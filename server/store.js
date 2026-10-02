/* ============================================================
   STORE — the database.

   A JSON file per collection, written atomically (temp file + fsync +
   rename) so a crash mid-write can never leave a half-written members list.
   Deliberately zero dependencies: no native build, no service to sign up
   for. At bar scale — thousands of members, tens of thousands of ledger
   rows — this is comfortably fast, because the whole thing is held in
   memory and only flushed on change.

   Where it lives: server/data/ by default, or DATA_DIR (set it to a
   persistent disk on a host). Back that folder up and you have backed up
   everything.

   If it ever outgrows that (it won't for one room), every access goes
   through this module, so swapping in SQLite or Postgres means rewriting
   this file only and nothing else.
   ============================================================ */
import './env.js';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync,
         openSync, fsyncSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA = resolve(process.env.DATA_DIR || join(HERE, 'data'));

/* The printed cards (moo_card_*_BB0001-0050.pdf) carry just the number,
   "0001" … "0050". In the database a card is "BB0001" … "BB0050". */
export const CARD_PREFIX = 'BB';
export const PRINTED_CARDS = 50;

if(!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

function load(name, fallback){
  const f = join(DATA, name + '.json');
  if(!existsSync(f)) return fallback;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch(e){
    /* Never silently start with an empty database — that would look like
       "all the members vanished" and staff would re-enter everything. */
    throw new Error(`${f} is corrupt and was not overwritten: ${e.message}`);
  }
}
function save(name, value){
  const f = join(DATA, name + '.json');
  const tmp = f + '.tmp';
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, f);           /* atomic on POSIX */
}

/* ---------- card numbers ----------
   Accept every way staff or a guest might type a card number:
   "0001", "1", "#0001", "BB0001", "bb-0001", and the older "BB-00001".
   All of them mean card BB0001. Anything else is returned unchanged
   (upper-cased) so it simply won't match a card. */
export function canonSerial(s){
  const raw = String(s == null ? '' : s).trim().toUpperCase();
  const m = raw.match(/^(?:BB)?[\s#-]*0*(\d{1,6})$/);
  if(!m || Number(m[1]) < 1) return raw;
  return CARD_PREFIX + String(Number(m[1])).padStart(4, '0');
}
export const normSerial = canonSerial;
export function serialNumber(s){
  const m = canonSerial(s).match(/^BB(\d+)$/);
  return m ? Number(m[1]) : null;
}
const serialFor = n => CARD_PREFIX + String(n).padStart(4, '0');

/* ---------- collections ---------- */
export const db = {
  members: load('members', []),
  ledger:  load('ledger', []),
  cards:   load('cards', []),
  posLog:  load('posLog', []),
  meta:    load('meta', { nextSerial: 1 }),
  staff:   load('staff', []),     /* staff logins made in the portal (scrypt hashes only) */
  audit:   load('audit', []),     /* staff-account changes: who created/disabled/reset whom */
  codes:   load('codes', [])      /* free-table-time redemption codes (app + POS), pending and finished */
};

export const flush = {
  members: () => save('members', db.members),
  ledger:  () => save('ledger', db.ledger),
  cards:   () => save('cards', db.cards),
  posLog:  () => save('posLog', db.posLog),
  meta:    () => save('meta', db.meta),
  staff:   () => save('staff', db.staff),
  audit:   () => save('audit', db.audit),
  codes:   () => save('codes', db.codes),
  all(){ this.members(); this.ledger(); this.cards(); this.posLog(); this.meta(); this.staff(); this.audit(); this.codes(); }
};

/* ---------- migrate + seed (runs on every start, idempotent) ----------
   1. Older data used "BB-00001" style numbers; rewrite them as "BB0001" so
      they match what is printed on the cards.
   2. Make sure every printed card, BB0001–BB0050, exists as a blank.
   3. Repair any balance that an old bug turned into null/NaN by re-adding
      that member's ledger. */
function migrate(){
  const dirty = new Set();
  for(const c of db.cards){
    const s = canonSerial(c.serial);
    if(s !== c.serial){ c.serial = s; dirty.add('cards'); }
  }
  for(const m of db.members){
    const s = canonSerial(m.memberNo);
    if(s !== m.memberNo){ m.memberNo = s; dirty.add('members'); }
  }
  for(const p of db.posLog){
    if(p.memberNo && canonSerial(p.memberNo) !== p.memberNo){ p.memberNo = canonSerial(p.memberNo); dirty.add('posLog'); }
  }
  const have = new Set(db.cards.map(c => c.serial));
  for(let n = 1; n <= PRINTED_CARDS; n++){
    if(have.has(serialFor(n))) continue;
    db.cards.push({ serial: serialFor(n), printed: new Date().toISOString(),
                    memberId: null, assignedAt: null, void: false, by: 'seed' });
    dirty.add('cards');
  }
  if(dirty.has('cards')) db.cards.sort((a, b) => (serialNumber(a.serial) || 0) - (serialNumber(b.serial) || 0));
  const maxN = db.cards.reduce((a, c) => Math.max(a, serialNumber(c.serial) || 0), 0);
  if(!(db.meta.nextSerial > maxN)){ db.meta.nextSerial = maxN + 1; dirty.add('meta'); }

  for(const m of db.members){
    if(Number.isFinite(m.balance) && Number.isFinite(m.lifetime)) continue;
    const rows = db.ledger.filter(r => r.memberId === m.id && Number.isFinite(r.points));
    m.balance = rows.reduce((a, r) => a + r.points, 0);
    m.lifetime = rows.filter(r => r.points > 0).reduce((a, r) => a + r.points, 0);
    console.warn(`  Repaired the points balance of ${m.memberNo} from its ledger`);
    dirty.add('members');
  }
  for(const name of dirty) flush[name]();
}
migrate();

/* ---------- lookups ---------- */
export const findById    = id => db.members.find(m => m.id === id);
export const findByNo    = no => {
  const s = canonSerial(no);
  return s ? db.members.find(m => m.memberNo === s) : undefined;
};
/* Email is optional now (phone OR email), so an empty email must never
   "match" every member who has none. */
export const findByEmail = e => {
  const want = String(e || '').trim().toLowerCase();
  if(!want) return undefined;
  return db.members.find(m => String(m.email || '').toLowerCase() === want);
};
/* Phones compare on digits only, and a leading US country code is ignored,
   so "(973) 555-0101", "973.555.0101" and "+1 973 555 0101" are one number. */
export function phoneKey(p){
  let d = String(p || '').replace(/\D/g, '');
  if(d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}
export const findByPhone = p => {
  const clean = phoneKey(p);
  if(!clean || clean.length < 7) return null;
  return db.members.find(m => phoneKey(m.phone) === clean);
};

/* Staff type a card number, scan a barcode, type a phone or email — one door. */
export function findByAny(q){
  const s = String(q || '').trim();
  if(!s) return null;
  return findByNo(s) || findByEmail(s) || findByPhone(s) || null;
}

/* ---------- card inventory ----------
   Cards are printed in bulk BEFORE anyone signs up: a box of identical
   blanks whose only variable is the number. Signup assigns an existing
   number to a new profile. A number therefore has a life of its own:
     printed  -> in the drawer, unassigned
     assigned -> belongs to one member
     void     -> lost/damaged, can never be reassigned
*/
export const findCard = s => db.cards.find(c => c.serial === canonSerial(s));
export const cardForMember = id => db.cards.find(c => c.memberId === id && !c.void);

/* Mint the next N numbers (BB0051, BB0052 …). Do this BEFORE printing. */
export function mintCards(prefix, count, by){
  const made = [];
  for(let i = 0; i < count; i++){
    const n = db.meta.nextSerial++;
    made.push({
      serial: serialFor(n),
      printed: new Date().toISOString(),
      memberId: null, assignedAt: null, void: false, by: by || null
    });
  }
  db.cards.push(...made);
  flush.cards(); flush.meta();
  return made;
}

export const ledgerFor = id => db.ledger.filter(r => r.memberId === id);
