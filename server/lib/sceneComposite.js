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
const { stripDataUriPrefix, bytesFromAnyImage } = require('./r2');
const { GROK_ASPECT_PRESETS, closestGrokAspect } = require('./grokAspect');
const { rembgRemoveBackground } = require('./rembg');

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
const DEFAULT_PALETTE_NAMES = {
  '#E60000': 'red',
  '#0050D0': 'blue',
  '#00B050': 'green',
  '#F0C000': 'yellow',
  '#8B00B0': 'purple',
  '#00B0B0': 'cyan',
};
// Head tint per body colour — same hue, mixed ~50% with white. The head+neck
// of every placeholder is painted in this instead of the body colour, which
// makes head height directly MEASURABLE rather than inferred.
//
// Why: head height × canonical heads-per-body gives a figure's full height
// from the silhouette alone — no horizon estimate, no second figure needed —
// which is the only way to know how much of a frame-clipped figure is cut off.
// Deriving the head from the silhouette's shape instead does not work: it
// needs a neck notch in the row-width profile, and that notch disappears
// whenever a hand is raised to the head or hair covers the neck. Measured
// 2026-08-12 on two plates: no notch on 3 of 3 clipped foreground figures.
//
// Same hue keeps character separation intact (hue is what tells red from
// blue); the split from the body is by BRIGHTNESS — every base palette colour
// has a zero min-channel, the tints sit near 128, so the threshold is wide.
const HEAD_TINTS = {
  '#E60000': '#F38080',
  '#0050D0': '#80A8E8',
  '#00B050': '#80D8A8',
  '#F0C000': '#F8E080',
  '#8B00B0': '#C580D8',
  '#00B0B0': '#80D8D8',
};
// Saturation floor separating a silhouette BODY from both the pale head tint
// and from scenery. 0.55 was too strict once Grok renders in watercolor — a
// mid-green body measures 0.59 at its best and fragments below the floor,
// which shattered a figure into a 27x55 scrap. Sunlit path and dirt, the
// scenery that shares a red hue, measure ~0.23, so 0.45 clears both.
const BODY_SAT_FLOOR = 0.45;
// How much of a figure has to be missing before we believe scenery is hiding
// it. Everything feeding this judgement is a measurement, so a few percent
// either way is noise, not a railing. Two measured misfires set the bar: at
// 0.95 a woman standing in the open read as "94% on show" and lost 25px of her
// feet (Lab exp 684), and at 0.85 a man standing in the open read as 84% and
// lost his (Lab exp 724, 7.63 heads against the plate's 9.08).
//
// 0.75 is comfortable because DINO's face boxes made the scale meaningful: on
// that same page the genuinely occluded figure read 3.58 against 9.08 — 39% —
// so real occlusion clears this bar by a mile while measurement noise on a
// whole figure does not come near it. The old colour head-band could never
// have supported it: there, every figure on a plate sat between 2.43 and 3.05.
const MAX_SHOWN_TO_COUNT_AS_OCCLUDED = 0.75;
// The tallest figure on the plate must be at least this many times the
// shortest for the scene to have the depth the composite exists to fix.
// Calibrated on three pages: 2.77 (real depth, keep), 1.73 and 1.08 (no
// depth, abort). See the abort block in generateSceneComposite.
const MIN_DEPTH_SPREAD = 2.0;

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
// The preset set + nearest-preset lookup live in ./grokAspect (imported
// above as GROK_ASPECT_PRESETS + closestGrokAspect).

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
/**
 * Locate the ghosts with GroundingDINO instead of a colour diff.
 *
 * The split of labour, and why it is this way round (owner, 2026-08-15):
 *   - DINO answers "where are the people" — it looks for figures, so scenery
 *     cannot impersonate one. The colour diff could: on p4 sunlit lawn (hue 78,
 *     sat 0.59) matched the yellow palette entry closely enough to return a
 *     177x39 strip of grass as a character, which then anchored the ground
 *     plane, inverted it, and shrank two children to 40% of their painted size.
 *   - The PALETTE answers "which person is this" — each ghost is painted in a
 *     known hue, so the dominant palette colour inside a DINO box names it
 *     deterministically and for nothing. DINO itself cannot name anyone; the
 *     SOM pass that normally does returned UNKNOWN for 4 of 5 ghosts on a
 *     plate (Lab exp 723), because a flat cartoon figure gives a VLM nothing
 *     to recognise.
 *   - DINO's FACE boxes give the head, paired to the person box that contains
 *     them. No head-tint band needed, and no risk of picking a hand.
 *
 * Returns the same shape as findSilhouettesByDiff so every consumer downstream
 * — stature model, plate ratio, z-order, figure-figure occlusion — is
 * unchanged. Needs no depopulated background, so it can run on the plate alone.
 */
async function findSilhouettesWithDino(populatedBuf, cast, opts = {}) {
  const {
    _gdinoDetect, _collectNmsBoxes, GDINO_PERSON_NMS_IOU, GDINO_FACE_NMS_IOU,
  } = require('./figureDetection');
  const MIN_COLOUR_FRACTION = opts.minColourFraction ?? 0.04;  // of the box's area
  const HUE_THRESHOLD = opts.hueThreshold ?? 30;

  const meta = await sharp(populatedBuf).metadata();
  const W = meta.width, H = meta.height;
  const uri = `data:image/png;base64,${populatedBuf.toString('base64')}`;

  const det = await _gdinoDetect(uri, [{ name: 'person', text: 'person' }]);
  if (!det || !Array.isArray(det.figures) || !det.figures[0]) {
    throw new Error('[SCENE COMPOSITE] DINO returned no person boxes on the plate');
  }
  const persons = _collectNmsBoxes(det.figures[0], GDINO_PERSON_NMS_IOU);
  const fdet = await _gdinoDetect(uri, [{ name: 'face', text: 'face' }]);
  const faces = fdet?.figures?.[0] ? _collectNmsBoxes(fdet.figures[0], GDINO_FACE_NMS_IOU) : [];
  log.info(`[SCENE COMPOSITE]   DINO: ${persons.length} person box(es), ${faces.length} face box(es)`);

  const { data, info } = await sharp(populatedBuf).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const hueOf = (hex) => rgbToHue(
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));

  // Score every (box, character) pair by how many of that character's palette
  // pixels the box contains, then take the best pairs greedily. Greedy rather
  // than per-box argmax so two boxes cannot both claim the same character.
  const scored = [];
  for (let i = 0; i < persons.length; i++) {
    const [bx0, by0, bx1, by1] = persons[i].box.map(Math.round);
    const x0 = Math.max(0, bx0), y0 = Math.max(0, by0);
    const x1 = Math.min(W - 1, bx1), y1 = Math.min(H - 1, by1);
    if (x1 <= x0 || y1 <= y0) continue;
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    for (const c of cast) {
      const bodyHue = hueOf(c.color);
      const tint = HEAD_TINTS[c.color];
      const tintHue = tint ? hueOf(tint) : null;
      let n = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const k = (y * W + x) * ch;
          const r = data[k], g = data[k + 1], b = data[k + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if ((mx - mn) / (mx || 1) < BODY_SAT_FLOOR * 0.6 || mx < 80) continue;
          const h = rgbToHue(r, g, b);
          let dh = Math.abs(h - bodyHue); if (dh > 180) dh = 360 - dh;
          let dt = tintHue == null ? 999 : Math.abs(h - tintHue); if (dt > 180) dt = 360 - dt;
          if (dh <= HUE_THRESHOLD || dt <= HUE_THRESHOLD) n++;
        }
      }
      if (n / area >= MIN_COLOUR_FRACTION) scored.push({ boxIdx: i, name: c.name, n, area, box: [x0, y0, x1, y1] });
    }
  }
  scored.sort((a, b) => b.n - a.n);

  const results = {};
  const usedBox = new Set();
  for (const s of scored) {
    if (results[s.name] || usedBox.has(s.boxIdx)) continue;
    usedBox.add(s.boxIdx);
    const [x0, y0, x1, y1] = s.box;

    // Tighten to the character's own pixels inside the box, and build the mask
    // the occlusion step needs. The box is DINO's; the outline is ours.
    const mask = new Uint8Array(W * H);
    const c = cast.find(cc => cc.name === s.name);
    const bodyHue = hueOf(c.color);
    const tint = HEAD_TINTS[c.color];
    const tintHue = tint ? hueOf(tint) : null;
    let minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = (y * W + x) * ch;
        const r = data[k], g = data[k + 1], b = data[k + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if ((mx - mn) / (mx || 1) < BODY_SAT_FLOOR * 0.6 || mx < 80) continue;
        const h = rgbToHue(r, g, b);
        let dh = Math.abs(h - bodyHue); if (dh > 180) dh = 360 - dh;
        let dt = tintHue == null ? 999 : Math.abs(h - tintHue); if (dt > 180) dt = 360 - dt;
        if (dh > HUE_THRESHOLD && dt > HUE_THRESHOLD) continue;
        mask[y * W + x] = 1; count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) continue;

    // The face box belonging to this figure: most contained, and highest up.
    let best = null;
    for (const f of faces) {
      const [fx0, fy0, fx1, fy1] = f.box.map(Math.round);
      const ix0 = Math.max(fx0, x0), iy0 = Math.max(fy0, y0);
      const ix1 = Math.min(fx1, x1), iy1 = Math.min(fy1, y1);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      const inter = (ix1 - ix0) * (iy1 - iy0);
      const fArea = Math.max(1, (fx1 - fx0) * (fy1 - fy0));
      if (inter / fArea < 0.6) continue;
      if (!best || fy0 < best.top) best = { top: fy0, bottom: fy1, left: fx0, right: fx1 };
    }

    // MEASURE THE HEAD FROM THE PALE TINT, NOT FROM THE BOX (owner, 2026-08-15).
    // DINO's face box is a guess and its tightness varies: across two runs of
    // the same page the same woman's box came back 101px and 53px. The head
    // tint is painted by us and does not move. Measured on p6: the two whole
    // figures agree to 3% on the tint (4.19 and 4.07 heads) against 10% on the
    // raw boxes — and that box noise is what pushed the occlusion bar down and
    // still cost a standing man his feet.
    //
    // The box is still needed: it is the only thing that says WHERE to look.
    // Pale pixels of a character's hue are everywhere in a scene — sky for
    // blue, water for blue-green, sunlit grass for yellow — so searching the
    // person box, or the canvas, returns the sky. Searching the face box
    // returns the face.
    let head = null;
    if (best) {
      const tint = HEAD_TINTS[c.color];
      const tintHue2 = tint ? hueOf(tint) : bodyHue;
      let hy0 = 1e9, hy1 = -1, hn = 0;
      for (let y = Math.max(0, best.top); y <= Math.min(H - 1, best.bottom); y++) {
        for (let x = Math.max(0, best.left); x <= Math.min(W - 1, best.right); x++) {
          const k = (y * W + x) * ch;
          const r = data[k], g = data[k + 1], b = data[k + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx < 90) continue;
          const sat = (mx - mn) / (mx || 1);
          if (sat >= BODY_SAT_FLOOR + 0.10) continue;   // hair and body inside the face box
          if (sat < 0.12) continue;                      // white/grey: not a tinted head
          const hh = rgbToHue(r, g, b);
          let dh = Math.abs(hh - tintHue2); if (dh > 180) dh = 360 - dh;
          if (dh > HUE_THRESHOLD) continue;
          hn++; if (y < hy0) hy0 = y; if (y > hy1) hy1 = y;
        }
      }
      const tintH = hy1 >= 0 ? hy1 - hy0 + 1 : 0;
      const boxH = best.bottom - best.top;
      // A tint that fills almost none of the box means the box landed on hair
      // or missed — fall back to the box rather than invent a tiny head.
      if (tintH >= 8 && hn >= 30 && tintH >= boxH * 0.4) {
        head = { y: hy0, height: tintH, source: 'tint-in-face-box' };
      } else if (boxH >= 8) {
        head = { y: best.top, height: boxH, source: 'dino-face-box' };
      }
    }

    results[s.name] = {
      bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels: count },
      head,
      mask,
      dinoBox: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, score: +persons[s.boxIdx].score.toFixed(3) },
    };
    log.info(`[SCENE COMPOSITE]   ${s.name}: DINO box ${x1 - x0 + 1}x${y1 - y0 + 1} (${s.n}px of its colour), `
      + `outline ${maxX - minX + 1}x${maxY - minY + 1}${head ? `, head ${head.height}px (${head.source})` : ', no head'}`);
  }

  const missing = cast.filter(c => !results[c.name]).map(c => c.name);
  if (missing.length) log.warn(`[SCENE COMPOSITE]   DINO+colour found no box for: ${missing.join(', ')}`);
  return { canvasWidth: W, canvasHeight: H, diffMaskCount: null, results };
}

async function findSilhouettesByDiff(populatedBuf, cleanBgBuf, cast, opts = {}) {
  const DIFF_THRESHOLD = opts.diffThreshold ?? 40;
  const HUE_THRESHOLD = opts.hueThreshold ?? 35;
  const MIN_BLOB_PIXELS = opts.minBlobPixels ?? 500;

  const popMeta = await sharp(populatedBuf).metadata();
  const W = popMeta.width, H = popMeta.height;

  const pop = await sharp(populatedBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Align clean BG to populated dimensions (depopulate can rescale).
  // Uniform scaling — if depopulate rescaled the BG, contain pads instead of
  // stretching so the diff-mask alignment isn't distorted.
  const cleanAligned = await sharp(cleanBgBuf).resize(W, H, { fit: 'contain', background: { r: 255, g: 255, b: 255 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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

    // TWO masks, deliberately different saturation floors.
    //
    // colourMask (0.55) is the BODY and it defines the bbox. The floor has to
    // stay strict: the depopulate call repaints the whole image, so the diff
    // mask carries noise everywhere, and saturation is the only thing keeping
    // warm scenery out of a red figure. Relaxing this floor to catch heads put
    // 68 px of sunlit path into Emma's silhouette on staging story
    // job_1786484554633_crojok432 p7, which dragged her box to the frame edge
    // and made a fully visible figure look clipped.
    //
    // paleMask (0.15) is the HEAD TINT only, and it is searched near the top of
    // the body box, never across the canvas. Grok paints the tint paler than
    // specified — measured 0.22-0.29 where the spec asks 0.47 — so this floor
    // must sit low, and it can afford to because of where it is applied.
    // Collect every pixel of this character's hue first, WITHOUT deciding yet
    // whether it is body or head tint. Saturation cannot make that call: the
    // pale head sits close enough to the body's saturation that a floor either
    // swallows it into the body or drops it entirely (which is what produced
    // "head = null" on a plate whose heads were plainly tinted). BRIGHTNESS is
    // the axis that separates them — the two tones are bimodal in min-channel.
    const colourMask = new Uint8Array(W * H);
    const paleMask = new Uint8Array(W * H);
    const hueHits = [];
    const hueMins = [];
    for (let p = 0; p < W * H; p++) {
      if (!diffMask[p]) continue;
      const i = p * 4;
      const r = popD[i], g = popD[i + 1], b = popD[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 80) continue;
      const sat = (mx - mn) / (mx || 1);
      if (sat < 0.15) continue;
      let dh = Math.abs(rgbToHue(r, g, b) - targetHue);
      if (dh > 180) dh = 360 - dh;
      if (dh > HUE_THRESHOLD) continue;
      hueHits.push(p); hueMins.push(mn);
    }

    // Where the tint starts is a property of THIS figure, not a constant. The
    // body's own darkest channel moves with the palette colour — measured on
    // one plate: red body 21, blue 39, green 59, against head tints at 98-105.
    // A fixed cut (120) sat above all three and discarded every head.
    const tintSplit = (() => {
      if (hueMins.length < 50) return null;
      const sorted = [...hueMins].sort((a, b2) => a - b2);
      const bodyMedian = sorted[Math.floor(sorted.length * 0.5)];
      const brightTail = sorted[Math.floor(sorted.length * 0.97)];
      // Needs a real gap; without one this figure has only one tone.
      if (brightTail < bodyMedian + 25) return null;
      return Math.round((bodyMedian + brightTail) / 2);
    })();
    for (let k = 0; k < hueHits.length; k++) {
      const p = hueHits[k];
      const i = p * 4;
      const r = popD[i], g = popD[i + 1], b = popD[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = (mx - mn) / (mx || 1);
      if (tintSplit != null && mn > tintSplit) paleMask[p] = 1;
      else if (sat >= BODY_SAT_FLOOR) colourMask[p] = 1;
    }

    // Flood fill — collect EVERY blob of this colour, not just the biggest.
    // A silhouette is routinely split into disconnected fragments: anything
    // the character holds in front of themselves (a map, a letter, a lantern)
    // cuts the coloured region in two. Keeping only the largest fragment
    // measures a fraction of the figure — on staging story
    // job_1786277779744_vorw1f7ve p4 the green adult was split by the map he
    // holds and came back as 60×121 where the silhouette is 85×230, i.e. 47%
    // short. Because that adult was the page's only stature anchor, every
    // figure on the page was then pasted at roughly half its correct size.
    visited.fill(0);
    const blobs = [];
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
      blobs.push({ count, minX, minY, maxX, maxY, pixels });
    }
    blobs.sort((a, b) => b.count - a.count);
    if (!blobs.length || blobs[0].count < MIN_BLOB_PIXELS) { results[c.name] = null; continue; }

    // Merge fragments that belong to the same figure. A human silhouette is
    // one vertical stack, so a fragment joins when it shares the anchor's
    // column (≥50% horizontal overlap of the narrower box) and sits within
    // one anchor-height above or below it — enough to bridge a held object,
    // not enough to swallow an unrelated patch elsewhere in the scene.
    //
    // The gap is measured against the FROZEN anchor height, never the running
    // merged height: a running height ratchets upward with each merge and
    // lets arbitrarily distant patches chain in (the oversized-cutout bug on
    // staging story 9s2poh79f page 3).
    const anchor = blobs[0];
    const anchorH = anchor.maxY - anchor.minY + 1;
    let minX = anchor.minX, minY = anchor.minY, maxX = anchor.maxX, maxY = anchor.maxY;
    let mergedCount = anchor.count;
    const mergedPixels = [anchor.pixels];
    for (let i = 1; i < blobs.length; i++) {
      const b = blobs[i];
      if (b.count < MIN_BLOB_PIXELS / 4) continue;
      const bW = b.maxX - b.minX + 1;
      const aW = maxX - minX + 1;
      const overlapW = Math.max(0, Math.min(maxX, b.maxX) - Math.max(minX, b.minX) + 1);
      if (overlapW / Math.min(aW, bW) < 0.5) continue;
      const vGap = Math.max(0, Math.max(minY, b.minY) - Math.min(maxY, b.maxY));
      if (vGap > anchorH) continue;
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
      mergedCount += b.count;
      mergedPixels.push(b.pixels);
    }

    // Full-canvas silhouette mask: downstream needs absolute coordinates so
    // cropPhantom can build a context window of arbitrary padding and still
    // know which pixels belong to this character.
    const sMask = new Uint8Array(W * H);
    for (const px of mergedPixels) for (const q of px) sMask[q] = 1;

    // Head band — the pale-tint rows. Same hue as the body (so it is already
    // inside sMask), separated by brightness. Measuring it beats inferring a
    // neck from the silhouette's outline, which fails whenever a raised hand
    // or hair fills the neck.
    //
    // Take the TOPMOST run that is big enough to be a head, not the longest.
    // The head is always the highest tinted region on a figure, but it is not
    // reliably the largest: measured on one plate, the head bands were 905 and
    // 952 px while the HANDS came to 540 and 468 — only about 2:1, and a raised
    // hand closes that gap entirely. A minimum-size guard is what makes
    // "topmost" safe, since a stray pale speck would otherwise open the band at
    // the crown and end it immediately (that produced a 1px head).
    //
    // Search only the top of the figure — the head cannot be below it — and a
    // little above the body box, because when hair does not overhang, the face
    // itself is the topmost part and sits outside the saturated body mask.
    const bodyH = maxY - minY + 1;
    const padX = Math.round((maxX - minX + 1) * 0.15);
    const scanTop = Math.max(0, minY - Math.round(bodyH * 0.35));
    const scanBot = Math.min(H - 1, minY + Math.round(bodyH * 0.5));
    const paleRow = new Array(scanBot - scanTop + 1).fill(0);
    for (let y = scanTop; y <= scanBot; y++) {
      let n = 0;
      for (let x = Math.max(0, minX - padX); x <= Math.min(W - 1, maxX + padX); x++) {
        if (paleMask[y * W + x]) n++;
      }
      paleRow[y - scanTop] = n;
    }
    // Collect every run, tolerating a 3-row gap so JPEG speckle inside the face
    // does not split it, then keep the first run substantial enough to be a
    // head. The torso between face and hands is many rows of body colour, so
    // the gap rule separates them cleanly.
    const runs = [];
    {
      let from = -1, px = 0, gap = 0;
      for (let i = 0; i < paleRow.length; i++) {
        if (paleRow[i] >= 2) { if (from < 0) { from = i; px = 0; } px += paleRow[i]; gap = 0; }
        else if (from >= 0 && ++gap > 3) { runs.push({ from, to: i - gap, px }); from = -1; }
      }
      if (from >= 0) runs.push({ from, to: paleRow.length - 1, px });
    }
    const minHeadPx = Math.max(12, Math.round((maxX - minX + 1) * bodyH * 0.004));
    const head0 = runs.find(r => r.px >= minHeadPx) || null;
    const bestFrom = head0 ? head0.from : -1;
    const bestTo = head0 ? head0.to : -1;
    const bestPx = head0 ? head0.px : 0;
    // The head unit in heads-per-body runs crown to chin. The band's bottom is
    // the chin; its top is the hairline, because hair stays in the body colour.
    // So the crown is whichever is higher — the body mask's top (hair) or the
    // pale band's own top (a face with no hair above it).
    const faceTop = scanTop + bestFrom, faceBot = scanTop + bestTo;
    const crownY = Math.min(minY, faceTop);
    const head = bestFrom >= 0 && bestPx >= 30 && faceBot > crownY
      ? { y: crownY, height: faceBot - crownY + 1, faceY: faceTop, pixels: bestPx }
      : null;
    // The pale head is outside the saturated body mask, so the figure's real
    // extent starts at the crown, not at the shoulders.
    if (head && head.y < minY) minY = head.y;
    // …and the head must be IN the mask, not merely bound by it. The mask is
    // the figure's silhouette for every consumer downstream — the crosshatch
    // clips to it, the whiteout punches it out, the blend gate measures it.
    // Built from the body blobs alone it stops at the neck, so a repair leaves
    // the placeholder's painted face untouched and the model keeps it.
    // Union every pale pixel inside the figure's box, not just a confidently
    // measured head band — the band is often missed (it was null for the very
    // figure that exposed this) while the face is plainly there. Same hue
    // inside the same box is the same character.
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const q = y * W + x;
        if (paleMask[q]) sMask[q] = 1;
      }
    }
    // Then FILL THE HOLES. The face is painted in a skin tone and the eyes in
    // black, so neither matches the character's palette hue and no colour key
    // can reach them — they are enclosed gaps inside the outline. Flood the
    // background inward from the box border; whatever the flood cannot reach is
    // interior and belongs to the figure. Without this the crosshatch clips
    // around the face, the model keeps the placeholder's painted face, and the
    // repair silently preserves the very thing it was asked to replace.
    {
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const outside = new Uint8Array(bw * bh);
      const stack = [];
      const push = (lx, ly) => {
        const li = ly * bw + lx;
        if (outside[li]) return;
        if (sMask[(minY + ly) * W + (minX + lx)]) return;
        outside[li] = 1; stack.push(li);
      };
      for (let lx = 0; lx < bw; lx++) { push(lx, 0); push(lx, bh - 1); }
      for (let ly = 0; ly < bh; ly++) { push(0, ly); push(bw - 1, ly); }
      while (stack.length) {
        const li = stack.pop();
        const lx = li % bw, ly = (li / bw) | 0;
        if (lx > 0) push(lx - 1, ly);
        if (lx < bw - 1) push(lx + 1, ly);
        if (ly > 0) push(lx, ly - 1);
        if (ly < bh - 1) push(lx, ly + 1);
      }
      let filled = 0;
      for (let ly = 0; ly < bh; ly++) {
        for (let lx = 0; lx < bw; lx++) {
          const q = (minY + ly) * W + (minX + lx);
          if (!sMask[q] && !outside[ly * bw + lx]) { sMask[q] = 1; filled++; }
        }
      }
      if (filled) log.debug(`[SCENE COMPOSITE]   ${c.name}: filled ${filled}px of interior holes (face, eyes) into the silhouette`);
    }

    results[c.name] = {
      bbox: {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        pixels: mergedCount,
      },
      head,
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
  const col = (cellIdx - 1) % 4;
  const row = Math.floor((cellIdx - 1) / 4);
  // Head/body divider by min-variance (the decoupled sheet has UNEQUAL rows — a
  // short head row over a taller body row — so it is NOT at height/2). Same
  // detector the edge-splitter uses; the injected gutter is the low-variance row.
  const { data, info } = await sharp(sheetBuf).greyscale().raw().toBuffer({ resolveWithObject: true });
  let minVar = Infinity, sepY = Math.floor(info.height / 2);
  for (let y = Math.floor(info.height * 0.2); y < Math.floor(info.height * 0.8); y++) {
    let s = 0, sq = 0;
    for (let x = 0; x < info.width; x++) { const v = data[y * info.width + x]; s += v; sq += v * v; }
    const mean = s / info.width; const variance = sq / info.width - mean * mean;
    if (variance < minVar) { minVar = variance; sepY = y; }
  }
  const top = row === 0 ? 0 : sepY;
  const cellH = row === 0 ? sepY : info.height - sepY;
  return sharp(sheetBuf)
    .extract({ left: col * cellW, top, width: cellW, height: cellH })
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
  const out = await rembgRemoveBackground(buf);
  if (out) return out;
  return whiteToTransparent(buf);
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
 * @param {Buffer|string} sheet - the 2×4 sheet as a raw Buffer, data URI,
 *   raw base64, or http(s) URL (post-R2-migration stories store sheets as
 *   `https://images.magicalstory.ch/...` URLs — resolved via r2.bytesFromAnyImage).
 * @param {Object} opts
 * @param {'front'|'threeQuarter'|'profile'|'back'} opts.pose - body angle. Defaults to 'threeQuarter'.
 * @param {boolean} [opts.flip=false] - mirror horizontally (camera-right facing).
 * @param {boolean} [opts.includeFace=false] - also return the matching top-row face cell.
 * @returns {Promise<{ body: Buffer, face: Buffer|null }>} PNG buffers.
 */
async function cropAvatarCell(sheet, opts = {}) {
  // headOnly: close-up pages send only the head — the body cell is cropped to
  // its top 40% (head + headwear + shoulders) before stacking. The face cell
  // alone cannot serve: it is rendered hatless, so a naive face-only ref
  // loses hats and bandanas.
  const { pose = 'threeQuarter', includeFace = false, stack = false, headOnly = false } = opts;
  // bytesFromAnyImage handles Buffer / data-URI / raw base64 / http(s) URL.
  // Pre-R2-migration this was a bare base64 decode, which turned stored R2
  // URLs into ~80 bytes of garbage and silently broke cell refs for every
  // DB-reloaded story.
  const sheetBuf = await bytesFromAnyImage(sheet);
  if (!sheetBuf) {
    const preview = Buffer.isBuffer(sheet) ? '<Buffer>' : String(sheet).slice(0, 80);
    throw new Error(`cropAvatarCell: could not resolve sheet input to image bytes (input: "${preview}")`);
  }

  const bodyIdx = POSE_CELL[pose] || POSE_CELL.threeQuarter;
  let body = await cropSheetCell(sheetBuf, bodyIdx);
  if (headOnly) {
    const bMeta = await sharp(body).metadata();
    body = await sharp(body)
      .extract({ left: 0, top: 0, width: bMeta.width, height: Math.round((bMeta.height || 0) * 0.4) })
      .png().toBuffer();
  }

  let face = null;
  if (includeFace) {
    const faceIdx = FACE_CELL[pose] || FACE_CELL.threeQuarter;
    face = await cropSheetCell(sheetBuf, faceIdx);
  }

  // When stack=true and face is included, vertically combine face (top) +
  // body (bottom) into a single PNG matching the 2×4 sheet's column layout.
  // Single reference slot per character — same as the body-only path — but
  // foreground characters get a tight head close-up alongside the full body
  // pose so the model has a high-detail face anchor for canvas-large faces.
  let stacked = null;
  if (stack && face) {
    const [faceMeta, bodyMeta] = await Promise.all([
      sharp(face).metadata(),
      sharp(body).metadata(),
    ]);
    const W = Math.max(faceMeta.width || 0, bodyMeta.width || 0);
    const fH = faceMeta.height || 0;
    const bH = bodyMeta.height || 0;
    const faceResized = (faceMeta.width !== W)
      ? await sharp(face).resize(W, null, { fit: 'contain', background: { r: 255, g: 255, b: 255 } }).png().toBuffer()
      : face;
    const bodyResized = (bodyMeta.width !== W)
      ? await sharp(body).resize(W, null, { fit: 'contain', background: { r: 255, g: 255, b: 255 } }).png().toBuffer()
      : body;
    const faceResizedMeta = (faceMeta.width !== W) ? await sharp(faceResized).metadata() : { height: fH };
    const bodyResizedMeta = (bodyMeta.width !== W) ? await sharp(bodyResized).metadata() : { height: bH };
    const totalH = (faceResizedMeta.height || fH) + (bodyResizedMeta.height || bH);
    stacked = await sharp({
      create: { width: W, height: totalH, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).composite([
      { input: faceResized, left: 0, top: 0 },
      { input: bodyResized, left: 0, top: faceResizedMeta.height || fH },
    ]).png().toBuffer();
  }

  return { body, face, stacked };
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
/**
 * Figure-figure occlusion. `placements` arrives back-to-front, so for each
 * figure every LATER entry is one the plate says stands in front of it —
 * subtract those silhouettes from this figure's alpha, in place on `p.input`.
 *
 * Paint order alone cannot do this: a cutout is a rectangle, so the front
 * figure covers the back one and the back figure's own outline disappears.
 *
 * The masks cost nothing — findSilhouettesByDiff already returns a full-canvas
 * per-character mask (face and interior holes included) that the composite has
 * been discarding. More accurate than a segmenter, too: we painted these
 * silhouettes, so their extent is known rather than inferred.
 *
 * Guarded the same way as the two existing subtract implementations
 * (faceRepair.js occluder-subtract, samBlend.js round-2): a subtract that
 * erases more than 70% of the target means the labels are crossed — keep the
 * original alpha instead of a figure eaten by its neighbour.
 *
 * Returns a log array; mutates `placements[i].input`.
 */
async function subtractFiguresInFront(placements, silhouetteMasks, canvasW, canvasH) {
  const out = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const inFront = placements.slice(i + 1).filter(q => silhouetteMasks[q._name]);
    if (!inFront.length) continue;
    try {
      const meta = await sharp(p.input).metadata();
      // One cut-mask over this figure's rectangle: 255 where a figure in front
      // owns the pixel. Canvas coords → placement-local coords.
      const cut = Buffer.alloc(meta.width * meta.height, 0);
      let cutPixels = 0;
      for (const q of inFront) {
        const qm = silhouetteMasks[q._name];
        for (let y = 0; y < meta.height; y++) {
          const cy = p.top + y;
          if (cy < 0 || cy >= canvasH) continue;
          for (let x = 0; x < meta.width; x++) {
            const cx = p.left + x;
            if (cx < 0 || cx >= canvasW) continue;
            if (qm[cy * canvasW + cx] && !cut[y * meta.width + x]) {
              cut[y * meta.width + x] = 255; cutPixels++;
            }
          }
        }
      }
      if (!cutPixels) continue;
      const alphaMean = async (buf) => {
        const s = await sharp(buf).ensureAlpha().stats();
        return s?.channels?.[3] ? s.channels[3].mean / 255 : null;
      };
      const fracBefore = await alphaMean(p.input);
      const cutPng = await sharp(Buffer.alloc(meta.width * meta.height * 3, 255), {
        raw: { width: meta.width, height: meta.height, channels: 3 },
      }).ensureAlpha()
        .joinChannel(cut, { raw: { width: meta.width, height: meta.height, channels: 1 } })
        .png().toBuffer();
      const trial = await sharp(p.input).ensureAlpha()
        .composite([{ input: cutPng, blend: 'dest-out' }]).png().toBuffer();
      const fracAfter = await alphaMean(trial);
      const behind = inFront.map(q => q._name);
      if (fracBefore != null && fracBefore > 0 && fracAfter != null && fracAfter < fracBefore * 0.30) {
        log.warn(`[SCENE COMPOSITE]   ${p._name}: occlusion by ${behind.join(', ')} would remove ${Math.round((1 - fracAfter / fracBefore) * 100)}% — reverting (label mismatch)`);
        out.push({ name: p._name, behind, reverted: true });
        continue;
      }
      p.input = trial;
      const removedPct = fracBefore ? Math.round((1 - fracAfter / fracBefore) * 100) : 0;
      log.info(`[SCENE COMPOSITE]   ${p._name}: occluded by ${behind.join(', ')} — ${removedPct}% hidden`);
      out.push({ name: p._name, behind, removedPct });
    } catch (err) {
      log.warn(`[SCENE COMPOSITE]   ${p._name}: figure-figure occlusion failed (${err.message}) — pasting unoccluded`);
    }
  }
  return out;
}

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
    // No left/right here. The direction used to come from `c.flip`, which
    // nothing in the beats metadata ever sets, so every three-quarter and
    // profile figure was told "facing left" — a direction no one chose.
    // Only front, side and back read reliably; which way a figure turns is
    // left to the position and action text.
    const poseLabel = {
      front:        'front view, body facing the camera',
      threeQuarter: 'three-quarter view',
      profile:      'profile view',
      back:         'back view, viewer sees the back of the head',
    }[c.pose] || 'three-quarter view';
    const actionClause = c.action ? `, ${c.action}` : '';
    // Per-pose eye markers — black dot(s) inside the silhouette's head.
    // Front/three-quarter show two eyes; profile shows one; back shows none.
    const markerSpec = (() => {
      // Dot COUNT is what the detector reads; the side came from the same
      // unset flip flag, so it is gone with the direction.
      switch (c.pose) {
        case 'front':
          return 'two small BLACK dots side by side in the head area (eyes)';
        case 'threeQuarter':
          return "two small BLACK dots in the head area, offset together toward one side of the head (eyes)";
        case 'profile':
          return 'ONE small BLACK dot near one edge of the head area (eye)';
        case 'back':
          return 'NO eye dots — back-of-head only';
        default:
          return null;
      }
    })();
    const markerLine = markerSpec ? `\n    Eye markers (inside the head area): ${markerSpec}.` : '';
    const tint = HEAD_TINTS[c.color];
    const headLine = tint ? `\n    Head and neck (crown down to where the neck meets the shoulders): pale ${c.colorName || ''} ${tint}. Body below the neck: ${c.color}.` : '';
    return `- ONE ${c.colorName || ''} silhouette (${c.color}): ${c.name}, ${posHint}, ${poseLabel}${actionClause}. Size: ${sizeHint}.${headLine}${markerLine}`;
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
    // No left/right here. The direction used to come from `c.flip`, which
    // nothing in the beats metadata ever sets, so every three-quarter and
    // profile figure was told "facing left" — a direction no one chose.
    // Only front, side and back read reliably; which way a figure turns is
    // left to the position and action text.
    const poseLabel = {
      front:        'front view, body facing the camera',
      threeQuarter: 'three-quarter view',
      profile:      'profile view',
      back:         'back view, viewer sees the back of the head',
    }[c.pose] || 'three-quarter view';
    const markerSpec = (() => {
      switch (c.pose) {
        case 'front':        return 'two small BLACK dots side by side in the head area (eyes)';
        case 'threeQuarter': return 'two small BLACK dots in the head area, offset together toward one side of the head (eyes)';
        case 'profile':      return 'ONE small BLACK dot near one edge of the head area (eye)';
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
/**
 * Creature block for a plate prompt.
 *
 * The plate is the ONLY door a non-human figure has into a composited page.
 * The paste step places cast cut-outs and nothing else, so a creature the
 * plate does not paint cannot appear at all — measured on a page whose
 * outline declared a Visual Bible animal and whose interactions referred to
 * it: the setting prose carried a blanket "No figures, no animals", the
 * creature was not in the cast, and it vanished from the finished page
 * (2026-08-23 audit, Lab exp 64).
 *
 * The rule is a WHITELIST, not permission to improvise: paint the Visual
 * Bible entries named for this page, exactly as described, and invent no
 * other figure. A creature the model makes up does not match the story.
 *
 * Returns '' when the page declares no creatures — the blanket ban in the
 * setting prose is then correct and is left to stand.
 */
function buildPlateCreatureBlock(sceneCreatures) {
  const list = (Array.isArray(sceneCreatures) ? sceneCreatures : [])
    .filter(c => c && (c.name || c.description));
  if (!list.length) return '';
  const lines = list
    .map(c => `- ${c.name || 'creature'}: ${String(c.description || '').trim() || 'as described in the story'}`)
    .join('\n');
  return `

CREATURES IN THIS SCENE — paint each one, exactly as described:
${lines}
These creatures are part of the world plate and stay in it. If the SETTING DESCRIPTION above says to leave out figures or animals, that instruction does not apply to the creatures listed here — it exists to keep the human cast out, and they arrive separately. Paint no creature, animal or person that is not named above or drawn as a silhouette below.`;
}

function buildPopulatedPlatePrompt(scene, cast, cleanBackgroundPrompt, sceneCreatures = []) {
  const lines = buildCastLines(cast);
  const creatureBlock = buildPlateCreatureBlock(sceneCreatures);
  const settingBlock = (cleanBackgroundPrompt && cleanBackgroundPrompt.trim())
    || (scene?.description && String(scene.description).trim())
    || 'an outdoor scene';
  // Grok rejects anything over 8000 chars outright, and the setting block is
  // the only part that varies enough to blow it — a five-character page with
  // a full empty-scene prompt measured over the limit and 400'd the whole run.
  // Trim the SETTING to fit rather than truncating blind: keep the opening of
  // the art-style block (the style has to survive or the plate renders
  // photorealistic) plus as much as possible from **SHOT/LOCATION** onward
  // (the place has to survive or the plate renders somewhere else entirely).
  // Budget by MEASURING the assembled prompt, never by estimating the fixed
  // overhead — an estimate was wrong twice and Grok 400s the entire run when
  // it is. Assemble once with the full setting, then trim the setting by the
  // exact excess and assemble again.
  const shrinkSetting = (text, excess) => {
    const budget = Math.max(600, text.length - excess);
    const m = text.match(/\*\*(SHOT|LOCATION|SETTING)\b/);
    if (!m) return text.slice(0, budget);
    // Keep the opening of the art-style block (drop it and the plate renders
    // photorealistic) plus as much as fits from the location onward (drop that
    // and the plate renders somewhere else). Both were measured failures.
    const styleKeep = Math.min(m.index, Math.round(budget * 0.35));
    return `${text.slice(0, styleKeep)}\n\n${text.slice(m.index, m.index + (budget - styleKeep))}`;
  };
  const sceneIntentBlock = scene?.intent
    ? `\nScene intent: ${String(scene.intent).trim()}\n`
    : '';

  const assemble = (setting) => `Paint a single illustrated scene that contains ${cast.length} flat-colour silhouette figures placed inside it. Two priorities IN ORDER — when they conflict, the lower-numbered priority wins.

PRIORITY 1 — The setting, props, and lighting must read exactly as described. Render every named environment element, prop, and required object below in its correct position. Do NOT invent new props that are not described. This image is the canonical world plate — the silhouettes will be lifted out in a later step, so the setting must be self-consistent with or without people in it.

SETTING DESCRIPTION:
${setting}
${sceneIntentBlock}${creatureBlock}

PRIORITY 2 — Place ${cast.length} flat-colour silhouette figures naturally so the scene makes physical sense. Use the cast entries below for size, depth and per-character action. Figures must stand on a SOLID surface visible in the scene (dock plank, floor, ground, rock, deck, path, stairs). NEVER position a silhouette with its feet on water or empty sky. Figures MAY overlap each other when the scene calls for it — partial occlusion is fine and natural.

${lines}

SILHOUETTE RENDERING DETAILS:
- Each silhouette is filled with flat solid colour at the exact hexes above — no gradient, no transparency, no watercolor wash, no shading on the silhouette itself.
- ONLY the human figures are flat colour. Every prop, object and piece of scenery keeps its own natural colours and full rendering, including anything a figure holds, opens, sits on or leans against. Never extend a figure's flat colour onto an object.
- TWO TONES per figure: the head and neck use the pale hex, everything else uses the saturated hex — torso, arms, hands, legs, feet, hair, hats. The boundary is a hard edge where the neck meets the shoulders, never a blend. The pale tone marks the head, not skin: hands, bare arms and bare legs stay the body colour.
- Small BLACK eye dot(s) inside the head area per the marker spec above (~5% of head width, pure #000000). Nothing else inside the silhouette.
- Size scales with depth: foreground largest, midground medium, background small.

NO TEXT in the output.`;

  const MAX = 8000;
  let out = assemble(settingBlock);
  if (out.length > MAX) {
    const excess = out.length - MAX + 200; // 200 char safety margin
    out = assemble(shrinkSetting(settingBlock, excess));
  }
  return out;
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

The silhouettes to remove are these solid saturated colours: ${colorList}. Each one is a flat human-shaped block of solid colour — a paler tone of the same colour on the head and neck, the saturated tone on the body, with small black eye dots — painted on top of the scene. Remove the pale head area as well as the saturated body.

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

// Art-style descriptors — must stay aligned with prompts/art-styles.txt and
// client/src/constants/artStyles.ts. The blend boilerplate reads from this
// map; falling back to watercolor for an unmapped style produces colourful
// output for manga / pixel / cyber etc. which contradicts the brief.
const BLEND_STYLE_LINES = {
  watercolor:   "soft watercolor children's storybook illustration style — gentle washes, simple outlines",
  pixar:        "Pixar 3D illustration style — smooth shading, clean rim light",
  anime:        "anime line-art style — clean lines, flat shading",
  cartoon:      "modern flat cartoon, bold outlines, clean shapes, vibrant flat colours",
  oil:          "oil painting style with visible brushwork",
  manga:        "traditional Japanese manga style — intricate detailed ink linework, atmospheric screentones, dramatic monochrome composition; character clothing/hair/key objects may carry their specified colours (color-spread / promotional cover style), backgrounds stay monochrome",
  chibi:        "chibi super-deformed style — massive head, tiny body, kawaii aesthetic, smooth illustration with minimal detail",
  steampunk:    "Steampunk graphic novel illustration — Victorian aesthetic, brass and copper accents, leather textures, sepia/muted palette, detailed linework",
  comic:        "classic American comic book art — heavy black ink lines, dynamic composition, halftone/Ben-Day dots, vibrant CMYK colours",
  lowpoly:      "low-poly 3D style — isometric geometric shapes, vibrant solid colours, clean edges, retro video-game aesthetic",
  concept:      "digital concept art — painterly brushwork, dramatic lighting, rich palette, visible artistic strokes, cinematic atmosphere (NOT photorealistic)",
  pixel:        "16-bit pixel art style — limited palette, detailed sprite work, retro video-game aesthetic",
  cyber:        "cyberpunk graphic novel illustration — neon reflections, chrome, dense complexity, high contrast, dark atmosphere, volumetric fog",
  realistic:    "a photograph — real people, real skin texture, natural hair, natural light",
};

/**
 * The style sentence for a blend prompt.
 *
 * ART_STYLES (promptBuilders) is the canonical list every other prompt path
 * uses, and it is consulted FIRST — because BLEND_STYLE_LINES is a second,
 * older copy that is missing keys. `realistic` is one of them, so a
 * photorealistic page was silently told "soft watercolor children's storybook
 * illustration style" by the `|| watercolor` fallback (found 2026-08-15 by
 * printing the prompt a Lab run actually sent). A style map that answers
 * confidently for a style it does not know is worse than one that throws.
 */
function _blendStyleLine(artStyle) {
  const key = String(artStyle || '').trim();
  // BLEND_STYLE_LINES FIRST. It used to be the fallback behind ART_STYLES,
  // which meant every style present there got the long GENERATION paragraph
  // instead of the short blend line this map exists to provide — the map was
  // effectively dead for every mapped style. Two costs, both measured:
  // length (frame creep scales with prompt size — see buildBlendEditPrompt),
  // and content. The realistic paragraph ends "cinematic composition", which
  // asks for a well-composed shot in the same prompt that needs the shot left
  // alone; exp 848 re-framed. ART_STYLES stays as the fallback for a style
  // this map does not carry.
  if (BLEND_STYLE_LINES[key]) return BLEND_STYLE_LINES[key];
  try {
    const { ART_STYLES } = require('./promptBuilders');
    if (ART_STYLES?.[key]) return ART_STYLES[key];
  } catch { /* fall through to the local map */ }
  return BLEND_STYLE_LINES.watercolor;
}

// Grok's edit endpoint caps prompts at 8000 chars. Reserve ~300 char
// headroom so future tweaks to the boilerplate don't silently re-blow
// the budget. The boilerplate below is ~2400 chars; that leaves the
// brief ~5300 chars of room.
const BLEND_PROMPT_HARD_CAP = 7700;

/**
 * Build a text-rendering directive for cover blend prompts. When the caller
 * (test-models cover dispatcher) supplies scene.textOverlay, we append an
 * EXCEPTION block that overrides the boilerplate's "no text" rule for a
 * single specific text element. Wording cribbed from coverComposite.js:724-735
 * so the two cover paths produce comparable typography.
 *
 * Returns '' when textOverlay is null / undefined / falsy.
 */
function buildTextOverlayDirective(textOverlay, fallbackArtStyle) {
  if (!textOverlay || typeof textOverlay !== 'object') return '';
  const text = String(textOverlay.text || '').trim();
  if (!text) return '';
  const style = textOverlay.artStyle || fallbackArtStyle || 'watercolor';
  const type = String(textOverlay.type || '').toLowerCase();
  let directive;
  if (type === 'title') {
    directive = `TITLE TEXT (override the no-text rule): render this exact title across the upper third of the canvas: "${text}". Hand-painted ${style} letterforms — NOT a system font, not flat digital text. Looks brushed by an illustrator. Letters have depth, integrated with the sky / upper background area, never on faces. This is the ONLY text in the image.`;
  } else if (type === 'dedication') {
    directive = `DEDICATION TEXT (override the no-text rule): render this exact dedication in the lower third of the canvas: "${text}". Hand-painted ${style} letterforms — quieter and smaller than a title, no 3D depth, kept flat and graceful. This is the ONLY text in the image.`;
  } else if (type === 'branding') {
    directive = `FOOTER TEXT (override the no-text rule): render exactly the text "${text}" inset from the bottom-left corner (roughly 5% in from both the left edge and the bottom edge, sitting clearly inside the frame, not flush against the border). Hand-painted ${style} letterforms — NOT a system font. This is the ONLY text in the image.`;
  } else {
    return '';
  }
  return `\n\n═══ TEXT RENDERING ═══\n${directive}`;
}

/**
 * The staging clause appended to the page's own prompt.
 *
 * Everything above it is what we would send to CREATE this page, so the model
 * renders the scene on its own terms; this block only says what Image 1 already
 * fixes. It deliberately does NOT say "positions and sizes are already correct"
 * or forbid restructuring the scenery — those three lines are what stopped the
 * model putting a character behind a railing the brief explicitly placed him
 * behind (job_1786780194082_s980g4s9a p6: "kneels at the gap in the bridge
 * railing and peers down through it"). The plate had the occlusion right and
 * the old prompt forbade keeping it.
 */
const BLEND_STAGING_CLAUSE = `STAGING — Image 1 already places every character: who they are, where they stand, and how big they are. Keep each character at that position and that size, keep the camera and framing of Image 1, and render the page described above around them.

- A character the scene places behind something — a railing, a wall, a chest, another character — is drawn BEHIND it: paint that element over them so it passes in front. This is the one change to Image 1's staging you may make.
- Do not resize, move, rotate or re-pose any character. Do not re-frame the shot, change the viewpoint, or rebuild the architecture and landscape.
- Match each character to the scene's light, and soften pasted cutout edges so they read as painted rather than stickered.
- Paint over any solid red, blue, green, yellow, purple or cyan outline or fringe left around a character by the staging step. No solid-colour outlines survive.
- Add no character who is not already in Image 1, remove none, and substitute none.
- Keep each character's face, hair, age and clothing as Image 1 and the labelled portrait grid show them.
- No text, captions, numbers or signatures anywhere.`;

/**
 * Name each staged figure's depth.
 *
 * The page prompt carries the generic rule ("`background` is small and distant.
 * Foreground > midground > background in size") but never says WHICH character
 * is which — that lives in scene metadata the prompt does not surface. So the
 * model has to infer it from prose while another line describes the same person
 * as "a full adult-height man", and on p6 it rendered him at foreground size.
 */
/**
 * The two things the blend needs from scene metadata that a pasted avatar
 * cannot supply: what each face is feeling, and what each person is attending
 * to.
 *
 * Takes the interaction's `object` and deliberately NOT its `where`. `where`
 * is the staging sentence ("kneels at the gap in the bridge railing") and
 * sending it is what relocated characters in every run that included it;
 * `object` is just the target their eyes go to. One field apart, opposite
 * outcomes — see buildBlendEditPrompt's note.
 */
function buildBlendMetadata(fullData, scene = null, clothingRequirements = null) {
  const fd = fullData || {};
  const chars = fd.characters || scene?.sceneCharacters || [];

  // Clothing comes from clothingRequirements — the canonical per-story source —
  // and never from a saved avatar's wardrobe, which legitimately differs from
  // what a character wears in this story. The scene character carries the
  // CATEGORY ('summer', 'costumed:pirate'); the requirement holds the prose.
  const characterClothing = {};
  for (const c of chars) {
    if (!c?.name) continue;
    const reqs = clothingRequirements?.[c.name];
    if (!reqs) continue;
    const cat = String(c.clothing || '').toLowerCase();
    const key = cat.startsWith('costumed') ? 'costumed' : cat;
    const entry = reqs[key] || Object.values(reqs).find(v => v?.used && v.description);
    if (entry?.description) characterClothing[c.name] = String(entry.description).trim().slice(0, 400);
  }
  const characterExpressions = {};
  for (const c of chars) {
    if (c?.name && c.expression) characterExpressions[c.name] = String(c.expression).trim();
  }
  const attentionTargets = {};
  const characterActions = {};
  for (const it of (fd.interactions || [])) {
    if (!it?.character) continue;
    if (it.object) attentionTargets[it.character] = String(it.object).trim();
    // `where` is the interaction itself ("kneels at the gap in the railing and
    // peers down through it"). It is sent as something to perform ON THE SPOT,
    // never as a placement — the prompt's own wording carries that distinction,
    // because the same sentence inside a scene-staging prompt is what moved
    // characters across the frame in every earlier attempt.
    if (it.where) characterActions[it.character] = String(it.where).trim();
  }
  return { characterExpressions, attentionTargets, characterActions, characterClothing };
}

// Age as the census words it. Kept coarse on purpose: the blend needs to know
// a figure is a child rather than a shrunk adult, and nothing finer.
// Metadata fragments arrive lowercase and unpunctuated ("kneels at the gap",
// "eyes wide with urgency"). The blend reads as prose now, so each one becomes
// its own sentence rather than a bullet fragment.
function _sentence(text) {
  const t = String(text || '').trim().replace(/[.\s]+$/, '');
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}

function _ageWord(age) {
  const n = Number(age);
  if (!Number.isFinite(n)) return 'a person';
  if (n < 4) return 'a toddler';
  if (n < 13) return 'a child';
  if (n < 20) return 'a teenager';
  if (n < 60) return 'an adult';
  return 'an elderly person';
}

function buildStagedDepthLine(cast) {
  if (!Array.isArray(cast) || !cast.length) return '';
  const byDepth = { foreground: [], midground: [], background: [] };
  for (const c of cast) {
    const d = String(c.depth || 'foreground').toLowerCase();
    if (byDepth[d]) byDepth[d].push(c.name);
  }
  const parts = [];
  if (byDepth.background.length) parts.push(`${byDepth.background.join(' and ')} ${byDepth.background.length > 1 ? 'are' : 'is'} in the background — small and distant`);
  if (byDepth.midground.length) parts.push(`${byDepth.midground.join(' and ')} ${byDepth.midground.length > 1 ? 'are' : 'is'} midground`);
  if (byDepth.foreground.length) parts.push(`${byDepth.foreground.join(' and ')} ${byDepth.foreground.length > 1 ? 'are' : 'is'} foreground — largest`);
  return parts.length ? `\n\nDepths as staged: ${parts.join('; ')}.` : '';
}

/**
 * The blend prompt for a composited page.
 *
 * MEASURED, nine variants on one fixed canvas (Lab 695-705, 2026-08-15). The
 * page's own generation prompt is NOT usable here, even though sending it was
 * the obvious idea: its `Composition`, `EXACT POSES` and `EXPRESSIONS` sections
 * are orders to arrange a scene, and at blend time the scene is already
 * arranged, so the model carries them out — it relocated a character from a
 * bridge down onto the promenade in 3 of 3 runs that included them. Rewording
 * them as descriptions of Image 1 did not help (run C). Naming the occluder
 * made it worse (run E). Deleting them is what worked.
 *
 * What is sent instead, and why each part earns its place:
 *   - a CENSUS of who is in the picture. Without it a half-hidden figure is
 *     read as an artefact and painted out (run A deleted a man entirely).
 *   - KEEP WHERE THEY ARE, since position and size are already correct.
 *   - MAKE THEM NATURAL — the two jobs the blend actually exists for.
 *   - the EXPRESSIONS and ATTENTION targets from the scene metadata, because
 *     pasted avatar cut-outs are blank-faced and looking at the camera.
 *
 * Known cost of the expression block: the frame creeps in as the prompt grows
 * (1810 chars held the framing exactly, 3063 zoomed enough to cut feet). The
 * owner chose to keep the expressions and accept that. Do not "fix" it by
 * adding another prohibition — four different ones have been overridden.
 */
function buildBlendEditPrompt(scene, cast = null) {
  const people = Array.isArray(cast) ? cast : [];
  if (people.length) {
    const expressions = scene.characterExpressions || {};
    const attention = scene.attentionTargets || {};
    const actions = scene.characterActions || {};
    const occluded = scene.occludedBy || {};
    const artStyle = _blendStyleLine(scene.artStyle);

    const depthWord = (c) => {
      const d = String(c.depth || 'foreground').toLowerCase();
      return d === 'background' ? 'in the distance'
        : d === 'midground' ? 'in the middle distance' : 'close to the camera';
    };

    // One paragraph per person, and every fact stated ONCE. The old build said
    // each action twice (as "doing:" in the census and again under CHANGE
    // THESE), each outfit twice (the scene overview and "wearing:"), and each
    // depth twice (the census word and a trailing "Depths as staged" line) —
    // roughly a third of the prompt was restatement, and what got restated was
    // what to CHANGE rather than what to keep.
    const lines = people.map((c) => {
      const bits = [`- ${c.name} — ${_ageWord(c.age)}, ${depthWord(c)}.`];
      if (actions[c.name]) bits.push(` ${_sentence(actions[c.name])}`);
      if (attention[c.name]) bits.push(` Looking at ${attention[c.name]}.`);
      if (expressions[c.name]) bits.push(` ${_sentence(expressions[c.name])}`);
      // Size-neutral, and the occluder is deliberately NOT named: run E of Lab
      // 695-705 named it and the result was worse.
      if (occluded[c.name]) bits.push(' Only part of them shows, which is deliberate — leave them exactly as they are, at exactly the size they are.');
      return bits.join('');
    }).join('\n');

    const textDirective = buildTextOverlayDirective(scene.textOverlay, scene.artStyle);

    return `${artStyle}.

This picture is finished and correctly staged: every person stands where they belong, at the size they belong. What it lacks is life — the faces are blank and the bodies are stiff from being pasted in.

Give each person below their expression, and turn their head and body on the spot toward what they are watching:
${lines}

Then settle them into the picture: soften the pasted edges, paint out any solid colour fringe around them, match each person to the light and colour of the scene, and give each one a contact shadow where they meet the ground.

Everything else is already right and stays as it is — the camera position, the borders and the crop, the background, and who is in the frame. No lettering anywhere in the picture.${textDirective}`;
  }

  // Legacy path — no page prompt supplied (older callers, cover dispatcher).
  const styleLine = _blendStyleLine(scene.artStyle);
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

  // Cover text-overlay directive — only present when caller (test-models cover
  // dispatcher) supplied scene.textOverlay. Empty string otherwise so scenes
  // are unaffected. Built before the brief-trim so the directive's bytes are
  // accounted for in briefRoom.
  const textDirective = buildTextOverlayDirective(scene.textOverlay, scene.artStyle);

  // Tight cap: trim the brief if total prompt would exceed Grok's 8000-char
  // edit limit. The earlier 5500-char compositeBrief slice in regeneration.js
  // left no room for boilerplate when fully populated (8058 chars in
  // production smoke). Re-slice at the prompt builder so both the test-
  // models route AND the main pipeline are protected.
  const fixedLen = boilerplate.length + (brief ? briefHeader.length : 0) + textDirective.length;
  const briefRoom = Math.max(0, BLEND_PROMPT_HARD_CAP - fixedLen);
  const trimmedBrief = brief.length > briefRoom ? brief.slice(0, briefRoom).trim() + '\n[...]' : brief;
  const briefBlock = trimmedBrief ? `${briefHeader}${trimmedBrief}` : '';
  const full = `${boilerplate}${briefBlock}${textDirective}`;
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
    if (cropMode === 'body' && !c.singleImage) {
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
    // No left/right here. The direction used to come from `c.flip`, which
    // nothing in the beats metadata ever sets, so every three-quarter and
    // profile figure was told "facing left" — a direction no one chose.
    // Only front, side and back read reliably; which way a figure turns is
    // left to the position and action text.
    const poseLabel = {
      front:        'front view, body facing the camera',
      threeQuarter: 'three-quarter view',
      profile:      'profile view',
      back:         'back view, viewer sees the back of the head',
    }[c.pose] || 'three-quarter view';
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
  // Back-cast positions also need substitution — scene expansion can write
  // "Sarah stands beside Daniel"; Daniel is another back-cast (silhouette)
  // so the bare name leaks into the prompt and confuses Grok. Replace with
  // the matching colour reference.
  const sanitisedBackCast = backCast.map(c => ({ ...c, position: subBackNames(c.position), action: subBackNames(c.action) }));
  const frontBlock = frontCast.length > 0
    ? `FOREGROUND (real characters, painted INTO the scene, closer to camera) — render these ${frontCast.length} character(s) using the identity pack for face/hair/clothing. These foreground figures sit IN FRONT of any silhouettes they overlap; paint them ON TOP, occluding background silhouettes wherever they cross.\n\n${buildBackCharLines(sanitisedFrontCast)}\n`
    : '';
  const backBlock = backCast.length > 0
    ? `BACKGROUND (silhouette placeholders, farther from camera, BEHIND the foreground) — paint ${backCast.length} flat-colour silhouette shape(s) on the scene, at the back of the cast layout. The foreground characters above will be drawn IN FRONT of these silhouettes — wherever a foreground character overlaps a silhouette, the foreground character wins (paint over the silhouette). The silhouettes are NOT real characters; they are pure solid-colour cutouts with no face, no clothing, no hair detail, no shading. They mark where real background characters will be inset in a later step.\n\n${buildAnonymousCastLines(sanitisedBackCast)}\n\nSILHOUETTE RENDERING DETAILS:\n- Flat human-shaped block filled with FULLY SATURATED solid colour at the exact hex above — no gradient, no transparency, no shading, no skin tone, no face, no hair texture, no clothing texture.\n- Small BLACK eye dot(s) inside the head per the marker spec above.\n- A correctly drawn silhouette looks like a paper cutout pasted onto the scene.`
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
  // Tail: by default "NO TEXT in the output." For covers (scene.textOverlay
  // supplied), swap in the override directive so the anchor plate renders
  // title / dedication / branding instead of dropping it. Without this swap,
  // even when the brief asks for a title, the trailing NO TEXT line wins
  // and Grok produces a textless front cover. Same pattern as
  // buildBlendEditPrompt's textOverlay override.
  const textDirective = buildTextOverlayDirective(scene?.textOverlay, scene?.artStyle);
  const tail = textDirective || `\nNO TEXT in the output.`;
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

The silhouettes to remove are these solid saturated colours: ${colorList}. Each one is a flat human-shaped block of solid colour — a paler tone of the same colour on the head and neck, the saturated tone on the body, with small black eye dots — painted on top of the scene. Remove the pale head area as well as the saturated body.

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
  // In the new pipeline this function fills the BACK silhouettes with real
  // characters — so frontCast here is actually the back stratum (renders
  // names KEPT), backCast here is the foreground stratum (drawn elsewhere
  // in step 1, NOT in this image).
  //
  // For sentences that co-mention an off-image character, keep their name
  // and add a "(drawn separately on the foreground layer, do not redraw)"
  // parenthetical. Keeping the name preserves spatial context ("Emma
  // reaches up from one step below Noah" still parses); the parenthetical
  // tells Grok not to actually paint them. Better than a generic "a
  // background figure" which (a) was misleading in the new flow, and (b)
  // collapsed multiple distinct off-image characters into the same
  // identical phrase, making sentences ambiguous.
  const backSubs = Object.fromEntries(backNames.map(n => [n, `${n} (drawn separately on the foreground layer — do NOT redraw here)`]));
  const offCanvasNote = backNames.length > 0
    ? `\nNOTE: ${backNames.join(', ')} are FOREGROUND characters drawn on a separate layer in step 1. They are NOT in this image. Do NOT paint them here. This image only contains the silhouette-mapped background characters listed above.\n`
    : '';
  const briefHeader = `\nPAGE BRIEF (background characters only — the ones being rendered HERE) — canonical descriptions of the silhouette characters and their costumes. Use these (with the identity pack) for face, hair, clothing.\n\n`;
  const rawBrief = scene?.pageBrief ? String(scene.pageBrief).trim() : '';
  const filteredBrief = filterBriefByStratum(rawBrief, frontNames, backNames, backSubs);
  const fixedLen = head.length + tail.length + offCanvasNote.length + (filteredBrief ? briefHeader.length + 1 : 0);
  const briefRoom = Math.max(0, STRATIFIED_PROMPT_HARD_CAP - fixedLen);
  const trimmedBrief = sliceBriefAtSentence(filteredBrief, briefRoom);
  const briefBlock = trimmedBrief ? `${briefHeader}${trimmedBrief}\n` : '';
  const full = `${head}${offCanvasNote}${briefBlock}${tail}`;
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
    // Visual Bible creatures declared on THIS page: [{ name, description }].
    // The plate is their only way into the image (see buildPlateCreatureBlock),
    // and the list is a whitelist — the model paints these and invents none.
    sceneCreatures = [],
    // Per-call override for the phantom-pose render technique. When true,
    // step 3 renders each character in their phantom's pose via an extra
    // Grok edit call (full 2×4 sheet + cropped phantom) before pasting,
    // instead of cutting a static standing cell from the 2×4 sheet.
    // Default reads from MODEL_DEFAULTS.phantomPoseRender (false).
    phantomPoseRender = false,
    // Stop after the paste and return the raw composited canvas. The blend is
    // a third Grok call that repaints the frame, and it has been observed to
    // resize the pasted figures — so when the question is what the paste step
    // produced, skipping it is both cheaper and the honest comparison.
    // NOT a shippable output on its own: the pasted figures read as stickers.
    skipBlend = false,
    // How each detected silhouette becomes the real character:
    //   'paste'      — cut the pose cell out of the 2×4 sheet, scale it by the
    //                  stature model, paste it, then blend the whole frame.
    //   'charRepair' — hand the silhouette's box to the SAME character-repair
    //                  Grok call production already uses for identity fixes,
    //                  once per figure, so the model paints the character into
    //                  the scene instead of us compositing pixels into it.
    figureMethod = 'paste',
    // 'dino' (default) or 'diff' — see the detection step. The diff is kept
    // only so a Lab run can reproduce a pre-2026-08-15 result; it is the
    // detector that mistook lawn for a character.
    figureDetect = 'dino',
  } = opts;

  if (!cleanBackgroundPrompt && !scene?.description) {
    throw new Error('cleanBackgroundPrompt or scene.description required');
  }
  if (!Array.isArray(cast) || cast.length === 0) throw new Error('cast must be non-empty');

  if (existingCleanBackground) {
    log.info('[SCENE COMPOSITE] existingCleanBackground passed — ignored in populated-plate-first pipeline (clean BG is now derived from the populated plate).');
  }

  // Assign colours + colour names to any cast entry missing them.
  const usedColors = new Set(cast.map((c) => c.color).filter(Boolean));
  let nextColorIdx = 0;
  for (const c of cast) {
    if (c.color && c.colorName) continue;
    if (!c.color) {
      while (usedColors.has(DEFAULT_PALETTE[nextColorIdx]) && nextColorIdx < DEFAULT_PALETTE.length) {
        nextColorIdx++;
      }
      if (nextColorIdx >= DEFAULT_PALETTE.length) {
        throw new Error(`out of default palette colours (cast has ${cast.length} characters)`);
      }
      c.color = DEFAULT_PALETTE[nextColorIdx++];
      usedColors.add(c.color);
    }
    if (!c.colorName) c.colorName = DEFAULT_PALETTE_NAMES[c.color] || 'coloured';
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
  const populatedPrompt = buildPopulatedPlatePrompt(scene, cast, cleanBackgroundPrompt, sceneCreatures);
  if (sceneCreatures.length) {
    log.info(`[SCENE COMPOSITE] plate paints ${sceneCreatures.length} VB creature(s): ${sceneCreatures.map(c => c.name).join(', ')}`);
  }
  const populated = await generateWithGrok(populatedPrompt, { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', populated.usage, 'scene_composite_populated_plate', populated.modelId);
  totalCost += populated.usage?.cost || 0;
  const populatedBuf = Buffer.from(stripDataUriPrefix(populated.imageData), 'base64');
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
  // skipOutputCrop: step 3 DIFFS this plate against the populated one pixel for
  // pixel to derive the silhouette masks. A drift crop on either side destroys
  // that correspondence.
  const depopulated = await editWithGrok(depopulatePrompt, [populated.imageData], { aspectRatio, model: GROK_MODELS.STANDARD, skipOutputCrop: true });
  if (usageTracker) usageTracker('grok', depopulated.usage, 'scene_composite_depopulate', depopulated.modelId);
  totalCost += depopulated.usage?.cost || 0;
  const bgImageData = depopulated.imageData;
  const bgBuf = Buffer.from(stripDataUriPrefix(bgImageData), 'base64');
  debug.cleanBackground = bgImageData;
  debug.cleanBackgroundPrompt = cleanBackgroundPrompt || null;
  debug.cleanBackgroundSource = 'derived-from-populated-plate';
  debug.depopulatePrompt = depopulatePrompt;
  debug.depopulateSentToGrok = depopulated.sentToGrok || null;

  // ── Step 3/5: detect silhouettes by diffing populated against clean BG.
  // Hue matching alone fails on palette collisions (e.g. yellow silhouette
  // on a yellow lawn — see story job_1778865205295_c2n86mdmn p4). The diff
  // mask removes the background palette entirely before hue runs.
  // 'dino' asks GroundingDINO where the people are and uses the palette only to
  // say WHICH person each box is — scenery cannot impersonate a figure that
  // way. 'diff' is the original: subtract the clean background, then match hue.
  const detector = figureDetect === 'diff' ? 'diff' : 'dino';
  log.info(`[SCENE COMPOSITE] step 3/5 — bbox detect (${detector})`);
  const detection = detector === 'dino'
    ? await findSilhouettesWithDino(populatedBuf, cast)
    : await findSilhouettesByDiff(populatedBuf, bgBuf, cast);
  debug.detector = detector;
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
  if (detection.diffMaskCount != null) {
    log.info(`[SCENE COMPOSITE]   diff mask: ${detection.diffMaskCount} px (${(100 * detection.diffMaskCount / (detection.canvasWidth * detection.canvasHeight)).toFixed(1)}% of canvas)`);
  }

  // ── Two aborts, before a single figure is scaled ────────────────────────
  //
  // Both keep the page that normal generation already produced, which on a
  // scene like this is better than anything the composite can build. The
  // pipeline treats a throw here as "ship the rendered page".
  //
  // (a) A box that cannot be a person. On p4 the detector keyed sunlit lawn
  //     into a character's yellow and returned a 177x39 strip. Every number
  //     downstream is derived from these boxes, so one bogus box is not a
  //     local error — it inverted the ground plane and shrank two children to
  //     40%. If detection is wrong about WHO is where, nothing after it is
  //     worth computing.
  //
  // (b) No depth spread. The composite exists for scenes with someone near
  //     and someone far; it is triggered by the scene metadata DECLARING that
  //     split. The plate shows whether the split is real. Measured across
  //     three pages (Lab 707/708/709):
  //       p6  tallest/shortest 2.77, foot-lines spanning 40% of canvas — real
  //       p10 1.73, 28% — five figures in one band, three standing in water
  //       p4  1.08, 14% — five figures round one chest, declared 3 fore + 2 back
  //     Below 2x there is no depth to correct, so compositing can only lose:
  //     it removes Grok's own figures and pastes standing avatars into the
  //     spaces where the plate drew people kneeling or waist-deep in a river.
  const figureBoxes = cast.map(c => detection.results[c.name]?.bbox).filter(Boolean);
  const bogus = cast.filter((c) => {
    const b = detection.results[c.name]?.bbox;
    return b && !_isPlausibleFigureBox(b, detection.results[c.name]?.head);
  });
  // A refusal must not destroy its own evidence. Both gates below fire AFTER
  // the plate and the depopulated plate have been generated and paid for
  // (2 Grok calls), and until now the throw discarded them: the plate that
  // proves WHY the composite refused existed only in memory. Callers that
  // want to show the refusal read `err.compositeDebug` — the same debug
  // object a successful run returns, holding whatever had been built.
  const refuse = (message) => {
    const err = new Error(message);
    // Stamped onto the debug itself, not only onto the Error: the production
    // pipeline persists the debug and the Error is gone by then, so a stored
    // refusal has to carry its own reason.
    debug.abortReason = message;
    err.compositeDebug = debug;
    return err;
  };
  if (bogus.length) {
    throw refuse('[SCENE COMPOSITE] detection returned a box that cannot be a standing figure ('
      + bogus.map(c => `${c.name} ${detection.results[c.name].bbox.width}x${detection.results[c.name].bbox.height}`).join(', ')
      + ') — scenery was keyed into a character colour, so the page keeps its original render');
  }
  if (figureBoxes.length >= 2) {
    const hs = figureBoxes.map(b => b.height);
    const spread = Math.max(...hs) / Math.min(...hs);
    debug.depthSpread = Number(spread.toFixed(2));
    if (spread < MIN_DEPTH_SPREAD) {
      throw refuse(`[SCENE COMPOSITE] no depth spread on the plate — tallest/shortest figure is ${spread.toFixed(2)}x `
        + `(needs ${MIN_DEPTH_SPREAD}x). Every character is at the same distance, so the declared foreground/background `
        + 'split is not real and there is nothing for the composite to correct — the page keeps its original render');
    }
  }

  // ── Stature correction ──────────────────────────────────────────────────
  // Grok places figures at the right DEPTH but not reliably at the right
  // STATURE, so scaling a cutout to bbox.height reproduces its error. The
  // model (see buildStatureModel) reads the box as a depth probe instead and
  // derives each figure's height from its own real-world height.
  // Plate proportions first: the median heads-per-body across whole figures is
  // what lets the stature model recognise (and exclude) an occluded anchor.
  const plate = buildPlateHeadRatio(cast, detection.results, detection.canvasHeight);
  const headsByName = Object.fromEntries(cast
    .map(c => [c.name, detection.results[c.name]?.head])
    .filter(([, h]) => h));
  // Age sizing replaces the ground plane (owner, 2026-08-15): a child is sized
  // against the adults actually painted on this plate, never converted through
  // centimetres and back. buildStatureModel and its foot-solve are gone here.
  const ageTargets = buildAgeTargets(cast, detection.results, detection.canvasHeight);
  if (plate.ratio) log.info(`[SCENE COMPOSITE]   plate proportions: ${plate.ratio.toFixed(2)} heads per body (from ${plate.n} whole figure${plate.n === 1 ? '' : 's'})`);
  debug.plateHeadRatio = plate.ratio ? { ratio: Number(plate.ratio.toFixed(3)), fromFigures: plate.n } : null;
  debug.ageTargets = ageTargets;
  debug.heads = Object.fromEntries(cast
    .map(c => [c.name, detection.results[c.name]?.head || null])
    .filter(([, h]) => h));
  for (const [n, t] of Object.entries(ageTargets)) {
    log.info(`[SCENE COMPOSITE]   age sizing: ${n} ${detection.results[n].bbox.height}px -> ${t}px, measured against the adults on the plate`);
  }

  // ── Step 4 alternative: hand each silhouette to character repair.
  // Instead of compositing pixels into the plate, ask Grok to paint the real
  // character over the coloured figure — the same call production already uses
  // for identity fixes. The plate keeps its pose, its contact with the ground
  // and its occlusion, because the model repaints in place rather than us
  // pasting a standing cell on top. Costs one Grok call per figure.
  if (figureMethod === 'charRepair') {
    const { repairCharacterFace } = require('./faceRepair');
    log.info(`[SCENE COMPOSITE] step 4/4 — character repair over the plate (${Object.keys(bboxes).length} figures)`);
    let current = populated.imageData;
    const repairLog = [];
    const repairSteps = {};
    for (const c of cast) {
      const bbox = bboxes[c.name];
      if (!bbox) { repairLog.push({ name: c.name, skipped: 'no silhouette detected' }); continue; }
      // Char repair takes NORMALISED [ymin, xmin, ymax, xmax].
      const nb = [
        bbox.y / detection.canvasHeight,
        bbox.x / detection.canvasWidth,
        (bbox.y + bbox.height) / detection.canvasHeight,
        (bbox.x + bbox.width) / detection.canvasWidth,
      ];
      let avatarUri = null;
      try {
        const cell = await cropAvatarCell(c.sheetBuf, { pose: c.pose });
        const buf = cell.body || cell.stacked || cell.face;
        if (buf) avatarUri = `data:image/png;base64,${buf.toString('base64')}`;
      } catch (err) {
        log.warn(`[SCENE COMPOSITE] avatar cell for ${c.name} failed: ${err.message}`);
      }
      if (!avatarUri) { repairLog.push({ name: c.name, skipped: 'no avatar cell' }); continue; }
      try {
        // Winning configuration, measured over 20 single-figure runs:
        //   cutout  — the model receives ONLY the padded crop. In box mode it
        //             "sees the full scene" (resolveRegion) and composes for the
        //             page, painting a figure that spills far outside its box.
        //   crosshatch + FULL-FIGURE strong blur — the blur removes identity
        //             while stance survives, so the character comes from the
        //             avatar rather than from the ghost; the hatch marks what to
        //             repaint. The template already expects this ("infer pose
        //             from the figure still faintly visible through the
        //             crosshatch").
        //   styleMatch OFF — its premise is inverted here. It guards a character
        //             already drawn in the page's medium; we are deliberately
        //             inserting the avatar, and matching the avatar IS the goal.
        //             iou / whiteCard / coverage stay ON: those catch real
        //             garbage, as a run with iou off demonstrated.
        // The figure mask comes from SAM, not from a hand-rolled colour mask —
        // colour keys miss hands and faces (skin tones match no palette hue) and
        // patching that by hand bled into neighbouring figures.
        const res = await repairCharacterFace(current, avatarUri, {
          model: 'grok',
          regionSource: 'cutout',
          treatment: 'crosshatch',
          faceOnly: false,
          bodyBbox: nb,
          bbox: nb,
          charName: c.name,
          issueDescription: `The figure is a flat ${c.colorName || 'coloured'} placeholder silhouette. Paint ${c.name} there instead.`,
          clothingDescription: c.clothing || null,
          sceneDescription: scene?.description || '',
          artStyle: scene?.artStyle || null,
          blurFigure: true,
          blurStrength: 'strong',
          gates: { styleMatch: false },
          includeDebug: true,
        });
        if (res?.imageData) {
          current = res.imageData;
          repairSteps[c.name] = res.imageData;
          repairLog.push({ name: c.name, bbox: nb.map(v => +v.toFixed(3)), method: res.method || 'grok' });
          log.info(`[SCENE COMPOSITE]   ${c.name}: repaired in place (${res.method || 'grok'})`);
        } else {
          // Carry the rejection REASON, not just "nothing" — a silent skip is
          // what let a raw silhouette ship in the first place.
          const why = [res?.rejectedReason, res?.gateMessage, res?.error]
            .filter(Boolean).join(' — ') || 'repair returned nothing';
          repairLog.push({ name: c.name, skipped: why });
          log.warn(`[SCENE COMPOSITE]   ${c.name}: repair produced nothing — ${why}`);
        }
      } catch (err) {
        repairLog.push({ name: c.name, skipped: err.message });
        log.warn(`[SCENE COMPOSITE]   ${c.name}: repair threw — ${err.message}`);
      }
      if (usageTracker) usageTracker('grok', { cost: 0.02 }, 'scene_composite_char_repair', GROK_MODELS.STANDARD);
      totalCost += 0.02;
    }
    debug.charRepairLog = repairLog;
    debug.charRepairSteps = repairSteps;
    debug.composited = current;
    log.info(`[SCENE COMPOSITE] complete (charRepair) — total cost $${totalCost.toFixed(4)}`);
    return {
      imageData: current,
      usage: { cost: totalCost, direct_cost: totalCost, model: 'scene-composite-charrepair' },
      debug,
    };
  }

  // ── Step 4/5: composite character cutouts onto the derived clean BG
  log.info(`[SCENE COMPOSITE] step 4/5 — composite cutouts${phantomPoseRender ? ' (phantom-pose render ON)' : ''}`);
  const placements = [];
  const placementLog = [];
  const cutoutDebug = {};
  const occludedBy = {};   // name → true when scenery hid part of them and we clipped
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
          stripDataUriPrefix(ppr.imageData),
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
      // A Visual Bible secondary character carries ONE reference image, not a
      // 2×4 pose sheet — cropping a cell out of it yields a fragment of the
      // figure (a shoulder, half a face). Use the whole buffer for those.
      const cellBuf = c.singleImage
        ? c.sheetBuf
        : await cropSheetCell(c.sheetBuf, POSE_CELL[c.pose]);
      cutBuf = await removeBackground(cellBuf);
      cutBuf = await trimTransparent(cutBuf);
      if (c.flip) cutBuf = await flipHorizontal(cutBuf);
    }
    // Height + vertical anchor from the stature model. The box still supplies
    // the horizontal position; whether its BOTTOM is a ground line or just the
    // edge of the frame is decided by sizeFigure.
    const { targetH, anchor, clip, via, paintedFull, visibleFraction } = sizeFigure(
      c, bbox, detection.canvasWidth, detection.canvasHeight,
      detection.results[c.name]?.head, plate.ratio, ageTargets[c.name]);
    if (targetH !== bbox.height) {
      log.info(`[SCENE COMPOSITE]   ${c.name} (age ${c.age}): box h=${bbox.height}${clip.bottom ? ' (clipped)' : ''} → ${targetH} (${((targetH / bbox.height - 1) * 100).toFixed(0)}%), anchored by ${anchor}, via ${via}${visibleFraction ? `, ${Math.round(visibleFraction * 100)}% on show` : ''}`);
    }
    let scaled = await scaleToHeight(cutBuf, Math.max(20, targetH));

    // Scenery hides the rest of this figure, so paste only the part that shows.
    // Drawing the whole body would paint over the very thing doing the hiding,
    // and the scene interaction the brief asked for disappears with it.
    // Clip at the OCCLUDER LINE, not at a fraction. The thing hiding this
    // figure sits at a fixed place on the canvas — the silhouette's own bottom
    // edge — so the visible height is bbox.height no matter what the figure's
    // full height works out to. Scaling him does not move the railing.
    //
    // Clipping by fraction was wrong twice over: the fraction was measured
    // against the height Grok PAINTED and then applied to a differently scaled
    // figure, so two rulers were mixed. On p6 that pasted 50px of a man whose
    // visible silhouette was 85px.
    if (visibleFraction && visibleFraction < 1) {
      const m0 = await sharp(scaled).metadata();
      const keep = Math.max(8, Math.min(m0.height, bbox.height));
      // Second guard, in the same spirit as MAX_SHOWN_TO_COUNT_AS_OCCLUDED and
      // deliberately not folded into it: whatever the branch above concluded,
      // a cut of a few percent is measurement slop and takes a character's
      // feet off for nothing. Either scenery hides a real part of this figure
      // or it does not.
      if (keep < m0.height * MAX_SHOWN_TO_COUNT_AS_OCCLUDED) {
        scaled = await sharp(scaled)
          .extract({ left: 0, top: 0, width: m0.width, height: keep }).png().toBuffer();
        log.info(`[SCENE COMPOSITE]   ${c.name}: clipped at the occluder line (${m0.height}px → ${keep}px, matching the ${bbox.height}px visible silhouette)`);
        // The blend census tells the model this figure is partly hidden, so it
        // does not read a half-body as an artefact and paint it out.
        occludedBy[c.name] = true;
      }
    }

    let sMeta = await sharp(scaled).metadata();
    const cx = bbox.x + Math.floor(bbox.width / 2);
    const bottomY = bbox.y + bbox.height;
    const canvasH = detection.canvasHeight;
    // 'head': the box bottom is the frame edge, so pin the head where Grok
    // painted it and let the legs run off-canvas — that is the framing the
    // plate asked for. 'feet': pin the soles to the painted ground line.
    let top = anchor === 'head' ? bbox.y : bottomY - sMeta.height;
    // sharp refuses an overlay that falls outside the base, so trim whatever
    // leaves the canvas rather than shoving the figure back into frame (which
    // would move it off its mark).
    if (top < 0) {
      scaled = await sharp(scaled).extract({ left: 0, top: -top, width: sMeta.width, height: sMeta.height + top }).png().toBuffer();
      sMeta = await sharp(scaled).metadata();
      top = 0;
    }
    if (top + sMeta.height > canvasH) {
      scaled = await sharp(scaled).extract({ left: 0, top: 0, width: sMeta.width, height: canvasH - top }).png().toBuffer();
      sMeta = await sharp(scaled).metadata();
    }
    const left = Math.max(0, Math.min(detection.canvasWidth - sMeta.width, cx - Math.floor(sMeta.width / 2)));
    placements.push({
      input: scaled, left, top,
      _footY: bottomY, _name: c.name, _color: c.color, _bbox: bbox,
    });
    // Keep the exact cut-out that was pasted — the figure's own frame is where
    // a shredded alpha or a wrong sheet cell shows up, and it is invisible in
    // the flattened canvas.
    try { cutoutDebug[c.name] = `data:image/png;base64,${scaled.toString('base64')}`; } catch { /* debug only */ }
    // Per-figure record of what was measured and what decided the size — the
    // Lab card shows this, so a run can be judged without re-deriving it.
    placementLog.push({
      name: c.name,
      age: c.age,
      paintedBox: { w: bbox.width, h: bbox.height, x: bbox.x, y: bbox.y },
      clipped: clip.bottom ? 'bottom' : (clip.top ? 'top' : null),
      head: detection.results[c.name]?.head?.height || null,
      paintedFull: paintedFull || null,
      targetH,
      anchor,
      via,
      left, top,
    });
  }
  if (Object.keys(phantomPoseRenders).length > 0) debug.phantomPoseRenders = phantomPoseRenders;
  debug.placements = placementLog;
  debug.cutouts = cutoutDebug;

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

  // ── Figure-figure occlusion ───────────────────────────────────────────────
  // Paint order alone does not occlude: the front figure is a whole rectangular
  // cutout, so it covers the one behind and the back figure's own outline is
  // lost. Subtract, from each figure's alpha, the silhouettes of every figure
  // painted AFTER it — the ones the plate says stand in front.
  //
  // The masks are free: findSilhouettesByDiff already returns a full-canvas,
  // per-character mask (face and interior holes included) that this path has
  // been discarding. No SAM call, and more accurate than one, because we
  // painted these silhouettes ourselves.
  //
  // Guarded like the two existing subtract implementations (faceRepair.js:345,
  // samBlend.js:551): if removing a neighbour would erase more than 70% of the
  // target, the labels are crossed — keep the unsubtracted alpha.
  const occlusionLog = await subtractFiguresInFront(
    placements, silhouetteMasks, detection.canvasWidth, detection.canvasHeight);
  if (occlusionLog.length) debug.figureOcclusion = occlusionLog;

  // Strip the auxiliary fields before handing to sharp — it only knows input/left/top.
  const compositeInputs = placements.map(({ input, left, top }) => ({ input, left, top }));

  const composited = await sharp(bgBuf).composite(compositeInputs).png().toBuffer();

  const compositedData = `data:image/png;base64,${composited.toString('base64')}`;
  debug.composited = compositedData;

  if (skipBlend) {
    log.info(`[SCENE COMPOSITE] blend skipped — returning the raw pasted canvas. Total cost $${totalCost.toFixed(4)}, ${placements.length}/${cast.length} characters placed`);
    return {
      imageData: compositedData,
      usage: { cost: totalCost, direct_cost: totalCost, model: 'scene-composite-noblend' },
      debug,
    };
  }

  // ── Step 5/5: Grok edit blend pass
  log.info('[SCENE COMPOSITE] step 5/5 — blend pass');
  const blended = await blendPastedCanvas({
    compositedData, scene: { ...scene, occludedBy }, cast,
    aspectRatio, visualBibleGridImage, usageTracker, debug,
  });
  totalCost += blended.cost;

  log.info(`[SCENE COMPOSITE] complete — total cost $${totalCost.toFixed(4)}, ${placements.length}/${cast.length} characters placed`);

  return {
    imageData: blended.imageData,
    usage: { cost: totalCost, direct_cost: totalCost, model: 'scene-composite' },
    debug,
  };
}

/**
 * The blend pass on its own: take a pasted canvas and hand it to Grok with the
 * page's prompt plus the staging clause.
 *
 * Split out so it can be replayed. Every blend variant we want to compare runs
 * against the SAME pasted canvas — the plate, the depopulate and the paste are
 * already correct and re-rolling them changes the staging under the comparison,
 * which is how three earlier "the prompt is better now" readings turned out to
 * be a different plate rather than a different prompt. One Grok call per try.
 *
 * `promptOverride` replaces the built prompt outright (Lab A/B arms).
 */
async function blendPastedCanvas({
  compositedData, scene, cast, aspectRatio, visualBibleGridImage,
  usageTracker, promptOverride = null, debug = {},
}) {
  let blendPrompt = promptOverride || buildBlendEditPrompt(scene, cast);
  // The page's own prompt runs to ~7.5k on a busy page, so it can pass Grok's
  // budget once the staging clause is added. Shrink with the SAME helper page
  // generation uses: it holds the REQUIRED OBJECTS + ART STYLE tail back and
  // reattaches it verbatim. A blind cut is not an option — one measured at 7.5k
  // dropped the whole ART STYLE block and rendered photographic 3 times out of 3.
  if (blendPrompt.length > BLEND_PROMPT_HARD_CAP) {
    try {
      const { shrinkPromptForModel } = require('./images');
      const before = blendPrompt.length;
      blendPrompt = await shrinkPromptForModel(blendPrompt, BLEND_PROMPT_HARD_CAP, 'SCENE COMPOSITE BLEND', GROK_MODELS.STANDARD);
      log.info(`[SCENE COMPOSITE]   blend prompt ${before} → ${blendPrompt.length} chars (budget ${BLEND_PROMPT_HARD_CAP})`);
    } catch (err) {
      log.warn(`[SCENE COMPOSITE] blend prompt shrink failed (${err.message}) — sending as built at ${blendPrompt.length} chars`);
    }
  }
  debug.blendPrompt = blendPrompt;
  // VB grid as Image 2 — labelled portrait grid serves as the authoritative face /
  // clothing reference. The composited image stays as Image 1 (the canvas to refine).
  const blendRefs = visualBibleGridImage
    ? [compositedData, visualBibleGridImage]
    : [compositedData];
  debug.blendRefCount = blendRefs.length;
  const pass1 = await editWithGrok(blendPrompt, blendRefs, { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', pass1.usage, 'scene_composite_blend', pass1.modelId);
  debug.blendSentToGrok = pass1.sentToGrok || null;

  return { imageData: pass1.imageData, cost: pass1.usage?.cost || 0, blendPrompt };
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
    if (c.color && c.colorName) continue;
    if (!c.color) {
      while (usedColors.has(DEFAULT_PALETTE[nextColorIdx]) && nextColorIdx < DEFAULT_PALETTE.length) nextColorIdx++;
      if (nextColorIdx >= DEFAULT_PALETTE.length) {
        throw new Error(`out of default palette colours (back stratum has ${backCast.length} characters)`);
      }
      c.color = DEFAULT_PALETTE[nextColorIdx++];
      usedColors.add(c.color);
    }
    if (!c.colorName) c.colorName = DEFAULT_PALETTE_NAMES[c.color] || 'coloured';
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

// ─── Simple composite (no silhouette dance) ───────────────────────────────
//
// When backCast is empty (cast≤2 OR no real depth signal — see
// splitCastByStratum), the silhouette → cutout → align → composite cycle is
// pointless: there's nothing to round-trip. Instead we do the same thing
// coverComposite.js does for V2+ covers — server-side sharp.composite of
// each character's body-front cell onto the styled empty scene, then ONE
// Grok blend pass to refine edges + render text + add required objects.
//
// Identity is guaranteed because the actual styled-avatar pixels are in the
// canvas before Grok touches it. Grok can refine but can't reinvent a face
// it didn't draw. Same pattern, same cost ($0.02 empty scene + $0.02 blend
// edit = $0.04 total), and the dev panel gets the pre-Grok composited
// intermediate the user was looking for.

// Real-world heights by age (cm), copied from coverComposite.js so both
// paths produce visually consistent sizing.
function _heightCm(age) {
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

/**
 * A silhouette that runs off the edge of the canvas is CLIPPED — its box
 * height is the visible part of the figure, not the figure. Grok frames
 * foreground characters knee-up routinely, so this is the common case, not an
 * edge case. A clipped box may not be used as a stature reference (its height
 * means nothing) and may not be anchored by its feet (its bottom edge is the
 * frame, not the ground).
 */
function _boxClipping(bbox, canvasW, canvasH, tol = 2) {
  return {
    top: bbox.y <= tol,
    bottom: bbox.y + bbox.height >= canvasH - tol,
    left: bbox.x <= tol,
    right: bbox.x + bbox.width >= canvasW - tol,
  };
}

/**
 * Stature model — converts a figure's foot Y into pixels-per-cm at that depth.
 *
 * The detected bbox is Grok's painted silhouette. Treat it as a DEPTH probe,
 * not a height: s = boxHeight / realHeightCm is the pixels-per-cm where that
 * figure stands. Adults are the reference (their proportions are what Grok
 * draws most reliably), so fit s as a linear function of foot Y — a ground
 * plane recedes linearly in screen space — and give every figure
 * height = s(footY) × its own real height.
 *
 * Only UNCLIPPED adult boxes may anchor the fit. Clipped ones measure a
 * fraction of a body and would drag the whole page down with them.
 */
/**
 * Is this box a standing person at all?
 *
 * A standing figure is taller than it is wide. When the detector keys scenery
 * into a character's colour — a dirt mound, a chest lid, a shadow — it returns
 * a wide flat blob, and everything downstream believes it.
 *
 * Measured on job_1786567053374_8ktpkfhec p4 (Lab exp 708): an adult came back
 * as 177x39, a 4.5:1 landscape sliver. It became one of the two ground-plane
 * anchors, and fitting a plane through "an adult is 39px tall down at y=791"
 * and "an adult is 250px tall up at y=637" INVERTS the plane — apparent size
 * shrinking as things come nearer. Both children then scaled to 40% of the
 * size Grok painted them. One bad box, five wrong figures.
 */
/**
 * How tall a person of this age is, as a fraction of an adult (owner, 2026-08-15).
 *
 * These are the owner's numbers and they match growth charts closely enough:
 * a 4-year-old is ~103cm against an adult's ~175cm (0.59), a 7-year-old ~122cm
 * (0.70), a 10-year-old ~138cm (0.79), a 13-year-old ~156cm (0.89).
 *
 * 0.6 is the floor on purpose. Whatever the geometry claims, no figure is ever
 * scaled below 40% of the adult it is measured against — the ground plane that
 * this replaces once decided a five-year-old should be 40% of her PAINTED size
 * (p4, Lab 708), and a hard floor makes that class of failure impossible
 * instead of merely unlikely.
 */
const AGE_FLOOR = 0.6;
function _ageHeightFactor(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n) || n >= 18) return 1.0;
  if (n >= 13) return 0.9;
  if (n >= 10) return 0.8;
  if (n >= 6) return 0.7;
  return AGE_FLOOR;
}

/**
 * Size every non-adult against the adults actually painted on this plate.
 *
 * The rule the owner asked for, and it is a comparison rather than a model:
 * a child is always smaller than an adult, so a child's height is the adult's
 * height times the age factor. What it replaces — buildStatureModel and the
 * pixels → centimetres → pixels round trip — is what turned two ghosts drawn
 * 4% apart (257 and 268px) into figures 3x apart (323 and 108px), because each
 * figure was converted separately through its own real-world height.
 *
 * Which adult: the nearest one by foot line. When two or more adults stand at
 * different depths they also say how size changes with depth, so the
 * comparison is carried to the child's own foot line through them — two
 * measured points, never extrapolated beyond what the cap allows.
 *
 * Corrections only ever SHRINK, and never past AGE_FLOOR. No adult on the
 * plate means no correction: there is nothing to be smaller than.
 */
function buildAgeTargets(cast, results, canvasH) {
  const seen = [];
  for (const c of cast) {
    const r = results[c.name];
    if (!r?.bbox || !_isPlausibleFigureBox(r.bbox, r.head)) continue;
    seen.push({ name: c.name, age: parseInt(c.age, 10), h: r.bbox.height, foot: r.bbox.y + r.bbox.height });
  }
  const adults = seen.filter(s => !Number.isFinite(s.age) || s.age >= 18);
  const out = {};
  if (!adults.length) return out;

  // Adult height as a function of foot line: a straight line through two or
  // more adults, otherwise the single adult's height everywhere.
  let adultHeightAt;
  if (adults.length >= 2) {
    const sy = adults.reduce((a, s) => a + s.foot, 0) / adults.length;
    const sh = adults.reduce((a, s) => a + s.h, 0) / adults.length;
    let num = 0, den = 0;
    for (const s of adults) { num += (s.foot - sy) * (s.h - sh); den += (s.foot - sy) ** 2; }
    const slope = den > 0 ? num / den : 0;
    // A negative slope means the adults disagree about which way depth runs
    // (one of them is kneeling, or they stand on different surfaces). Fall back
    // to the tallest adult rather than trust the direction.
    adultHeightAt = slope > 0
      ? (y) => sh + slope * (y - sy)
      : () => Math.max(...adults.map(s => s.h));
  } else {
    adultHeightAt = () => adults[0].h;
  }

  for (const s of seen) {
    const factor = _ageHeightFactor(s.age);
    if (factor >= 1) continue;                       // adults keep what was painted
    const expected = Math.round(adultHeightAt(s.foot) * factor);
    // Shrink only, and never below the floor of the painted height.
    const target = Math.max(Math.round(s.h * AGE_FLOOR), Math.min(s.h, expected));
    if (target !== s.h) out[s.name] = target;
  }
  return out;
}

function _isPlausibleFigureBox(b, head = null) {
  if (!b || !(b.height > 0) || !(b.width > 0)) return false;
  if (b.height < 20) return false;
  // "Taller than wide" is the wrong test on its own, and p6 proves it: a man
  // leaning on a bridge parapet shows as 181x133 — torso and outstretched arms
  // above the rail, legs hidden — and rejecting him would throw away exactly
  // the case the composite is for. What separates him from p4's 177x39 strip
  // of lawn is the HEAD: the detector found a head band on the man and none on
  // the grass. So a wide box is allowed when a head sits in it, and only an
  // extreme, headless sliver is called scenery.
  if (head && head.height >= 8) return b.width / b.height <= 4;
  return b.width / b.height <= 2.5;
}

/**
 * Target paste height + vertical anchor for one figure.
 *
 * Returns { targetH, anchor } where anchor is 'feet' (align the cutout's
 * bottom to the box bottom) or 'head' (align its top to the box top, letting
 * the legs run off-canvas — the correct behaviour for a figure Grok framed
 * knee-up, where the box bottom is the frame edge and not a ground line).
 */
/**
 * Heads per full body height — the standard artist's scale. A newborn is about
 * 4 heads tall, an adult about 7.5; children fall between. Combined with a
 * measured head this gives a figure's full height with no horizon, no ground
 * plane, and no second figure to compare against.
 */
function _headsPerBody(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n)) return 7.5;
  if (n <= 1) return 4.0;
  if (n <= 3) return 5.0;
  if (n <= 5) return 5.5;
  if (n <= 7) return 6.0;
  if (n <= 10) return 6.5;
  if (n <= 12) return 7.0;
  if (n <= 15) return 7.25;
  return 7.5;
}

/**
 * Heads-per-body as THIS plate actually draws it, measured from the figures
 * whose full height is known (unclipped, with a head band).
 *
 * The canonical table is the wrong yardstick for a drawing: Grok renders
 * children's-book proportions, measured at 3.75–4.29 heads across three plates
 * for ages 5, 36, 38 and 68 alike, where the anatomical figures are 5.5–7.5.
 * Feeding canonical numbers in over-estimated a clipped figure by ~2×.
 * Both sides of the ratio must come from the same drawing convention, so take
 * it off the plate and fall back to anatomy only when nothing is measurable.
 */
function buildPlateHeadRatio(cast, results, canvasH) {
  const rs = [];
  for (const c of cast) {
    const r = results?.[c.name];
    if (!r || !r.head || r.head.height < 8) continue;
    if (r.bbox.y + r.bbox.height >= canvasH - 2) continue; // clipped: height unknown
    if (!_isPlausibleFigureBox(r.bbox, r.head)) continue;  // scenery keyed into a figure's colour
    rs.push(r.bbox.height / r.head.height);
  }
  if (!rs.length) return { ratio: null, n: 0 };
  rs.sort((a, b) => a - b);
  // Upper quartile, not the median. Occlusion only ever SHORTENS a body, so an
  // occluded figure reads as fewer heads and drags a median down — and this
  // ratio is the very yardstick used to detect occlusion, so a contaminated one
  // hides the thing it is supposed to find. The most complete figure on the
  // plate is the one telling the truth about its proportions.
  return { ratio: rs[Math.ceil((rs.length - 1) * 0.75)], n: rs.length };
}

/**
 * How tall to paste this figure, and whether to cut it.
 *
 * Three inputs, in this order (owner, 2026-08-15):
 *   1. THE PLATE. The height Grok painted is the answer unless something
 *      specific says otherwise. Every version of this function that started
 *      from a real-world height in centimetres instead produced a figure the
 *      plate never asked for — two ghosts drawn 4% apart came out 3x apart.
 *   2. THE HEAD, measured from the tint inside the face box. head x the
 *      plate's own heads-per-body is the figure Grok painted; if the box is
 *      materially shorter than that, scenery hides the rest. Scale to the
 *      full height and report the fraction that shows, so the paste site can
 *      clip at the occluder line and leave the occluder visible.
 *   3. THE AGE TARGET, when one was computed: a child measured against the
 *      adults on this plate (buildAgeTargets). Only ever shrinks, never past
 *      40%.
 *
 * A frame-clipped figure (box running off the bottom edge) is anchored by the
 * head so its legs run off canvas, which is the framing the plate asked for.
 */
function sizeFigure(c, bbox, canvasW, canvasH, head = null, plateRatio = null, ageTarget = null) {
  const clip = _boxClipping(bbox, canvasW, canvasH);
  const anchor = clip.bottom && !clip.top ? 'head' : 'feet';

  // Hidden by scenery: the head says the painted figure is taller than the box.
  if (head && head.height >= 8 && plateRatio && !clip.top) {
    const paintedFull = Math.round(head.height * plateRatio);
    const shown = bbox.height / paintedFull;
    if (shown < MAX_SHOWN_TO_COUNT_AS_OCCLUDED && shown > 0.15) {
      const full = ageTarget ? Math.max(bbox.height, Math.round(paintedFull * (ageTarget / bbox.height))) : paintedFull;
      return {
        targetH: Math.max(20, full),
        anchor: 'head',
        clip,
        corrected: true,
        paintedFull,
        visibleFraction: Math.min(1, shown),
        via: ageTarget ? 'head+occluded+age' : 'head+occluded',
      };
    }
  }

  // Cut off by the frame, not by scenery: the box bottom is the frame edge, so
  // the head pins the figure and the legs run off canvas. The head gives the
  // full height; without one, keep what was painted and let it be short.
  if (anchor === 'head') {
    const visible = canvasH - bbox.y;
    const full = head && head.height >= 8 && plateRatio
      ? Math.max(visible, Math.round(head.height * plateRatio))
      : Math.max(visible, bbox.height);
    const target = ageTarget ? Math.max(visible, Math.min(full, ageTarget)) : full;
    return { targetH: Math.max(20, target), anchor, clip, corrected: true, visible, via: 'frame-clipped' };
  }

  // Whole figure standing on visible ground: the plate is right, apart from a
  // child drawn adult-sized.
  if (ageTarget && ageTarget !== bbox.height) {
    return { targetH: Math.max(20, ageTarget), anchor, clip, corrected: true, via: 'age' };
  }
  return { targetH: bbox.height, anchor, clip, corrected: false, via: 'as-painted' };
}

// Parse a position phrase ("left foreground", "right midground", "in the
// scene") into a horizontal fraction (0–1) and a depth multiplier for size.
// Vague phrases default to centre + foreground.
function _parsePosition(phrase) {
  const s = String(phrase || '').toLowerCase();
  let xFrac = 0.5;
  if (s.includes('far left')) xFrac = 0.10;
  else if (s.includes('left')) xFrac = 0.30;
  else if (s.includes('far right')) xFrac = 0.90;
  else if (s.includes('right')) xFrac = 0.70;
  else if (s.includes('centre') || s.includes('center')) xFrac = 0.50;
  let depthMul = 1.0;
  if (s.includes('background')) depthMul = 0.55;
  else if (s.includes('midground')) depthMul = 0.75;
  return { xFrac, depthMul };
}

// Parse an aspect-ratio string ("3:4", "16:9") into [w, h] pixel dims given
// a base width. Used to size the composite canvas.
function _aspectDims(aspectRatio, baseWidth = 1024) {
  const m = String(aspectRatio || '3:4').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return { W: baseWidth, H: Math.round(baseWidth * 4 / 3) };
  const aw = parseFloat(m[1]), ah = parseFloat(m[2]);
  if (!aw || !ah) return { W: baseWidth, H: Math.round(baseWidth * 4 / 3) };
  return { W: baseWidth, H: Math.round(baseWidth * ah / aw) };
}

/**
 * Simple-composite path: paste body-front cells onto the empty scene at
 * deterministic positions, then run a single Grok blend pass to refine.
 * Used when backCast is empty.
 *
 * Returns the same shape generateStratifiedComposite returns so callers stay
 * agnostic about which branch ran.
 */
async function _simpleCompositePath({ emptySceneData, frontCast, aspectRatio, scene, usageTracker, debug, totalCost, visualBibleGridImage }) {
  const { W, H } = _aspectDims(aspectRatio, 1024);
  log.info(`[SCENE COMPOSITE/SIMPLE] start — ${frontCast.length} chars, canvas ${W}×${H}`);

  // 1. Decode empty scene into a buffer at canvas dimensions.
  const baseBase64 = (typeof emptySceneData === 'string')
    ? stripDataUriPrefix(emptySceneData)
    : emptySceneData.toString('base64');
  const baseInputBuf = Buffer.from(baseBase64, 'base64');
  const baseBuf = await sharp(baseInputBuf)
    .resize(W, H, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 92 })
    .toBuffer();

  // 2. Extract body-front cell + remove BG + trim, per character.
  const figures = [];
  for (const c of frontCast) {
    if (!c.sheetBuf || !Buffer.isBuffer(c.sheetBuf)) {
      log.warn(`[SCENE COMPOSITE/SIMPLE] ${c.name}: no sheetBuf — skipping`);
      continue;
    }
    const cellIdx = POSE_CELL[c.pose] ?? POSE_CELL.front;
    let cellBuf;
    try {
      // Single-image Visual Bible references have no cells to crop.
      cellBuf = c.singleImage ? c.sheetBuf : await cropSheetCell(c.sheetBuf, cellIdx);
    } catch (err) {
      log.warn(`[SCENE COMPOSITE/SIMPLE] ${c.name}: cropSheetCell failed (${err.message}); using full sheet`);
      cellBuf = c.sheetBuf;
    }
    const cleanBuf = await removeBackground(cellBuf);
    const trimmedBuf = await sharp(cleanBuf).trim({ threshold: 1 }).toBuffer().catch(() => cleanBuf);
    figures.push({ name: c.name, age: c.age, position: c.position, depth: c.depth, buffer: trimmedBuf });
  }
  if (figures.length === 0) throw new Error('[SCENE COMPOSITE/SIMPLE] no usable figures');

  // 3. Resize each figure by age (proportional to real-world cm). The tallest
  // figure occupies ~62% of canvas height; everyone else scales to match.
  const tallestCm = Math.max(...figures.map(f => _heightCm(f.age)));
  const targetTallestPx = Math.round(H * 0.62);
  const pxPerCm = targetTallestPx / tallestCm;
  for (const f of figures) {
    const { depthMul } = _parsePosition(f.position);
    const targetH = Math.max(40, Math.round(_heightCm(f.age) * pxPerCm * depthMul));
    let resized = await sharp(f.buffer).resize({ height: targetH }).png().toBuffer();
    let meta = await sharp(resized).metadata();
    if (meta.width > W || meta.height > H) {
      resized = await sharp(resized).resize({ width: W, height: H, fit: 'inside' }).png().toBuffer();
      meta = await sharp(resized).metadata();
    }
    f.buffer = resized;
    f.width = meta.width;
    f.height = meta.height;
    f.xFrac = _parsePosition(f.position).xFrac;
  }

  // 4. Compute (left, top) for each figure. Bottom-aligned to groundY; x
  // from parsed position phrase. Clamp to canvas bounds.
  const groundY = Math.round(H * 0.96);
  const layers = [];
  for (const f of figures) {
    const cx = Math.round(f.xFrac * W);
    const left = Math.max(0, Math.min(W - f.width, cx - Math.round(f.width / 2)));
    const top = Math.max(0, groundY - f.height);
    layers.push({ input: f.buffer, left, top });
  }

  // 5. Composite figures onto base.
  const composited = await sharp(baseBuf).composite(layers).jpeg({ quality: 92 }).toBuffer();
  debug.simpleComposite = `data:image/jpeg;base64,${composited.toString('base64')}`;
  debug.simpleCompositeFigures = figures.map(f => ({ name: f.name, age: f.age, width: f.width, height: f.height, position: f.position }));
  log.info(`[SCENE COMPOSITE/SIMPLE] composited ${figures.length} figures onto ${W}×${H} base`);

  // 6. Build blend prompt — existing buildBlendEditPrompt has scene.textOverlay
  // support so covers get title/dedication/branding rendered, scenes get the
  // default no-text behaviour. editWithGrok wants data URI strings (it does
  // r2.stripDataUriPrefix on each ref), so convert the composited buffer
  // before passing.
  const blendPrompt = buildBlendEditPrompt(scene);
  const blendRefs = [`data:image/jpeg;base64,${composited.toString('base64')}`];
  if (visualBibleGridImage) {
    const vbUri = typeof visualBibleGridImage === 'string'
      ? (visualBibleGridImage.startsWith('data:') ? visualBibleGridImage : `data:image/jpeg;base64,${visualBibleGridImage}`)
      : (Buffer.isBuffer(visualBibleGridImage) ? `data:image/jpeg;base64,${visualBibleGridImage.toString('base64')}` : null);
    if (vbUri) blendRefs.push(vbUri);
  }
  log.info(`[SCENE COMPOSITE/SIMPLE] blend edit — ${blendRefs.length} ref(s), aspect ${aspectRatio}`);
  const blend = await editWithGrok(blendPrompt, blendRefs, { aspectRatio, model: GROK_MODELS.STANDARD });
  if (usageTracker) usageTracker('grok', blend.usage, 'scene_composite_simple_blend', blend.modelId);
  totalCost += blend.usage?.cost || 0;
  debug.blendInput = `data:image/jpeg;base64,${composited.toString('base64')}`;
  debug.blendOutput = blend.imageData;
  debug.blendPrompt = blendPrompt;
  debug.blendSentToGrok = blend.sentToGrok || null;

  return {
    imageData: blend.imageData,
    usage: { cost: totalCost, direct_cost: totalCost, model: 'scene-composite-simple' },
    debug,
  };
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

  // ── Simple-composite branch ─────────────────────────────────────────────
  // When the back stratum is empty (cast≤2 or no real depth signal — see
  // splitCastByStratum), skip the anchor plate + silhouette dance entirely.
  // Server-side sharp.composite figures onto the empty scene, then one Grok
  // blend pass. Same cost as the old short-circuit ($0.04 total: empty scene
  // + 1 edit) but produces deterministic placement, pixel-faithful identity
  // (the styled avatar pixels ARE in the canvas before Grok touches it), and
  // a visible composited intermediate in the dev panel.
  if (backCast.length === 0) {
    return _simpleCompositePath({
      emptySceneData, frontCast, aspectRatio, scene, usageTracker, debug, totalCost,
      visualBibleGridImage,
    });
  }

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
  // skipOutputCrop: rendered figures are pasted back onto this anchor plate at
  // detected bbox coordinates — the plate must not be zoomed or shifted.
  const anchor = await editWithGrok(anchorPrompt, anchorRefs, { aspectRatio, model: GROK_MODELS.STANDARD, skipOutputCrop: true });
  if (usageTracker) usageTracker('grok', anchor.usage, 'scene_composite_strat_anchor_plate', anchor.modelId);
  totalCost += anchor.usage?.cost || 0;
  const anchorBuf = Buffer.from(stripDataUriPrefix(anchor.imageData), 'base64');
  debug.anchorPlate = anchor.imageData;
  debug.anchorPlatePrompt = anchorPrompt;
  debug.anchorPlateSentToGrok = anchor.sentToGrok || null;
  // Back-compat aliases — existing dev panels read these names.
  debug.populatedPlate = anchor.imageData;
  debug.populatedPlatePrompt = anchorPrompt;
  debug.populatedPlateSentToGrok = anchor.sentToGrok || null;
  debug.blocking = anchor.imageData;
  debug.blockingPrompt = anchorPrompt;

  // (The backCast.length === 0 short-circuit is handled earlier in this
  // function via _simpleCompositePath — the anchor-plate Grok edit is
  // skipped entirely in that case so the dev panel sees a real composited
  // intermediate instead of a prompt-driven render.)

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
  const presetName = closestGrokAspect(cropW, cropH);
  const targetRatio = GROK_ASPECT_PRESETS.find(p => p.name === presetName).value;
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
  log.info(`[SCENE COMPOSITE/STRATIFIED]   pad to preset ${presetName}: ${cropW}×${cropH} → ${paddedW}×${paddedH} (pad L${padLeft} T${padTop} R${padRight} B${padBottom})`);
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
  // skipOutputCrop: step 3 extracts the (padLeft, padTop, cropW, cropH)
  // sub-rectangle back out of this output — the pad geometry must survive.
  const frontPlate = await editWithGrok(fillPrompt, fillRefs, { aspectRatio: presetName, model: GROK_MODELS.STANDARD, padInput: true, skipOutputCrop: true });
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
  const frontPlateRawBuf = Buffer.from(stripDataUriPrefix(frontPlate.imageData), 'base64');
  // Uniform scaling — pad with white instead of stretching when Grok's
  // output aspect drifts from the requested padded aspect (common when
  // Grok coerces a 9:20 ask into 1:1 or similar). fit: 'contain' preserves
  // proportions, pads to exact paddedW×paddedH so the extract step still
  // works. Without this, characters near the edges came back stretched
  // before they were cropped back out.
  const grokAtCrop = await sharp(frontPlateRawBuf)
    .resize(paddedW, paddedH, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
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
    // Uniform single scale factor — never separate x/y. Non-uniform stretch
    // (the old fit: 'fill' here) was the visible distortion in step 2c: a
    // narrow silhouette + wide Grok output → stretched character. Pick min
    // ratio so the content fits inside the silhouette box, then center.
    const scale = Math.min(inBoxW / outBoxW, inBoxH / outBoxH);
    const scaledW = Math.max(1, Math.round(outBoxW * scale));
    const scaledH = Math.max(1, Math.round(outBoxH * scale));
    const contentScaled = await sharp(contentRgb, { raw: { width: outBoxW, height: outBoxH, channels: 3 } })
      .resize(scaledW, scaledH, { fit: 'inside' })
      .raw()
      .toBuffer();
    alignedRgb = Buffer.alloc(cropW * cropH * 3, 255);
    const offX = inMinX + Math.floor((inBoxW - scaledW) / 2);
    const offY = inMinY + Math.floor((inBoxH - scaledH) / 2);
    for (let y = 0; y < scaledH; y++) {
      for (let x = 0; x < scaledW; x++) {
        const srcI = (y * scaledW + x) * 3;
        const dstI = ((offY + y) * cropW + (offX + x)) * 3;
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
  const emptySceneRawBuf = Buffer.from(stripDataUriPrefix(emptySceneData), 'base64');
  // Uniform scaling — when Grok's anchor-plate output aspect drifts from
  // the empty-scene aspect (rare but happens with the input-coerce edge),
  // fit: 'contain' preserves proportions and pads to canvasW×canvasH so the
  // downstream raw-buffer diff still indexes correctly. White pad bg keeps
  // the foreground-mask diff threshold consistent.
  const emptyScaledPng = await sharp(emptySceneRawBuf)
    .resize(canvasW, canvasH, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
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
  blendPastedCanvas,
  buildBlendEditPrompt,
  buildBlendMetadata,
  POSE_CELL,
  FACE_CELL,
  DEFAULT_PALETTE,
  cropAvatarCell,
  // internal helpers exposed for tests
  _internal: {
    findColorBbox,
    findSilhouettesByDiff,
    subtractFiguresInFront,
    buildPlateHeadRatio,
    sizeFigure,
    buildAgeTargets,
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
