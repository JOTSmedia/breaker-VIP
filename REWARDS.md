# Preferred Player Card: how the rewards program works

This is the reference for the Breaker Billiards members club: how points are earned and spent,
how the cards work, what staff can do, and how the POS terminals connect. For installing,
running, backups, passwords and hosting, see [README.md](README.md).

**The rules live in `server/program.json`.** If this file and `program.json` ever disagree,
`program.json` wins, because that is what the server actually uses. Edit it, restart, done.

---

## The approved rules (Sept 2026)

| Rule | Setting |
| --- | --- |
| Earning | **5 points per table hour**, **1 point per $5 on bar & food tabs** (before tax and tip) and **1 point per $5 tipped**, each rounded down per check. Table rental fees never earn dollar points. |
| Redeeming | **Free table time only.** No bar or food redemptions. |
| Cards | `BB0001` to `BB0050` are in the system. The number printed on the card (`0001`) works everywhere. |
| POS terminals | **Off** until `POS_WEBHOOK_KEY` is set in `server/.env`. |
| Sensitive actions | Need a **manager or the admin** login (see the role table below). |
| Toast | Bar points on the **pre-tax, pre-tip subtotal** only; tip points from the separate tip field (`tip` / `tipAmount`). **Automatic service charges / auto-gratuity are not tips and earn nothing.** A check that only carries a total is refused (422). |
| Redemption codes | Made in the app (valid **15 min**, one at a time) or by the register / desk (valid **24 h**, max **2 open** per member). The points are **held the moment the code is made** and come off when the Front Desk redeems it; an expired or cancelled code releases them. Only a **manager** can cancel a code. Each works once. |
| Tier overrides | Set by a manager, last **12 months** (`tierOverride.expiryMonths`), then the tier follows lifetime points again. |

---

## Earning points

| | |
| --- | --- |
| Table time | **5 points per hour** (half hours count: 1.5 h = 8 points, rounded) |
| Bar & food tabs | **1 point per $5** of the subtotal before tax and tip, rounded down per check ($27 = 5 points, $4.99 = 0) |
| Tips | **1 point per $5 tipped**, rounded down per check on its own ($12 tip = 2 points). Never counted inside the bar subtotal as well. An automatic service charge / auto-gratuity is **not** a tip and earns nothing |
| Table rental fees | no dollar points: table time earns per hour only, so nobody is paid twice for the same hour |
| Black tier | **1.5x** on everything earned (table time, bar tabs and tips) |
| "In The 11th Hour" | bank 10 paid table hours and the 11th hour is free (tracked automatically) |

**The bar rate is one setting:** `earn.perDollar` in `server/program.json` (currently `0.2`,
which means 1 point per $5). Change that number and restart to change the rate; set it to `0` (or
delete it) and bar tabs stop earning.

**The tip rate is its own setting:** `earn.perTipDollar` (currently `0.2`, 1 point per $5
tipped). It is kept apart from `perDollar` so either can change without the other; `0` switches
tip points off. A $40 subtotal with a $10 tip earns 8 + 2 = 10 points.

**Why 1 point per $5.** Table time at the default $15/hour earns 5 points, which is 1 point per
$3. The only reward is free table time, worth about $15 per 250 points (about 6 cents a point).
So bar spend gives back about **1.2%**, against about **2%** for table time. That keeps table time
the main thing the program rewards, and every redemption costs the bar only idle table time,
never product off the shelf.

There is no weeknight multiplier, no birthday bonus and no visit-streak bonus. The code still
knows how to do those, but they are switched off because `program.json` doesn't set
`multiplier`, `birthdayBonus` or `visitStreakBonus`. Leave them unset unless John approves a
change.

Staff add points at **Front Desk**: find the member, enter the **table hours** and/or the **bar &
food tab** before tax and tip (not the table fee), plus the **tip** in its own optional box, and
press Award. The tip is stored separately on the ledger row (`detail.tip`). The screen shows what it's worth before
you commit. If it comes to 0 points (nothing entered, or a tab under $5 on its own) it refuses
with "Nothing to award".

## Tiers

Tier is based on **lifetime** points (everything ever earned), so redeeming a reward never
drops anyone a level.

**Tier override (managers).** A manager can pin a member to a tier (Members → open the member →
Tier). It needs a reason, is written to the member's record (and the audit log) with who did it,
and **expires 12 months after it is set** (`tierOverride.expiryMonths` in `program.json`). The
expiry date is shown on the member's screen and in the Members list. After it the member is
automatically back on the tier their lifetime points earn (checked on every read, so it can't
linger), and an "override expired" line is added to their record. A manager can clear it sooner;
setting it again starts a new 12 months. It never changes the points balance. While it lasts the
override also drives the tier's table discount and Black's 1.5×. Overrides set before this rule
existed were given an expiry 12 months from the day they were set.

| Tier | Lifetime points | Perks |
| --- | --- | --- |
| Blue | 0 | 5 points per table hour and 1 point per $5 on bar tabs, 11th-hour tracker, points never expire |
| Silver | 500 | 5% off table time, early event sign-ups |
| Gold | 2,000 | 10% off table time, 1 comped table hour a month, wait-list priority |
| Black | 5,000 | 20% off table time, 1 comped table hour a week, reserved rack, 1.5x points on everything earned, first access to events |

## Redeeming

| Points | Reward |
| --- | --- |
| 250 | 1 hour of free table time |
| 450 | 2 hours of free table time |
| 625 | 3 hours of free table time |

All rewards are **free table time only**, redeemed at the **Front Desk**. There are no bar or food
rewards. The server enforces this: every reward in `program.json` must have `"type": "table"`,
the server refuses to start if one doesn't, and staff redeem, redemption codes and code
confirmation all reject anything that isn't a table-time reward. Ways to redeem:

- **Staff redeem**: Front Desk, tap the reward. Points come off immediately (only **available**
  points can be spent: see holds below).
- **Redemption code**: a 6-character code (letters and digits with no 0/O or 1/I/L) that stands
  for one reward for one member. Staff type it into **Redeem A Code** on the Front Desk. Each code
  works once.
  - **From the app**: the member taps a reward. Valid `redeemCodes.memberExpiryMinutes` (15).
    **One app code at a time**: a new tap replaces their previous app code and releases its hold.
  - **From the register** (Toast / CueT): `POST /api/pos/redeem-code` (below), printed on the
    receipt or shown on screen. Valid `redeemCodes.posExpiryHours` (24). **At most 2 open at once
    per member** (`redeemCodes.maxOpenPosCodes`).
  - **From the desk**: **Code for later** on the member's screen (same rules as a register code,
    counts toward the same limit of 2). Front Desk logins can make these.

**Holds: points are reserved as soon as a code is made.**

| | Balance | Held | Available |
| --- | --: | --: | --: |
| Member has 634 points | 634 | 0 | 634 |
| Makes a code for 1 free hour (250) | 634 | 250 | 384 |
| Front Desk redeems the code | 384 | 0 | 384 |
| ...or the code expires / a manager cancels it | 634 | 0 | 634 |

- **Available = balance − points held by open codes.** A code can only be made if the
  *available* points cover it; otherwise it is refused with how many more are needed. Staff
  redeem and manual adjustments can't dig into held points either.
- **Redeem** turns the hold into the deduction, once: the balance drops by the held amount and
  the hold ends in the same step, so the points are never taken twice.
- **Expiry** releases the hold. A hold is simply an open code in `codes.json`, and an expired code
  holds nothing from the moment it expires (worked out on every read), so points can never get
  stuck, even across restarts. A sweep (at start-up, every minute and before each request) marks
  it expired and writes the release to the member's history.
- **Cancel** releases the hold. Cancelling is **manager / admin only**; the Front Desk doesn't see
  the Cancel button and the server refuses it (403). Closing an account or replacing a lost card
  cancels that member's open codes and releases their holds.
- The member sees **Available Points**, the held amount and each open code in the app; staff see
  the same on the Front Desk member screen (and "held" in the Members list and dashboard).
- History: making a code writes a **hold** line (e.g. "250 points held: code K7MX4Q …"),
  expiry/cancel/replace writes a **release** line, and redeeming writes the normal **redeem**
  line (−250) with the code. Hold and release lines carry 0 points: the balance only moves on
  redeem. Members see these lines too.
- Codes are saved in `server/data/codes.json` (written atomically like everything else), so a
  restart never loses one or its hold. Each record keeps who/what made it, when it expires, and who
  redeemed or cancelled it and when. Finished codes are kept 90 days.
- Open codes show under **Codes Waiting** and on the member's screen.

What it costs the bar: a free hour (250 points) takes 50 paid hours, about a 2% give-back, on
top of the 11th-hour punch card (about 9%). Bar tabs add about 1.2% on bar spend ($1,250 of bar
spend for a free hour), paid out in otherwise idle table time.

---

## The cards

- The 50 printed cards are `BB0001` to `BB0050`. They are blank: no name, no tier. Any card in
  the drawer can go to any new member.
- Staff can type the number any way: `0001`, `1`, `BB0001` and `BB-0001` all mean the same card.
- There is **no barcode**. Staff type the number.
- **More cards**: Staff console, then **Cards**, then **Mint A Batch** (manager or admin). New
  numbers continue from `BB0051`. Then `npm run cards` makes the card-back PDF in
  `generated_cards/`. The front is the same on every card, so reuse
  `moo_card_fronts_BB0001-0050.pdf`. Always mint **before** printing so the system and the
  plastic match.
- **Lost card**: look the member up, **Replace Lost Card**, enter the new card's number. The old
  number is retired forever. Points, tier and history stay with the member.

## Signing someone up (staff only)

Staff console, then **New Member**:

1. The next blank card is pre-selected; pick another unassigned card if you're handing over a
   different one.
2. Enter a name and a **phone or an email** (at least one). Both must be unique: the same phone
   written differently (`(973) 555-0101`, `+1 973.555.0101`) counts as the same number.
   Birthday is optional.
3. **Create Member**. A **4-digit PIN** is shown once. Give it to the member with the card.
   Managers can also set a starting tier here (with a reason).

PINs are stored hashed and can never be read back, only reset. Members sign in at `/rewards`
with their card number, phone or email plus the PIN.

## Editing, closing and lost cards

- **Edit details** (any staff, Front Desk included): name, phone, email, birthday. Every change
  is logged on the member's record with the old and new value and who made it, and in the audit
  log (`member.edit`). A member must keep at least one of phone or email.
- **Close / reopen** (manager): a closed account can't sign in, earn (Front Desk or POS),
  redeem, or have a code redeemed, and no new codes can be made. Open codes are cancelled and
  their holds released. Reopening restores everything; points are kept.
- **Lost card** (any staff, Front Desk included): move the account to a new blank card. The old
  number is voided for good; points, tier and history stay with the member. Open codes are
  cancelled (holds released). Logged on the record and in the audit log (`member.card-replace`).

## Staff logins and what each can do

| Action | Front Desk | Manager | Admin |
| --- | :-: | :-: | :-: |
| Look up / search members, sign up, add points, redeem, redeem codes, make codes (Code for later) | ✓ | ✓ | ✓ |
| Edit member details, reset member PIN, replace lost card (edit and card replacement are audited) | ✓ | ✓ | ✓ |
| **Cancel** a redemption code (releases its held points) | | ✓ | ✓ |
| Manual point adjustment (reason required) | | ✓ | ✓ |
| Tier override (set / clear, reason required) | | ✓ | ✓ |
| Close / reopen accounts | | ✓ | ✓ |
| Member CSV export, mint / void cards, clear POS log | | ✓ | ✓ |
| Create / switch off / reset **Front Desk** logins | | ✓ | ✓ |
| Create / switch off / reset **Manager** logins | | | ✓ |

- Staff logins are made on the **Staff** tab and stored in `server/data/staff.json` as scrypt
  hashes, never plain text. Passwords need 10+ characters.
- Switching a login off, or resetting its password, signs that person out of every session
  immediately (checked on every request).
- The audit log (`server/data/audit.json`, shown on the Staff tab, manager+) records staff-login
  changes and member actions: `member.edit`, `member.card-replace`, `member.tier` /
  `member.tier-clear`, `member.adjust`, `member.close` / `member.reopen` and `code.cancel`.
- The **admin** is the `.env` login (`ADMIN_PASS_HASH`, set by `npm run setup`). It can't be
  changed from the portal. The older `.env` logins (`MANAGER_PASS`, `DESK_PASS`, `BAR_PASS`) still
  work; `BAR_PASS` (usernames `barmanager` or `bar`) signs in **as a Front Desk login**: there is
  no separate bar role (it was folded into Front Desk, and a test checks this).
- Every points and member change in the ledger records which login did it.

## The admin view

**Activity** shows every transaction, newest first. The ledger is append-only: mistakes and
their corrections both stay on the record. **Members** has search and **Export CSV**. The
dashboard shows members, signups, points earned and redeemed, **points outstanding** (what the
bar owes in future free table time), points **held** by open codes, tier mix and blank cards left.

---

## POS terminals (Toast and CueT)

**Terminals are locked out until `POS_WEBHOOK_KEY` is set** in `server/.env`. Each terminal then
sends the same value in an `X-POS-Key` header. A signed-in staff user can also use these routes
(that's how the POS Hub's simulate button works).

| Route | What it does under the current rules |
| --- | --- |
| `POST /api/pos/cuet/session-closed` | CueT table session closed. Awards **5 points per table hour** (1.5x for Black) and feeds the 11th-hour tracker. The rental dollars earn **no** dollar points. Also reports the member's tier discount on the rental. |
| `POST /api/pos/cuet/lookup` | CueT terminal looks up a member by card number. Returns `pointsBalance`, `pointsHeld` and `pointsAvailable`. |
| `POST /api/pos/toast/order-closed` | Toast bar check closed. **Awards 1 point per $5 of the pre-tax, pre-tip subtotal** plus **1 point per $5 of the tip** (separate field), each rounded down (1.5x for Black). Needs a `checkId`; duplicate protection on it, so a retried check is never paid twice. |
| `POST /api/pos/redeem-code` | Asks for a free-table-time code. Body: the member (`memberNo` / `serial` / `card` / `phone` / `email` / `memberIdent`) and `rewardId` (`table1`, `table2`, `table3`); optional `terminal`. Returns `code`, `reward`, `expiresAt`, `expiresInHours`, `member` (`balance`, `held`, `available`) and a ready-made `receiptText`. Refused with 400 if the member's **available** points don't cover it or the account is closed, and with 429 if they already have 2 register codes open. **The points are held now** and come off when the Front Desk redeems the code. |

**Which Toast amount is used.** The server takes the first of these fields that is present:
`subtotal`, `netAmount`, `preTaxAmount`. It should be the check after discounts, before tax and
tip, in dollars (not cents). If a check only carries a total (`amount`, `total` or `spend`, which
may include tax and tip), it is **refused** (HTTP 422), nothing is awarded, and the refusal shows
in the POS Hub feed as "Refused". That is deliberate: over-crediting tax and tips can't be taken
back once points are redeemed, and a refusal is obvious while the integration is being set up. A
refused check can be resent with a subtotal and will be paid. CueT sessions need a `sessionId`
and 0 to 24 `tableHours`.

**Tips.** The tip comes from the first of `tip`, `tipAmount` that is present (0 to $1,000;
anything else refuses the check with 422). It is never looked for inside the subtotal, so it
can't be paid twice. It is stored separately in the ledger row (`detail.tip`) and the POS log
(`tip`), and is not counted in lifetime bar spend (the staff view shows `lifetimeTips`).

**Service charges are not tips.** An automatic service charge or auto-gratuity (e.g. added for a
large party) earns **no** points. The fields `gratuity`, `gratuityAmount`, `autoGratuity`,
`autoGratuityAmount`, `serviceCharge`, `serviceChargeAmount` and `serviceCharges` (a number, or a
list of `{ amount }`) are ignored for points. The check itself is still paid on its subtotal (and
on a real `tip` if there is one), and the ignored amount is written to the POS log and the ledger
row as `serviceChargeIgnored` (with `serviceChargeFields`), so it's plain to see it was left out
on purpose.

**Codes on an earn.** A CueT or Toast earn may include `requestRedeemCode: "<rewardId>"`. The
points are awarded first; the response then carries `redeemCode` (same shape as
`/api/pos/redeem-code`) or, if a code can't be made, `redeemCodeError`. The earn always stands.

Members are matched by card number, phone or email. Repeated check or session numbers are
ignored, so a terminal retrying can't double-credit.

**Still open: verify against real Toast/CueT payloads.** Neither webhook has been tested with a
real terminal. Before turning the key on, confirm with whoever sets up the terminals: the field
names (`checkId`, `subtotal`, `tip`, `memberIdent` / `phone` / `memberNo`, `sessionId`, `tableHours`,
`rate`), that amounts are dollars not cents, that the subtotal excludes tax, tip and service
charges, which field Toast actually uses for a service charge / auto-gratuity (so it lands in
the ignored list above) versus a guest-chosen tip, how a member is
identified at the register, and whether the register can print the redemption code on a receipt.

---

## Security

- PINs and passwords are scrypt-hashed with a per-secret salt, never stored in the clear.
- Sessions are signed tokens with an expiry. Member tokens can't reach staff routes.
- Login throttling: repeated failures lock that member number (or admin IP) out for 15 minutes.
  That is what makes a 4-digit PIN acceptable. Behind a Cloudflare Tunnel set
  `TRUST_PROXY=cloudflare` so the real visitor address (`CF-Connecting-IP`) is used.
- No cookies are set; sessions are signed tokens sent in an `Authorization` header.
- Every staff-entered field is validated on the server (lengths, email/phone/date formats,
  number ranges, duplicate phone/email).
- Failed logins never reveal whether a card number exists.
- Writes are atomic, and a corrupt data file stops the server from starting instead of starting
  empty.
- `server/.env` and `server/data/` are gitignored. Never commit or share them.
- The server listens only on this computer (`127.0.0.1`) unless `HOST` is changed. **Only open it
  up behind HTTPS**, because PINs and tokens cross the network.

---

## Files

```
breaker_rewards/
  breaker_billiards_app.html   guest menu + member portal
  admin.html                   staff console
  card.html                    card studio
  README.md                    setup, running, backups, hosting, Linktree
  REWARDS.md                   this file
  scripts/                     setup, card PDFs, backup/restore
  backups/                     npm run backup output (gitignored)
  test/rewards.test.mjs        automated tests (npm test)
  server/
    server.js                  API, POS routes, static files
    points.js                  points rules, tiers, 11th-hour tracker
    store.js                   JSON-file database (atomic writes: temp file in the data folder, then rename)
    auth.js                    hashing, tokens, throttling
    program.json               THE PROGRAM: earn rates (table, bar, tip), code expiry + limits, override expiry, tiers, rewards
    .env.example               settings template (real settings go in .env)
    data/                      the live database incl. staff.json, audit.json, codes.json (gitignored)
```
