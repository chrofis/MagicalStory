/**
 * Chase the occluded figure (Hans) with several Grounded-SAM prompt variants,
 * including negative prompts that push the detector away from Daniel (the
 * salient foreground man it wrongly grabbed). One overlay strip per variant.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SP = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad';
const PAGE = path.join(SP, 'samfig-page.jpg');
const VERSION = 'ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c';

// Hans is the white-haired grandfather at the BACK, occluded behind Daniel
// (green polo) and Sarah (yellow). Variants escalate specificity + negatives.
const VARIANTS = [
  { tag: 'A_grandfather',      pos: 'grandfather',                     neg: '' },
  { tag: 'B_whitehair',        pos: 'man with white hair',             neg: '' },
  { tag: 'C_neg_daniel',       pos: 'elderly man with white mustache', neg: 'man in green polo shirt' },
  { tag: 'D_neg_young',        pos: 'old man with grey hair',          neg: 'young man, dark hair' },
  { tag: 'E_behind',           pos: 'old man behind the others',       neg: '' },
  { tag: 'F_neg_both',         pos: 'grey haired old man',             neg: 'green polo, yellow blouse, dark hair man' },
];

async function groundedSam(pageJpeg, pos, neg) {
  let pred;
  for (let a = 0; a < 12; a++) {
    const c = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: VERSION, input: { image: `data:image/jpeg;base64,${pageJpeg.toString('base64')}`, mask_prompt: pos, negative_mask_prompt: neg, adjustment_factor: 0 } }),
    });
    pred = await c.json();
    if (pred.id) break;
    if (String(pred.detail || '').includes('throttled')) { await new Promise(r => setTimeout(r, 20000)); continue; }
    throw new Error(JSON.stringify(pred).slice(0, 160));
  }
  const t0 = Date.now();
  while (['starting', 'processing'].includes(pred.status)) {
    if (Date.now() - t0 > 240000) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 3000));
    pred = await (await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` } })).json();
  }
  if (pred.status !== 'succeeded') throw new Error(`${pred.status}: ${pred.error}`);
  return Buffer.from(await (await fetch(pred.output[2])).arrayBuffer());
}

(async () => {
  const pageBuf = fs.readFileSync(PAGE);
  const meta = await sharp(pageBuf).metadata();
  const W = meta.width, H = meta.height, n = W * H;
  const results = [];
  for (const v of VARIANTS) {
    process.stdout.write(`${v.tag}: pos="${v.pos}"${v.neg ? ` neg="${v.neg}"` : ''} ... `);
    let maskRaw, pct, cx, cy;
    try {
      const maskBuf = await groundedSam(pageBuf, v.pos, v.neg);
      maskRaw = await sharp(maskBuf).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
      let area = 0, sx = 0, sy = 0;
      for (let i = 0; i < n; i++) if (maskRaw[i] > 128) { area++; sx += i % W; sy += (i / W) | 0; }
      pct = (area / n * 100).toFixed(1);
      cx = area ? ((sx / area) / W * 100).toFixed(0) : '-';
      cy = area ? ((sy / area) / H * 100).toFixed(0) : '-';
      // Hans's head is top-center-right (~y<25%, x 55-80%). Daniel centre (~y 35%, x 45-60%).
      const guess = area === 0 ? 'EMPTY' : (cy < 28 ? 'HANS-ish (top)' : cy > 30 && cx < 62 ? 'DANIEL-ish (centre)' : '?');
      console.log(`${pct}% centroid(${cx},${cy}) -> ${guess}`);
      results.push({ ...v, pct, cx, cy, guess });
    } catch (e) { console.log('FAIL', e.message); results.push({ ...v, pct: 'fail' }); await new Promise(r=>setTimeout(r,3000)); continue; }
    const over = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) if (maskRaw[i] > 128) { over[i*4]=171; over[i*4+1]=71; over[i*4+2]=188; over[i*4+3]=125; }
    const overImg = await sharp(pageBuf).composite([{ input: over, raw: { width: W, height: H, channels: 4 } }]).jpeg({ quality: 86 }).toBuffer();
    const h = Math.min(H, 460), w = Math.round(W*(h/H));
    const parts = await Promise.all([pageBuf, overImg].map(b => sharp(b).resize(w, h).toBuffer()));
    const strip = await sharp({ create: { width: w*2+8, height: h, channels: 3, background: 'white' } })
      .composite(parts.map((p,k)=>({ input: p, left: k*(w+8), top: 0 }))).jpeg({ quality: 86 }).toBuffer();
    fs.writeFileSync(path.join(SP, `hans-${v.tag}.jpg`), strip);
    await new Promise(r => setTimeout(r, 11000));
  }
  fs.writeFileSync(path.join(SP, 'hans-variants.json'), JSON.stringify(results, null, 1));
  console.log('\n=== summary ===');
  for (const r of results) console.log(`${r.tag}: "${r.pos}"${r.neg?` / NOT "${r.neg}"`:''} -> ${r.pct}% ${r.guess||''}`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
