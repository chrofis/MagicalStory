#!/usr/bin/env node
/**
 * Manual two-pass composite test (v3):
 *   1. Fetch styled-avatar URLs for a story's characters (from the user that
 *      owns the story) — extract the BODY-FRONT quadrant from each 2x2
 *      avatar grid.
 *   2. Scale figures by real-world height (age → cm → px on canvas).
 *   3. Composite all of them onto a landmark from historical_locations.
 *   4. Send composite + refs to Grok (max 5 slots) AND/OR Gemini in one run.
 *
 * Usage:
 *   node scripts/test-manual-composite.js [--story=<id>] [--user=<id>] [--landmark=q] [--max=N] [--style=...] [--blender=both|grok|gemini]
 *
 * Examples:
 *   node scripts/test-manual-composite.js --story=job_1778013683956_j0i3jyen0 --max=7 --blender=both
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');

function arg(name, dflt = null) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : dflt;
}

const STORY_ID = arg('story');
const USER_ID = arg('user');
const LANDMARK_QUERY = arg('landmark', 'tellsplatte');
const MAX_CHARS = parseInt(arg('max', '7'), 10);
const STYLE_HINT = arg('style', "watercolor children's storybook illustration, soft brushwork, gentle colors");
const BLENDER = arg('blender', 'grok'); // grok | gemini | both — default grok (Gemini refuses dense composites)
const USE_REMBG = !process.argv.includes('--no-rembg'); // on by default
const REMBG_URL = arg('rembg-url', 'http://localhost:5000/remove-bg');
const SCENE_KIND = arg('scene', 'village'); // closeup | room | village | panorama
const DEPTHS_ARG = arg('depths', null);     // optional CSV: foreground,midground,...
const ROW_DEPTH = arg('row', null);         // when set: put ALL chars at this depth (foreground|midground|background)
const SCALE_BOOST = parseFloat(arg('scale', '1.0')); // multiply final figure heights (e.g. 1.2 → 20% bigger)
const GROUND_FRAC_ARG = arg('ground', null);         // override ground line as fraction of H (e.g. 0.98)
const OVERLAP_FRAC = parseFloat(arg('overlap', '0')); // ≥0: fraction of avg figure width that neighbours overlap
const LAYOUT = arg('layout', null);                  // null | 'halfcircle' | 'row'
const POLE_X_FRAC = parseFloat(arg('pole-x', '0.5')); // x of focal pole (fraction of W)
const POLE_Y_FRAC = parseFloat(arg('pole-y', '0.40')); // y of focal pole (fraction of H, where chars look up to)
const FLIP_NAMES = (arg('flip', '') || '')           // CSV of character names to horizontally flip
  .split(',').map(s => s.trim()).filter(Boolean);
const MODE = arg('mode', null);                      // null|'cover' — cover-page-style prompt
const CONTEXT = arg('context', '');                  // optional extra scene/prop context appended to prompt
const TWO_PASS = process.argv.includes('--two-pass'); // pass1 = poses on white bg; pass2 = paint over real landmark

// Scene-scale: how much of the canvas height a foreground adult should fill.
// Tighter scenes (closeup, indoor room) → figures dominate. Wider scenes
// (village square, panorama) → figures are smaller, leaving room for the
// landmark.
function sceneScale(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'closeup':  return 1.00;  // tightly framed indoor portrait
    case 'room':     return 0.85;  // domestic interior, midground close
    case 'village':  return 0.62;  // marketplace / street — landmark visible
    case 'panorama': return 0.42;  // mountains, lake — figures small
    default:         return 0.62;
  }
}
// Depth multiplier on figure height (front 100%, mid 60%, back 30%).
function depthFactor(depth) {
  switch (String(depth || '').toLowerCase()) {
    case 'foreground': return 1.00;
    case 'midground':  return 0.60;
    case 'background': return 0.32;
    default:           return 1.00;
  }
}
// Depth-specific ground-line Y as a fraction of canvas height
// (background characters stand "higher" because they're further away).
function depthGroundY(depth, H) {
  switch (String(depth || '').toLowerCase()) {
    case 'foreground': return Math.round(H * 0.96);
    case 'midground':  return Math.round(H * 0.78);
    case 'background': return Math.round(H * 0.62);
    default:           return Math.round(H * 0.96);
  }
}
// Sort characters by importance: main → child (age ≤ 12) → adult.
// This is the rule for cover/intro pages: mains anchor the centre, other
// children sit immediately around them, adults occupy the wings.
function sortByImportance(chars) {
  return chars.slice().sort((a, b) => {
    const score = (c) => {
      if (c.is_main === 'true') return 0;
      const age = parseInt(c.age, 10);
      if (Number.isFinite(age) && age <= 12) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
}

// Within each importance tier, reorder so that genders alternate as much as
// possible (M-F-M-F or F-M-F-M). When tiers cross, the alternation seed for
// the next tier flips based on the last tier's last char so the boundary
// stays alternated too. Best-effort — when one gender is over-represented
// the surplus clusters at the end.
function alternateByGender(chars) {
  if (chars.length <= 2) return chars;
  // Group by importance tier (preserve sortByImportance ordering)
  const tier = (c) => {
    if (c.is_main === 'true') return 0;
    const age = parseInt(c.age, 10);
    if (Number.isFinite(age) && age <= 12) return 1;
    return 2;
  };
  const tiers = new Map(); // tierIdx → [chars]
  for (const c of chars) {
    const t = tier(c);
    if (!tiers.has(t)) tiers.set(t, []);
    tiers.get(t).push(c);
  }
  const out = [];
  let lastGender = null;
  for (const t of [0, 1, 2]) {
    const group = tiers.get(t) || [];
    if (group.length === 0) continue;
    // Split this tier by gender
    const males = group.filter(c => String(c.gender || '').toLowerCase() === 'male');
    const females = group.filter(c => String(c.gender || '').toLowerCase() === 'female');
    const others = group.filter(c => !['male', 'female'].includes(String(c.gender || '').toLowerCase()));
    // Decide which gender starts: opposite of `lastGender` when known.
    // When sizes are unequal, start with the more numerous gender so the
    // surplus ends up split, not all at the end.
    let startWithMale;
    if (lastGender === 'male') startWithMale = false;
    else if (lastGender === 'female') startWithMale = true;
    else startWithMale = males.length >= females.length;
    const a = startWithMale ? males.slice() : females.slice();
    const b = startWithMale ? females.slice() : males.slice();
    while (a.length || b.length) {
      if (a.length) { const c = a.shift(); out.push(c); lastGender = String(c.gender || '').toLowerCase(); }
      if (b.length) { const c = b.shift(); out.push(c); lastGender = String(c.gender || '').toLowerCase(); }
    }
    // Append unknown-gender characters at the end of the tier
    for (const c of others) { out.push(c); lastGender = null; }
  }
  return out;
}

// Center-out arrangement with gender alternation, supporting any number of
// flagged mains. Algorithm:
//   1. Split into mains and non-mains.
//   2. CENTRE BLOCK = the central K positions, where K = max(1, mains.length).
//      - If K mains: place them inside the block, centre-out, alternating
//        by gender (the highest-priority main lands at the geometric centre
//        of the block; the second flanks them; etc.).
//      - If 0 mains: the centre slot gets the highest-priority NON-main of
//        the MAJORITY gender, so the outward alternation works.
//   3. WINGS: positions outside the block, filled outward from each edge
//      with the next-priority non-main whose gender flips the edge's gender.
//      Falls back to the next priority when the desired gender is exhausted.
function arrangeCenterOut(sorted) {
  const n = sorted.length;
  if (n === 0) return [];
  const out = new Array(n);
  const flip = (g) => g === 'male' ? 'female' : g === 'female' ? 'male' : null;
  const genderOf = (c) => String(c?.gender || '').toLowerCase();

  const mains = [];
  const nonMains = [];
  for (const c of sorted) {
    if (c.is_main === 'true') mains.push(c);
    else nonMains.push(c);
  }

  // ─── Centre block ────────────────────────────────────────────────────
  const K = Math.max(1, mains.length);
  const blockStart = Math.floor((n - K) / 2);
  const blockEnd = blockStart + K; // exclusive

  if (mains.length === 0) {
    // Pick non-main centre as majority-gender's highest-priority entry.
    let male = 0, female = 0;
    for (const c of nonMains) {
      const g = genderOf(c);
      if (g === 'male') male++; else if (g === 'female') female++;
    }
    let pickIdx = 0;
    if (male !== female) {
      const target = male > female ? 'male' : 'female';
      const idx = nonMains.findIndex(c => genderOf(c) === target);
      if (idx >= 0) pickIdx = idx;
    }
    out[blockStart] = nonMains[pickIdx];
    nonMains.splice(pickIdx, 1);
  } else {
    // Place mains inside the block, centre-out, alternating by gender.
    const inner = new Array(K);
    const innerCentre = Math.floor((K - 1) / 2);
    inner[innerCentre] = mains[0];
    const usedMain = new Set([0]);
    const innerCentreGender = genderOf(mains[0]);
    const innerOffsets = [];
    for (let d = 1; d <= Math.max(innerCentre, K - 1 - innerCentre); d++) {
      if (innerCentre + d < K) innerOffsets.push(d);
      if (innerCentre - d >= 0) innerOffsets.push(-d);
    }
    for (const off of innerOffsets) {
      const want = (Math.abs(off) % 2 === 0) ? innerCentreGender : flip(innerCentreGender);
      let pick = -1;
      if (want) {
        for (let i = 0; i < mains.length; i++) {
          if (usedMain.has(i)) continue;
          if (genderOf(mains[i]) === want) { pick = i; break; }
        }
      }
      if (pick === -1) {
        for (let i = 0; i < mains.length; i++) {
          if (!usedMain.has(i)) { pick = i; break; }
        }
      }
      inner[innerCentre + off] = mains[pick];
      usedMain.add(pick);
    }
    // Copy block into final layout
    for (let k = 0; k < K; k++) out[blockStart + k] = inner[k];
  }

  // ─── Wings: fill outward from each edge of the block ────────────────
  const pickByGender = (want) => {
    if (want) {
      for (let i = 0; i < nonMains.length; i++) {
        if (genderOf(nonMains[i]) === want) return i;
      }
    }
    return nonMains.length > 0 ? 0 : -1;
  };

  // Right wing — positions blockEnd … n-1
  let nextWant = flip(genderOf(out[blockEnd - 1]));
  for (let pos = blockEnd; pos < n; pos++) {
    const idx = pickByGender(nextWant);
    if (idx === -1) break;
    out[pos] = nonMains[idx];
    nonMains.splice(idx, 1);
    nextWant = flip(genderOf(out[pos]));
  }

  // Left wing — positions blockStart-1 … 0
  nextWant = flip(genderOf(out[blockStart]));
  for (let pos = blockStart - 1; pos >= 0; pos--) {
    const idx = pickByGender(nextWant);
    if (idx === -1) break;
    out[pos] = nonMains[idx];
    nonMains.splice(idx, 1);
    nextWant = flip(genderOf(out[pos]));
  }

  return out;
}

// Distribute depths across N characters when no --depths CSV given:
// front-load the most prominent (sorted main first) and push the rest back.
function autoDepths(n) {
  if (n <= 1) return ['foreground'];
  if (n === 2) return ['foreground', 'foreground'];
  if (n === 3) return ['foreground', 'foreground', 'midground'];
  if (n === 4) return ['foreground', 'foreground', 'midground', 'midground'];
  if (n === 5) return ['foreground', 'foreground', 'midground', 'midground', 'background'];
  if (n === 6) return ['foreground', 'foreground', 'midground', 'midground', 'background', 'background'];
  // 7+: 2 fg, 3 mg, rest bg
  const out = ['foreground', 'foreground', 'midground', 'midground', 'midground'];
  while (out.length < n) out.push('background');
  return out;
}

const ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ──────────────────────────────────────────────────────────────────────
// Real-world height by age (cm). Tallest character maps to TARGET_TALLEST_PX.
// ──────────────────────────────────────────────────────────────────────
const TARGET_TALLEST_PX = 920; // tallest figure on a 1024×1365 canvas

function heightCm(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n)) return 175; // unknown → adult
  // Approx WHO growth chart values (round numbers, not gendered)
  if (n <= 1) return 75;
  if (n <= 2) return 87;
  if (n <= 3) return 95;
  if (n <= 4) return 102;
  if (n <= 5) return 110;
  if (n <= 6) return 116;
  if (n <= 7) return 122;
  if (n <= 8) return 128;
  if (n <= 9) return 134;
  if (n <= 10) return 140;
  if (n <= 11) return 145;
  if (n <= 12) return 150;
  if (n <= 13) return 158;
  if (n <= 14) return 162;
  if (n <= 15) return 167;
  if (n <= 16) return 170;
  if (n <= 17) return 172;
  // Adults: slight shrink with age
  if (n <= 60) return 175;
  if (n <= 75) return 170;
  return 165;
}

async function loadImage(src) {
  if (!src) return null;
  // Object shape from R2 migration: { imageUrl, imageData }
  if (typeof src === 'object') {
    return loadImage(src.imageUrl || src.imageData);
  }
  if (typeof src !== 'string') return null;
  if (src.startsWith('data:')) return Buffer.from(src.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src);
    if (!r.ok) { console.warn(`  fetch ${src.slice(0, 60)}... → ${r.status}`); return null; }
    return Buffer.from(await r.arrayBuffer());
  }
  try { return Buffer.from(src, 'base64'); } catch { return null; }
}

// Real ML cutout via the existing /remove-bg Python endpoint (rembg + U2-Net).
// Falls back to null on any failure so the caller can chroma-key as fallback.
async function rembgRemove(buf) {
  try {
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    const r = await fetch(REMBG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, max_size: 1024 }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      console.warn(`   rembg HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    if (!j.success || !j.image) {
      console.warn(`   rembg returned ${j.error || 'no image'}`);
      return null;
    }
    return Buffer.from(j.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  } catch (e) {
    console.warn(`   rembg call failed: ${e.message}`);
    return null;
  }
}

/**
 * Remove the avatar background via edge-flood-fill chroma key.
 *
 * Approach:
 *   1. Sample the 4 corners → median bg color
 *   2. Flood-fill from every edge pixel that matches the bg (BFS),
 *      keeping ONLY edge-connected matches transparent. Pixels inside
 *      the figure that happen to share the bg color stay opaque.
 *   3. Soft alpha edge for pixels in [threshold, threshold * 1.5] so the
 *      cutout doesn't look razor-cut.
 *
 * Works on watercolor / painterly backgrounds where the bg isn't a
 * single solid colour but a connected region around the figure.
 */
async function removeStudioBg(buf, threshold = 45) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const CH = 4;

  // Median bg color from 4 corners (8×8 patches)
  const samplePatch = (x0, y0, w = 8, h = 8) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + h && y < height; y++) {
      for (let x = x0; x < x0 + w && x < width; x++) {
        const i = (y * width + x) * CH;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return n > 0 ? [r / n, g / n, b / n] : null;
  };
  const samples = [
    samplePatch(0, 0),
    samplePatch(width - 8, 0),
    samplePatch(0, height - 8),
    samplePatch(width - 8, height - 8),
  ].filter(Boolean);
  const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const bgR = med(samples.map(s => s[0]));
  const bgG = med(samples.map(s => s[1]));
  const bgB = med(samples.map(s => s[2]));

  const distSq = (i) => {
    const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB;
    return dr * dr + dg * dg + db * db;
  };
  const T_HARD = threshold * threshold;
  const T_SOFT = (threshold * 1.5) * (threshold * 1.5);

  // Visited mask + queue for BFS flood from edges
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0, qTail = 0;

  const enqueueIf = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = y * width + x;
    if (visited[idx]) return;
    if (distSq(idx * CH) > T_SOFT) { visited[idx] = 1; return; }
    visited[idx] = 1;
    queue[qTail++] = idx;
  };

  // Seed BFS with all edge pixels
  for (let x = 0; x < width; x++) { enqueueIf(x, 0); enqueueIf(x, height - 1); }
  for (let y = 0; y < height; y++) { enqueueIf(0, y); enqueueIf(width - 1, y); }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = Math.floor(idx / width);
    const pixel = idx * CH;
    const d2 = distSq(pixel);
    if (d2 < T_HARD) {
      data[pixel + 3] = 0;
    } else if (d2 < T_SOFT) {
      // Soft edge — proportional alpha
      const t = (Math.sqrt(d2) - threshold) / (threshold * 0.5);
      data[pixel + 3] = Math.max(0, Math.min(255, Math.round(255 * t)));
    } else {
      continue; // shouldn't happen due to enqueue gate
    }
    // Expand 4-connected neighbors
    enqueueIf(x + 1, y);
    enqueueIf(x - 1, y);
    enqueueIf(x, y + 1);
    enqueueIf(x, y - 1);
  }

  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ──────────────────────────────────────────────────────────────────────
// Extract body-front quadrant from a 2x2 styled-avatar grid.
// Layout (per server/lib/grok.js extractFaceAndBody):
//   ┌─────────────┬─────────────┐
//   │ Face Front  │ Face 3/4    │
//   ├─────────────┼─────────────┤
//   │ Body Front  │ Body Profile│   ← we want this (bottom-left)
//   └─────────────┴─────────────┘
// Detect separators via row/column variance (divider lines have lowest variance).
async function extractQuadrant(buffer, which = 'body-front') {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const aspect = meta.height / meta.width;
  if (aspect < 1.3 || aspect > 2.2) {
    // Not a 2x2 grid — return as-is
    return buffer;
  }
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Horizontal separator (face row ↔ body row)
  let minHVar = Infinity, separatorY = Math.floor(height / 2);
  const hStart = Math.floor(height * 0.25);
  const hEnd = Math.floor(height * 0.75);
  for (let y = hStart; y < hEnd; y++) {
    let sum = 0, sumSq = 0;
    for (let x = 0; x < width; x++) { const v = data[y * width + x]; sum += v; sumSq += v * v; }
    const mean = sum / width;
    const variance = sumSq / width - mean * mean;
    if (variance < minHVar) { minHVar = variance; separatorY = y; }
  }
  let minVVar = Infinity, separatorX = Math.floor(width / 2);
  const vStart = Math.floor(width * 0.3);
  const vEnd = Math.floor(width * 0.7);
  for (let x = vStart; x < vEnd; x++) {
    let sum = 0, sumSq = 0;
    for (let y = 0; y < height; y++) { const v = data[y * width + x]; sum += v; sumSq += v * v; }
    const mean = sum / height;
    const variance = sumSq / height - mean * mean;
    if (variance < minVVar) { minVVar = variance; separatorX = x; }
  }

  // Quadrant layout in the styled-avatar grid:
  //   ┌───────────────┬──────────────┐
  //   │ Face Front    │ Face 3/4     │
  //   ├───────────────┼──────────────┤
  //   │ Body Front    │ Body Profile │
  //   └───────────────┴──────────────┘
  let left, top, w, h;
  if (which === 'body-profile') {
    left = separatorX; top = separatorY; w = width - separatorX; h = height - separatorY;
  } else {
    // body-front (default)
    left = 0; top = separatorY; w = separatorX; h = height - separatorY;
  }
  return sharp(buffer).extract({ left, top, width: w, height: h }).toBuffer();
}

const extractBodyFront = (buf) => extractQuadrant(buf, 'body-front');
const extractBodyProfile = (buf) => extractQuadrant(buf, 'body-profile');

/**
 * Half-circle plan for N characters around a focal point.
 *   Wings (leftmost / rightmost) use BODY PROFILE (mirrored on left to face right).
 *   Centre uses BODY FRONT.
 *   Each slot has its own x-fraction, ground-y-fraction, depth-scale, and facing.
 *
 * For 7 chars the layout is:
 *   slot 0  far-left, profile, mirror,   x=0.10, depth=0.85, facing right
 *   slot 1  left,     profile, mirror,   x=0.24, depth=0.85, facing right
 *   slot 2  centre-l, front,             x=0.39, depth=0.80, facing camera (look up)
 *   slot 3  centre,   front,             x=0.50, depth=0.80, facing camera (look up)
 *   slot 4  centre-r, front,             x=0.61, depth=0.80, facing camera (look up)
 *   slot 5  right,    profile,           x=0.76, depth=0.85, facing left
 *   slot 6  far-right,profile,           x=0.90, depth=0.85, facing left
 *
 * Centre is "20% back" → smaller (0.80×). Wings "15% back" → 0.85×. Ground
 * line shifts up slightly with depth so the figures form a concave arc.
 */
function halfCirclePlan(n) {
  if (n <= 1) return [{ xFrac: 0.5, depthScale: 1.0, groundFrac: 0.98, view: 'body-front', facing: 'camera-up', mirror: false }];

  // Wing/centre split. For 7 chars → 2 left wing, 3 centre, 2 right wing.
  // Generalised: leftWing = floor((n-3)/2) clamped to ≥0, then centre fills
  // the rest, then rightWing = leftWing.
  const leftWing = Math.max(0, Math.floor((n - 3) / 2));
  const rightWing = leftWing;
  const centre = n - leftWing - rightWing;
  const wingEndIdx = leftWing;          // first centre index
  const centreEndIdx = leftWing + centre; // first right-wing index

  const plan = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const xFrac = 0.10 + t * 0.80;

    let view, facing, mirror;
    let depthScale, groundFrac;
    if (i < wingEndIdx) {
      // Left wing — slightly back (15%), facing right, side-view mirrored
      view = 'body-profile'; facing = 'right'; mirror = true;
      depthScale = 0.85; groundFrac = 0.98;
    } else if (i >= centreEndIdx) {
      // Right wing — facing left, side-view (no mirror)
      view = 'body-profile'; facing = 'left'; mirror = false;
      depthScale = 0.85; groundFrac = 0.98;
    } else {
      // Centre — further back (20%), front view, gaze tilted up at pole
      view = 'body-front'; facing = 'camera-up'; mirror = false;
      depthScale = 0.80; groundFrac = 0.94;
    }
    plan.push({ xFrac, depthScale, groundFrac, view, facing, mirror });
  }
  return plan;
}

// ──────────────────────────────────────────────────────────────────────

async function main() {
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: dbUrl, ssl: { rejectUnauthorized: false },
    statement_timeout: 60000, query_timeout: 60000,
  });

  // 1. Pick user + auto-detect story art style
  let userId = USER_ID;
  let storyArtStyle = arg('avatar-style', null);
  const storyClothing = arg('avatar-clothing', 'standard');
  if (!userId && STORY_ID) {
    const r = await pool.query(`SELECT user_id FROM stories WHERE id=$1`, [STORY_ID]);
    userId = r.rows[0]?.user_id;
    if (!userId) { console.error('story not found'); process.exit(1); }
    console.log(`📖 story: ${STORY_ID}  user: ${userId}`);
    if (!storyArtStyle) {
      // Story.data is huge; raise statement_timeout for this one extraction
      try {
        const r2 = await pool.query({
          text: `SELECT data->>'artStyle' AS s FROM stories WHERE id=$1`,
          values: [STORY_ID],
          statement_timeout: 300000,
        });
        storyArtStyle = r2.rows[0]?.s || null;
      } catch (e) { console.warn(`   ⚠️  artStyle lookup failed: ${e.message}`); }
    }
  }
  if (!userId) {
    const r = await pool.query(`SELECT user_id FROM stories ORDER BY created_at DESC LIMIT 1`);
    userId = r.rows[0]?.user_id;
  }
  storyArtStyle = storyArtStyle || 'watercolor';
  console.log(`🎨 art style: ${storyArtStyle} / ${storyClothing}`);

  // 2. Pull characters from the STORY snapshot (stories.data.characters[]) —
  // that's where per-story costumed avatars live. The `characters` table only
  // has standard/formal variants. The story snapshot has the watercolor
  // medieval-costumed variants generated for THIS specific story.
  // When --story is not provided, fall back to the user's character row.
  let charQ;
  if (STORY_ID) {
    charQ = await pool.query({
      text: `
        SELECT
          ch->>'id'                                                            AS id,
          ch->>'name'                                                          AS name,
          ch->>'age'                                                           AS age,
          ch->>'gender'                                                        AS gender,
          ch->'avatars'->'styledAvatars'->$2->'costumed'                       AS styled_costumed,
          ch->'avatars'->'styledAvatars'->$2->$3                               AS styled,
          ch->'avatars'->'styledAvatars'->$2->'standard'                       AS styled_standard_fallback,
          ch->'avatars'->>'standardUrl'                                        AS base_url,
          ch->'avatars'->>'standard'                                           AS base_inline,
          ch->>'isMainCharacter'                                               AS is_main
        FROM stories, jsonb_array_elements(data->'characters') ch
        WHERE id = $1
      `,
      values: [STORY_ID, storyArtStyle, storyClothing],
      statement_timeout: 600000,
    });
  } else {
    charQ = await pool.query(`
      SELECT
        ch->>'id'                                                            AS id,
        ch->>'name'                                                          AS name,
        ch->>'age'                                                           AS age,
        ch->>'gender'                                                        AS gender,
        NULL                                                                 AS styled_costumed,
        ch->'avatars'->'styledAvatars'->$2->$3                               AS styled,
        ch->'avatars'->'styledAvatars'->$2->'standard'                       AS styled_standard_fallback,
        ch->'avatars'->>'standardUrl'                                        AS base_url,
        ch->'avatars'->>'standard'                                           AS base_inline,
        ch->>'isMainCharacter'                                               AS is_main
      FROM characters c, jsonb_array_elements(c.data->'characters') ch
      WHERE c.user_id = $1
    `, [userId, storyArtStyle, storyClothing]);
  }
  let allChars = charQ.rows.filter(r => r.styled_costumed || r.styled || r.styled_standard_fallback || r.base_url || r.base_inline);
  if (allChars.length === 0) { console.error(`no characters with styled avatars for user ${userId}`); process.exit(1); }

  // Importance sort: main > other-children > adults. This gives mains
  // priority for centre placement, children fill inner positions, adults
  // sit on the wings.
  const importanceSorted = sortByImportance(allChars).slice(0, MAX_CHARS);
  // Cover mode: arrangeCenterOut does priority-centred placement + gender
  // alternation outward from the centre directly. No pre-shuffle needed.
  // Default mode (row): pre-alternate by gender within each importance tier
  // so the row reads M-F-M-F-… end-to-end.
  const chosen = MODE === 'cover'
    ? arrangeCenterOut(importanceSorted)
    : alternateByGender(importanceSorted);
  console.log(`👥 ${chosen.length} characters: ${chosen.map(c => `${c.name}(${c.age}y, ${heightCm(c.age)}cm)`).join(', ')}`);

  // 3. Pick landmark — accept rows with EITHER photo_data (legacy) OR photo_url
  // (post-Phase-2 R2 migration nulled photo_data for migrated rows).
  const lmQ = await pool.query(`
    SELECT id, location_name, photo_data, photo_url, photo_attribution
    FROM historical_locations
    WHERE ((photo_data IS NOT NULL AND length(photo_data) > 0)
           OR (photo_url IS NOT NULL AND length(photo_url) > 0))
      AND (location_name ILIKE $1 OR location_query ILIKE $1 OR aliases::text ILIKE $1)
    ORDER BY photo_score DESC NULLS LAST LIMIT 1
  `, [`%${LANDMARK_QUERY}%`]);
  if (lmQ.rows.length === 0) { console.error(`no landmark "${LANDMARK_QUERY}"`); process.exit(1); }
  const landmark = lmQ.rows[0];
  console.log(`🏞️  ${landmark.location_name}`);
  const landmarkBuf = await loadImage(landmark.photo_data || landmark.photo_url);
  if (!landmarkBuf) { console.error('failed to load landmark'); process.exit(1); }

  // 4. Per-character: load avatar grid → extract body-front → height-scale
  const W = 1024, H = 1365;
  const outDir = path.join(ROOT, 'tests', `composite-${STAMP}`);
  fs.mkdirSync(outDir, { recursive: true });
  const charsDir = path.join(outDir, 'chars');
  fs.mkdirSync(charsDir, { recursive: true });

  // Per-character placement plan. Layouts:
  //   --layout=halfcircle → wings use side-view, centre uses front, depth-arc
  //   --row=<depth>       → all chars at one depth, simple row (existing)
  //   --depths=CSV        → explicit per-character depths
  //   default             → auto-distribute foreground/midground/background
  const halfCircle = LAYOUT === 'halfcircle' ? halfCirclePlan(chosen.length) : null;
  const depths = halfCircle
    ? halfCircle.map(() => 'midground')
    : ROW_DEPTH
      ? Array(chosen.length).fill(String(ROW_DEPTH).toLowerCase())
      : DEPTHS_ARG
        ? DEPTHS_ARG.split(',').map(s => s.trim().toLowerCase())
        : autoDepths(chosen.length);
  while (depths.length < chosen.length) depths.push('foreground');

  // Scene-wide scale factor: how big the FOREGROUND adult fills the canvas.
  // Tighter scenes → figures dominate; village/panorama → smaller, leaving
  // room for landmark.
  const scnFactor = sceneScale(SCENE_KIND);
  const tallestCm = Math.max(...chosen.map(c => heightCm(c.age)));
  const pxPerCmFg = (TARGET_TALLEST_PX * scnFactor) / tallestCm;
  console.log(`   scene=${SCENE_KIND} (×${scnFactor.toFixed(2)})  tallest=${tallestCm}cm → fg=${Math.round(TARGET_TALLEST_PX * scnFactor)}px  (${pxPerCmFg.toFixed(2)} px/cm)`);
  console.log(`   depths: ${depths.map((d, i) => `${chosen[i].name}=${d}`).join(', ')}`);
  if (USE_REMBG) console.log(`   bg removal: rembg via ${REMBG_URL} (chroma-key fallback if down)`);

  const figures = [];
  for (let idx = 0; idx < chosen.length; idx++) {
    const c = chosen[idx];
    const depth = depths[idx] || 'foreground';
    // styled_costumed is an object keyed by costume description, e.g.:
    //   { 'medieval swiss huntsman': 'data:image/jpeg;base64,...' }
    const costumedVal = c.styled_costumed && typeof c.styled_costumed === 'object'
      ? Object.values(c.styled_costumed)[0] || null
      : c.styled_costumed;
    const src = costumedVal || c.styled || c.styled_standard_fallback || c.base_url
              || (c.base_inline ? `data:image/png;base64,${c.base_inline}` : null);
    const buf = await loadImage(src);
    if (!buf) { console.log(`   ⚠️  ${c.name}: load failed`); continue; }

    // 1. Extract front or profile body quadrant per the layout plan.
    // --flip=NAMES toggles the mirror flag for those characters (lets the
    // user fix per-character profile-facing-direction quirks).
    const view = halfCircle ? halfCircle[idx].view : 'body-front';
    let mirror = halfCircle ? halfCircle[idx].mirror : false;
    if (FLIP_NAMES.some(n => n.toLowerCase() === c.name.toLowerCase())) {
      mirror = !mirror;
    }
    let bodyOnly = await extractQuadrant(buf, view);
    if (mirror && bodyOnly) {
      bodyOnly = await sharp(bodyOnly).flop().toBuffer();
    }

    // 2. Background removal — rembg (real ML) when available, chroma-key fallback
    let bgRemoved = null;
    if (USE_REMBG) {
      bgRemoved = await rembgRemove(bodyOnly);
      if (!bgRemoved) console.log(`   ${c.name}: rembg unavailable — falling back to chroma key`);
    }
    if (!bgRemoved) {
      bgRemoved = await removeStudioBg(bodyOnly).catch(err => {
        console.warn(`   ⚠️  ${c.name}: bg-remove failed (${err.message}), keeping bg`);
        return bodyOnly;
      });
    }

    // 3. Trim transparent border tight around the figure
    const trimmed = await sharp(bgRemoved).trim({ threshold: 1 }).toBuffer().catch(() => bgRemoved);
    const trimMeta = await sharp(trimmed).metadata();
    if (!trimMeta.width || !trimMeta.height) { console.log(`   ⚠️  ${c.name}: empty after trim`); continue; }

    // 4. Resize: real-world cm × scene-scale × depth-multiplier × scale-boost
    // Half-circle plan overrides depth-multiplier with its per-slot depthScale.
    const planScale = halfCircle ? halfCircle[idx].depthScale : depthFactor(depth);
    const targetH = Math.max(40, Math.round(heightCm(c.age) * pxPerCmFg * planScale * SCALE_BOOST));
    const resized = await sharp(trimmed).resize({ height: targetH }).png().toBuffer();
    const rmeta = await sharp(resized).metadata();
    fs.writeFileSync(path.join(charsDir, `${c.name}.png`), resized);
    const slotPlan = halfCircle ? halfCircle[idx] : null;
    figures.push({
      name: c.name,
      age: parseInt(c.age, 10) || null,
      depth,
      buffer: resized,
      width: rmeta.width,
      height: rmeta.height,
      slot: slotPlan,
      view,
    });
    const slotInfo = slotPlan ? ` slot=(x:${slotPlan.xFrac.toFixed(2)},${slotPlan.facing})` : '';
    console.log(`   ${c.name.padEnd(10)} age=${String(c.age).padStart(3)}  ${depth.padEnd(10)} ${view.padEnd(13)} → ${rmeta.width}×${rmeta.height}px${slotInfo}`);
  }
  if (figures.length === 0) { console.error('no figures'); process.exit(1); }

  // 4b. Pull cover/initial-page artifact references from the story's VB.
  // For 'cover' mode we composite these PROPS in front of the figures so
  // they look held / interacted with. We pull from coverHints.<key>.objects
  // (the LOC* / ART* IDs the story planner picked for the cover).
  // Also pull the story title — used to render title text on the cover.
  let propBuffers = [];
  let landmarkDescr = '';
  let storyTitle = '';
  if (STORY_ID) {
    try {
      const tQ = await pool.query({
        text: `SELECT data->>'title' AS title FROM stories WHERE id = $1`,
        values: [STORY_ID],
        statement_timeout: 600000,
      });
      storyTitle = tQ.rows[0]?.title || '';
      if (storyTitle) console.log(`📕 title: "${storyTitle}"`);
    } catch (e) { /* not fatal */ }
  }
  if (STORY_ID) {
    try {
      const hintKey = arg('hint', 'initialPage'); // initialPage | titlePage | backCover
      const r = await pool.query({
        text: `
          SELECT
            data->'coverHints'->$2->'objects' AS objects,
            (SELECT array_agg(loc->>'extractedDescription') FROM jsonb_array_elements(data->'visualBible'->'locations') loc
              WHERE loc->>'id' IN (SELECT jsonb_array_elements_text(data->'coverHints'->$2->'objects'))) AS loc_descs
          FROM stories WHERE id = $1
        `,
        values: [STORY_ID, hintKey],
        statement_timeout: 600000,
      });
      const objects = r.rows[0]?.objects || [];
      const locDescs = (r.rows[0]?.loc_descs || []).filter(Boolean);
      if (locDescs.length > 0) {
        landmarkDescr = locDescs.join(' ').slice(0, 800);
      }
      const artIds = objects.filter(id => /^ART\d+$/.test(id));
      if (artIds.length > 0) {
        const r2 = await pool.query({
          text: `
            SELECT a->>'id' AS id, a->>'name' AS name,
                   a->>'referenceImageUrl' AS url,
                   a->>'referenceImageData' AS inline,
                   a->>'extractedDescription' AS descr
            FROM stories, jsonb_array_elements(data->'visualBible'->'artifacts') a
            WHERE id = $1 AND a->>'id' = ANY($2::text[])
          `,
          values: [STORY_ID, artIds],
          statement_timeout: 600000,
        });
        for (const row of r2.rows) {
          const buf = await loadImage(row.url || row.inline);
          if (!buf) continue;
          // Bg-remove the prop so it composites cleanly on the scene
          let cleanBuf = await rembgRemove(buf);
          if (!cleanBuf) cleanBuf = await removeStudioBg(buf).catch(() => buf);
          const trimmed = await sharp(cleanBuf).trim({ threshold: 1 }).toBuffer().catch(() => cleanBuf);
          propBuffers.push({ id: row.id, name: row.name, buffer: trimmed, descr: row.descr || '' });
          console.log(`   prop: ${row.name} (${row.id})`);
        }
      }
    } catch (e) {
      console.warn(`   ⚠️  prop fetch failed: ${e.message}`);
    }
  }

  // 5. Composite onto landmark — depth-aware placement.
  // Group by depth: background → midground → foreground (paint order matters
  // so closer figures cover further ones at overlap points).
  // Two-pass mode: pass 1 uses a plain white canvas so Grok focuses ENTIRELY
  // on the pose redraw without distraction. The landmark gets composited in
  // pass 2 after we cut out the reposed figures.
  const bg = TWO_PASS
    ? await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg({ quality: 92 }).toBuffer()
    : await sharp(landmarkBuf).resize(W, H, { fit: 'cover', position: 'centre' }).toBuffer();
  const figs = figures;
  const margin = 24;
  const usableW = W - margin * 2;
  const composites = [];
  const placements = [];
  const orderedDepths = ['background', 'midground', 'foreground'];

  // Half-circle path: place each figure at its plan's xFrac/groundFrac directly.
  if (halfCircle) {
    for (const f of figs) {
      const groundY = Math.round(H * f.slot.groundFrac);
      const cx = Math.round(W * f.slot.xFrac);
      const left = Math.max(0, Math.min(W - f.width, cx - Math.round(f.width / 2)));
      const top = Math.max(0, groundY - f.height);
      composites.push({ input: f.buffer, left, top });
      placements.push({
        name: f.name, age: f.age, depth: f.depth,
        view: f.view, facing: f.slot.facing,
        left, top, width: f.width, height: f.height,
      });
    }
    const totalSumW = figs.reduce((s, f) => s + f.width, 0);
    console.log(`   layout: half-circle around (${POLE_X_FRAC.toFixed(2)},${POLE_Y_FRAC.toFixed(2)}) — sum width ${totalSumW}px on canvas ${W}px`);
    // Skip the row loop below
    /* fall-through to composite step */
  }

  // Row layout (default).
  // Step from figure i to i+1 is the AVERAGE of the two adjacent widths
  // times (1 - overlap). This keeps neighbours uniformly close regardless
  // of size — kids no longer end up with bigger visual gaps just because
  // they're narrower than the adults beside them.
  for (const depth of (halfCircle ? [] : orderedDepths)) {
    const row = figs.filter(f => f.depth === depth);
    if (row.length === 0) continue;
    const groundY = GROUND_FRAC_ARG
      ? Math.round(H * parseFloat(GROUND_FRAC_ARG))
      : depthGroundY(depth, H);
    const sumW = row.reduce((s, f) => s + f.width, 0);
    const overlap = OVERLAP_FRAC > 0 ? OVERLAP_FRAC : (sumW > usableW ? 0.20 : 0);

    // Compute centre-x for each figure using per-pair stepping.
    const centres = new Array(row.length);
    centres[0] = 0;
    for (let i = 1; i < row.length; i++) {
      const step = (row[i - 1].width + row[i].width) / 2 * (1 - overlap);
      centres[i] = centres[i - 1] + step;
    }
    // Translate so the row is canvas-centred.
    const span = centres[row.length - 1];
    const startCentre = (W - span) / 2;
    for (let i = 0; i < row.length; i++) centres[i] += startCentre;

    for (let i = 0; i < row.length; i++) {
      const f = row[i];
      const left = Math.max(0, Math.min(W - f.width, Math.round(centres[i] - f.width / 2)));
      const top = Math.max(0, groundY - f.height);
      composites.push({ input: f.buffer, left, top });
      placements.push({ name: f.name, age: f.age, depth: f.depth, left, top, width: f.width, height: f.height });
    }
  }
  const totalSumW = figs.reduce((s, f) => s + f.width, 0);
  console.log(`   layout: ${figs.length} figures across ${[...new Set(figs.map(f => f.depth))].join('/')} (sum width ${totalSumW}px, canvas ${W}px)`);

  // 5b. Composite props ON TOP of the figures so they appear in front.
  // Sized + positioned to overlap the figures' LOWER LEGS — that's what
  // "in foreground, on the ground in front of them" looks like in
  // perspective. Earlier 18%-height-near-bottom landed at shoe-level and
  // read as "next to the feet" rather than "in front".
  // 25% of H, bottom of prop flush with canvas bottom → top extends up
  // into the figures' shin/knee region.
  const propPlacements = [];
  if (propBuffers.length > 0) {
    const propTargetH = Math.round(H * 0.25);
    const propMargin = 16;
    const baseY = H - 8; // bottom of props at canvas bottom (8px breathing room)
    let propTotalW = 0;
    const sized = [];
    for (const p of propBuffers) {
      const buf = await sharp(p.buffer).resize({ height: propTargetH, withoutEnlargement: false }).png().toBuffer();
      const m = await sharp(buf).metadata();
      sized.push({ ...p, buffer: buf, width: m.width, height: m.height });
      propTotalW += m.width;
    }
    const gap = sized.length > 1 ? Math.max(8, Math.round(W * 0.02)) : 0;
    propTotalW += gap * (sized.length - 1);
    let cursor = Math.round((W - propTotalW) / 2);
    for (const p of sized) {
      const left = Math.max(propMargin, Math.min(W - p.width - propMargin, cursor));
      const top = Math.max(0, baseY - p.height);
      composites.push({ input: p.buffer, left, top });
      propPlacements.push({ id: p.id, name: p.name, left, top, width: p.width, height: p.height });
      cursor += p.width + gap;
      console.log(`   prop placed: ${p.name.padEnd(20)} ${p.width}×${p.height}px at (${left}, ${top})`);
    }
  }

  const compositeBuf = await sharp(bg).composite(composites).jpeg({ quality: 92 }).toBuffer();
  fs.writeFileSync(path.join(outDir, '01-manual-composite.jpg'), compositeBuf);
  console.log(`💾 ${outDir}/01-manual-composite.jpg`);

  // 6. Build prompt — strong, specific edit instructions so the blender
  // actually re-renders rather than returning the input unchanged.
  const placementSentences = placements.map((p) => {
    const xPct = Math.round((p.left + p.width / 2) / W * 100);
    const region = xPct < 33 ? 'left' : xPct < 66 ? 'center' : 'right';
    const facingNote = p.facing === 'right' ? ', facing right toward the central pole'
      : p.facing === 'left' ? ', facing left toward the central pole'
      : p.facing === 'camera-up' ? ', facing the camera with chin tilted UP toward the pole at top-centre'
      : '';
    return `- ${p.name} (age ${p.age}) in the ${region} (~${xPct}% across)${facingNote}.`;
  }).join('\n');

  const focalPctX = Math.round(POLE_X_FRAC * 100);
  const focalPctY = Math.round(POLE_Y_FRAC * 100);

  // Two prompt modes:
  //   'cover' — generic intro/cover-page group-portrait prompt. No focal-point
  //             references. Best for "all chars facing forward" intro pages.
  //   default — Tell-style half-circle around a focal pole (legacy).
  let prompt;
  if (MODE === 'cover' && TWO_PASS) {
    // Pass 1: figures on plain white bg. ONLY job is repose. No bg preserve,
    // no title, no style — keep the model focused.
    const n = placements.length;
    const centerIdx = Math.floor(n / 2);
    const propName = propPlacements[0]?.name || null;
    const positionLabel = (i) => {
      if (n === 1) return 'the figure';
      if (i === 0) return 'the leftmost figure';
      if (i === n - 1) return 'the rightmost figure';
      if (i === centerIdx) return 'the centre figure';
      if (i < centerIdx) return `the ${i === 1 ? 'second-from-left' : `${i + 1}th-from-left`} figure`;
      const fromRight = n - i;
      return `the ${fromRight === 2 ? 'second-from-right' : `${fromRight}th-from-right`} figure`;
    };
    const ageLabel = (age) => {
      const a = parseInt(age, 10);
      if (!Number.isFinite(a)) return 'figure';
      if (a <= 6) return 'small child';
      if (a <= 12) return 'older child';
      if (a <= 17) return 'teenager';
      if (a <= 60) return 'adult';
      return 'elderly figure';
    };
    const visualId = (i) => `${positionLabel(i)} (the ${ageLabel(placements[i].age)})`;
    const POSES = [];
    for (let i = 0; i < n; i++) {
      const me = visualId(i);
      let pose;
      if (i === centerIdx) {
        pose = propName
          ? `BOTH HANDS rest on the ${propName} on the ground in front. Body leans slightly forward over the prop. Head tilts down to look at the prop, then up at the viewer. NOT standing with arms at sides.`
          : `Holding hands with the figure to the immediate right. Body squared to camera, smiling. NOT standing with arms at sides.`;
      } else if (i < centerIdx) {
        pose = `RIGHT ARM raised and wrapped around ${visualId(i + 1)}'s shoulders, pulling that figure close. Body angled slightly to the right. NOT standing with arms at sides.`;
      } else {
        pose = `LEFT HAND placed on ${visualId(i - 1)}'s shoulder, fingers visible. Body angled slightly to the left. NOT standing with arms at sides.`;
      }
      POSES.push(`- ${me}: REDRAW the pose. New pose: ${pose}`);
    }
    prompt = `PASS 1: REPOSE FIGURES ONLY.

The input shows ${n} character cutouts on a plain white background, plus ${propPlacements.length} prop(s) in the foreground. The figures are pasted with ARMS AT THEIR SIDES — this is wrong, and your only job is to redraw their poses per the lines below. Keep the white background. Keep every face/hair/skin/clothing exactly. Keep every prop. Just change the poses.

═══ POSE REDRAW (mandatory — do every line) ═══
${POSES.join('\n')}

PRESERVE: every face, every hair colour, every skin tone, every clothing detail, every prop, the white background, the relative positions of the figures (leftmost stays leftmost etc.).

DO NOT add or remove characters. DO NOT change clothing. DO NOT add a landscape or any background. KEEP THE WHITE BACKGROUND. NO TEXT, no letters.

If any figure still has arms at their sides in your output, the task has failed.`;
  } else if (MODE === 'cover') {
    const n = placements.length;
    const centerIdx = Math.floor(n / 2);
    const propName = propPlacements[0]?.name || null;

    // Visual identifiers — Grok doesn't know character names from a single
    // composite, so we describe each figure by its POSITION + age category.
    const positionLabel = (i) => {
      if (n === 1) return 'the figure';
      if (i === 0) return 'the leftmost figure';
      if (i === n - 1) return 'the rightmost figure';
      if (i === centerIdx) return 'the centre figure';
      if (i < centerIdx) return `the ${i === 1 ? 'second-from-left' : `${i + 1}th-from-left`} figure`;
      const fromRight = n - i;
      return `the ${fromRight === 2 ? 'second-from-right' : `${fromRight}th-from-right`} figure`;
    };
    const ageLabel = (age) => {
      const a = parseInt(age, 10);
      if (!Number.isFinite(a)) return 'figure';
      if (a <= 6) return 'small child';
      if (a <= 12) return 'older child';
      if (a <= 17) return 'teenager';
      if (a <= 60) return 'adult';
      return 'elderly figure';
    };
    const visualId = (i) => {
      const p = placements[i];
      return `${positionLabel(i)} (the ${ageLabel(p.age)})`;
    };

    // Per-character pose assignments. Pattern (left-to-right):
    //   leftward of centre  → arm around the next-inward figure's shoulders
    //   centre              → both hands on the foreground prop (or hold neighbour's hand)
    //   rightward of centre → hand on the next-inward figure's shoulder
    // Every figure has a specific imperative and refers to neighbours by
    // their visual identifier (position + age), never by name.
    const POSES = [];
    for (let i = 0; i < n; i++) {
      const me = visualId(i);
      let pose;
      if (i === centerIdx) {
        pose = propName
          ? `BOTH HANDS rest on the ${propName} on the ground in front. Body leans slightly forward over the prop. Head tilts down to look at the prop, then up at the viewer. NOT standing with arms at sides.`
          : `Holding hands with the figure to the immediate right. Body squared to camera, smiling. NOT standing with arms at sides.`;
      } else if (i < centerIdx) {
        const target = visualId(i + 1);
        pose = `RIGHT ARM raised and wrapped around ${target}'s shoulders, pulling that figure close. Body angled slightly to the right toward ${target}. NOT standing with arms at sides.`;
      } else {
        const target = visualId(i - 1);
        pose = `LEFT HAND placed on ${target}'s shoulder, fingers visible. Body angled slightly to the left toward ${target}. NOT standing with arms at sides.`;
      }
      POSES.push(`- ${me}: REDRAW the pose. Currently shown standing neutrally with arms at sides — this is wrong. New pose: ${pose}`);
    }
    const poseBlock = POSES.join('\n');

    const charLines = placements.map((p, i) => {
      const note = i === centerIdx ? '(main / centre — anchor of the group)' : '';
      return `- ${visualId(i)}, age ${p.age}. ${note}`.trim();
    }).join('\n');

    const propLine = propPlacements.length > 0
      ? `\nFOREGROUND PROPS (already in the composite — keep them in front of the family, painted as shown):\n${propPlacements.map(p => `- ${p.name}: on the ground in front of the centre character, partially in front of their legs.`).join('\n')}\n`
      : '';

    // The composite already contains the correct landmark. Telling Grok to
    // "paint the background to match this description" backfired — it took
    // that as licence to redraw the background from scratch and ignore the
    // composite. Now we explicitly say: PRESERVE the composite's background
    // EXACTLY — no redrawing — and the description is supplementary identity
    // info only (in case it helps with style decisions on the architecture).
    const sceneLine = landmarkDescr
      ? `\nBACKGROUND (CRITICAL — do NOT redraw): the landmark behind the figures is ALREADY in the composite. Keep it pixel-faithful — do not invent a new background, do not generalise to a generic "old town", do not move buildings. Repaint only enough to apply the watercolor style on top of the existing structure. For reference, the depicted landmark is described below; this is supplementary, not an instruction to redraw:\n  >  ${landmarkDescr}\n`
      : `\nBACKGROUND (CRITICAL — do NOT redraw): the landmark behind the figures is ALREADY in the composite. Keep it pixel-faithful — do not invent a new background. Repaint only enough to apply the watercolor style on top of the existing structure. The landmark is "${landmark.location_name}".\n`;

    const titleBlock = storyTitle
      ? `\n═══ JOB D — TITLE TEXT ═══\nRender this exact title across the UPPER THIRD of the canvas: "${storyTitle}".\n- Hand-painted watercolor letterforms — NOT a system font, not flat digital text. Looks brushed by an illustrator.\n- Letters have depth, slight irregularity, integrated with the watercolor scene above the figures.\n- Do not place title text on or over the figures' faces. Title goes in the sky / upper background area.\n- This is the ONLY text in the image. No other letters, signs, or symbols.\n`
      : '';

    prompt = `THIS IS A COVER ILLUSTRATION COMPOSITE. You have FOUR independent jobs to do, and ALL of them must happen. Returning the input image with only style applied is a failure.

The input shows: ${n} character cutouts standing in a row with ARMS AT THEIR SIDES (this is WRONG — see Job B), ${propPlacements.length} prop cutout(s) pasted in the foreground, on top of a real landmark photograph (this background is correct — see Job A).

═══════════════════════════════════════════════════════════════
JOB A — PRESERVE THE BACKGROUND (do not redraw)
═══════════════════════════════════════════════════════════════
The landmark behind the figures is ALREADY in the input composite. Keep it pixel-faithful: same buildings, same architecture, same proportions, same window placement. Apply watercolor styling ON TOP of the existing structure — but do NOT invent a new background, do NOT generalise to a generic "old town", do NOT move buildings.${landmarkDescr ? ` The landmark depicted is described here for reference (do NOT use this as a redraw instruction): "${landmarkDescr.slice(0, 400)}"` : ''}

═══════════════════════════════════════════════════════════════
JOB B — REPOSE EVERY FIGURE (mandatory; this is the change)
═══════════════════════════════════════════════════════════════
The figures in the composite are pasted with their original neutral poses (arms at sides, no interaction). THIS IS WRONG. You MUST repose every single figure as listed below. Do not return the input poses. Do not preserve the arms-at-sides default. Every line below is a hard requirement:

${poseBlock}

If your output has any figure still standing with arms at their sides, the task has FAILED. The whole point of this edit is to put the family into the warm interacting group portrait described above.

═══════════════════════════════════════════════════════════════
JOB C — UNIFY THE STYLE
═══════════════════════════════════════════════════════════════
- Re-render every figure, every prop, and the landmark in this art style: ${STYLE_HINT}. NOT photoreal.
- Match a single global lighting direction across all figures, props, and the scene.
- Add natural ground shadows under feet and props.
- Soften cutout edges so the figures and props sit naturally on the ground.
- Composition fills the canvas edge-to-edge — no borders, no panels.
${titleBlock}
═══════════════════════════════════════════════════════════════
CHARACTERS (preserve identity from the composite — face, hair, skin, clothing exactly):
═══════════════════════════════════════════════════════════════
${charLines}
${propLine}${CONTEXT ? `\nADDITIONAL CONTEXT:\n${CONTEXT}\n` : ''}
═══════════════════════════════════════════════════════════════
HARD CONSTRAINTS:
═══════════════════════════════════════════════════════════════
- DO NOT add or remove characters.
- DO NOT swap which face goes where.
- DO NOT redraw the landmark scenery from scratch — preserve it from the composite.
- DO NOT skip the pose redraw — every figure's pose changes per the JOB B lines above.
- Other than the title (Job D), NO text, no letters, no signage anywhere in the image.`;
  } else {
    prompt = `Re-render this composite as a single unified watercolor children's-book illustration in this art style: ${STYLE_HINT}. NOT photoreal. The composite shows pasted bg-removed character cutouts on a real photograph of "${landmark.location_name}" — your job is to re-render it cleanly so all figures and the landmark belong in the same painted scene.

THE SCENE: All seven characters stand BEHIND the tall wooden pole topped with the feathered hat (the pole is at roughly (${focalPctX}%, ${focalPctY}%) of the canvas). The pole rises in front of them, between them and the viewer. Every character is gazing UPWARD at the feathered hat at the top of the pole — chin lifted, neck tilted back, head angled up.

Per-character placement and facing (left to right):
${placementSentences}

REQUIRED CHANGES (do all of these):
- Render every character in unified watercolor style — soft brushwork, gentle storybook colors. NOT photoreal.
- TILT every character's head UP. Chin lifted, eyes raised, neck angled back so they're physically looking up at the hat on top of the pole. This is a head-pose change, not just an eye-direction change.
- Position all characters BEHIND the pole — the pole sits between them and the viewer.
- The leftmost wing characters face right toward the pole; the centre group faces the camera with heads tilted up; the rightmost wing characters face left toward the pole. The whole group forms a concave arc of attention around the pole.
- Add natural ground shadows beneath each character's feet on the cobblestones.
- Match medieval Altdorf afternoon lighting (warm, soft, long shadows) consistently across all figures and the scene.
- Soften the cutout edges — figures must blend into the cobblestone surface naturally, not look pasted.

PRESERVE EXACTLY:
- Every character's face, hair, skin tone, clothing.
- The number of characters and their approximate left-to-right order.
- The landmark's silhouette (pole position, hat, church tower, mountains).

DO NOT add or remove characters. DO NOT swap faces.`;
  }

  fs.writeFileSync(path.join(outDir, 'prompt.txt'), prompt);

  const meta = {
    user: userId,
    story: STORY_ID || null,
    title: storyTitle || null,
    landmark: { id: landmark.id, name: landmark.location_name, attribution: landmark.photo_attribution },
    characters: placements,
    canvas: `${W}x${H}`,
    style: STYLE_HINT,
    runs: {},
  };

  // 7. Blenders
  if (BLENDER === 'grok' || BLENDER === 'both') {
    await grokBlend(prompt, compositeBuf, landmarkBuf, figs, outDir, meta);
  }
  if (BLENDER === 'gemini' || BLENDER === 'both') {
    await geminiBlend(prompt, compositeBuf, landmarkBuf, figs, outDir, meta);
  }

  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`\n📂 ${outDir}`);
  await pool.end();
}

// ──────────────────────────────────────────────────────────────────────
// Blenders
// ──────────────────────────────────────────────────────────────────────

async function grokBlend(prompt, compositeBuf, landmarkBuf, figures, outDir, meta) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) { console.warn('⚠️  XAI_API_KEY not set — skipping Grok'); return; }

  // Just send the manual composite — single ref, no extra slots.
  // The composite already has the landmark in the background and every
  // character in their pasted position; Grok's job is to re-render it
  // in unified style, not to compose anything new.
  const compositeUrl = `data:image/jpeg;base64,${compositeBuf.toString('base64')}`;
  fs.writeFileSync(path.join(outDir, 'grok-input.jpg'), compositeBuf);
  console.log(`📤 Grok: composite-only (1 slot)`);

  const body = {
    model: 'grok-imagine-image',
    prompt,
    response_format: 'b64_json',
    aspect_ratio: '3:4',
    image: { url: compositeUrl, type: 'image_url' },
  };
  const t0 = Date.now();
  const resp = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const elapsed = Date.now() - t0;
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`❌ Grok ${resp.status}: ${err.slice(0, 400)}`);
    fs.writeFileSync(path.join(outDir, 'grok-error.txt'), err);
    meta.runs.grok = { error: `HTTP ${resp.status}`, elapsedMs: elapsed };
    return;
  }
  const data = await resp.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) { console.error('❌ Grok: no image'); meta.runs.grok = { error: 'no image' }; return; }
  const pass1Buf = Buffer.from(b64, 'base64');
  const pass1Path = TWO_PASS ? '02a-pass1-poses.jpg' : '02a-grok-blended.jpg';
  fs.writeFileSync(path.join(outDir, pass1Path), pass1Buf);
  console.log(`✅ Grok ${(elapsed / 1000).toFixed(1)}s → ${pass1Path}`);
  meta.runs.grok = { elapsedMs: elapsed, slots: 1 };

  // ─── PASS 2 (only when --two-pass) ──────────────────────────────────
  // Take the reposed pass-1 result, cut the figures, lay them on the real
  // landmark, then ask Grok to convert to watercolor + blend with bg.
  if (TWO_PASS) {
    console.log(`🔁 Pass 2: cut reposed figures → composite on landmark → watercolor pass`);
    try {
      // 1. rembg the pass-1 result so we get figures + props on transparent bg.
      let cutout = await rembgRemove(pass1Buf);
      if (!cutout) {
        console.warn('   pass2: rembg unavailable, using pass-1 image as-is');
        cutout = pass1Buf;
      }
      fs.writeFileSync(path.join(outDir, '02b-cutout.png'), cutout);

      // 2. Composite cutout onto landmark.
      const W = 1024, H = 1365;
      const bg2 = await sharp(landmarkBuf).resize(W, H, { fit: 'cover', position: 'centre' }).jpeg({ quality: 92 }).toBuffer();
      const cutoutResized = await sharp(cutout).resize(W, H, { fit: 'inside' }).png().toBuffer();
      const cm = await sharp(cutoutResized).metadata();
      const left = Math.round((W - cm.width) / 2);
      const top = Math.round((H - cm.height) / 2);
      const composite2 = await sharp(bg2).composite([{ input: cutoutResized, left, top }]).jpeg({ quality: 92 }).toBuffer();
      fs.writeFileSync(path.join(outDir, '02c-pass2-input.jpg'), composite2);

      // 3. Pass 2 prompt — ONLY watercolor unification + bg integration.
      // No pose changes (figures already in their poses).
      const titleText = meta.title || '';
      const titleLine = titleText
        ? `\nTITLE: render the title text "${titleText}" across the upper third of the canvas in hand-painted watercolor letters (NOT a system font). Title goes in the sky / upper background area, never on faces. This is the only text in the image.`
        : '';
      const pass2Prompt = `LANDMARK PROTECTION (CRITICAL — read first):
The background of this image is a real photograph of a specific landmark. DO NOT redraw it. DO NOT move buildings. DO NOT change architecture. DO NOT change the skyline. DO NOT add or remove windows. DO NOT swap the building style. The buildings, the position of every window, the roofline, and the silhouette must remain pixel-faithful to the input photograph. Your edit is a TEXTURE / STYLE pass on top of the existing pixels — not a regeneration of the scene.

YOUR EDIT (in this order):
1. Apply ${STYLE_HINT} stylistically across the whole image — soft watercolor brushstrokes, paper texture, gentle wash. The buildings keep their EXACT geometry, only their rendering style changes from photographic to painted.
2. The figures (already painted in watercolor with interactive poses) are foreground — blend them into the scene by matching lighting and softening cutout edges. Do NOT change their poses.
3. REPAINT THE GROUND ONLY beneath/around the figures' feet so it reads as a continuation of the actual ground material the landmark stands on (cobblestone, paving stones, plaza, dirt, grass, sand, snow — whichever matches the landmark). The ground transition should be invisible. Do not extend ground OVER the buildings.${titleLine}

PRESERVE EXACTLY:
- Every building, window, roofline, doorway, decorative stonework — they are correct in the input.
- Every figure's pose, face, hair, skin tone, clothing.
- Every prop's silhouette and material.

DO NOT:
- Redraw or reposition any building.
- Replace the landmark with a generic city/street.
- Change which figures appear or their order.
- Add text other than the title (if any). No signage, no shop names, no letters.
- Add new objects, animals, or extra characters.

NOT photoreal. Watercolor texture only.`;

      const body2 = {
        model: 'grok-imagine-image',
        prompt: pass2Prompt,
        response_format: 'b64_json',
        aspect_ratio: '3:4',
        image: { url: `data:image/jpeg;base64,${composite2.toString('base64')}`, type: 'image_url' },
      };
      const t2 = Date.now();
      const resp2 = await fetch('https://api.x.ai/v1/images/edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body2),
        signal: AbortSignal.timeout(180000),
      });
      const elapsed2 = Date.now() - t2;
      if (!resp2.ok) {
        const err = await resp2.text();
        console.error(`❌ Pass 2 ${resp2.status}: ${err.slice(0, 400)}`);
        fs.writeFileSync(path.join(outDir, 'pass2-error.txt'), err);
        meta.runs.grokPass2 = { error: `HTTP ${resp2.status}`, elapsedMs: elapsed2 };
        return;
      }
      const data2 = await resp2.json();
      const b642 = data2.data?.[0]?.b64_json;
      if (!b642) { console.error('❌ Pass 2: no image'); meta.runs.grokPass2 = { error: 'no image' }; return; }
      fs.writeFileSync(path.join(outDir, '02d-pass2-final.jpg'), Buffer.from(b642, 'base64'));
      console.log(`✅ Pass 2 Grok ${(elapsed2 / 1000).toFixed(1)}s → 02d-pass2-final.jpg`);
      meta.runs.grokPass2 = { elapsedMs: elapsed2 };
    } catch (e) {
      console.error(`❌ Pass 2 failed: ${e.message}`);
      meta.runs.grokPass2 = { error: e.message };
    }
  }
}

async function geminiBlend(prompt, compositeBuf, landmarkBuf, figures, outDir, meta) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.warn('⚠️  GEMINI_API_KEY not set — skipping Gemini'); return; }

  // Gemini 2.5 Flash Image returned IMAGE_OTHER (model refused) on the
  // detailed multi-character prompt. Strip the prompt down to the bare
  // task — re-render the composite in a unified style. No mentions of
  // children / ages / ground shadows that might trip safety classifiers.
  const compactPrompt = `Re-render this image as a single unified illustration in this art style: ${STYLE_HINT}. Preserve every figure's face, hair, and clothing. Preserve the landmark behind them. NOT photoreal.`;
  const parts = [
    { text: compactPrompt },
    { inline_data: { mime_type: 'image/jpeg', data: compositeBuf.toString('base64') } },
  ];
  console.log(`📤 Gemini: composite only, minimal prompt`);

  const modelId = 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.4, responseModalities: ['IMAGE', 'TEXT'] },
  };
  const t0 = Date.now();
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const elapsed = Date.now() - t0;
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`❌ Gemini ${resp.status}: ${err.slice(0, 400)}`);
    fs.writeFileSync(path.join(outDir, 'gemini-error.txt'), err);
    meta.runs.gemini = { error: `HTTP ${resp.status}`, elapsedMs: elapsed };
    return;
  }
  const data = await resp.json();
  let outImg = null, outText = '';
  for (const p of data.candidates?.[0]?.content?.parts || []) {
    if (p.inlineData?.data || p.inline_data?.data) outImg = p.inlineData?.data || p.inline_data?.data;
    if (p.text) outText += p.text;
  }
  if (!outImg) {
    console.error('❌ Gemini: no image');
    fs.writeFileSync(path.join(outDir, 'gemini-response.json'), JSON.stringify(data, null, 2));
    meta.runs.gemini = { error: 'no image' };
    return;
  }
  fs.writeFileSync(path.join(outDir, '02b-gemini-blended.jpg'), Buffer.from(outImg, 'base64'));
  console.log(`✅ Gemini ${(elapsed / 1000).toFixed(1)}s → 02b-gemini-blended.jpg`);
  meta.runs.gemini = { elapsedMs: elapsed, refs: figures.length };
}

main().catch(e => { console.error('💥', e.message); console.error(e.stack); process.exit(1); });
