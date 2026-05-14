/**
 * Scene composite page-generation pipeline.
 *
 * Three Grok calls per page:
 *   1. generate clean background (no people)
 *   2. edit-add coloured silhouettes at the positions Sonnet declared
 *   3. edit-blend: cut the real character sheets in at the detected bboxes,
 *      then one Grok edit pass to harmonise lighting / soften pasted edges.
 *
 * Characters come from pre-rendered 2×4 sheets stored on the character row
 * (character.avatars.sheet2x4_<costume>). Each cast entry on the scene says
 * { name, pose, flip, color } so the script picks the right cell + flip.
 *
 * Behind MODEL_DEFAULTS.enableSceneComposite (default false). Per-story
 * opt-out via inputData.composite === false.
 *
 * See docs/SCENE-COMPOSITE-PIPELINE.html for the architecture overview and
 * scripts/test-scene-composite.js for the validation harness.
 */

'use strict';

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { generateWithGrok, editWithGrok, GROK_MODELS } = require('./grok');

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

  // 4-connected flood fill; keep the largest blob.
  const visited = new Uint8Array(W * H);
  let best = null;
  const stack = new Int32Array(W * H);
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
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (h / w < 1.1) continue;
    if (!best || count > best.pixels) {
      best = { x: minX, y: minY, width: w, height: h, pixels: count };
    }
  }
  return best;
}

// ─── Sheet cell helpers ───────────────────────────────────────────────────

/** Crop one of 8 cells from a 2×4 sheet. 1-indexed. */
async function cropSheetCell(sheetBuf, cellIdx) {
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

// ─── Prompt builders ──────────────────────────────────────────────────────

/**
 * Build the silhouette-addition prompt for the blocking step. The cast
 * entries describe each character's role in the scene; we emit one
 * "X silhouette" line per character with the colour, size hint, and
 * direction.
 */
function buildBlockingEditPrompt(scene, cast) {
  const lines = cast.map((c) => {
    const sizeHint = c.sizeHint || 'about two-thirds the size of the largest figure';
    const posHint = c.position || 'in the scene';
    const direction = c.flip ? 'facing right' : 'facing left';
    const poseLabel = {
      front:        'front view, body facing the camera',
      threeQuarter: `three-quarter view, ${direction}`,
      profile:      `profile view, ${direction}`,
      back:         'back view, viewer sees the back of the head',
    }[c.pose] || `three-quarter view, ${direction}`;
    return `- ONE ${c.colorName || ''} silhouette (${c.color}): ${c.description || c.name}, ${posHint}, ${poseLabel}. Size: ${sizeHint}.`;
  }).join('\n');

  return `Keep the scene background EXACTLY as it is in this image — every pixel of the setting must remain pixel-identical. Only ADD ${cast.length} flat-colour silhouette figures into the scene at the positions below. The silhouettes are solid uniform colour shapes — no faces, no clothing details, no texture.

${lines}

Every silhouette is one solid uniform colour, painted directly into the scene at a position that makes physical sense (feet on the ground, sized for depth). NO TEXT. Do not modify the background in any way.`;
}

function buildBlendEditPrompt(scene) {
  return `Refine this children's book illustration. Real characters have been pasted onto a clean scene background at the correct positions, sizes, and body directions. Blend each character into the scene: harmonise watercolor lighting, soften pasted edges, add subtle shadows on the ground. Preserve each character's identity, face, hair, costume, position, size, and body direction EXACTLY — do not move, resize, rotate, or change facing direction. Apply the scene action: ${scene.action || scene.description || ''}. Render in the scene's art style. NO TEXT in the output.`;
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
  } = opts;

  if (!cleanBackgroundPrompt && !existingCleanBackground) throw new Error('cleanBackgroundPrompt or existingCleanBackground required');
  if (!Array.isArray(cast) || cast.length === 0) throw new Error('cast must be non-empty');

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

  // ── Step 1: clean background
  // Reuse the empty-scene image already generated by the dedicated empty-scene
  // phase (sceneBackgrounds[pageNumber].imageData) when one is passed in. Skips
  // a Grok generate call (~$0.02 + ~5s per page) and keeps the BG consistent
  // with what the rest of the pipeline used.
  let bgImageData;
  if (existingCleanBackground) {
    log.info(`[SCENE COMPOSITE] step 1/4 — reusing existing empty scene (${cast.length} cast)`);
    bgImageData = existingCleanBackground;
  } else {
    log.info(`[SCENE COMPOSITE] step 1/4 — clean background (${cast.length} cast)`);
    const bg = await generateWithGrok(cleanBackgroundPrompt, { aspectRatio, model: GROK_MODELS.STANDARD });
    if (usageTracker) usageTracker('grok', bg.usage, 'scene_composite_bg', bg.modelId);
    totalCost += bg.usage?.cost || 0;
    bgImageData = bg.imageData;
  }
  const bgBuf = Buffer.from(bgImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  debug.cleanBackground = bgImageData;
  debug.cleanBackgroundPrompt = cleanBackgroundPrompt || null;
  debug.cleanBackgroundSource = existingCleanBackground ? 'reused-empty-scene' : 'grok-generate';

  // ── Step 2: add silhouettes via Grok edit
  log.info('[SCENE COMPOSITE] step 2/4 — blocking (add silhouettes)');
  const blockingPrompt = buildBlockingEditPrompt(scene, cast);
  const blocking = await editWithGrok(blockingPrompt, [bgImageData], { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', blocking.usage, 'scene_composite_blocking', blocking.modelId);
  totalCost += blocking.usage?.cost || 0;
  const blockingBuf = Buffer.from(blocking.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  debug.blocking = blocking.imageData;
  debug.blockingPrompt = blockingPrompt;

  // ── Step 3: detect bboxes + composite cutouts on the clean background
  log.info('[SCENE COMPOSITE] step 3/4 — detect bboxes + composite');
  const bboxes = {};
  const placements = [];
  for (const c of cast) {
    const bbox = await findColorBbox(blockingBuf, c.color);
    if (!bbox) {
      log.warn(`[SCENE COMPOSITE] no bbox for ${c.name} (${c.color}) — Grok did not paint a recognisable silhouette`);
      continue;
    }
    bboxes[c.name] = bbox;
    log.info(`[SCENE COMPOSITE]   ${c.name} (${c.color}): bbox ${bbox.width}×${bbox.height} @ (${bbox.x},${bbox.y}); cell ${POSE_CELL[c.pose]} (${c.pose})${c.flip ? ' flipped' : ''}`);

    const cellBuf = await cropSheetCell(c.sheetBuf, POSE_CELL[c.pose]);
    let cutBuf = await removeBackground(cellBuf);
    cutBuf = await trimTransparent(cutBuf);
    if (c.flip) cutBuf = await flipHorizontal(cutBuf);
    const scaled = await scaleToHeight(cutBuf, bbox.height);

    const sMeta = await sharp(scaled).metadata();
    const cx = bbox.x + Math.floor(bbox.width / 2);
    const bottomY = bbox.y + bbox.height;
    const left = Math.max(0, cx - Math.floor(sMeta.width / 2));
    const top = Math.max(0, bottomY - sMeta.height);
    placements.push({ input: scaled, left, top });
  }
  debug.bboxes = bboxes;

  if (placements.length === 0) {
    throw new Error('[SCENE COMPOSITE] no characters placed — bbox detection failed for every cast entry');
  }

  const composited = await sharp(bgBuf).composite(placements).png().toBuffer();
  const compositedData = `data:image/png;base64,${composited.toString('base64')}`;
  debug.composited = compositedData;

  // ── Step 4: Grok edit blend pass
  log.info('[SCENE COMPOSITE] step 4/4 — blend pass');
  const blendPrompt = buildBlendEditPrompt(scene);
  debug.blendPrompt = blendPrompt;
  const pass1 = await editWithGrok(blendPrompt, [compositedData], { aspectRatio, model: GROK_MODELS.STANDARD });
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
    buildBlockingEditPrompt,
    buildBlendEditPrompt,
    rgbToHue,
  },
};
