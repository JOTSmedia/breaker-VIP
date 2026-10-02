/* ============================================================
   AUTH — password/PIN hashing and signed session tokens.

   Uses only node:crypto. Two kinds of credential:

   MEMBER  — logs in with member number (or email) + a 4-digit PIN that
             staff sets at signup. A PIN is weak on purpose: it protects a
             points balance, not money, and it has to be usable by someone
             holding a drink. It is still salted and hashed, never stored in
             the clear, and login is rate-limited by member.

   ADMIN   — username + password from .env, hashed the same way. Admin
             tokens are separate from member tokens and carry a role, so a
             member token can never reach an admin route.

   Tokens are HMAC-signed payloads (not JWT, to stay dependency-free) with
   an expiry baked in and verified on every request.
   ============================================================ */
import { scryptSync, randomBytes, randomInt, timingSafeEqual, createHmac, createHash } from 'node:crypto';

/* ---------- hashing ---------- */
export function hash(secret){
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(String(secret), salt, 64).toString('hex');
  return `${salt}:${key}`;
}
export function verifyHash(secret, stored){
  if(!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const a = Buffer.from(key, 'hex');
  const b = scryptSync(String(secret), salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- tokens ---------- */
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

export function sign(payload, secret, ttlHours){
  const body = b64({ ...payload, exp: Date.now() + ttlHours * 3600e3 });
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}
export function verify(token, secret){
  if(typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const want = createHmac('sha256', secret).update(body).digest('base64url');
  /* constant-time compare, and length-check first so timingSafeEqual can't throw */
  if(mac.length !== want.length) return null;
  if(!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch(e){ return null; }
  if(!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

/* ---------- brute-force brake ----------
   Per-key attempt counter. Not a substitute for a real WAF, but it stops
   someone walking a 4-digit PIN across 10,000 guesses from the parking lot. */
const fails = new Map();
const WINDOW = 15 * 60e3, MAX = 8;

export function throttled(key){
  const rec = fails.get(key);
  if(!rec) return false;
  if(Date.now() - rec.first > WINDOW){ fails.delete(key); return false; }
  return rec.n >= MAX;
}
export function noteFail(key){
  const rec = fails.get(key);
  if(!rec || Date.now() - rec.first > WINDOW) fails.set(key, { n: 1, first: Date.now() });
  else rec.n++;
}
export const clearFails = key => fails.delete(key);

export const pinOk = p => /^\d{4}$/.test(String(p || ''));
export const randomPin = () => String(randomInt(1000, 10000));

/* ---------- retired demo passwords ----------
   Earlier builds shipped with demo passwords printed in the docs. Only their
   SHA-256 fingerprints are kept here, so the server and setup can refuse
   them if they are still sitting in an old .env. */
const RETIRED = new Set([
  "3826dfe92243a9642584061b19374cdb00a1eef80d3fcf55dc3776a56a1c4ee8",
  "ae044151425fb8481972eb28795c7703b94ed0a0e0d6aff5744b34a909de940e",
  "690234c7ed7607c369f95f95523a112283cb0228c3910df34696f3b969dc8bfe",
  "1808da7d3b47a55047aafa2a7560920652b55d806599903e09ce3f84ae5d0749",
  "02ccf27105554b9a7fc512ba9f40b863ff974c35487512a7ea8b0e661f831b12"
]);
export const isRetiredPassword = p => RETIRED.has(createHash('sha256').update(String(p)).digest('hex'));
export const isHash = h => /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(String(h || '').trim());
