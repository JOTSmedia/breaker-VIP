/* ============================================================
   ENV — loads settings from server/.env (or the file named by ENV_FILE)
   into process.env. Imported FIRST by everything else so settings like
   DATA_DIR are in place before the database opens.

   Real environment variables always win over the file, so a hosting
   dashboard (Render, Railway, Fly.io…) can override anything in it.
   ============================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : join(HERE, '.env');

export function parseEnv(text){
  const out = {};
  for(const raw of String(text).split('\n')){
    const line = raw.trim();
    if(!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if(i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

if(existsSync(ENV_FILE)){
  for(const [k, v] of Object.entries(parseEnv(readFileSync(ENV_FILE, 'utf8'))))
    if(!(k in process.env)) process.env[k] = v;
}
