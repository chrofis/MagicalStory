/**
 * Round 2: Grounded-SAM (text-prompted, schananas/grounded_sam on Replicate)
 * vs rembg on the same 10 stored figures as sam-vs-rembg.js.
 *
 * Prompt = the figure's stored label ("boy in orange shirt...") when it looks
 * like a real phrase, else "person". Model runs on the bbox+20% crop.
 * Strips: crop | rembg (red) | Grounded-SAM (blue).
 *
 * Usage: node scripts/analysis/grounded-sam-vs-rembg.js
 * Output: scripts/analysis/test-output/sam-vs-rembg/round2-*.jpg
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, 'test-output', 'sam-vs-rembg');
const PHOTO_ANALYZER_URL = 'http://127.0.0.1:5000';
const GROUNDED_SAM_VERSION = 'ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c';
const PAD = 0.2;
const STORIES = [
  'job_1783282609908_0l16joxsb',
  'job_1783280541856_eujhh6z3e',
  'job_1783261118182_iadh9sckj',
];
const MAX_SAMPLES = 10;
const JUNK_LABELS = new Set(['character', 'description', 'no face', 'figure', 'person', 'unknown']);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function promptFor(label) {
  const l = String(label || '').trim();
  if (l.length > 10 && l.includes(' ') && !JUNK_LABELS.has(l.toLowerCase())) return l;
  return 'person';
}

async function groundedSam(cropJpeg, prompt) {
  // Low-credit accounts are throttled to 6 predictions/min, burst 1 — retry
  // creation with a backoff instead of failing the sample.
  let pred;
  for (let attempt = 0; attempt < 8; attempt++) {
    const create = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: GROUNDED_SAM_VERSION,
        input: { image: `data:image/jpeg;base64,${cropJpeg.toString('base64')}`, mask_prompt: prompt, negative_mask_prompt: '', adjustment_factor: 0 },
      }),
    });
    pred = await create.json();
    if (pred.id) break;
    if (String(pred.detail || '').includes('throttled')) {
      await new Promise(r => setTimeout(r, 20_000));
      continue;
    }
    throw new Error(`create: ${JSON.stringify(pred).slice(0, 200)}`);
  }
  if (!pred?.id) throw new Error('create: still throttled after retries');
  const t0 = Date.now();
  while (['starting', 'processing'].includes(pred.status)) {
    if (Date.now() - t0 > 300_000) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 3000));
    pred = await (await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
    })).json();
  }
  if (pred.status !== 'succeeded') throw new Error(`${pred.status}: ${pred.error}`);
  // outputs: [annotated, neg_annotated, mask, inverted_mask]
  return pred.output[2];
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function rembgSilhouette(cropJpeg) {
  const res = await fetch(`${PHOTO_ANALYZER_URL}/silhouette-edge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: `data:image/jpeg;base64,${cropJpeg.toString('base64')}`, color: [255, 255, 255], alpha: 255 }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json();
  const m = j?.image?.match?.(/^data:image\/\w+;base64,(.+)$/);
  if (!j?.success || !m) return null;
  return Buffer.from(m[1], 'base64');
}

async function overlay(cropJpeg, mask, w, h, rgb) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (mask[i] > 128) {
      rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 110;
    }
  }
  return sharp(cropJpeg).composite([{ input: rgba, raw: { width: w, height: h, channels: 4 } }]).jpeg({ quality: 90 }).toBuffer();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const samples = [];
  for (const storyId of STORIES) {
    const s = await pool.query("SELECT data->'sceneImages' as si FROM stories WHERE id=$1", [storyId]);
    if (!s.rows.length) continue;
    for (const page of s.rows[0].si || []) {
      const figs = page?.bboxDetection?.figures || [];
      for (let fi = 0; fi < Math.min(figs.length, 2); fi++) {
        if (figs[fi].bodyBox) samples.push({ storyId, pageNumber: page.pageNumber, fi, bodyBox: figs[fi].bodyBox, label: figs[fi].label });
      }
    }
  }
  const step = Math.max(1, Math.floor(samples.length / MAX_SAMPLES));
  const picked = samples.filter((_, i) => i % step === 0).slice(0, MAX_SAMPLES);
  console.log(`${samples.length} figures found, testing ${picked.length}`);

  const results = [];
  for (const smp of picked) {
    const tag = `${smp.storyId.slice(-6)}-p${smp.pageNumber}-f${smp.fi}`;
    if (fs.existsSync(path.join(OUT_DIR, `round2-${tag}.jpg`))) { console.log(tag, 'already done, skipping'); continue; }
    try {
      const img = await pool.query(
        'SELECT image_url FROM story_images WHERE story_id=$1 AND page_number=$2 ORDER BY version_index DESC LIMIT 1',
        [smp.storyId, smp.pageNumber]);
      if (!img.rows[0]?.image_url) { console.log(tag, 'no R2 url'); continue; }
      const pageBuf = await fetchBuf(img.rows[0].image_url);
      const meta = await sharp(pageBuf).metadata();
      const W = meta.width, H = meta.height;
      const [ymin, xmin, ymax, xmax] = smp.bodyBox;
      const padX = (xmax - xmin) * PAD, padY = (ymax - ymin) * PAD;
      const rect = { left: Math.max(0, Math.floor((xmin - padX) * W)), top: Math.max(0, Math.floor((ymin - padY) * H)) };
      rect.width = Math.min(W - rect.left, Math.ceil((xmax - xmin + 2 * padX) * W));
      rect.height = Math.min(H - rect.top, Math.ceil((ymax - ymin + 2 * padY) * H));
      const cropJpeg = await sharp(pageBuf).extract(rect).jpeg({ quality: 92 }).toBuffer();
      const n = rect.width * rect.height;

      // rembg
      const silPng = await rembgSilhouette(cropJpeg);
      const rembgMask = Buffer.alloc(n);
      if (silPng) {
        const a = await sharp(silPng).resize(rect.width, rect.height, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
        for (let i = 0; i < n; i++) if (a[i] > 128) rembgMask[i] = 255;
      }

      // grounded-sam
      const prompt = promptFor(smp.label);
      console.log(tag, `grounded_sam prompt: "${prompt}" ...`);
      const maskUrl = await groundedSam(cropJpeg, prompt);
      const gMaskRaw = await sharp(await fetchBuf(maskUrl)).resize(rect.width, rect.height, { fit: 'fill' }).greyscale().raw().toBuffer();
      const gMask = Buffer.alloc(n);
      for (let i = 0; i < n; i++) if (gMaskRaw[i] > 128) gMask[i] = 255;

      // metrics
      let aR = 0, aG = 0, inter = 0;
      for (let i = 0; i < n; i++) {
        const r = rembgMask[i] > 128, g = gMask[i] > 128;
        if (r) aR++;
        if (g) aG++;
        if (r && g) inter++;
      }
      const iou = inter / Math.max(1, aR + aG - inter);
      results.push({ tag, prompt, rembgPct: (aR / n * 100).toFixed(1), gPct: (aG / n * 100).toFixed(1), iou: iou.toFixed(2) });

      const [oR, oG] = await Promise.all([
        overlay(cropJpeg, rembgMask, rect.width, rect.height, [255, 40, 40]),
        overlay(cropJpeg, gMask, rect.width, rect.height, [50, 110, 255]),
      ]);
      const rowH = Math.min(rect.height, 480);
      const rowW = Math.round(rect.width * (rowH / rect.height));
      const parts = await Promise.all([cropJpeg, oR, oG].map(b => sharp(b).resize(rowW, rowH).toBuffer()));
      const strip = await sharp({ create: { width: rowW * 3 + 20, height: rowH, channels: 3, background: 'white' } })
        .composite(parts.map((p, i) => ({ input: p, left: i * (rowW + 10), top: 0 })))
        .jpeg({ quality: 88 }).toBuffer();
      fs.writeFileSync(path.join(OUT_DIR, `round2-${tag}.jpg`), strip);
      console.log(tag, `done — rembg ${results.at(-1).rembgPct}% | grounded ${results.at(-1).gPct}% | IoU ${results.at(-1).iou}`);
    } catch (e) {
      console.log(tag, 'FAILED:', e.message);
    }
  }
  console.log('\n=== ROUND 2 SUMMARY (crop | rembg=red | grounded-SAM=blue) ===');
  for (const r of results) console.log(`${r.tag} | "${r.prompt.slice(0, 36)}" | rembg ${r.rembgPct}% | grounded ${r.gPct}% | IoU ${r.iou}`);
  await pool.end();
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
