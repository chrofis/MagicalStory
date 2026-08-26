/**
 * Grounded-SAM with FULL identity prompts (age+gender+hair+facial-hair+skin+
 * clothing) on all 5 figures of page 3, run twice:
 *   pass1 = positive only
 *   pass2 = positive + negative (clothing of everyone sharing gender OR age group)
 * Saves an overlay strip per (figure,pass) and a combined image per pass.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SP = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad';
const PAGE = path.join(SP, 'samfig-page.jpg');
const VERSION = 'ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c';

const FIGS = [
  { name: 'Emma',   color: [235,64,52],  pos: 'preschooler girl with brown hair, light skin, in a pink top and blue jeans',
    neg: 'yellow blouse, blue and white striped shirt' },
  { name: 'Noah',   color: [52,168,83],  pos: 'young boy with blonde hair, light skin, in a blue and white striped shirt and navy trousers',
    neg: 'green polo shirt, beige shirt, pink top' },
  { name: 'Daniel', color: [66,133,244], pos: 'adult man with dark brown hair and a short beard, light skin, in a green polo shirt',
    neg: 'blue and white striped shirt, beige shirt, yellow blouse' },
  { name: 'Sarah',  color: [244,180,0],  pos: 'adult woman with blonde hair and glasses, light skin, in a yellow blouse and grey trousers',
    neg: 'pink top, green polo shirt' },
  { name: 'Hans',   color: [171,71,188], pos: 'elderly man with white hair and a white mustache, fair skin, in a beige shirt',
    neg: 'blue and white striped shirt, green polo shirt' },
];

async function gsam(pageJpeg, pos, neg) {
  let pred;
  for (let a = 0; a < 14; a++) {
    const c = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: VERSION, input: { image: `data:image/jpeg;base64,${pageJpeg.toString('base64')}`, mask_prompt: pos, negative_mask_prompt: neg, adjustment_factor: 0 } }),
    });
    pred = await c.json();
    if (pred.id) break;
    if (String(pred.detail || '').includes('throttled')) { await new Promise(r => setTimeout(r, 20000)); continue; }
    throw new Error(JSON.stringify(pred).slice(0, 150));
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

// rough per-figure ground-truth centroid (from box-prompted run) to auto-judge
const TRUTH = { Emma: [21,72], Noah: [78,66], Daniel: [50,33], Sarah: [67,32], Hans: [64,12] }; // [x%,y%] approx

async function runPass(pageBuf, W, H, useNeg, label) {
  const n = W * H;
  const combo = Buffer.alloc(n * 4);
  const rows = [];
  for (const f of FIGS) {
    const neg = useNeg ? f.neg : '';
    process.stdout.write(`[${label}] ${f.name} ... `);
    let maskRaw, pct, cx, cy;
    try {
      const mb = await gsam(pageBuf, f.pos, neg);
      maskRaw = await sharp(mb).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
      let area = 0, sx = 0, sy = 0;
      for (let i = 0; i < n; i++) if (maskRaw[i] > 128) { area++; sx += i % W; sy += (i / W) | 0; }
      pct = (area / n * 100).toFixed(1);
      cx = area ? (sx / area) / W * 100 : -1;
      cy = area ? (sy / area) / H * 100 : -1;
      const [tx, ty] = TRUTH[f.name];
      const dist = area ? Math.hypot(cx - tx, cy - ty) : 999;
      const hit = area === 0 ? 'EMPTY' : dist < 15 ? 'CORRECT' : 'WRONG(' + [tx,ty] + ' vs ' + [cx.toFixed(0),cy.toFixed(0)] + ')';
      console.log(`${pct}% -> ${hit}`);
      rows.push({ name: f.name, pct, hit, neg });
    } catch (e) { console.log('FAIL', e.message); rows.push({ name: f.name, pct: 'fail', hit: 'fail' }); await new Promise(r=>setTimeout(r,3000)); continue; }
    const over = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) if (maskRaw[i] > 128) { over[i*4]=f.color[0];over[i*4+1]=f.color[1];over[i*4+2]=f.color[2];over[i*4+3]=120; if(combo[i*4+3]===0){combo[i*4]=f.color[0];combo[i*4+1]=f.color[1];combo[i*4+2]=f.color[2];combo[i*4+3]=130;} }
    const oimg = await sharp(pageBuf).composite([{ input: over, raw: { width: W, height: H, channels: 4 } }]).jpeg({ quality: 86 }).toBuffer();
    const h = Math.min(H, 440), w = Math.round(W*(h/H));
    const parts = await Promise.all([pageBuf, oimg].map(b => sharp(b).resize(w, h).toBuffer()));
    const strip = await sharp({ create: { width: w*2+8, height: h, channels: 3, background: 'white' } })
      .composite(parts.map((p,k)=>({ input: p, left: k*(w+8), top: 0 }))).jpeg({ quality: 86 }).toBuffer();
    fs.writeFileSync(path.join(SP, `full-${label}-${f.name}.jpg`), strip);
    await new Promise(r => setTimeout(r, 11000));
  }
  const comboImg = await sharp(pageBuf).composite([{ input: combo, raw: { width: W, height: H, channels: 4 } }]).jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(SP, `full-${label}-ALL.jpg`), comboImg);
  return rows;
}

(async () => {
  const pageBuf = fs.readFileSync(PAGE);
  const meta = await sharp(pageBuf).metadata();
  const W = meta.width, H = meta.height;
  const p1 = await runPass(pageBuf, W, H, false, 'pass1');
  const p2 = await runPass(pageBuf, W, H, true, 'pass2');
  fs.writeFileSync(path.join(SP, 'full-identity-results.json'), JSON.stringify({ pass1: p1, pass2: p2 }, null, 1));
  console.log('\n=== PASS 1 (positive only) ==='); p1.forEach(r => console.log(`  ${r.name}: ${r.pct}% ${r.hit}`));
  console.log('=== PASS 2 (+ same-group negatives) ==='); p2.forEach(r => console.log(`  ${r.name}: ${r.pct}% ${r.hit}`));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
