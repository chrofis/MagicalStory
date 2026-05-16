/**
 * Scene composite page-generation pipeline.
 *
 * Three Grok calls per page (same call count as before; reordered):
 *   1. generate populated plate — the full scene + coloured silhouettes
 *      placed in one go (text-to-image). Anchors world geometry + VB props
 *      WITH characters in their final positions.
 *   2. detect silhouette bboxes from the populated plate.
 *   3. edit-depopulate the populated plate — remove the silhouettes and
 *      repaint the regions with surrounding terrain. Yields the derived
 *      clean BG plate, guaranteed self-consistent with the populated one.
 *   4. composite the real character cutouts (from 2×4 sheets or per-pose
 *      phantom renders) onto the derived clean BG at the detected bboxes.
 *   5. one Grok edit blend pass to harmonise lighting / soften edges / add
 *      missing required objects from the brief.
 *
 * Why this order: the previous flow generated an empty scene first, then
 * Grok-edited silhouettes onto it. The blocking edit silently drifted the
 * background (added a bench, swapped a VB prop, repainted the floor) so
 * the empty plate stopped matching the silhouette plate. Generating the
 * populated plate first locks the world geometry + VB props in place with
 * the characters; the empty plate is derived from that single source of
 * truth.
 *
 * Characters come from pre-rendered 2×4 sheets stored on the character row
 * (character.avatars.sheet2x4_<costume>). Each cast entry on the scene says
 * { name, pose, flip, color } so the script picks the right cell + flip.
 *
 * Behind MODEL_DEFAULTS.enableSceneComposite (default true) + cast-aware
 * auto-routing in server/lib/imageRouter.js. Per-story opt-out via
 * inputData.composite === false.
 *
 * See docs/SCENE-COMPOSITE-PIPELINE.html for the architecture overview and
 * scripts/test-scene-composite.js for the validation harness.
 */

'use strict';

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { generateWithGrok, editWithGrok, GROK_MODELS } = require('./grok');
const { renderCharacterInPhantomPose } = require('./phantomPoseRender');

const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

// ─── Pose enum → cell index in the 2×4 sheet ──────────────────────────────
// Cells 1–4 are head-only views (not used by scene composite).
// Cells 5–8 are full-body views: front, threeQuarter (camera-left),
// profile (camera-left), back. To face camera-right, set flip: true.
const POSE_CELL = {
  front: 5,
  threeQuarter: 6,
  profile: 7,
  back: 8,
};

// ─── Default character colour palette ─────────────────────────────────────
// Saturated hues with > 35° separation in HSL so the bbox detector can
// distinguish them. The 2×4 colour-leak test (Hans/Daniel/Emma/Noah) used
// these exact values and produced clean blob detection on every run.
const DEFAULT_PALETTE = [
  '#E60000', // red
  '#0050D0', // blue
  '#00B050', // green
  '#F0C000', // amber yellow
  '#8B00B0', // purple
  '#00B0B0', // cyan
];

// ─── Grok aspect preset picker ────────────────────────────────────────────
//
// Grok's edit endpoint only accepts a fixed set of aspect_ratio strings:
//   1:1, 3:4, 4:3, 9:16, 16:9, 2:3, 3:2, 1:2, 2:1, 9:19.5, 19.5:9, 9:20, 20:9
//
// 'auto' is documented as accepted by the body but the editWithGrok helper
// uses the aspect string to drive its own input-cover-cropper — when the
// string isn't a parseable W:H it falls back to ratio 1 and crops the
// input to square, which clipped silhouettes off the edges of our crop.
//
// Strategy: pick the preset closest to the actual crop ratio, then white-
// pad the crop to that exact preset BEFORE sending. The padding is on the
// background (which is already white inside the masked crop), so we lose
// no silhouette pixels. After Grok returns, we extract the original crop
// region back out of the padded output.
const GROK_ASPECT_PRESETS = [
  { name: '1:1',    ratio: 1 },
  { name: '3:4',    ratio: 3 / 4 },
  { name: '4:3',    ratio: 4 / 3 },
  { name: '9:16',   ratio: 9 / 16 },
  { name: '16:9',   ratio: 16 / 9 },
  { name: '2:3',    ratio: 2 / 3 },
  { name: '3:2',    ratio: 3 / 2 },
  { name: '1:2',    ratio: 0.5 },
  { name: '2:1',    ratio: 2 },
  { name: '9:19.5', ratio: 9 / 19.5 },
  { name: '19.5:9', ratio: 19.5 / 9 },
  { name: '9:20',   ratio: 9 / 20 },
  { name: '20:9',   ratio: 20 / 9 },
];
function nearestGrokAspect(w, h) {
  const r = w / h;
  let best = GROK_ASPECT_PRESETS[0], bestDiff = Math.abs(r - best.ratio);
  for (const p of GROK_ASPECT_PRESETS) {
    const d = Math.abs(r - p.ratio);
    if (d < bestDiff) { bestDiff = d; best = p; }
  }
  return best;
}

// ─── Silhouette colour match — RGB Euclidean distance ────────────────────
//
// Verified by sampling real Grok anchor plates. Grok's faithful renders
// land within ~30 of the target. But Grok also frequently renders silhouettes
// SIGNIFICANTLY DESATURATED — saw red rendered as average rgb(225, 68, 69)
// across 50k pixels (distance 97 from target #E60000), essentially a salmon
// instead of red. Threshold 110 catches Grok's desaturation drift while
// scene colours stay rejected (wood at 158+, stone at 180+, skin at 234+
// from the saturated palette colours).
//
// Earlier gradient-from-white attempt failed: it skipped axes where the
// target was within 30 of white (true for #E60000 with R=230) which let
// every dark pixel pass for red detection. Pure RGB distance has no such
// blind spot. Connected-component flood fill + 200 px min-blob filter
// downstream rejects any isolated scene speckles that happen to fall
// inside the threshold radius.
const SILHOUETTE_MATCH_THRESHOLD_SQ = 110 * 110;
function isSilhouetteMatch(r, g, b, tr, tg, tb) {
  const dr = r - tr, dg = g - tg, db = b - tb;
  return dr * dr + dg * dg + db * db <= SILHOUETTE_MATCH_THRESHOLD_SQ;
}

// ─── Hue helpers (for the bbox detector) ──────────────────────────────────
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

/**
 * Find the largest connected blob in `buf` whose hue is near `hex`.
 * Returns { x, y, width, height, pixels } or null if no blob ≥ 200 px
 * with height/width ≥ 1.1 is found.
 */
async function findColorBbox(buf, hex) {
  const tr = parseInt(hex.slice(1, 3), 16);
  const tg = parseInt(hex.slice(3, 5), 16);
  const tb = parseInt(hex.slice(5, 7), 16);
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  const mask = new Uint8Array(W * H);

  // Gradient-from-white silhouette match. Handles both solid silhouettes
  // (when Grok paints exactly the target colour) AND translucent variants
  // (Grok occasionally blends silhouettes with the white background at
  // anti-aliased edges, or rendered the whole silhouette at 70-90% opacity).
  // See isSilhouetteMatch comment block for the math.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      if (isSilhouetteMatch(data[i], data[i + 1], data[i + 2], tr, tg, tb)) {
        mask[y * W + x] = 1;
      }
    }
  }

  // 4-connected flood fill; collect every qualifying blob (>=200 px), then
  // merge vertically-stacked fragments of the same character (e.g. when a
  // table or fence cuts the figure in half).
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
      const neighbours = [];
      if (x > 0) neighbours.push(q - 1);
      if (x < W - 1) neighbours.push(q + 1);
      if (y > 0) neighbours.push(q - W);
      if (y < H - 1) neighbours.push(q + W);
      for (const n of neighbours) {
        if (mask[n] && !visited[n]) {
          visited[n] = 1;
          stack[top++] = n;
        }
      }
    }
    if (count < 200) continue;
    blobs.push({ minX, minY, maxX, maxY, count });
  }
  if (blobs.length === 0) return null;

  // Sort by pixel count descending — the largest blob anchors the merge.
  blobs.sort((a, b) => b.count - a.count);
  const anchor = blobs[0];
  let merged = { ...anchor, pixels: anchor.count };

  // For each smaller blob, fold it in only if it lies in the SAME vertical
  // column as the anchor (horizontal overlap ≥60% of the smaller blob's
  // width) AND has a NARROW vertical gap to the anchor (≤15% of the
  // anchor's height — the size of a fence rail, a table edge, a banner
  // strap). Anything beyond is treated as an unrelated saturated patch in
  // the scene and ignored.
  //
  // Anchor height is FROZEN — earlier versions used the running merged
  // height (`mH`), which ratcheted upward with each merge and let
  // arbitrarily distant patches join. That's exactly the bug that produced
  // oversized cutouts on staging story `9s2poh79f` page 3.
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

  const w = merged.maxX - merged.minX + 1;
  let h = merged.maxY - merged.minY + 1;
  // Aspect sanity: drop horizon-stripe / banner-strap false positives (saturated
  // sky band, painted sign, etc.). 0.3 is permissive enough to keep reclining,
  // sitting, leaning-over and reaching-across poses — every human silhouette
  // we've seen Grok paint has h/w ≥ 0.4. The earlier 1.1 threshold rejected
  // any non-portrait pose and silently dropped wide-action characters (see
  // story job_1778849489132_irowi7vq7 page 2 — red silhouette lying in a
  // rowboat measured 845×388 = h/w 0.46 and was discarded).
  if (h / w < 0.3) return null;
  // Belt-and-braces clamp: a single character should never need more than
  // 90% of canvas height. If the merge / detection ever overshoots, cap.
  if (h > H * 0.9) {
    const clampedTop = Math.max(0, merged.maxY - Math.floor(H * 0.9) + 1);
    merged.minY = clampedTop;
    h = merged.maxY - merged.minY + 1;
  }
  return { x: merged.minX, y: merged.minY, width: w, height: h, pixels: merged.pixels };
}

/**
 * Diff-based silhouette detector — the production path.
 *
 * Given the populated plate and its derived clean BG (depopulate output),
 * every saturated pixel that appears only in the populated plate belongs to
 * a silhouette. That removes palette collision entirely — yellow grass that
 * exists in both images diffs to ~0 and is filtered out before hue matching
 * runs. Inside the diff mask, plain hue distance cleanly separates touching
 * silhouettes by colour.
 *
 * For each cast entry (with assigned palette colour), returns:
 *   - bbox: { x, y, width, height, pixels }
 *   - mask: full-canvas Uint8Array (W*H) with 1 = silhouette pixel, 0 = not
 *           (used downstream by cropPhantom to keep only the target's pixels
 *           and repaint everything else with clean-BG context)
 *
 * Returns `{ canvasWidth, canvasHeight, diffMaskCount, results: { name → { bbox, mask } | null } }`.
 *
 * Tuning knobs are deliberate:
 *   - diffThreshold 40  (~16% of 255): below this is JPEG noise; above this
 *                       reliably catches silhouette vs. matching background.
 *   - hueThreshold 35°  : Grok's actual paint variance is ~5-10°; 35° gives
 *                       margin for sat/shadow drift without bleeding into
 *                       adjacent palette entries (palette is spaced ≥50° apart).
 *   - minBlobPixels 500 : drops noise specks. Real silhouettes are >5k px on
 *                       a 1024×1024 canvas.
 */
async function findSilhouettesByDiff(populatedBuf, cleanBgBuf, cast, opts = {}) {
  const DIFF_THRESHOLD = opts.diffThreshold ?? 40;
  const HUE_THRESHOLD = opts.hueThreshold ?? 35;
  const MIN_BLOB_PIXELS = opts.minBlobPixels ?? 500;

  const popMeta = await sharp(populatedBuf).metadata();
  const W = popMeta.width, H = popMeta.height;

  const pop = await sharp(populatedBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Align clean BG to populated dimensions (depopulate can rescale).
  const cleanAligned = await sharp(cleanBgBuf).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const popD = pop.data, clD = cleanAligned.data;

  // ── 1. Diff mask: where the two images disagree.
  const diffMask = new Uint8Array(W * H);
  let diffMaskCount = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const dr = Math.abs(popD[i]     - clD[i]    );
    const dg = Math.abs(popD[i + 1] - clD[i + 1]);
    const db = Math.abs(popD[i + 2] - clD[i + 2]);
    if (Math.max(dr, dg, db) > DIFF_THRESHOLD) {
      diffMask[p] = 1;
      diffMaskCount++;
    }
  }

  // ── 2. Per-cast colour: hue match inside diff mask, biggest blob wins.
  const results = {};
  const visited = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  for (const c of cast) {
    if (!c.color) { results[c.name] = null; continue; }
    const tr = parseInt(c.color.slice(1, 3), 16);
    const tg = parseInt(c.color.slice(3, 5), 16);
    const tb = parseInt(c.color.slice(5, 7), 16);
    const targetHue = rgbToHue(tr, tg, tb);

    const colourMask = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      if (!diffMask[p]) continue;
      const i = p * 4;
      const r = popD[i], g = popD[i + 1], b = popD[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = (mx - mn) / (mx || 1);
      if (sat < 0.55 || mx < 80) continue;
      let dh = Math.abs(rgbToHue(r, g, b) - targetHue);
      if (dh > 180) dh = 360 - dh;
      if (dh <= HUE_THRESHOLD) colourMask[p] = 1;
    }

    // Flood fill — track the biggest blob and remember its pixels.
    visited.fill(0);
    let bestCount = 0;
    let bestPixels = null;
    let bestMinX = 0, bestMinY = 0, bestMaxX = 0, bestMaxY = 0;
    for (let p = 0; p < W * H; p++) {
      if (!colourMask[p] || visited[p]) continue;
      let top = 0;
      stack[top++] = p; visited[p] = 1;
      let count = 0, minX = W, minY = H, maxX = -1, maxY = -1;
      const pixels = [];
      while (top > 0) {
        const q = stack[--top];
        const x = q % W, y = Math.floor(q / W);
        count++; pixels.push(q);
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        if (x > 0)     { const n=q-1; if (colourMask[n]&&!visited[n]) { visited[n]=1; stack[top++]=n; } }
        if (x < W - 1) { const n=q+1; if (colourMask[n]&&!visited[n]) { visited[n]=1; stack[top++]=n; } }
        if (y > 0)     { const n=q-W; if (colourMask[n]&&!visited[n]) { visited[n]=1; stack[top++]=n; } }
        if (y < H - 1) { const n=q+W; if (colourMask[n]&&!visited[n]) { visited[n]=1; stack[top++]=n; } }
      }
      if (count > bestCount) {
        bestCount = count; bestPixels = pixels;
        bestMinX = minX; bestMinY = minY; bestMaxX = maxX; bestMaxY = maxY;
      }
    }

    if (bestCount < MIN_BLOB_PIXELS) { results[c.name] = null; continue; }

    // Full-canvas silhouette mask: downstream needs absolute coordinates so
    // cropPhantom can build a context window of arbitrary padding and still
    // know which pixels belong to this character.
    const sMask = new Uint8Array(W * H);
    for (const q of bestPixels) sMask[q] = 1;

    results[c.name] = {
      bbox: {
        x: bestMinX,
        y: bestMinY,
        width: bestMaxX - bestMinX + 1,
        height: bestMaxY - bestMinY + 1,
        pixels: bestCount,
      },
      mask: sMask,
    };
  }

  return { canvasWidth: W, canvasHeight: H, diffMaskCount, results };
}

// ─── Sheet cell helpers ───────────────────────────────────────────────────

/** Crop one of 8 cells from a 2×4 sheet by fixed math. 1-indexed.
 *  Used as the fallback when edge-detected splitting is unavailable. */
async function cropSheetCellFixed(sheetBuf, cellIdx) {
  const meta = await sharp(sheetBuf).metadata();
  const cellW = Math.floor(meta.width / 4);
  const cellH = Math.floor(meta.height / 2);
  const col = (cellIdx - 1) % 4;
  const row = Math.floor((cellIdx - 1) / 4);
  return sharp(sheetBuf)
    .extract({ left: col * cellW, top: row * cellH, width: cellW, height: cellH })
    .png()
    .toBuffer();
}

/**
 * Split a 2×4 sheet into 8 cells by EDGE DETECTION (Python /split-reference-sheet,
 * variance-based separator search), not fixed math. Returns an array of 8
 * PNG buffers in row-major order: cells[0..3] = top-row face cells,
 * cells[4..7] = bottom-row body cells. Cell index 1-8 maps to array index 0-7.
 *
 * On failure (Python service unreachable / errors), throws — caller falls
 * back to cropSheetCellFixed per-cell.
 */
async function splitSheetByEdgeDetection(sheetBuf) {
  const b64 = sheetBuf.toString('base64');
  const r = await fetch(`${PHOTO_ANALYZER_URL}/split-reference-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: `data:image/png;base64,${b64}`, count: 8, cols: 4, rows: 2 }),
  });
  if (!r.ok) throw new Error(`split-reference-sheet HTTP ${r.status}`);
  const data = await r.json();
  if (!data.success || !Array.isArray(data.cells)) {
    throw new Error(`split-reference-sheet bad response: ${data.error || JSON.stringify(data).slice(0,120)}`);
  }
  return data.cells.map(b64png => b64png ? Buffer.from(b64png, 'base64') : null);
}

/**
 * Get one cell from a sheet — uses edge detection when possible, falls back to
 * fixed math. The split result is memoised per sheetBuf so all 8 cells share a
 * single Python call.
 */
const _sheetSplitCache = new WeakMap();
async function cropSheetCell(sheetBuf, cellIdx) {
  if (!_sheetSplitCache.has(sheetBuf)) {
    try {
      const cells = await splitSheetByEdgeDetection(sheetBuf);
      _sheetSplitCache.set(sheetBuf, cells);
    } catch (err) {
      log.warn(`[SCENE COMPOSITE] edge-detection split failed: ${err.message} — falling back to fixed-math crop`);
      _sheetSplitCache.set(sheetBuf, null);
    }
  }
  const cells = _sheetSplitCache.get(sheetBuf);
  if (cells && cells[cellIdx - 1]) return cells[cellIdx - 1];
  return cropSheetCellFixed(sheetBuf, cellIdx);
}

/** Background-remove via the Python rembg service; white-threshold fallback. */
async function removeBackground(buf) {
  try {
    const b64 = buf.toString('base64');
    const r = await fetch(`${PHOTO_ANALYZER_URL}/remove-bg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:image/png;base64,${b64}` }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`rembg ${r.status}`);
    const data = await r.json();
    const out = data.image || data.result || data.data;
    if (!out) throw new Error('rembg returned no image');
    const cleanB64 = String(out).replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(cleanB64, 'base64');
  } catch (err) {
    log.warn(`[SCENE COMPOSITE] rembg fallback to threshold: ${err.message}`);
    return whiteToTransparent(buf);
  }
}

async function whiteToTransparent(buf, threshold = 240) {
  const img = sharp(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    if (r >= threshold && g >= threshold && b >= threshold) out[i + 3] = 0;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function trimTransparent(buf) {
  return sharp(buf).trim({ threshold: 1 }).png().toBuffer();
}

async function flipHorizontal(buf) {
  return sharp(buf).flop().png().toBuffer();
}

async function scaleToHeight(buf, targetH) {
  const meta = await sharp(buf).metadata();
  if (!meta.height || meta.height === targetH) return buf;
  return sharp(buf).resize({ height: targetH, withoutEnlargement: false }).png().toBuffer();
}

// ─── Top-row face cells (head/neck views) ────────────────────────────────
// Same four angles as POSE_CELL but in cells 1-4 (top row) — used when a page
// generation wants the character's face/identity rather than the full body.
const FACE_CELL = {
  front: 1,
  threeQuarter: 2,
  profile: 3,
  back: 4,
};

/**
 * Crop one (or two) cells from a 2×4 character sheet for use as a per-page
 * reference image during story generation. Replaces the today-default of
 * sending the whole 2×4 sheet (or a single-body styled avatar) as a Grok
 * reference — sending just the matching pose cell keeps the model focused
 * on identity + costume without the other 7 pose distractions.
 *
 * @param {Buffer|string} sheet - the 2×4 sheet as a raw Buffer OR data URI.
 * @param {Object} opts
 * @param {'front'|'threeQuarter'|'profile'|'back'} opts.pose - body angle. Defaults to 'threeQuarter'.
 * @param {boolean} [opts.flip=false] - mirror horizontally (camera-right facing).
 * @param {boolean} [opts.includeFace=false] - also return the matching top-row face cell.
 * @returns {Promise<{ body: Buffer, face: Buffer|null }>} PNG buffers.
 */
async function cropAvatarCell(sheet, opts = {}) {
  const { pose = 'threeQuarter', flip = false, includeFace = false } = opts;
  const sheetBuf = Buffer.isBuffer(sheet)
    ? sheet
    : Buffer.from(String(sheet).replace(/^data:image\/\w+;base64,/, ''), 'base64');

  const bodyIdx = POSE_CELL[pose] || POSE_CELL.threeQuarter;
  let body = await cropSheetCell(sheetBuf, bodyIdx);
  if (flip) body = await flipHorizontal(body);

  let face = null;
  if (includeFace) {
    const faceIdx = FACE_CELL[pose] || FACE_CELL.threeQuarter;
    face = await cropSheetCell(sheetBuf, faceIdx);
    if (flip) face = await flipHorizontal(face);
  }
  return { body, face };
}

/**
 * Detect z-order (paint sequence) by reading actual occlusion from the
 * populated plate. For each pair of placements whose bboxes overlap, count
 * saturated pixels of each character's colour inside the intersection
 * rectangle — the character with significantly more pixels there is the
 * one painted on top by Grok (the other character's pixels were overwritten
 * where they were occluded).
 *
 * @param {Buffer} populatedBuf raw image bytes of the populated plate (any
 *   format sharp accepts).
 * @param {Array} placements [{ _name, _color, _bbox, _footY, ... }]
 *   _bbox: { x, y, width, height }; _color: '#RRGGBB' hex.
 * @returns {Promise<{order: Array, scores: Object, decisions: Array}>}
 *   order — placements re-sorted back-to-front (paint in this order; sharp
 *     paints first → last so the LAST entry ends up on top).
 *   scores — per-name occlusion score (higher = more in front).
 *   decisions — per-pair audit: [{ a, b, aPx, bPx, winner }] for log lines.
 */
async function detectZOrderByOcclusion(populatedBuf, placements) {
  if (placements.length < 2) {
    return { order: placements.slice(), scores: {}, decisions: [] };
  }
  const { data, info } = await sharp(populatedBuf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;

  // Pre-compute target hue per placement.
  const hues = placements.map((p) => {
    const r = parseInt(p._color.slice(1, 3), 16);
    const g = parseInt(p._color.slice(3, 5), 16);
    const b = parseInt(p._color.slice(5, 7), 16);
    return rgbToHue(r, g, b);
  });

  const scores = new Map(placements.map((p) => [p._name, 0]));
  const decisions = [];

  // Pixel margin to declare a winner: the front character should have at least
  // 30% more saturated pixels of its colour in the bbox intersection than the
  // other. Below that, the overlap is ambiguous (e.g. tall character behind
  // shorter character — back character's head visible above front shoulders);
  // we leave the score untouched and let the foot-Y tiebreaker decide.
  const MARGIN = 1.3;
  // Skip pairs whose bbox intersection is tiny — not enough signal.
  const MIN_INTERSECTION_PX = 200;

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const A = placements[i], B = placements[j];
      const ax1 = A._bbox.x, ay1 = A._bbox.y;
      const ax2 = A._bbox.x + A._bbox.width, ay2 = A._bbox.y + A._bbox.height;
      const bx1 = B._bbox.x, by1 = B._bbox.y;
      const bx2 = B._bbox.x + B._bbox.width, by2 = B._bbox.y + B._bbox.height;
      const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
      const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
      if (ix2 <= ix1 || iy2 <= iy1) continue;
      if ((ix2 - ix1) * (iy2 - iy1) < MIN_INTERSECTION_PX) continue;

      const aHue = hues[i], bHue = hues[j];
      let aPx = 0, bPx = 0;
      for (let y = iy1; y < iy2; y++) {
        for (let x = ix1; x < ix2; x++) {
          const k = (y * W + x) * ch;
          const r = data[k], g = data[k + 1], bb = data[k + 2];
          const maxCh = Math.max(r, g, bb), minCh = Math.min(r, g, bb);
          const sat = (maxCh - minCh) / (maxCh || 1);
          if (sat < 0.55 || maxCh < 80) continue;
          const h = rgbToHue(r, g, bb);
          let dhA = Math.abs(h - aHue); if (dhA > 180) dhA = 360 - dhA;
          let dhB = Math.abs(h - bHue); if (dhB > 180) dhB = 360 - dhB;
          if (dhA <= 35) aPx++;
          if (dhB <= 35) bPx++;
        }
      }
      let winner = 'ambiguous';
      if (aPx >= bPx * MARGIN && aPx > 0) {
        scores.set(A._name, scores.get(A._name) + 1);
        scores.set(B._name, scores.get(B._name) - 1);
        winner = A._name;
      } else if (bPx >= aPx * MARGIN && bPx > 0) {
        scores.set(B._name, scores.get(B._name) + 1);
        scores.set(A._name, scores.get(A._name) - 1);
        winner = B._name;
      }
      decisions.push({ a: A._name, b: B._name, aPx, bPx, winner });
    }
  }

  const ordered = placements.slice().sort((a, b) => {
    const dz = (scores.get(a._name) || 0) - (scores.get(b._name) || 0);
    if (dz !== 0) return dz;
    return a._footY - b._footY;
  });

  return {
    order: ordered,
    scores: Object.fromEntries(scores),
    decisions,
  };
}

// ─── Prompt builders ──────────────────────────────────────────────────────

/**
 * Build the cast-line block (one line per silhouette) used by both the
 * populated-plate generate prompt and any future per-character spec.
 */
function buildCastLines(cast) {
  return cast.map((c) => {
    const sizeHint = c.sizeHint || 'about two-thirds the size of the largest figure';
    const posHint = c.position || 'in the scene';
    const direction = c.flip ? 'facing right' : 'facing left';
    const poseLabel = {
      front:        'front view, body facing the camera',
      threeQuarter: `three-quarter view, ${direction}`,
      profile:      `profile view, ${direction}`,
      back:         'back view, viewer sees the back of the head',
    }[c.pose] || `three-quarter view, ${direction}`;
    const actionClause = c.action ? `, ${c.action}` : '';
    // Per-pose eye markers — black dot(s) inside the silhouette's head.
    // Front/three-quarter show two eyes; profile shows one; back shows none.
    const markerSpec = (() => {
      const oppSide = c.flip ? 'left' : 'right';
      switch (c.pose) {
        case 'front':
          return 'two small BLACK dots side by side in the head area (eyes)';
        case 'threeQuarter':
          return `two small BLACK dots in the head area offset toward the silhouette's ${oppSide} half (eyes)`;
        case 'profile':
          return `ONE small BLACK dot near the silhouette's ${oppSide} edge of the head (eye)`;
        case 'back':
          return 'NO eye dots — back-of-head only';
        default:
          return null;
      }
    })();
    const markerLine = markerSpec ? `\n    Eye markers (inside the head area): ${markerSpec}.` : '';
    return `- ONE ${c.colorName || ''} silhouette (${c.color}): ${c.name}, ${posHint}, ${poseLabel}${actionClause}. Size: ${sizeHint}.${markerLine}`;
  }).join('\n');
}

/**
 * Anonymous-cast variant of buildCastLines: same structural data (position,
 * pose, action, size, eye markers) but with the character's NAME and ACTION
 * stripped. Used in Stratified Composite step 1 so Grok has no name handle
 * for the front-stratum figures — the prompt refers to them by colour only.
 * Names + actions are reserved for step 3 where the real figures get drawn.
 */
function buildAnonymousCastLines(cast) {
  return cast.map((c) => {
    const sizeHint = c.sizeHint || 'about two-thirds the size of the largest figure';
    const posHint = c.position || 'in the scene';
    const direction = c.flip ? 'facing right' : 'facing left';
    const poseLabel = {
      front:        'front view, body facing the camera',
      threeQuarter: `three-quarter view, ${direction}`,
      profile:      `profile view, ${direction}`,
      back:         'back view, viewer sees the back of the head',
    }[c.pose] || `three-quarter view, ${direction}`;
    const markerSpec = (() => {
      const oppSide = c.flip ? 'left' : 'right';
      switch (c.pose) {
        case 'front':        return 'two small BLACK dots side by side in the head area (eyes)';
        case 'threeQuarter': return `two small BLACK dots in the head area offset toward the silhouette's ${oppSide} half (eyes)`;
        case 'profile':      return `ONE small BLACK dot near the silhouette's ${oppSide} edge of the head (eye)`;
        case 'back':         return 'NO eye dots — back-of-head only';
        default:             return null;
      }
    })();
    const markerLine = markerSpec ? `\n    Eye markers (inside the head area): ${markerSpec}.` : '';
    return `- ONE ${c.colorName || ''} silhouette (${c.color}): ${posHint}, ${poseLabel}. Size: ${sizeHint}.${markerLine}`;
  }).join('\n');
}

/**
 * Filter a page-brief string in three passes:
 *   1. Paragraph pre-pass: drop paragraphs (separated by blank lines) that
 *      mention zero "keep" names AND zero "drop" names — these are generic
 *      boilerplate ("When the FIRST reference photo shows a real
 *      location...") that aren't useful here.
 *   2. Sentence filter: within each remaining paragraph, drop sentences
 *      that mention ONLY drop names. Sentences with no names at all are
 *      kept (they're scene context).
 *   3. Name substitution: in surviving sentences that still co-mention a
 *      drop name, replace the drop name with its substitute (e.g. the
 *      silhouette colour). Prevents leaked names from reaching Grok.
 *
 * @param {string} brief
 * @param {string[]} keepNames
 * @param {string[]} dropNames
 * @param {Object<string, string>} [substitutes] - map of dropName → replacement (e.g. {Noah: 'the red silhouette'})
 */
function filterBriefByStratum(brief, keepNames = [], dropNames = [], substitutes = {}) {
  if (!brief || typeof brief !== 'string') return '';
  const keep = keepNames.filter(Boolean).map(n => String(n));
  const drop = dropNames.filter(Boolean).map(n => String(n));
  if (drop.length === 0) return brief;

  const escape = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentions = (text, names) => {
    if (names.length === 0) return false;
    return names.some(n => new RegExp(`\\b${escape(n)}\\b`, 'i').test(text));
  };
  const substituteDropNames = (text) => {
    let out = text;
    for (const n of drop) {
      const sub = substitutes[n] || `the figure`;
      out = out.replace(new RegExp(`\\b${escape(n)}'s\\b`, 'gi'), `${sub}'s`);
      out = out.replace(new RegExp(`\\b${escape(n)}\\b`, 'gi'), sub);
    }
    return out;
  };

  // Step 1 — paragraph pre-pass. Paragraphs separated by `\n\n+`. A
  // paragraph that mentions zero names from either list is generic prose
  // and gets dropped.
  const paragraphs = brief.split(/\n{2,}/);
  const keptParagraphs = paragraphs.filter(p => {
    const t = p.trim();
    if (!t) return false;
    return mentions(t, keep) || mentions(t, drop);
  });

  // Step 2 + 3 — sentence filter + name substitution.
  const outParagraphs = [];
  for (const p of keptParagraphs) {
    const outLines = [];
    for (const line of p.split('\n')) {
      if (!line.trim()) { outLines.push(line); continue; }
      if (!mentions(line, drop)) { outLines.push(line); continue; }
      const sentences = line.split(/(?<=[.;!?])\s+/);
      const kept = [];
      for (const s of sentences) {
        const hasDrop = mentions(s, drop);
        if (!hasDrop) { kept.push(s); continue; }
        const hasKeep = mentions(s, keep);
        if (!hasKeep) continue; // drop sentence mentioning ONLY drop names
        kept.push(substituteDropNames(s));
      }
      if (kept.length > 0) outLines.push(kept.join(' '));
    }
    const joined = outLines.join('\n').trim();
    if (joined) outParagraphs.push(joined);
  }
  return outParagraphs.join('\n\n').trim();
}

/**
 * Slice a brief at a sentence-or-paragraph boundary to fit a budget. Avoids
 * the truncated-mid-sentence ("(e.g.") problem of a raw `.slice(0, n)`.
 */
function sliceBriefAtSentence(brief, maxChars) {
  if (!brief || brief.length <= maxChars) return brief || '';
  const slice = brief.slice(0, maxChars);
  // Prefer paragraph boundary if there's one in the last 25% of the slice.
  const lastBreak = Math.max(
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
    slice.lastIndexOf('!\n'),
    slice.lastIndexOf('?\n'),
  );
  if (lastBreak > maxChars * 0.5) {
    return slice.slice(0, lastBreak + 1).trim() + '\n[...]';
  }
  // Fallback: trim to the last whitespace.
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 0) return slice.slice(0, lastSpace).trim() + ' [...]';
  return slice.trim() + ' [...]';
}

/**
 * Build the populated-plate generate prompt. Single Grok text-to-image
 * call: paint the full scene WITH the coloured silhouettes already placed
 * in it. The setting + VB props + silhouettes are committed together, so
 * the later depopulate step can derive a self-consistent empty plate from
 * the same source.
 */
function buildPopulatedPlatePrompt(scene, cast, cleanBackgroundPrompt) {
  const lines = buildCastLines(cast);
  const settingBlock = (cleanBackgroundPrompt && cleanBackgroundPrompt.trim())
    || (scene?.description && String(scene.description).trim())
    || 'an outdoor scene';
  const sceneIntentBlock = scene?.intent
    ? `\nScene intent: ${String(scene.intent).trim()}\n`
    : '';

  return `Paint a single illustrated scene that contains ${cast.length} flat-colour silhouette figures placed inside it. Two priorities IN ORDER — when they conflict, the lower-numbered priority wins.

PRIORITY 1 — The setting, props, and lighting must read exactly as described. Render every named environment element, prop, and required object below in its correct position. Do NOT invent new props that are not described. This image is the canonical world plate — the silhouettes will be lifted out in a later step, so the setting must be self-consistent with or without people in it.

SETTING DESCRIPTION:
${settingBlock}
${sceneIntentBlock}
PRIORITY 2 — Place ${cast.length} flat-colour silhouette figures naturally so the scene makes physical sense. Use the cast entries below for size, depth and per-character action. Figures must stand on a SOLID surface visible in the scene (dock plank, floor, ground, rock, deck, path, stairs). NEVER position a silhouette with its feet on water or empty sky. Figures MAY overlap each other when the scene calls for it — partial occlusion is fine and natural.

${lines}

SILHOUETTE RENDERING DETAILS:
- Each silhouette is filled with FULLY SATURATED solid colour at the exact hex above — no gradient, no transparency, no watercolor wash, no shading on the silhouette itself.
- Small BLACK eye dot(s) inside the head area per the marker spec above (~5% of head width, pure #000000). Nothing else inside the silhouette.
- Size scales with depth: foreground largest, midground medium, background small.

NO TEXT in the output.`;
}

/**
 * Build the depopulate edit prompt. Input image is the populated plate;
 * remove every flat-colour silhouette and repaint the regions with the
 * surrounding scenery so the result is the same world, empty of people.
 * Every other pixel must remain identical — this is what anchors the
 * world geometry + VB props for the rest of the pipeline.
 */
function buildDepopulatePrompt(cast) {
  const colorList = cast
    .map(c => `${c.color}${c.colorName ? ` (${c.colorName})` : ''}`)
    .join(', ');
  return `Remove every flat-colour silhouette figure from this image and paint over each region with the surrounding scenery, so the result reads as the same scene empty of people.

The silhouettes to remove are these solid saturated colours: ${colorList}. Each one is a flat human-shaped block of solid colour with small black eye dots — painted on top of the scene.

DO:
- Replace each coloured silhouette area with the terrain visible around it — extend the floor, ground, dock, path, wall, water, foliage, sky, or interior background behind it so the patch blends naturally.
- Keep every other pixel of the scene pixel-identical. Sky, walls, named props, lighting, every detail of the setting must remain exactly as it is.

DO NOT:
- Add new characters, animals, or human figures of any kind.
- Restructure the scene — do not move, resize, recolour, or rebuild walls, props, sky, water, or any background element.
- Add, remove, or substitute any named prop or object in the scene.
- Add text, captions, numbers, or signatures.
- Leave any coloured residue, outline, or shadow where a silhouette stood — the patch must blend seamlessly with the surrounding scene.

The output is the same scene as the input, empty of people, identical in every other respect.`;
}

// Art-style descriptors — must stay aligned with character2x4Sheet.js ART_STYLE_LINES.
const BLEND_STYLE_LINES = {
  watercolor:   "soft watercolor children's storybook illustration style — gentle washes, simple outlines",
  pixar:        "Pixar 3D illustration style — smooth shading, clean rim light",
  anime:        "anime line-art style — clean lines, flat shading",
  cartoon:      "modern flat cartoon, bold outlines, clean shapes",
  oil:          "oil painting style with visible brushwork",
};

// Grok's edit endpoint caps prompts at 8000 chars. Reserve ~300 char
// headroom so future tweaks to the boilerplate don't silently re-blow
// the budget. The boilerplate below is ~2400 chars; that leaves the
// brief ~5300 chars of room.
const BLEND_PROMPT_HARD_CAP = 7700;

function buildBlendEditPrompt(scene) {
  const styleLine = BLEND_STYLE_LINES[scene.artStyle] || BLEND_STYLE_LINES.watercolor;
  const brief = (scene.pageBrief || '').trim();
  const briefHeader = `\n\nPAGE BRIEF — these blocks define the canonical look of every character, costume, object, and pose in this scene. The composited image (Image 1) is already staged correctly; the brief tells you WHAT each silhouette is supposed to look like once blended. Image 2 (when provided) is the labelled portrait grid — use it as the authoritative face/clothing reference.\n\n`;
  const boilerplate = `Refine Image 1 into a single cohesive children's book illustration in ${styleLine}.

Image 1 (THIS IMAGE) already contains real characters pasted onto a clean scene background. The characters are at the correct positions, sizes, and body directions. Your job is to BLEND them into the scene and ADD any REQUIRED OBJECTS that the brief names but the staged composite is missing.

DO:
- Harmonise the lighting on each character so it matches the scene's light direction and colour temperature.
- Soften pasted cutout edges so they read as painted, not stickered.
- Add a subtle ground shadow under each character's feet, consistent with the scene light.
- ADD every REQUIRED OBJECT named in the brief that is missing from the staged scene — render each one according to its description, placed where the EXACT POSES say a character interacts with it (e.g. a "treasure chest" the brief names should appear at the feet / in front of the character whose pose says "leans over the chest"; a "parchment map" should appear in the hands of the character whose pose says "holds the map between both hands"). Make these objects look like they belong in the scene's lighting and style.
- If any solid red, blue, green, orange, magenta or yellow outlines or fringes are visible around or beneath a character (silhouette residue from the blocking step), paint over them with the surrounding scene colour. The final image must contain NO solid-colour outlines.

DO NOT:
- Move, resize, rotate, mirror, or change the facing direction of any character — their pixel position and pose are already correct.
- Add, remove, or substitute any character.
- Change any character's face, hair, age, body proportions, costume, or accessories — match the labelled portrait grid (Image 2) exactly.
- Add props or scenery that are NOT named in the brief — only required objects from the brief may be added.
- Restructure the underlying background scenery (architecture, geography, sky). Adding a named required object at the correct position is COMPLETING the scene, not restructuring it.
- Add text, captions, numbers, or signatures of any kind.`;

  // Tight cap: trim the brief if total prompt would exceed Grok's 8000-char
  // edit limit. The earlier 5500-char compositeBrief slice in regeneration.js
  // left no room for boilerplate when fully populated (8058 chars in
  // production smoke). Re-slice at the prompt builder so both the test-
  // models route AND the main pipeline are protected.
  const fixedLen = boilerplate.length + (brief ? briefHeader.length : 0);
  const briefRoom = Math.max(0, BLEND_PROMPT_HARD_CAP - fixedLen);
  const trimmedBrief = brief.length > briefRoom ? brief.slice(0, briefRoom).trim() + '\n[...]' : brief;
  const briefBlock = trimmedBrief ? `${briefHeader}${trimmedBrief}` : '';
  const full = `${boilerplate}${briefBlock}`;
  if (full.length > 8000) {
    log.warn(`[SCENE COMPOSITE] blend prompt at ${full.length} chars after trim — still over Grok's 8000 limit (brief input was ${brief.length})`);
  }
  return full;
}

// ─── Stratified-composite helpers ─────────────────────────────────────────

/**
 * Stitch the 2×4 sheets of every cast entry into a single horizontal strip
 * with a name label below each panel. Used as a Grok edit reference to
 * anchor character identities when the prompt names them.
 *
 * @param {Array<Object>} cast - entries with `name` and `sheetBuf` (Buffer).
 * @param {Object} [options]
 * @param {number} [options.targetHeight=512] - panel height in px.
 * @param {number} [options.labelHeight=32]  - black label bar height.
 * @returns {Promise<string>} data URI of the stitched pack (jpeg).
 */
async function buildIdentityPack(cast, options = {}) {
  const { targetHeight = 512, labelHeight = 32, aspectRatio = null, cropMode = 'full' } = options;
  if (!Array.isArray(cast) || cast.length === 0) return null;

  // Resize every sheet to the same height; collect dims + raw buffers.
  // cropMode='body' picks just the body cell matching the char's pose so
  // the identity pack is much smaller and binds tighter (no head-only cells
  // distracting Grok). cropMode='full' keeps the original 2×4 sheet.
  const panels = [];
  for (const c of cast) {
    if (!c.sheetBuf || !Buffer.isBuffer(c.sheetBuf)) continue;
    let srcBuf = c.sheetBuf;
    if (cropMode === 'body') {
      const cell = POSE_CELL[c.pose] || POSE_CELL.threeQuarter;
      try {
        srcBuf = await cropSheetCell(c.sheetBuf, cell);
      } catch (err) {
        log.warn(`[STRATIFIED] cropSheetCell failed for ${c.name}: ${err.message} — falling back to full sheet`);
      }
    }
    const resized = await sharp(srcBuf)
      .resize({ height: targetHeight, withoutEnlargement: false })
      .toBuffer({ resolveWithObject: true });
    panels.push({ buf: resized.data, w: resized.info.width, h: resized.info.height, name: c.name });
  }
  if (panels.length === 0) return null;

  // Build a label image (black bar with white text) for each panel using SVG.
  const labelled = [];
  for (const p of panels) {
    const svg = Buffer.from(
      `<svg width="${p.w}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${p.w}" height="${labelHeight}" fill="#000"/>
        <text x="${p.w / 2}" y="${labelHeight / 2 + 6}" font-family="sans-serif" font-size="18" font-weight="bold" fill="#fff" text-anchor="middle">${(p.name || '').replace(/[<>&]/g, '')}</text>
      </svg>`
    );
    const stacked = await sharp({
      create: { width: p.w, height: p.h + labelHeight, channels: 3, background: '#ffffff' },
    })
      .composite([
        { input: p.buf, top: 0, left: 0 },
        { input: svg, top: p.h, left: 0 },
      ])
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    labelled.push({ buf: stacked.data, w: stacked.info.width, h: stacked.info.height });
  }

  // Horizontal stitch.
  const totalW = labelled.reduce((acc, p) => acc + p.w, 0);
  const maxH = labelled.reduce((acc, p) => Math.max(acc, p.h), 0);
  let x = 0;
  const composites = labelled.map((p) => {
    const c = { input: p.buf, top: 0, left: x };
    x += p.w;
    return c;
  });
  let out = await sharp({
    create: { width: totalW, height: maxH, channels: 3, background: '#ffffff' },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toBuffer();

  // Pre-pad to the caller's target aspect ratio so Grok's input aspect
  // cropper (cover-crop in editWithGrok) doesn't slice off the side panels.
  // The pack is on a white background so the extension is invisible.
  if (aspectRatio) {
    const [aW, aH] = String(aspectRatio).split(':').map(Number);
    if (aW > 0 && aH > 0) {
      const target = aW / aH;
      const current = totalW / maxH;
      if (Math.abs(current - target) / target > 0.01) {
        let padW = 0, padH = 0;
        if (current > target) {
          // pack is wider than target → grow height (pad top+bottom)
          padH = Math.round(totalW / target) - maxH;
        } else {
          // pack is taller than target → grow width (pad left+right)
          padW = Math.round(maxH * target) - totalW;
        }
        out = await sharp(out)
          .extend({
            top: Math.floor(padH / 2),
            bottom: Math.ceil(padH / 2),
            left: Math.floor(padW / 2),
            right: Math.ceil(padW / 2),
            background: '#ffffff',
          })
          .jpeg({ quality: 88 })
          .toBuffer();
      }
    }
  }
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

// ─── Stratified-composite prompt builders ─────────────────────────────────

/**
 * Per-character prose line for a real character (no silhouette colour).
 * Grok renders them using the reference sheet image that ships alongside
 * the prompt. Used for the foreground stratum in the new pipeline.
 */
function buildBackCharLines(cast) {
  return cast.map((c) => {
    const sizeHint = c.sizeHint || (c.depth === 'background' ? 'small in the distance' : 'medium, closer to camera');
    const posHint = c.position || 'in the scene';
    const direction = c.flip ? 'facing right' : 'facing left';
    const poseLabel = {
      front:        'front view, body facing the camera',
      threeQuarter: `three-quarter view, ${direction}`,
      profile:      `profile view, ${direction}`,
      back:         'back view, viewer sees the back of the head',
    }[c.pose] || `three-quarter view, ${direction}`;
    const actionClause = c.action ? `, ${c.action}` : '';
    return `- ${c.name}: ${posHint}, ${poseLabel}${actionClause}. Size: ${sizeHint}. Match the matching reference sheet for face, hair, and clothing.`;
  }).join('\n');
}

/**
 * Anchor-plate prompt for Stratified Composite. Renders the scene with:
 *   - back-stratum characters drawn as real characters (prose, no colour)
 *   - front-stratum characters as the existing flat-colour silhouettes
 * Reference images shipped alongside: one 2×4 sheet per back-stratum char,
 * so Grok knows who they are without consuming a front-stratum cutout pass.
 */
// Grok edit/generate endpoint hard limit is 8000 chars. Leave 300 char
// headroom so future prompt tweaks don't silently re-blow the budget.
const STRATIFIED_PROMPT_HARD_CAP = 7700;

// Foreground-first anchor-plate prompt. Renders the FRONT stratum
// (closer-to-camera characters) as REAL characters using the identity pack,
// and places the BACK stratum (farther characters) as flat-colour
// silhouettes. Replaces the previous order which rendered the back stratum
// real and placed the front as silhouettes — Grok was pulling silhouettes
// to the back of the scene, which gave wrong z-order on the composite.
//
// In the new flow:
//   step 1: foreground real + background silhouettes
//   step 2: silhouettes → real (background characters)
//   step 3: layered composite — empty scene → real back → real front
function buildAnchorPlatePrompt(scene, frontCast, backCast, cleanBackgroundPrompt, hasIdentityPack = false) {
  const frontNames = frontCast.map(c => c.name).filter(Boolean);
  const backNames = backCast.map(c => c.name).filter(Boolean);
  // For substitution, refer to back chars (the silhouettes here) by their
  // silhouette colour name. Front chars are rendered as real so their names
  // stay in the prompt.
  const backSubs = Object.fromEntries(
    backCast.map(c => [c.name, `the ${c.colorName || (c.color || 'coloured').toLowerCase()} silhouette`])
  );
  const settingBlock = (cleanBackgroundPrompt && cleanBackgroundPrompt.trim())
    || (scene?.description && String(scene.description).trim())
    || 'an outdoor scene';
  // Scene intent gets the stratum filter — drop sentences naming only
  // back-stratum chars (the silhouettes); substitute back names with their
  // silhouette colour in co-mention sentences. Front-stratum chars (the
  // real ones) keep their names.
  const filteredIntent = scene?.intent
    ? filterBriefByStratum(String(scene.intent).trim(), frontNames, backNames, backSubs)
    : '';
  const sceneIntentBlock = filteredIntent ? `\nScene intent: ${filteredIntent}\n` : '';
  const refsBlock = hasIdentityPack
    ? `\nINPUT IMAGES:\n- Image 1: empty scene canvas. Paint your output ON TOP of it — keep its setting, lighting, and named props intact.\n- Image 2: labelled identity pack — one body panel per FOREGROUND character with the name on a black bar below. Match each foreground character's face, hair, and clothing to the matching panel.\n`
    : '';
  // Substitute back-character names inside front-cast entries' free-text
  // fields (position + action). Scene-expansion can write "Noah stands
  // beside Daniel" — Noah is the foreground char (real, name OK), but
  // Daniel is the back stratum (silhouette now) so his name leaks.
  const subBackNames = (s) => {
    if (!s) return s;
    let out = s;
    for (const bc of backCast) {
      const n = bc.name;
      if (!n) continue;
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sub = `the ${bc.colorName || (bc.color || 'coloured').toLowerCase()} silhouette`;
      out = out.replace(new RegExp(`\\b${esc}'s\\b`, 'gi'), `${sub}'s`);
      out = out.replace(new RegExp(`\\b${esc}\\b`, 'gi'), sub);
    }
    return out;
  };
  const sanitisedFrontCast = frontCast.map(c => ({ ...c, position: subBackNames(c.position), action: subBackNames(c.action) }));
  const frontBlock = frontCast.length > 0
    ? `FOREGROUND (real characters, painted INTO the scene, closer to camera) — render these ${frontCast.length} character(s) using the identity pack for face/hair/clothing. These foreground figures sit IN FRONT of any silhouettes they overlap; paint them ON TOP, occluding background silhouettes wherever they cross.\n\n${buildBackCharLines(sanitisedFrontCast)}\n`
    : '';
  const backBlock = backCast.length > 0
    ? `BACKGROUND (silhouette placeholders, farther from camera, BEHIND the foreground) — paint ${backCast.length} flat-colour silhouette shape(s) on the scene, at the back of the cast layout. The foreground characters above will be drawn IN FRONT of these silhouettes — wherever a foreground character overlaps a silhouette, the foreground character wins (paint over the silhouette). The silhouettes are NOT real characters; they are pure solid-colour cutouts with no face, no clothing, no hair detail, no shading. They mark where real background characters will be inset in a later step.\n\n${buildAnonymousCastLines(backCast)}\n\nSILHOUETTE RENDERING DETAILS:\n- Flat human-shaped block filled with FULLY SATURATED solid colour at the exact hex above — no gradient, no transparency, no shading, no skin tone, no face, no hair texture, no clothing texture.\n- Small BLACK eye dot(s) inside the head per the marker spec above.\n- A correctly drawn silhouette looks like a paper cutout pasted onto the scene.`
    : '';
  const totalCount = frontCast.length + backCast.length;

  const briefHeader = `\nPAGE BRIEF (foreground characters only) — canonical descriptions of the foreground characters, costumes, props, and required objects. All mentions of the background silhouette characters have been replaced with their silhouette colour reference; do not render them as real characters here.\n\n`;
  const head = `Paint a single illustrated scene. ${frontCast.length} FOREGROUND character(s) rendered as real people closer to camera; ${backCast.length} BACKGROUND silhouette placeholder(s) drawn behind them. Two priorities IN ORDER — when they conflict, the lower-numbered priority wins.
${refsBlock}
PRIORITY 1 — Setting + lighting + named props must match the description. This image is the canonical world plate. Do NOT invent props that are not described.

SETTING:
${settingBlock}
${sceneIntentBlock}
PRIORITY 2 — Cast placement. Characters stand on a SOLID surface visible in the scene. Foreground REAL characters are IN FRONT of background silhouettes when they overlap — paint real characters over silhouettes.

${frontBlock}
${backBlock}`;
  const tail = `\nNO TEXT in the output.`;
  const rawBrief = scene?.pageBrief ? String(scene.pageBrief).trim() : '';
  const filteredBrief = filterBriefByStratum(rawBrief, frontNames, backNames, backSubs);
  const fixedLen = head.length + tail.length + (filteredBrief ? briefHeader.length + 1 : 0);
  const briefRoom = Math.max(0, STRATIFIED_PROMPT_HARD_CAP - fixedLen);
  const trimmedBrief = sliceBriefAtSentence(filteredBrief, briefRoom);
  const briefBlock = trimmedBrief ? `${briefHeader}${trimmedBrief}\n` : '';
  const full = `${head}${briefBlock}${tail}`;
  if (full.length > 8000) {
    log.warn(`[SCENE COMPOSITE/STRATIFIED] anchor prompt ${full.length} chars after trim — still over 8000 (brief input ${rawBrief.length}, filtered ${filteredBrief.length}, fixed ${fixedLen})`);
  }
  return full;
}

/**
 * Depopulate only the front-stratum silhouettes. Back-stratum characters
 * (drawn as real characters on the anchor plate) must be preserved.
 */
function buildFrontDepopulatePrompt(frontCast) {
  const colorList = frontCast
    .map(c => `${c.color}${c.colorName ? ` (${c.colorName})` : ''}`)
    .join(', ');
  return `Remove every flat-colour silhouette figure from this image and paint over each region with the surrounding scenery, so the result reads as the same scene with the silhouettes erased.

The silhouettes to remove are these solid saturated colours: ${colorList}. Each one is a flat human-shaped block of solid colour with small black eye dots — painted on top of the scene.

DO:
- Replace each coloured silhouette area with the terrain visible around it — extend the floor, ground, dock, path, wall, water, foliage, sky, or interior background behind it so the patch blends naturally.
- PRESERVE every other character drawn in the scene. Any real (non-silhouette) character must remain whole — if a silhouette partially overlaps a real character, restore the hidden parts of that character from what is visible around the overlap so they read as complete figures.
- Keep every other pixel of the scene pixel-identical. Sky, walls, named props, lighting, every detail of the setting must remain exactly as it is.

DO NOT:
- Add new characters, animals, or human figures of any kind.
- Restructure the scene — do not move, resize, recolour, or rebuild walls, props, sky, water, or any background element.
- Add, remove, or substitute any named prop or object in the scene.
- Add text, captions, numbers, or signatures.
- Leave any coloured residue, outline, or shadow where a silhouette stood — the patch must blend seamlessly with the surrounding scene.

The output is the same scene as the input, with only the coloured silhouettes removed. Every real character drawn into the scene must remain in place and intact.`;
}

/**
 * Front-figure-plate prompt. Replaces each colour silhouette on the anchor
 * plate with the corresponding real character from the reference sheets.
 * Reference images shipped alongside: anchor plate first, then one 2×4
 * sheet per front-stratum character.
 */
function buildFrontInsetPrompt(frontCast, scene, hasIdentityPack = false, backCast = []) {
  const colorList = frontCast
    .map(c => `- ${c.color}${c.colorName ? ` (${c.colorName})` : ''} silhouette → ${c.name}`)
    .join('\n');
  const refsBlock = hasIdentityPack
    ? `\nINPUT IMAGES:\n- Image 1: flat-colour silhouettes on a pure WHITE background (#FFFFFF, RGB 255,255,255 — fully saturated white, NOT cream, NOT off-white, NOT light grey). Each silhouette marks where a character must be drawn IN THE OUTPUT. The number, positions, and sizes of silhouettes in Image 1 are binding — the OUTPUT must contain EXACTLY the same number of characters at EXACTLY the same positions/sizes/orientations as the silhouettes in Image 1. EVERY pixel outside the silhouettes in the OUTPUT must be pure white #FFFFFF — no gradient, no soft grey edge, no studio backdrop, no shadow on the floor. This output will be alpha-composited onto a separate scene afterward, so any non-white pixel outside the characters becomes a visible artefact.\n- Image 2: labelled identity pack — one body panel per character with the character's name on a BLACK BAR BELOW the panel. Image 2 is for IDENTITY REFERENCE ONLY: it tells you which name maps to which face/clothing. DO NOT COPY the black name bars, the labels, or the side-by-side identity-pack layout into the output. The output must look like Image 1 with each silhouette replaced by a real character — NOT like Image 2.\n`
    : '';
  const head = `Replace each flat-colour silhouette in Image 1 with the corresponding REAL character. Keep the rest of Image 1 as PURE WHITE #FFFFFF (RGB 255,255,255) — not cream, not light grey, not a studio backdrop, not a soft shadow. The characters will be composited onto a separate scene afterward; any pixel that isn't pure white outside the character bodies becomes a visible halo in the final image.
${refsBlock}
Silhouette → character mapping:
${colorList}

DO:
- For each silhouette, draw the real character occupying the same bounding region: same height, same foot position, same body direction. Face, hair, and clothing must match the identity pack panel and the page brief.
- All ${frontCast.length} characters appear in ONE image together — share lighting, eye-line continuity, and pose interactions implied by their relative positions.
- Outside the character bodies: every pixel is PURE WHITE #FFFFFF. No grey, no cream, no studio backdrop, no shadow on the floor under the characters, no soft halo around them — pure 255,255,255 right up to the body edge.

DO NOT:
- Move, resize, rotate, or flip any character relative to where its silhouette sits in Image 1.
- Add, remove, or substitute any character beyond replacing the listed silhouettes.
- Paint a scene, background, ground, or sky around the characters — those exist on the separate plate they will be composited onto.
- Add text, captions, numbers, signatures, name labels, or the BLACK NAME BARS from Image 2. The output has NO labels and NO text anywhere.
- Copy Image 2's side-by-side identity-pack layout. The output's character positions come from Image 1's silhouettes, NOT Image 2.
- Leave any flat-colour residue from the silhouettes — they must be fully replaced by rendered characters.`;
  const tail = `\nThe output is Image 1 with each coloured silhouette replaced by the matching real character, rendered together in one cohesive scene.`;
  const backNames = backCast.map(c => c.name).filter(Boolean);
  const frontNames = frontCast.map(c => c.name).filter(Boolean);
  // For sentences that co-mention a back name, substitute it with a neutral
  // "a background figure" so Grok doesn't try to redraw the back character.
  const backSubs = Object.fromEntries(backNames.map(n => [n, 'a background figure']));
  const briefHeader = `\nPAGE BRIEF (foreground characters only) — canonical descriptions of the foreground characters and their costumes. Use these (with the identity pack) for face, hair, clothing.\n\n`;
  const rawBrief = scene?.pageBrief ? String(scene.pageBrief).trim() : '';
  const filteredBrief = filterBriefByStratum(rawBrief, frontNames, backNames, backSubs);
  const fixedLen = head.length + tail.length + (filteredBrief ? briefHeader.length + 1 : 0);
  const briefRoom = Math.max(0, STRATIFIED_PROMPT_HARD_CAP - fixedLen);
  const trimmedBrief = sliceBriefAtSentence(filteredBrief, briefRoom);
  const briefBlock = trimmedBrief ? `${briefHeader}${trimmedBrief}\n` : '';
  const full = `${head}${briefBlock}${tail}`;
  if (full.length > 8000) {
    log.warn(`[SCENE COMPOSITE/STRATIFIED] front-inset prompt ${full.length} chars after trim — still over 8000 (brief input ${rawBrief.length}, filtered ${filteredBrief.length}, fixed ${fixedLen})`);
  }
  return full;
}

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Generate a page image using the scene composite pipeline.
 *
 * @param {Object} opts
 * @param {string} opts.cleanBackgroundPrompt - prose for the empty scene (no people).
 * @param {Object} opts.scene - { description, action } — used in prompts.
 * @param {Array<Object>} opts.cast - per-character entries:
 *     { name, sheetBuf, pose: 'front'|'threeQuarter'|'profile'|'back',
 *       flip: boolean, description?, position?, sizeHint?, color?, colorName? }
 *   `sheetBuf` is a Buffer of the character's 2×4 sheet PNG.
 *   `color` is optional — auto-assigned from DEFAULT_PALETTE if missing.
 * @param {string} [opts.aspectRatio='16:9']
 * @param {Function} [opts.usageTracker] - (provider, usage, fn, modelId) => void
 * @returns {Promise<{ imageData: string, usage: Object, debug: Object }>}
 *   imageData is a data URI.
 */
async function generateSceneComposite(opts) {
  // Dispatch: 'stratified' (default) renders back-stratum chars natively in
  // the anchor plate and insets only the front stratum. 'uniform' is the
  // original silhouette-for-everyone pipeline kept available for A/B compare.
  const strategy = opts.compositeStrategy || 'stratified';
  if (strategy === 'stratified') {
    return generateStratifiedComposite(opts);
  }
  if (strategy !== 'uniform') {
    throw new Error(`unknown compositeStrategy: ${strategy} (expected 'stratified' | 'uniform')`);
  }

  const {
    cleanBackgroundPrompt,
    existingCleanBackground = null,
    scene = {},
    cast = [],
    aspectRatio = '16:9',
    usageTracker = null,
    visualBibleGridImage = null,
    // Per-call override for the phantom-pose render technique. When true,
    // step 3 renders each character in their phantom's pose via an extra
    // Grok edit call (full 2×4 sheet + cropped phantom) before pasting,
    // instead of cutting a static standing cell from the 2×4 sheet.
    // Default reads from MODEL_DEFAULTS.phantomPoseRender (false).
    phantomPoseRender = false,
  } = opts;

  if (!cleanBackgroundPrompt && !scene?.description) {
    throw new Error('cleanBackgroundPrompt or scene.description required');
  }
  if (!Array.isArray(cast) || cast.length === 0) throw new Error('cast must be non-empty');

  if (existingCleanBackground) {
    log.info('[SCENE COMPOSITE] existingCleanBackground passed — ignored in populated-plate-first pipeline (clean BG is now derived from the populated plate).');
  }

  // Assign colours to any cast entry missing one
  const usedColors = new Set(cast.map((c) => c.color).filter(Boolean));
  let nextColorIdx = 0;
  for (const c of cast) {
    if (c.color) continue;
    while (usedColors.has(DEFAULT_PALETTE[nextColorIdx]) && nextColorIdx < DEFAULT_PALETTE.length) {
      nextColorIdx++;
    }
    if (nextColorIdx >= DEFAULT_PALETTE.length) {
      throw new Error(`out of default palette colours (cast has ${cast.length} characters)`);
    }
    c.color = DEFAULT_PALETTE[nextColorIdx++];
    usedColors.add(c.color);
  }
  for (const c of cast) {
    if (!c.sheetBuf || !Buffer.isBuffer(c.sheetBuf)) {
      throw new Error(`cast[${c.name}].sheetBuf must be a Buffer`);
    }
    if (!POSE_CELL[c.pose]) throw new Error(`cast[${c.name}].pose invalid: ${c.pose}`);
  }

  const debug = {};
  let totalCost = 0;

  // ── Step 1/5: populated plate (Grok generate)
  // Paint the full scene + silhouettes in one text-to-image call. Replaces
  // the old "empty BG then Grok-edit silhouettes onto it" pair — that flow
  // let the blocking edit drift the background (added a bench, swapped a
  // VB prop, repainted the floor) so the empty plate no longer matched
  // the silhouette plate.
  log.info(`[SCENE COMPOSITE] step 1/5 — populated plate (generate; ${cast.length} cast)`);
  const populatedPrompt = buildPopulatedPlatePrompt(scene, cast, cleanBackgroundPrompt);
  const populated = await generateWithGrok(populatedPrompt, { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', populated.usage, 'scene_composite_populated_plate', populated.modelId);
  totalCost += populated.usage?.cost || 0;
  const populatedBuf = Buffer.from(populated.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  debug.populatedPlate = populated.imageData;
  debug.populatedPlatePrompt = populatedPrompt;
  // sentToGrok comes verbatim from the Grok API wrapper — every byte +
  // every prompt char captured at the call site. The dev panel reads this
  // instead of synthesising its own snapshot.
  debug.populatedPlateSentToGrok = populated.sentToGrok || null;
  // Back-compat aliases so existing dev panels keep showing the same fields.
  debug.blocking = populated.imageData;
  debug.blockingPrompt = populatedPrompt;

  // ── Step 2/5: depopulate to derive the clean BG (Grok edit)
  // Done BEFORE bbox detection so the diff-based detector has both images.
  log.info('[SCENE COMPOSITE] step 2/5 — depopulate (derive clean BG)');
  const depopulatePrompt = buildDepopulatePrompt(cast);
  const depopulated = await editWithGrok(depopulatePrompt, [populated.imageData], { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', depopulated.usage, 'scene_composite_depopulate', depopulated.modelId);
  totalCost += depopulated.usage?.cost || 0;
  const bgImageData = depopulated.imageData;
  const bgBuf = Buffer.from(bgImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  debug.cleanBackground = bgImageData;
  debug.cleanBackgroundPrompt = cleanBackgroundPrompt || null;
  debug.cleanBackgroundSource = 'derived-from-populated-plate';
  debug.depopulatePrompt = depopulatePrompt;
  debug.depopulateSentToGrok = depopulated.sentToGrok || null;

  // ── Step 3/5: detect silhouettes by diffing populated against clean BG.
  // Hue matching alone fails on palette collisions (e.g. yellow silhouette
  // on a yellow lawn — see story job_1778865205295_c2n86mdmn p4). The diff
  // mask removes the background palette entirely before hue runs.
  log.info('[SCENE COMPOSITE] step 3/5 — diff-based bbox detect');
  const detection = await findSilhouettesByDiff(populatedBuf, bgBuf, cast);
  const bboxes = {};
  const silhouetteMasks = {};
  for (const c of cast) {
    const r = detection.results[c.name];
    if (!r) {
      log.warn(`[SCENE COMPOSITE] no silhouette for ${c.name} (${c.color}) — diff+hue found nothing`);
      continue;
    }
    bboxes[c.name] = r.bbox;
    silhouetteMasks[c.name] = r.mask;
    log.info(`[SCENE COMPOSITE]   ${c.name} (${c.color}): bbox ${r.bbox.width}×${r.bbox.height} @ (${r.bbox.x},${r.bbox.y}) [${r.bbox.pixels} px]; cell ${POSE_CELL[c.pose]} (${c.pose})${c.flip ? ' flipped' : ''}`);
  }
  if (Object.keys(bboxes).length === 0) {
    throw new Error('[SCENE COMPOSITE] no silhouettes detected — diff+hue found nothing for any cast entry');
  }
  debug.bboxes = bboxes;
  log.info(`[SCENE COMPOSITE]   diff mask: ${detection.diffMaskCount} px (${(100 * detection.diffMaskCount / (detection.canvasWidth * detection.canvasHeight)).toFixed(1)}% of canvas)`);

  // ── Step 4/5: composite character cutouts onto the derived clean BG
  log.info(`[SCENE COMPOSITE] step 4/5 — composite cutouts${phantomPoseRender ? ' (phantom-pose render ON)' : ''}`);
  const placements = [];
  const phantomPoseRenders = {};
  for (const c of cast) {
    const bbox = bboxes[c.name];
    if (!bbox) continue;

    // Source the character cutout. Two paths:
    //   - phantom-pose render (flag on): Grok renders the character in the
    //     phantom's pose from the full 2×4 sheet + cropped phantom. No flip
    //     needed afterwards — the pose already encodes facing direction.
    //   - static cell (default): cut the matching cell from the 2×4 sheet,
    //     flip if the cast entry asks for the opposite facing direction.
    let cutBuf;
    let usedPhantomPose = false;
    if (phantomPoseRender) {
      try {
        // Pass the per-character silhouette mask so cropPhantom can repaint
        // every non-target pixel (other silhouettes AND any palette-colliding
        // background) with derived clean-BG pixels — Grok then sees ONLY the
        // target's silhouette plus the surrounding scene context.
        const ppr = await renderCharacterInPhantomPose({
          charSheet2x4: c.sheetBuf,
          blockingImageBuf: populatedBuf,
          bbox,
          charName: c.name,
          colorName: c.colorName,
          action: c.action,
          aspectRatio: '9:16',
          model: GROK_MODELS.STANDARD,
          usageTracker,
          cleanBgBuf: bgBuf,
          silhouetteMask: silhouetteMasks[c.name],
          canvasWidth: detection.canvasWidth,
          canvasHeight: detection.canvasHeight,
        });
        totalCost += ppr.usage?.cost || 0;
        phantomPoseRenders[c.name] = { ...ppr.debug, output: ppr.imageData };
        const renderedBuf = Buffer.from(
          ppr.imageData.replace(/^data:image\/\w+;base64,/, ''),
          'base64',
        );
        cutBuf = await removeBackground(renderedBuf);
        cutBuf = await trimTransparent(cutBuf);
        usedPhantomPose = true;
      } catch (err) {
        log.warn(`[SCENE COMPOSITE] phantom-pose render failed for ${c.name}: ${err.message} — falling back to static cell`);
      }
    }
    if (!usedPhantomPose) {
      const cellBuf = await cropSheetCell(c.sheetBuf, POSE_CELL[c.pose]);
      cutBuf = await removeBackground(cellBuf);
      cutBuf = await trimTransparent(cutBuf);
      if (c.flip) cutBuf = await flipHorizontal(cutBuf);
    }
    const scaled = await scaleToHeight(cutBuf, bbox.height);

    const sMeta = await sharp(scaled).metadata();
    const cx = bbox.x + Math.floor(bbox.width / 2);
    const bottomY = bbox.y + bbox.height;
    const left = Math.max(0, cx - Math.floor(sMeta.width / 2));
    const top = Math.max(0, bottomY - sMeta.height);
    placements.push({
      input: scaled, left, top,
      _footY: bottomY, _name: c.name, _color: c.color, _bbox: bbox,
    });
  }
  if (Object.keys(phantomPoseRenders).length > 0) debug.phantomPoseRenders = phantomPoseRenders;

  if (placements.length === 0) {
    throw new Error('[SCENE COMPOSITE] no characters placed — bbox detection failed for every cast entry');
  }

  // Z-order: read Grok's actual painted occlusion off the populated plate.
  // For each pair whose bboxes overlap, the character with significantly more
  // saturated pixels of its colour in the intersection rect is the one in
  // front (Grok painted over the other where they occlude). foot-Y is the
  // tiebreaker for ambiguous / non-overlapping pairs.
  const zResult = await detectZOrderByOcclusion(populatedBuf, placements);
  placements.length = 0;
  placements.push(...zResult.order);
  debug.zScores = zResult.scores;
  debug.zDecisions = zResult.decisions;
  for (const d of zResult.decisions) {
    log.info(`[SCENE COMPOSITE]   occlusion ${d.a} vs ${d.b}: ${d.a}=${d.aPx}px ${d.b}=${d.bPx}px → ${d.winner} in front`);
  }
  log.info(`[SCENE COMPOSITE]   z-order (back → front): ${placements.map(p => `${p._name}[score=${zResult.scores[p._name]},foot=${p._footY}]`).join(' → ')}`);
  // Strip the auxiliary fields before handing to sharp — it only knows input/left/top.
  const compositeInputs = placements.map(({ input, left, top }) => ({ input, left, top }));

  const composited = await sharp(bgBuf).composite(compositeInputs).png().toBuffer();
  const compositedData = `data:image/png;base64,${composited.toString('base64')}`;
  debug.composited = compositedData;

  // ── Step 5/5: Grok edit blend pass
  log.info('[SCENE COMPOSITE] step 5/5 — blend pass');
  const blendPrompt = buildBlendEditPrompt(scene);
  debug.blendPrompt = blendPrompt;
  // VB grid as Image 2 — labelled portrait grid serves as the authoritative face /
  // clothing reference. The composited image stays as Image 1 (the canvas to refine).
  const blendRefs = visualBibleGridImage
    ? [compositedData, visualBibleGridImage]
    : [compositedData];
  debug.blendRefCount = blendRefs.length;
  const pass1 = await editWithGrok(blendPrompt, blendRefs, { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', pass1.usage, 'scene_composite_blend', pass1.modelId);
  totalCost += pass1.usage?.cost || 0;
  debug.blendSentToGrok = pass1.sentToGrok || null;

  log.info(`[SCENE COMPOSITE] complete — total cost $${totalCost.toFixed(4)}, ${placements.length}/${cast.length} characters placed`);

  return {
    imageData: pass1.imageData,
    usage: { cost: totalCost, direct_cost: totalCost, model: 'scene-composite' },
    debug,
  };
}

// ─── Stratified composite pipeline ────────────────────────────────────────

/**
 * Stratified Composite — render back-stratum characters natively in the
 * anchor plate, render front-stratum characters as one foreground figure
 * plate, crop them out, paste onto the depopulated back plate, blend.
 *
 * Same opts signature as generateSceneComposite (cast, scene, aspectRatio,
 * visualBibleGridImage, usageTracker, cleanBackgroundPrompt). Additional
 * opts:
 *   - backCast, frontCast: pre-split strata. When omitted, the function
 *     splits internally via splitCastByStratum from compositeCastBuilder.
 */
async function generateStratifiedComposite(opts) {
  const {
    cleanBackgroundPrompt,
    existingCleanBackground = null,
    scene = {},
    cast = [],
    aspectRatio = '16:9',
    usageTracker = null,
    visualBibleGridImage = null,
  } = opts;

  if (!cleanBackgroundPrompt && !scene?.description) {
    throw new Error('cleanBackgroundPrompt or scene.description required');
  }
  if (!Array.isArray(cast) || cast.length === 0) throw new Error('cast must be non-empty');

  // Split into strata. Caller may pre-split; otherwise compute here.
  let backCast = opts.backCast;
  let frontCast = opts.frontCast;
  if (!Array.isArray(backCast) || !Array.isArray(frontCast)) {
    const { splitCastByStratum } = require('./compositeCastBuilder');
    const split = splitCastByStratum(cast);
    backCast = split.backCast;
    frontCast = split.frontCast;
  }

  // BACK stratum needs flat colours for the silhouettes (they're the
  // placeholders in step 1). Front stratum is rendered as real characters
  // and doesn't need a colour. Assign colours to BACK only so we don't
  // exhaust the palette on front-half entries.
  const usedColors = new Set(backCast.map((c) => c.color).filter(Boolean));
  let nextColorIdx = 0;
  for (const c of backCast) {
    if (c.color) continue;
    while (usedColors.has(DEFAULT_PALETTE[nextColorIdx]) && nextColorIdx < DEFAULT_PALETTE.length) nextColorIdx++;
    if (nextColorIdx >= DEFAULT_PALETTE.length) {
      throw new Error(`out of default palette colours (back stratum has ${backCast.length} characters)`);
    }
    c.color = DEFAULT_PALETTE[nextColorIdx++];
    usedColors.add(c.color);
  }
  for (const c of backCast) {
    if (!POSE_CELL[c.pose]) throw new Error(`backCast[${c.name}].pose invalid: ${c.pose}`);
  }
  // Both strata need sheetBuf — front for step-1 identity pack, back for
  // step-2 identity pack.
  for (const c of [...frontCast, ...backCast]) {
    if (!c.sheetBuf || !Buffer.isBuffer(c.sheetBuf)) {
      throw new Error(`cast[${c.name}].sheetBuf must be a Buffer`);
    }
  }

  const debug = {
    strategy: 'stratified',
    backNames: backCast.map(c => c.name),
    frontNames: frontCast.map(c => c.name),
  };
  let totalCost = 0;

  log.info(`[STRATIFIED] cast split — back=[${backCast.map(c=>c.name).join(',')}] front=[${frontCast.map(c=>c.name).join(',')}]`);

  // Any throw inside the body re-emitted with the partial debug bundle
  // attached so the dev panel can still show what Grok produced up to the
  // point of failure (anchor plate, depopulate output, etc.).
  try {
    return await _stratifiedBody({ debug, totalCost, backCast, frontCast, existingCleanBackground, cleanBackgroundPrompt, scene, aspectRatio, usageTracker, visualBibleGridImage });
  } catch (err) {
    err.partialDebug = debug;
    throw err;
  }
}

async function _stratifiedBody(ctx) {
  let { debug, totalCost, backCast, frontCast, existingCleanBackground, cleanBackgroundPrompt, scene, aspectRatio, usageTracker, visualBibleGridImage } = ctx;

  // ── Step 0: empty-scene canvas
  // Stratified step 1 is a Grok EDIT so we can attach identity packs as
  // reference images. Edit needs Image 1 = a canvas. Reuse a saved
  // empty-scene plate when provided; otherwise generate one (extra call).
  let emptySceneData = null;
  let emptySceneSource = 'reused';
  if (existingCleanBackground && typeof existingCleanBackground === 'string' && existingCleanBackground.length > 0) {
    emptySceneData = existingCleanBackground.startsWith('data:')
      ? existingCleanBackground
      : `data:image/jpeg;base64,${existingCleanBackground}`;
    log.info('[SCENE COMPOSITE/STRATIFIED] step 0/5 — reusing existing clean background as canvas');
  } else {
    log.info('[SCENE COMPOSITE/STRATIFIED] step 0/5 — generating empty scene canvas');
    const emptyPrompt = `Paint a single illustrated scene with no people, no characters, no animals — just the setting, props, and lighting.\n\nSETTING DESCRIPTION:\n${(cleanBackgroundPrompt && cleanBackgroundPrompt.trim()) || scene?.description || 'an outdoor scene'}${scene?.intent ? `\n\nScene intent: ${String(scene.intent).trim()}` : ''}\n\nNO TEXT in the output. No human or animal figures of any kind.`;
    const emptyGen = await generateWithGrok(emptyPrompt, { aspectRatio, model: GROK_MODELS.STANDARD });
    if (usageTracker) usageTracker('grok', emptyGen.usage, 'scene_composite_strat_empty_scene', emptyGen.modelId);
    totalCost += emptyGen.usage?.cost || 0;
    emptySceneData = emptyGen.imageData;
    emptySceneSource = 'generated';
    debug.emptyScenePrompt = emptyPrompt;
    debug.emptySceneSentToGrok = emptyGen.sentToGrok || null;
  }
  debug.emptyScene = emptySceneData;
  debug.emptySceneSource = emptySceneSource;

  // ── Identity packs. Built once at page aspect; the editWithGrok call
  // for step 2 uses padInput:true so the cropper pads (instead of
  // cropping) to match the step-2 preset aspect — no characters get
  // sliced down the middle even when step 2's aspect is much narrower.
  const backIdentityPack = await buildIdentityPack(backCast, { aspectRatio, cropMode: 'body' });
  const frontIdentityPack = frontCast.length > 0
    ? await buildIdentityPack(frontCast, { aspectRatio, cropMode: 'body' })
    : null;
  if (backIdentityPack) debug.backIdentityPack = backIdentityPack;
  if (frontIdentityPack) debug.frontIdentityPack = frontIdentityPack;

  // ── Step 1/4: Anchor plate. FOREGROUND-FIRST: render FRONT stratum
  // (closer-to-camera chars) as REAL using the identity pack, place BACK
  // stratum (farther chars) as flat-colour silhouettes BEHIND the
  // foreground. Refs: [emptyScene, frontIdentityPack]. Back identity pack
  // is INTENTIONALLY omitted — Grok would render the silhouette stratum
  // as real characters if shown their faces, which breaks the silhouette
  // detection step.
  log.info(`[SCENE COMPOSITE/STRATIFIED] step 1/4 — anchor plate (front-real=${frontCast.length}, back-silhouettes=${backCast.length})`);
  const hasAnchorIdentity = !!frontIdentityPack;
  const anchorPrompt = buildAnchorPlatePrompt(scene, frontCast, backCast, cleanBackgroundPrompt, hasAnchorIdentity);
  const anchorRefs = [emptySceneData];
  if (frontIdentityPack) anchorRefs.push(frontIdentityPack);
  const anchor = await editWithGrok(anchorPrompt, anchorRefs, { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', anchor.usage, 'scene_composite_strat_anchor_plate', anchor.modelId);
  totalCost += anchor.usage?.cost || 0;
  const anchorBuf = Buffer.from(anchor.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  debug.anchorPlate = anchor.imageData;
  debug.anchorPlatePrompt = anchorPrompt;
  debug.anchorPlateSentToGrok = anchor.sentToGrok || null;
  // Back-compat aliases — existing dev panels read these names.
  debug.populatedPlate = anchor.imageData;
  debug.populatedPlatePrompt = anchorPrompt;
  debug.populatedPlateSentToGrok = anchor.sentToGrok || null;
  debug.blocking = anchor.imageData;
  debug.blockingPrompt = anchorPrompt;

  // N=1 short-circuit: only one character total, and they're rendered
  // natively in the anchor plate. No silhouettes to lift, no inset. Return
  // the anchor plate directly.
  if (backCast.length === 0) {
    log.info(`[SCENE COMPOSITE/STRATIFIED] short-circuit — back stratum empty; anchor plate is final ($${totalCost.toFixed(4)})`);
    return {
      imageData: anchor.imageData,
      usage: { cost: totalCost, direct_cost: totalCost, model: 'scene-composite-stratified' },
      debug,
    };
  }

  // ── Step 1.5: detect BACK-stratum silhouette bboxes on the anchor plate
  // — these are the placeholders we'll replace with real characters in
  // step 2. If Grok didn't paint the silhouettes at all, fail fast with
  // the anchor plate in partialDebug so the dev panel can show what Grok
  // produced.
  log.info('[SCENE COMPOSITE/STRATIFIED] step 1.5 — detect background silhouette bboxes on anchor plate');
  const anchorMeta = await sharp(anchorBuf).metadata();
  const canvasW = anchorMeta.width, canvasH = anchorMeta.height;
  const bboxes = {};
  for (const c of backCast) {
    const r = await findColorBbox(anchorBuf, c.color);
    if (!r) {
      log.warn(`[SCENE COMPOSITE/STRATIFIED] no ${c.color} silhouette on anchor plate`);
      continue;
    }
    bboxes[c.name] = r;
    log.info(`[SCENE COMPOSITE/STRATIFIED]   ${c.name} (${c.color}): bbox ${r.width}×${r.height} @ (${r.x},${r.y}) [${r.pixels} px]`);
  }
  debug.bboxes = bboxes;
  if (Object.keys(bboxes).length === 0) {
    throw new Error('[SCENE COMPOSITE/STRATIFIED] no background silhouettes detected on anchor plate — Grok did not paint any of the requested colours');
  }

  // Union bbox of all detected silhouettes + 20% padding. This region is
  // the input to step 3 (Grok edit): just the silhouettes plus a bit of
  // local scene context, never the whole canvas. Cuts prompt-irrelevant
  // pixels Grok could "fix" and keeps the model focused on the silhouettes.
  // 30% padding (was 20%) — gives breathing room when the silhouette bbox
  // underestimates the true silhouette (e.g. anti-aliased translucent edges
  // that gradient-match still misses) so the crop doesn't clip the figure.
  const UNION_PAD_RATIO = 0.30;
  let minX = canvasW, minY = canvasH, maxX = 0, maxY = 0;
  for (const r of Object.values(bboxes)) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  const unionW = maxX - minX, unionH = maxY - minY;
  const padX = Math.round(unionW * UNION_PAD_RATIO);
  const padY = Math.round(unionH * UNION_PAD_RATIO);
  const cropX = Math.max(0, minX - padX);
  const cropY = Math.max(0, minY - padY);
  const cropW = Math.min(canvasW - cropX, unionW + 2 * padX);
  const cropH = Math.min(canvasH - cropY, unionH + 2 * padY);
  const cropBox = { left: cropX, top: cropY, width: cropW, height: cropH };
  debug.step3CropBox = cropBox;
  log.info(`[SCENE COMPOSITE/STRATIFIED]   step-3 crop: ${cropW}×${cropH} @ (${cropX},${cropY}) [${(100 * cropW * cropH / (canvasW * canvasH)).toFixed(1)}% of canvas]`);

  // ── Build a per-pixel silhouette mask of the anchor plate using the
  // gradient-from-white match (catches translucent silhouettes Grok
  // sometimes paints). The mask doubles as (a) input mask (drives the
  // white-out step before sending to Grok) and (b) output alpha (drives
  // the composite-back step). No depopulate Grok call needed — we already
  // know exactly which pixels are silhouette.
  log.info('[SCENE COMPOSITE/STRATIFIED] building silhouette mask from anchor plate');
  const { data: anchorRgb, info: anchorInfo } = await sharp(anchorBuf).raw().toBuffer({ resolveWithObject: true });
  const anchorCh = anchorInfo.channels;
  // Targets are the BACK-stratum colours — those are the silhouettes in the
  // anchor plate.
  const targets = backCast.map(c => ({
    tr: parseInt(c.color.slice(1, 3), 16),
    tg: parseInt(c.color.slice(3, 5), 16),
    tb: parseInt(c.color.slice(5, 7), 16),
  }));
  // Each colour match is RESTRICTED to inside its detected bbox (plus a
  // small padding for anti-aliased edges). Without this, a stray scene
  // pixel matching the silhouette colour (water reflection, sunset glare,
  // etc.) gets included in the mask and Grok sees an extra coloured blob
  // to "replace with a character".
  const BBOX_PAD = 8;
  const colourRegions = backCast.map((c, idx) => {
    const bb = bboxes[c.name];
    if (!bb) return null;
    return {
      x1: Math.max(0, bb.x - BBOX_PAD),
      y1: Math.max(0, bb.y - BBOX_PAD),
      x2: Math.min(canvasW, bb.x + bb.width + BBOX_PAD),
      y2: Math.min(canvasH, bb.y + bb.height + BBOX_PAD),
      target: targets[idx],
    };
  }).filter(Boolean);
  const fullMask = Buffer.alloc(canvasW * canvasH);
  let maskedCount = 0;
  for (const region of colourRegions) {
    const { x1, y1, x2, y2, target } = region;
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const i = (y * canvasW + x) * anchorCh;
        if (fullMask[y * canvasW + x]) continue; // already counted by another colour
        if (isSilhouetteMatch(anchorRgb[i], anchorRgb[i + 1], anchorRgb[i + 2], target.tr, target.tg, target.tb)) {
          fullMask[y * canvasW + x] = 255;
          maskedCount++;
        }
      }
    }
  }
  log.info(`[SCENE COMPOSITE/STRATIFIED]   mask: ${maskedCount} silhouette px (${(100 * maskedCount / (canvasW * canvasH)).toFixed(2)}% of canvas)`);

  // ── Step 2/4: background fill plate — crop the anchor to union bbox +
  // pad, replace non-silhouette pixels with WHITE inside the crop, send to
  // Grok edit. Grok sees only the back-stratum silhouettes on a white
  // field; back identity pack as Image 2 binds name↔face. No foreground
  // pixels in the input means zero risk of Grok modifying them.
  log.info('[SCENE COMPOSITE/STRATIFIED] step 2/4 — background fill plate (silhouettes on white)');
  const maskedInputRgb = Buffer.alloc(cropW * cropH * 3);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcI = ((cropY + y) * canvasW + (cropX + x)) * anchorCh;
      const dstI = (y * cropW + x) * 3;
      if (fullMask[(cropY + y) * canvasW + (cropX + x)]) {
        maskedInputRgb[dstI]     = anchorRgb[srcI];
        maskedInputRgb[dstI + 1] = anchorRgb[srcI + 1];
        maskedInputRgb[dstI + 2] = anchorRgb[srcI + 2];
      } else {
        maskedInputRgb[dstI] = maskedInputRgb[dstI + 1] = maskedInputRgb[dstI + 2] = 255;
      }
    }
  }

  // Pad the masked crop with WHITE to a Grok aspect preset so editWithGrok's
  // input cover-cropper doesn't slice the crop edges off. Outside the
  // silhouettes is already white, so the pad is invisible at composite time.
  // Track the pad offsets so we can extract the original cropW×cropH region
  // back out of the Grok output before alignment.
  const preset = nearestGrokAspect(cropW, cropH);
  const targetRatio = preset.ratio;
  const currentRatio = cropW / cropH;
  let paddedW = cropW, paddedH = cropH, padLeft = 0, padTop = 0;
  if (currentRatio < targetRatio) {
    paddedW = Math.round(cropH * targetRatio);
    padLeft = Math.floor((paddedW - cropW) / 2);
  } else if (currentRatio > targetRatio) {
    paddedH = Math.round(cropW / targetRatio);
    padTop = Math.floor((paddedH - cropH) / 2);
  }
  const padRight = paddedW - cropW - padLeft;
  const padBottom = paddedH - cropH - padTop;
  log.info(`[SCENE COMPOSITE/STRATIFIED]   pad to preset ${preset.name}: ${cropW}×${cropH} → ${paddedW}×${paddedH} (pad L${padLeft} T${padTop} R${padRight} B${padBottom})`);
  const maskedInputBuf = await sharp(maskedInputRgb, { raw: { width: cropW, height: cropH, channels: 3 } })
    .extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, background: '#ffffff' })
    .png()
    .toBuffer();
  const maskedInputData = `data:image/png;base64,${maskedInputBuf.toString('base64')}`;
  debug.step3Input = maskedInputData;
  debug.step3PaddedSize = { width: paddedW, height: paddedH, padLeft, padTop };

  // Step 2 fills the BACK silhouettes with real characters using the back
  // identity pack. The front cast is unrelated to this call — they were
  // already rendered real in step 1 and aren't in this crop at all.
  const hasBackIdentity = !!backIdentityPack;
  const fillPrompt = buildFrontInsetPrompt(backCast, scene, hasBackIdentity, frontCast);
  const fillRefs = [maskedInputData];
  if (backIdentityPack) fillRefs.push(backIdentityPack);
  // padInput:true → Grok's aspect normalizer PADS each input with white
  // to match preset.name instead of cover-cropping. Both refs here have
  // white backgrounds (silhouette crop's surround is white; identity
  // pack's background is white) so the pad bars are invisible.
  const frontPlate = await editWithGrok(fillPrompt, fillRefs, { aspectRatio: preset.name, model: GROK_MODELS.STANDARD, padInput: true });
  if (usageTracker) usageTracker('grok', frontPlate.usage, 'scene_composite_strat_back_fill', frontPlate.modelId);
  totalCost += frontPlate.usage?.cost || 0;
  debug.frontPlate = frontPlate.imageData; // panel reads "frontPlate"; semantically this is the bg-fill plate
  debug.frontPlatePrompt = fillPrompt;
  debug.frontPlateSentToGrok = frontPlate.sentToGrok || null;

  // ── Step 3/4: composite the rendered characters back onto the ORIGINAL
  // anchor plate using a feathered version of the silhouette mask as
  // alpha. Inside the mask: Grok output. Outside: anchor plate (which
  // already has background characters + scene baked in). The depopulate
  // step is gone — the anchor plate's non-silhouette pixels ARE the back
  // plate we need.
  log.info('[SCENE COMPOSITE/STRATIFIED] step 3/4 — per-figure align + mask-compose onto anchor');
  // Extract the ORIGINAL crop region (cropW × cropH) back out of Grok's
  // padded-aspect output. resize the output to the padded dimensions, then
  // extract the (padLeft, padTop, cropW, cropH) sub-rectangle.
  const frontPlateRawBuf = Buffer.from(frontPlate.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const grokAtCrop = await sharp(frontPlateRawBuf)
    .resize(paddedW, paddedH, { fit: 'fill' })
    .extract({ left: padLeft, top: padTop, width: cropW, height: cropH })
    .raw()
    .toBuffer();

  // Crop the silhouette mask to the same region (drives the alpha for the
  // final composite, plus per-character bbox lookup below).
  const cropMaskRaw = Buffer.alloc(cropW * cropH);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      cropMaskRaw[y * cropW + x] = fullMask[(cropY + y) * canvasW + (cropX + x)];
    }
  }

  // ── Group alignment. We must PRESERVE the relative distances between
  // figures (those distances ARE the layout Grok was asked to honour), so
  // we scale + translate the output AS ONE GROUP — never per-figure. Find
  // the output content bbox (union of all FIGURE pixels), find the
  // input silhouette bbox (union of all silhouette pixels), then map one
  // onto the other.
  //
  // A "figure pixel" is one that's neither near-white (background) NOR
  // near-black (label bars). Grok sometimes leaks the identity-pack name
  // strips into its output despite the prompt forbidding them — the
  // black-bar pixels would inflate the output bbox AND get pasted onto
  // the anchor as visible black-and-white striping. Filtering them out
  // here is the defence-in-depth.
  const WHITE_TOL_SQ = 35 * 35;
  const BLACK_TOL_SQ = 50 * 50;
  const isFigurePx = (r, g, b) => {
    const dwr = r - 255, dwg = g - 255, dwb = b - 255;
    if (dwr * dwr + dwg * dwg + dwb * dwb <= WHITE_TOL_SQ) return false;
    if (r * r + g * g + b * b <= BLACK_TOL_SQ) return false;
    return true;
  };
  let inMinX = cropW, inMinY = cropH, inMaxX = -1, inMaxY = -1;
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      if (cropMaskRaw[y * cropW + x]) {
        if (x < inMinX) inMinX = x;
        if (y < inMinY) inMinY = y;
        if (x > inMaxX) inMaxX = x;
        if (y > inMaxY) inMaxY = y;
      }
    }
  }
  let outMinX = cropW, outMinY = cropH, outMaxX = -1, outMaxY = -1;
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const i = (y * cropW + x) * 3;
      if (isFigurePx(grokAtCrop[i], grokAtCrop[i + 1], grokAtCrop[i + 2])) {
        if (x < outMinX) outMinX = x;
        if (y < outMinY) outMinY = y;
        if (x > outMaxX) outMaxX = x;
        if (y > outMaxY) outMaxY = y;
      }
    }
  }

  let alignedRgb;
  if (inMaxX >= 0 && outMaxX >= 0) {
    const inBoxW = inMaxX - inMinX + 1, inBoxH = inMaxY - inMinY + 1;
    const outBoxW = outMaxX - outMinX + 1, outBoxH = outMaxY - outMinY + 1;
    debug.alignment = { input: { x: inMinX, y: inMinY, w: inBoxW, h: inBoxH }, output: { x: outMinX, y: outMinY, w: outBoxW, h: outBoxH } };
    log.info(`[SCENE COMPOSITE/STRATIFIED]   group align: grok content ${outBoxW}×${outBoxH}@(${outMinX},${outMinY}) → input silhouettes ${inBoxW}×${inBoxH}@(${inMinX},${inMinY})`);
    const contentRgb = Buffer.alloc(outBoxW * outBoxH * 3);
    for (let y = 0; y < outBoxH; y++) {
      for (let x = 0; x < outBoxW; x++) {
        const srcI = ((outMinY + y) * cropW + (outMinX + x)) * 3;
        const dstI = (y * outBoxW + x) * 3;
        contentRgb[dstI]     = grokAtCrop[srcI];
        contentRgb[dstI + 1] = grokAtCrop[srcI + 1];
        contentRgb[dstI + 2] = grokAtCrop[srcI + 2];
      }
    }
    const contentScaled = await sharp(contentRgb, { raw: { width: outBoxW, height: outBoxH, channels: 3 } })
      .resize(inBoxW, inBoxH, { fit: 'fill' })
      .raw()
      .toBuffer();
    alignedRgb = Buffer.alloc(cropW * cropH * 3, 255);
    for (let y = 0; y < inBoxH; y++) {
      for (let x = 0; x < inBoxW; x++) {
        const srcI = (y * inBoxW + x) * 3;
        const dstI = ((inMinY + y) * cropW + (inMinX + x)) * 3;
        alignedRgb[dstI]     = contentScaled[srcI];
        alignedRgb[dstI + 1] = contentScaled[srcI + 1];
        alignedRgb[dstI + 2] = contentScaled[srcI + 2];
      }
    }
  } else {
    log.warn(`[SCENE COMPOSITE/STRATIFIED]   group align: bbox detection failed (in=${inMaxX < 0}, out=${outMaxX < 0}); using raw output`);
    alignedRgb = grokAtCrop;
  }
  debug.alignedFrontPlate = `data:image/png;base64,${await sharp(alignedRgb, { raw: { width: cropW, height: cropH, channels: 3 } }).png().toBuffer().then(b => b.toString('base64'))}`;

  // ── Alpha mask. Per-pixel near-white-and-near-black classification (the
  // old approach) had a serious failure mode: it rejected near-WHITE pixels
  // INSIDE the character (e.g. the white skeleton print on Noah's hoodie,
  // white teeth, white shoe soles) — those pixels became transparent in
  // the composite, leaving holes in the character.
  //
  // Better: flood-fill from the image border to identify the OUTSIDE
  // background (only near-pure-white pixels reachable from the border).
  // Mask = NOT(reachable background) — everything else, including the
  // white prints inside the character outline. Then subtract near-black
  // pixels so any leaked label bar still gets excluded.
  const WHITE_TIGHT_SQ = 30 * 30;
  const isNearPureWhite = (r, g, b) => {
    const dr = r - 255, dg = g - 255, db = b - 255;
    return dr * dr + dg * dg + db * db <= WHITE_TIGHT_SQ;
  };
  const bgMask = new Uint8Array(cropW * cropH);
  const stack = new Int32Array(cropW * cropH);
  let top = 0;
  const pushIfWhite = (p) => {
    if (bgMask[p]) return;
    const ni = p * 3;
    if (isNearPureWhite(alignedRgb[ni], alignedRgb[ni + 1], alignedRgb[ni + 2])) {
      bgMask[p] = 1;
      stack[top++] = p;
    }
  };
  // Seed from all four borders.
  for (let x = 0; x < cropW; x++) {
    pushIfWhite(x);
    pushIfWhite((cropH - 1) * cropW + x);
  }
  for (let y = 0; y < cropH; y++) {
    pushIfWhite(y * cropW);
    pushIfWhite(y * cropW + cropW - 1);
  }
  // Flood-fill outward (4-connected).
  while (top > 0) {
    const p = stack[--top];
    const x = p % cropW, y = (p - x) / cropW;
    if (x > 0)            pushIfWhite(p - 1);
    if (x < cropW - 1)    pushIfWhite(p + 1);
    if (y > 0)            pushIfWhite(p - cropW);
    if (y < cropH - 1)    pushIfWhite(p + cropW);
  }
  // Mask = everything not reached by the flood, MINUS any near-black
  // pixels (defence against Grok leaking the identity-pack label bar).
  const figureMaskRaw = Buffer.alloc(cropW * cropH);
  let maskedFigureCount = 0;
  for (let i = 0; i < cropW * cropH; i++) {
    if (bgMask[i]) continue;
    const j = i * 3;
    const r = alignedRgb[j], g = alignedRgb[j + 1], b = alignedRgb[j + 2];
    if (r * r + g * g + b * b <= BLACK_TOL_SQ) continue; // near-black, reject
    figureMaskRaw[i] = 255;
    maskedFigureCount++;
  }
  log.info(`[SCENE COMPOSITE/STRATIFIED]   figure-mask: ${maskedFigureCount} px (${((100 * maskedFigureCount) / (cropW * cropH)).toFixed(1)}% of crop)`);

  // Feather the FIGURE mask (not the silhouette mask) so we paste only
  // figure pixels onto the anchor — never the white surround. Small blur
  // softens the boundary so the composite seam isn't visible.
  //
  // CRITICAL: sharp's .blur() converts a 1-channel raw input into a
  // 3-channel raw output (verified: 470×962×1 → 1,356,420 bytes = 3
  // channels packed). Without resolveWithObject we'd silently read R/G/B
  // bytes at stride 1 instead of the per-pixel value at stride 3, which
  // scrambles the alpha mask and makes most figure pixels composite as
  // alpha=0 (kids invisible, leaving just a tiny black-bar artifact —
  // exactly the bug the user reported).
  const featheredRaw = await sharp(figureMaskRaw, { raw: { width: cropW, height: cropH, channels: 1 } })
    .blur(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const fData = featheredRaw.data;
  const fStride = featheredRaw.info.channels; // 1 or 3 depending on sharp's internal path
  const rgba = Buffer.alloc(cropW * cropH * 4);
  for (let i = 0; i < cropW * cropH; i++) {
    rgba[i * 4]     = alignedRgb[i * 3];
    rgba[i * 4 + 1] = alignedRgb[i * 3 + 1];
    rgba[i * 4 + 2] = alignedRgb[i * 3 + 2];
    rgba[i * 4 + 3] = fData[i * fStride];
  }
  const maskedBgFillPng = await sharp(rgba, { raw: { width: cropW, height: cropH, channels: 4 } }).png().toBuffer();

  // ── Layered composite (NEW order):
  //   Layer 1: empty scene (base)
  //   Layer 2: real background characters (from step-2 bg-fill plate)
  //            at the silhouette region with figure-mask alpha
  //   Layer 3: real foreground characters (from step-1 anchor plate)
  //            on top, using a foreground mask = anchor pixels that
  //            differ from empty scene AND are NOT silhouette colours.
  //
  // This preserves z-order: foreground occludes background wherever
  // their canvas positions overlap, because Grok drew foreground ON
  // TOP of silhouettes in the anchor plate.
  const emptySceneRawBuf = Buffer.from(emptySceneData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const emptyScaledPng = await sharp(emptySceneRawBuf)
    .resize(canvasW, canvasH, { fit: 'fill' })
    .png()
    .toBuffer();
  const { data: emptyRgb, info: emptyInfo } = await sharp(emptyScaledPng).raw().toBuffer({ resolveWithObject: true });
  const emptyCh = emptyInfo.channels;

  // Foreground mask: anchor pixel differs from empty scene AND is not in
  // the silhouette mask. Threshold tuned so shadows / faint diff are not
  // counted (we don't want noise pixels making it through).
  const FG_DIFF_THRESHOLD_SQ = 45 * 45;
  const fgCanvasMask = Buffer.alloc(canvasW * canvasH);
  let fgCount = 0;
  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      const i = y * canvasW + x;
      if (fullMask[i]) continue;
      const aI = i * anchorCh;
      const eI = i * emptyCh;
      const dr = anchorRgb[aI]     - emptyRgb[eI];
      const dg = anchorRgb[aI + 1] - emptyRgb[eI + 1];
      const db = anchorRgb[aI + 2] - emptyRgb[eI + 2];
      if (dr * dr + dg * dg + db * db > FG_DIFF_THRESHOLD_SQ) {
        fgCanvasMask[i] = 255;
        fgCount++;
      }
    }
  }
  log.info(`[SCENE COMPOSITE/STRATIFIED]   foreground mask: ${fgCount} px (${((100 * fgCount) / (canvasW * canvasH)).toFixed(1)}% of canvas)`);

  // Feather the foreground mask so the seam between fg and bg is soft.
  const fgFeathered = await sharp(fgCanvasMask, { raw: { width: canvasW, height: canvasH, channels: 1 } })
    .blur(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const fgStride = fgFeathered.info.channels;
  const anchorRgbaForFg = Buffer.alloc(canvasW * canvasH * 4);
  for (let i = 0; i < canvasW * canvasH; i++) {
    anchorRgbaForFg[i * 4]     = anchorRgb[i * anchorCh];
    anchorRgbaForFg[i * 4 + 1] = anchorRgb[i * anchorCh + 1];
    anchorRgbaForFg[i * 4 + 2] = anchorRgb[i * anchorCh + 2];
    anchorRgbaForFg[i * 4 + 3] = fgFeathered.data[i * fgStride];
  }
  const anchorFgMaskedPng = await sharp(anchorRgbaForFg, { raw: { width: canvasW, height: canvasH, channels: 4 } }).png().toBuffer();

  const composited = await sharp(emptyScaledPng)
    .composite([
      { input: maskedBgFillPng, left: cropX, top: cropY }, // back chars (real)
      { input: anchorFgMaskedPng, left: 0, top: 0 },       // foreground chars (real, from anchor)
    ])
    .png()
    .toBuffer();
  const compositedData = `data:image/png;base64,${composited.toString('base64')}`;
  debug.composited = compositedData;
  debug.foregroundMask = `data:image/png;base64,${await sharp(fgCanvasMask, { raw: { width: canvasW, height: canvasH, channels: 1 } }).png().toBuffer().then(b => b.toString('base64'))}`;

  // ── Step 4/4: blend pass (same as uniform path)
  log.info('[SCENE COMPOSITE/STRATIFIED] step 4/4 — blend pass');
  const blendPrompt = buildBlendEditPrompt(scene);
  debug.blendPrompt = blendPrompt;
  const blendRefs = visualBibleGridImage
    ? [compositedData, visualBibleGridImage]
    : [compositedData];
  debug.blendRefCount = blendRefs.length;
  const pass1 = await editWithGrok(blendPrompt, blendRefs, { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', pass1.usage, 'scene_composite_strat_blend', pass1.modelId);
  totalCost += pass1.usage?.cost || 0;
  debug.blendSentToGrok = pass1.sentToGrok || null;

  log.info(`[SCENE COMPOSITE/STRATIFIED] complete — total cost $${totalCost.toFixed(4)}, back=${backCast.length} front=${Object.keys(bboxes).length}/${frontCast.length}`);

  return {
    imageData: pass1.imageData,
    usage: { cost: totalCost, direct_cost: totalCost, model: 'scene-composite-stratified' },
    debug,
  };
}

module.exports = {
  generateSceneComposite,
  generateStratifiedComposite,
  POSE_CELL,
  FACE_CELL,
  DEFAULT_PALETTE,
  cropAvatarCell,
  // internal helpers exposed for tests
  _internal: {
    findColorBbox,
    findSilhouettesByDiff,
    cropSheetCell,
    removeBackground,
    trimTransparent,
    flipHorizontal,
    scaleToHeight,
    buildPopulatedPlatePrompt,
    buildDepopulatePrompt,
    buildAnchorPlatePrompt,
    buildBackCharLines,
    buildFrontDepopulatePrompt,
    buildFrontInsetPrompt,
    buildBlendEditPrompt,
    buildCastLines,
    buildAnonymousCastLines,
    filterBriefByStratum,
    buildIdentityPack,
    detectZOrderByOcclusion,
    rgbToHue,
  },
};
