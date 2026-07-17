#!/usr/bin/env node
/**
 * Validate face-point-guided MobileSAM (step 3 of the face-anchored detection
 * rework) on pages where the current GDINO(identity-prompt)->SAM path produced
 * bad bodyBoxes (Sarah collapsed to head-only, Hans sliver box).
 *
 * Per page:
 *   1. /detect-illustration-faces  -> precise local face boxes
 *   2. /detect-figures-text "person" (generic) -> all person boxes (best+candidates, NMS)
 *   3. per face: containing person box, then SAM three ways:
 *        A box-only            (current behaviour)
 *        B box + face point    (proposed)
 *        C face point only     (control)
 *   4. overlay each mask; write an HTML side-by-side report.
 *
 * Usage: node scripts/analysis/test-sam-face-point.js <storyId> <pages csv> [--staging]
 */
'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const PA = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
const OUT = path.join(require('os').tmpdir(), 'sam-face-point');

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
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter || 1);
};

// Decode a figure-mask PNG data-uri to a raw alpha bitmap + fill stats.
async function maskStats(dataUri, W, H) {
  const buf = Buffer.from(dataUri.split(',')[1], 'base64');
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, minX = info.width, minY = info.height, maxX = 0, maxY = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 128) {
      n++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { png: buf, fill: n, bbox: n ? [minX, minY, maxX + 1, maxY + 1] : null, w: info.width, h: info.height };
}

// Tint a white mask PNG to a colour and composite over the base image, plus box/point markers.
async function overlay(baseBuf, W, H, maskPng, color, box, point, label, outFile) {
  const layers = [];
  if (maskPng) {
    const tinted = await sharp(maskPng).ensureAlpha().tint(color).png().toBuffer();
    const half = await sharp(tinted).composite([{ input: Buffer.from([255, 255, 255, 140]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }]).png().toBuffer();
    layers.push({ input: half });
  }
  let svg = '';
  if (box) svg += `<rect x="${box[0]}" y="${box[1]}" width="${box[2] - box[0]}" height="${box[3] - box[1]}" fill="none" stroke="#0A84FF" stroke-width="4"/>`;
  if (point) svg += `<circle cx="${point[0]}" cy="${point[1]}" r="10" fill="#FF2D55" stroke="white" stroke-width="3"/>`;
  svg += `<text x="12" y="34" font-size="28" font-family="sans-serif" fill="white" stroke="black" stroke-width="1">${label}</text>`;
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`) });
  await sharp(baseBuf).composite(layers).jpeg({ quality: 88 }).toFile(outFile);
}

async function main() {
  const [storyId, pageCsv, ...flags] = process.argv.slice(2);
  if (!storyId || !pageCsv) { console.error('usage: test-sam-face-point.js <storyId> <pages csv> [--staging]'); process.exit(1); }
  const staging = flags.includes('--staging');
  const pool = new Pool({ connectionString: staging ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  fs.mkdirSync(OUT, { recursive: true });
  const pages = pageCsv.split(',').map(Number);

  const imgRes = await pool.query(
    "SELECT page_number, image_url FROM story_images WHERE story_id=$1 AND image_type='scene' AND page_number = ANY($2) ORDER BY page_number, version_index ASC", [storyId, pages]);
  const urlByPage = new Map();
  for (const r of imgRes.rows) if (!urlByPage.has(r.page_number)) urlByPage.set(r.page_number, r.image_url); // version 0 = what detection saw
  await pool.end();

  const htmlCells = [];
  for (const pn of pages) {
    const url = urlByPage.get(pn);
    if (!url) { console.log(`p${pn}: no image`); continue; }
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const meta = await sharp(buf).metadata();
    const W = meta.width, H = meta.height;
    const b64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
    console.log(`\n=== p${pn} (${W}x${H}) ===`);

    // 1 — faces
    const faceRes = await pa('/detect-illustration-faces', { image: b64 });
    const faces = (faceRes.faces || []).map(f => {
      const bx = f.faceBox || f.box || f;
      return { x: bx.x, y: bx.y, w: bx.width, h: bx.height, conf: `${f.source || '?'}:${f.confidence ?? '?'}` };
    });
    console.log(`faces: ${faces.length}`, faces.map(f => `(${f.x},${f.y} ${f.w}x${f.h} ${f.conf})`).join(' '));

    // 2 — generic person boxes from GDINO
    const det = await pa('/detect-figures-text', {
      image: b64, prompts: [{ name: 'person', text: 'person' }],
      box_threshold: 0.20, text_threshold: 0.15,
    });
    const pf = (det.figures || [])[0] || {};
    let personBoxes = [];
    if (pf.box) personBoxes.push({ box: pf.box, score: pf.score });
    for (const c of (pf.candidates || [])) if (c.box) personBoxes.push({ box: c.box, score: c.score });
    // NMS dedupe
    personBoxes.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const p of personBoxes) if (!kept.some(k => iou(k.box, p.box) > 0.5)) kept.push(p);
    console.log(`person boxes: ${kept.length}`, kept.map(k => `[${k.box.map(Math.round)}] ${k.score.toFixed(2)}`).join(' '));

    // 3 — per face: containing person box + SAM variants
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      const containing = kept.filter(k => cx >= k.box[0] && cx <= k.box[2] && cy >= k.box[1] && cy <= k.box[3])
        .sort((a, b) => ((a.box[2] - a.box[0]) * (a.box[3] - a.box[1])) - ((b.box[2] - b.box[0]) * (b.box[3] - b.box[1])));
      const pbox = containing[0]?.box || null;
      const point = [Math.round(cx), Math.round(cy)];
      console.log(`\nface#${fi} center=(${point}) personBox=${pbox ? `[${pbox.map(Math.round)}]` : 'NONE'}`);

      const variants = [];
      if (pbox) variants.push({ tag: 'A box-only', body: { image: b64, box: pbox } });
      if (pbox) variants.push({ tag: 'B box+point', body: { image: b64, box: pbox, points: [point], point_labels: [1] } });
      variants.push({ tag: 'C point-only', body: { image: b64, points: [point], point_labels: [1] } });

      const row = { page: pn, face: fi, cells: [] };
      for (const v of variants) {
        let stats = null, err = null;
        try {
          const r = await pa('/figure-mask', v.body);
          stats = await maskStats(r.image, W, H);
        } catch (e) { err = e.message; }
        const tagFs = v.tag.replace(/[^a-z0-9]+/gi, '_');
        const outFile = path.join(OUT, `p${pn}_face${fi}_${tagFs}.jpg`);
        if (stats) await overlay(buf, W, H, stats.png, '#00c853', v.body.box || null, point, `p${pn} f${fi} ${v.tag} fill=${stats.fill}`, outFile);
        else await overlay(buf, W, H, null, null, v.body.box || null, point, `p${pn} f${fi} ${v.tag} ERR`, outFile);
        const fillPct = stats ? (100 * stats.fill / (W * H)).toFixed(1) : '—';
        const mb = stats?.bbox ? stats.bbox.map(Math.round).join(',') : '—';
        console.log(`  ${v.tag.padEnd(12)} fill=${fillPct}% maskBox=[${mb}] ${err || ''}`);
        row.cells.push({ file: path.basename(outFile), tag: v.tag, fillPct, err });
      }
      htmlCells.push(row);
    }
  }

  // 4 — HTML report
  const html = `<!doctype html><meta charset="utf-8"><title>SAM face-point test</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;margin:16px}h2{margin:24px 0 8px}
.row{display:flex;gap:8px;margin-bottom:20px}.cell{flex:1}img{width:100%;border-radius:6px}
.cap{font-size:13px;padding:4px 2px;color:#9fe}</style>
<h1>MobileSAM: box-only vs box+face-point vs point-only</h1>
${htmlCells.map(r => `<h2>page ${r.page} · face ${r.face}</h2><div class="row">${r.cells.map(c =>
  `<div class="cell"><img src="${c.file}"><div class="cap">${c.tag} · fill ${c.fillPct}% ${c.err ? '· ERROR ' + c.err : ''}</div></div>`).join('')}</div>`).join('\n')}`;
  fs.writeFileSync(path.join(OUT, 'report.html'), html);
  console.log(`\nreport -> ${path.join(OUT, 'report.html')}`);
}
main().catch(e => { console.error(e); process.exit(1); });
