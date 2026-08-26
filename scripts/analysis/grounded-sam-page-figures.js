/**
 * Text-prompted Grounded-SAM (Replicate) on the FULL page — find each figure
 * by its clothing description, no bbox supplied. Tests whether the story's
 * stored clothing is a good enough prompt to locate each character.
 * Overlay per character + a combined image.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SP = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad';
const PAGE = path.join(SP, 'samfig-page.jpg');
const VERSION = 'ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c';

// Prompt formula: [visual-age] [gender-noun] in [distinctive garment+colour].
// Age + gender from story characters, clothing from clothingRequirements
// (page3 = standard). Age/gender disambiguate the two kids from the two
// adults from the elder; clothing colour picks between same-age-and-gender.
const FIGS = [
  { name: 'Emma',   prompt: 'young girl in pink shirt',                 color: [235,64,52] },
  { name: 'Noah',   prompt: 'young boy in blue and white striped shirt', color: [52,168,83] },
  { name: 'Daniel', prompt: 'adult man in green polo shirt',            color: [66,133,244] },
  { name: 'Sarah',  prompt: 'adult woman in yellow blouse',             color: [244,180,0] },
  { name: 'Hans',   prompt: 'elderly man with white mustache',          color: [171,71,188] },
];

async function groundedSam(pageJpeg, prompt) {
  let pred;
  for (let a = 0; a < 10; a++) {
    const c = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: VERSION, input: { image: `data:image/jpeg;base64,${pageJpeg.toString('base64')}`, mask_prompt: prompt, negative_mask_prompt: '', adjustment_factor: 0 } }),
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
  return Buffer.from(await (await fetch(pred.output[2])).arrayBuffer()); // slot 2 = raw mask
}

(async () => {
  const pageBuf = fs.readFileSync(PAGE);
  const meta = await sharp(pageBuf).metadata();
  const W = meta.width, H = meta.height, n = W * H;
  const comboRGBA = Buffer.alloc(n * 4);
  const summary = [];
  for (const f of FIGS) {
    process.stdout.write(`${f.name} ("${f.prompt}") ... `);
    let maskRaw, pct;
    try {
      const maskBuf = await groundedSam(pageBuf, f.prompt);
      maskRaw = await sharp(maskBuf).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
      let area = 0; for (let i = 0; i < n; i++) if (maskRaw[i] > 128) area++;
      pct = (area / n * 100).toFixed(1);
      console.log(`${pct}%`);
    } catch (e) { console.log('FAIL', e.message); summary.push({ ...f, pct: 'fail' }); continue; }
    summary.push({ ...f, pct });
    const over = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) if (maskRaw[i] > 128) { over[i*4]=f.color[0]; over[i*4+1]=f.color[1]; over[i*4+2]=f.color[2]; over[i*4+3]=120; if (comboRGBA[i*4+3]===0){comboRGBA[i*4]=f.color[0];comboRGBA[i*4+1]=f.color[1];comboRGBA[i*4+2]=f.color[2];comboRGBA[i*4+3]=130;} }
    const overImg = await sharp(pageBuf).composite([{ input: over, raw: { width: W, height: H, channels: 4 } }]).jpeg({ quality: 88 }).toBuffer();
    const h = Math.min(H, 520), w = Math.round(W*(h/H));
    const parts = await Promise.all([pageBuf, overImg].map(b => sharp(b).resize(w, h).toBuffer()));
    const strip = await sharp({ create: { width: w*2+10, height: h, channels: 3, background: 'white' } })
      .composite(parts.map((p,k)=>({ input: p, left: k*(w+10), top: 0 }))).jpeg({ quality: 88 }).toBuffer();
    fs.writeFileSync(path.join(SP, `gsamfig-${f.name}.jpg`), strip);
    await new Promise(r => setTimeout(r, 11000)); // throttle spacing
  }
  const combo = await sharp(pageBuf).composite([{ input: comboRGBA, raw: { width: W, height: H, channels: 4 } }]).jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(SP, 'gsamfig-ALL.jpg'), combo);
  fs.writeFileSync(path.join(SP, 'gsamfig-summary.json'), JSON.stringify(summary));
  console.log('\nsaved gsamfig-ALL.jpg + per-figure strips');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
