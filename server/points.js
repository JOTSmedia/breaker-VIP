/* ============================================================
   POINTS — every rule that decides how many points something is worth.

   Kept apart from the HTTP layer so the maths is readable and testable on
   its own. Two balances are tracked per member and they are NOT the same
   number:

     balance  — spendable points. Goes up on earn, DOWN on redeem.
     lifetime — total ever earned. Never goes down.

   Tier is driven by LIFETIME, so redeeming a reward can never demote
   someone. That matters: a program that takes your status away for using
   it trains people not to use it.
   ============================================================ */

export function tierFor(program, lifetime){
  const tiers = [...program.tiers].sort((a, b) => a.min - b.min);
  let out = tiers[0];
  for(const t of tiers) if(lifetime >= t.min) out = t;
  return out;
}
export function nextTierFor(program, lifetime){
  return [...program.tiers].sort((a, b) => a.min - b.min).find(t => t.min > lifetime) || null;
}

/* The tier a member actually gets. Normally it comes from LIFETIME points;
   a manager can pin a member to a tier with `tierOverride` (a tier key),
   which wins until it is cleared OR until it expires. Every override carries
   an `expiresAt` (tierOverride.expiryMonths in program.json, default 12
   months from when it was set); from that moment the member is simply back
   on the tier their lifetime points earn. The check is made on every read,
   so an expired override can never keep counting, even between sweeps.
   Balances are never touched by this. */
export const tierByKey = (program, key) => program.tiers.find(t => t.key === key) || null;
export const DEFAULT_OVERRIDE_MONTHS = 12;
export const overrideMonths = program =>
  Number(program && program.tierOverride && program.tierOverride.expiryMonths) || DEFAULT_OVERRIDE_MONTHS;
/* Same day-of-month N months later (clamped: 31 Jan + 1 month = 28/29 Feb). */
export function addMonths(when, months){
  const d = new Date(when);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}
export const overrideExpired = (o, now = Date.now()) =>
  !!(o && o.expiresAt && Date.parse(o.expiresAt) <= now);
/* The override that is in force right now, or null (none, unknown tier, expired). */
export function activeOverride(program, member, now = Date.now()){
  const o = member && member.tierOverride;
  if(!o || !tierByKey(program, o.key) || overrideExpired(o, now)) return null;
  return o;
}
export function memberTier(program, member){
  if(!member) return tierFor(program, 0);
  const o = activeOverride(program, member);
  return (o && tierByKey(program, o.key)) || tierFor(program, member.lifetime || 0);
}
/* Next tier to aim for: the first one above BOTH the member's lifetime
   points and their current (possibly overridden) tier. */
export function memberNextTier(program, member){
  const cur = memberTier(program, member);
  return [...program.tiers].sort((a, b) => a.min - b.min)
    .find(t => t.min > cur.min && t.min > (member.lifetime || 0)) || null;
}

/* ============================================================
   TABLE PUNCH TRACKER — "In The 11th Hour"
   Bank 10 hours at the tables, and your 11th hour is 100% FREE!
   Calculates cumulative table hours, current 11-hour cycle,
   free hours earned, and whether the 11th hour milestone is unlocked.
   ============================================================ */
export function tablePunchStatus(program, member, ledger = []){
  const cycle = (program.earn && program.earn.tablePunchCycle) || 11;
  const memberLedger = ledger.filter(r => r.memberId === member.id && r.type === 'earn');
  
  const totalTableHours = memberLedger.reduce((sum, r) => {
    return sum + (r.detail && r.detail.tableHours ? Math.max(0, Number(r.detail.tableHours) || 0) : 0);
  }, 0);

  const roundedTotal = Math.round(totalTableHours * 10) / 10;
  const currentCycleHours = Math.round((roundedTotal % cycle) * 10) / 10;
  const freeHoursEarned = Math.floor(roundedTotal / cycle);
  const hoursToNextFree = Math.max(0, Math.round(((cycle - 1) - currentCycleHours) * 10) / 10);
  const isCompHourReady = currentCycleHours >= (cycle - 1);

  const slots = [];
  for(let i = 1; i <= cycle; i++){
    const isFreeSlot = (i === cycle);
    const filled = (i <= Math.floor(currentCycleHours)) || (isFreeSlot && isCompHourReady);
    slots.push({
      slot: i,
      label: isFreeSlot ? '11th FREE' : `${i}h`,
      isFree: isFreeSlot,
      filled
    });
  }

  return {
    totalHours: roundedTotal,
    cycle,
    currentCycleHours,
    freeHoursEarned,
    hoursToNextFree,
    isCompHourReady,
    slots,
    rewardName: (program.earn && program.earn.tablePunchRewardName) || 'In The 11th Hour — Free Table Time'
  };
}

/* What a given spend is worth right now, with every bonus applied and an
   explanation of each one — the explanation is what gets shown to the member
   and written into the ledger, so nobody has to trust a bare number. */
export function quoteEarn(program, member, { amount = 0, tableHours = 0, tip = 0, when = new Date() }){
  const e = program.earn;
  const lines = [];
  let base = 0;

  const spend = Math.max(0, Number(amount) || 0);
  const hours = Math.max(0, Number(tableHours) || 0);
  const tipAmt = Math.max(0, Number(tip) || 0);

  /* `amount` is BAR / FOOD spend in dollars (a Toast check or a tab rung in
     at the Front Desk). It earns earn.perDollar points per dollar, rounded
     DOWN per check (0.2 = 1 point per $5). Table rental dollars must never be
     passed in here — table time earns per hour below (see quoteCueTEarn).
     The Number() guard matters: without it a missing rate produced NaN and
     wiped the member's balance to null. */
  const perDollar = Number(e.perDollar) || 0;
  if(spend > 0 && perDollar > 0){
    const p = Math.floor(spend * perDollar + 1e-9);   /* 1e-9 guards float error at other rates ($90 * 0.7 = 62.999…) */
    base += p;
    lines.push({ label: `$${spend.toFixed(2)} bar tab`, points: p });
  }
  /* `tip` is the TIP on a bar tab, in dollars. It earns earn.perTipDollar
     points per dollar (0.2 = 1 point per $5), rounded DOWN on its own — kept
     apart from the bar rate so either can change without the other. The tip
     is never part of `amount`: bar points come from the pre-tip subtotal. */
  const perTip = Number(e.perTipDollar) || 0;
  if(tipAmt > 0 && perTip > 0){
    const p = Math.floor(tipAmt * perTip + 1e-9);
    base += p;
    lines.push({ label: `$${tipAmt.toFixed(2)} tip`, points: p });
  }
  if(hours > 0){
    const p = Math.round(hours * e.perTableHour);
    base += p;
    lines.push({ label: `${hours}h table time`, points: p });
  }

  let total = base;

  /* weeknight multiplier — applies to the whole base, not just the drinks */
  const dow = when.getDay();
  const isMultiDay = Array.isArray(e.multiplierDays) && e.multiplierDays.includes(dow);
  if(isMultiDay && e.multiplier > 1 && base > 0){
    const bonus = Math.round(base * (e.multiplier - 1));
    total += bonus;
    lines.push({ label: e.multiplierLabel || `${e.multiplier}x day`, points: bonus });
  }

  /* Black-tier permanent boost, applied after the day multiplier */
  const tier = memberTier(program, member);
  if(tier.earnBoost && tier.earnBoost > 1 && base > 0){
    const bonus = Math.round(total * (tier.earnBoost - 1));
    total += bonus;
    lines.push({ label: `${tier.name} tier ${tier.earnBoost}x`, points: bonus });
  }

  return { points: total, lines, tier };
}

/* Toast POS Quote (Bar check ingestion) */
export function quoteToastEarn(program, member, { checkId, amount = 0, tip = 0, items = [], when = new Date() }){
  const q = quoteEarn(program, member, { amount, tip, tableHours: 0, when });
  return {
    ...q,
    source: 'toast',
    checkId: String(checkId || '').trim() || 'CHECK',
    itemCount: Array.isArray(items) ? items.length : 0
  };
}

/* CueT POS Quote (Billiards table session ingestion) */
export function quoteCueTEarn(program, member, { tableNo, tableHours = 0, rate = 15, when = new Date() }){
  const tier = memberTier(program, member);
  const discountPct = tier.tableDiscount || 0;
  const hours = Math.max(0, Number(tableHours) || 0);
  const grossAmount = hours * (Number(rate) || 15);
  const discountAmount = Math.round(grossAmount * (discountPct / 100) * 100) / 100;
  const netAmount = Math.max(0, Math.round((grossAmount - discountAmount) * 100) / 100);

  /* Table time earns per HOUR only. The rental dollars are reported (for the
     discount display and the ledger) but deliberately NOT passed as `amount`,
     otherwise earn.perDollar would pay a second time on the same table fee. */
  const q = quoteEarn(program, member, { amount: 0, tableHours: hours, when });
  return {
    ...q,
    source: 'cuet',
    tableNo: String(tableNo || '1'),
    tableHours: hours,
    grossAmount,
    discountPct,
    discountAmount,
    netAmount
  };
}

/* Birthday month: once per calendar year, and only if the month matches.
   Stored as birthdayBonusYear on the member so it can't be farmed. */
export function birthdayDue(program, member, when = new Date()){
  if(!member || !member.birthday) return 0;
  const bMonth = Number(String(member.birthday).split('-')[1]);
  if(!bMonth || bMonth !== when.getMonth() + 1) return 0;
  if(member.birthdayBonusYear === when.getFullYear()) return 0;
  return program.earn.birthdayBonus || 0;
}

/* Visit streak: count distinct visit days this calendar month. The Nth one
   pays a bonus. "Distinct days" not "transactions", so a member who runs
   three tabs in a night doesn't get three visits out of it. */
export function visitBonusDue(program, member, ledger, when = new Date()){
  const need = program.earn.visitStreakCount;
  const bonus = program.earn.visitStreakBonus;
  if(!need || !bonus) return 0;
  const ym = when.toISOString().slice(0, 7);
  const days = new Set(
    ledger.filter(r => r.memberId === member.id && r.type === 'earn' && r.at.slice(0, 7) === ym)
          .map(r => r.at.slice(0, 10))
  );
  days.add(when.toISOString().slice(0, 10));   /* include the visit being recorded */
  if(days.size !== need) return 0;             /* pays on exactly the Nth day */
  if(member.visitBonusMonth === ym) return 0;
  return bonus;
}

/* REWARDS ARE FREE TABLE TIME ONLY. Every reward in program.json must carry
   "type": "table"; anything else is never offered and can never be redeemed
   (member voucher, staff redeem and voucher confirm all go through here). */
export const REWARD_TYPE_TABLE = 'table';
export const isTableReward = r => !!r && r.type === REWARD_TYPE_TABLE;
export const tableRewards = program => (program.rewards || []).filter(isTableReward);
export const rewardById = (program, id) =>
  tableRewards(program).find(r => r.id === id) || null;

/* Checked once at server start. A reward that isn't table time, or a broken
   earn rate, stops the server with a clear message instead of quietly
   offering something John never approved. Returns a list of problems. */
export function validateProgram(program){
  const problems = [];
  const e = program.earn || {};
  if(!(Number(e.perTableHour) > 0)) problems.push('earn.perTableHour must be a positive number');
  if(e.perDollar != null && !(Number(e.perDollar) >= 0)) problems.push('earn.perDollar must be a number (0 or more)');
  if(e.perTipDollar != null && !(Number(e.perTipDollar) >= 0)) problems.push('earn.perTipDollar must be a number (0 or more)');
  const rc = program.redeemCodes || {};
  if(rc.posExpiryHours != null && !(Number(rc.posExpiryHours) > 0 && Number(rc.posExpiryHours) <= 24 * 30))
    problems.push('redeemCodes.posExpiryHours must be more than 0 and at most 720 (30 days)');
  if(rc.memberExpiryMinutes != null && !(Number(rc.memberExpiryMinutes) > 0 && Number(rc.memberExpiryMinutes) <= 24 * 60))
    problems.push('redeemCodes.memberExpiryMinutes must be more than 0 and at most 1440 (a day)');
  if(rc.maxOpenPosCodes != null && !(Number.isInteger(Number(rc.maxOpenPosCodes)) && Number(rc.maxOpenPosCodes) >= 1 && Number(rc.maxOpenPosCodes) <= 20))
    problems.push('redeemCodes.maxOpenPosCodes must be a whole number from 1 to 20');
  const to = program.tierOverride || {};
  if(to.expiryMonths != null && !(Number.isInteger(Number(to.expiryMonths)) && Number(to.expiryMonths) >= 1 && Number(to.expiryMonths) <= 120))
    problems.push('tierOverride.expiryMonths must be a whole number of months from 1 to 120');
  if(!Array.isArray(program.rewards) || !program.rewards.length) problems.push('rewards must list at least one reward');
  for(const r of program.rewards || []){
    if(!isTableReward(r))
      problems.push(`reward "${r && r.id}" has type "${r && r.type}" — rewards must be free table time ("type": "table")`);
    if(!(Number(r && r.cost) > 0)) problems.push(`reward "${r && r.id}" needs a positive cost`);
  }
  return problems;
}

/* Everything the member portal and the admin panel need about one account,
   shaped once here so the two clients can never drift apart. */
/* Dollars behind an earn row, split by where they were spent. Handles every
   shape the ledger has held: Toast rows (detail.pos 'toast', spend), CueT rows
   (detail.pos 'cuet', spend = net rental), Front Desk rows (barSpend, or the
   older `amount` field, which was always the bar tab). */
export function spendOf(row){
  const d = (row && row.type === 'earn' && row.detail) || null;
  if(!d) return { bar: 0, table: 0, tip: 0 };
  const n = v => Math.max(0, Number(v) || 0);
  if(d.pos === 'cuet') return { bar: 0, table: n(d.spend), tip: 0 };
  if(d.pos === 'toast') return { bar: n(d.barSpend != null ? d.barSpend : d.spend), table: 0, tip: n(d.tip) };
  return { bar: n(d.barSpend != null ? d.barSpend : d.amount), table: 0, tip: n(d.tip) };
}

/* Ledger rows a MEMBER sees about themselves: points movements and joining.
   Staff-only notes (edits, tier changes, PIN resets) stay in the staff view. */
const MEMBER_VISIBLE = new Set(['earn', 'redeem', 'adjust', 'join', 'hold', 'release']);

export function publicMember(program, member, ledger = [], opts = {}){
  const tier = memberTier(program, member);
  const next = memberNextTier(program, member);
  const tracker = tablePunchStatus(program, member, ledger);

  const memberLedger = ledger
    .filter(r => r.memberId === member.id)
    .sort((a, b) => (a.at < b.at ? 1 : -1));

  /* lifetimeSpend is bar + table spend; tips are reported on their own */
  let barSpend = 0, tableSpend = 0, tips = 0;
  for(const r of memberLedger){ const s = spendOf(r); barSpend += s.bar; tableSpend += s.table; tips += s.tip; }
  const round2 = v => Math.round(v * 100) / 100;
  const lifetimeSpend = barSpend + tableSpend;

  const history = opts.forMember
    ? memberLedger.filter(r => MEMBER_VISIBLE.has(r.type)).slice(0, 100)
        .map(r => ({ id: r.id, type: r.type, points: r.points, label: r.label, at: r.at,
                     detail: r.detail && r.detail.pos ? { pos: r.detail.pos }
                           : r.detail && (r.type === 'hold' || r.type === 'release') ? { held: r.detail.held, code: r.detail.code }
                           : null }))
    : memberLedger.slice(0, 100);

  const distinctVisits = new Set(
    memberLedger.filter(r => r.type === 'earn').map(r => r.at.slice(0, 10))
  ).size;

  /* HELD points: reserved by open redemption codes (worked out by the server
     from codes.json and passed in). `balance` is every point the member owns;
     `available` is what they can still spend or put on a new code. */
  const held = Math.max(0, Number(opts.held) || 0);
  const override = activeOverride(program, member);

  return {
    id: member.id,
    memberNo: member.memberNo,
    name: member.name,
    email: member.email,
    phone: member.phone || '',
    birthday: member.birthday,
    balance: member.balance,
    held,
    available: member.balance - held,
    lifetime: member.lifetime,
    joined: member.joined,
    active: member.active !== false,
    claimed: !!member.pinHash,
    tier: { key: tier.key, name: tier.name, perks: tier.perks, tableDiscount: tier.tableDiscount },
    tierSource: override ? 'override' : 'points',
    tierUntil: override ? (override.expiresAt || null) : null,
    ...(opts.forMember ? { holds: opts.holds || [] } : { tierOverride: override || null }),
    tableTracker: tracker,
    tierDiscount: tier.tableDiscount || 0,
    lifetimeSpend: round2(lifetimeSpend),
    lifetimeBarSpend: round2(barSpend),
    lifetimeTableSpend: round2(tableSpend),
    lifetimeTips: round2(tips),
    lifetimeVisits: distinctVisits,
    lifetimeTableHours: tracker.totalHours,
    nextTier: next ? { name: next.name, min: next.min, need: next.min - member.lifetime } : null,
    history
  };
}

