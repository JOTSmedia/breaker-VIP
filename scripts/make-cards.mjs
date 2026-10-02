#!/usr/bin/env node
/* ============================================================
   npm run cards -- --from 51 --count 50

   Makes a print-ready PDF of card BACKS for new card numbers, laid out
   exactly like the printed moo_card_backs_BB0001-0050.pdf: same page size
   (3.5" x 2" plus bleed), same hairline frame, the number in Courier-Bold
   30pt, centred. The FRONT is identical on every card, so reuse any page of
   moo_card_fronts_BB0001-0050.pdf for the fronts.

   Before printing, add the same numbers to the system:
   admin.html → Cards → Mint A Batch (it hands out the next free numbers).

   Output goes to generated_cards/. The original moo_card_* files are never
   touched.
   Options: --from N (default 51)  --count N (default 50)  --out file.pdf  --overwrite
   ============================================================ */
import PDFDocument from 'pdfkit';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const pad = n => String(n).padStart(4, '0');

const from = parseInt(opt('--from') ?? '51', 10);
const count = parseInt(opt('--count') ?? '50', 10);
if(!(from >= 1) || !(count >= 1) || count > 1000 || from + count - 1 > 9999){
  console.error('Use --from 1..9999 and --count 1..1000'); process.exit(1);
}
const to = from + count - 1;
const out = resolve(opt('--out') || join(ROOT, 'generated_cards', `card_backs_BB${pad(from)}-BB${pad(to)}.pdf`));
if(basename(out).startsWith('moo_card_')){ console.error('Refusing to overwrite the original printed card files.'); process.exit(1); }
if(existsSync(out) && !argv.includes('--overwrite')){ console.error(`${out} already exists (add --overwrite to replace it).`); process.exit(1); }
mkdirSync(dirname(out), { recursive: true });

/* measurements copied from the printed backs PDF */
const W = 263.52, H = 155.52;
const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false,
  info: { Title: `Breaker Billiards card backs ${pad(from)}-${pad(to)}` } });
const done = new Promise((ok, bad) => { const s = createWriteStream(out); s.on('finish', ok).on('error', bad); doc.pipe(s); });

for(let n = from; n <= to; n++){
  doc.addPage({ size: [W, H], margin: 0 });
  doc.rect(0, 0, W, H).fill('#FFFFFF');
  doc.rect(11.76, 11.76, 240, 132).lineWidth(0.4).stroke('#000000');
  const label = pad(n);
  doc.font('Courier-Bold').fontSize(30).fillColor('#000000');
  const w = doc.widthOfString(label, { characterSpacing: 6 });
  /* the printed file centres the number including the spacing after the last digit */
  doc.text(label, (W - w - 6) / 2, 57.76, { characterSpacing: 6, lineBreak: false });
}
doc.end();
await done;

console.log(`Wrote ${count} card back${count === 1 ? '' : 's'} (${pad(from)} to ${pad(to)}) to ${out}`);
if(from <= 50) console.log('Note: 0001–0050 were already printed — only reprint those to replace a damaged card.');
console.log('Fronts: reuse any page of moo_card_fronts_BB0001-0050.pdf (every front is the same).');
console.log('Remember: mint the same numbers in admin.html → Cards before handing the cards out.');
