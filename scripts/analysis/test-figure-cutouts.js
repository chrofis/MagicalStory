#!/usr/bin/env node
/**
 * Full-page figure extraction demo: generic DINO "person" boxes -> MobileSAM
 * mask per box -> per-figure cutout PNGs + one background image with every
 * figure removed. HTML report: original | cutouts | background-without-figures.
 *
 * Usage: node scripts/analysis/test-figure-cutouts.js <storyId> <pages csv> [--staging]
 */
'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const PA = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
const OUT = path.join(require('os').tmpdir(), 'figure-cutouts');

async function pa(endpoint, body) {
  const res = await fetch(`${PA}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
  });
  const j = await res.json();
  if (!j.success) throw new Error(`${endpoint} ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter || 1);
};

async function main() {
  const [storyId, pageCsv, ...flags] = process.argv.slice(2);
  if (!storyId || !pageCsv) { console.error('usage: test-figure-cutouts.js <storyId> <pages csv> [--staging]'); process.exit(1); }
  const staging = flags.includes('--staging');
  const label = (flags.find(f => f.startsWith('--label=')) || '--label=run').split('=')[1];
  const pool = new Pool({ connectionString: staging ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  fs.mkdirSync(OUT, { recursive: true });
  const pages = pageCsv.split(',').map(Number);

  const imgRes = await pool.query(
    "SELECT page_number, image_url FROM story_images WHERE story_id=$1 AND image_type='scene' AND page_number = ANY($2) ORDER BY page_number, version_index ASC", [storyId, pages]);
  const urlByPage = new Map();
  for (const r of imgRes.rows) if (!urlByPage.has(r.page_number)) urlByPage.set(r.page_number, r.image_url);
  await pool.end();

  const sections = [];
  for (const pn of pages) {
    const url = urlByPage.get(pn);
    if (!url) { console.log(`p${pn}: no image`); continue; }
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const meta = await sharp(buf).metadata();
    const W = meta.width, H = meta.height;
    const b64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
    console.log(`\n=== p${pn} (${W}x${H}) ===`);

    // 1 — all person boxes (generic prompt, best + candidates, NMS)
    const det = await pa('/detect-figures-text', {
      image: b64, prompts: [{ name: 'person', text: 'person' }],
      box_threshold: 0.20, text_threshold: 0.15,
    });
    const pf = (det.figures || [])[0] || {};
    let boxes = [];
    if (pf.box) boxes.push({ box: pf.box, score: pf.score });
    for (const c of (pf.candidates || [])) if (c.box) boxes.push({ box: c.box, score: c.score });
    boxes.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const p of boxes) if (!kept.some(k => iou(k.box, p.box) > 0.5)) kept.push(p);
    console.log(`person boxes: ${kept.length}`);

    // 1b — DINO faces too (no Haar): generic "face" prompt, best + candidates, NMS
    const fdet = await pa('/detect-figures-text', {
      image: b64, prompts: [{ name: 'face', text: 'face' }],
      box_threshold: 0.20, text_threshold: 0.15,
    });
    const ff = (fdet.figures || [])[0] || {};
    let fboxes = [];
    if (ff.box) fboxes.push({ box: ff.box, score: ff.score });
    for (const c of (ff.candidates || [])) if (c.box) fboxes.push({ box: c.box, score: c.score });
    fboxes.sort((a, b) => b.score - a.score);
    const faces = [];
    for (const p of fboxes) if (!faces.some(k => iou(k.box, p.box) > 0.4)) faces.push(p);
    console.log(`DINO face boxes: ${faces.length}`, faces.map(f => `[${f.box.map(Math.round)}] ${f.score.toFixed(2)}`).join(' '));

    // original + annotated (person boxes blue-ish palette, DINO face dots red)
    const origFile = `${label}_p${pn}_0_original.jpg`;
    fs.writeFileSync(path.join(OUT, origFile), buf);
    const palette = ['#FF9F0A', '#34C759', '#0A84FF', '#AF52DE', '#5AC8FA'];
    let annSvg = '';
    kept.forEach((k, i) => { const [x1, y1, x2, y2] = k.box; const c = palette[i % palette.length];
      annSvg += `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${c}" stroke-width="5"/><text x="${x1 + 6}" y="${y1 + 30}" font-size="26" font-family="sans-serif" fill="${c}" stroke="black" stroke-width="0.5">#${i} ${k.score.toFixed(2)}</text>`; });
    faces.forEach(f => { const cx = (f.box[0] + f.box[2]) / 2, cy = (f.box[1] + f.box[3]) / 2;
      annSvg += `<circle cx="${cx}" cy="${cy}" r="11" fill="#FF2D55" stroke="white" stroke-width="3"/><text x="${cx + 14}" y="${cy + 6}" font-size="20" font-family="sans-serif" fill="#FF2D55" stroke="black" stroke-width="0.5">${f.score.toFixed(2)}</text>`; });
    const annFile = `${label}_p${pn}_1_annotated.jpg`;
    await sharp(buf).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${annSvg}</svg>`) }]).jpeg({ quality: 88 }).toFile(path.join(OUT, annFile));

    // 2 — SAM mask per box -> cutout; accumulate union for background removal
    const cutFiles = [];
    let unionMask = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      const r = await pa('/figure-mask', { image: b64, box: k.box });
      const maskPng = Buffer.from(r.image.split(',')[1], 'base64'); // white where figure, alpha 255
      // cutout = original pixels where mask (dest-in)
      const cutout = await sharp(buf).ensureAlpha()
        .composite([{ input: maskPng, blend: 'dest-in' }])
        .png().toBuffer();
      // trim to the mask bbox for display
      const [x1, y1, x2, y2] = k.box.map(Math.round);
      const pad = 20;
      const ex = Math.max(0, x1 - pad), ey = Math.max(0, y1 - pad);
      const ew = Math.min(W, x2 + pad) - ex, eh = Math.min(H, y2 + pad) - ey;
      const cutFile = `${label}_p${pn}_fig${i}_cutout.png`;
      await sharp(cutout).extract({ left: ex, top: ey, width: ew, height: eh }).png().toFile(path.join(OUT, cutFile));
      cutFiles.push({ file: cutFile, score: k.score, fill: r.fill_pixels });
      console.log(`  fig#${i} box=[${k.box.map(Math.round)}] score=${k.score.toFixed(2)} fill=${r.fill_pixels}px`);
      // grow union
      unionMask = await sharp(unionMask).composite([{ input: maskPng, blend: 'over' }]).png().toBuffer();
    }

    // 3 — background = original with union mask punched out (dest-out), over checkerboard
    const noFigs = await sharp(buf).ensureAlpha()
      .composite([{ input: unionMask, blend: 'dest-out' }])
      .png().toBuffer();
    const bgFile = `${label}_p${pn}_9_background_no_figures.png`;
    await sharp(noFigs).png().toFile(path.join(OUT, bgFile));

    sections.push({ pn, origFile, annFile, cutFiles, bgFile, n: kept.length, nFaces: faces.length });
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Figure cutouts</title>
<style>body{font-family:sans-serif;background:#181818;color:#eee;margin:16px}
h2{margin:28px 0 10px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start}
.cell{background:#222;border-radius:8px;padding:6px;max-width:340px}
.cell img{width:100%;border-radius:6px;background:
  repeating-conic-gradient(#666 0% 25%, #999 0% 50%) 0 0/24px 24px}
.cap{font-size:13px;color:#9fe;padding:4px 2px}</style>
<h1>DINO "person" &rarr; MobileSAM: per-figure cutouts + emptied background</h1>
${sections.map(s => `<h2>page ${s.pn} — ${s.n} figures · ${s.nFaces} DINO faces</h2><div class="row">
<div class="cell"><img src="${s.origFile}"><div class="cap">original</div></div>
<div class="cell"><img src="${s.annFile}"><div class="cap">DINO person boxes + DINO face dots (red)</div></div>
${s.cutFiles.map((c, i) => `<div class="cell"><img src="${c.file}"><div class="cap">figure #${i} · score ${c.score.toFixed(2)} · ${c.fill}px</div></div>`).join('')}
<div class="cell"><img src="${s.bgFile}"><div class="cap">background — all figures removed</div></div>
</div>`).join('\n')}`;
  fs.writeFileSync(path.join(OUT, `report_${label}.html`), html);
  console.log(`\nreport -> ${path.join(OUT, 'report.html')}`);
}
main().catch(e => { console.error(e); process.exit(1); });
