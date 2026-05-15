#!/usr/bin/env node
/**
 * Debug: why was the yellow phantom on page 4 of
 *   job_1778865205295_c2n86mdmn (staging)
 * not extracted reliably?
 *
 * Steps:
 *   1. Pull story + page-4 cast & compositeBboxes from staging DB.
 *   2. Pull composite_blocking (the populated plate) from story_images.
 *   3. Re-run findColorBbox locally for every cast colour, with diagnostics
 *      (sat / brightness / hue-distance histograms, blob list before merge).
 *   4. Save diagnostic masks + the populated plate to tests/avatar-debug/.
 *
 * Usage:
 *   node scripts/analysis/debug-yellow-phantom.js [storyId] [pageNumber]
 *
 * Defaults to job_1778865205295_c2n86mdmn / page 4.
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const STAGING_DB = process.env.STAGING_DATABASE_URL;
if (!STAGING_DB) {
  console.error('Set STAGING_DATABASE_URL before running (the staging Railway Postgres URL).');
  process.exit(1);
}
const STORY_ID = process.argv[2] || 'job_1778865205295_c2n86mdmn';
const PAGE_NUM = parseInt(process.argv[3] || '4', 10);

const OUT_DIR = path.join(__dirname, '..', '..', 'tests', 'avatar-debug', `yellow-phantom-${STORY_ID}-p${PAGE_NUM}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const DEFAULT_PALETTE = {
  '#E60000': 'red',
  '#0050D0': 'blue',
  '#00B050': 'green',
  '#F0C000': 'amber yellow',
  '#8B00B0': 'purple',
  '#00B0B0': 'cyan',
};

function rgbToHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

async function findColorBboxVerbose(buf, hex, label) {
  const tr = parseInt(hex.slice(1, 3), 16);
  const tg = parseInt(hex.slice(3, 5), 16);
  const tb = parseInt(hex.slice(5, 7), 16);
  const targetHue = rgbToHue(tr, tg, tb);
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const mask = new Uint8Array(W * H);

  // Diagnostic counters
  let totalSatBright = 0;
  let nearHue = 0;
  // Per-pixel-of-interest distance histogram, bucketed in 10° intervals
  const hueDistHist = new Array(19).fill(0); // 0..180 / 10

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const maxCh = Math.max(r, g, b);
      const minCh = Math.min(r, g, b);
      const sat = (maxCh - minCh) / (maxCh || 1);
      if (sat < 0.55 || maxCh < 80) continue;
      totalSatBright++;
      const hue = rgbToHue(r, g, b);
      let dh = Math.abs(hue - targetHue);
      if (dh > 180) dh = 360 - dh;
      hueDistHist[Math.min(18, Math.floor(dh / 10))]++;
      if (dh <= 35) {
        nearHue++;
        mask[y * W + x] = 1;
      }
    }
  }

  // Save mask as a debug PNG (white = qualifying pixels, black = not).
  const maskRgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const v = mask[p] ? 255 : 0;
    maskRgba[p * 4] = v;
    maskRgba[p * 4 + 1] = v;
    maskRgba[p * 4 + 2] = v;
    maskRgba[p * 4 + 3] = 255;
  }
  await sharp(maskRgba, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(path.join(OUT_DIR, `mask-${label}-${hex.slice(1)}.png`));

  // Flood fill — collect every qualifying blob ≥200 px
  const visited = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const blobs = [];
  for (let p = 0; p < W * H; p++) {
    if (!mask[p] || visited[p]) continue;
    let top = 0;
    stack[top++] = p;
    visited[p] = 1;
    let count = 0, minX = W, minY = H, maxX = -1, maxY = -1;
    while (top > 0) {
      const q = stack[--top];
      const x = q % W, y = Math.floor(q / W);
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > 0) {
        const n = q - 1;
        if (mask[n] && !visited[n]) { visited[n] = 1; stack[top++] = n; }
      }
      if (x < W - 1) {
        const n = q + 1;
        if (mask[n] && !visited[n]) { visited[n] = 1; stack[top++] = n; }
      }
      if (y > 0) {
        const n = q - W;
        if (mask[n] && !visited[n]) { visited[n] = 1; stack[top++] = n; }
      }
      if (y < H - 1) {
        const n = q + W;
        if (mask[n] && !visited[n]) { visited[n] = 1; stack[top++] = n; }
      }
    }
    if (count < 200) continue;
    blobs.push({ minX, minY, maxX, maxY, count });
  }
  blobs.sort((a, b) => b.count - a.count);

  // Replicate merge logic from sceneComposite.findColorBbox
  let merged = null;
  if (blobs.length > 0) {
    const anchor = blobs[0];
    merged = { ...anchor, pixels: anchor.count };
    const anchorH = anchor.maxY - anchor.minY + 1;
    for (let i = 1; i < blobs.length; i++) {
      const b = blobs[i];
      const bW = b.maxX - b.minX + 1;
      const mW = merged.maxX - merged.minX + 1;
      const overlapW = Math.max(0, Math.min(merged.maxX, b.maxX) - Math.max(merged.minX, b.minX) + 1);
      const overlapRatio = overlapW / Math.min(mW, bW);
      const vGap = Math.max(0, Math.max(merged.minY, b.minY) - Math.min(merged.maxY, b.maxY));
      if (overlapRatio < 0.6) continue;
      if (vGap > anchorH * 0.15) continue;
      merged.minX = Math.min(merged.minX, b.minX);
      merged.minY = Math.min(merged.minY, b.minY);
      merged.maxX = Math.max(merged.maxX, b.maxX);
      merged.maxY = Math.max(merged.maxY, b.maxY);
      merged.pixels += b.count;
    }
  }

  let bbox = null;
  if (merged) {
    const w = merged.maxX - merged.minX + 1;
    let h = merged.maxY - merged.minY + 1;
    const aspectOk = (h / w) >= 0.3;
    bbox = { x: merged.minX, y: merged.minY, width: w, height: h, pixels: merged.pixels, aspectOk };
    if (h > H * 0.9) bbox.heightClamped = true;
  }

  return {
    targetHue: targetHue.toFixed(1),
    canvas: `${W}×${H}`,
    satBrightPixels: totalSatBright,
    nearHuePixels: nearHue,
    hueDistHist,
    blobCount: blobs.length,
    blobs: blobs.slice(0, 8).map(b => ({
      count: b.count,
      x: b.minX, y: b.minY,
      w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1,
    })),
    finalBbox: bbox,
  };
}

(async () => {
  const pool = new Pool({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });

  console.log(`\nstoryId : ${STORY_ID}`);
  console.log(`page    : ${PAGE_NUM}`);
  console.log(`out dir : ${OUT_DIR}\n`);

  // 1. Story data
  const sRes = await pool.query("SELECT id, data FROM stories WHERE id = $1", [STORY_ID]);
  if (sRes.rows.length === 0) {
    console.error('Story not found in staging DB');
    process.exit(1);
  }
  const data = sRes.rows[0].data;
  const scenes = data.sceneImages || [];
  const scene = scenes.find(s => s.pageNumber === PAGE_NUM);
  if (!scene) {
    console.error(`Page ${PAGE_NUM} not found in sceneImages (have pages: ${scenes.map(s => s.pageNumber).join(', ')})`);
    process.exit(1);
  }

  console.log('── Scene cast / composite metadata ─────────────────────────');
  const cast = scene.compositeCast || scene.cast || null;
  if (cast) {
    console.log('cast:');
    for (const c of cast) {
      console.log(`  - ${c.name} | color=${c.color} (${c.colorName || '?'}) | pose=${c.pose || '?'} | action=${c.action || '-'} | flip=${!!c.flip}`);
    }
  } else {
    console.log('(no cast metadata on scene — check compositeBboxes / compositePhantomCharOrder)');
  }
  if (scene.compositeBboxes) {
    console.log('\nstored compositeBboxes:');
    for (const [name, b] of Object.entries(scene.compositeBboxes)) {
      console.log(`  - ${name}: ${b ? JSON.stringify(b) : 'NULL — extraction failed'}`);
    }
  }
  if (scene.compositePhantomCharOrder) {
    console.log(`\nphantomCharOrder: ${JSON.stringify(scene.compositePhantomCharOrder)}`);
  }
  if (scene.compositePhantomRenders) {
    console.log('\nphantomRenders:');
    for (const [name, r] of Object.entries(scene.compositePhantomRenders)) {
      console.log(`  - ${name}: color=${r.colorName} action=${r.action || '-'} bbox=${r.bbox ? JSON.stringify(r.bbox) : 'NULL'}`);
    }
  }

  // 2. Blocking image
  const iRes = await pool.query(
    "SELECT image_data, image_url FROM story_images WHERE story_id = $1 AND page_number = $2 AND image_type = 'composite_blocking' ORDER BY version_index DESC LIMIT 1",
    [STORY_ID, PAGE_NUM]
  );
  if (iRes.rows.length === 0) {
    console.error('\ncomposite_blocking image not found in story_images.');
    process.exit(1);
  }
  let buf;
  let img = iRes.rows[0].image_data;
  const imgUrl = iRes.rows[0].image_url;
  if (img) {
    if (typeof img === 'string' && img.startsWith('data:')) {
      img = img.replace(/^data:image\/\w+;base64,/, '');
    }
    buf = Buffer.isBuffer(img) ? img : Buffer.from(img, 'base64');
  } else if (imgUrl) {
    console.log(`(image_data is NULL — fetching from R2: ${imgUrl})`);
    const r = await fetch(imgUrl);
    if (!r.ok) {
      console.error(`R2 fetch failed: HTTP ${r.status}`);
      process.exit(1);
    }
    buf = Buffer.from(await r.arrayBuffer());
  } else {
    console.error('\nstory_images row has neither image_data nor image_url.');
    process.exit(1);
  }
  const meta = await sharp(buf).metadata();
  console.log(`\n── Populated plate (composite_blocking): ${meta.width}×${meta.height}, ${(buf.length/1024).toFixed(0)} KB`);
  fs.writeFileSync(path.join(OUT_DIR, 'populated.jpg'), buf);

  // 3. Run findColorBbox per palette colour (yellow + every other cast colour)
  let colorsToTest;
  if (cast) {
    colorsToTest = cast.map(c => ({ hex: c.color, name: c.name, label: (c.colorName || c.color) }));
  } else if (scene.compositePhantomCharOrder) {
    const paletteHex = Object.keys(DEFAULT_PALETTE);
    const paletteName = Object.values(DEFAULT_PALETTE);
    colorsToTest = scene.compositePhantomCharOrder.map((name, i) => ({
      hex: paletteHex[i],
      name,
      label: paletteName[i],
    }));
  } else {
    colorsToTest = Object.entries(DEFAULT_PALETTE).map(([hex, label]) => ({ hex, name: '(palette)', label }));
  }

  console.log('\n── findColorBbox per cast colour ───────────────────────────');
  for (const c of colorsToTest) {
    const r = await findColorBboxVerbose(buf, c.hex, c.label.replace(/\s+/g, '-'));
    console.log(`\n[${c.label}] ${c.hex}  → ${c.name}`);
    console.log(`  targetHue            : ${r.targetHue}°`);
    console.log(`  sat≥0.55 & V≥80 pix  : ${r.satBrightPixels}`);
    console.log(`  hue-dist ≤35° pixels : ${r.nearHuePixels}`);
    console.log(`  hue-dist histogram   : ` + r.hueDistHist.map((n, i) => `${i*10}-${i*10+9}:${n}`).filter(s => !s.endsWith(':0')).join('  '));
    console.log(`  blobs (≥200 px)      : ${r.blobCount}`);
    if (r.blobs.length > 0) {
      for (const b of r.blobs.slice(0, 5)) {
        console.log(`    blob count=${b.count}  x=${b.x} y=${b.y}  w=${b.w} h=${b.h}  (h/w=${(b.h/b.w).toFixed(2)})`);
      }
    }
    if (r.finalBbox) {
      console.log(`  → final bbox         : x=${r.finalBbox.x} y=${r.finalBbox.y} w=${r.finalBbox.width} h=${r.finalBbox.height} (h/w=${(r.finalBbox.height/r.finalBbox.width).toFixed(2)}) aspectOk=${r.finalBbox.aspectOk}`);
    } else {
      console.log(`  → final bbox         : NULL  (no blob ≥200 px qualified)`);
    }
  }

  await pool.end();
  console.log(`\nDone. Diagnostic masks + populated plate in:\n  ${OUT_DIR}\n`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
