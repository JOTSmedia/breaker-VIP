/* ============================================================
   PREFERRED PLAYER CARD — API + static server.

   Zero npm dependencies. Node 18+ only:  node server/server.js

   Serves two things:
     1. the JSON API under /api/*
     2. the static files in this folder's parent (the guest app, the admin
        panel, the card printer) so one process runs the whole thing

   WHY THIS EXISTS: the guest menu is a single static file and happily lives
   on GitHub Pages. Accounts, points and an admin view cannot — static
   hosting has no database and no way to keep a secret. This process is that
   missing half. Point ALLOW_ORIGIN at wherever the guest app is hosted and
   the two halves talk.

   Config comes from server/.env (see .env.example). Nothing secret is
   hard-coded and data/ is gitignored.
   ============================================================ */
import './env.js';                      /* must be first: loads server/.env */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';

import { db, flush, findById, findByAny, findByEmail, findByPhone, ledgerFor, phoneKey,
         normSerial, findCard, cardForMember, mintCards, serialNumber, DATA } from './store.js';
import { hash, verifyHash, sign, verify, throttled, noteFail, clearFails, pinOk, randomPin,
         isRetiredPassword, isHash } from './auth.js';
import { quoteEarn, quoteToastEarn, quoteCueTEarn, tablePunchStatus, tierFor, memberTier, tierByKey,
         birthdayDue, visitBonusDue, rewardById, tableRewards, validateProgram, publicMember,
         overrideMonths, addMonths, overrideExpired } from './points.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ---------- config ----------
   Settings come from server/.env (see .env.example), loaded by ./env.js.
   There are NO passwords in this file. */
const PORT         = Number(process.env.PORT || 4400);
const HOST         = process.env.HOST || '127.0.0.1';
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

const PROGRAM = JSON.parse(readFileSync(join(HERE, 'program.json'), 'utf8'));

/* Fail loudly on a program.json that breaks the approved rules (e.g. a
   reward that isn't free table time) rather than quietly serving it. */
{
  const problems = validateProgram(PROGRAM);
  if(problems.length){
    console.error('\n  server/program.json has a problem, so the server will not start:\n' +
                  problems.map(p => '    - ' + p).join('\n') + '\n');
    process.exit(1);
  }
}

/* ---------- staff accounts ----------
   An account exists only if its password is set in .env: ideally the scrypt
   hash written by `npm run setup` (ADMIN_PASS_HASH), or a plain password
   (ADMIN_PASS, handy on a hosting dashboard) that is hashed in memory here.
   Extra staff logins (MANAGER_ / BAR_ / DESK_PASS) are optional. */
function credential(prefix){
  const h = (process.env[prefix + '_PASS_HASH'] || '').trim();
  if(h){
    if(isHash(h)) return h;
    console.warn(`  ! ${prefix}_PASS_HASH is not a valid hash, so that login is switched off. Run: npm run setup`);
    return null;
  }
  const p = process.env[prefix + '_PASS'] || '';
  if(!p) return null;
  if(isRetiredPassword(p)){
    console.warn(`  ! ${prefix}_PASS is an old published demo password, so that login is switched off. Run: npm run setup`);
    return null;
  }
  if(p.length < 8){
    console.warn(`  ! ${prefix}_PASS is shorter than 8 characters, so that login is switched off`);
    return null;
  }
  return hash(p);
}

/* ROLES — three, enforced on the server for every request:
     admin    the root login from .env (ADMIN_PASS_HASH). Everything, including
              managing manager accounts. Can't be changed from the portal.
     manager  + adjustments, CSV export, card minting/voiding, tier overrides,
              closing/reopening accounts, CANCELLING redemption codes,
              managing front-desk logins.
     desk     front desk (and bar staff): look up, sign up, add points,
              redeem, make and redeem codes, edit member details and replace
              lost cards (both written to the audit log).
   The old separate "bar" role had exactly the desk permissions, so it is
   folded into desk; BAR_PASS still works and signs in as a desk account. */
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', desk: 'Front Desk' };
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();

/* Env accounts (.env): the root admin plus the optional legacy
   MANAGER_/DESK_/BAR_PASS logins. Read-only in the portal. */
const ENV_STAFF = {};                   /* username -> account */
const ENV_LIST = [];                    /* one entry per env login, for the Staff screen */
function addEnvStaff(usernames, name, role, h){
  if(!h) return;
  const acct = { username: usernames[0], aliases: usernames.slice(1), name, role, hash: h,
                 source: 'env', active: true, sessionVersion: 0 };
  for(const u of usernames) ENV_STAFF[u] = acct;
  ENV_LIST.push(acct);
}
addEnvStaff([...new Set([ADMIN_USER, 'admin'])], 'Administrator', 'admin', credential('ADMIN'));
addEnvStaff(['manager'], 'General Manager', 'manager', credential('MANAGER'));
addEnvStaff(['frontdesk', 'desk'], 'Front Desk', 'desk', credential('DESK'));
addEnvStaff(['barmanager', 'bar'], 'Bar Manager', 'desk', credential('BAR'));

/* Usernames a portal account may never take, so it can't shadow (or be
   shadowed by) an .env login, even one that isn't switched on today. */
const RESERVED_USERS = new Set([ADMIN_USER, 'admin', 'root', 'system', 'manager', 'frontdesk', 'desk', 'barmanager', 'bar']);

/* Portal accounts live in the data folder (staff.json), scrypt hashes only. */
function staffAccount(username){
  const u = String(username || '').trim().toLowerCase();
  if(ENV_STAFF[u]) return ENV_STAFF[u];
  const a = db.staff.find(x => x.username === u);
  return a ? { ...a, source: 'portal' } : null;
}
const MANAGER_ROLES = new Set(['admin', 'manager']);
const isManager = staff => MANAGER_ROLES.has(staff.role);
/* who may create / disable / reset whom: admin -> manager + desk, manager -> desk */
const canManageRole = (actor, role) =>
  (actor.role === 'admin' && (role === 'manager' || role === 'desk')) ||
  (actor.role === 'manager' && role === 'desk');
const DUMMY_HASH = hash(randomBytes(16).toString('hex'));   /* same-time reply for unknown usernames */

if(!ENV_STAFF[ADMIN_USER]){
  console.error('\n  No admin password is set, so the server will not start.\n' +
                '  Run:  npm run setup     (or set ADMIN_PASS on your host)\n');
  process.exit(1);
}

/* A stable secret matters: regenerating it on boot would log everyone out on
   every restart. Persist one in the data folder if none is configured. */
let SECRET = process.env.SESSION_SECRET || '';
if(!SECRET){
  const f = join(DATA, '.secret');
  if(existsSync(f)) SECRET = readFileSync(f, 'utf8').trim();
  else {
    SECRET = randomBytes(32).toString('hex');
    writeFileSync(f, SECRET, { mode: 0o600 });
    console.log('  Generated a session secret in the data folder');
  }
}
/* Staff tokens carry a fingerprint of the account's password hash and its
   session version, so a password change, a reset or disabling the account
   signs out every session that account had. Checked on EVERY request. */
const passVersion = acct => createHmac('sha256', SECRET)
  .update(`${acct.hash}|${acct.sessionVersion || 0}`).digest('base64url').slice(0, 16);

/* Public files: only these types, and only at the top level of this folder. */
const PUBLIC_EXT = new Set(['.html', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.pdf', '.woff2']);

/* ---------- tiny http helpers ---------- */
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2', '.txt':'text/plain', '.pdf':'application/pdf' };

function cors(req, res){
  const origin = req.headers.origin;
  if(ALLOW_ORIGIN.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if(origin && ALLOW_ORIGIN.includes(origin)){
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
function json(res, code, body){
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(s);
}
const ok   = (res, body) => json(res, 200, body);
const fail = (res, code, msg) => json(res, code, { error: msg });

function readBody(req){
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if(n > 64 * 1024){ reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if(!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch(e){ reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

/* Client address for login throttling. Default: the socket address. Behind a
   Cloudflare Tunnel every request arrives from 127.0.0.1, so with
   TRUST_PROXY=cloudflare the CF-Connecting-IP header is used instead. Only
   turn that on when the tunnel is the ONLY way in (HOST=127.0.0.1) — anyone
   who can reach the port directly could otherwise fake the header. */
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
function clientIp(req){
  if(TRUST_PROXY === 'cloudflare'){
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if(cf && cf.length <= 64 && /^[0-9a-f:.]+$/i.test(cf)) return cf;
  }
  return req.socket.remoteAddress || 'x';
}

function requireMember(req, res){
  const p = verify(bearer(req), SECRET);
  if(!p || p.role !== 'member'){ fail(res, 401, 'Sign in again'); return null; }
  const m = findById(p.sub);
  if(!m || m.active === false){ fail(res, 401, 'Account unavailable'); return null; }
  return m;
}
function staffFromToken(req){
  const p = verify(bearer(req), SECRET);
  const acct = p && p.kind === 'staff' ? staffAccount(p.username) : null;
  if(!acct || acct.active === false || p.pv !== passVersion(acct)) return null;
  return { ...p, role: acct.role, username: acct.username, name: acct.name,
           sub: acct.source === 'env' ? acct.name : `${acct.name} (${acct.username})` };
}
function requireAdmin(req, res){
  const staff = staffFromToken(req);
  if(!staff){ fail(res, 401, 'Staff sign in required'); return null; }
  return staff;
}
function requireManager(res, staff){
  if(MANAGER_ROLES.has(staff.role)) return true;
  fail(res, 403, 'Only a manager or the admin can do that');
  return false;
}
/* POS terminals (Toast / CueT) authenticate with the shared POS_WEBHOOK_KEY
   sent as an X-POS-Key header; signed-in staff (the admin page) may use the
   same routes. With no key configured, terminals are simply locked out. */
function posAllowed(req){
  if(staffFromToken(req)) return true;
  const want = process.env.POS_WEBHOOK_KEY || '';
  const got = String(req.headers['x-pos-key'] || '');
  if(!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/* ---------- ledger ---------- */
function record(memberId, type, points, label, detail){
  const row = { id: randomUUID(), memberId, type, points, label,
                detail: detail || null, at: new Date().toISOString() };
  db.ledger.push(row);
  flush.ledger();
  return row;
}

const emailOk = v => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v || '').trim());
const dateOk  = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());

/* ---------- input validation ----------
   Every staff-entered field is checked here, on the server, whatever the
   page in front of it does. */
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, max);
function realDate(v){
  if(!dateOk(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d &&
         y >= 1900 && dt.getTime() <= Date.now();
}
function formatPhone(p){
  const d = phoneKey(p);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : clean(p, 30);
}
/* Member details. `partial` = only validate fields that were sent (edits).
   Returns { error } or the cleaned fields that were present. */
function memberFields(body, partial){
  const out = {};
  const has = k => !partial || Object.prototype.hasOwnProperty.call(body, k);
  if(has('name')){
    const name = clean(body.name, 80);
    if(name.length < 2) return { error: 'Name is required (2 to 80 characters)' };
    out.name = name;
  }
  if(has('email')){
    const email = clean(body.email, 120).toLowerCase();
    if(email && !emailOk(email)) return { error: 'That email does not look right' };
    out.email = email;
  }
  if(has('phone')){
    const raw = clean(body.phone, 30);
    const d = phoneKey(raw);
    if(raw && (d.length < 7 || d.length > 15 || /[^\d\s().+-]/.test(raw)))
      return { error: 'That phone number does not look right' };
    out.phone = raw ? formatPhone(raw) : '';
  }
  if(has('birthday')){
    const b = clean(body.birthday, 10);
    if(b && !realDate(b)) return { error: 'Birthday must be a real date, YYYY-MM-DD' };
    out.birthday = b;
  }
  return out;
}
const nextFreeCard = () => db.cards.filter(c => !c.memberId && !c.void)
  .sort((a, b) => (serialNumber(a.serial) || 0) - (serialNumber(b.serial) || 0))[0] || null;

/* Staff-account changes go to their own append-only audit file. */
function audit(by, action, target, detail){
  db.audit.push({ id: randomUUID(), at: new Date().toISOString(), by, action, target, detail: detail || null });
  flush.audit();
}
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
function passwordProblem(pw, username){
  const p = String(pw || '');
  if(p.length < 10) return 'Password must be at least 10 characters';
  if(p.length > 200) return 'Password is too long';
  if(p.toLowerCase().includes(String(username || '').toLowerCase()) && username) return 'Password must not contain the username';
  if(isRetiredPassword(p)) return 'That is an old published demo password — choose another';
  return null;
}
const publicStaff = a => ({ username: a.username, aliases: a.aliases || [], name: a.name, role: a.role,
  roleLabel: ROLE_LABEL[a.role] || a.role, source: a.source || 'portal', active: a.active !== false,
  createdAt: a.createdAt || null, createdBy: a.createdBy || null, updatedAt: a.updatedAt || null,
  lastLoginAt: a.lastLoginAt || null });

/* ---------- POS helpers ----------
   Toast: points are earned on the PRE-TAX, PRE-TIP subtotal. The first of
   these fields that is present is used. A payload that only carries a
   total (amount / total / spend, which may include tax and tip) is REFUSED
   and nothing is awarded: over-paying on tax and tips can't be taken back
   once a member redeems, and a refusal shows up straight away while the
   integration is being set up. The refusal is written to the POS log. */
const TOAST_SUBTOTAL_FIELDS = ['subtotal', 'netAmount', 'preTaxAmount'];
const TOAST_TOTAL_FIELDS = ['amount', 'total', 'spend'];
const present = v => v !== undefined && v !== null && v !== '';
function toastSubtotal(body){
  for(const f of TOAST_SUBTOTAL_FIELDS){
    if(!present(body[f])) continue;
    const v = Number(body[f]);
    if(!Number.isFinite(v) || v < 0) return { error: `"${f}" must be a dollar amount of 0 or more` };
    if(v > 5000) return { error: `"${f}" of $${v} looks wrong — nothing was awarded` };
    return { value: Math.round(v * 100) / 100, field: f };
  }
  const tf = TOAST_TOTAL_FIELDS.find(f => present(body[f]));
  return tf
    ? { error: `Only a total ("${tf}") was sent. Bar points are earned on the pre-tax, pre-tip subtotal — ` +
               `send "subtotal". Nothing was awarded.`, totalOnly: tf }
    : { error: 'A pre-tax, pre-tip "subtotal" is required' };
}
/* Tips earn on their own (earn.perTipDollar), from a SEPARATE field. The
   tip is never looked for inside the subtotal, so it can't be paid twice.
   Only a real, guest-chosen TIP earns: `tip` or `tipAmount`. An automatic
   service charge / auto-gratuity (e.g. added to large parties) is NOT a tip
   and earns nothing — the fields below are ignored for points, and the
   amount is written to the POS log (serviceChargeIgnored) so it is plain to
   see that it was deliberately left out. */
const TOAST_TIP_FIELDS = ['tip', 'tipAmount'];
const TOAST_SERVICE_CHARGE_FIELDS = ['gratuity', 'gratuityAmount', 'autoGratuity', 'autoGratuityAmount',
                                     'serviceCharge', 'serviceChargeAmount', 'serviceCharges'];
function toastServiceCharge(body){
  const fields = [];
  let amount = 0;
  const add = v => { const n = Number(v); if(Number.isFinite(n) && n > 0) amount += n; };
  for(const f of TOAST_SERVICE_CHARGE_FIELDS){
    const v = body[f];
    if(!present(v)) continue;
    fields.push(f);
    if(Array.isArray(v)) v.slice(0, 50).forEach(x => add(x && typeof x === 'object'
      ? (x.amount != null ? x.amount : x.chargeAmount) : x));
    else add(v);
  }
  return fields.length ? { amount: Math.round(amount * 100) / 100, fields } : null;
}
function toastTip(body){
  for(const f of TOAST_TIP_FIELDS){
    if(!present(body[f])) continue;
    const v = Number(body[f]);
    if(!Number.isFinite(v) || v < 0) return { error: `"${f}" must be a dollar amount of 0 or more` };
    if(v > 1000) return { error: `A tip ("${f}") of $${v} looks wrong — nothing was awarded` };
    return { value: Math.round(v * 100) / 100, field: f };
  }
  return { value: 0, field: null };
}
function logPos(entry){
  db.posLog.push({ id: randomUUID(), at: new Date().toISOString(), ...entry });
  flush.posLog();
}
function applyBonuses(m, now, rows, { birthday = true } = {}){
  if(birthday){
    const bday = birthdayDue(PROGRAM, m, now);
    if(bday){
      m.balance += bday; m.lifetime += bday;
      m.birthdayBonusYear = now.getFullYear();
      rows.push(record(m.id, 'earn', bday, 'Birthday month bonus'));
    }
  }
  const visit = visitBonusDue(PROGRAM, m, db.ledger, now);
  if(visit){
    m.balance += visit; m.lifetime += visit;
    m.visitBonusMonth = now.toISOString().slice(0, 7);
    rows.push(record(m.id, 'earn', visit, `${PROGRAM.earn.visitStreakCount}th visit this month`));
  }
}
function awardToast(m, { checkId, subtotal, subtotalField, tip = 0, tipField = null, items, serverName, serviceCharge = null }){
  const now = new Date();
  const sc = serviceCharge ? { serviceChargeIgnored: serviceCharge.amount, serviceChargeFields: serviceCharge.fields } : {};
  const q = quoteToastEarn(PROGRAM, m, { checkId, amount: subtotal, tip, items, when: now });
  const rows = [];
  m.balance += q.points; m.lifetime += q.points;
  rows.push(record(m.id, 'earn', q.points, `Toast Bar Tab #${checkId}`,
    { pos: 'toast', checkId, spend: subtotal, barSpend: subtotal, subtotalField, tip, tipField,
      items, serverName, breakdown: q.lines, ...sc }));
  applyBonuses(m, now, rows);
  flush.members();
  logPos({ source: 'toast', checkId, memberId: m.id, memberNo: m.memberNo, amount: subtotal,
           subtotalField, tip, tipField, points: q.points, serverName, ...sc });
  return { ok: true, source: 'toast', checkId, subtotal, tip, breakdown: q.lines, ...sc,
           awarded: rows.reduce((a, r) => a + r.points, 0),
           member: staffMember(m) };
}
function cuetFields(body, defaults = {}){
  const tableHours = present(body.tableHours) ? Number(body.tableHours)
                   : present(body.hours) ? Number(body.hours)
                   : present(body.duration) ? Number(body.duration) : defaults.tableHours;
  const rate = present(body.rate) ? Number(body.rate) : 15;
  if(!Number.isFinite(tableHours) || tableHours <= 0 || tableHours > 24)
    return { error: 'tableHours must be more than 0 and at most 24' };
  if(!Number.isFinite(rate) || rate < 0 || rate > 500) return { error: 'rate must be between $0 and $500 an hour' };
  return { tableHours: Math.round(tableHours * 100) / 100, rate };
}
function awardCuet(m, { sessionId, tableNo, tableHours, rate, cashier }){
  const now = new Date();
  const q = quoteCueTEarn(PROGRAM, m, { tableNo, tableHours, rate, when: now });
  const rows = [];
  m.balance += q.points; m.lifetime += q.points;
  rows.push(record(m.id, 'earn', q.points, `CueT Table #${tableNo} (${tableHours}h)`, {
    pos: 'cuet', sessionId, tableNo, tableHours, rate, grossAmount: q.grossAmount,
    discountPct: q.discountPct, discountAmount: q.discountAmount, spend: q.netAmount,
    cashier, breakdown: q.lines }));
  applyBonuses(m, now, rows, { birthday: false });
  flush.members();
  logPos({ source: 'cuet', sessionId, tableNo, tableHours, grossAmount: q.grossAmount,
           discountPct: q.discountPct, netAmount: q.netAmount, points: q.points,
           memberId: m.id, memberNo: m.memberNo, cashier });
  return { ok: true, source: 'cuet', sessionId, tableNo, tableHours, discountPct: q.discountPct,
           netAmount: q.netAmount, awarded: rows.reduce((a, r) => a + r.points, 0),
           tableTracker: tablePunchStatus(PROGRAM, m, db.ledger), member: staffMember(m) };
}

/* ---------- redemption codes (free table time) ----------
   A code stands for "this member may have this reward". Two ways to get one:
     member-app — the member taps a reward in the app (short-lived)
     pos        — the register / CueT asks for one (POST /api/pos/redeem-code,
                  or requestRedeemCode on an earn), printed on the receipt
   HOLDS: making a code RESERVES its points straight away. The member still
   owns them (`balance` is unchanged) but they are HELD, so
       available = balance − points held by the member's open codes
   and a code can only be made when `available` covers it. A hold is simply
   an open (pending, unexpired) code in codes.json — there is no second
   counter that could drift — so holds survive a restart, and a code whose
   time is up stops holding points the instant it expires, on every read,
   whether or not the sweep has run yet. What happens to a hold:
     redeemed  -> the held points are taken off the balance (once, here only)
     cancelled -> released (manager / admin only, or closing the account,
                  replacing a lost card, or a newer app code replacing it)
     expired   -> released (the sweep logs it; the maths never waits for it)
   Every hold and release is written to the member's history.
   Limits: one app code at a time (a new one replaces — and releases — the
   old one) and redeemCodes.maxOpenPosCodes register codes (default 2).
   A code works once. Finished codes stay as a record for 90 days. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   /* no 0/O, 1/I/L */
const CODE_LEN = 6;
const CODE_KEEP_DAYS = 90;
const codeCfg = () => {
  const rc = PROGRAM.redeemCodes || {};
  return { posHours: Number(rc.posExpiryHours) || 24, memberMinutes: Number(rc.memberExpiryMinutes) || 15,
           maxPos: Number(rc.maxOpenPosCodes) || 2 };
};
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
function newRedeemCode(){
  const taken = new Set(db.codes.map(c => c.code));
  for(let i = 0; i < 1000; i++){
    let c = '';
    for(let j = 0; j < CODE_LEN; j++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if(!taken.has(c)) return c;
  }
  throw new Error('could not make a unique redemption code');
}
const SRC_NAME = { 'member-app': 'app', pos: 'register' };
/* Release a pending code's hold: it is now cancelled or expired. Writes a
   'release' row (0 points: the balance never moved, the hold just ends).
   The caller flushes codes.json. */
function releaseCode(c, status, { by = null, reason = null, at = new Date().toISOString() } = {}){
  if(c.status !== 'pending') return false;
  if(status === 'expired') Object.assign(c, { status: 'expired', expiredAt: at });
  else Object.assign(c, { status: 'cancelled', cancelledAt: at, cancelledBy: by, cancelReason: reason });
  const why = status === 'expired' ? 'expired' : `cancelled${reason ? ' — ' + reason : ''}`;
  record(c.memberId, 'release', 0, `${num(c.cost)} points released: code ${c.code} ${why}`,
         { held: c.cost, code: c.code, rewardId: c.rewardId, source: c.source, status, by, reason });
  return true;
}
const num = n => Number(n || 0).toLocaleString('en-US');
/* Release the holds of codes whose time is up, and forget finished codes
   after CODE_KEEP_DAYS. Runs at start-up, every minute, and before every API
   request — but held/available never depend on it: they only count codes
   that are pending AND unexpired, so an overdue code holds nothing even if
   the sweep has not run yet. */
function sweepCodes(){
  const now = Date.now(), cutoff = now - CODE_KEEP_DAYS * 864e5;
  let dirty = false;
  for(const c of db.codes){
    if(c.status === 'pending' && Date.parse(c.expiresAt) <= now){
      releaseCode(c, 'expired', { at: c.expiresAt }); dirty = true;
    }
  }
  const keep = db.codes.filter(c => c.status === 'pending' || Date.parse(c.createdAt) > cutoff);
  if(keep.length !== db.codes.length){ db.codes = keep; dirty = true; }
  if(dirty) flush.codes();
}
/* Tier overrides past their expiresAt: the tier has already reverted (the
   check is made on every read); this clears the override and logs it. */
function sweepTierOverrides(){
  const now = Date.now();
  let dirty = false;
  for(const m of db.members){
    const o = m.tierOverride;
    if(!o || !overrideExpired(o, now)) continue;
    m.tierOverride = null;
    dirty = true;
    const t = tierByKey(PROGRAM, o.key);
    record(m.id, 'tier', 0, `Tier override (${t ? t.name : o.key}) expired — back to ${memberTier(PROGRAM, m).name} by lifetime points`,
           { by: 'system', reason: `Override set ${String(o.at || '').slice(0, 10)} expired ${String(o.expiresAt).slice(0, 10)}`,
             from: o.key, to: null, expired: true });
  }
  if(dirty) flush.members();
}
function sweep(){ sweepCodes(); sweepTierOverrides(); }
/* Older overrides were set with no end date: give them one, counted from
   the day they were set (the approved rule is 12 months). */
{
  let dirty = false;
  for(const m of db.members){
    if(m.tierOverride && !m.tierOverride.expiresAt){
      m.tierOverride.expiresAt = addMonths(m.tierOverride.at || new Date(), overrideMonths(PROGRAM));
      dirty = true;
    }
  }
  if(dirty) flush.members();
}
sweep();
setInterval(sweep, 60e3).unref();

const pendingCodesFor = memberId => {
  const now = Date.now();
  return db.codes.filter(c => c.memberId === memberId && c.status === 'pending' && Date.parse(c.expiresAt) > now);
};
/* Points held by a member's open codes, and what is left to spend. */
const heldFor = memberId => pendingCodesFor(memberId).reduce((a, c) => a + (Number(c.cost) || 0), 0);
const availableFor = m => m.balance - heldFor(m.id);

/* Make a code and put its points on hold. The caller has checked that the
   available balance covers it. */
function createCode(m, r, { source, by, ttlMs, context = null }){
  const now = Date.now();
  const c = { code: newRedeemCode(), source, status: 'pending', memberId: m.id, memberNo: m.memberNo,
              rewardId: r.id, rewardName: r.name, cost: r.cost,
              createdAt: new Date(now).toISOString(), createdBy: by || null,
              expiresAt: new Date(now + ttlMs).toISOString(), context };
  db.codes.push(c);
  flush.codes();
  record(m.id, 'hold', 0, `${num(r.cost)} points held: code ${c.code} for ${r.name} (${SRC_NAME[source] || source})`,
         { held: r.cost, code: c.code, rewardId: r.id, source, by: by || null, expiresAt: c.expiresAt });
  return c;
}
/* Cancel a member's pending codes (all, or only one source), releasing
   their holds. Returns how many. */
function cancelCodes(memberId, { reason, by, source = null }){
  const at = new Date().toISOString();
  let n = 0, dirty = false;
  for(const c of db.codes){
    if(c.memberId !== memberId || c.status !== 'pending' || (source && c.source !== source)) continue;
    dirty = true;
    if(Date.parse(c.expiresAt) <= Date.now()) releaseCode(c, 'expired', { at: c.expiresAt });
    else { releaseCode(c, 'cancelled', { by: by || null, reason: reason || null, at }); n++; }
  }
  if(dirty) flush.codes();
  return n;
}
function publicCode(c){
  const m = findById(c.memberId);
  return { code: c.code, source: c.source, status: c.status, memberId: c.memberId,
           memberNo: m ? m.memberNo : c.memberNo, member: m ? m.name : '?',
           rewardId: c.rewardId, reward: c.rewardName, cost: c.cost,
           createdAt: c.createdAt, createdBy: c.createdBy, expiresAt: c.expiresAt,
           confirmedAt: c.confirmedAt || null, confirmedBy: c.confirmedBy || null,
           cancelledAt: c.cancelledAt || null, cancelledBy: c.cancelledBy || null, cancelReason: c.cancelReason || null };
}
/* Staff view of a member: everything publicMember gives, plus open codes. */
const staffMember = m => ({ ...publicMember(PROGRAM, m, db.ledger, { held: heldFor(m.id) }),
                            pendingCodes: pendingCodesFor(m.id).map(publicCode) });
/* The member's own view: their open codes (the holds) are listed too. */
const memberView = m => {
  const open = pendingCodesFor(m.id);
  return publicMember(PROGRAM, m, db.ledger, { forMember: true,
    held: open.reduce((a, c) => a + (Number(c.cost) || 0), 0),
    holds: open.map(c => ({ code: c.code, reward: c.rewardName, cost: c.cost, source: c.source,
                            createdAt: c.createdAt, expiresAt: c.expiresAt })) });
};
const shortBy = (m, cost) => {
  const held = heldFor(m.id), avail = m.balance - held;
  return `needs ${num(cost - avail)} more` + (held ? ` (${num(held)} of their ${num(m.balance)} points are held by open codes)` : '');
};

/* Issue a register code (POS / CueT / Front Desk "Code for later"). The
   points are HELD now; they come off when the Front Desk redeems it. */
function issuePosCode(m, rewardId, { by, context }){
  const r = rewardById(PROGRAM, rewardId);   /* table-time rewards only */
  if(!r) return { status: 400, error: 'Unknown reward — codes are for free table time only' };
  if(m.active === false) return { status: 400, error: 'Account is inactive' };
  const { posHours, maxPos } = codeCfg();
  if(pendingCodesFor(m.id).filter(c => c.source === 'pos').length >= maxPos)
    return { status: 429, error: `This member already has ${maxPos} register codes waiting — redeem one, or ask a manager to cancel one` };
  if(availableFor(m) < r.cost) return { status: 400, error: `Not enough points for ${r.name} — ${shortBy(m, r.cost)}` };
  const c = createCode(m, r, { source: 'pos', by, ttlMs: posHours * 3600e3, context });
  logPos({ source: 'redeem-code', code: c.code, rewardId: r.id, memberId: m.id, memberNo: m.memberNo,
           points: 0, held: r.cost, cost: r.cost, expiresAt: c.expiresAt, by, ...(context ? { context } : {}) });
  const held = heldFor(m.id);
  return { ok: true, code: c.code, reward: { id: r.id, name: r.name, cost: r.cost },
           member: { memberNo: m.memberNo, name: m.name, balance: m.balance, held, available: m.balance - held },
           expiresAt: c.expiresAt, expiresInHours: posHours,
           receiptText: `${r.name} — code ${c.code}. Show this at the Front Desk. ` +
                        `${r.cost} points are held for it and come off when it is used. Valid ${posHours}h, once.` };
}
/* Optional "requestRedeemCode": rewardId on a CueT / Toast earn. The earn
   always stands; the code is added if it can be issued, else a reason. */
function attachCode(result, m, rewardId, by, context){
  if(!present(rewardId)) return result;
  const c = issuePosCode(m, String(rewardId), { by, context });
  return c.ok ? { ...result, redeemCode: c } : { ...result, redeemCodeError: c.error };
}

/* ---------- claim codes ----------
   How a member takes ownership of the account staff just created for them.

   At signup the member gets a short code. They open the app, enter it once,
   and CHOOSE THEIR OWN PIN — which means no PIN is ever written on a slip of
   paper, and nobody at the bar ever knows it. The code is one-time and
   expires, so a dropped receipt isn't a way into someone's account.

   Persisted with the member (not in memory) so a server restart mid-shift
   doesn't strand everyone who signed up that night. */
const CLAIM_TTL_HOURS = 72;
const newClaimCode = () => randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
const claimValid = m => m && m.claimCode && m.claimExpires > Date.now() && !m.claimed;

/* ============================================================
   ROUTES
   ============================================================ */
async function route(req, res, url){
  const path = url.pathname;
  const body = (req.method === 'POST') ? await readBody(req) : {};
  if(path.startsWith('/api/')) sweep();     /* release expired holds / overrides before answering */

  /* ---------- public ---------- */
  if(path === '/api/health') return ok(res, { ok: true, members: db.members.length });

  if(path === '/api/program'){
    return ok(res, {
      brand: PROGRAM.brand, earn: PROGRAM.earn, tiers: PROGRAM.tiers,
      rewards: tableRewards(PROGRAM), terms: PROGRAM.terms,
      redeemCodes: { posExpiryHours: codeCfg().posHours, memberExpiryMinutes: codeCfg().memberMinutes,
                     maxOpenPosCodes: codeCfg().maxPos },
      tierOverride: { expiryMonths: overrideMonths(PROGRAM) }
    });
  }

  /* ---------- card check (public) ----------
     Is this a real Breaker card? Accepts the number exactly as printed on the
     card ("0001") or the id ("BB0001"). Deliberately says nothing about who
     holds it — seeing a balance needs the member's PIN. */
  if(path === '/api/card' || path.startsWith('/api/card/')){
    const raw = path.startsWith('/api/card/') ? decodeURIComponent(path.slice('/api/card/'.length))
                                              : (url.searchParams.get('id') || '');
    const card = findCard(raw);
    if(!card) return fail(res, 404, 'That is not a Breaker Billiards card number');
    return ok(res, {
      serial: card.serial,
      printedAs: String(serialNumber(card.serial)).padStart(4, '0'),
      status: card.void ? 'void' : (card.memberId ? 'active' : 'unassigned')
    });
  }

  /* ---------- member ---------- */
  if(path === '/api/member/login' && req.method === 'POST'){
    const ident = String(body.ident || '').trim();
    const key = 'm:' + ident.toLowerCase();
    if(throttled(key)) return fail(res, 429, 'Too many attempts. Try again in 15 minutes.');
    const m = findByAny(ident);
    if(m && m.active !== false && !m.pinHash && claimValid(m)){
      /* signed up but never claimed — point them at the right screen rather
         than letting them bounce off a PIN they were never given */
      return fail(res, 409, 'This account has not been set up yet. Use the claim code from the bar.');
    }
    if(!m || m.active === false || !m.pinHash || !verifyHash(body.pin, m.pinHash)){
      noteFail(key);
      /* same message either way — don't reveal which member numbers exist */
      return fail(res, 401, 'Member number or PIN not recognised');
    }
    clearFails(key);
    return ok(res, {
      token: sign({ sub: m.id, role: 'member' }, SECRET, 24 * 365),
      member: memberView(m)
    });
  }

  if(path === '/api/member/me'){
    const m = requireMember(req, res); if(!m) return;
    return ok(res, { member: memberView(m) });
  }

  if(path === '/api/member/pin' && req.method === 'POST'){
    const m = requireMember(req, res); if(!m) return;
    if(!verifyHash(body.currentPin, m.pinHash)) return fail(res, 403, 'Current PIN is wrong');
    if(!pinOk(body.newPin)) return fail(res, 400, 'New PIN must be 4 digits');
    m.pinHash = hash(body.newPin);
    flush.members();
    return ok(res, { ok: true });
  }

  /* Member makes a code in the app. The points are HELD now (not taken):
     they come off when the Front Desk redeems the code, and are released if
     it expires or is cancelled. One app code at a time — a new one replaces
     the old one and releases its hold first. */
  if(path === '/api/member/redeem' && req.method === 'POST'){
    const m = requireMember(req, res); if(!m) return;
    const r = rewardById(PROGRAM, body.rewardId);   /* table-time rewards only */
    if(!r) return fail(res, 400, 'Unknown reward — rewards are free table time only');
    const oldHeld = pendingCodesFor(m.id).filter(c => c.source === 'member-app').reduce((a, c) => a + c.cost, 0);
    const avail = availableFor(m) + oldHeld;       /* the old app code is about to be released */
    if(avail < r.cost){
      const held = heldFor(m.id) - oldHeld;
      return fail(res, 400, `Not enough points — you need ${num(r.cost - avail)} more` +
                            (held ? ` (${num(held)} of your points are held by codes you already have)` : ''));
    }
    cancelCodes(m.id, { reason: 'Replaced by a newer code from the app', by: 'member', source: 'member-app' });
    const { memberMinutes } = codeCfg();
    const c = createCode(m, r, { source: 'member-app', by: 'member', ttlMs: memberMinutes * 60e3 });
    return ok(res, { code: c.code, reward: r, expiresInMinutes: memberMinutes, expiresAt: c.expiresAt,
                     member: memberView(m) });
  }

  /* Check a claim code before asking for a PIN, so the member sees their own
     name and knows they typed it right. */
  if(path === '/api/member/claim/check'){
    const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
    const m = db.members.find(x => x.claimCode === code);
    if(!claimValid(m)) return fail(res, 404, 'That code is not valid, has expired, or has already been used');
    return ok(res, { name: m.name, memberNo: m.memberNo });
  }

  /* Claim: set your own PIN, once. Burns the code. */
  if(path === '/api/member/claim' && req.method === 'POST'){
    const code = String(body.code || '').trim().toUpperCase();
    const key = 'c:' + code;
    if(throttled(key)) return fail(res, 429, 'Too many attempts. Try again in 15 minutes.');
    const m = db.members.find(x => x.claimCode === code);
    if(!claimValid(m)){
      noteFail(key);
      return fail(res, 404, 'That code is not valid, has expired, or has already been used');
    }
    if(!pinOk(body.pin)) return fail(res, 400, 'Choose a 4-digit PIN');
    m.pinHash = hash(body.pin);
    m.claimed = true;
    m.claimCode = null;
    m.claimExpires = null;
    flush.members();
    clearFails(key);
    record(m.id, 'note', 0, 'Account claimed — PIN set by member');
    return ok(res, {
      token: sign({ sub: m.id, role: 'member' }, SECRET, 24 * 365),
      member: memberView(m)
    });
  }

  /* ============================================================
     POS INTEGRATIONS — Toast POS (Bar) & CueT POS (Billiards)
     ============================================================ */

  if(path.startsWith('/api/pos/') && !posAllowed(req))
    return fail(res, 401, 'POS key (X-POS-Key header) or staff sign-in required');

  /* Toast POS Webhook / Bar Check Closed — bar/food spend earns
     earn.perDollar points (rounded down per check), idempotent by checkId. */
  if(path === '/api/pos/toast/order-closed' && req.method === 'POST'){
    const checkId = clean(body.checkId || body.orderId, 64);
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    const ident = body.memberIdent || body.phone || body.email || body.memberNo || body.serial;
    const serverName = clean(body.serverName || body.bartender || 'Toast Register', 60);

    /* A check number is required: it is what stops a retried webhook paying twice. */
    if(!checkId) return fail(res, 400, 'checkId (the Toast check / order number) is required');
    if(!ident) return fail(res, 400, 'Member identifier (number, phone, or email) required');
    const m = findByAny(ident);
    if(!m) return fail(res, 404, `No member found for "${clean(ident, 60)}"`);
    if(m.active === false) return fail(res, 400, 'Account is inactive');

    /* Idempotency: a check that was already paid is never paid again. */
    const existing = db.posLog.find(p => p.source === 'toast' && p.checkId === checkId && p.status !== 'rejected');
    if(existing) return ok(res, { ok: true, duplicate: true, checkId, message: 'Check already processed' });

    const sub = toastSubtotal(body);
    if(sub.error){
      console.warn(`  ! Toast check ${checkId} refused: ${sub.error}`);
      logPos({ source: 'toast', status: 'rejected', checkId, memberId: m.id, memberNo: m.memberNo,
               amount: present(body[sub.totalOnly]) ? Number(body[sub.totalOnly]) || 0 : 0,
               points: 0, reason: sub.error, serverName });
      return fail(res, 422, sub.error);
    }
    const tip = toastTip(body);
    if(tip.error){
      console.warn(`  ! Toast check ${checkId} refused: ${tip.error}`);
      logPos({ source: 'toast', status: 'rejected', checkId, memberId: m.id, memberNo: m.memberNo,
               amount: sub.value, points: 0, reason: tip.error, serverName });
      return fail(res, 422, tip.error);
    }
    const out = awardToast(m, { checkId, subtotal: sub.value, subtotalField: sub.field,
                                tip: tip.value, tipField: tip.field, items, serverName,
                                serviceCharge: toastServiceCharge(body) });
    return ok(res, attachCode(out, m, body.requestRedeemCode, `Toast: ${serverName}`, { checkId }));
  }

  /* CueT POS Webhook / Table Rental Session Closed */
  if(path === '/api/pos/cuet/session-closed' && req.method === 'POST'){
    const sessionId = clean(body.sessionId, 64);
    const tableNo = clean(body.tableNo || '1', 10);
    const ident = body.memberIdent || body.memberNo || body.serial || body.phone;
    const cashier = clean(body.cashier || 'CueT Terminal', 60);

    if(!sessionId) return fail(res, 400, 'sessionId is required');
    if(!ident) return fail(res, 400, 'Member identifier (number or phone) required');
    const m = findByAny(ident);
    if(!m) return fail(res, 404, `No member found for "${clean(ident, 60)}"`);
    if(m.active === false) return fail(res, 400, 'Account is inactive');

    const existing = db.posLog.find(p => p.source === 'cuet' && p.sessionId === sessionId);
    if(existing) return ok(res, { ok: true, duplicate: true, sessionId, message: 'Table session already processed' });

    const f = cuetFields(body);
    if(f.error) return fail(res, 400, f.error);
    const out = awardCuet(m, { sessionId, tableNo, tableHours: f.tableHours, rate: f.rate, cashier });
    return ok(res, attachCode(out, m, body.requestRedeemCode, `CueT: ${cashier}`, { sessionId, tableNo }));
  }

  /* POS asks for a free-table-time redemption code (for the receipt or the
     screen). The points are HELD now and come off when the Front Desk
     redeems the code. */
  if(path === '/api/pos/redeem-code' && req.method === 'POST'){
    const ident = body.memberIdent || body.memberNo || body.serial || body.card || body.phone || body.email;
    if(!ident) return fail(res, 400, 'Member identifier (card number, phone or email) required');
    if(!present(body.rewardId)) return fail(res, 400, 'rewardId (a table-time reward) is required');
    const m = findByAny(ident);
    if(!m) return fail(res, 404, `No member found for "${clean(ident, 60)}"`);
    const by = clean(body.terminal || body.cashier || body.serverName || 'POS terminal', 60);
    const c = issuePosCode(m, String(body.rewardId), { by, context: null });
    if(!c.ok) return fail(res, c.status, c.error);
    return ok(res, c);
  }

  /* CueT Member Lookup for Terminal */
  if(path === '/api/pos/cuet/lookup' && (req.method === 'POST' || req.method === 'GET')){
    const ident = req.method === 'GET' ? (url.searchParams.get('ident') || url.searchParams.get('serial') || url.searchParams.get('q')) : (body.ident || body.serial || body.phone);
    if(!ident) return fail(res, 400, 'Member serial or phone required');
    const m = findByAny(ident);
    if(!m) return fail(res, 404, 'Member not found');
    if(m.active === false) return fail(res, 400, 'Account is inactive');
    const tier = memberTier(PROGRAM, m);
    const tracker = tablePunchStatus(PROGRAM, m, db.ledger);
    return ok(res, {
      ok: true,
      memberNo: m.memberNo,
      name: m.name,
      phone: m.phone || '',
      tier: tier.name,
      tableDiscountPct: tier.tableDiscount || 0,
      tableTracker: tracker,
      pointsBalance: m.balance,
      pointsHeld: heldFor(m.id),
      pointsAvailable: availableFor(m)
    });
  }

  /* ---------- staff & admin login ---------- */
  if(path === '/api/admin/login' && req.method === 'POST'){
    const key = 'a:' + clientIp(req);
    if(throttled(key)) return fail(res, 429, 'Too many attempts. Try again in 15 minutes.');
    const user = String(body.user || '').trim().toLowerCase().slice(0, 64);
    const acct = staffAccount(user);
    const good = verifyHash(String(body.pass || '').slice(0, 200), acct ? acct.hash : DUMMY_HASH);
    if(!acct || !good){
      noteFail(key);
      return fail(res, 401, 'Wrong username or password');
    }
    if(acct.active === false) return fail(res, 403, 'This login has been switched off — ask a manager');
    clearFails(key);
    if(acct.source === 'portal'){
      const rec = db.staff.find(x => x.username === acct.username);
      rec.lastLoginAt = new Date().toISOString(); flush.staff();
    }
    return ok(res, {
      token: sign({ kind: 'staff', sub: acct.name, username: acct.username, role: acct.role,
                    pv: passVersion(acct) }, SECRET, 12),
      user: acct.name, username: acct.username, role: acct.role, roleLabel: ROLE_LABEL[acct.role]
    });
  }

  if(path.startsWith('/api/admin/')){
    const admin = requireAdmin(req, res); if(!admin) return;
    /* Manager/admin only. Everything else under /api/admin/ is open to any
       signed-in staff login (front desk included). */
    const MANAGER_ONLY = ['/api/admin/adjust', '/api/admin/export', '/api/admin/cards/batch',
                          '/api/admin/cards/void', '/api/admin/pos/clear', '/api/admin/active',
                          '/api/admin/members/tier', '/api/admin/audit', '/api/admin/codes/cancel'];
    if((MANAGER_ONLY.includes(path) || path.startsWith('/api/admin/staff')) && !requireManager(res, admin)) return;

    if(path === '/api/admin/me'){
      return ok(res, { user: admin.name, username: admin.username, role: admin.role,
                       roleLabel: ROLE_LABEL[admin.role], isManager: isManager(admin),
                       canManage: ['manager', 'desk'].filter(r => canManageRole(admin, r)) });
    }

    if(path === '/api/admin/stats'){
      const now = new Date(), ym = now.toISOString().slice(0, 7);
      const month = db.ledger.filter(r => r.at.slice(0, 7) === ym);
      const bMonth = now.getMonth() + 1;
      return ok(res, {
        members: db.members.length,
        activeMembers: db.members.filter(m => m.active !== false).length,
        cardsUnassigned: db.cards.filter(c => !c.memberId && !c.void).length,
        cardsTotal: db.cards.length,
        pointsOutstanding: db.members.reduce((a, m) => a + m.balance, 0),
        pointsHeld: db.codes.filter(c => c.status === 'pending' && Date.parse(c.expiresAt) > Date.now())
          .reduce((a, c) => a + (Number(c.cost) || 0), 0),
        earnedThisMonth: month.filter(r => r.type === 'earn').reduce((a, r) => a + r.points, 0),
        redeemedThisMonth: Math.abs(month.filter(r => r.type === 'redeem').reduce((a, r) => a + r.points, 0)),
        signupsThisMonth: db.members.filter(m => m.joined.slice(0, 7) === ym).length,
        birthdaysThisMonth: db.members.filter(m =>
          m.birthday && Number(m.birthday.split('-')[1]) === bMonth).length,
        tierCounts: PROGRAM.tiers.map(t => ({
          name: t.name,
          count: db.members.filter(m => memberTier(PROGRAM, m).key === t.key).length
        })),
        pendingVouchers: db.codes.filter(c => c.status === 'pending' && Date.parse(c.expiresAt) > Date.now())
          .map(publicCode)
      });
    }

    if(path === '/api/admin/members' && req.method === 'GET'){
      /* search by name, card number (any way it's typed), phone or email */
      const q = clean(url.searchParams.get('q'), 80).toLowerCase();
      const qSerial = normSerial(q), qPhone = phoneKey(q);
      let list = db.members;
      if(q) list = list.filter(m =>
        String(m.name || '').toLowerCase().includes(q) || String(m.email || '').toLowerCase().includes(q) ||
        m.memberNo.toLowerCase().includes(q) || m.memberNo === qSerial ||
        (qPhone.length >= 3 && phoneKey(m.phone).includes(qPhone)));
      list = [...list].sort((a, b) => (a.joined < b.joined ? 1 : -1)).slice(0, 200);
      return ok(res, { members: list.map(m => {
        const t = memberTier(PROGRAM, m);
        return { id: m.id, memberNo: m.memberNo, name: m.name, email: m.email || '', phone: m.phone || '',
                 birthday: m.birthday || '', balance: m.balance, held: heldFor(m.id), lifetime: m.lifetime,
                 joined: m.joined, active: m.active !== false, tier: t.name, tierKey: t.key,
                 tierOverride: !!(m.tierOverride && !overrideExpired(m.tierOverride)),
                 tierUntil: m.tierOverride && !overrideExpired(m.tierOverride) ? m.tierOverride.expiresAt || null : null };
      }) });
    }

    /* STAFF SIGNUP — the only way an account is created. The card defaults
       to the next blank in the drawer; staff can pick any other unassigned
       card. Name plus a phone OR an email (both unique). Birthday optional.
       A manager may pin a starting tier. Returns the PIN in plain text
       exactly once, for staff to hand over; it is stored hashed. */
    if(path === '/api/admin/members' && req.method === 'POST'){
      const f = memberFields(body, false);
      if(f.error) return fail(res, 400, f.error);
      if(!f.email && !f.phone) return fail(res, 400, 'Enter a phone number or an email (at least one)');
      const dupE = f.email && findByEmail(f.email);
      if(dupE) return fail(res, 409, `That email is already on card ${dupE.memberNo}`);
      const dupP = f.phone && findByPhone(f.phone);
      if(dupP) return fail(res, 409, `That phone number is already on card ${dupP.memberNo}`);
      if(present(body.pin) && !pinOk(body.pin)) return fail(res, 400, 'PIN must be 4 digits (or leave it blank for a random one)');

      let tierOverride = null;
      if(present(body.tierOverride)){
        if(!isManager(admin)) return fail(res, 403, 'Only a manager or the admin can set a tier');
        const t = tierByKey(PROGRAM, String(body.tierOverride));
        if(!t) return fail(res, 400, 'Unknown tier');
        const at = new Date().toISOString();
        tierOverride = { key: t.key, by: admin.sub, at, expiresAt: addMonths(at, overrideMonths(PROGRAM)),
                         reason: clean(body.tierReason, 200) || 'Set at signup' };
      }

      let card;
      if(present(body.serial)){
        const serial = normSerial(body.serial);
        card = findCard(serial);
        if(!card) return fail(res, 404, `Card ${serial} is not in the system — mint that batch first`);
        if(card.void) return fail(res, 400, `Card ${serial} was voided and cannot be reused`);
        if(card.memberId) return fail(res, 409, `Card ${serial} is already assigned to someone`);
      } else {
        card = nextFreeCard();
        if(!card) return fail(res, 409, 'No blank cards left — mint a batch on the Cards tab first');
      }

      const assignedPin = pinOk(body.pin) ? String(body.pin) : randomPin();
      const m = {
        id: randomUUID(),
        memberNo: card.serial,
        name: f.name, email: f.email, phone: f.phone, birthday: f.birthday,
        claimCode: null, claimExpires: null,
        claimed: true,
        pinHash: hash(assignedPin),
        balance: 0, lifetime: 0,
        joined: new Date().toISOString(),
        active: true,
        tierOverride,
        birthdayBonusYear: null,
        visitBonusMonth: null,
        signedUpBy: admin.sub
      };
      card.memberId = m.id;
      card.assignedAt = new Date().toISOString();
      db.members.push(m);
      flush.members(); flush.cards();
      record(m.id, 'join', 0, `Joined — card ${card.serial}`, { by: admin.sub });
      if(tierOverride){
        record(m.id, 'tier', 0, `Tier set to ${tierByKey(PROGRAM, tierOverride.key).name} (override, until ${tierOverride.expiresAt.slice(0, 10)})`,
               { by: admin.sub, reason: tierOverride.reason, to: tierOverride.key, expiresAt: tierOverride.expiresAt });
        audit(admin.sub, 'member.tier', m.memberNo, { memberId: m.id, to: tierOverride.key, expiresAt: tierOverride.expiresAt, reason: tierOverride.reason });
      }
      return ok(res, { member: staffMember(m), pin: assignedPin,
                       serial: card.serial });
    }

    /* EDIT DETAILS — name, phone, email, birthday. Any staff login (front
       desk included). Every change is written to the member's history with
       before/after values and who made it, and to the audit log. */
    if(path === '/api/admin/members/update' && req.method === 'POST'){
      const m = findById(body.memberId);
      if(!m) return fail(res, 404, 'No member found');
      const f = memberFields(body, true);
      if(f.error) return fail(res, 400, f.error);
      const next = { name: m.name, email: m.email || '', phone: m.phone || '', birthday: m.birthday || '', ...f };
      if(!next.email && !next.phone) return fail(res, 400, 'A member needs a phone number or an email (at least one)');
      if(f.email){ const d = findByEmail(f.email); if(d && d.id !== m.id) return fail(res, 409, `That email is already on card ${d.memberNo}`); }
      if(f.phone){ const d = findByPhone(f.phone); if(d && d.id !== m.id) return fail(res, 409, `That phone number is already on card ${d.memberNo}`); }
      const changes = {};
      for(const k of ['name', 'email', 'phone', 'birthday'])
        if(k in f && String(m[k] || '') !== next[k]) changes[k] = { from: m[k] || '', to: next[k] };
      if(!Object.keys(changes).length) return ok(res, { member: staffMember(m), changed: [] });
      for(const k of Object.keys(changes)) m[k] = next[k];
      flush.members();
      record(m.id, 'edit', 0, `Details updated: ${Object.keys(changes).join(', ')}`,
             { by: admin.sub, changes, reason: clean(body.reason, 200) || null });
      audit(admin.sub, 'member.edit', m.memberNo, { memberId: m.id, role: admin.role, fields: Object.keys(changes),
                                                    reason: clean(body.reason, 200) || null });
      return ok(res, { member: staffMember(m), changed: Object.keys(changes) });
    }

    /* TIER OVERRIDE (manager/admin) — pin a member to a tier, or clear it so
       the tier follows lifetime points again. Reason required; logged. */
    if(path === '/api/admin/members/tier' && req.method === 'POST'){
      const m = findById(body.memberId);
      if(!m) return fail(res, 404, 'No member found');
      const reason = clean(body.reason, 200);
      if(reason.length < 3) return fail(res, 400, 'A reason is required for a tier change');
      const before = memberTier(PROGRAM, m);
      if(!present(body.tier)){
        if(!m.tierOverride) return fail(res, 400, 'This member has no tier override to clear');
        const was = m.tierOverride;
        m.tierOverride = null;
        flush.members();
        const now = memberTier(PROGRAM, m);
        record(m.id, 'tier', 0, `Tier override cleared — ${now.name} by lifetime points`,
               { by: admin.sub, reason, from: was.key, to: null });
        audit(admin.sub, 'member.tier-clear', m.memberNo, { memberId: m.id, from: was.key, reason });
      } else {
        const t = tierByKey(PROGRAM, String(body.tier));
        if(!t) return fail(res, 400, 'Unknown tier');
        /* every override ends: tierOverride.expiryMonths (default 12) from now */
        const at = new Date().toISOString();
        const expiresAt = addMonths(at, overrideMonths(PROGRAM));
        m.tierOverride = { key: t.key, by: admin.sub, at, expiresAt, reason };
        flush.members();
        record(m.id, 'tier', 0, `Tier set to ${t.name} (override until ${expiresAt.slice(0, 10)}, was ${before.name})`,
               { by: admin.sub, reason, from: before.key, to: t.key, expiresAt });
        audit(admin.sub, 'member.tier', m.memberNo, { memberId: m.id, from: before.key, to: t.key, expiresAt, reason });
      }
      return ok(res, { member: staffMember(m) });
    }

    /* ---------- staff logins (manager/admin; see canManageRole) ---------- */
    if(path === '/api/admin/staff' && req.method === 'GET'){
      return ok(res, {
        env: ENV_LIST.map(publicStaff),
        staff: db.staff.map(publicStaff),
        canManage: ['manager', 'desk'].filter(r => canManageRole(admin, r))
      });
    }
    if(path === '/api/admin/staff' && req.method === 'POST'){
      const username = String(body.username || '').trim().toLowerCase();
      const name = clean(body.name, 60);
      const role = String(body.role || '');
      if(!USERNAME_RE.test(username)) return fail(res, 400, 'Username: 3–32 characters, letters, numbers, dot, dash or underscore');
      if(RESERVED_USERS.has(username) || db.staff.some(x => x.username === username))
        return fail(res, 409, 'That username is taken');
      if(name.length < 2) return fail(res, 400, 'Enter the person\'s name');
      if(!['manager', 'desk'].includes(role)) return fail(res, 400, 'Role must be manager or desk');
      if(!canManageRole(admin, role)) return fail(res, 403, role === 'manager'
        ? 'Only the admin can create manager logins' : 'You cannot create that login');
      const problem = passwordProblem(body.password, username);
      if(problem) return fail(res, 400, problem);
      const acct = { username, name, role, hash: hash(String(body.password)), active: true, sessionVersion: 1,
                     createdAt: new Date().toISOString(), createdBy: admin.sub, updatedAt: null, lastLoginAt: null };
      db.staff.push(acct);
      flush.staff();
      audit(admin.sub, 'staff.create', username, { role, name });
      return ok(res, { staff: publicStaff(acct) });
    }
    if((path === '/api/admin/staff/active' || path === '/api/admin/staff/password') && req.method === 'POST'){
      const username = String(body.username || '').trim().toLowerCase();
      const acct = db.staff.find(x => x.username === username);
      if(!acct) return fail(res, 404, ENV_STAFF[username]
        ? 'That login is set in server/.env and can only be changed there' : 'No such staff login');
      if(!canManageRole(admin, acct.role)) return fail(res, 403, acct.role === 'manager'
        ? 'Only the admin can change manager logins' : 'You cannot change that login');
      if(acct.username === admin.username) return fail(res, 400, 'You cannot change your own login here');
      if(path.endsWith('/active')){
        if(typeof body.active !== 'boolean') return fail(res, 400, 'active must be true or false');
        acct.active = body.active;
        acct.sessionVersion = (acct.sessionVersion || 0) + 1;     /* signs out every session */
        acct.updatedAt = new Date().toISOString();
        flush.staff();
        audit(admin.sub, body.active ? 'staff.enable' : 'staff.disable', username, null);
      } else {
        const problem = passwordProblem(body.password, username);
        if(problem) return fail(res, 400, problem);
        acct.hash = hash(String(body.password));
        acct.sessionVersion = (acct.sessionVersion || 0) + 1;     /* signs out every session */
        acct.updatedAt = new Date().toISOString();
        flush.staff();
        audit(admin.sub, 'staff.password-reset', username, null);
      }
      return ok(res, { staff: publicStaff(acct) });
    }
    if(path === '/api/admin/audit'){
      const rows = [...db.audit].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 200);
      return ok(res, { rows });
    }

    /* ---------- card inventory ---------- */

    /* Mint a batch of blanks. Do this BEFORE sending artwork to the printer,
       then print exactly the serials it returns. */
    if(path === '/api/admin/cards/batch' && req.method === 'POST'){
      const count = Math.round(Number(body.count) || 0);
      if(count < 1 || count > 1000) return fail(res, 400, 'Mint between 1 and 1000 cards at a time');
      const made = mintCards(PROGRAM.brand.cardPrefix, count, admin.sub);
      return ok(res, { minted: made.length, from: made[0].serial,
                       to: made[made.length - 1].serial, serials: made.map(c => c.serial) });
    }

    if(path === '/api/admin/cards'){
      const status = url.searchParams.get('status') || 'all';
      let list = db.cards;
      if(status === 'unassigned') list = list.filter(c => !c.memberId && !c.void);
      if(status === 'assigned')   list = list.filter(c => c.memberId && !c.void);
      if(status === 'void')       list = list.filter(c => c.void);
      return ok(res, {
        counts: {
          total: db.cards.length,
          unassigned: db.cards.filter(c => !c.memberId && !c.void).length,
          assigned: db.cards.filter(c => c.memberId && !c.void).length,
          void: db.cards.filter(c => c.void).length
        },
        nextUnassigned: (nextFreeCard() || {}).serial || null,
        unassignedSerials: db.cards.filter(c => !c.memberId && !c.void).map(c => c.serial)
          .sort((a, b) => (serialNumber(a) || 0) - (serialNumber(b) || 0)).slice(0, 500),
        cards: [...list].sort((a, b) => (serialNumber(a.serial) || 0) - (serialNumber(b.serial) || 0))
          .slice(-400).reverse().map(c => {
          const m = c.memberId ? findById(c.memberId) : null;
          return { serial: c.serial, printed: c.printed, void: c.void,
                   assignedAt: c.assignedAt, member: m ? m.name : null,
                   memberId: c.memberId };
        })
      });
    }

    /* Replace a lost or damaged card. There is ONE card design, so tiering up
       never needs new plastic — this only runs when the physical card is gone.

       The account, points, tier and history all stay exactly where they are;
       only the serial changes. That is the whole reason card and member are
       separate records. */
    if(path === '/api/admin/cards/reissue' && req.method === 'POST'){
      const m = findById(body.memberId);
      if(!m) return fail(res, 404, 'No member found');
      if(!present(body.serial)) return fail(res, 400, 'Type the number of the NEW card');
      const serial = normSerial(body.serial);
      if(serial === m.memberNo) return fail(res, 400, 'That is the card they already have');
      const card = findCard(serial);
      if(!card) return fail(res, 404, `Card ${serial} is not in the system`);
      if(card.void) return fail(res, 400, 'That card was voided');
      if(card.memberId) return fail(res, 409, 'That card is already assigned');
      const old = cardForMember(m.id);
      if(old){ old.void = true; old.voidedAt = new Date().toISOString(); old.memberId = null; }
      card.memberId = m.id;
      card.assignedAt = new Date().toISOString();
      const wasNo = m.memberNo;
      m.memberNo = card.serial;
      flush.members(); flush.cards();
      const why = clean(body.reason, 40) || 'replaced';
      record(m.id, 'note', 0, `Card ${why}: ${wasNo} -> ${card.serial} (old card retired)`,
             { by: admin.sub, from: wasNo, to: card.serial });
      audit(admin.sub, 'member.card-replace', card.serial, { memberId: m.id, role: admin.role, from: wasNo, to: card.serial, reason: why });
      /* any open code was raised under the old card; cancel it and release
         its hold (a lost card may be in someone else's hands) */
      cancelCodes(m.id, { reason: `Card replaced (${wasNo} -> ${card.serial})`, by: admin.sub });
      return ok(res, { member: staffMember(m), serial: card.serial, voided: wasNo });
    }

    if(path === '/api/admin/cards/void' && req.method === 'POST'){
      const card = findCard(body.serial);
      if(!card) return fail(res, 404, 'Card not in the system');
      if(card.memberId) return fail(res, 400, 'That card is assigned — reissue the member onto a new card instead');
      card.void = !!body.void;
      card.voidedAt = card.void ? new Date().toISOString() : null;
      flush.cards();
      return ok(res, { serial: card.serial, void: card.void });
    }

    if(path === '/api/admin/lookup'){
      const q = url.searchParams.get('q');
      const m = findByAny(q);
      if(!m){
        const card = findCard(q);
        if(card && card.void) return json(res, 404, { error: `Card ${card.serial} was voided (lost or replaced)`,
                                                      card: { serial: card.serial, status: 'void' } });
        if(card) return json(res, 404, { error: `Card ${card.serial} is a valid blank card, but nobody is signed up on it yet — use New Member`,
                                         card: { serial: card.serial, status: 'unassigned' } });
        return fail(res, 404, 'No member or card found');
      }
      return ok(res, {
        member: staffMember(m),
        unclaimed: !m.pinHash
      });
    }

    /* EARN — staff rings in a visit: `amount` is the BAR / FOOD tab in dollars
       (earn.perDollar, rounded down) and `tableHours` is table time
       (earn.perTableHour). Either or both. Never type the table rental fee
       into amount — table time already earns per hour. Applies the tier
       boost (and any day multiplier / birthday / visit bonus, all off unless
       program.json sets them) and writes one ledger row per bonus so the
       member can see exactly where every point came from. */
    if(path === '/api/admin/earn' && req.method === 'POST'){
      const m = findById(body.memberId) || findByAny(body.ident);
      if(!m) return fail(res, 404, 'No member found');
      if(m.active === false) return fail(res, 400, 'That account is closed');

      const amount = present(body.amount) ? Number(body.amount) : 0;
      const tableHours = present(body.tableHours) ? Number(body.tableHours) : 0;
      const tip = present(body.tip) ? Number(body.tip) : 0;
      if(!Number.isFinite(amount) || amount < 0) return fail(res, 400, 'Bar tab must be a dollar amount');
      if(!Number.isFinite(tip) || tip < 0) return fail(res, 400, 'Tip must be a dollar amount');
      if(tip > 1000) return fail(res, 400, 'That tip looks wrong — check it');
      if(!Number.isFinite(tableHours) || tableHours < 0) return fail(res, 400, 'Table hours must be a number');
      if(amount <= 0 && tableHours <= 0 && tip <= 0) return fail(res, 400, 'Enter a bar tab, a tip or table hours');
      if(amount > 5000) return fail(res, 400, 'That amount looks wrong — check it');
      if(tableHours > 24) return fail(res, 400, 'More than 24 table hours looks wrong — check it');

      const now = new Date();
      const q = quoteEarn(PROGRAM, m, { amount, tableHours, tip, when: now });
      if(!(q.points > 0)){
        const per = Number(PROGRAM.earn.perDollar) || 0;
        return fail(res, 400, per > 0
          ? `Nothing to award — bar tabs earn 1 point per full $${+(1 / per).toFixed(2)}`
          : 'Nothing to award — bar tabs are not earning points right now (earn.perDollar is off)');
      }
      const rows = [];

      m.balance += q.points; m.lifetime += q.points;
      rows.push(record(m.id, 'earn', q.points,
        q.lines.map(l => l.label).join(' + '),
        { amount, barSpend: amount, tip: Math.round(tip * 100) / 100, tableHours, breakdown: q.lines,
          note: clean(body.note, 200) || null, by: admin.sub }));

      const bday = birthdayDue(PROGRAM, m, now);
      if(bday){
        m.balance += bday; m.lifetime += bday;
        m.birthdayBonusYear = now.getFullYear();
        rows.push(record(m.id, 'earn', bday, 'Birthday month bonus'));
      }
      const visit = visitBonusDue(PROGRAM, m, db.ledger, now);
      if(visit){
        m.balance += visit; m.lifetime += visit;
        m.visitBonusMonth = now.toISOString().slice(0, 7);
        rows.push(record(m.id, 'earn', visit,
          `${PROGRAM.earn.visitStreakCount}th visit this month`));
      }
      flush.members();
      return ok(res, { member: staffMember(m),
                       awarded: rows.reduce((a, r) => a + r.points, 0), rows });
    }

    /* REDEEM — staff-initiated, immediate. Only AVAILABLE points can be
       spent: points held by open codes are spoken for. */
    if(path === '/api/admin/redeem' && req.method === 'POST'){
      const m = findById(body.memberId) || findByAny(body.ident);
      if(!m) return fail(res, 404, 'No member found');
      if(m.active === false) return fail(res, 400, 'That account is closed');
      const r = rewardById(PROGRAM, body.rewardId);   /* table-time rewards only */
      if(!r) return fail(res, 400, 'Unknown reward — rewards are free table time only');
      if(availableFor(m) < r.cost) return fail(res, 400, `Not enough points — ${shortBy(m, r.cost)}`);
      m.balance -= r.cost;
      flush.members();
      record(m.id, 'redeem', -r.cost, r.name, { rewardId: r.id, by: admin.sub });
      return ok(res, { member: staffMember(m), reward: r });
    }

    /* Redeem a code — from the member app or printed by the POS. This is the
       moment points come off: the hold becomes the deduction (the code stops
       being pending in the same step, so the points are never taken twice). */
    if(path === '/api/admin/redeem/confirm' && req.method === 'POST'){
      const code = normCode(body.code);
      if(!code) return fail(res, 400, 'Type the code');
      const c = db.codes.find(x => x.code === code);
      if(!c) return fail(res, 404, 'That code is not valid — check the letters');
      const when = t => new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      if(c.status === 'redeemed') return fail(res, 409, `Code ${code} was already used ${when(c.confirmedAt)} (${c.confirmedBy})`);
      if(c.status === 'cancelled') return fail(res, 410, `Code ${code} was cancelled${c.cancelReason ? ': ' + c.cancelReason : ''}`);
      if(c.status === 'expired' || Date.parse(c.expiresAt) <= Date.now()){
        if(releaseCode(c, 'expired', { at: c.expiresAt })) flush.codes();
        return fail(res, 410, `Code ${code} expired ${when(c.expiresAt)} — ask them for a new one`);
      }
      const m = findById(c.memberId);
      const r = rewardById(PROGRAM, c.rewardId);     /* table-time rewards only */
      if(!m || !r || m.active === false){
        releaseCode(c, 'cancelled', { by: admin.sub,
          reason: !m || m.active === false ? 'Account closed' : 'Reward no longer offered' });
        flush.codes();
        return fail(res, 400, 'That code is no longer valid (account closed or reward withdrawn)');
      }
      const cost = Number(c.cost) || r.cost;        /* exactly what was held */
      /* can't normally happen (held points can't be spent elsewhere); kept as a guard */
      if(m.balance < cost) return fail(res, 400, `Balance has changed — ${m.name} has ${m.balance} points, ${r.name} needs ${cost}. Nothing was taken.`);
      m.balance -= cost;
      Object.assign(c, { status: 'redeemed', confirmedAt: new Date().toISOString(), confirmedBy: admin.sub, cost });
      flush.members(); flush.codes();
      record(m.id, 'redeem', -cost, `${r.name} (code ${code})`,
             { rewardId: r.id, viaCode: code, codeSource: c.source, heldPoints: cost, by: admin.sub });
      return ok(res, { member: staffMember(m), reward: r, code: publicCode(c) });
    }

    /* Open codes (all, or one member's), plus recently finished ones. */
    if(path === '/api/admin/codes' && req.method === 'GET'){
      sweepCodes();
      const mid = url.searchParams.get('memberId');
      const mine = mid ? db.codes.filter(c => c.memberId === mid) : db.codes;
      const sorted = [...mine].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return ok(res, { pending: sorted.filter(c => c.status === 'pending').map(publicCode),
                       recent: sorted.filter(c => c.status !== 'pending').slice(0, 50).map(publicCode) });
    }

    /* Staff issue a code at the desk (same rules as a register code: the
       points are held, max redeemCodes.maxOpenPosCodes open) — for a guest
       who wants a code for later. Any staff login. */
    if(path === '/api/admin/codes/issue' && req.method === 'POST'){
      const m = findById(body.memberId) || findByAny(body.ident);
      if(!m) return fail(res, 404, 'No member found');
      const c = issuePosCode(m, String(body.rewardId || ''), { by: admin.sub, context: { desk: true } });
      if(!c.ok) return fail(res, c.status, c.error);
      return ok(res, { ...c, memberView: staffMember(m) });
    }

    /* Cancel one pending code — MANAGER / ADMIN ONLY (see MANAGER_ONLY; the
       front desk gets a 403). Releases the hold; nothing was taken, so
       nothing is refunded. */
    if(path === '/api/admin/codes/cancel' && req.method === 'POST'){
      const code = normCode(body.code);
      const c = db.codes.find(x => x.code === code);
      if(!c) return fail(res, 404, 'No such code');
      if(c.status !== 'pending') return fail(res, 400, `That code is already ${c.status}`);
      const reason = clean(body.reason, 200) || 'Cancelled by a manager';
      releaseCode(c, 'cancelled', { by: admin.sub, reason });
      flush.codes();
      audit(admin.sub, 'code.cancel', c.code, { memberId: c.memberId, memberNo: c.memberNo, cost: c.cost, reason });
      const m = findById(c.memberId);
      return ok(res, { code: publicCode(c), member: m ? staffMember(m) : null });
    }

    /* Manual correction, either direction. Always requires a reason so the
       ledger stays auditable — this is the one route that can invent points. */
    if(path === '/api/admin/adjust' && req.method === 'POST'){
      const m = findById(body.memberId);
      if(!m) return fail(res, 404, 'No member found');
      const pts = Math.round(Number(body.points) || 0);
      const note = clean(body.note, 200);
      if(!Number.isFinite(Number(body.points))) return fail(res, 400, 'Points must be a whole number');
      if(Math.abs(pts) > 100000) return fail(res, 400, 'That adjustment looks wrong — check it');
      if(!pts) return fail(res, 400, 'Enter a non-zero number of points');
      if(note.length < 3) return fail(res, 400, 'A reason is required for a manual adjustment');
      if(m.balance + pts < 0) return fail(res, 400, 'That would take the balance below zero');
      const held = heldFor(m.id);
      if(m.balance + pts < held) return fail(res, 400,
        `${num(held)} points are held by open codes — the balance can't go below that. Cancel a code first.`);
      m.balance += pts;
      if(pts > 0) m.lifetime += pts;
      flush.members();
      record(m.id, 'adjust', pts, note, { by: admin.sub });
      audit(admin.sub, 'member.adjust', m.memberNo, { memberId: m.id, points: pts, reason: note });
      return ok(res, { member: staffMember(m) });
    }

    /* Re-issue a claim code — for someone who lost the slip, or never got
       round to setting up. Wipes any existing PIN so the new code is the
       only way in. */
    if(path === '/api/admin/claim' && req.method === 'POST'){
      const m = findById(body.memberId);
      if(!m) return fail(res, 404, 'No member found');
      m.claimCode = newClaimCode();
      m.claimExpires = Date.now() + CLAIM_TTL_HOURS * 3600e3;
      m.claimed = false;
      m.pinHash = null;
      flush.members();
      record(m.id, 'note', 0, 'New claim code issued', { by: admin.sub });
      return ok(res, { claimCode: m.claimCode, claimHours: CLAIM_TTL_HOURS });
    }

    if(path === '/api/admin/pin' && req.method === 'POST'){
      const m = findById(body.memberId);
      if(!m) return fail(res, 404, 'No member found');
      const pin = pinOk(body.pin) ? String(body.pin) : randomPin();
      m.pinHash = hash(pin);
      flush.members();
      record(m.id, 'note', 0, 'PIN reset by staff', { by: admin.sub });
      return ok(res, { pin });
    }

    if(path === '/api/admin/active' && req.method === 'POST'){
      const m = findById(body.memberId);
      if(!m) return fail(res, 404, 'No member found');
      if(typeof body.active !== 'boolean') return fail(res, 400, 'active must be true or false');
      if(m.active !== false && body.active) return fail(res, 400, 'That account is already open');
      if(m.active === false && !body.active) return fail(res, 400, 'That account is already closed');
      m.active = body.active;
      flush.members();
      /* closing cancels every open code, releasing its hold */
      if(!m.active) cancelCodes(m.id, { reason: 'Account closed', by: admin.sub });
      record(m.id, 'note', 0, m.active ? 'Account reopened' : 'Account closed',
             { by: admin.sub, reason: clean(body.reason, 200) || null });
      audit(admin.sub, m.active ? 'member.reopen' : 'member.close', m.memberNo,
            { memberId: m.id, reason: clean(body.reason, 200) || null });
      return ok(res, { member: staffMember(m) });
    }

    if(path === '/api/admin/ledger'){
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
      const rows = [...db.ledger].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit)
        .map(r => {
          const m = findById(r.memberId);
          return { ...r, memberNo: m ? m.memberNo : '?', name: m ? m.name : '(deleted)' };
        });
      return ok(res, { rows });
    }

    if(path === '/api/admin/export'){
      const head = 'member_no,name,email,phone,birthday,balance,held,lifetime,tier,tier_override,tier_override_until,joined,active';
      /* quote every cell and neutralise spreadsheet formulas (=, +, -, @) */
      const esc = s => { let v = String(s == null ? '' : s); if(/^[=+\-@\t\r]/.test(v)) v = "'" + v;
                         return `"${v.replace(/"/g, '""')}"`; };
      const lines = db.members.map(m => [m.memberNo, m.name, m.email, m.phone, m.birthday,
        m.balance, heldFor(m.id), m.lifetime, memberTier(PROGRAM, m).name,
        m.tierOverride && !overrideExpired(m.tierOverride) ? m.tierOverride.key : '',
        m.tierOverride && !overrideExpired(m.tierOverride) ? String(m.tierOverride.expiresAt || '').slice(0, 10) : '', m.joined,
        m.active !== false].map(esc).join(','));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="preferred-player-members.csv"' });
      return res.end([head, ...lines].join('\n'));
    }

    if(path === '/api/admin/pos/logs' && req.method === 'GET'){
      const logs = [...(db.posLog || [])].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 100);
      return ok(res, { logs });
    }

    if(path === '/api/admin/pos/clear' && req.method === 'POST'){
      db.posLog = [];
      flush.posLog();
      return ok(res, { ok: true, message: 'POS logs cleared' });
    }

    /* POS Hub test buttons: run the same code a real terminal would. The
       Toast simulator uses the same subtotal rule as the webhook. */
    if(path === '/api/admin/pos/simulate' && req.method === 'POST'){
      const source = String(body.source || 'toast').toLowerCase();
      const ident = body.ident || body.memberNo || body.serial || body.phone;
      const m = findByAny(ident);
      if(!m) return fail(res, 404, `No member found matching "${clean(ident, 60)}"`);
      if(m.active === false) return fail(res, 400, 'Account is inactive');

      if(source === 'toast'){
        const checkId = clean(body.checkId, 64) || ('SIM-' + randomBytes(3).toString('hex').toUpperCase());
        if(db.posLog.some(p => p.source === 'toast' && p.checkId === checkId && p.status !== 'rejected'))
          return fail(res, 409, `Check ${checkId} was already processed — use a new check number`);
        const sub = toastSubtotal(body);
        if(sub.error) return fail(res, 400, sub.error);
        const tip = toastTip(body);
        if(tip.error) return fail(res, 400, tip.error);
        return ok(res, awardToast(m, { checkId, subtotal: sub.value, subtotalField: sub.field,
          tip: tip.value, tipField: tip.field, serviceCharge: toastServiceCharge(body),
          items: Array.isArray(body.items) ? body.items.slice(0, 200) : [],
          serverName: clean(body.serverName, 60) || 'Simulated Bartender' }));
      }
      if(source === 'cuet'){
        const sessionId = clean(body.sessionId, 64) || ('SIM-' + randomBytes(3).toString('hex').toUpperCase());
        if(db.posLog.some(p => p.source === 'cuet' && p.sessionId === sessionId))
          return fail(res, 409, `Session ${sessionId} was already processed`);
        const f = cuetFields(body, { tableHours: 2 });
        if(f.error) return fail(res, 400, f.error);
        return ok(res, awardCuet(m, { sessionId, tableNo: clean(body.tableNo, 10) || '3',
          tableHours: f.tableHours, rate: f.rate, cashier: clean(body.cashier, 60) || 'Simulated Counter' }));
      }
      return fail(res, 400, 'source must be toast or cuet');
    }

    return fail(res, 404, 'Unknown admin route');
  }

  if(path.startsWith('/api/')) return fail(res, 404, 'Unknown route');

  /* ---------- static ----------
     Only public pages, images and the card PDFs at the top level of this
     folder are served. server/ (the .env, the database, the session secret),
     docs, scripts and dotfiles are never reachable over HTTP. */
  if(req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
  let rel = decodeURIComponent(path);
  /* short link for Linktree / QR codes: /rewards opens the member portal */
  if(rel === '/rewards' || rel === '/rewards/'){ res.writeHead(302, { Location: '/#rewards' }); return res.end(); }
  if(rel === '/') rel = '/breaker_billiards_app.html';
  const name = rel.replace(/^\/+/, '');
  if(!name || /[\/\\]/.test(name) || name.startsWith('.') || !PUBLIC_EXT.has(extname(name).toLowerCase()))
    return fail(res, 404, 'Not found');
  const target = join(ROOT, name);
  if(!existsSync(target) || !statSync(target).isFile()) return fail(res, 404, 'Not found');
  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache',
                       'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  return res.end(req.method === 'HEAD' ? undefined : readFileSync(target));
}

/* ---------- boot ---------- */
const server = createServer(async (req, res) => {
  cors(req, res);
  if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    await route(req, res, url);
  } catch(e){
    console.error(`${req.method} ${url.pathname} ->`, e.message);
    if(!res.headersSent) fail(res, 400, e.message || 'Request failed');
  }
});
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE'
    ? `\n  Port ${PORT} is already in use — is the server already running? (Change PORT in server/.env to use another.)\n`
    : e.message);
  process.exit(1);
});
/* Every write is already on disk (synchronous + fsync), so stopping is safe. */
for(const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });

server.listen(PORT, HOST, () => {
  const shown = (HOST === '0.0.0.0' || HOST === '::') ? 'localhost' : HOST;
  const base = `http://${shown}:${server.address().port}`;
  console.log(`\n  BREAKER BILLIARDS — Preferred Player Card`);
  console.log(`  ------------------------------------------`);
  console.log(`  Customer page  ${base}/rewards`);
  console.log(`  Staff / admin  ${base}/admin.html`);
  console.log(`  Card studio    ${base}/card.html`);
  console.log(`  Data folder    ${DATA}`);
  console.log(`  Members ${db.members.length} · Cards ${db.cards.length}`);
  console.log(HOST === '127.0.0.1' ? '  Only this computer can connect (set HOST=0.0.0.0 to share on your network).'
                                   : `  Listening on ${HOST}:${PORT}`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
