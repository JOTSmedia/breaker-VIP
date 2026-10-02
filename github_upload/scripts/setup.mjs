#!/usr/bin/env node
/* ============================================================
   npm run setup — first-time setup. Safe to run again.

     1. creates server/.env from server/.env.example (if it is missing)
     2. sets the admin password — asks for one, or generates a strong one —
        and stores ONLY a scrypt hash of it in .env
     3. fills in a session secret
     4. creates / updates the database: blank cards BB0001–BB0050

   Options
     --reset-password        choose a new admin password (npm run set-password)
     --generate              don't ask, generate a strong password
     --password-file <path>  write a generated password to that file
                             (readable only by you) instead of the screen
     --fresh                 back up the current .env and start a new one

   Environment
     ADMIN_PASSWORD=...      use this password (scripted installs)
     ENV_FILE / DATA_DIR     use a different settings file / data folder
   ============================================================ */
import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

if(Number(process.versions.node.split('.')[0]) < 18){
  console.error(`Node.js 18 or newer is needed (this computer has ${process.version}). Get the LTS from https://nodejs.org`);
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'server', '.env.example');
const ENV = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : join(ROOT, 'server', '.env');
process.env.ENV_FILE = ENV;

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const { hash, isHash, isRetiredPassword } = await import('../server/auth.js');

function ask(q, hidden){
  return new Promise(done => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if(hidden) rl._writeToOutput = s => { if(s.includes(q)) rl.output.write(q); };
    rl.question(q, a => { rl.close(); if(hidden) process.stdout.write('\n'); done(a); });
  });
}

console.log('\n  Breaker Billiards rewards — setup\n');

/* 1. settings file */
if(flag('--fresh') && existsSync(ENV)){
  const bak = `${ENV}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(ENV, bak); chmodSync(bak, 0o600);
  console.log(`  Backed up the old settings to ${bak}`);
}
if(!existsSync(ENV) || flag('--fresh')){
  copyFileSync(EXAMPLE, ENV);
  console.log(`  Created ${ENV}`);
}
chmodSync(ENV, 0o600);
let text = readFileSync(ENV, 'utf8');
const get = k => ((text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
const set = (k, v) => {
  const re = new RegExp(`^${k}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, () => `${k}=${v}`) : text.replace(/\n*$/, `\n${k}=${v}\n`);
};

for(const k of ['ADMIN_PASS', 'MANAGER_PASS', 'BAR_PASS', 'DESK_PASS']){
  if(get(k) && isRetiredPassword(get(k))){ set(k, ''); console.log(`  Removed an old demo password from ${k}`); }
}
if(get('ALLOW_ORIGIN') === '*'){ set('ALLOW_ORIGIN', ''); console.log('  Cleared ALLOW_ORIGIN="*" (not needed when this server hosts the pages)'); }
if(!get('ADMIN_USER')) set('ADMIN_USER', 'admin');

/* 2. admin password */
const hasAdmin = isHash(get('ADMIN_PASS_HASH')) || get('ADMIN_PASS').length >= 8;
let generated = null, changed = false;
if(!hasAdmin || flag('--reset-password')){
  let pw = process.env.ADMIN_PASSWORD || '';
  if(!pw && !flag('--generate') && process.stdin.isTTY){
    console.log('  Choose the admin password (8+ characters),');
    console.log('  or just press Enter and a strong one will be made for you.');
    pw = await ask('  Admin password: ', true);
    if(pw && (await ask('  Type it again:  ', true)) !== pw){
      console.error('\n  Those did not match — nothing was changed. Run it again.\n'); process.exit(1);
    }
  }
  if(!pw){ pw = randomBytes(15).toString('base64url'); generated = pw; }
  if(pw.length < 8 || isRetiredPassword(pw)){
    console.error('\n  That password is too short (or is an old demo password). Nothing was changed.\n'); process.exit(1);
  }
  set('ADMIN_PASS_HASH', hash(pw));
  set('ADMIN_PASS', '');
  changed = true;
}

/* 3. session secret */
if(!get('SESSION_SECRET')) set('SESSION_SECRET', randomBytes(32).toString('hex'));

writeFileSync(ENV, text, { mode: 0o600 });
chmodSync(ENV, 0o600);

const user = get('ADMIN_USER');
const pwFile = opt('--password-file');
if(generated && pwFile){
  const f = resolve(pwFile);
  writeFileSync(f, `Breaker Billiards rewards — admin login\n\nUsername: ${user}\nPassword: ${generated}\n\n` +
    `Put this in a password manager, then delete this file.\nChange it any time with:  npm run set-password\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
  console.log(`  Admin password generated and written to ${f} (only you can read it).`);
} else if(generated){
  console.log('\n  ┌──────────────────────────────────────────────┐');
  console.log(`  │  Admin username:  ${user.padEnd(27)}│`);
  console.log(`  │  Admin password:  ${generated.padEnd(27)}│`);
  console.log('  │  Write this down now — it is not shown again. │');
  console.log('  └──────────────────────────────────────────────┘\n');
} else if(changed){
  console.log('  Admin password saved (stored only as a hash).');
} else {
  console.log('  Admin password is already set — left alone (npm run set-password changes it).');
}
if(changed && hasAdmin) console.log('  Anyone signed in to the staff console with the old password is now signed out.');

/* 4. database */
const { db, DATA } = await import('../server/store.js');
console.log(`  Database ready in ${DATA}`);
console.log(`    ${db.cards.length} cards (${db.cards[0].serial} to ${db.cards[db.cards.length - 1].serial}), ${db.members.length} members`);
console.log('\n  Done. Start it with:  npm start');
console.log(`  Then open http://127.0.0.1:${get('PORT') || 4400}/admin.html and sign in as "${user}".\n`);
