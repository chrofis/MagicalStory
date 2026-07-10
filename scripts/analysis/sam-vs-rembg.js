/**
 * SAM 2 (Replicate, everything-mode) vs rembg (local U2-Net) figure-silhouette
 * comparison on stored prod pages with known figure bboxes.
 *
 * For each (story, page, figure):
 *   - rembg: crop bodyBox+20% pad → /silhouette-edge (exactly how char-repair
 *     builds its blend silhouette today)
 *   - SAM 2: run once per page (auto mask generation), union all masks that
 *     sit ≥60% inside the padded bbox (approximates a box-prompted SAM)
 *   - save side-by-side composite: crop | rembg overlay (red) | SAM overlay (green)
 *
 * Usage: node scripts/analysis/sam-vs-rembg.js
 * Output: scripts/analysis/test-output/sam-vs-rembg/
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, 'test-output', 'sam-vs-rembg');
const PHOTO_ANALYZER_URL = 'http://127.0.0.1:5000';
const REPLICATE_VERSION = 'fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83';
const PAD = 0.2;

const STORIES = [
  'job_1783282609908_0l16joxsb', // Wer hilft, der findet
  'job_1783280541856_eujhh6z3e', // Der Zettel unter dem Schuh
  'job_1783261118182_iadh9sckj', // Die Schnitzeljagd durch die Altstadt
];
const MAX_SAMPLES = 10;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function replicateSam(imageUrl) {
  const create = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: REPLICATE_VERSION, input: { image: imageUrl } }),
  });
  let pred = await create.json();
  if (pred.error || !pred.id) throw new Error(`replicate create: ${pred.error || JSON.stringify(pred).slice(0, 200)}`);
  const t0 = Date.now();
  while (['starting', 'processing'].includes(pred.status)) {
    if (Date.now() - t0 > 300_000) throw new Error('replicate timeout');
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
    });
    pred = await res.json();
  }
  if (pred.status !== 'succeeded') throw new Error(`replicate ${pred.status}: ${pred.error}`);
  return pred.output; // { combined_mask, individual_masks: [urls] }
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${r.status} ${url.slice(0, 80)}`);
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
  return Buffer.from(m[1], 'base64'); // PNG, white figure on transparent
}

// Union SAM masks that sit ≥60% inside the padded bbox; returns full-page 1-channel raw mask
async function samUnionMask(maskUrls, W, H, rect) {
  const union = Buffer.alloc(W * H);
  let used = 0;
  for (const url of maskUrls) {
    const raw = await sharp(await fetchBuf(url)).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
    let area = 0, inside = 0;
    for (let i = 0; i < W * H; i++) {
      if (raw[i] > 128) {
        area++;
        const x = i % W, y = (i / W) | 0;
        if (x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height) inside++;
      }
    }
    if (area > 200 && inside / area >= 0.6 && area < W * H * 0.6) {
      for (let i = 0; i < W * H; i++) if (raw[i] > 128) union[i] = 255;
      used++;
    }
  }
  return { union, used };
}

async function overlay(cropJpeg, maskRaw1ch, w, h, rgb) {
  // mask as colored 40%-alpha layer on the crop
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (maskRaw1ch[i] > 128) {
      rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 110;
    }
  }
  return sharp(cropJpeg).composite([{ input: rgba, raw: { width: w, height: h, channels: 4 } }]).jpeg({ quality: 90 }).toBuffer();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 1. Collect samples
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
  // spread selection across the list
  const step = Math.max(1, Math.floor(samples.length / MAX_SAMPLES));
  const picked = samples.filter((_, i) => i % step === 0).slice(0, MAX_SAMPLES);
  console.log(`${samples.length} figures found, testing ${picked.length}`);

  const samCache = new Map(); // per page
  const results = [];
  for (const smp of picked) {
    const tag = `${smp.storyId.slice(-6)}-p${smp.pageNumber}-f${smp.fi}`;
    try {
      const img = await pool.query(
        'SELECT image_url, image_data FROM story_images WHERE story_id=$1 AND page_number=$2 ORDER BY version_index DESC LIMIT 1',
        [smp.storyId, smp.pageNumber]);
      if (!img.rows.length) { console.log(tag, 'no image row'); continue; }
      const { image_url, image_data } = img.rows[0];
      if (!image_url) { console.log(tag, 'no R2 url (skip — replicate needs a URL)'); continue; }
      const pageBuf = await fetchBuf(image_url);
      const meta = await sharp(pageBuf).metadata();
      const W = meta.width, H = meta.height;

      const [ymin, xmin, ymax, xmax] = smp.bodyBox;
      const padX = (xmax - xmin) * PAD, padY = (ymax - ymin) * PAD;
      const rect = {
        left: Math.max(0, Math.floor((xmin - padX) * W)),
        top: Math.max(0, Math.floor((ymin - padY) * H)),
      };
      rect.width = Math.min(W - rect.left, Math.ceil((xmax - xmin + 2 * padX) * W));
      rect.height = Math.min(H - rect.top, Math.ceil((ymax - ymin + 2 * padY) * H));

      const cropJpeg = await sharp(pageBuf).extract(rect).jpeg({ quality: 92 }).toBuffer();

      // rembg on the crop (prod-identical)
      const silPng = await rembgSilhouette(cropJpeg);
      let rembgMask = Buffer.alloc(rect.width * rect.height);
      if (silPng) {
        const a = await sharp(silPng).resize(rect.width, rect.height, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
        for (let i = 0; i < a.length; i++) if (a[i] > 128) rembgMask[i] = 255;
      }

      // SAM on the full page (cached per page)
      const pageKey = `${smp.storyId}:${smp.pageNumber}`;
      if (!samCache.has(pageKey)) {
        console.log(tag, 'running SAM 2 on Replicate...');
        samCache.set(pageKey, await replicateSam(image_url));
      }
      const samOut = samCache.get(pageKey);
      const maskUrls = samOut.individual_masks || [];
      const { union, used } = await samUnionMask(maskUrls, W, H, rect);
      // crop SAM union to rect
      const samMask = Buffer.alloc(rect.width * rect.height);
      for (let y = 0; y < rect.height; y++)
        for (let x = 0; x < rect.width; x++)
          samMask[y * rect.width + x] = union[(y + rect.top) * W + (x + rect.left)];

      // metrics
      const n = rect.width * rect.height;
      let aR = 0, aS = 0, inter = 0;
      for (let i = 0; i < n; i++) {
        const r = rembgMask[i] > 128, s2 = samMask[i] > 128;
        if (r) aR++;
        if (s2) aS++;
        if (r && s2) inter++;
      }
      const iou = inter / Math.max(1, aR + aS - inter);
      results.push({ tag, label: smp.label, rembgPct: (aR / n * 100).toFixed(1), samPct: (aS / n * 100).toFixed(1), iou: iou.toFixed(2), samMasksUsed: used, totalSamMasks: maskUrls.length });

      // composite: crop | rembg red | SAM green
      const [oR, oS] = await Promise.all([
        overlay(cropJpeg, rembgMask, rect.width, rect.height, [255, 40, 40]),
        overlay(cropJpeg, samMask, rect.width, rect.height, [40, 220, 40]),
      ]);
      const rowH = Math.min(rect.height, 480);
      const scale = rowH / rect.height;
      const rowW = Math.round(rect.width * scale);
      const parts = await Promise.all([cropJpeg, oR, oS].map(b => sharp(b).resize(rowW, rowH).toBuffer()));
      const strip = await sharp({ create: { width: rowW * 3 + 20, height: rowH, channels: 3, background: 'white' } })
        .composite(parts.map((p, i) => ({ input: p, left: i * (rowW + 10), top: 0 })))
        .jpeg({ quality: 88 }).toBuffer();
      fs.writeFileSync(path.join(OUT_DIR, `${tag}.jpg`), strip);
      console.log(tag, `done — rembg ${results.at(-1).rembgPct}% | SAM ${results.at(-1).samPct}% (${used}/${maskUrls.length} masks) | IoU ${results.at(-1).iou}`);
    } catch (e) {
      console.log(tag, 'FAILED:', e.message);
    }
  }

  console.log('\n=== SUMMARY (original | rembg=red | SAM=green in each strip) ===');
  for (const r of results) console.log(`${r.tag} | ${String(r.label).slice(0, 38).padEnd(38)} | rembg ${r.rembgPct}% | sam ${r.samPct}% (${r.samMasksUsed}/${r.totalSamMasks}) | IoU ${r.iou}`);
  console.log(`\nImages: ${OUT_DIR}`);
  await pool.end();
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
