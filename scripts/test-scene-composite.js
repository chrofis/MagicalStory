#!/usr/bin/env node
/**
 * Scene composite test — proof-of-concept for the new scene pipeline.
 *
 * Steps:
 *   1. For each character + chosen pose, crop the matching cell from the
 *      character's 2×4 sheet (cells 5..8 = body front/45°/profile/back).
 *   2. White-to-transparent the cell so the figure is a cutout.
 *   3. Scale by age-based real-world height (mirrors coverComposite.js).
 *   4. Generate an empty-scene background via Grok (one call per scene).
 *   5. Composite character cutouts onto the background.
 *   6. Pass 1 (Grok edit) — unify style, apply action verbs from the
 *      scene prose, blend figures into the scene.
 *
 * Outputs all intermediate stages so each step can be debugged.
 *
 * Usage:
 *   node scripts/test-scene-composite.js
 */

'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const XAI_API_KEY = process.env.XAI_API_KEY;
if (!XAI_API_KEY) { console.error('XAI_API_KEY missing'); process.exit(1); }

const STAMP = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const OUT_ROOT = path.resolve(__dirname, '..', 'tests', '_outputs', 'scene-composite', STAMP);
fs.mkdirSync(OUT_ROOT, { recursive: true });

// ────────────────────────────────────────────────────────────────────────────
// Inputs: characters and their 2×4 sheets we already generated locally
// ────────────────────────────────────────────────────────────────────────────
const CHARACTERS = {
  Hans: {
    age: 65,
    sheet: 'tests/_outputs/character-from-phantom/2026-05-11-20-58-08__Hans-variantA/grok.png',
    style: 'watercolor',
    costume: 'pirate costume, white shirt, red sash, tricorn hat',
  },
  Daniel: {
    age: 40,
    sheet: 'tests/_outputs/character-from-phantom/2026-05-11-21-10-35__Daniel-variantA-pixar/grok.png',
    style: 'pixar 3D',
    costume: 'medieval knight, chainmail tunic, sword',
  },
  Emma: {
    age: 6,
    sheet: 'tests/_outputs/character-from-phantom/2026-05-11-21-07-27__Emma-variantA/grok.png',
    style: 'watercolor',
    costume: 'pirate costume, white blouse, red sash, tricorn hat',
  },
  Noah: {
    age: 5,
    sheet: 'tests/_outputs/character-from-phantom/2026-05-11-21-29-52__Noah-variantA/grok.png',
    style: 'watercolor',
    costume: 'small pirate, striped red and white shirt, eye patch',
  },
};

// Pose → body cell index in the 2×4 grid (cells are 1-indexed; bottom row is 5..8).
const POSE_CELL = {
  front: 5,
  threeQuarter: 6,
  profile: 7,
  back: 8,
};

// Real-world height by age (cm) — copied from server/lib/coverComposite.js.
function heightCm(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n)) return 175;
  if (n <= 1) return 75;
  if (n <= 3) return 95;
  if (n <= 5) return 110;
  if (n <= 7) return 122;
  if (n <= 10) return 140;
  if (n <= 12) return 150;
  if (n <= 14) return 162;
  if (n <= 17) return 172;
  if (n <= 60) return 175;
  return 168;
}

// ────────────────────────────────────────────────────────────────────────────
// Three test scenes
// ────────────────────────────────────────────────────────────────────────────
const COLORS = {
  Hans:   '#E60000', // pure red
  Emma:   '#00B050', // pure green (was teal — Grok rendered green-green, hue mismatch)
  Daniel: '#0050D0', // strong blue
  Noah:   '#F0C000', // amber yellow
};

const SCENES = [
  // Three-image pipeline: clean BG → Grok-edit-adds-silhouettes → composite on clean BG
  {
    id: 'G_holzbruecke_3img',
    mode: 'three-image',
    cleanBackgroundPrompt: `An old Swiss covered wooden bridge — the historic Holzbrücke in Baden, Switzerland — interior view looking down its length. Wooden beams overhead, planks underfoot, open railings on both sides showing the river below. Daylight streaming through. No people in this image — completely empty bridge. Watercolor children's storybook style.`,
    addSilhouettesPrompt: `Keep the wooden bridge background EXACTLY as it is — every plank, beam, stone, and river ripple must remain pixel-identical. Only add FOUR flat-colour silhouette figures into the scene at the positions below. The silhouettes are solid uniform colour shapes — no faces, no clothing details, no texture.

- ONE RED silhouette (#E60000): a full-grown man, large, in the centre-right foreground, body in PROFILE turned to the right, leaning forward against the wooden railing to look down at the river.
- ONE BLUE silhouette (#0050D0): an adult man, three-quarter body view, slightly behind the red figure on his left side. About two-thirds the size of the red figure. Body turned slightly to the right.
- ONE GREEN silhouette (#00B050): a small girl, in the LEFT midground, three-quarter body view turned to the RIGHT (toward the centre of the frame). About half the size of the red figure.
- ONE YELLOW silhouette (#F0C000): a small boy, standing on the LEFT side of the green figure, three-quarter body view also turned to the RIGHT. About the same size as the green figure.

Every silhouette is one solid uniform colour. No text. Do not modify the bridge background in any way.`,
    cast: [
      // The 2×4 cells (3/4 + profile) face the camera's LEFT by default.
      // To make a figure face RIGHT in the scene, flip=true.
      // All four silhouettes in this scene face right → flip=true everywhere.
      { name: 'Hans',   color: '#E60000', pose: 'profile',      flip: true }, // facing right
      { name: 'Daniel', color: '#0050D0', pose: 'threeQuarter', flip: true }, // facing right
      { name: 'Emma',   color: '#00B050', pose: 'threeQuarter', flip: true }, // facing right
      { name: 'Noah',   color: '#F0C000', pose: 'threeQuarter', flip: true }, // facing right
    ],
    finalAction: 'The Berger family stands on the historic Holzbrücke wooden bridge. Hans (centre-right, large, profile to the right) leans over the wooden railing to look down at the river. Daniel (behind Hans, three-quarter view) watches. Emma and Noah (left, three-quarter facing right) watch from the side. All four are in pirate costumes. Watercolor children\'s storybook style.',
  },
  // Story job_1778400519362_xwufe7ptv "Was unter der Holzbrücke lag" —
  // 4 of the 5 Berger family members on the Baden covered wooden bridge.
  // Blocking mode: Grok decides placement, script detects bboxes, real
  // characters pasted in.
  {
    id: 'F_holzbruecke_family',
    mode: 'blocking',
    blockingPrompt: `An old Swiss covered wooden bridge — the historic Holzbrücke in Baden, Switzerland — crossing a calm river under a stone roof. The view is from inside the bridge looking down its length, wooden beams overhead, daylight streaming through the open sides, planks underfoot. Soft watercolor children's storybook style.

Painted into this scene are FOUR FLAT-COLOUR SILHOUETTE FIGURES — solid colour shapes, no faces, no clothing details, no texture. Each silhouette stands on the wooden bridge floor in a position that makes physical sense:

- ONE RED silhouette: a full-grown man in the centre foreground of the bridge, large, body facing slightly to the right (three-quarter view), leaning over the wooden railing looking down at the river.
- ONE BLUE silhouette: an adult man, midground, behind the red figure, three-quarter view, also looking over the railing, about two-thirds the size of the red figure.
- ONE GREEN silhouette: a small girl, in the LEFT midground of the bridge, three-quarter body view turned toward the centre of the frame, about half the size of the red figure.
- ONE YELLOW silhouette: a small boy, standing next to the green figure on the LEFT, three-quarter body view turned toward the centre, about the same size as the green figure.

Every silhouette is a SOLID UNIFORM COLOUR. The background is the wooden bridge interior in soft watercolor. ABSOLUTELY NO TEXT in the image.`,
    cleanBackgroundPrompt: `An old Swiss covered wooden bridge — the historic Holzbrücke in Baden — interior view looking down its length. Wooden beams overhead, planks underfoot, open railings on both sides showing the river below. Daylight streaming through. No people in this image — empty bridge. Watercolor children's storybook style.`,
    cast: [
      { name: 'Hans',   color: '#E60000', pose: 'threeQuarter', flip: false },
      { name: 'Daniel', color: '#0050D0', pose: 'threeQuarter', flip: false },
      { name: 'Emma',   color: '#00B050', pose: 'threeQuarter', flip: false },
      { name: 'Noah',   color: '#F0C000', pose: 'threeQuarter', flip: false },
    ],
    finalAction: 'The Berger family stands on the historic Holzbrücke wooden bridge in Baden. Hans (centre foreground, large) leans over the wooden railing to look down at the river. Daniel (midground behind him) joins him at the rail. Emma and Noah (left midground, smaller, child-size) watch from the side. All four are in pirate costumes. Watercolor children\'s storybook style.',
  },
  // PREVIOUS — Altdorf apple shot, validated the blocking-mode pipeline.
  {
    id: 'E_appleshot_blocking',
    mode: 'blocking',
    blockingPrompt: `A medieval Swiss village square at midday — Altdorf marketplace. Wide cobblestone square framed by half-timbered houses. A tall wooden pole rises in the centre background with a brimmed hat mounted on top (the Gessler hat).

Painted into this scene are FOUR FLAT-COLOUR SILHOUETTE FIGURES — solid colour shapes, no faces, no clothing details, no texture, no shading. Each silhouette stands on the ground in a position that makes physical sense for the scene below.

- ONE RED silhouette: a full-grown man, BACK VIEW (his back is to the viewer), standing in the centre-foreground of the square, large, holding a crossbow aimed across the square toward the back-right.
- ONE GREEN silhouette: a small child, far in the background on the right side of the square (very small in scale due to distance — about one-fifth the size of the red figure), standing very still with a tiny red apple on top of the head, three-quarter body view turned toward the centre of the frame.
- ONE BLUE silhouette: an adult man, in the LEFT midground, three-quarter body view turned toward the centre (watching the action), about two-thirds the size of the red figure.
- ONE YELLOW silhouette: a small boy, standing next to the blue silhouette on the LEFT midground, three-quarter body view turned toward the centre, about half the size of the red figure.

Every silhouette is a SOLID UNIFORM COLOUR. The background is painted in soft watercolor children's storybook style. ABSOLUTELY NO TEXT in the image.`,
    cleanBackgroundPrompt: 'A medieval Swiss village square at midday — Altdorf marketplace. Wide cobblestone square framed by half-timbered houses. A tall wooden pole rises in the centre background with a brimmed hat mounted on top. No people in this image — completely empty foreground. Watercolor children\'s storybook style.',
    cast: [
      { name: 'Hans',   color: '#E60000', pose: 'back',         flip: false },
      { name: 'Emma',   color: '#00B050', pose: 'threeQuarter', flip: true },
      { name: 'Daniel', color: '#0050D0', pose: 'threeQuarter', flip: false },
      { name: 'Noah',   color: '#F0C000', pose: 'threeQuarter', flip: false },
    ],
    finalAction: 'A tense apple-shot moment in the marketplace. Wilhelm Tell (centre foreground, back to the viewer) aims a wooden crossbow across the square toward his young son (far background, right side, small, with a red apple on his head). Two spectators (left midground) — a tall adult man and a young boy — watch from the side. Watercolor children\'s storybook style.',
  },
  // PREVIOUS — coloured placeholder mode where positions came from xFrac (script-side).
  {
    id: 'D_appleshot_coloured',
    coloured: true,
    description: 'A medieval Swiss village square at midday — Altdorf marketplace. Wide cobblestone square framed by half-timbered houses. A tall wooden pole rises in the centre-right background with a brimmed hat mounted on top (the Gessler hat). No people in this image — leave the foreground empty across the full width. Watercolor children\'s storybook style.',
    cast: [
      // Hans (Tell): foreground centre-left, body turned away from camera (back view).
      { name: 'Hans',   pose: 'back',         flip: false, xFrac: 0.45, scale: 1.00, depth: 'foreground' },
      // Emma (Walter): far background, back-right, small, three-quarter turned to viewer's LEFT.
      { name: 'Emma',   pose: 'threeQuarter', flip: true,  xFrac: 0.85, scale: 0.35, depth: 'background' },
      // Two spectators on the left, three-quarter turned to the viewer's RIGHT.
      { name: 'Daniel', pose: 'threeQuarter', flip: false, xFrac: 0.08, scale: 0.85, depth: 'midground' },
      { name: 'Noah',   pose: 'threeQuarter', flip: false, xFrac: 0.20, scale: 0.55, depth: 'midground' },
    ],
    finalAction: 'A tense apple-shot moment in the marketplace. Wilhelm Tell stands with his back to the viewer in the centre-left foreground, aiming a wooden crossbow toward his young son in the distance. The son (small, far background, right side) stands very still with a red apple on his head, body turned in a three-quarter view toward the centre of the frame. Two spectators (left side, midground) — a tall adult man and a young boy — watch the scene from the side, both turned in a three-quarter view to look toward Tell and the apple. Watercolor children\'s storybook style.',
  },
  {
    id: 'C_appleshot_crowd',
    description: 'A medieval Swiss village square at midday — Altdorf marketplace. Wide cobblestone square framed by half-timbered houses. A wooden pole rises in the centre background with a brimmed hat mounted on top (the Gessler hat). No people in this image — leave the foreground empty across the full width. Watercolor children\'s storybook style.',
    cast: [
      { name: 'Hans',   pose: 'profile',      position: 'far left foreground, aiming a crossbow toward the right' },
      { name: 'Emma',   pose: 'front',        position: 'far right midground, smaller, standing very still with apple on head' },
      { name: 'Daniel', pose: 'threeQuarter', position: 'centre-left midground, watching the scene from a few paces behind Hans' },
      { name: 'Noah',   pose: 'threeQuarter', position: 'centre-right midground, watching from a few paces in front of Emma' },
      { name: 'Daniel', pose: 'front',        position: 'centre background near the pole, arms crossed, observing' },
    ],
    finalAction: 'A tense apple-shot moment in the marketplace. Wilhelm Tell (far left, large in the foreground) aims a wooden crossbow across the square toward his young son (far right midground, small and standing very still with a red apple balanced on his head). Two soldiers (centre, midground, smaller) watch the scene. A bailiff (centre background, near the Gessler hat pole) observes with arms crossed. Watercolor children\'s storybook style.',
  },
  {
    id: 'A_appleshot',
    description: 'A medieval Swiss village square at midday — Altdorf marketplace. Wide cobblestone square framed by half-timbered houses. A wooden pole rises in the centre-right background with a brimmed hat mounted on top (the Gessler hat). No people in this image — leave the foreground empty across the full width. Watercolor children\'s storybook style.',
    cast: [
      { name: 'Hans',  pose: 'profile', position: 'left foreground, aiming crossbow toward the right' },
      { name: 'Emma',  pose: 'front',   position: 'right midground, small in the distance, standing still with an apple on her head' },
    ],
    finalAction: 'Wilhelm Tell (left foreground, large) aims a wooden crossbow toward the right side of the frame. His young son (right midground, smaller and farther away) stands very still with a round red apple balanced on top of his head. The two figures are clearly far apart across the square — roughly thirty paces between them.',
  },
  {
    id: 'B_boatleap',
    description: 'A stormy alpine lake at dusk. Dark grey clouds, choppy water, a wooden rowboat sits on rough waves in the left foreground, prow pointing right. Sharp rocky cliffs rise on the right side of the frame, with a flat ledge of rock close to the camera. Driving rain. No people in this image — leave the boat and the ledge empty.',
    cast: [
      { name: 'Hans', pose: 'threeQuarter', position: 'mid-air between the boat (left) and the rocky ledge (right), caught mid-leap' },
    ],
    finalAction: 'Wilhelm Tell leaps from the wooden boat on the left toward the rocky ledge on the right — caught in mid-air, body angled forward, one foot pushing off from the boat\'s stern, arms outstretched for balance. Storm clouds, driving rain, dramatic dusk lighting.',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Grok call helpers
// ────────────────────────────────────────────────────────────────────────────
async function grokGenerate(prompt, aspect = '16:9') {
  const body = {
    model: 'grok-imagine-image',
    prompt,
    n: 1,
    response_format: 'b64_json',
    aspect_ratio: aspect,
    resolution: '1k',
  };
  const t0 = Date.now();
  const r = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Grok gen ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  if (!data.data?.[0]?.b64_json) throw new Error('no image from Grok gen');
  return { buf: Buffer.from(data.data[0].b64_json, 'base64'), ms: Date.now() - t0 };
}

async function grokEdit(prompt, refImageBuffers, aspect = '16:9') {
  const images = refImageBuffers.map(buf => ({
    url: `data:image/png;base64,${buf.toString('base64')}`,
    type: 'image_url',
  }));
  const body = {
    model: 'grok-imagine-image',
    prompt,
    response_format: 'b64_json',
    aspect_ratio: aspect,
    images,
  };
  const t0 = Date.now();
  const r = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Grok edit ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  if (!data.data?.[0]?.b64_json) throw new Error('no image from Grok edit');
  return { buf: Buffer.from(data.data[0].b64_json, 'base64'), ms: Date.now() - t0 };
}

// ────────────────────────────────────────────────────────────────────────────
// Image helpers
// ────────────────────────────────────────────────────────────────────────────
async function cropCell(sheetPath, cellIdx) {
  // 2×4 grid: cells numbered 1..8 (1=top-left, 4=top-right, 5=bottom-left, 8=bottom-right).
  const buf = fs.readFileSync(sheetPath);
  const meta = await sharp(buf).metadata();
  const cellW = Math.floor(meta.width / 4);
  const cellH = Math.floor(meta.height / 2);
  const col = (cellIdx - 1) % 4;
  const row = Math.floor((cellIdx - 1) / 4);
  return sharp(buf)
    .extract({ left: col * cellW, top: row * cellH, width: cellW, height: cellH })
    .png()
    .toBuffer();
}

const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

// Foreground extraction via the Python rembg service (preferred).
// Falls back to a simple white-threshold cutout if the service is unreachable.
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
    console.log(`    ⚠️  rembg fallback to threshold (${err.message})`);
    return whiteToTransparent(buf);
  }
}

// Fallback: white-to-transparent (used if Python rembg is unreachable).
async function whiteToTransparent(buf, threshold = 240) {
  const img = sharp(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    if (r >= threshold && g >= threshold && b >= threshold) out[i + 3] = 0;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

// Tight-crop a cutout (remove transparent borders).
async function trimTransparent(buf) {
  return sharp(buf).trim({ threshold: 1 }).png().toBuffer();
}

// Scale a cutout so its height equals targetPxHeight.
async function scaleToHeight(buf, targetH) {
  const meta = await sharp(buf).metadata();
  if (!meta.height || meta.height === targetH) return buf;
  return sharp(buf).resize({ height: targetH, withoutEnlargement: false }).png().toBuffer();
}

async function flipHorizontal(buf) {
  return sharp(buf).flop().png().toBuffer();
}

// Convert a cutout's opaque pixels to a flat colour silhouette. Used to
// build coloured placeholders that Pass 1 can map back to specific
// characters ("red = Hans, green = Emma, …").
async function toColoredSilhouette(cutoutBuf, hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const img = sharp(cutoutBuf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] > 0) {
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
    }
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

// Stitch up to N character 2×4 sheets horizontally into one mega-reference.
// Grok edit takes max 3 images including the composite, so this packs all
// character refs into a single slot.
async function stitchSheets(sheetPaths, targetW = 1600) {
  const bufs = await Promise.all(sheetPaths.map(p => sharp(fs.readFileSync(p))
    .resize({ width: Math.floor(targetW / sheetPaths.length), withoutEnlargement: false })
    .png()
    .toBuffer()));
  const metas = await Promise.all(bufs.map(b => sharp(b).metadata()));
  const W = metas.reduce((s, m) => s + (m.width || 0), 0);
  const H = Math.max(...metas.map(m => m.height || 0));
  const composites = [];
  let x = 0;
  for (let i = 0; i < bufs.length; i++) {
    composites.push({ input: bufs[i], left: x, top: 0 });
    x += metas[i].width || 0;
  }
  return sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(composites).png().toBuffer();
}

// ────────────────────────────────────────────────────────────────────────────
// Per-scene pipeline
// ────────────────────────────────────────────────────────────────────────────
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

// Find the LARGEST connected region whose RGB is close to a target colour
// and return its bounding box. Uses an iterative flood fill on a 4-connected
// mask. Required because the watercolor scene background can contain
// scattered pixels in the placeholder colour family (e.g. green foliage
// pixels matching Emma's green), which inflate the bbox to canvas-wide if
// we just take "all matching pixels". The largest connected blob is the
// actual figure.
async function findColorBbox(buf, hex) {
  // Build a hue-based mask instead of an RGB-distance mask. Watercolor
  // rendering of a saturated silhouette can shift each channel by ±60 from
  // the prompt's pure hex, which knocks an RGB-distance match out.
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
      // Require strong saturation — the placeholder silhouettes are pure
      // colour, the watercolour scene background is muted. 0.55 keeps clear
      // silhouette pixels and rejects warm-ceiling / leaf-green tones that
      // share a hue family.
      if (sat < 0.55) continue;
      if (maxCh < 80) continue;
      const hue = rgbToHue(r, g, b);
      // Hue distance on the colour wheel (0..180).
      let dh = Math.abs(hue - targetHue);
      if (dh > 180) dh = 360 - dh;
      if (dh <= 35) mask[y * W + x] = 1;
    }
  }

  // Iterative 4-connected flood fill — find the largest blob.
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
    // Standing figure sanity: height should exceed width by at least 1.1×.
    // Stray horizontal-tinted regions (sunlit ceiling beams, water reflections)
    // tend to be wide and shallow — reject them.
    if (h / w < 1.1) continue;
    if (!best || count > best.pixels) {
      best = { x: minX, y: minY, width: w, height: h, pixels: count };
    }
  }
  return best;
}

function depthBaseFraction(depth) {
  switch (depth) {
    case 'foreground': return 0.78;
    case 'midground':  return 0.55;
    case 'background': return 0.30;
    default:           return 0.65;
  }
}
function depthGroundYFrac(depth) {
  switch (depth) {
    case 'foreground': return 0.95;
    case 'midground':  return 0.78;
    case 'background': return 0.62;
    default:           return 0.95;
  }
}

// Analyse a colour mask region in `buf` and infer pose + facing direction.
// Returns { pose: 'front'|'threeQuarter'|'profile'|'back', flip: bool, meta }
async function analyzeSilhouette(buf, hex, bbox) {
  const tr = parseInt(hex.slice(1, 3), 16);
  const tg = parseInt(hex.slice(3, 5), 16);
  const tb = parseInt(hex.slice(5, 7), 16);
  const targetHue = rgbToHue(tr, tg, tb);
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;

  // Count mask pixels inside the bbox, split by left/right half of the bbox.
  let leftMass = 0, rightMass = 0, total = 0;
  // Also slice top/middle/bottom thirds — width at each tier helps spot the
  // shoulder-line offset that distinguishes 3/4 from profile.
  const tierWidths = [
    { minX: W, maxX: -1 }, // upper third
    { minX: W, maxX: -1 }, // middle third
    { minX: W, maxX: -1 }, // lower third
  ];
  const midX = bbox.x + Math.floor(bbox.width / 2);
  const tierBoundary1 = bbox.y + Math.floor(bbox.height / 3);
  const tierBoundary2 = bbox.y + Math.floor((bbox.height * 2) / 3);

  for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.width; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const maxCh = Math.max(r, g, b);
      const minCh = Math.min(r, g, b);
      const sat = (maxCh - minCh) / (maxCh || 1);
      if (sat < 0.55 || maxCh < 80) continue;
      const hue = rgbToHue(r, g, b);
      let dh = Math.abs(hue - targetHue);
      if (dh > 180) dh = 360 - dh;
      if (dh > 35) continue;
      total++;
      if (x < midX) leftMass++; else rightMass++;
      const tier = y < tierBoundary1 ? 0 : (y < tierBoundary2 ? 1 : 2);
      if (x < tierWidths[tier].minX) tierWidths[tier].minX = x;
      if (x > tierWidths[tier].maxX) tierWidths[tier].maxX = x;
    }
  }

  const asymmetry = total > 0 ? (rightMass - leftMass) / total : 0; // > 0 means heavier on the right
  const aspect = bbox.height / bbox.width;

  // Tier widths — head vs torso vs legs widths
  const tw = tierWidths.map(t => t.maxX >= t.minX ? t.maxX - t.minX + 1 : 0);

  // Heuristics:
  // - aspect > 2.2: tall thin → front or back (slender silhouette)
  // - aspect 1.5–2.2: 3/4 view — shoulder line wider than head
  // - aspect < 1.5: profile (body short relative to height because chest/feet stick out)
  // - |asymmetry| > 0.10: figure is rotated away from camera centre.
  //   Sign tells which way: rightMass > leftMass → body extends to the right
  //   → figure FACES LEFT (head/back to the right, chest/feet pointing left).
  //   (Standing figure's profile bulge is on the chest/face side.)
  let pose, flip = false;
  if (aspect >= 2.2) {
    pose = 'front'; // could be back too — disambiguated below if a back-cue present
  } else if (aspect >= 1.6) {
    pose = Math.abs(asymmetry) > 0.10 ? 'threeQuarter' : 'front';
  } else {
    pose = 'profile';
  }
  // Direction: positive asymmetry → mass leans right → figure faces left (we flip cell to face left)
  // The 2×4 cells face the camera's right by default. Flip when figure faces left.
  if (pose !== 'front' && pose !== 'back') {
    flip = asymmetry > 0;
  }

  return { pose, flip, asymmetry, aspect, tierWidths: tw, totalMass: total };
}

async function runSceneBlocking(scene) {
  const dir = path.join(OUT_ROOT, scene.id);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n══ ${scene.id} (blocking mode) ══`);

  // 1) ONE Grok call — generate the blocking image
  console.log('  → generating blocking image (Grok decides placement)…');
  const blocking = await grokGenerate(scene.blockingPrompt, '16:9');
  fs.writeFileSync(path.join(dir, '1_blocking.png'), blocking.buf);
  const meta = await sharp(blocking.buf).metadata();
  console.log(`    ✓ ${meta.width}×${meta.height} (${blocking.ms}ms)`);

  // 2) Detect each character's bbox in the blocking image
  console.log('  → detecting colour bboxes…');
  const bboxes = {};
  for (const c of scene.cast) {
    const bbox = await findColorBbox(blocking.buf, c.color);
    if (!bbox) {
      console.log(`    ⚠️  ${c.name} (${c.color}) — NO MATCH`);
    } else {
      console.log(`    ✓ ${c.name} (${c.color}): ${bbox.width}×${bbox.height} at (${bbox.x}, ${bbox.y}) — ${bbox.pixels} px`);
    }
    bboxes[c.name] = bbox;
  }
  fs.writeFileSync(path.join(dir, '2_bboxes.json'), JSON.stringify(bboxes, null, 2));

  // 3) Prepare each character's cutout (cropped cell → cutout → flip → scale)
  const placements = [];
  for (let i = 0; i < scene.cast.length; i++) {
    const c = scene.cast[i];
    const bbox = bboxes[c.name];
    if (!bbox) continue;
    const char = CHARACTERS[c.name];
    const cellIdx = POSE_CELL[c.pose];
    console.log(`  → ${c.name}: cell ${cellIdx}, scale to ${bbox.height}px…`);

    const cellBuf = await cropCell(char.sheet, cellIdx);
    let cutBuf = await removeBackground(cellBuf);
    cutBuf = await trimTransparent(cutBuf);
    if (c.flip) cutBuf = await flipHorizontal(cutBuf);
    const scaled = await scaleToHeight(cutBuf, bbox.height);
    fs.writeFileSync(path.join(dir, `3_${i + 1}_${c.name}_cutout_scaled.png`), scaled);

    const sMeta = await sharp(scaled).metadata();
    const cx = bbox.x + Math.floor(bbox.width / 2);
    const bottomY = bbox.y + bbox.height;
    const left = Math.max(0, cx - Math.floor(sMeta.width / 2));
    const top = Math.max(0, bottomY - sMeta.height);
    placements.push({ name: c.name, buf: scaled, left, top });
  }

  // 4) Composite cutouts DIRECTLY onto the blocking image — same background,
  //    no second Grok call. The cutouts cover most of each silhouette;
  //    leftover coloured edges (a few px around each figure) get cleaned up
  //    by Pass 1.
  const composited = await sharp(blocking.buf)
    .composite(placements.map(p => ({ input: p.buf, left: p.left, top: p.top })))
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, '4_composited_on_blocking.png'), composited);

  // 5) Pass 1 — Grok edit. Two jobs: (a) erase any remaining flat-colour
  //    silhouette pixels around each figure, replacing with scene texture;
  //    (b) blend the pasted figures into the scene with consistent lighting.
  console.log('  → Pass 1 (Grok edit blend)…');
  const editPrompt = `Refine this children's book illustration. Real characters have been pasted on top of coloured silhouette placeholders. Two tasks:

1. REMOVE any remaining flat-coloured patches (red, blue, green, yellow blobs around the characters) — repaint those areas with surrounding scene texture so no solid-colour silhouette remains visible.
2. Blend each pasted character into the scene with matching watercolor lighting and edges. Keep each character's identity, face, hair, costume, position, size, and body angle IDENTICAL — do not move, resize, or change their facing direction.

Scene action: ${scene.finalAction}

Watercolor children's storybook style. NO TEXT in the output.`;
  const pass1 = await grokEdit(editPrompt, [composited]);
  fs.writeFileSync(path.join(dir, '5_pass1.png'), pass1.buf);
  console.log(`    ✓ Pass 1 in ${pass1.ms}ms`);

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    scene: scene.id, mode: 'blocking', bboxes,
    blockingMs: blocking.ms, pass1Ms: pass1.ms,
  }, null, 2));
}

async function runSceneThreeImage(scene) {
  const dir = path.join(OUT_ROOT, scene.id);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n══ ${scene.id} (three-image mode) ══`);

  // 1) IMAGE 1 — clean background (Grok generate)
  console.log('  → Image 1: clean background…');
  const bg = await grokGenerate(scene.cleanBackgroundPrompt, '16:9');
  fs.writeFileSync(path.join(dir, '1_clean_bg.png'), bg.buf);
  const meta = await sharp(bg.buf).metadata();
  console.log(`    ✓ ${meta.width}×${meta.height} (${bg.ms}ms)`);

  // 2) IMAGE 2 — blocking with silhouettes added (Grok edit on Image 1)
  console.log('  → Image 2: add silhouettes via Grok edit…');
  const blocking = await grokEdit(scene.addSilhouettesPrompt, [bg.buf], '16:9');
  fs.writeFileSync(path.join(dir, '2_blocking.png'), blocking.buf);
  console.log(`    ✓ blocking in ${blocking.ms}ms`);

  // 3) Detect bboxes only — skip orientation detection (unreliable). Pass 1
  //    will use the blocking image as a directional reference instead.
  console.log('  → detecting bboxes…');
  const bboxes = {};
  for (const c of scene.cast) {
    const bbox = await findColorBbox(blocking.buf, c.color);
    if (!bbox) { console.log(`    ⚠️  ${c.name} (${c.color}) — NO MATCH`); continue; }
    bboxes[c.name] = bbox;
    console.log(`    ✓ ${c.name}: bbox ${bbox.width}×${bbox.height} @ (${bbox.x},${bbox.y})`);
  }
  fs.writeFileSync(path.join(dir, '3_bboxes.json'), JSON.stringify(bboxes, null, 2));

  // 4) Cut each character in at the detected position + size. The pose and
  //    flip come from the cast config — we already told Grok to draw the
  //    silhouette in that direction, so we pick the matching cell.
  const placements = [];
  for (let i = 0; i < scene.cast.length; i++) {
    const c = scene.cast[i];
    const bbox = bboxes[c.name];
    if (!bbox) continue;
    const char = CHARACTERS[c.name];
    const cellIdx = POSE_CELL[c.pose] || POSE_CELL.front;
    console.log(`  → ${c.name}: cell ${cellIdx} (${c.pose})${c.flip ? ' flipped' : ''}, height ${bbox.height}px`);

    const cellBuf = await cropCell(char.sheet, cellIdx);
    let cutBuf = await removeBackground(cellBuf);
    cutBuf = await trimTransparent(cutBuf);
    if (c.flip) cutBuf = await flipHorizontal(cutBuf);
    const scaled = await scaleToHeight(cutBuf, bbox.height);
    fs.writeFileSync(path.join(dir, `4_${i + 1}_${c.name}_cutout.png`), scaled);

    const sMeta = await sharp(scaled).metadata();
    const cx = bbox.x + Math.floor(bbox.width / 2);
    const bottomY = bbox.y + bbox.height;
    const left = Math.max(0, cx - Math.floor(sMeta.width / 2));
    const top = Math.max(0, bottomY - sMeta.height);
    placements.push({ name: c.name, buf: scaled, left, top });
  }

  // 5) IMAGE 3 — composite cutouts on the CLEAN background (Image 1, untouched)
  console.log('  → Image 3: composite on clean background…');
  const composited = await sharp(bg.buf)
    .composite(placements.map(p => ({ input: p.buf, left: p.left, top: p.top })))
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, '5_composited.png'), composited);

  // 6) Pass 1 — blend the pasted characters into the scene. The figures are
  //    already in the correct direction (picked from the matching 2×4 cell),
  //    so Pass 1 only needs to smooth edges, harmonise lighting, and apply
  //    the scene action.
  console.log('  → Pass 1 (Grok edit, blend only)…');
  const editPrompt = `Refine this children's book illustration. Real characters have been pasted onto a clean scene background at the correct positions, sizes, and body directions. Blend each character into the scene: harmonise watercolor lighting, soften pasted edges, add subtle shadows on the ground. Preserve each character's identity, face, hair, costume, position, size, and body direction EXACTLY — do not move, resize, rotate, or change facing direction. Apply the scene action: ${scene.finalAction}. Watercolor children's storybook style. NO TEXT.`;
  const pass1 = await grokEdit(editPrompt, [composited], '16:9');
  fs.writeFileSync(path.join(dir, '6_pass1.png'), pass1.buf);
  console.log(`    ✓ Pass 1 in ${pass1.ms}ms`);

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    scene: scene.id, mode: 'three-image', bboxes,
    bgMs: bg.ms, blockingMs: blocking.ms, pass1Ms: pass1.ms,
  }, null, 2));
}

async function runScene(scene) {
  if (scene.mode === 'three-image') return runSceneThreeImage(scene);
  if (scene.mode === 'blocking') return runSceneBlocking(scene);
  const dir = path.join(OUT_ROOT, scene.id);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n══ ${scene.id} ══`);

  // 1) Generate empty-scene background
  console.log('  → generating empty scene background…');
  const bg = await grokGenerate(scene.description + ' Watercolor children\'s storybook style.', '16:9');
  fs.writeFileSync(path.join(dir, '1_background.png'), bg.buf);
  const bgMeta = await sharp(bg.buf).metadata();
  console.log(`    ✓ ${bgMeta.width}×${bgMeta.height} (${bg.ms}ms)`);

  const W = bgMeta.width, H = bgMeta.height;

  // 2) Per-character cutouts (cropped cell → rembg → optional flip → scale → place)
  const cutouts = [];
  // age-table scaling — only used when the cast entry doesn't supply absolute scale/depth.
  const TALLEST_PX = Math.round(H * 0.65);
  let maxAge = 0;
  for (const c of scene.cast) maxAge = Math.max(maxAge, CHARACTERS[c.name].age);
  const refHeightCm = heightCm(maxAge);

  for (let i = 0; i < scene.cast.length; i++) {
    const c = scene.cast[i];
    const char = CHARACTERS[c.name];
    const cellIdx = POSE_CELL[c.pose];
    if (!cellIdx) throw new Error(`unknown pose: ${c.pose}`);
    console.log(`  → ${c.name}: cell ${cellIdx} (${c.pose})${c.flip ? ' [flipped]' : ''}…`);

    const cellBuf = await cropCell(char.sheet, cellIdx);
    fs.writeFileSync(path.join(dir, `2_${i + 1}_${c.name}_cell${cellIdx}.png`), cellBuf);

    let cutBuf = await removeBackground(cellBuf);
    cutBuf = await trimTransparent(cutBuf);
    if (c.flip) cutBuf = await flipHorizontal(cutBuf);
    fs.writeFileSync(path.join(dir, `3_${i + 1}_${c.name}_cutout.png`), cutBuf);

    // Scale: prefer absolute depth/scale on the cast entry; fall back to age-based.
    let targetH;
    if (c.depth) {
      targetH = Math.round(H * depthBaseFraction(c.depth) * (c.scale || 1));
    } else {
      const charHeightCm = heightCm(char.age);
      targetH = Math.round(TALLEST_PX * (charHeightCm / refHeightCm) * (c.scale || 1));
    }
    const scaled = await scaleToHeight(cutBuf, targetH);
    fs.writeFileSync(path.join(dir, `4_${i + 1}_${c.name}_scaled.png`), scaled);

    const sMeta = await sharp(scaled).metadata();
    const groundY = Math.round(H * (c.depth ? depthGroundYFrac(c.depth) : 0.95));
    let left, top;
    if (typeof c.xFrac === 'number') {
      const cx = Math.round(W * c.xFrac);
      left = Math.max(0, cx - Math.floor(sMeta.width / 2));
      top = Math.max(0, groundY - sMeta.height);
    } else {
      // legacy left-to-right placement when no xFrac specified
      const slotW = Math.floor(W / scene.cast.length);
      const slotCentre = slotW * i + Math.floor(slotW / 2);
      left = Math.max(0, slotCentre - Math.floor(sMeta.width / 2));
      top = Math.max(0, groundY - sMeta.height);
    }
    cutouts.push({ name: c.name, buf: scaled, left, top });
  }

  // 3a) Normal cutout composite (always produced for comparison)
  console.log('  → compositing cutouts onto background…');
  const cutoutComposites = cutouts.map(c => ({ input: c.buf, left: c.left, top: c.top }));
  const composited = await sharp(bg.buf).composite(cutoutComposites).png().toBuffer();
  fs.writeFileSync(path.join(dir, '5_composited.png'), composited);

  let pass1Input = composited;
  let refs = [composited];
  let editPrompt;

  // 3b) Coloured-placeholder composite — opaque silhouettes in per-character colour
  if (scene.coloured) {
    const colouredComposites = [];
    for (const c of cutouts) {
      const colour = COLORS[c.name] || '#888888';
      const silhouette = await toColoredSilhouette(c.buf, colour);
      colouredComposites.push({ input: silhouette, left: c.left, top: c.top });
    }
    const colouredScene = await sharp(bg.buf).composite(colouredComposites).png().toBuffer();
    fs.writeFileSync(path.join(dir, '5b_colored_placeholders.png'), colouredScene);
    pass1Input = colouredScene;

    const sheets = scene.cast.map(c => CHARACTERS[c.name].sheet)
      .filter((v, i, a) => a.indexOf(v) === i);
    const stitched = await stitchSheets(sheets);
    fs.writeFileSync(path.join(dir, '5c_stitched_refs.png'), stitched);

    const colourLines = scene.cast.map(c => {
      const ch = CHARACTERS[c.name];
      return `  ${COLORS[c.name]} silhouette = ${c.name} (${ch.costume})`;
    }).join('\n');

    editPrompt = `Image 1 shows a children's book scene with COLOURED PLACEHOLDER SILHOUETTES marking where each character belongs. Image 2 is a stitched reference sheet showing each character at front / 45° / profile / back views.

REPLACE each coloured silhouette in Image 1 with the matching character from Image 2. Keep each silhouette's EXACT POSITION, SIZE, and BODY ANGLE — do not move, resize, or rotate. Every coloured silhouette must become a fully-rendered character; none may be dropped, none may be merged. ${scene.cast.length} silhouettes in, ${scene.cast.length} characters out.

Colour → character map:
${colourLines}

Action context: ${scene.finalAction}

Keep the background of Image 1 unchanged. Render in watercolor children's storybook style. NO TEXT in the output.`;
    refs = [pass1Input, stitched];
  } else {
    editPrompt = `Refine this children's book illustration. The characters have been composited onto the background. Repaint them so they look natural in the scene (correct lighting, soft watercolor shading, integrated with the background). Apply this action: ${scene.finalAction}. Keep each character's face, hair, and costume identical to how they are composited. Keep the same camera angle and the same background. Watercolor children's storybook style.`;
  }

  // 4) Pass 1 — Grok edit
  console.log('  → Pass 1 (Grok edit)…');
  const pass1 = await grokEdit(editPrompt, refs);
  fs.writeFileSync(path.join(dir, '6_pass1.png'), pass1.buf);
  console.log(`    ✓ Pass 1 in ${pass1.ms}ms`);

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    scene: scene.id,
    coloured: !!scene.coloured,
    description: scene.description,
    finalAction: scene.finalAction,
    cast: scene.cast,
    bgMs: bg.ms,
    pass1Ms: pass1.ms,
  }, null, 2));
}

(async () => {
  const onlyId = process.argv.find(a => a.startsWith('--only='))?.split('=')[1];
  const scenes = onlyId ? SCENES.filter(s => s.id === onlyId) : SCENES;
  for (const scene of scenes) {
    try {
      await runScene(scene);
    } catch (err) {
      console.error(`✗ ${scene.id} failed: ${err.message}`);
    }
  }
  console.log(`\nAll done. Output: ${OUT_ROOT}`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
