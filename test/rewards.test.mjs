/* Automated checks for the rewards server.
   Run with:  npm test
   Each run uses a throwaway settings file and data folder in the system temp
   directory, starts the REAL server as a separate process, and deletes
   everything afterwards. Your real server/.env and server/data are never touched. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { hash } from '../server/auth.js';
import { quoteEarn, quoteCueTEarn, rewardById, validateProgram } from '../server/points.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'bb-rewards-test-'));
const PASS = randomBytes(12).toString('base64url');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const POS_KEY = randomBytes(16).toString('hex');
const PROGRAM = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'program.json'), 'utf8'));
const BASE = `http://127.0.0.1:${PORT}`;

const CLEAN = { ...process.env };
for(const k of Object.keys(CLEAN))
  if(/^(ADMIN_|MANAGER_|BAR_|DESK_|PORT$|HOST$|DATA_DIR$|SESSION_SECRET$|POS_WEBHOOK_KEY$|ALLOW_ORIGIN$|ENV_FILE$)/.test(k)) delete CLEAN[k];

writeFileSync(join(TMP, 'test.env'), [
  'ADMIN_USER=admin', `ADMIN_PASS_HASH=${hash(PASS)}`, `PORT=${PORT}`, 'HOST=127.0.0.1',
  `DATA_DIR=${join(TMP, 'data')}`, `SESSION_SECRET=${randomBytes(32).toString('hex')}`,
  `POS_WEBHOOK_KEY=${POS_KEY}`
].join('\n'));
const ENV = { ...CLEAN, ENV_FILE: join(TMP, 'test.env') };

let proc = null;
async function startServer(){
  proc = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', d => log += d); proc.stderr.on('data', d => log += d);
  for(let i = 0; i < 100; i++){
    try { if((await fetch(BASE + '/api/health')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + log);
}
async function stopServer(){
  if(!proc) return;
  const p = proc; proc = null;
  await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); });
}
async function call(method, path, body, token, headers = {}){
  const r = await fetch(BASE + path, { method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, headers: r.headers };
}

before(startServer);
after(async () => { await stopServer(); rmSync(TMP, { recursive: true, force: true }); });

let token, memberId;

test('admin login rejects a wrong password (and unknown users)', async () => {
  const bad = await call('POST', '/api/admin/login', { user: 'admin', pass: 'wrong-password' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.token, undefined);
  const nobody = await call('POST', '/api/admin/login', { user: 'manager', pass: PASS });
  assert.equal(nobody.status, 401, 'manager login is off unless MANAGER_PASS is set');
  const old = await call('POST', '/api/admin/login', { user: 'admin', pass: 'demo-pass' });
  assert.equal(old.status, 401, 'the old demo backdoor is gone');
});

test('admin login accepts the password from .env', async () => {
  const r = await call('POST', '/api/admin/login', { user: 'admin', pass: PASS });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  token = r.body.token;
  assert.equal((await call('GET', '/api/admin/stats')).status, 401, 'admin API needs a token');
  assert.equal((await call('GET', '/api/admin/stats', null, token)).status, 200);
});

test('card lookup: BB0001 and BB0050 exist, typed any way (as printed: 0001 / 0050)', async () => {
  for(const [typed, id] of [['BB0001', 'BB0001'], ['0001', 'BB0001'], ['bb-0001', 'BB0001'], ['BB-00001', 'BB0001'],
                            ['BB0050', 'BB0050'], ['0050', 'BB0050'], ['50', 'BB0050']]){
    const r = await call('GET', '/api/card/' + encodeURIComponent(typed));
    assert.equal(r.status, 200, `card ${typed}`);
    assert.equal(r.body.serial, id);
    assert.equal(r.body.status, 'unassigned');
  }
  const blank = await call('GET', '/api/admin/lookup?q=0050', null, token);
  assert.equal(blank.status, 404);
  assert.equal(blank.body.card.serial, 'BB0050');
  assert.match(blank.body.error, /valid blank card/);
});

test('unknown card numbers are rejected', async () => {
  for(const typed of ['BB0051', 'BB9999', '0000', 'hello', 'BB00A1']){
    assert.equal((await call('GET', '/api/card/' + encodeURIComponent(typed))).status, 404, `card ${typed}`);
    assert.equal((await call('GET', '/api/admin/lookup?q=' + encodeURIComponent(typed), null, token)).status, 404);
  }
});

test('sign up a member on card 0001 and find them by the printed number', async () => {
  const r = await call('POST', '/api/admin/members',
    { name: 'Test Player', email: 'test@example.com', birthday: '1990-01-15', serial: '0001', pin: '4321' }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.serial, 'BB0001');
  memberId = r.body.member.id;
  const found = await call('GET', '/api/admin/lookup?q=0001', null, token);
  assert.equal(found.status, 200);
  assert.equal(found.body.member.memberNo, 'BB0001');
  assert.equal((await call('GET', '/api/card/BB0001')).body.status, 'active');
});

test('adding points: 5 per table hour; nothing to award is refused', async () => {
  for(let i = 0; i < 3; i++){
    const r = await call('POST', '/api/admin/earn', { memberId, tableHours: 20 }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.awarded, 100);
  }
  const tooLong = await call('POST', '/api/admin/earn', { memberId, tableHours: 25 }, token);
  assert.equal(tooLong.status, 400, 'more than 24 table hours in one go is refused');
  const junk = await call('POST', '/api/admin/earn', { memberId, amount: 'lots' }, token);
  assert.equal(junk.status, 400);
  const nothing = await call('POST', '/api/admin/earn', { memberId, amount: 0, tableHours: 0 }, token);
  assert.equal(nothing.status, 400);
  const under5 = await call('POST', '/api/admin/earn', { memberId, amount: 4.99 }, token);
  assert.equal(under5.status, 400, 'a bar tab under $5 is worth 0 points');
  assert.match(under5.body.error, /Nothing to award/);
  const huge = await call('POST', '/api/admin/earn', { memberId, amount: 5001 }, token);
  assert.equal(huge.status, 400, 'the $5000 sanity check still applies');
  const after = await call('GET', '/api/admin/lookup?q=BB0001', null, token);
  assert.equal(after.body.member.balance, 300, 'balance is still a number, not null');
});

test('redeeming: takes the points, refuses when there are not enough', async () => {
  const r = await call('POST', '/api/admin/redeem', { memberId, rewardId: 'table1' }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.member.balance, 50);
  assert.equal(r.body.member.lifetime, 300, 'redeeming never lowers lifetime points / tier');
  const tooMuch = await call('POST', '/api/admin/redeem', { memberId, rewardId: 'table2' }, token);
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /Not enough points/);
});

test('points persist across a server restart', async () => {
  await stopServer();
  await startServer();
  const r = await call('GET', '/api/admin/lookup?q=0001', null, token);
  assert.equal(r.status, 200, 'staff session survives the restart');
  assert.equal(r.body.member.balance, 50);
  assert.equal(r.body.member.lifetime, 300);
  assert.ok(r.body.member.history.some(h => h.type === 'redeem'));
  const me = await call('POST', '/api/member/login', { ident: '0001', pin: '4321' });
  assert.equal(me.status, 200);
  assert.equal(me.body.member.balance, 50);
});

/* ---------- Sept 2026 rules: bar tabs earn, no double dipping, table-time-only rewards ---------- */
let bar, black;
async function signUp(serial, email){
  const r = await call('POST', '/api/admin/members',
    { name: 'Player ' + serial, email, birthday: '1985-06-20', serial, pin: '2468' }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.member.id;
}
const pos = (path, body) => call('POST', path, body, null, { 'X-POS-Key': POS_KEY });

test('program.json: bar rate is earn.perDollar 0.2 and every reward is table time', async () => {
  assert.equal(PROGRAM.earn.perDollar, 0.2);
  assert.equal(PROGRAM.earn.perTableHour, 5);
  for(const k of ['multiplier', 'multiplierDays', 'birthdayBonus', 'visitStreakCount', 'visitStreakBonus'])
    assert.equal(PROGRAM.earn[k], undefined, `${k} stays off`);
  assert.deepEqual(validateProgram(PROGRAM), []);
  const r = await call('GET', '/api/program');
  assert.equal(r.status, 200);
  assert.ok(r.body.rewards.length > 0);
  assert.ok(r.body.rewards.every(x => x.type === 'table'));
});

test('bar tab earns 1 point per $5, rounded down ($27 -> 5); table + bar combine', async () => {
  bar = await signUp('0002', 'bar@example.com');
  const r = await call('POST', '/api/admin/earn', { memberId: bar, amount: 27 }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.awarded, 5);
  assert.equal(r.body.member.balance, 5);
  const both = await call('POST', '/api/admin/earn', { memberId: bar, amount: 27.5, tableHours: 2 }, token);
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.equal(both.body.awarded, 15, '2h x 5 = 10, plus floor(27.50 x 0.2) = 5');
  assert.equal(both.body.member.balance, 20);
  assert.equal(both.body.member.tableTracker.totalHours, 2);
});

test('Black tier 1.5x applies to bar tab points too', async () => {
  black = await signUp('0003', 'black@example.com');
  const adj = await call('POST', '/api/admin/adjust', { memberId: black, points: 5000, note: 'test: reach Black' }, token);
  assert.equal(adj.status, 200, JSON.stringify(adj.body));
  assert.equal(adj.body.member.tier.name, 'Black');
  const r = await call('POST', '/api/admin/earn', { memberId: black, amount: 20 }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.awarded, 6, 'floor(20 x 0.2) = 4, x1.5 = 6');
  const both = await call('POST', '/api/admin/earn', { memberId: black, amount: 20, tableHours: 1 }, token);
  assert.equal(both.body.awarded, 14, '(5 + 4) x 1.5 = 13.5, rounded = 14');
});

test('CueT table session earns per hour only, never dollar points on the rental', async () => {
  const r = await pos('/api/pos/cuet/session-closed', { sessionId: 'S-1', memberIdent: '0002', tableHours: 2, rate: 15 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.awarded, 10, '2h x 5 = 10; the $30 rental earns nothing extra');
  assert.equal(r.body.netAmount, 30, 'rental amount is still reported');
  const again = await pos('/api/pos/cuet/session-closed', { sessionId: 'S-1', memberIdent: '0002', tableHours: 2, rate: 15 });
  assert.equal(again.body.duplicate, true);
  const blk = await pos('/api/pos/cuet/session-closed', { sessionId: 'S-2', memberIdent: '0003', tableHours: 2, rate: 15 });
  assert.equal(blk.body.discountPct, 20, 'Black still sees its table discount');
  assert.equal(blk.body.netAmount, 24);
  assert.equal(blk.body.awarded, 15, '10 x 1.5, no dollar points');
  const sim = await call('POST', '/api/admin/pos/simulate', { source: 'cuet', ident: '0002', tableHours: 3, rate: 20 }, token);
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.equal(sim.body.awarded, 15, 'simulated CueT session: 3h x 5, no dollar points');
  const me = await call('GET', '/api/admin/lookup?q=0002', null, token);
  assert.equal(me.body.member.balance, 20 + 10 + 15);
});

test('Toast webhook awards floor($ x 0.2) and is idempotent by checkId', async () => {
  const r = await pos('/api/pos/toast/order-closed', { checkId: 'CHK-9001', memberIdent: '0002', subtotal: 45.75, total: 58.90 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.awarded, 9);
  assert.equal(r.body.member.balance, 45 + 9);
  const dup = await pos('/api/pos/toast/order-closed', { checkId: 'CHK-9001', memberIdent: '0002', subtotal: 45.75 });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  const blk = await pos('/api/pos/toast/order-closed', { checkId: 'CHK-9002', memberIdent: '0003', subtotal: 50 });
  assert.equal(blk.body.awarded, 15, 'Black: 10 x 1.5');
  const me = await call('GET', '/api/admin/lookup?q=0002', null, token);
  assert.equal(me.body.member.balance, 54, 'the duplicate check added nothing');
  const noKey = await call('POST', '/api/pos/toast/order-closed', { checkId: 'CHK-9003', memberIdent: '0002', subtotal: 45 });
  assert.equal(noKey.status, 401);
});

test('only table-time rewards can be redeemed', async () => {
  const staff = await call('POST', '/api/admin/redeem', { memberId: black, rewardId: 'drink1' }, token);
  assert.equal(staff.status, 400);
  assert.match(staff.body.error, /table time only/);
  const login = await call('POST', '/api/member/login', { ident: '0003', pin: '2468' });
  assert.equal(login.status, 200);
  const voucher = await call('POST', '/api/member/redeem', { rewardId: 'food1' }, login.body.token);
  assert.equal(voucher.status, 400);
  const good = await call('POST', '/api/member/redeem', { rewardId: 'table1' }, login.body.token);
  assert.equal(good.status, 200, JSON.stringify(good.body));
  const conf = await call('POST', '/api/admin/redeem/confirm', { code: good.body.code }, token);
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.equal(conf.body.reward.type, 'table');
  /* the code-level guard, independent of what program.json currently lists */
  const fake = { ...PROGRAM, rewards: [...PROGRAM.rewards,
    { id: 'drink1', type: 'bar', cost: 100, name: 'Free drink' }, { id: 'nachos', cost: 100, name: 'Nachos' }] };
  assert.equal(rewardById(fake, 'drink1'), null);
  assert.equal(rewardById(fake, 'nachos'), null, 'a reward with no type is not table time');
  assert.equal(rewardById(fake, 'table1').id, 'table1');
  const problems = validateProgram(fake);
  assert.equal(problems.length, 2, problems.join('; '));
  assert.match(problems[0], /drink1/);
});

test('points maths: CueT quotes never pass rental dollars into the bar rate', () => {
  const m = { lifetime: 0 };
  const q = quoteCueTEarn(PROGRAM, m, { tableHours: 4, rate: 25 });
  assert.equal(q.points, 20);
  assert.equal(q.netAmount, 100);
  assert.equal(q.lines.length, 1);
  assert.equal(quoteEarn(PROGRAM, m, { amount: 24.99 }).points, 4);
  assert.equal(quoteEarn(PROGRAM, m, { amount: 25 }).points, 5);
  assert.equal(quoteEarn({ ...PROGRAM, earn: { ...PROGRAM.earn, perDollar: 0.7 } }, m, { amount: 90 }).points, 63);
});

test('Toast: points come from the pre-tax, pre-tip subtotal; a total-only check is refused', async () => {
  const before = (await call('GET', '/api/admin/lookup?q=0002', null, token)).body.member.balance;
  const totalOnly = await pos('/api/pos/toast/order-closed', { checkId: 'CHK-7001', memberIdent: '0002', amount: 50 });
  assert.equal(totalOnly.status, 422);
  assert.match(totalOnly.body.error, /subtotal/);
  for(const [id, body] of [['CHK-7011', { total: 61.5 }], ['CHK-7012', { spend: 30, tip: 6 }], ['CHK-7013', { amount: 40, gratuity: 7 }]]){
    const r = await pos('/api/pos/toast/order-closed', { checkId: id, memberIdent: '0002', ...body });
    assert.equal(r.status, 422, `total-only check ${id} is refused even with a tip`);
    assert.match(r.body.error, /subtotal/);
  }
  assert.equal((await call('GET', '/api/admin/lookup?q=0002', null, token)).body.member.balance, before, 'refused checks award nothing');
  const logs = await call('GET', '/api/admin/pos/logs', null, token);
  assert.ok(logs.body.logs.some(l => l.checkId === 'CHK-7001' && l.status === 'rejected' && l.points === 0),
    'the refusal is visible in the POS log');
  const fixed = await pos('/api/pos/toast/order-closed', { checkId: 'CHK-7001', memberIdent: '0002', subtotal: 40, total: 52.4 });
  assert.equal(fixed.status, 200, 'a corrected resend of a refused check is still paid');
  assert.equal(fixed.body.awarded, 8);
  const net = await pos('/api/pos/toast/order-closed', { checkId: 'CHK-7002', memberIdent: '0002', netAmount: 25 });
  assert.equal(net.body.awarded, 5, 'netAmount is accepted as the subtotal');
  assert.equal((await pos('/api/pos/toast/order-closed', { memberIdent: '0002', subtotal: 25 })).status, 400, 'checkId is required');
  assert.equal((await pos('/api/pos/toast/order-closed', { checkId: 'CHK-7003', memberIdent: '0002', subtotal: -5 })).status, 422);
  const after = (await call('GET', '/api/admin/lookup?q=0002', null, token)).body.member;
  assert.equal(after.balance, before + 13);
  const hist = after.history.find(h => h.label === 'Toast Bar Tab #CHK-7001');
  assert.equal(hist.detail.subtotalField, 'subtotal');
  assert.equal(hist.detail.spend, 40);
});

test('lifetime spend counts Front Desk bar tabs, Toast checks and CueT table rentals', async () => {
  const m = (await call('GET', '/api/admin/lookup?q=0002', null, token)).body.member;
  /* Front Desk $27 + $27.50, Toast $45.75 + $40 + $25; CueT net $30 + $60 */
  assert.equal(m.lifetimeBarSpend, 165.25);
  assert.equal(m.lifetimeTableSpend, 90);
  assert.equal(m.lifetimeSpend, 255.25);
});

/* ---------- staff logins, roles and the admin portal ---------- */
let mgrToken, deskToken, desk2Token;
const login = (user, pass) => call('POST', '/api/admin/login', { user, pass });

test('staff logins: admin creates manager + desk, stored as scrypt hashes, validated', async () => {
  const mk = (body, t = token) => call('POST', '/api/admin/staff', body, t);
  assert.equal((await mk({ username: 'mgr1', name: 'Manager Mo', role: 'manager', password: 'manager-pass-123' })).status, 200);
  assert.equal((await mk({ username: 'desk1', name: 'Desk Dee', role: 'desk', password: 'desk-pass-12345' })).status, 200);
  assert.equal((await mk({ username: 'desk9', name: 'Weak', role: 'desk', password: 'short' })).status, 400);
  assert.equal((await mk({ username: 'manager', name: 'Taken', role: 'desk', password: 'long-enough-pass' })).status, 409, 'reserved .env username');
  assert.equal((await mk({ username: 'desk1', name: 'Again', role: 'desk', password: 'long-enough-pass' })).status, 409);
  assert.equal((await mk({ username: 'boss', name: 'Boss', role: 'admin', password: 'long-enough-pass' })).status, 400, 'no new admins');
  assert.equal((await mk({ username: 'x', name: 'Bad Name', role: 'desk', password: 'long-enough-pass' })).status, 400);
  const raw = readFileSync(join(TMP, 'data', 'staff.json'), 'utf8');
  assert.ok(!raw.includes('manager-pass-123') && !raw.includes('desk-pass-12345'), 'no plaintext passwords on disk');
  for(const a of JSON.parse(raw)) assert.match(a.hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  mgrToken = (await login('mgr1', 'manager-pass-123')).body.token;
  deskToken = (await login('desk1', 'desk-pass-12345')).body.token;
  assert.ok(mgrToken && deskToken);
  const me = await call('GET', '/api/admin/me', null, deskToken);
  assert.equal(me.body.role, 'desk');
  assert.equal(me.body.isManager, false);
});

test('staff passwords must be at least 10 characters (create and reset)', async () => {
  const nine = await call('POST', '/api/admin/staff', { username: 'desk10', name: 'Nine Chars', role: 'desk', password: 'abcdefgh9' }, token);
  assert.equal(nine.status, 400);
  assert.match(nine.body.error, /at least 10 characters/);
  const ten = await call('POST', '/api/admin/staff', { username: 'desk10', name: 'Ten Chars', role: 'desk', password: 'abcdefgh10' }, token);
  assert.equal(ten.status, 200, 'exactly 10 characters is accepted');
  const reset = await call('POST', '/api/admin/staff/password', { username: 'desk10', password: '123456789' }, token);
  assert.equal(reset.status, 400, 'a 9-character reset is refused');
  assert.match(reset.body.error, /at least 10 characters/);
  assert.equal((await call('POST', '/api/admin/staff/password', { username: 'desk10', password: 'ten-chars!' }, token)).status, 200);
  assert.equal((await call('POST', '/api/admin/staff/active', { username: 'desk10', active: false }, token)).status, 200);
});

test('the old bar login is folded into Front Desk: BAR_PASS signs in with the desk role', async () => {
  const port = PORT + 7, dir = join(TMP, 'data-bar');
  const barPass = randomBytes(9).toString('base64url'), deskPass = randomBytes(9).toString('base64url');
  writeFileSync(join(TMP, 'bar.env'), [`ADMIN_PASS_HASH=${hash(PASS)}`, `BAR_PASS=${barPass}`, `DESK_PASS=${deskPass}`,
    `PORT=${port}`, 'HOST=127.0.0.1', `DATA_DIR=${dir}`, `SESSION_SECRET=${randomBytes(32).toString('hex')}`].join('\n'));
  const p = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...CLEAN, ENV_FILE: join(TMP, 'bar.env') }, stdio: 'ignore' });
  try {
    const b = `http://127.0.0.1:${port}`;
    for(let i = 0; i < 100; i++){ try { if((await fetch(b + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const post = async (path, body, tok) => { const r = await fetch(b + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() }; };
    for(const user of ['bar', 'barmanager', 'frontdesk', 'desk']){
      const l = await post('/api/admin/login', { user, pass: user.includes('bar') ? barPass : deskPass });
      assert.equal(l.status, 200, user);
      assert.equal(l.body.role, 'desk', `${user} is a desk login`);
      assert.equal(l.body.roleLabel, 'Front Desk');
      assert.equal((await post('/api/admin/adjust', { memberId: 'x', points: 1, note: 'nope' }, l.body.token)).status, 403,
        `${user} cannot do manager work`);
      assert.equal((await post('/api/admin/codes/cancel', { code: 'ABCDEF' }, l.body.token)).status, 403);
    }
    const me = await (await fetch(b + '/api/admin/me', { headers: { Authorization: 'Bearer ' +
      (await post('/api/admin/login', { user: 'bar', pass: barPass })).body.token } })).json();
    assert.equal(me.role, 'desk'); assert.equal(me.isManager, false);
  } finally {
    await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); });
  }
});

test('roles: managers manage desk logins only; front desk manages nobody', async () => {
  assert.equal((await call('POST', '/api/admin/staff', { username: 'desk2', name: 'Desk Two', role: 'desk', password: 'desk-two-pass-1' }, mgrToken)).status, 200);
  assert.equal((await call('POST', '/api/admin/staff', { username: 'mgr2', name: 'Mgr Two', role: 'manager', password: 'mgr-two-pass-12' }, mgrToken)).status, 403);
  assert.equal((await call('POST', '/api/admin/staff/password', { username: 'mgr1', password: 'another-pass-123' }, mgrToken)).status, 403,
    'a manager cannot reset a manager login');
  assert.equal((await call('POST', '/api/admin/staff/active', { username: 'admin', active: false }, mgrToken)).status, 404,
    '.env logins cannot be changed from the portal');
  assert.equal((await call('GET', '/api/admin/staff', null, deskToken)).status, 403);
  assert.equal((await call('POST', '/api/admin/staff', { username: 'desk3', name: 'Desk 3', role: 'desk', password: 'desk-three-pass' }, deskToken)).status, 403);
  desk2Token = (await login('desk2', 'desk-two-pass-1')).body.token;
  assert.ok(desk2Token);
});

test('front desk is refused every manager action but can do desk work', async () => {
  const m = (await call('GET', '/api/admin/lookup?q=0002', null, deskToken)).body.member;
  for(const [path, body] of [
    ['/api/admin/adjust', { memberId: m.id, points: 10, note: 'nope' }],
    ['/api/admin/cards/batch', { count: 1 }],
    ['/api/admin/cards/void', { serial: 'BB0049', void: true }],
    ['/api/admin/active', { memberId: m.id, active: false }],
    ['/api/admin/members/tier', { memberId: m.id, tier: 'gold', reason: 'nope' }],
    ['/api/admin/pos/clear', {}]]){
    assert.equal((await call('POST', path, body, deskToken)).status, 403, path);
  }
  assert.equal((await call('GET', '/api/admin/export', null, deskToken)).status, 403);
  assert.equal((await call('GET', '/api/admin/audit', null, deskToken)).status, 403);
  const withTier = await call('POST', '/api/admin/members',
    { name: 'Tier Sneak', email: 'sneak@example.com', tierOverride: 'black' }, deskToken);
  assert.equal(withTier.status, 403, 'front desk cannot set a tier at signup');
  const earn = await call('POST', '/api/admin/earn', { memberId: m.id, tableHours: 1 }, deskToken);
  assert.equal(earn.status, 200);
  assert.equal(earn.body.awarded, 5);
  assert.equal(earn.body.rows[0].detail.by, 'Desk Dee (desk1)', 'the ledger records which login did it');
});

test('switching a staff login off, or resetting its password, signs it out at once', async () => {
  assert.equal((await call('GET', '/api/admin/me', null, desk2Token)).status, 200);
  assert.equal((await call('POST', '/api/admin/staff/active', { username: 'desk2', active: false }, mgrToken)).status, 200);
  assert.equal((await call('GET', '/api/admin/me', null, desk2Token)).status, 401, 'old session is dead');
  assert.equal((await login('desk2', 'desk-two-pass-1')).status, 403, 'switched-off login cannot sign in');
  assert.equal((await call('POST', '/api/admin/staff/active', { username: 'desk2', active: true }, mgrToken)).status, 200);
  assert.equal((await login('desk2', 'desk-two-pass-1')).status, 200);

  assert.equal((await call('POST', '/api/admin/staff/password', { username: 'desk1', password: 'short' }, mgrToken)).status, 400);
  assert.equal((await call('POST', '/api/admin/staff/password', { username: 'desk1', password: 'desk-new-pass-99' }, mgrToken)).status, 200);
  assert.equal((await call('GET', '/api/admin/me', null, deskToken)).status, 401, 'reset kills the old session');
  assert.equal((await login('desk1', 'desk-pass-12345')).status, 401, 'old password no longer works');
  deskToken = (await login('desk1', 'desk-new-pass-99')).body.token;
  assert.ok(deskToken);
  assert.equal((await call('POST', '/api/admin/staff/password', { username: 'mgr1', password: 'manager-pass-456' }, token)).status, 200,
    'admin can reset a manager');
  assert.equal((await call('GET', '/api/admin/me', null, mgrToken)).status, 401);
  mgrToken = (await login('mgr1', 'manager-pass-456')).body.token;
  const audit = await call('GET', '/api/admin/audit', null, mgrToken);
  const acts = audit.body.rows.map(r => `${r.action}:${r.target}`);
  for(const a of ['staff.create:mgr1', 'staff.create:desk2', 'staff.disable:desk2', 'staff.enable:desk2',
                  'staff.password-reset:desk1', 'staff.password-reset:mgr1'])
    assert.ok(acts.includes(a), a);
  assert.equal(audit.body.rows.find(r => r.action === 'staff.disable').by, 'Manager Mo (mgr1)');
});

let phoneOnly, emailOnly;
test('signup: phone only or email only, next free card by default, duplicates refused', async () => {
  const cards = await call('GET', '/api/admin/cards?status=unassigned', null, deskToken);
  assert.equal(cards.body.nextUnassigned, 'BB0004');
  const a = await call('POST', '/api/admin/members', { name: 'Pat Phoneonly', phone: '(973) 555-0101', pin: '1111' }, deskToken);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.serial, 'BB0004', 'defaults to the next blank card');
  assert.equal(a.body.member.email, '');
  phoneOnly = a.body.member;
  const b = await call('POST', '/api/admin/members', { name: 'Emma Emailonly', email: 'Emma.Only@Example.com', pin: '2222' }, deskToken);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.serial, 'BB0005');
  assert.equal(b.body.member.email, 'emma.only@example.com');
  assert.equal(b.body.member.birthday, '', 'birthday is optional');
  emailOnly = b.body.member;
  const pick = await call('POST', '/api/admin/members', { name: 'Card Picker', email: 'picker@example.com', serial: '0010' }, deskToken);
  assert.equal(pick.body.serial, 'BB0010', 'staff may pick another blank card');
  assert.equal((await call('POST', '/api/admin/members', { name: 'Card Taken', email: 'taken@example.com', serial: '0010' }, deskToken)).status, 409);
  assert.equal((await call('POST', '/api/admin/members', { name: 'No Contact' }, deskToken)).status, 400);
  const dupP = await call('POST', '/api/admin/members', { name: 'Dup Phone', phone: '+1 973.555.0101' }, deskToken);
  assert.equal(dupP.status, 409, 'same phone written differently is still a duplicate');
  assert.equal((await call('POST', '/api/admin/members', { name: 'Dup Email', email: 'EMMA.ONLY@example.com' }, deskToken)).status, 409);
  assert.equal((await call('POST', '/api/admin/members', { name: 'Bad Date', email: 'd@example.com', birthday: '2001-02-30' }, deskToken)).status, 400);
  assert.equal((await call('POST', '/api/admin/members', { name: 'Bad Mail', email: 'not-an-email' }, deskToken)).status, 400);
  assert.equal((await call('POST', '/api/admin/members', { name: 'Bad Pin', email: 'p@example.com', pin: '12' }, deskToken)).status, 400);
  assert.equal((await call('GET', '/api/admin/cards?status=unassigned', null, deskToken)).body.nextUnassigned, 'BB0006');
  const byPhone = await call('GET', '/api/admin/lookup?q=' + encodeURIComponent('973-555-0101'), null, deskToken);
  assert.equal(byPhone.body.member.memberNo, 'BB0004');
  const ml = await call('POST', '/api/member/login', { ident: '9735550101', pin: '1111' });
  assert.equal(ml.status, 200, 'members can sign in with their phone number too');
  const ml2 = await call('POST', '/api/member/login', { ident: '0005', pin: '2222' });
  assert.equal(ml2.status, 200);
});

test('member search finds by name, card number, phone and email', async () => {
  const q = async s => (await call('GET', '/api/admin/members?q=' + encodeURIComponent(s), null, deskToken)).body.members.map(m => m.memberNo);
  assert.ok((await q('phoneonly')).includes('BB0004'));
  assert.ok((await q('0005')).includes('BB0005'));
  assert.ok((await q('555-0101')).includes('BB0004'));
  assert.ok((await q('emma.only@')).includes('BB0005'));
  assert.deepEqual(await q('zzz-nobody'), []);
});

test('editing member details is validated and logged with before/after and who', async () => {
  const r = await call('POST', '/api/admin/members/update',
    { memberId: emailOnly.id, phone: '201 555 0199', name: 'Emma  Only', reason: 'new phone' }, deskToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed.sort(), ['name', 'phone']);
  assert.equal(r.body.member.phone, '(201) 555-0199');
  const row = r.body.member.history.find(h => h.type === 'edit');
  assert.equal(row.detail.by, 'Desk Dee (desk1)');
  assert.equal(row.detail.changes.phone.from, '');
  assert.equal(row.detail.changes.name.to, 'Emma Only');
  assert.equal(row.detail.reason, 'new phone');
  assert.equal((await call('POST', '/api/admin/members/update', { memberId: phoneOnly.id, phone: '' }, deskToken)).status, 400,
    'cannot remove the only contact');
  assert.equal((await call('POST', '/api/admin/members/update', { memberId: phoneOnly.id, email: 'emma.only@example.com' }, deskToken)).status, 409);
  assert.equal((await call('POST', '/api/admin/members/update', { memberId: phoneOnly.id, birthday: 'yesterday' }, deskToken)).status, 400);
  const me = await call('POST', '/api/member/login', { ident: '0005', pin: '2222' });
  assert.ok(!me.body.member.history.some(h => h.type === 'edit'), 'staff notes are not shown to the member');
  assert.equal(me.body.member.tierOverride, undefined);
});

test('tier override: manager only, respected by earning, logged, and clearable', async () => {
  const t = (body, tok = mgrToken) => call('POST', '/api/admin/members/tier', { memberId: phoneOnly.id, ...body }, tok);
  assert.equal((await t({ tier: 'black' })).status, 400, 'reason required');
  assert.equal((await t({ tier: 'diamond', reason: 'nope' })).status, 400);
  const set = await t({ tier: 'black', reason: 'league captain' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.member.tier.name, 'Black');
  assert.equal(set.body.member.tierSource, 'override');
  assert.equal(set.body.member.tierOverride.by, 'Manager Mo (mgr1)');
  const exp = new Date(set.body.member.tierOverride.expiresAt), want = new Date();
  want.setUTCFullYear(want.getUTCFullYear() + 1);
  assert.ok(Math.abs(exp - want) < 3 * 864e5, 'an override expires 12 months after it is set');
  assert.equal(set.body.member.tierUntil, set.body.member.tierOverride.expiresAt);
  assert.match(set.body.member.history.find(h => h.type === 'tier').label, /until \d{4}-\d{2}-\d{2}/);
  assert.equal(set.body.member.lifetime, 0, 'points are untouched');
  const earn = await call('POST', '/api/admin/earn', { memberId: phoneOnly.id, tableHours: 2 }, deskToken);
  assert.equal(earn.body.awarded, 15, 'Black 1.5x applies through the override');
  assert.equal(earn.body.member.tierDiscount, 20);
  const clr = await t({ tier: null, reason: 'season over' });
  assert.equal(clr.status, 200);
  assert.equal(clr.body.member.tier.name, 'Blue');
  assert.equal(clr.body.member.tierSource, 'points');
  assert.equal(clr.body.member.balance, 15, 'balance is kept');
  const rows = clr.body.member.history.filter(h => h.type === 'tier');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.detail.by === 'Manager Mo (mgr1)' && r.detail.reason));
  assert.equal((await t({ tier: null, reason: 'again' })).status, 400, 'nothing to clear');
  const su = await call('POST', '/api/admin/members',
    { name: 'Silver Start', phone: '862-555-0142', tierOverride: 'silver', tierReason: 'staff family' }, mgrToken);
  assert.equal(su.status, 200, JSON.stringify(su.body));
  assert.equal(su.body.member.tier.name, 'Silver');
  assert.ok(su.body.member.tierOverride.expiresAt, 'a tier set at signup expires too');
});

test('tier overrides expire: after expiresAt the member is back on the tier their points earn', async () => {
  assert.equal(PROGRAM.tierOverride.expiryMonths, 12);
  const su = (await call('GET', '/api/admin/members?q=Silver%20Start', null, mgrToken)).body.members[0];
  assert.equal(su.tier, 'Silver'); assert.equal(su.tierOverride, true); assert.ok(su.tierUntil);
  const me = await call('GET', '/api/admin/lookup?q=' + su.memberNo, null, mgrToken);
  assert.equal(me.body.member.tierSource, 'override');
  /* push the expiry into the past on disk, as if 12 months went by */
  await stopServer();
  const f = join(TMP, 'data', 'members.json');
  const all = JSON.parse(readFileSync(f, 'utf8'));
  all.find(m => m.id === su.id).tierOverride.expiresAt = new Date(Date.now() - 60e3).toISOString();
  writeFileSync(f, JSON.stringify(all));
  await startServer();
  const after = (await call('GET', '/api/admin/lookup?q=' + su.memberNo, null, mgrToken)).body.member;
  assert.equal(after.tier.name, 'Blue', 'reverted to the earned tier');
  assert.equal(after.tierSource, 'points');
  assert.equal(after.tierOverride, null);
  const row = after.history.find(h => h.type === 'tier' && h.detail.expired);
  assert.ok(row, 'the expiry is logged'); assert.match(row.label, /expired/); assert.equal(row.detail.by, 'system');
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).find(m => m.id === su.id).tierOverride, null, 'cleared on disk');
  /* memberTier ignores an expired override even before the sweep clears it */
  const { memberTier } = await import('../server/points.js');
  assert.equal(memberTier(PROGRAM, { lifetime: 0, tierOverride: { key: 'black', expiresAt: new Date(Date.now() - 1).toISOString() } }).key, 'blue');
  assert.equal(memberTier(PROGRAM, { lifetime: 0, tierOverride: { key: 'black', expiresAt: new Date(Date.now() + 864e5).toISOString() } }).key, 'black');
});

test('closing an account blocks sign-in, earning, redeeming and vouchers; reopening restores it', async () => {
  const adj = await call('POST', '/api/admin/adjust', { memberId: emailOnly.id, points: 300 }, mgrToken);
  assert.equal(adj.status, 400, 'adjustments need a reason');
  const adj2 = await call('POST', '/api/admin/adjust', { memberId: emailOnly.id, points: 300, note: 'welcome gift' }, mgrToken);
  assert.equal(adj2.status, 200);
  const arow = adj2.body.member.history.find(h => h.type === 'adjust');
  assert.equal(arow.label, 'welcome gift');
  assert.equal(arow.detail.by, 'Manager Mo (mgr1)');
  const mtok = (await call('POST', '/api/member/login', { ident: '0005', pin: '2222' })).body.token;
  const v = await call('POST', '/api/member/redeem', { rewardId: 'table1' }, mtok);
  assert.equal(v.status, 200);
  const close = await call('POST', '/api/admin/active', { memberId: emailOnly.id, active: false, reason: 'test' }, mgrToken);
  assert.equal(close.status, 200);
  assert.equal(close.body.member.active, false);
  assert.equal((await call('POST', '/api/member/login', { ident: '0005', pin: '2222' })).status, 401);
  assert.equal((await call('GET', '/api/member/me', null, mtok)).status, 401);
  assert.equal((await call('POST', '/api/admin/earn', { memberId: emailOnly.id, tableHours: 1 }, deskToken)).status, 400);
  assert.equal((await call('POST', '/api/admin/redeem', { memberId: emailOnly.id, rewardId: 'table1' }, deskToken)).status, 400);
  assert.notEqual((await call('POST', '/api/admin/redeem/confirm', { code: v.body.code }, deskToken)).status, 200);
  assert.equal((await pos('/api/pos/toast/order-closed', { checkId: 'CHK-8001', memberIdent: '0005', subtotal: 20 })).status, 400);
  assert.equal((await call('POST', '/api/admin/active', { memberId: emailOnly.id, active: true }, mgrToken)).status, 200);
  assert.equal((await call('POST', '/api/member/login', { ident: '0005', pin: '2222' })).status, 200);
  const after = (await call('GET', '/api/admin/lookup?q=0005', null, deskToken)).body.member;
  assert.equal(after.balance, 300, 'no points moved while it was closed');
});

test('lost card: account moves to the new card, the old number is retired', async () => {
  assert.equal((await call('POST', '/api/admin/cards/reissue', { memberId: phoneOnly.id, serial: '0010' }, deskToken)).status, 409, 'card in use');
  const r = await call('POST', '/api/admin/cards/reissue', { memberId: phoneOnly.id, serial: '0020', reason: 'lost' }, deskToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.member.memberNo, 'BB0020');
  assert.equal(r.body.voided, 'BB0004');
  assert.equal(r.body.member.balance, 15, 'points came along');
  assert.equal((await call('GET', '/api/card/0004')).body.status, 'void');
  const old = await call('GET', '/api/admin/lookup?q=0004', null, deskToken);
  assert.equal(old.status, 404);
  assert.match(old.body.error, /voided/);
  assert.equal((await call('POST', '/api/admin/cards/reissue', { memberId: emailOnly.id, serial: '0004' }, deskToken)).status, 400, 'a void card is never reused');
  assert.equal((await call('POST', '/api/member/login', { ident: '0020', pin: '1111' })).status, 200);
  assert.equal((await call('POST', '/api/member/login', { ident: '0004', pin: '1111' })).status, 401);
  const note = r.body.member.history.find(h => h.type === 'note' && /BB0004 -> BB0020/.test(h.label));
  assert.equal(note.detail.by, 'Desk Dee (desk1)');
});

test('front desk may edit details and replace lost cards; both are in the audit log', async () => {
  const rows = (await call('GET', '/api/admin/audit', null, mgrToken)).body.rows;
  const edit = rows.find(r => r.action === 'member.edit' && r.target === 'BB0005');
  assert.ok(edit, 'desk edit is audited');
  assert.equal(edit.by, 'Desk Dee (desk1)'); assert.equal(edit.detail.role, 'desk');
  assert.deepEqual(edit.detail.fields.sort(), ['name', 'phone']);
  const card = rows.find(r => r.action === 'member.card-replace' && r.target === 'BB0020');
  assert.ok(card, 'desk card replacement is audited');
  assert.equal(card.by, 'Desk Dee (desk1)'); assert.equal(card.detail.from, 'BB0004');
  for(const a of ['member.tier', 'member.tier-clear', 'member.adjust', 'member.close', 'member.reopen'])
    assert.ok(rows.some(r => r.action === a), a + ' is audited');
  assert.equal((await call('GET', '/api/admin/audit', null, deskToken)).status, 403, 'the audit log itself stays manager+');
});

/* ---------- tips, persistent redemption codes, POS codes ---------- */
let tipper;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;   /* no 0/O, 1/I/L */
const lookupM = async q => (await call('GET', '/api/admin/lookup?q=' + encodeURIComponent(q), null, token)).body.member;

test('tips earn 1 point per $5 tipped, separately from the pre-tip bar subtotal', async () => {
  assert.equal(PROGRAM.earn.perTipDollar, 0.2);
  const q = quoteEarn(PROGRAM, { lifetime: 0 }, { amount: 24.99, tip: 9.99 });
  assert.equal(q.points, 4 + 1, 'each is rounded down on its own');
  assert.equal(q.lines.length, 2);
  assert.equal(quoteEarn({ ...PROGRAM, earn: { ...PROGRAM.earn, perTipDollar: 0 } }, { lifetime: 0 }, { tip: 50 }).points, 0);

  tipper = await signUp('0030', 'tip@example.com');
  const desk = await call('POST', '/api/admin/earn', { memberId: tipper, amount: 27, tip: 12 }, token);
  assert.equal(desk.status, 200, JSON.stringify(desk.body));
  assert.equal(desk.body.awarded, 5 + 2, 'floor(27 x 0.2) + floor(12 x 0.2)');
  const row = desk.body.member.history.find(h => h.type === 'earn');
  assert.equal(row.detail.tip, 12); assert.equal(row.detail.barSpend, 27);
  assert.equal((await call('POST', '/api/admin/earn', { memberId: tipper, tip: 5 }, token)).body.awarded, 1, 'tip on its own');
  assert.equal((await call('POST', '/api/admin/earn', { memberId: tipper, tip: 4 }, token)).status, 400, 'under $5 tipped earns nothing');
  assert.equal((await call('POST', '/api/admin/earn', { memberId: tipper, amount: 10, tip: 1001 }, token)).status, 400);
  assert.equal((await call('POST', '/api/admin/earn', { memberId: tipper, amount: 10, tip: -1 }, token)).status, 400);

  const t1 = await pos('/api/pos/toast/order-closed', { checkId: 'TIP-1', memberIdent: '0030', subtotal: 40, tip: 10, total: 57.2 });
  assert.equal(t1.status, 200, JSON.stringify(t1.body));
  assert.equal(t1.body.awarded, 8 + 2, 'bar on the $40 subtotal, tip on the $10 tip; the $57.20 total is ignored');
  assert.equal(t1.body.subtotal, 40); assert.equal(t1.body.tip, 10);
  assert.equal((await pos('/api/pos/toast/order-closed', { checkId: 'TIP-2', memberIdent: '0030', subtotal: 20, tipAmount: 5 })).body.awarded, 5);
  /* automatic service charges / auto-gratuity are NOT tips and earn nothing */
  const sc = await pos('/api/pos/toast/order-closed', { checkId: 'TIP-3', memberIdent: '0030', subtotal: 10, gratuity: 5 });
  assert.equal(sc.status, 200);
  assert.equal(sc.body.awarded, 2, 'only the $10 subtotal earns; the $5 gratuity does not');
  assert.equal(sc.body.tip, 0); assert.equal(sc.body.serviceChargeIgnored, 5);
  for(const [id, extra] of [['SC-1', { serviceCharge: 18 }], ['SC-2', { autoGratuity: 9.5 }],
                            ['SC-3', { serviceCharges: [{ name: 'Party 8+', amount: 12 }, { amount: 3 }] }]]){
    const r = await pos('/api/pos/toast/order-closed', { checkId: id, memberIdent: '0030', subtotal: 10, ...extra });
    assert.equal(r.body.awarded, 2, `${id}: a service charge earns nothing`);
  }
  const both = await pos('/api/pos/toast/order-closed', { checkId: 'SC-4', memberIdent: '0030', subtotal: 10, tip: 5, gratuity: 20 });
  assert.equal(both.body.awarded, 2 + 1, 'the real tip still earns when a service charge is also on the check');
  assert.equal(both.body.tip, 5);
  const huge = await pos('/api/pos/toast/order-closed', { checkId: 'TIP-4', memberIdent: '0030', subtotal: 10, tip: 1500 });
  assert.equal(huge.status, 422, 'a tip over $1000 is refused and nothing is awarded');
  assert.equal((await pos('/api/pos/toast/order-closed', { checkId: 'TIP-5', memberIdent: '0030', subtotal: 10, tip: 'x' })).status, 422);

  const blk = await pos('/api/pos/toast/order-closed', { checkId: 'TIP-B', memberIdent: '0003', subtotal: 20, tip: 20 });
  assert.equal(blk.body.awarded, 12, 'Black: (4 bar + 4 tip) x 1.5');

  const logs = (await call('GET', '/api/admin/pos/logs', null, token)).body.logs;
  const l1 = logs.find(l => l.checkId === 'TIP-1');
  assert.equal(l1.tip, 10); assert.equal(l1.tipField, 'tip'); assert.equal(l1.amount, 40);
  assert.ok(logs.some(l => l.checkId === 'TIP-4' && l.status === 'rejected'));
  const l3 = logs.find(l => l.checkId === 'TIP-3');
  assert.equal(l3.serviceChargeIgnored, 5, 'the ignored service charge is recorded in the POS log');
  assert.deepEqual(l3.serviceChargeFields, ['gratuity']); assert.equal(l3.tip, 0);
  assert.equal(logs.find(l => l.checkId === 'SC-3').serviceChargeIgnored, 15);

  const m = await lookupM('0030');
  assert.equal(m.balance, 7 + 1 + 10 + 5 + 2 + 2 * 3 + 3);
  const h = m.history.find(x => x.label === 'Toast Bar Tab #TIP-1');
  assert.equal(h.detail.tip, 10); assert.equal(h.detail.spend, 40);
  assert.equal(m.lifetimeBarSpend, 27 + 40 + 20 + 10 + 4 * 10, 'tips are never counted as bar spend');
  assert.equal(m.lifetimeTips, 12 + 5 + 10 + 5 + 5, 'service charges are not tips');
  const prog = await call('GET', '/api/program');
  assert.equal(prog.body.earn.perTipDollar, 0.2);
});

test('app codes HOLD their points at once; holds survive a restart, redeem once, and expiry releases them', async () => {
  assert.equal((await call('POST', '/api/admin/adjust', { memberId: tipper, points: 600, note: 'test: codes' }, token)).status, 200);
  const before = (await lookupM('0030')).balance;
  const mtok = (await call('POST', '/api/member/login', { ident: '0030', pin: '2468' })).body.token;
  const v = await call('POST', '/api/member/redeem', { rewardId: 'table1' }, mtok);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.match(v.body.code, CODE_RE);
  assert.equal(v.body.expiresInMinutes, 15);
  assert.equal(v.body.member.held, 250, 'the member sees the held points');
  assert.equal(v.body.member.available, before - 250);
  assert.deepEqual(v.body.member.holds.map(h => [h.code, h.cost]), [[v.body.code, 250]]);
  let m = await lookupM('0030');
  assert.equal(m.balance, before, 'the balance is untouched: the points are held, not taken');
  assert.equal(m.held, 250); assert.equal(m.available, before - 250);
  const hold = m.history.find(h => h.type === 'hold' && h.detail.code === v.body.code);
  assert.ok(hold, 'the hold is in the history'); assert.equal(hold.points, 0); assert.equal(hold.detail.held, 250);
  const onDisk = JSON.parse(readFileSync(join(TMP, 'data', 'codes.json'), 'utf8'));
  assert.equal(onDisk.find(c => c.code === v.body.code).status, 'pending');

  await stopServer();
  await startServer();

  m = await lookupM('0030');
  assert.equal(m.held, 250, 'the hold survives a restart');
  assert.equal(m.available, before - 250);
  const meAfter = (await call('GET', '/api/member/me', null, mtok)).body.member;
  assert.equal(meAfter.held, 250); assert.equal(meAfter.available, before - 250);
  assert.ok(meAfter.history.some(h => h.type === 'hold'), 'members see holds in their history');

  const typed = v.body.code.toLowerCase().slice(0, 3) + '-' + v.body.code.toLowerCase().slice(3);
  const conf = await call('POST', '/api/admin/redeem/confirm', { code: typed }, token);
  assert.equal(conf.status, 200, 'the code made before the restart still works: ' + JSON.stringify(conf.body));
  assert.equal(conf.body.member.balance, before - 250, 'redeeming turns the hold into the deduction');
  assert.equal(conf.body.member.held, 0);
  assert.equal(conf.body.member.available, before - 250, 'available did not drop a second time');
  assert.equal(conf.body.code.status, 'redeemed');
  assert.equal(conf.body.code.source, 'member-app');
  assert.ok(conf.body.code.confirmedBy && conf.body.code.confirmedAt);
  const again = await call('POST', '/api/admin/redeem/confirm', { code: v.body.code }, token);
  assert.equal(again.status, 409); assert.match(again.body.error, /already used/);
  assert.equal((await lookupM('0030')).balance, before - 250, 'a second confirm takes nothing');
  const saved = JSON.parse(readFileSync(join(TMP, 'data', 'codes.json'), 'utf8')).find(c => c.code === v.body.code);
  assert.equal(saved.status, 'redeemed'); assert.ok(saved.confirmedBy);

  /* one app code at a time: a new one replaces the old one and releases its hold */
  const bal = before - 250;                                     /* 384 */
  const a = (await call('POST', '/api/member/redeem', { rewardId: 'table1' }, mtok)).body;
  const b = (await call('POST', '/api/member/redeem', { rewardId: 'table1' }, mtok)).body;
  assert.ok(a.code && b.code, 'a replacement is allowed even though only one code fits in the available balance');
  assert.notEqual(a.code, b.code);
  assert.equal(b.member.held, 250, 'only the newest app code holds points');
  assert.equal((await call('POST', '/api/admin/redeem/confirm', { code: a.code }, token)).status, 410);
  m = await lookupM('0030');
  const rel = m.history.find(h => h.type === 'release' && h.detail.code === a.code);
  assert.ok(rel, 'replacing releases the old hold'); assert.match(rel.label, /Replaced by a newer code/);
  /* over-balance: an app code for more than the available points is refused, and the old code is kept */
  const big = await call('POST', '/api/member/redeem', { rewardId: 'table2' }, mtok);
  assert.equal(big.status, 400); assert.match(big.body.error, /Not enough points/);
  assert.equal((await lookupM('0030')).pendingCodes[0].code, b.code, 'a refused code does not cancel the one they have');

  /* expiry releases the hold: push b's expiry into the past on disk */
  await stopServer();
  const f = join(TMP, 'data', 'codes.json');
  const all = JSON.parse(readFileSync(f, 'utf8'));
  all.find(c => c.code === b.code).expiresAt = new Date(Date.now() - 1000).toISOString();
  writeFileSync(f, JSON.stringify(all));
  await startServer();
  m = await lookupM('0030');
  assert.equal(m.held, 0, 'an expired code holds nothing'); assert.equal(m.available, bal);
  const exp = m.history.find(h => h.type === 'release' && h.detail.code === b.code);
  assert.ok(exp, 'the expiry release is logged'); assert.equal(exp.detail.status, 'expired');
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).find(c => c.code === b.code).status, 'expired', 'marked expired on disk');
  const late = await call('POST', '/api/admin/redeem/confirm', { code: b.code }, token);
  assert.equal(late.status, 410); assert.match(late.body.error, /expired/);
  assert.equal((await lookupM('0030')).balance, bal);
  assert.equal(m.history.filter(h => h.type === 'release' && h.detail.code === b.code).length, 1, 'released exactly once');
  assert.equal((await call('POST', '/api/admin/redeem/confirm', { code: 'ZZZZZZ' }, token)).status, 404);
});

test('register codes: POS key, 24h, hold on creation, max 2 open, over-balance refused, manager-only cancel, closing releases', async () => {
  assert.equal(PROGRAM.redeemCodes.maxOpenPosCodes, 2);
  assert.equal((await call('POST', '/api/pos/redeem-code', { memberNo: '0030', rewardId: 'table1' })).status, 401, 'needs the POS key');
  assert.equal((await pos('/api/pos/redeem-code', { memberNo: '0030' })).status, 400, 'reward required');
  assert.equal((await pos('/api/pos/redeem-code', { memberNo: '0030', rewardId: 'drink1' })).status, 400, 'table time only');
  assert.equal((await pos('/api/pos/redeem-code', { memberNo: '0049', rewardId: 'table1' })).status, 404);
  const start = (await lookupM('0030')).balance;    /* 384 */
  assert.equal((await pos('/api/pos/redeem-code', { memberNo: '0030', rewardId: 'table3' })).status, 400, 'not enough points');

  const A = await pos('/api/pos/redeem-code', { email: 'TIP@example.com', rewardId: 'table1', terminal: 'Bar 1' });
  assert.equal(A.status, 200, JSON.stringify(A.body));
  assert.match(A.body.code, CODE_RE);
  assert.equal(A.body.expiresInHours, 24);
  assert.ok(Math.abs(Date.parse(A.body.expiresAt) - (Date.now() + 24 * 3600e3)) < 60e3);
  assert.ok(A.body.receiptText.includes(A.body.code));
  assert.equal(A.body.member.held, 250); assert.equal(A.body.member.available, start - 250);
  /* over-balance: the second code does not fit in what is left */
  const over = await pos('/api/pos/redeem-code', { memberNo: '0030', rewardId: 'table1' });
  assert.equal(over.status, 400, 'creation fails when the AVAILABLE balance is short');
  assert.match(over.body.error, /held by open codes/);
  assert.equal((await call('POST', '/api/admin/redeem', { memberId: tipper, rewardId: 'table1' }, token)).status, 400,
    'held points cannot be spent at the desk either');
  const adjTooFar = await call('POST', '/api/admin/adjust', { memberId: tipper, points: -(start - 250 + 1), note: 'test: too far' }, token);
  assert.equal(adjTooFar.status, 400, 'an adjustment cannot eat into held points'); assert.match(adjTooFar.body.error, /held/);

  await call('POST', '/api/admin/adjust', { memberId: tipper, points: 200, note: 'test: top up' }, token);
  const B = await pos('/api/pos/redeem-code', { memberNo: '0030', rewardId: 'table1' });
  assert.equal(B.status, 200, JSON.stringify(B.body));
  let m = await lookupM('0030');
  assert.equal(m.balance, start + 200, 'no points come off when a code is made');
  assert.equal(m.held, 500); assert.equal(m.available, start + 200 - 500);
  assert.deepEqual(m.pendingCodes.map(c => c.code).sort(), [A.body.code, B.body.code].sort());
  assert.ok(m.pendingCodes.every(c => c.source === 'pos'));
  assert.ok(m.history.some(h => h.type === 'hold' && h.label.includes(A.body.code)), 'the hold is logged');
  assert.ok((await call('GET', '/api/admin/pos/logs', null, token)).body.logs.some(l => l.source === 'redeem-code' && l.code === A.body.code && l.held === 250));
  /* max 2 open register codes per member */
  await call('POST', '/api/admin/adjust', { memberId: tipper, points: 500, note: 'test: top up' }, token);
  const third = await pos('/api/pos/redeem-code', { memberNo: '0030', rewardId: 'table1' });
  assert.equal(third.status, 429, 'a third open register code is refused');
  assert.match(third.body.error, /2 register codes/);
  assert.equal((await call('POST', '/api/admin/codes/issue', { memberId: tipper, rewardId: 'table1' }, deskToken)).status, 429,
    '"Code for later" counts toward the same limit');

  const bal0 = (await lookupM('0030')).balance;
  const cA = await call('POST', '/api/admin/redeem/confirm', { code: A.body.code }, deskToken);
  assert.equal(cA.status, 200, 'front desk can redeem');
  assert.equal(cA.body.member.balance, bal0 - 250);
  assert.equal(cA.body.member.held, 250, 'only B is still held');
  assert.equal(cA.body.member.available, bal0 - 500, 'available is unchanged by the redeem: no double deduction');
  const redeems = cA.body.member.history.filter(h => h.type === 'redeem' && h.detail.viaCode === A.body.code);
  assert.equal(redeems.length, 1); assert.equal(redeems[0].points, -250);

  /* cancelling is manager / admin only */
  const deskCancel = await call('POST', '/api/admin/codes/cancel', { code: B.body.code, reason: 'nope' }, deskToken);
  assert.equal(deskCancel.status, 403, 'front desk cannot cancel a code');
  assert.equal((await lookupM('0030')).held, 250, 'the refused cancel changed nothing');
  const cancel = await call('POST', '/api/admin/codes/cancel', { code: B.body.code, reason: 'guest changed mind' }, mgrToken);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.code.status, 'cancelled');
  assert.equal(cancel.body.member.pendingCodes.length, 0);
  assert.equal(cancel.body.member.held, 0, 'cancel releases the hold');
  assert.equal(cancel.body.member.balance, bal0 - 250, 'nothing was taken, nothing refunded');
  const relB = cancel.body.member.history.find(h => h.type === 'release' && h.detail.code === B.body.code);
  assert.ok(relB); assert.match(relB.label, /guest changed mind/); assert.equal(relB.detail.by, 'Manager Mo (mgr1)');
  assert.equal((await call('POST', '/api/admin/redeem/confirm', { code: B.body.code }, token)).status, 410);
  assert.equal((await call('POST', '/api/admin/codes/cancel', { code: B.body.code }, token)).status, 400);
  assert.ok((await call('GET', '/api/admin/audit', null, mgrToken)).body.rows.some(r => r.action === 'code.cancel' && r.target === B.body.code));

  /* front desk "Code for later": desk can create it, and redeem it */
  const D = await call('POST', '/api/admin/codes/issue', { memberId: tipper, rewardId: 'table1' }, deskToken);
  assert.equal(D.status, 200, JSON.stringify(D.body));
  assert.equal(D.body.memberView.held, 250);
  assert.equal((await call('POST', '/api/admin/redeem/confirm', { code: D.body.code }, deskToken)).status, 200);

  /* optional requestRedeemCode on an earn: the code holds its points too */
  const cu = await pos('/api/pos/cuet/session-closed', { sessionId: 'S-RC1', memberIdent: '0030', tableHours: 1, requestRedeemCode: 'table1' });
  assert.equal(cu.status, 200, JSON.stringify(cu.body));
  assert.equal(cu.body.awarded, 5);
  assert.match(cu.body.redeemCode.code, CODE_RE);
  assert.equal(cu.body.redeemCode.member.held, 250);
  const tb = await pos('/api/pos/toast/order-closed', { checkId: 'RC-T1', memberIdent: '0030', subtotal: 10, requestRedeemCode: 'drink1' });
  assert.equal(tb.status, 200);
  assert.equal(tb.body.awarded, 2, 'the earn stands even if the code cannot be made');
  assert.match(tb.body.redeemCodeError, /table time/);
  const mtok = (await call('POST', '/api/member/login', { ident: '0030', pin: '2468' })).body.token;
  const app = await call('POST', '/api/member/redeem', { rewardId: 'table1' }, mtok);
  assert.equal(app.status, 200);
  assert.equal(app.body.member.held, 500, 'app + register holds add up');

  /* closing the account cancels its codes and releases every hold */
  const balC = (await lookupM('0030')).balance;
  assert.equal((await call('POST', '/api/admin/active', { memberId: tipper, active: false, reason: 'test' }, token)).status, 200);
  const codes = (await call('GET', '/api/admin/codes?memberId=' + tipper, null, token)).body;
  assert.equal(codes.pending.length, 0);
  const gone = codes.recent.find(c => c.code === cu.body.redeemCode.code);
  assert.equal(gone.status, 'cancelled'); assert.equal(gone.cancelReason, 'Account closed');
  assert.equal((await call('POST', '/api/admin/redeem/confirm', { code: cu.body.redeemCode.code }, token)).status, 410);
  assert.equal((await pos('/api/pos/redeem-code', { memberNo: '0030', rewardId: 'table1' })).status, 400, 'no codes for a closed account');
  assert.equal((await call('POST', '/api/admin/active', { memberId: tipper, active: true }, token)).status, 200);
  m = await lookupM('0030');
  assert.equal(m.held, 0); assert.equal(m.balance, balC, 'closing moved no points');
  assert.equal(m.history.filter(h => h.type === 'release' && /Account closed/.test(h.label)).length, 2);

  /* replacing a lost card cancels its codes and releases the hold */
  const E = await pos('/api/pos/redeem-code', { memberNo: '0030', rewardId: 'table1' });
  assert.equal(E.status, 200);
  const re = await call('POST', '/api/admin/cards/reissue', { memberId: tipper, serial: '0041', reason: 'lost' }, deskToken);
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal(re.body.member.held, 0); assert.equal(re.body.member.pendingCodes.length, 0);
  assert.ok(re.body.member.history.some(h => h.type === 'release' && h.detail.code === E.body.code && /Card replaced/.test(h.label)));
  assert.equal((await call('POST', '/api/admin/redeem/confirm', { code: E.body.code }, token)).status, 410);

  const stats = (await call('GET', '/api/admin/stats', null, token)).body;
  assert.ok(Array.isArray(stats.pendingVouchers));
  assert.equal(typeof stats.pointsHeld, 'number');
  const look = (await pos('/api/pos/cuet/lookup', { ident: '0041' })).body;
  assert.equal(look.pointsHeld, 0); assert.equal(look.pointsAvailable, look.pointsBalance);
});

test('backup writes a private tar.gz; restore refuses while the server runs, then restores', () => {
  const bdir = join(TMP, 'backups');
  const env = { ...CLEAN, ENV_FILE: join(TMP, 'none.env'), DATA_DIR: join(TMP, 'data'), BACKUP_DIR: bdir, PORT: String(PORT) };
  const b = spawnSync(process.execPath, ['scripts/backup.mjs'], { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(b.status, 0, b.stderr);
  const file = b.stdout.match(/Backup written: (\S+\.tar\.gz)/)[1];
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const busy = spawnSync(process.execPath, ['scripts/backup.mjs', '--restore', file], { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(busy.status, 1, 'refuses while the server answers on its port');
  assert.match(busy.stderr, /Stop it first/);
  const env2 = { ...env, DATA_DIR: join(TMP, 'data-restored'), PORT: String(PORT + 3) };
  const bad = spawnSync(process.execPath, ['scripts/backup.mjs', '--restore', join(ROOT, 'package.json')], { cwd: ROOT, env: env2, encoding: 'utf8', timeout: 20000 });
  assert.equal(bad.status, 1);
  const ok2 = spawnSync(process.execPath, ['scripts/backup.mjs', '--restore', file], { cwd: ROOT, env: env2, encoding: 'utf8', timeout: 20000 });
  assert.equal(ok2.status, 0, ok2.stderr);
  const orig = JSON.parse(readFileSync(join(TMP, 'data', 'members.json'), 'utf8'));
  const back = JSON.parse(readFileSync(join(TMP, 'data-restored', 'members.json'), 'utf8'));
  assert.deepEqual(back, orig);
  assert.ok(existsSync(join(TMP, 'data-restored', 'staff.json')));
});

test('private files are never served; /rewards goes to the member page', async () => {
  for(const p of ['/server/.env', '/server/data/members.json', '/server/data/.secret', '/server/server.js',
                  '/REWARDS.md', '/package.json', '/.gitignore', '/%2e%2e/%2e%2e/etc/passwd'])
    assert.equal((await fetch(BASE + p)).status, 404, p);
  assert.equal((await fetch(BASE + '/admin.html')).status, 200);
  assert.equal((await fetch(BASE + '/moo_card_backs_BB0001-0050.pdf')).headers.get('content-type'), 'application/pdf');
  const r = await fetch(BASE + '/rewards', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/#rewards');
});

test('POS terminals are locked out without the right POS key', async () => {
  const r = await call('POST', '/api/pos/cuet/session-closed', { memberIdent: '0001', tableHours: 5 });
  assert.equal(r.status, 401);
  const withBadKey = await call('POST', '/api/pos/cuet/session-closed', { memberIdent: '0001', tableHours: 5 }, null, { 'X-POS-Key': 'guess' });
  assert.equal(withBadKey.status, 401);
});

test('server refuses to start with no admin password', () => {
  writeFileSync(join(TMP, 'empty.env'), `PORT=${PORT + 1}\nDATA_DIR=${join(TMP, 'data-empty')}\n`);
  const r = spawnSync(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...CLEAN, ENV_FILE: join(TMP, 'empty.env') }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm run setup/);
});

test('setup creates .env with a HASHED generated password and seeds BB0001–BB0050', () => {
  const envFile = join(TMP, 'setup.env'), pwFile = join(TMP, 'pw.txt'), data = join(TMP, 'data-setup');
  const r = spawnSync(process.execPath, ['scripts/setup.mjs', '--generate', '--password-file', pwFile],
    { cwd: ROOT, env: { ...CLEAN, ENV_FILE: envFile, DATA_DIR: data }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const env = readFileSync(envFile, 'utf8');
  const pw = readFileSync(pwFile, 'utf8').match(/Password: (\S+)/)[1];
  assert.ok(pw.length >= 16);
  assert.match(env, /^ADMIN_PASS_HASH=[0-9a-f]{32}:[0-9a-f]{128}$/m);
  assert.ok(!env.includes(pw), 'the password itself is not stored');
  assert.ok(!r.stdout.includes(pw), 'the password is not printed');
  assert.equal(statSync(pwFile).mode & 0o777, 0o600);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  const cards = JSON.parse(readFileSync(join(data, 'cards.json'), 'utf8'));
  assert.equal(cards.length, 50);
  assert.equal(cards[0].serial, 'BB0001');
  assert.equal(cards[49].serial, 'BB0050');
});

test('card PDF generator reproduces the printed card backs exactly', () => {
  const out = join(TMP, 'backs.pdf');
  const r = spawnSync(process.execPath, ['scripts/make-cards.mjs', '--from', '1', '--count', '3', '--out', out],
    { cwd: ROOT, env: CLEAN, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const pages = f => {
    const b = readFileSync(f), s = b.toString('latin1'), outp = [];
    const re = /stream\r?\n/g; let m;
    while((m = re.exec(s))){
      const st = m.index + m[0].length, en = s.indexOf('endstream', st);
      try { const t = inflateSync(b.subarray(st, en)).toString('latin1'); if(t.includes(' TJ')) outp.push(t); } catch {}
    }
    return outp;
  };
  const printed = pages(join(ROOT, 'moo_card_backs_BB0001-0050.pdf')).slice(0, 3);
  assert.deepEqual(pages(out), printed);
  assert.ok(existsSync(join(ROOT, 'moo_card_backs_BB0001-0050.pdf')));
});
