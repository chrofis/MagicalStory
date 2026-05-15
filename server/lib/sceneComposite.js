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
  const targetHue = rgbToHue(tr, tg, tb);
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const mask = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const maxCh = Math.max(r, g, b);
      const minCh = Math.min(r, g, b);
      const sat = (maxCh - minCh) / (maxCh || 1);
      if (sat < 0.55 || maxCh < 80) continue;
      const hue = rgbToHue(r, g, b);
      let dh = Math.abs(hue - targetHue);
      if (dh > 180) dh = 360 - dh;
      if (dh <= 35) mask[y * W + x] = 1;
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

function buildBlendEditPrompt(scene) {
  const styleLine = BLEND_STYLE_LINES[scene.artStyle] || BLEND_STYLE_LINES.watercolor;
  const brief = (scene.pageBrief || '').trim();
  const briefBlock = brief
    ? `\n\nPAGE BRIEF — these blocks define the canonical look of every character, costume, object, and pose in this scene. The composited image (Image 1) is already staged correctly; the brief tells you WHAT each silhouette is supposed to look like once blended. Image 2 (when provided) is the labelled portrait grid — use it as the authoritative face/clothing reference.\n\n${brief}`
    : '';

  return `Refine Image 1 into a single cohesive children's book illustration in ${styleLine}.

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
- Add text, captions, numbers, or signatures of any kind.${briefBlock}`;
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
  // Back-compat aliases so existing dev panels keep showing the same fields.
  debug.blocking = populated.imageData;
  debug.blockingPrompt = populatedPrompt;

  // ── Step 2/5: detect bboxes on the populated plate
  log.info('[SCENE COMPOSITE] step 2/5 — bbox detect');
  const bboxes = {};
  for (const c of cast) {
    const bbox = await findColorBbox(populatedBuf, c.color);
    if (!bbox) {
      log.warn(`[SCENE COMPOSITE] no bbox for ${c.name} (${c.color}) — Grok did not paint a recognisable silhouette`);
      continue;
    }
    bboxes[c.name] = bbox;
    log.info(`[SCENE COMPOSITE]   ${c.name} (${c.color}): bbox ${bbox.width}×${bbox.height} @ (${bbox.x},${bbox.y}); cell ${POSE_CELL[c.pose]} (${c.pose})${c.flip ? ' flipped' : ''}`);
  }
  if (Object.keys(bboxes).length === 0) {
    throw new Error('[SCENE COMPOSITE] no silhouettes detected on populated plate — bbox detection failed for every cast entry');
  }
  debug.bboxes = bboxes;

  // ── Step 3/5: depopulate to derive the clean BG (Grok edit)
  log.info('[SCENE COMPOSITE] step 3/5 — depopulate (derive clean BG)');
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
        // Mask out OTHER cast members' silhouettes when they fall within
        // this character's cropped region — repaint with derived clean-BG
        // pixels so Grok sees only the target's silhouette + scene context.
        const otherColors = cast.filter(o => o.name !== c.name && o.color).map(o => o.color);
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
          otherColors,
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

  log.info(`[SCENE COMPOSITE] complete — total cost $${totalCost.toFixed(4)}, ${placements.length}/${cast.length} characters placed`);

  return {
    imageData: pass1.imageData,
    usage: { cost: totalCost, direct_cost: totalCost, model: 'scene-composite' },
    debug,
  };
}

module.exports = {
  generateSceneComposite,
  POSE_CELL,
  DEFAULT_PALETTE,
  // internal helpers exposed for tests
  _internal: {
    findColorBbox,
    cropSheetCell,
    removeBackground,
    trimTransparent,
    flipHorizontal,
    scaleToHeight,
    buildPopulatedPlatePrompt,
    buildDepopulatePrompt,
    buildBlendEditPrompt,
    buildCastLines,
    detectZOrderByOcclusion,
    rgbToHue,
  },
};
