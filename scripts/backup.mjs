#!/usr/bin/env node
/* ============================================================
   npm run backup                  -> backups/rewards-data-<date>_<time>.tar.gz
   npm run restore -- <file>       -> puts a backup back (server must be stopped)

   The whole database is the data folder (server/data, or DATA_DIR): members,
   points ledger, cards, POS log, staff logins and the session secret. A backup
   is a gzipped tar of that folder, readable only by you (mode 600), written
   to backups/ (gitignored) or BACKUP_DIR.

   Restore first takes a "pre-restore" backup of whatever is there now, checks
   the archive really is a rewards backup, and only then replaces the data.
   It refuses to run while the server is answering on its port (the running
   server would overwrite the restored files); use --force only if you are
   sure it is stopped.
   ============================================================ */
import '../server/env.js';           /* DATA_DIR / PORT / BACKUP_DIR from server/.env, if set */
import { existsSync, mkdirSync, chmodSync, statSync, readdirSync, readFileSync, copyFileSync,
         rmSync, mkdtempSync, lstatSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(process.env.DATA_DIR || join(ROOT, 'server', 'data'));
const OUT_DIR = resolve(process.env.BACKUP_DIR || join(ROOT, 'backups'));
const PORT = Number(process.env.PORT || 4400);
const REQUIRED = ['members.json', 'ledger.json', 'cards.json'];
const SAFE_NAME = /^\.?[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const die = msg => { console.error('\n  ' + msg + '\n'); process.exit(1); };
const stamp = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function backup(prefix = 'rewards-data'){
  if(!existsSync(join(DATA, 'members.json')) && !existsSync(join(DATA, 'cards.json')))
    die(`No rewards data found in ${DATA} — nothing to back up.`);
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  let out = join(OUT_DIR, `${prefix}-${stamp()}.tar.gz`);
  for(let i = 2; existsSync(out); i++) out = join(OUT_DIR, `${prefix}-${stamp()}-${i}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '--exclude', '*.tmp', '-C', DATA, '.'], { encoding: 'utf8' });
  if(r.status !== 0) die(`tar failed: ${r.stderr || r.error}`);
  chmodSync(out, 0o600);
  return out;
}

async function serverUp(){
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: ctl.signal });
    return r.ok;
  } catch { return false; }
}

async function restore(file, force){
  if(!file) die('Which backup? e.g.  npm run restore -- backups/rewards-data-2026-09-29_030000.tar.gz');
  const src = resolve(file);
  if(!existsSync(src) || !statSync(src).isFile()) die(`No such file: ${src}`);
  if(!force && await serverUp()) die(`The rewards server is running on port ${PORT}. Stop it first (Ctrl+C in its window), then run restore again.`);

  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(OUT_DIR, '.restore-'));
  try {
    const r = spawnSync('tar', ['-xzf', src, '-C', tmp], { encoding: 'utf8' });
    if(r.status !== 0) die(`That file could not be unpacked: ${r.stderr || r.error}`);
    const files = readdirSync(tmp).filter(n => SAFE_NAME.test(n) && lstatSync(join(tmp, n)).isFile());
    for(const need of REQUIRED){
      if(!files.includes(need)) die(`${basename(src)} is not a rewards backup (no ${need}). Nothing was changed.`);
    }
    for(const n of files.filter(n => n.endsWith('.json'))){
      try { JSON.parse(readFileSync(join(tmp, n), 'utf8')); }
      catch(e){ die(`${n} in that backup is damaged (${e.message}). Nothing was changed.`); }
    }
    const members = JSON.parse(readFileSync(join(tmp, 'members.json'), 'utf8'));

    let safety = null;
    if(existsSync(DATA) && readdirSync(DATA).some(n => n.endsWith('.json'))) safety = backup('pre-restore');
    mkdirSync(DATA, { recursive: true, mode: 0o700 });
    for(const n of readdirSync(DATA)) if(lstatSync(join(DATA, n)).isFile()) rmSync(join(DATA, n));
    for(const n of files){ copyFileSync(join(tmp, n), join(DATA, n)); chmodSync(join(DATA, n), 0o600); }
    console.log(`\n  Restored ${basename(src)} into ${DATA} (${members.length} members).`);
    if(safety) console.log(`  What was there before is saved as ${safety}`);
    console.log('  Start the server again with:  npm start\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
if(argv[0] === '--restore'){
  await restore(argv.find((a, i) => i > 0 && !a.startsWith('--')), argv.includes('--force'));
} else {
  const out = backup();
  console.log(`\n  Backup written: ${out} (${Math.ceil(statSync(out).size / 1024)} KB)`);
  console.log('  Copy it somewhere off this computer too (USB stick, cloud drive).');
  console.log(`  It contains member details and the session secret: keep it private.\n`);
}
