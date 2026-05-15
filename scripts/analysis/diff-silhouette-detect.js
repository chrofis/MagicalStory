#!/usr/bin/env node
/**
 * Diff-based silhouette detector — proof of concept.
 *
 * Replaces hue-based findColorBbox (which fails on palette collision —
 * e.g. yellow silhouette on a yellow lawn) with a per-pixel diff between
 * the populated plate and the depopulated clean BG.
 *
 *   1. mask  = |populated − cleanBg| > threshold  (per-pixel max channel delta)
 *   2. components = flood fill on mask            (one per silhouette)
 *   3. for each component:
 *        sampleColour = median hue of populated pixels in the component
 *        nearest palette entry → character name
 *        bbox + centroid + cutout-on-white from the mask + populated
 *
 * Usage:
 *   node scripts/analysis/diff-silhouette-detect.js <storyId> <pageNum>
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const STAGING_DB = process.env.STAGING_DATABASE_URL;
if (!STAGING_DB) { console.error('Set STAGING_DATABASE_URL'); process.exit(1); }

const STORY_ID = process.argv[2] || 'job_1778865205295_c2n86mdmn';
const PAGE_NUM = parseInt(process.argv[3] || '4', 10);
const OUT_DIR  = path.join(__dirname, '..', '..', 'tests', 'avatar-debug',
  `diff-detect-${STORY_ID}-p${PAGE_NUM}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const PALETTE = [
  { hex: '#E60000', name: 'red'    },
  { hex: '#0050D0', name: 'blue'   },
  { hex: '#00B050', name: 'green'  },
  { hex: '#F0C000', name: 'yellow' },
  { hex: '#8B00B0', name: 'purple' },
  { hex: '#00B0B0', name: 'cyan'   },
];

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
function hueDistance(a, b) { let d = Math.abs(a - b); return d > 180 ? 360 - d : d; }

async function fetchImage(pool, type) {
  const r = await pool.query(
    "SELECT image_data, image_url FROM story_images WHERE story_id = $1 AND page_number = $2 AND image_type = $3 ORDER BY version_index DESC LIMIT 1",
    [STORY_ID, PAGE_NUM, type]
  );
  if (r.rows.length === 0) throw new Error(`No row for image_type=${type}`);
  const row = r.rows[0];
  if (row.image_data) {
    const v = typeof row.image_data === 'string' && row.image_data.startsWith('data:')
      ? row.image_data.replace(/^data:image\/\w+;base64,/, '')
      : row.image_data;
    return Buffer.isBuffer(v) ? v : Buffer.from(v, 'base64');
  }
  const resp = await fetch(row.image_url);
  if (!resp.ok) throw new Error(`R2 fetch ${row.image_url}: HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function rgba(buf) {
  return sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

(async () => {
  const pool = new Pool({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });
  console.log(`\nstoryId : ${STORY_ID}`);
  console.log(`page    : ${PAGE_NUM}`);
  console.log(`out dir : ${OUT_DIR}\n`);

  console.log('Fetching populated + clean BG…');
  const popBuf  = await fetchImage(pool, 'composite_blocking');
  const cleanBuf = await fetchImage(pool, 'composite_clean_bg');
  await pool.end();

  // Align dimensions (clean BG may have been resized differently).
  const popMeta = await sharp(popBuf).metadata();
  const W = popMeta.width, H = popMeta.height;
  const pop   = await rgba(popBuf);
  const clean = await rgba(await sharp(cleanBuf).resize(W, H, { fit: 'fill' }).toBuffer());
  console.log(`populated ${W}×${H}, clean ${clean.info.width}×${clean.info.height}\n`);

  fs.writeFileSync(path.join(OUT_DIR, 'populated.jpg'), popBuf);
  fs.writeFileSync(path.join(OUT_DIR, 'clean_bg.jpg'), cleanBuf);

  // ── 1. diff per pixel ────────────────────────────────────────────────
  // We want pixels where the populated plate differs noticeably from the
  // clean BG. Use the max of the three per-channel absolute deltas — that
  // catches a saturated yellow silhouette on yellow grass (the populated
  // pixel is more saturated / different hue, so at least one channel will
  // differ a lot) while ignoring tiny JPEG noise.
  const DIFF_THRESHOLD = 40; // ~16% of 255
  const popD = pop.data, clD = clean.data;
  const mask = new Uint8Array(W * H);
  let maskCount = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const dr = Math.abs(popD[i]     - clD[i]    );
    const dg = Math.abs(popD[i + 1] - clD[i + 1]);
    const db = Math.abs(popD[i + 2] - clD[i + 2]);
    if (Math.max(dr, dg, db) > DIFF_THRESHOLD) {
      mask[p] = 1;
      maskCount++;
    }
  }
  console.log(`diff threshold     : ${DIFF_THRESHOLD}`);
  console.log(`mask pixels        : ${maskCount} (${(100*maskCount/(W*H)).toFixed(1)}% of canvas)\n`);

  // Save the diff mask
  {
    const out = Buffer.alloc(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const v = mask[p] ? 255 : 0;
      out[p*4] = v; out[p*4+1] = v; out[p*4+2] = v; out[p*4+3] = 255;
    }
    await sharp(out, { raw: { width: W, height: H, channels: 4 } })
      .png().toFile(path.join(OUT_DIR, 'diff_mask.png'));
  }

  // Save silhouettes-only (populated AND mask), white elsewhere.
  {
    const out = Buffer.alloc(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      if (mask[p]) {
        out[i]   = popD[i];
        out[i+1] = popD[i+1];
        out[i+2] = popD[i+2];
      } else {
        out[i]   = 255; out[i+1] = 255; out[i+2] = 255;
      }
      out[i+3] = 255;
    }
    await sharp(out, { raw: { width: W, height: H, channels: 4 } })
      .png().toFile(path.join(OUT_DIR, 'silhouettes_only.png'));
  }

  // ── 2. per-palette-colour detection INSIDE the diff mask ─────────────
  // This is the key step: the diff mask removes the background palette
  // collision (grass, sky, etc), and then hue matching cleanly separates
  // touching silhouettes by colour. We flood-fill per palette colour,
  // restricted to mask pixels, and take the biggest blob per colour.
  console.log('── Per-palette detection INSIDE diff mask ────────────────');
  for (const pal of PALETTE) {
    const pr = parseInt(pal.hex.slice(1,3),16), pg = parseInt(pal.hex.slice(3,5),16), pb = parseInt(pal.hex.slice(5,7),16);
    const palHue = rgbToHue(pr, pg, pb);
    const colourMask = new Uint8Array(W * H);
    let nMatch = 0;
    for (let p = 0; p < W * H; p++) {
      if (!mask[p]) continue;
      const i = p * 4;
      const r = popD[i], g = popD[i+1], b = popD[i+2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = (mx - mn) / (mx || 1);
      if (sat < 0.55 || mx < 80) continue;
      const dh = hueDistance(rgbToHue(r, g, b), palHue);
      if (dh > 35) continue;
      colourMask[p] = 1;
      nMatch++;
    }
    if (nMatch === 0) { console.log(`  ${pal.name.padEnd(7)} ${pal.hex}: no matching pixels in mask`); continue; }
    // Biggest connected blob for this colour
    const vis = new Uint8Array(W * H);
    const st = new Int32Array(W * H);
    let best = { count: 0, minX: 0, minY: 0, maxX: 0, maxY: 0, pixels: [] };
    for (let p = 0; p < W * H; p++) {
      if (!colourMask[p] || vis[p]) continue;
      let top = 0; st[top++] = p; vis[p] = 1;
      let count = 0, minX = W, minY = H, maxX = -1, maxY = -1;
      const pixels = [];
      while (top > 0) {
        const q = st[--top];
        const x = q % W, y = Math.floor(q / W);
        count++; pixels.push(q);
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        if (x > 0)     { const n=q-1; if (colourMask[n]&&!vis[n]) { vis[n]=1; st[top++]=n; } }
        if (x < W - 1) { const n=q+1; if (colourMask[n]&&!vis[n]) { vis[n]=1; st[top++]=n; } }
        if (y > 0)     { const n=q-W; if (colourMask[n]&&!vis[n]) { vis[n]=1; st[top++]=n; } }
        if (y < H - 1) { const n=q+W; if (colourMask[n]&&!vis[n]) { vis[n]=1; st[top++]=n; } }
      }
      if (count > best.count) best = { count, minX, minY, maxX, maxY, pixels };
    }
    if (best.count < 500) { console.log(`  ${pal.name.padEnd(7)} ${pal.hex}: biggest blob ${best.count} px (below 500) — not assigned`); continue; }
    const w = best.maxX - best.minX + 1, h = best.maxY - best.minY + 1;
    const cx = Math.round(best.minX + w / 2), cy = Math.round(best.minY + h / 2);
    console.log(`  ${pal.name.padEnd(7)} ${pal.hex}: ${best.count.toString().padStart(6)} px  bbox=${best.minX},${best.minY} ${w}×${h}  centroid=(${cx},${cy})`);

    // Save cutout on white using the blob's pixel mask
    const cutout = Buffer.alloc(w * h * 4);
    for (let o = 0; o < cutout.length; o += 4) { cutout[o]=255; cutout[o+1]=255; cutout[o+2]=255; cutout[o+3]=255; }
    for (const q of best.pixels) {
      const x = q % W, y = Math.floor(q / W);
      const o = ((y - best.minY) * w + (x - best.minX)) * 4;
      const i = q * 4;
      cutout[o] = popD[i]; cutout[o+1] = popD[i+1]; cutout[o+2] = popD[i+2]; cutout[o+3] = 255;
    }
    await sharp(cutout, { raw: { width: w, height: h, channels: 4 } })
      .png().toFile(path.join(OUT_DIR, `palette_${pal.name}.png`));
  }
  console.log('');

  console.log('── (legacy) connected components on diff mask alone ──────');
  const visited = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const components = [];
  for (let p = 0; p < W * H; p++) {
    if (!mask[p] || visited[p]) continue;
    let top = 0; stack[top++] = p; visited[p] = 1;
    let count = 0, minX = W, minY = H, maxX = -1, maxY = -1;
    const pixels = [];
    while (top > 0) {
      const q = stack[--top];
      const x = q % W, y = Math.floor(q / W);
      count++; pixels.push(q);
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      if (x > 0)     { const n=q-1; if (mask[n]&&!visited[n]) { visited[n]=1; stack[top++]=n; } }
      if (x < W - 1) { const n=q+1; if (mask[n]&&!visited[n]) { visited[n]=1; stack[top++]=n; } }
      if (y > 0)     { const n=q-W; if (mask[n]&&!visited[n]) { visited[n]=1; stack[top++]=n; } }
      if (y < H - 1) { const n=q+W; if (mask[n]&&!visited[n]) { visited[n]=1; stack[top++]=n; } }
    }
    if (count < 500) continue; // ignore noise specks
    components.push({ count, minX, minY, maxX, maxY, pixels });
  }
  components.sort((a, b) => b.count - a.count);
  console.log(`components (≥500 px): ${components.length}\n`);

  // ── 3. For each component: sample colour, match to palette, save crop ─
  const N = Math.min(components.length, 8);
  for (let idx = 0; idx < N; idx++) {
    const c = components[idx];
    // Median hue among saturated pixels in the component
    const hues = [];
    let avgR = 0, avgG = 0, avgB = 0, satCount = 0;
    for (const q of c.pixels) {
      const i = q * 4;
      const r = popD[i], g = popD[i+1], b = popD[i+2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = (mx - mn) / (mx || 1);
      if (sat < 0.45 || mx < 70) continue; // skip near-grey edge pixels
      hues.push(rgbToHue(r, g, b));
      avgR += r; avgG += g; avgB += b; satCount++;
    }
    if (satCount === 0) { console.log(`  component #${idx}: no saturated pixels — skipping`); continue; }
    hues.sort((a, b) => a - b);
    const medHue = hues[Math.floor(hues.length / 2)];
    avgR = Math.round(avgR / satCount); avgG = Math.round(avgG / satCount); avgB = Math.round(avgB / satCount);

    // Match to nearest palette entry by hue
    let best = null, bestD = Infinity;
    for (const pal of PALETTE) {
      const pr = parseInt(pal.hex.slice(1,3),16), pg = parseInt(pal.hex.slice(3,5),16), pb = parseInt(pal.hex.slice(5,7),16);
      const palHue = rgbToHue(pr, pg, pb);
      const d = hueDistance(medHue, palHue);
      if (d < bestD) { bestD = d; best = pal; }
    }

    const w = c.maxX - c.minX + 1, h = c.maxY - c.minY + 1;
    const cx = Math.round(c.minX + w / 2), cy = Math.round(c.minY + h / 2);
    console.log(`component #${idx}: count=${c.count}  bbox=${c.minX},${c.minY} ${w}×${h}  centroid=(${cx},${cy})`);
    console.log(`  median hue=${medHue.toFixed(1)}°  avg RGB=(${avgR},${avgG},${avgB})  → ${best.name} (${best.hex}, ${bestD.toFixed(1)}° away)`);

    // Cutout-on-white using the mask (not the bbox) — what we'd send to Grok
    const cutout = Buffer.alloc(w * h * 4);
    for (const q of c.pixels) {
      const x = q % W, y = Math.floor(q / W);
      const lx = x - c.minX, ly = y - c.minY;
      const o = (ly * w + lx) * 4;
      const i = q * 4;
      cutout[o]   = popD[i];
      cutout[o+1] = popD[i+1];
      cutout[o+2] = popD[i+2];
      cutout[o+3] = 255;
    }
    // Fill non-component pixels in the bbox region with white
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const o = (yy * w + xx) * 4;
        if (cutout[o + 3] === 0) { cutout[o]=255; cutout[o+1]=255; cutout[o+2]=255; cutout[o+3]=255; }
      }
    }
    // The buffer above leaves alpha 0 on never-touched pixels but we set them to white above; reset alphas to 255 just in case
    await sharp(cutout, { raw: { width: w, height: h, channels: 4 } })
      .png().toFile(path.join(OUT_DIR, `comp${idx}_${best.name}.png`));
  }

  console.log(`\nDone. Outputs in:\n  ${OUT_DIR}`);
})().catch(err => { console.error(err); process.exit(1); });
