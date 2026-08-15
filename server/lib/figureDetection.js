/**
 * Local Grounded-SAM figure detection — GroundingDINO → MobileSAM.
 *
 * Split out of images.js 2026-08-09. Selected by
 * MODEL_DEFAULTS.figureDetectionBackend === 'grounding-dino', it is the local
 * alternative to the Gemini bbox: stage 1 turns each character's identity prose
 * into a box, stage 2 turns the box into a tight silhouette. Fully local, no
 * external API.
 *
 * Reached from images.js only through _detectAllBoundingBoxesImpl, plus
 * detectPersonBoxInCrop / recoverFaceBox used by the repair paths. The
 * per-figure masks power the overlap guard, which is why the mask helpers live
 * here rather than in imageCompositing: they exist to judge detections, not to
 * blend pixels.
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');
const r2Lib = require('./r2');
const { photoAnalyzerUrl: _photoAnalyzerUrl, withAnalyzerSlot } = require('./photoAnalyzerClient');
const { getCurrentLogger } = require('./generationLogger');

const getStoryHelpers = () => require('./storyHelpers');

// Job id for runtime metric counters (runMetrics): the styled-avatar cache
// scope IS the jobId (== storyId) inside a full-mode story pipeline run;
// undefined outside one (admin tools, Test Lab) → forJob() no-ops. Same lazy
// require generationLogger._getScope uses (dodges the styledAvatars ⇄ images
// boot-order cycle). Trial jobs scope as `trial-${userId}` and are not counted.
const _metricsJobId = () => require('./styledAvatars')._cacheContext?.getStore?.();

/**
 * Short visible-garment phrase from a clothing description, for grounding /
 * SoM identity lines. Handles both shapes clothing strings come in:
 *   structured — "headwear: none; top: red striped shirt under a vest; …"
 *                → the `top:` value (else first non-"none" value)
 *   plain prose — "Pink long-sleeved t-shirt, dark jeans, sandals"
 *                → the first clause
 * Word-boundary capped; "key: none" segments never leak.
 */
function _shortGarmentPhrase(clothing, maxLen = 60) {
  if (!clothing) return '';
  const s = String(clothing).trim();
  let phrase = '';
  const segments = s.split(';').map(seg => seg.trim()).filter(Boolean);
  const keyed = segments
    .map(seg => { const m = seg.match(/^([a-z][a-z/ -]{2,20}):\s*(.+)$/i); return m ? { key: m[1].toLowerCase(), value: m[2].trim() } : null; })
    .filter(Boolean)
    .filter(kv => kv.value && !/^none$/i.test(kv.value));
  if (keyed.length > 0) {
    phrase = (keyed.find(kv => kv.key === 'top') || keyed[0]).value;
  } else {
    phrase = s.split(/[.;]/)[0].trim();
  }
  // First clause of the chosen phrase, word-boundary cap.
  phrase = phrase.split(/[,.]/)[0].trim();
  if (phrase.length > maxLen) phrase = phrase.slice(0, maxLen).replace(/\s+\S*$/, '');
  // No dangling connectives/articles after the cap ("…rolled sleeves under",
  // "…lacing at the") — strip repeatedly since they stack.
  let prev;
  do { prev = phrase; phrase = phrase.replace(/\s+(under|over|with|and|on|in|at|of|the|a|an)$/i, ''); } while (phrase !== prev);
  return phrase;
}


// ── Local Grounded-SAM figure detection (GroundingDINO → MobileSAM) ──
// Alternative to the Gemini bbox, selected by MODEL_DEFAULTS.figureDetectionBackend
// === 'grounding-dino'. Stage 1: /detect-figures-text (GroundingDINO) turns each
// character's full-identity prose into a box. Stage 2: /figure-mask (MobileSAM)
// turns the box into the tight silhouette; bodyBox = silhouette bounds. The
// per-figure masks power the overlap guard (mask overlap, not box overlap — two
// adjacent standing figures have overlapping boxes but disjoint masks). Fallback
// on a collision: retry-in-DINO (local) → return null → today's Gemini 2-pass
// bbox. Fully local; no external API anywhere.
const GDINO_OVERLAP_THRESHOLD = 0.30;   // overlapFrac ≥ this → collision
const GDINO_SAME_FIGURE = 0.95;         // ≈ 100% → both prompts hit the same person
const GDINO_LOW_CONFIDENCE = 0.45;      // DINO score below this → unreliable

function _pxBoxToNorm(box, W, H) {
  const [x1, y1, x2, y2] = box;
  return [
    Math.max(0, Math.min(1, y1 / H)),
    Math.max(0, Math.min(1, x1 / W)),
    Math.max(0, Math.min(1, y2 / H)),
    Math.max(0, Math.min(1, x2 / W)),
  ];
}

// Occlusion is resolved JOINTLY, not per figure (owner, 2026-08-15).
//
// Measured on job_1786780194082_s980g4s9a p-2 with a local MobileSAM replay ($0):
//
//   Emma's box-only mask                 94,121 px - and it covers 97% of
//                                        DANIEL'S head zone: her silhouette
//                                        swallowed the man behind her.
//   -> subtracting her from him          deletes HIS OWN head.
//   -> erasing her to white first        SAM segments the white hole; face gone.
//
//   box + POSITIVE on own face
//       + NEGATIVE on each other face    leak into his head: 97% -> 5.6%
//
// Solving N figures independently and patching the conflicts afterwards is what
// produced every one of those failures, so the page is now solved as ONE
// assignment: each pixel belongs to at most one person.
//
// DEPTH comes from geometry. People stand on a ground plane, so the LOWER a
// figure's box ends, the nearer it is. On that page:
//   Noah 1191 > Emma 1178 > Daniel 1169 > Sarah 1122 > Hans 1117
// which correctly puts BOTH Emma and Noah in front of Daniel - the old
// containment test caught only Emma (Noah overlaps him ~50%), which is exactly
// why Noah's sandal leaked into Daniel's cut-out, and the old mask-AREA rule got
// it backwards (Daniel's mask is smaller than Noah's, yet he is behind).
//
// Caveat: this assumes a common ground plane. Right for standing/crouching
// figures in story illustrations; a figure sitting on a wall or shot from above
// can invert it, so near-equal bottoms fall back to box containment.
const SAM_FRONT_CONTAINMENT = 0.80;   // tie-break when two boxes end at the same height
const SAM_GROUND_TIE_PX = 12;         // bottoms within this are "the same height"
const SAM_FACE_IN_MASK = 0.10;        // a mask must cover this much of its OWN face box
const SAM_FACE_CONTAINMENT = 0.70;    // a face this far inside a person box belongs to it

// Garment-colour seed points (owner, 2026-08-15).
//
// A single positive point on the face UNDER-SEGMENTS a figure wearing several
// garments: SAM reads blouse, skirt and skin as separate objects and returns
// only some of them. Measured on p-2 of job_1786780194082_s980g4s9a:
//
//   Sarah  face only 38,107 px -> + one dot on her white blouse  73,828 px  (+94%)
//   Noah   face only 73,113 px -> + shirt and shorts dots        80,761 px  (+10%)
//
// (For scale, Emma - a small child - masks at 91,886 px, so Sarah the adult at
// 38k was missing half of herself.)
//
// We already know what each character wears, so the colour words come from the
// identity line the detection call is given, and the dots are placed on pixels
// that actually match. Ordering rules, from the owner:
//   - the top dot must be BELOW the head
//   - the bottom dot must be BELOW the top dot
// Both are SEARCH CONSTRAINTS, not filters applied afterwards: grey is a
// background colour, and the largest grey blob in a whole figure box is river
// water, not the garment.
const GARMENT_TOP = /\b(shirt|t-?shirt|top|blouse|polo|sweater|jumper|pullover|hoodie|dress|tunic|vest|jacket|coat)\b/;
const GARMENT_BOTTOM = /\b(shorts|trousers|pants|skirt|jeans|chinos|leggings|dungarees)\b/;
// Neutral colours are the colour of pavement, stone, water and sky, so a
// BOTTOM-garment dot on one lands on the ground far more often than on the
// garment: Daniel's grey shorts are 134 px visible here, while the grey
// pavement blob below him is 33,578 px and wins on every ranking. Tops sit
// higher up where this does not happen (Sarah's white blouse is the single
// biggest win of this whole feature), so the guard applies to bottoms only.
const NEUTRAL_COLOURS = new Set(['grey', 'gray', 'white', 'black', 'beige', 'cream',
  'ivory', 'silver', 'khaki', 'tan']);
const DOT_MIN_PX = 400;          // smaller than this is not a garment
const DOT_DELTA_E = 30;          // how close a pixel must be to the named colour
const DOT_MAX_PER_GARMENT = 3;   // a garment split by an occluder still resolves
const DOT_BAND = 0.20;           // an extra piece must be in the main piece's band
const DOT_MIN_FRAC = 0.20;       // ...and be a real piece, not a speck

/** Colour word for the top and the bottom garment, from an identity line. */
function _garmentColourWords(description) {
  const text = String(description || '').toLowerCase();
  const wearing = text.includes('wearing:') ? text.split('wearing:')[1] : text;
  const out = { top: null, bottom: null };
  for (const clause of wearing.split(/[,;.]| and /)) {
    const isTop = GARMENT_TOP.test(clause), isBottom = GARMENT_BOTTOM.test(clause);
    if (!isTop && !isBottom) continue;
    for (const word of clause.split(/[\s/-]+/)) {
      const c = getGarmentColour().resolveColourName(word);
      if (!c) continue;
      if (isBottom && !out.bottom) out.bottom = c.name;
      else if (isTop && !out.top) out.top = c.name;
      break;
    }
  }
  return out;
}

/**
 * Centroids of the blobs inside `box`, below `yMin`, matching colour `name`.
 * Largest first, capped, and every extra piece must belong to the same garment
 * as the first (same horizontal band, comparable size) - without that, Sarah's
 * white SHOES and Noah's blue SANDAL were seeded as "shirt".
 */
function _colourSeedPoints(rgb, W, H, box, name, yMin) {
  const ref = getGarmentColour().resolveColourName(name);
  if (!ref) return [];
  const x0 = box[0], x1 = box[2], y1 = box[3];
  const y0 = Math.max(box[1], Math.round(yMin ?? box[1]));
  if (y0 >= y1) return [];
  const hit = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 3;
      if (_deltaE(_rgbToLabPx(rgb[o], rgb[o + 1], rgb[o + 2]), ref.lab) <= DOT_DELTA_E) hit[y * W + x] = 1;
    }
  }
  const lab = new Int32Array(W * H); let n = 0; const blobs = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    if (!hit[i] || lab[i]) continue;
    n++; let a = 0, sx = 0, sy = 0; const st = [i]; lab[i] = n;
    while (st.length) {
      const k = st.pop(); a++; const kx = k % W, ky = (k / W) | 0; sx += kx; sy += ky;
      if (kx > x0 && hit[k - 1] && !lab[k - 1]) { lab[k - 1] = n; st.push(k - 1); }
      if (kx < x1 - 1 && hit[k + 1] && !lab[k + 1]) { lab[k + 1] = n; st.push(k + 1); }
      if (ky > y0 && hit[k - W] && !lab[k - W]) { lab[k - W] = n; st.push(k - W); }
      if (ky < y1 - 1 && hit[k + W] && !lab[k + W]) { lab[k + W] = n; st.push(k + W); }
    }
    if (a >= DOT_MIN_PX) blobs.push({ a, cx: Math.round(sx / a), cy: Math.round(sy / a) });
  }
  blobs.sort((p, q) => q.a - p.a);
  const bandPx = Math.round(DOT_BAND * (box[3] - box[1]));
  return blobs
    .filter((b, i) => i === 0 || (Math.abs(b.cy - blobs[0].cy) <= bandPx && b.a >= DOT_MIN_FRAC * blobs[0].a))
    .slice(0, DOT_MAX_PER_GARMENT);
}

// Local Lab conversion (the garment module's is not exported).
function _rgbToLabPx(r, g, b) {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? ((R + 0.055) / 1.055) ** 2.4 : R / 12.92;
  G = G > 0.04045 ? ((G + 0.055) / 1.055) ** 2.4 : G / 12.92;
  B = B > 0.04045 ? ((B + 0.055) / 1.055) ** 2.4 : B / 12.92;
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (v) => v > 0.008856 ? Math.cbrt(v) : (7.787 * v + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const _deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const getGarmentColour = () => require('./garmentColourFix');

// A detected face with no person box is a MISSING FIGURE (owner, 2026-08-15).
//
// On job_1786780194082_s980g4s9a p-2 GroundingDINO returned FIVE faces and only
// FOUR persons. The unpaired one is Daniel, the crouching man behind Emma, and
// his face scored 0.528 - the HIGHEST on the page, above Hans standing in full
// view. Face detection never had trouble with him; the generic "person" query
// simply never proposed a box, so the whole figure was lost and the identity
// pass had no body to attach his name to.
//
// The box does NOT need to be tight. SAM is prompted with the figure's own face
// as a positive and every other face as a negative, and the depth pass then
// takes back whatever belongs to figures in front - so a generous box that
// CONTAINS the person is enough. Measured on that face, box + points:
//   w3.0 h6.5 t0.25 -> [194,388,410,1194] -> 29,744 px   <- chosen
//   w4.0 h5.0 t0.30 -> [158,383,446,1038] -> 12,304 px   cuts him off
//   w2.5 h4.0 t0.20 -> [212,393,392, 934] -> 13,159 px   cuts him off
// For reference the Gemini second-opinion box gave 30,464 px, so the
// synthesised box reproduces it to within 2.4%.
const FACE_TO_BODY_W = 3.0;    // shoulders+arms, in face widths
const FACE_TO_BODY_H = 6.5;    // body below the chin, in face heights
const FACE_TO_BODY_TOP = 0.25; // headroom above the face box

function _personBoxFromFace(faceBox, W, H) {
  const [x1, y1, x2, y2] = faceBox;
  const fw = x2 - x1, fh = y2 - y1;
  if (!(fw > 0 && fh > 0)) return null;
  const cx = Math.round((x1 + x2) / 2);
  const halfW = Math.round((FACE_TO_BODY_W * fw) / 2);
  return [
    Math.max(0, cx - halfW),
    Math.max(0, Math.round(y1 - FACE_TO_BODY_TOP * fh)),
    Math.min(W, cx + halfW),
    Math.min(H, Math.round(y2 + FACE_TO_BODY_H * fh)),
  ];
}

function _boxAreaPx(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }

// Fraction of `inner` that lies inside `outer` (both [x1,y1,x2,y2] px).
function _boxContainment(inner, outer) {
  const ix = Math.max(0, Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0]));
  const iy = Math.max(0, Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]));
  const a = _boxAreaPx(inner);
  return a > 0 ? (ix * iy) / a : 0;
}

// Which face box belongs to which person box: the SMALLEST person box that
// contains it wins. A face inside both a child's box and the enclosing box of
// the adult behind her belongs to the child; the adult's own face is inside his
// box and outside hers. Index-aligned with boxesPx; null where no face fits.
function _assignFacesToBoxes(boxesPx, faceBoxesPx) {
  const out = new Array(boxesPx.length).fill(null);
  for (const fb of (faceBoxesPx || [])) {
    if (!Array.isArray(fb) || fb.length !== 4) continue;
    let best = -1, bestArea = Infinity;
    for (let i = 0; i < boxesPx.length; i++) {
      const b = boxesPx[i];
      if (!Array.isArray(b) || b.length !== 4) continue;
      if (_boxContainment(fb, b) < SAM_FACE_CONTAINMENT) continue;
      const a = _boxAreaPx(b);
      if (a < bestArea) { bestArea = a; best = i; }
    }
    if (best >= 0 && !out[best]) out[best] = fb;
  }
  return out;
}

const _boxCentre = (b) => [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)];

/**
 * Box -> silhouette for a WHOLE PAGE, as one joint assignment.
 *
 * The ONE place boxes become masks, shared by the DINO path (Stage 2) and the
 * Gemini second-opinion path (attachSamMasksToFigures) - the page that exposed
 * this bug ran through the SECOND one, so a fix in either alone is no fix.
 *
 * Boxes are px [x1,y1,x2,y2]; the result is index-aligned with the input.
 * Each entry: {box, mask, keptBox, coverage, verdict, occluded, occludedByIdx,
 *              pxLostToFront, maskPx}
 */
async function _maskBoxesFrontFirst(imageDataUri, boxesPx, W, H, pageLabel = '', faceBoxesPx = null, descriptions = null) {
  const faces = _assignFacesToBoxes(boxesPx, faceBoxesPx);
  const n = boxesPx.length;
  const out = new Array(n);
  // Raw pixels once, for the garment-colour seed points.
  let rgb = null;
  if (descriptions) {
    try {
      const buf = Buffer.from(r2Lib.stripDataUriPrefix(imageDataUri), 'base64');
      rgb = (await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    } catch (e) { log.warn(`⚠️ [SAM] ${pageLabel}garment seeds unavailable (${e.message})`); }
  }

  // --- 1. one SAM call per figure, told WHICH figure it is looking at --------
  // Order does not matter here: conflicts are settled in step 3, so no figure
  // depends on another having been masked first.
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    const box = boxesPx[i];
    if (!Array.isArray(box) || box.length !== 4) continue;
    const own = faces[i];
    const points = [], labels = [];
    let seeds = 0;
    if (own) {
      points.push(_boxCentre(own)); labels.push(1);
      // Garment seeds. The stored faceBox is NOT a tight face - it runs to the
      // chest - so its CENTRE is the usable "the head is here" reference; its
      // bottom edge would reject every real top dot.
      if (rgb && descriptions && descriptions[i]) {
        const { top, bottom } = _garmentColourWords(descriptions[i]);
        const headRef = Math.round((own[1] + own[3]) / 2);
        let topY = null;
        if (top) {
          for (const b of _colourSeedPoints(rgb, W, H, box, top, headRef)) {
            points.push([b.cx, b.cy]); labels.push(1); seeds++;
            if (topY === null) topY = b.cy;   // order against the MAIN piece
          }
        }
        // Bottoms only when the colour is not the colour of the ground.
        if (bottom && topY !== null && !NEUTRAL_COLOURS.has(bottom)) {
          for (const b of _colourSeedPoints(rgb, W, H, box, bottom, topY)) {
            points.push([b.cx, b.cy]); labels.push(1); seeds++;
          }
        }
      }
      for (let j = 0; j < n; j++) {
        if (j === i || !faces[j]) continue;
        const c = _boxCentre(faces[j]);
        if (c[0] >= box[0] && c[0] <= box[2] && c[1] >= box[1] && c[1] <= box[3]) {
          points.push(c); labels.push(0);
        }
      }
    }
    if (seeds) log.debug(`[SAM] ${pageLabel}figure ${i}: ${seeds} garment seed point(s)`);
    const m = await _mobilesamMaskFull(imageDataUri, box, W, H,
      points.length ? points : null, points.length ? labels : null);
    if (!m) continue;
    // Drop components outside the box (neighbour-grab / degraded-analyzer
    // garbage). No coverage floor here: an occluded figure is legitimately
    // small, and step 4 judges it on its FACE instead.
    const r = await _cleanMaskAndCheck(m, box, { minCoverage: 0 });
    if (r.keptBox) raw[i] = { mask: m, separated: points.length > 1, seeds };
  }

  // --- 2. depth order: lower box bottom = nearer the camera ------------------
  const depth = [];
  for (let i = 0; i < n; i++) if (raw[i]) depth.push(i);
  depth.sort((a, b) => {
    const ba = boxesPx[a][3], bb = boxesPx[b][3];
    if (Math.abs(ba - bb) > SAM_GROUND_TIE_PX) return bb - ba;      // lower bottom first
    // Same height: the box CONTAINED by the other is the one in front.
    const aInB = _boxContainment(boxesPx[a], boxesPx[b]);
    const bInA = _boxContainment(boxesPx[b], boxesPx[a]);
    if (aInB >= SAM_FRONT_CONTAINMENT && aInB > bInA) return -1;
    if (bInA >= SAM_FRONT_CONTAINMENT && bInA > aInB) return 1;
    return _boxAreaPx(a) - _boxAreaPx(b);
  });

  // --- 3. winner-take-all: a pixel belongs to the FRONTMOST claimant ---------
  // This replaces pairwise dilated subtraction. Nothing is dilated, so no seam
  // fringe is created and no speckle filter is needed to clean one up.
  const owner = new Int32Array(W * H);   // 0 = unclaimed, else figureIndex + 1
  for (const i of depth) {
    const alpha = raw[i].mask.alpha;
    const lost = new Map();              // ownerIdx -> px taken from this figure
    let kept = 0;
    for (let k = 0; k < W * H; k++) {
      if (!alpha[k]) continue;
      const o = owner[k];
      if (o) { alpha[k] = 0; lost.set(o - 1, (lost.get(o - 1) || 0) + 1); }
      else { owner[k] = i + 1; kept++; }
    }
    raw[i].kept = kept;
    raw[i].lost = lost;
  }

  // --- 4. accept on the FACE, not on how much of the box is filled -----------
  // The old coverage floor threw away Daniel's real mask at 0.228 and left him
  // with no cut-out at all. "Does this silhouette contain its own face?" is the
  // question that actually identifies a figure, however little of it shows.
  for (let i = 0; i < n; i++) {
    const box = boxesPx[i];
    const base = {
      box, mask: null, keptBox: null, coverage: null, verdict: 'no-mask',
      occluded: false, occludedByIdx: [], pxLostToFront: 0, maskPx: 0,
    };
    if (!raw[i]) { out[i] = base; continue; }
    const { mask, separated, kept, lost, seeds } = raw[i];
    const pxLost = [...lost.values()].reduce((a, b) => a + b, 0);
    const occludedByIdx = [...lost.keys()].filter(k => lost.get(k) > 0);

    if (!kept) {
      out[i] = { ...base, verdict: 'rejected-fully-occluded', pxLostToFront: pxLost, occludedByIdx, occluded: true };
      continue;
    }
    // recompute bounds after the assignment
    const r = await _cleanMaskAndCheck(mask, box, { minCoverage: 0 });
    const face = faces[i];
    let faceCover = null;
    if (face) {
      let inFace = 0, tot = 0;
      for (let y = Math.max(0, face[1]); y < Math.min(H, face[3]); y++) {
        for (let x = Math.max(0, face[0]); x < Math.min(W, face[2]); x++) {
          tot++; if (mask.alpha[y * W + x]) inFace++;
        }
      }
      faceCover = tot ? inFace / tot : 0;
    }
    const ok = face ? faceCover >= SAM_FACE_IN_MASK : !!r.keptBox;
    if (!ok || !r.keptBox) {
      log.debug(`[SAM] ${pageLabel}figure ${i}: mask covers only ${((faceCover ?? 0) * 100).toFixed(1)}% of its own face — keeping the box`);
      out[i] = { ...base, verdict: 'rejected-not-its-face', pxLostToFront: pxLost, occludedByIdx, occluded: occludedByIdx.length > 0 };
      continue;
    }
    mask.pngBuf = await _maskToPng(mask);   // the cutout strip reads this
    out[i] = {
      box, mask, keptBox: r.keptBox,
      coverage: +r.coverage.toFixed(3),
      verdict: occludedByIdx.length ? 'mask-ok-occluded'
        : separated ? 'mask-ok-face-separated' : 'mask-ok',
      occluded: occludedByIdx.length > 0,
      occludedByIdx, pxLostToFront: pxLost, maskPx: kept, garmentSeeds: seeds || 0,
    };
  }
  return out;
}

// Decode the MobileSAM mask PNG (figure at alpha=255 on transparent) to a
// {alpha:Uint8Array(0/1), width, height, area, bbox:[x1,y1,x2,y2]} at W×H.
async function _binMaskFromBuffer(buf, W, H) {
  try {
    const { data } = await sharp(buf).resize(W, H, { fit: 'fill' })
      .ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    const bin = new Uint8Array(W * H);
    let area = 0, minx = W, miny = H, maxx = -1, maxy = -1;
    for (let i = 0; i < W * H; i++) {
      if (data[i] > 128) {
        bin[i] = 1; area++;
        const x = i % W, y = (i / W) | 0;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
    }
    if (area === 0) return null;
    return { alpha: bin, width: W, height: H, area, bbox: [minx, miny, maxx + 1, maxy + 1] };
  } catch { return null; }
}

// Clip a box-prompted SAM mask to its DINO box. The DINO box is the accurate
// figure extent; SAM refines it to a silhouette. A DISCONNECTED mask is NOT an
// error — an occluded figure (another figure or a prop in front) is correctly
// segmented into pieces that all sit INSIDE its box. The only real failure is a
// piece that lands OUTSIDE the box (SAM grabbed a neighbour, or a degraded
// analyzer returned garbage). Rule (user 2026-07-20): KEEP every component that
// is mostly inside the DINO box (occlusion included); DROP components mostly
// outside it. Mutates the mask to the kept (inside) components and returns
// { keptBox, droppedOutside, coverage }. keptBox === null → nothing usable inside
// the box, so the caller keeps the tight DINO box as the bodyBox.
//
// A kept mask must also FILL a meaningful share of the DINO box. Measured on
// exp #314 (three pages, 19 figures, healthy analyzer): every real silhouette
// covers 62-99% of its box. The two known failures — a story run against an
// analyzer serving stale SAM embeddings (fixed in ff1ed9aa) — produced kept
// fragments at 1.6% and 1.7%: a sliver of an adult's vest, and the pumpkin
// standing next to a boy. Both were accepted as `mask-ok` and became the
// figure's bodyBox. Falling back to the tight DINO box costs nothing (it is
// the pre-SAM truth), so the floor sits far below any real silhouette.
const SAM_MIN_BOX_COVERAGE = 0.25;

async function _cleanMaskAndCheck(mask, gdinoBoxPx, opts = {}) {
  // The floor is overridable so Stage 2b can re-check a mask it deliberately
  // shrank: after an enclosed neighbour is subtracted, low coverage is the
  // expected outcome, not the stale-embedding symptom the default guards.
  const minCoverage = opts.minCoverage ?? SAM_MIN_BOX_COVERAGE;
  const { alpha, width: W, height: H } = mask;
  const lab = new Int32Array(W * H); let n = 0; const comps = [];
  for (let i = 0; i < W * H; i++) {
    if (!alpha[i] || lab[i]) continue;
    n++; let area = 0, minx = W, miny = H, maxx = -1, maxy = -1; const st = [i]; lab[i] = n;
    while (st.length) {
      const k = st.pop(); area++; const x = k % W, y = (k / W) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0 && alpha[k - 1] && !lab[k - 1]) { lab[k - 1] = n; st.push(k - 1); }
      if (x < W - 1 && alpha[k + 1] && !lab[k + 1]) { lab[k + 1] = n; st.push(k + 1); }
      if (y > 0 && alpha[k - W] && !lab[k - W]) { lab[k - W] = n; st.push(k - W); }
      if (y < H - 1 && alpha[k + W] && !lab[k + W]) { lab[k + W] = n; st.push(k + W); }
    }
    comps.push({ label: n, area, bbox: [minx, miny, maxx + 1, maxy + 1] });
  }
  if (!comps.length) return { keptBox: null, droppedOutside: 0, coverage: 0 };
  // Fraction of a component's bbox area that overlaps the DINO box, with a small
  // tolerance so a figure that legitimately overhangs the tight box a little is
  // still "inside". The tolerance is PER AXIS: deriving one tolerance from
  // max(width, height) inflated the short axis by a fraction of the long one, so
  // a tall narrow person box (253x733 px) got 88 px of horizontal slack instead
  // of 30 — wide enough to swallow a prop standing entirely beside the figure.
  const [bx0, by0, bx1, by1] = gdinoBoxPx;
  const tolX = 0.12 * (bx1 - bx0);
  const tolY = 0.12 * (by1 - by0);
  const fracInside = (b) => {
    const ix = Math.max(0, Math.min(b[2], bx1 + tolX) - Math.max(b[0], bx0 - tolX));
    const iy = Math.max(0, Math.min(b[3], by1 + tolY) - Math.max(b[1], by0 - tolY));
    const a = (b[2] - b[0]) * (b[3] - b[1]);
    return a > 0 ? (ix * iy) / a : 0;
  };
  const drop = new Set(); const kept = []; let droppedOutside = 0;
  for (const c of comps) {
    if (fracInside(c.bbox) >= 0.5) kept.push(c);
    else { drop.add(c.label); if (c.area > 50) droppedOutside++; }  // >50px = a real outside piece, not a speck
  }
  if (!kept.length) return { keptBox: null, droppedOutside, coverage: 0 };  // all outside → use the DINO box
  let mnx = W, mny = H, mxx = -1, mxy = -1;
  for (const c of kept) { mnx = Math.min(mnx, c.bbox[0]); mny = Math.min(mny, c.bbox[1]); mxx = Math.max(mxx, c.bbox[2]); mxy = Math.max(mxy, c.bbox[3]); }
  // Coverage of the DINO box by the kept extent, measured the same way the
  // boxes themselves are compared (bbox area, not silhouette pixel count) so
  // the threshold reads directly against the numbers in a lab detection entry.
  const boxArea = Math.max(1, (bx1 - bx0) * (by1 - by0));
  const coverage = ((mxx - mnx) * (mxy - mny)) / boxArea;
  if (coverage < SAM_MIN_BOX_COVERAGE) {
    // Do NOT mutate the mask — the caller drops it wholesale and keeps the box.
    return { keptBox: null, droppedOutside, coverage };
  }
  if (drop.size) {
    for (let i = 0; i < W * H; i++) if (alpha[i] && drop.has(lab[i])) alpha[i] = 0;
  }
  mask.bbox = [mnx, mny, mxx, mxy]; mask.area = kept.reduce((s, c) => s + c.area, 0);
  if (drop.size) mask.pngBuf = await _maskToPng(mask);
  return { keptBox: mask.bbox, droppedOutside, coverage };
}

// GroundingDINO text→box for a set of prompts.
async function _gdinoDetect(imageDataUri, prompts) {
  const _t0 = Date.now();
  try {
    const res = await withAnalyzerSlot(() => fetch(`${_photoAnalyzerUrl()}/detect-figures-text`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUri, prompts }),
      // The first call after a cold start (or post-idle-unload) pays the ~90s
      // model load on top of one forward pass per character; 180s wasn't enough
      // for a 4-5 char page and the endpoint's completed work was abandoned for
      // a spurious Gemini fallback. 300s covers cold load + passes; warm calls
      // finish in ~60-100s. Genuine hangs still fall back to Gemini after this.
      signal: AbortSignal.timeout(300_000),
    }));
    if (!res.ok) { log.warn(`⚠️ [GDINO-DETECT] /detect-figures-text HTTP ${res.status}`); return null; }
    const j = await res.json();
    if (!j?.success) { log.warn(`⚠️ [GDINO-DETECT] endpoint error: ${j?.error}`); return null; }
    return j;
  } catch (e) { log.warn(`⚠️ [GDINO-DETECT] detect failed: ${e.message}`); require('./runMetrics').forJob(_metricsJobId()).count('dino_detect_fail'); return null; }
  finally {
    // Reliable wall-clock split DINO vs SAM (owner, 2026-08-10): counters per
    // story run, readable from runMetrics after any generation.
    const m = require('./runMetrics').forJob(_metricsJobId());
    m.count('dino_calls'); m.add('dino_ms', Date.now() - _t0);
  }
}

// MobileSAM box→mask on the full page (box in full-page pixel coords).
// `points` / `labels` (1 = "this figure", 0 = "NOT this figure") refine the box:
// a box around a figure standing behind another necessarily contains the front
// figure, and box-only SAM then returns the wrong person. See SAM_FRONT_* .
async function _mobilesamMaskFull(imageDataUri, boxPx, W, H, points = null, labels = null) {
  const _t0 = Date.now();
  try {
    // Through withAnalyzerSlot like every other analyzer call (gdinoDetect, the
    // repair-side figure-mask). This one had used a raw fetch, so a story's
    // repair phase fired unbounded concurrent masks at the analyzer; the server
    // now serializes SAM under a lock, and this bounds the in-flight queue so
    // callers don't pile up decoded pages waiting on that lock.
    const res = await withAnalyzerSlot(() => fetch(`${_photoAnalyzerUrl()}/figure-mask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(points && points.length
        ? { image: imageDataUri, box: boxPx, points, point_labels: labels }
        : { image: imageDataUri, box: boxPx }),
      // 150s: an aborted request does NOT cancel the analyzer's computation —
      // short timeouts under CPU contention stack zombie work until the
      // service starves (observed SAM outage). Waiting beats re-firing.
      signal: AbortSignal.timeout(150_000),
    }));
    if (!res.ok) return null;
    const j = await res.json();
    const m = j?.image?.match?.(/^data:image\/\w+;base64,(.+)$/);
    if (!j?.success || !m || !(j.fill_pixels > 0)) return null;
    const pngBuf = Buffer.from(m[1], 'base64');
    const mask = await _binMaskFromBuffer(pngBuf, W, H);
    if (mask) mask.pngBuf = pngBuf; // kept for the overlay's cutout strip (never persisted)
    return mask;
  } catch (e) { log.warn(`⚠️ [GDINO-DETECT] mask failed: ${e.message}`); require('./runMetrics').forJob(_metricsJobId()).count('dino_mask_fail'); return null; }
  finally {
    const m = require('./runMetrics').forJob(_metricsJobId());
    m.count('sam_calls'); m.add('sam_ms', Date.now() - _t0);
  }
}

/**
 * Fresh figure box on a CROP via GroundingDINO 'person' — used to re-detect the
 * repainted figure on Qwen's output (round-2) instead of reusing the original
 * box, so the head mask is segmented against a box aligned to the ACTUAL new
 * figure. Returns the largest person box [x1,y1,x2,y2] in crop px, or null
 * (caller falls back to the copied box). cropJpegBuffer is the crop image.
 */
async function detectPersonBoxInCrop(cropJpegBuffer, faceBoxInCrop = null, pageLabel = '') {
  try {
    const uri = `data:image/jpeg;base64,${cropJpegBuffer.toString('base64')}`;
    const det = await _gdinoDetect(uri, [{ name: 'person', text: 'person' }]);
    if (!det?.figures?.[0]) return null;
    const persons = _collectNmsBoxes(det.figures[0], GDINO_PERSON_NMS_IOU);
    if (!persons.length) return null;
    // The crop often contains OTHER people (neighbours in the scene). Pick the
    // person whose box overlaps the FACE box (the target head) the most — NOT
    // the largest, which is frequently a bigger adjacent figure (exp: monk /
    // green-dress woman picked instead of Verena → IoU 0%). Fall back to largest.
    let pick;
    if (faceBoxInCrop?.length === 4) {
      // Require the face box's CENTER to lie inside the person box — the crop
      // often contains bigger neighbours, and mere edge-overlap isn't enough to
      // trust it's the target. If no detected person contains the face, return
      // null so the caller keeps the copied original box (correct) rather than
      // masking a neighbour (exp #129: monk picked → IoU 0%).
      const fcx = (faceBoxInCrop[0] + faceBoxInCrop[2]) / 2, fcy = (faceBoxInCrop[1] + faceBoxInCrop[3]) / 2;
      const containing = persons.filter(p => fcx >= p.box[0] && fcx < p.box[2] && fcy >= p.box[1] && fcy < p.box[3]);
      if (!containing.length) {
        log.info(`🔎 [GDINO-DETECT] ${pageLabel}round-2 re-detect: no person contains the face box (${persons.length} found) — keeping the copied box`);
        return null;
      }
      // smallest containing box = the target head's own figure, not an enclosing crowd
      containing.sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]));
      pick = { p: containing[0] };
    } else {
      persons.sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]));
      pick = { p: persons[0] };
    }
    log.info(`🔎 [GDINO-DETECT] ${pageLabel}round-2 person re-detect: ${persons.length} box(es), picked face-containing (score ${pick.p.score?.toFixed?.(2) ?? '?'})`);
    return pick.p.box.map(v => Math.round(v));
  } catch (e) {
    log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}round-2 person re-detect failed: ${e.message}`);
    require('./runMetrics').forJob(_metricsJobId()).count('dino_round2_fail');
    return null;
  }
}

function _maskOverlapFrac(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 0;
  let inter = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) if (a.alpha[i] && b.alpha[i]) inter++;
  return inter / Math.max(1, Math.min(a.area, b.area));
}

// DINO face boxes hug the facial features tightly; downstream face repair
// needs the full head (hair, chin, ears). Pad 100% (50% per side) around
// the center, clamped to the image. SINGLE source of truth — used by the
// full-page detection assembly AND recoverFaceBox, so a recovered face box
// is byte-identical in shape to a normally-detected one.
// Adaptive: when the raw face is already LARGE relative to its body (anime
// proportions, lying poses, close-ups) the full pad balloons the box to
// half the figure — the whiteout stops reading as "a face to fill in" and
// the edit model draws a floating portrait instead. Large faces get 40%.
function _padDinoFaceBox(facePxBox, W, H, bodyBoxNorm = null) {
  const [x1, y1, x2, y2] = facePxBox;
  let padFrac = 0.5;
  if (bodyBoxNorm?.length === 4) {
    const faceArea = ((x2 - x1) / W) * ((y2 - y1) / H);
    const bodyArea = (bodyBoxNorm[3] - bodyBoxNorm[1]) * (bodyBoxNorm[2] - bodyBoxNorm[0]);
    if (bodyArea > 0 && faceArea / bodyArea > 0.18) padFrac = 0.2;
  }
  const pw = (x2 - x1) * padFrac, ph = (y2 - y1) * padFrac;
  return _pxBoxToNorm([
    Math.max(0, x1 - pw), Math.max(0, y1 - ph),
    Math.min(W, x2 + pw), Math.min(H, y2 + ph),
  ], W, H);
}

/**
 * Face-box recovery for a figure whose full-page face detection came back
 * empty (small/distant faces): crop the KNOWN body box, upscale it, and run
 * the SAME GroundingDINO 'face' prompt + NMS + padding as full-page detection
 * — a 40px face on the full page is 150px+ in the upscaled crop, where
 * detection is reliable. Maps the best box back to page coords and pads it
 * with the shared _padDinoFaceBox rule (full head, not just facial features).
 * Returns page-normalized [ymin,xmin,ymax,xmax], or null when even the zoomed
 * crop has no detectable face (caller must then fail the face repair loudly —
 * never silently downgrade to a body repair).
 */
async function recoverFaceBox(imageDataUri, bodyBoxNorm, pageLabel = '') {
  try {
    if (!bodyBoxNorm || bodyBoxNorm.length !== 4) return null;
    const buf = Buffer.from(r2Lib.stripDataUriPrefix(imageDataUri), 'base64');
    const meta = await sharp(buf).metadata();
    const W = meta.width, H = meta.height;
    const [y0, x0, y1, x1] = bodyBoxNorm;
    const padX = (x1 - x0) * 0.10, padY = (y1 - y0) * 0.10;
    const cx = Math.max(0, Math.round((x0 - padX) * W));
    const cy = Math.max(0, Math.round((y0 - padY) * H));
    const cw = Math.min(W - cx, Math.round((x1 - x0 + 2 * padX) * W));
    const ch = Math.min(H - cy, Math.round((y1 - y0 + 2 * padY) * H));
    if (cw < 16 || ch < 16) return null;
    // Upscale small crops so the face has enough pixels for DINO.
    const scale = cw < 640 ? 640 / cw : 1;
    const sw = Math.round(cw * scale), sh = Math.round(ch * scale);
    const cropJpeg = await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch })
      .resize(sw, sh, { fit: 'fill' }).jpeg({ quality: 92 }).toBuffer();
    // Same prompts + leak filter as full-page detection: a "face" box that
    // largely coincides with a person box IS the person box (head+torso —
    // exp #70 whited out Lukas's shirt with one). Faces must also stay small
    // relative to the crop, which is the whole body plus padding.
    const det = await _gdinoDetect(`data:image/jpeg;base64,${cropJpeg.toString('base64')}`,
      [{ name: 'face', text: 'face' }, { name: 'person', text: 'person' }]);
    if (!det?.figures?.[0]) return null;
    const persons = det.figures[1] ? _collectNmsBoxes(det.figures[1], GDINO_PERSON_NMS_IOU) : [];
    const faces = _collectNmsBoxes(det.figures[0], GDINO_FACE_NMS_IOU)
      .filter(f => !persons.some(p => _boxIouXyxy(f.box, p.box) > GDINO_FACE_LEAK_IOU))
      .filter(f => (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) < 0.15 * sw * sh);
    if (faces.length === 0) return null;
    const best = faces[0].box; // px in the scaled crop, score-desc
    // Back to PAGE pixel coords, then the shared production padding.
    const pagePxBox = [
      cx + best[0] / scale, cy + best[1] / scale,
      cx + best[2] / scale, cy + best[3] / scale,
    ];
    log.info(`🔎 [GDINO-DETECT] ${pageLabel}face recovered via body-crop zoom (score ${faces[0].score?.toFixed?.(2) ?? '?'})`);
    return _padDinoFaceBox(pagePxBox, W, H, bodyBoxNorm);
  } catch (e) {
    log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}face recovery failed: ${e.message}`);
    require('./runMetrics').forJob(_metricsJobId()).count('face_recovery_fail');
    return null;
  }
}

/**
 * Set-of-Mark identity: draw letter badges (A, B, …) on the detected figures
 * and ask Gemini Flash which letter is which expected character — recognition
 * by age/gender/hair/clothing, the task vision LLMs are reliably good at.
 * Gemini returns letters only, never coordinates, so its spatial sloppiness
 * cannot corrupt the local DINO/SAM geometry.
 *
 * Returns { nameByDet: Map(detIdx → name), answers } or null (caller falls
 * back to layout+gender matching). Answers with duplicate names are invalid.
 */
async function _somIdentifyFigures(imageDataUri, dets, expectedCharacters, W, H, pageLabel = '', badgeAnchor = 'box') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || dets.length === 0) return null;
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  // More detections than letters (extreme crowd): badge the largest figures —
  // expected characters are essentially never tiny background crowd. The
  // unbadged rest stays UNKNOWN. Never bail to the layout fallback for this.
  let badgeIdx = dets.map((_, i) => i);
  if (dets.length > LETTERS.length) {
    badgeIdx = badgeIdx
      .sort((a, b) => {
        const area = (d) => (d.box[2] - d.box[0]) * (d.box[3] - d.box[1]);
        return area(dets[b]) - area(dets[a]);
      })
      .slice(0, LETTERS.length);
  }

  // Badge on the upper torso: below the face if one is paired, else at 1/4
  // of the box height — keeps the badge off the face so it can't obscure
  // the features Gemini needs.
  const badges = badgeIdx.map((detIdx, i) => {
    const d = dets[detIdx];
    const [x1, y1, x2, y2] = d.box;
    // BADGE ANCHOR (opts.badgeAnchor / BADGE_ANCHOR env, default 'box' = today).
    // 'face' takes the X from the paired face. The badge's job is to point at
    // ONE person, and a person box spanning two people has its centre in the GAP
    // between them: on job_1786737619634_d66c7bg9g p10 badge C sat between the
    // two children and badge E between the boy and the old man, and the model
    // duly swapped Emma and Noah. The paired face is the only part of the
    // detection that is reliably one person.
    const cx = (badgeAnchor === 'face' && d.face) ? (d.face.box[0] + d.face.box[2]) / 2 : (x1 + x2) / 2;
    // 0.2 x face height below the face box — just under the chin. 0.6 landed
    // mid-torso (measured at 56% down the body box on the p14 figures), far
    // enough from the face that the badge read as belonging to no one.
    const by = d.face ? Math.min(y2 - 20, d.face.box[3] + (d.face.box[3] - d.face.box[1]) * 0.2) : y1 + (y2 - y1) * 0.25;
    return { letter: LETTERS[i], detIdx, x: Math.round(cx), y: Math.round(by) };
  });
  const R = Math.max(22, Math.round(Math.min(W, H) * 0.028));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${badges.map(b =>
    `<circle cx="${b.x}" cy="${b.y}" r="${R}" fill="black" stroke="white" stroke-width="4"/>` +
    `<text x="${b.x}" y="${b.y + R * 0.38}" font-family="Arial" font-size="${Math.round(R * 1.15)}" font-weight="bold" fill="white" text-anchor="middle">${b.letter}</text>`).join('')}</svg>`;
  const sceneBuf = Buffer.from(r2Lib.stripDataUriPrefix(imageDataUri), 'base64');
  const marked = await sharp(sceneBuf).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer();

  const charLines = expectedCharacters.map(c => {
    // gdinoPrompt already ends in "wearing <garment>" (built via
    // _shortGarmentPhrase); only add clothing when it isn't there yet.
    const identity = c.gdinoPrompt || c.description || c.name;
    const garment = /\bwearing\b/i.test(identity) ? '' : _shortGarmentPhrase(c.clothing);
    // Expected position/action from the scene plan ("center-right background
    // being led away") — often the only usable cue for occluded or partially
    // visible figures whose clothing/hair the badge crop doesn't show. Hint
    // only: repairs sometimes run BECAUSE a figure was painted in the wrong
    // spot, so identity cues stay primary.
    const posHint = c.position ? ` Expected position/action (hint from the scene plan; the image may differ): ${c.position}.` : '';
    return `- ${c.name}: ${identity}.${garment ? ` Wearing: ${garment}.` : ''}${posHint}`;
  }).join('\n');
  const nBadges = badges.length;
  const nChars = expectedCharacters.length;
  const elimHint = nBadges === nChars
    ? `\nThere are exactly ${nBadges} badges and ${nChars} expected characters — assign each character to one badge, by elimination if needed. Only use "unknown" for a badge that is clearly an extra/background figure, not for an expected character you are merely less sure about (a preschooler among adults, an occluded figure — assign the best remaining match).`
    : `\nUse "unknown" only for a badge that is an extra/background figure matching none of the expected characters. If a badge is plausibly an expected character (right age band and gender) assign it rather than "unknown".`;
  const prompt = `Figures in this illustration are marked with black letter badges (${badges.map(b => b.letter).join(', ')}).
Match each letter to one of these characters by age, gender, hair, and clothing; use the expected position/action as a supporting hint only:
${charLines}${elimHint}
Answer JSON only, e.g. {"A": "name"}. Each name at most once.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inlineData: { mimeType: 'image/jpeg', data: marked.toString('base64') } },
        { text: prompt },
      ] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) { log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}SoM Gemini HTTP ${res.status}`); return null; }
  const j = await res.json();
  const text = (j?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('') || '';
  let answers;
  // Tolerate prose/fence wrapping around the JSON ("Here is the JSON…").
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  try { answers = JSON.parse(jsonMatch ? jsonMatch[0] : text); } catch { log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}SoM answer not JSON: ${text.slice(0, 120)}`); return null; }
  if (!answers || typeof answers !== 'object') return null;

  const validNames = new Set(expectedCharacters.map(c => c.name));
  const nameByDet = new Map();
  const claimed = new Set();
  for (const b of badges) {
    const raw = String(answers[b.letter] || '').trim();
    if (!raw || /^unknown$/i.test(raw)) continue;
    const name = [...validNames].find(n => n.toLowerCase() === raw.toLowerCase());
    if (!name) continue;
    if (claimed.has(name)) { log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}SoM duplicate name "${name}" — answer invalid`); return null; }
    claimed.add(name);
    nameByDet.set(b.detIdx, name);
  }
  if (nameByDet.size === 0) return null;
  const letterByDet = new Map(badges.map(b => [b.detIdx, b.letter]));
  log.info(`🔤 [GDINO-DETECT] ${pageLabel}SoM identity: ${[...nameByDet.entries()].map(([i, n]) => `${letterByDet.get(i)}=${n}`).join(' ')}${dets.length > nameByDet.size ? ` (${dets.length - nameByDet.size} unknown)` : ''}`);
  return { nameByDet, answers };
}

// Binary mask → white-on-transparent PNG (same encoding /figure-mask returns).
async function _maskToPng(mask) {
  const raw = Buffer.alloc(mask.width * mask.height * 4);
  for (let i = 0; i < mask.width * mask.height; i++) {
    if (mask.alpha[i]) { const o = i * 4; raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255; }
  }
  return sharp(raw, { raw: { width: mask.width, height: mask.height, channels: 4 } }).png().toBuffer();
}

/**
 * Detect figures with the local Grounded-SAM path — generic prompts.
 *
 * Design (2026-07-17, docs/decisions.md "DINO goes generic"): DINO answers
 * WHERE, never WHO. Identity prose in grounding prompts produced bad boxes
 * (head-only collapses, sliver boxes, misattribution), so detection is now:
 *   1. GroundingDINO "person"  → all figure boxes (best + candidates, NMS)
 *   2. GroundingDINO "face"    → face boxes (replaces the Haar cascade;
 *      person-sized leaks filtered by IoU vs person boxes)
 *   3. MobileSAM per person box → tight silhouette; bodyBox = mask bounds
 *   4. face → figure pairing by containment
 *   5. name assignment from the scene layout (position-prose x-band + depth
 *      tier + adult/child size) — deterministic min-cost matching, no grounding
 *   6. expected VB objects grounded individually with short generic labels
 *
 * Returns { figures, objects, masks, diag } (masks = per-figure mask PNG
 * buffers, index-aligned with figures, for the overlay cutout strip — never
 * persisted), or { figures: null, diag } to signal "fall back to Gemini"
 * (no persons found, or fewer persons than expected characters).
 */
const GDINO_PERSON_NMS_IOU = 0.5;   // person candidates closer than this are one figure
const GDINO_FACE_NMS_IOU = 0.4;
const GDINO_FACE_LEAK_IOU = 0.5;    // "face" box this close to a person box IS the person box
const GDINO_OBJECT_MIN_SCORE = 0.25;

function _boxIouXyxy(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

// Best box + candidates from one _gdinoDetect figure, NMS-deduped, score-desc.
// NMS is NOT what loses an occluded figure (owner, 2026-08-15 — reverted).
//
// A size-ratio guard was added here on the theory that NMS deleted the figure
// standing behind another: Daniel's box vs Emma's is IoU 0.653 against a 0.5
// threshold, so a lower-scoring candidate on him would have been suppressed.
//
// The stored detection diag then showed the theory was arithmetic about a
// candidate that never existed. On job_1786780194082_s980g4s9a p-2 DINO's
// "person" query returned FOUR boxes and none of them is Daniel — he was never
// proposed, so there was nothing for NMS to suppress. What the guard actually
// did was admit a LOOSE DUPLICATE around Sarah (her box sits 100% inside it,
// area ratio 0.696 against the 0.70 floor), which the identity pass then had to
// name and called "Daniel" because that name was unassigned. It manufactured a
// phantom and, by removing the undercount, it also removed the Gemini
// second-opinion fallback that had been supplying a usable box for him.
//
// The real signal is that DINO found FIVE FACES and only four persons: Daniel's
// face scored 0.528, the HIGHEST on the page, and had no person box to attach
// to. That unpaired face is what now synthesises his box (see
// _personBoxFromFace) — a missing person box, not a suppressed one.
function _collectNmsBoxes(fig, nmsIou) {
  const all = [];
  if (fig?.box) all.push({ box: fig.box, score: fig.score });
  for (const c of (fig?.candidates || [])) if (c.box) all.push({ box: c.box, score: c.score });
  all.sort((a, b) => b.score - a.score);
  const out = [];
  for (const p of all) if (!out.some(k => _boxIouXyxy(k.box, p.box) > nmsIou)) out.push(p);
  return out;
}

// Scene-metadata position prose carries a depth token ("left foreground",
// "right background, seated on the bench") — 0 fore, 1 mid, 2 back.
function _depthRankFromProse(pos) {
  const s = String(pos || '').toLowerCase();
  if (/\bforeground\b/.test(s)) return 0;
  if (/\bbackground\b/.test(s)) return 2;
  return 1;
}

function _isChildFromText(t) {
  return /\b(girl|boy|child|kid|toddler|baby|preschooler|kindergartner|schoolboy|schoolgirl)\b/i.test(String(t || ''));
}

// Character gender from the identity prose ('f' | 'm' | null). Layout alone
// cannot separate two adults with identical position prose — gender can.
function _genderFromText(t) {
  const s = String(t || '');
  if (/\b(woman|girl|female|mother|mom|grandma|grandmother|lady|aunt|sister)\b/i.test(s)) return 'f';
  if (/\b(man|boy|male|father|dad|grandpa|grandfather|uncle|brother)\b/i.test(s)) return 'm';
  return null;
}

/**
 * Deterministic name→box matching from the intended scene layout + gender.
 * chars: [{name, xTarget|null, depthRank, isChild, gender}]; dets: [{cx, h,
 * bottom, femaleNorm}] (normalized; femaleNorm 0..1 from the generic
 * "woman . girl" DINO pass). Brute-force min-cost injective assignment.
 */
function _assignFiguresByLayout(chars, dets) {
  const N = chars.length, M = dets.length;
  // Depth proxy per detection: lower in frame = more foreground. Rank scaled 0..2.
  const byBottom = dets.map((d, i) => ({ i, b: d.bottom })).sort((a, b) => b.b - a.b);
  const detDepth = new Array(M);
  byBottom.forEach((e, r) => { detDepth[e.i] = M > 1 ? (r * 2) / (M - 1) : 0; });
  // Size percentile per detection: 0 = tallest.
  const byH = dets.map((d, i) => ({ i, h: d.h })).sort((a, b) => b.h - a.h);
  const detSizePct = new Array(M);
  byH.forEach((e, r) => { detSizePct[e.i] = M > 1 ? r / (M - 1) : 0.5; });
  // Size only separates when the cast mixes adults and children.
  const ageMix = chars.some(c => c.isChild) && chars.some(c => !c.isChild);
  const cost = (c, j) => {
    let k = 0;
    if (c.xTarget != null) k += 1.0 * Math.abs(c.xTarget - dets[j].cx);
    else k += 0.3 * Math.abs(0.5 - dets[j].cx);
    k += 0.25 * Math.abs(c.depthRank - detDepth[j]) / 2;
    if (ageMix) k += 0.3 * (c.isChild ? (1 - detSizePct[j]) : detSizePct[j]);
    // Gender: the tiebreaker layout can't provide (two adults, no L/R prose).
    if (c.gender && dets[j].femaleNorm != null) {
      k += 0.6 * (c.gender === 'f' ? (1 - dets[j].femaleNorm) : dets[j].femaleNorm);
    }
    return k;
  };
  let best = null, bestCost = Infinity, second = Infinity;
  const chosen = [], used = new Set();
  const walk = () => {
    if (chosen.length === N) {
      let t = 0;
      for (let i = 0; i < N; i++) t += cost(chars[i], chosen[i]);
      if (t < bestCost) { second = bestCost; bestCost = t; best = chosen.slice(); }
      else if (t < second) second = t;
      return;
    }
    for (let j = 0; j < M; j++) {
      if (used.has(j)) continue;
      used.add(j); chosen.push(j);
      walk();
      chosen.pop(); used.delete(j);
    }
  };
  walk();
  return { map: best || [], cost: bestCost, margin: second - bestCost };
}

async function detectFiguresWithGroundingDino(imageData, expectedCharacters, opts = {}) {
  const { pageLabel = '', expectedObjects = [], objectGroundingHints = null } = opts;
  if (!Array.isArray(expectedCharacters) || expectedCharacters.length === 0) return null;

  // The endpoints need base64 bytes — resolve http(s)/data/base64 to a data URI.
  let imageDataUri;
  if (typeof imageData === 'string' && /^https?:\/\//i.test(imageData)) {
    const buf = await require('./r2').fetchImageBytes(imageData);
    if (!buf) { log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}could not fetch image bytes`); return null; }
    imageDataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
  } else {
    imageDataUri = imageData.startsWith('data:') ? imageData : `data:image/jpeg;base64,${r2Lib.stripDataUriPrefix(imageData)}`;
  }

  const diag = { backend: 'grounding-dino', mode: 'generic', persons: [], faces: [], assignment: [], objects: [], fellBack: false, reason: null };

  // Stage 1 — generic person boxes.
  const det = await _gdinoDetect(imageDataUri, [{ name: 'person', text: 'person' }]);
  if (!det || !Array.isArray(det.figures)) return null;
  const W = det.width, H = det.height;
  const persons = _collectNmsBoxes(det.figures[0], GDINO_PERSON_NMS_IOU);
  diag.persons = persons.map(p => ({ box: p.box.map(Math.round), score: +p.score.toFixed(3) }));
  if (persons.length === 0) {
    diag.fellBack = true; diag.reason = 'no person boxes';
    log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}no person boxes — falling back to Gemini`);
    return { figures: null, diag };
  }

  // Stage 1b — generic face boxes (DINO replaces the Haar cascade here; it
  // found background faces Haar missed and has no phantom problem once
  // person-sized leaks are filtered).
  let faces = [];
  const fdet = await _gdinoDetect(imageDataUri, [{ name: 'face', text: 'face' }]);
  if (fdet?.figures?.[0]) {
    faces = _collectNmsBoxes(fdet.figures[0], GDINO_FACE_NMS_IOU)
      .filter(f => !persons.some(p => _boxIouXyxy(f.box, p.box) > GDINO_FACE_LEAK_IOU));
  }
  diag.faces = faces.map(f => ({ box: f.box.map(Math.round), score: +f.score.toFixed(3) }));

  // Stage 1b-2 — a face nobody's person box claims IS a person we missed.
  // Checked geometrically here rather than after the Stage-3 pairing, so the
  // recovered figure flows through masking and identity like any other.
  for (const f of faces) {
    if (persons.some(p => _boxContainment(f.box, p.box) >= SAM_FACE_CONTAINMENT)) continue;
    const box = _personBoxFromFace(f.box, W, H);
    if (!box) continue;
    persons.push({ box, score: f.score, fromFace: true });
    diag.persons.push({ box: box.map(Math.round), score: +f.score.toFixed(3), fromFace: true });
    log.info(`🦖 [GDINO-DETECT] ${pageLabel}recovered a figure from an unpaired face (score ${f.score.toFixed(3)}) — DINO found the face but no person box`);
  }

  // Stage 1c — femaleness pass is LAZY (owner, 2026-08-10): it only feeds the
  // layout-fallback tiebreaker, and SoM identity succeeds on virtually every
  // page — running "woman . girl" up front wasted a full DINO forward pass per
  // page. It now runs inside the fallback branch, only when SoM failed.
  let femaleBoxes = [];
  const loadFemaleBoxes = async () => {
    const gdet = await _gdinoDetect(imageDataUri, [{ name: 'female', text: 'woman . girl' }]);
    if (gdet?.figures?.[0]) femaleBoxes = _collectNmsBoxes(gdet.figures[0], GDINO_PERSON_NMS_IOU);
    diag.femaleBoxes = femaleBoxes.map(f => ({ box: f.box.map(Math.round), score: +f.score.toFixed(3) }));
  };
  const femaleNormFor = (personBox) => {
    const s = Math.max(0, ...femaleBoxes.filter(f => _boxIouXyxy(f.box, personBox) > 0.6).map(f => f.score));
    return Math.min(1, s / 0.45);
  };

  // Stage 2 — MobileSAM silhouette per person box, VALIDATED against the DINO
  // box. The DINO box is tight/accurate; SAM only refines it to a silhouette.
  // We accept the mask (and use its bounds as bodyBox) ONLY when it is one
  // connected figure ≤10% larger than the DINO box; otherwise SAM over-segmented
  // (grabbed a neighbour / background — disconnected or blown up) and we keep the
  // tight DINO box. _cleanMaskAndCheck also trims the mask to its largest
  // component (drops specks) so an accepted mask is clean for the cutout.
  //
  // ORDER MATTERS: smallest box first, so a figure standing in front is always
  // resolved before the figure it occludes, and its pixels can be erased from
  // the image the occluded figure's SAM call sees (see SAM_FRONT_* above).
  const dets = (await _maskBoxesFrontFirst(imageDataUri, persons.map(p => p.box), W, H, pageLabel,
    faces.map(f => f.box), expectedCharacters.map(c => (typeof c === 'object' ? c.description : '') || '')))
    .map((m, i) => ({
      box: persons[i].box,
      score: persons[i].score,
      mask: m.mask,
      bodyBox: m.keptBox ? _pxBoxToNorm(m.keptBox, W, H) : _pxBoxToNorm(persons[i].box, W, H),
      gdinoBox: _pxBoxToNorm(persons[i].box, W, H),
      samApplied: !!m.mask,
      maskVerdict: m.verdict,
      maskCoverage: m.coverage,
      // Free from the joint depth pass — no anatomy, no thresholds: who took
      // pixels from this figure, and how many. Downstream can tell a partial
      // view from a complete one instead of judging a fragment as a whole.
      occluded: m.occluded,
      occludedByIdx: m.occludedByIdx,
      pxLostToFront: m.pxLostToFront,
      maskPx: m.maskPx,
      garmentSeeds: m.garmentSeeds,
    }));
  // Persist any SAM mask leak to the STORY log (not just Railway), so a blow-out
  // is always findable later per-story instead of vanishing into container logs.
  const leaks = dets.filter(d => d.maskVerdict === 'rejected-all-outside'
    || d.maskVerdict === 'mask-clipped-outside-box'
    || d.maskVerdict === 'rejected-too-small');
  if (leaks.length) {
    getCurrentLogger()?.warn?.('sam_mask_leak',
      `${pageLabel}SAM mask did not match the DINO box on ${leaks.length}/${dets.length} figure(s) — kept the DINO box`,
      null, { pageLabel, verdicts: dets.map(d => d.maskVerdict), coverage: dets.map(d => d.maskCoverage) });
  }
  const noMask = dets.filter(d => d.maskVerdict === 'no-mask');
  if (dets.length >= 2 && noMask.length >= Math.ceil(dets.length * 0.6)) {
    getCurrentLogger()?.warn?.('sam_no_mask',
      `${pageLabel}MobileSAM returned no segmentation for ${noMask.length}/${dets.length} figures — mask service unavailable or overloaded (used DINO boxes)`,
      null, { pageLabel });
  }
  // Two masks ≈ the same figure → keep the higher-score one.
  for (let i = dets.length - 1; i >= 1; i--) {
    for (let j = 0; j < i; j++) {
      if (_maskOverlapFrac(dets[i].mask, dets[j].mask) >= GDINO_SAME_FIGURE) {
        diag.persons[i].droppedDuplicateOf = j;
        dets.splice(i, 1);
        break;
      }
    }
  }
  // The occlusion carve-out that used to live here is GONE: _maskBoxesFrontFirst
  // now settles every contested pixel in one winner-take-all pass ordered by
  // depth. The old rule gave shared pixels to the SMALLER mask, which is
  // backwards for an occluded figure — Daniel's mask is smaller than Noah's, yet
  // Daniel stands behind him, so Noah's sandal ended up in Daniel's cut-out.
  if (dets.length < expectedCharacters.length) {
    // Undercount is NOT an automatic fallback anymore (owner, 2026-08-09):
    // fewer persons than expected has two causes with opposite fixes — the
    // painter really painted fewer (DINO is RIGHT, e.g. a redraw dropped a
    // character), or DINO merged two overlapping figures into one box. The
    // orchestrator resolves this with a Gemini second opinion; here we finish
    // the full pipeline (SAM + SoM) on the persons we DID find and flag it.
    diag.undercount = `${dets.length} persons < ${expectedCharacters.length} expected`;
    log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}${diag.undercount} — completing detection; orchestrator will get a Gemini second opinion`);
  }

  // Stage 3 — face → figure pairing. Two strategies, selectable so the Lab can
  // run them against the same page (opts.facePairing / FACE_PAIRING env).
  //
  //   'greedy' (default, unchanged): for each face in SCORE order, take the
  //     SMALLEST containing person box that has no face yet.
  //   'global': score every geometrically possible (face, box) pair and take
  //     the best pairs best-first, then give any left-over face a body box
  //     synthesised from the face.
  //
  // Why 'global' exists — measured on job_1786737619634_d66c7bg9g p10 (5 people,
  // 5 faces, 5 person boxes, three of which each span two people):
  //   Daniel's face (cx 794) sits 6px inside the RIGHT EDGE of Hans's box
  //   (573-800), and that box is SMALLER (177,968) than Daniel's own body box
  //   (202,300) — so "smallest containing box" gave Daniel's face to Hans's
  //   body. Hans's face then found no free box and was DROPPED, and the girl's
  //   face was dropped the same way. 5 faces in, 3 pairings out, 2 of them wrong,
  //   and two people invisible to identity and to every repair keyed on it.
  const facePairing = opts.facePairing || process.env.FACE_PAIRING || 'mask';
  diag.facePairing = facePairing;
  if (facePairing === 'mask') {
    // MASK-FIRST ASSOCIATION (owner, 2026-08-14). The order was: boxes → guess
    // which face belongs to which box → badge → segment. But SAM has ALREADY
    // run by this point (Stage 2), and a MASK is one person where a BOX may be
    // two. Measured on job_1786737619634_d66c7bg9g p10: three of the five
    // person boxes each swallow a neighbour, yet all five SAM cutouts are clean
    // single people. So the separation problem is already solved — it was just
    // being ignored by the step that needed it most.
    //
    // A face belongs to the figure whose SILHOUETTE it sits in. Sample a 3x3
    // grid inside the face box rather than the centre alone: the centre can
    // land on a gap in the mask (an eye, a hair parting), and the grid also
    // breaks ties by how much of the face the mask actually covers.
    const hitsIn = (det, f) => {
      if (!det.mask || !det.mask.alpha) return 0;
      const { alpha, width: mw, height: mh } = det.mask;
      let hits = 0;
      for (let gy = 1; gy <= 3; gy++) {
        for (let gx = 1; gx <= 3; gx++) {
          const x = Math.round(f.box[0] + (f.box[2] - f.box[0]) * gx / 4);
          const y = Math.round(f.box[1] + (f.box[3] - f.box[1]) * gy / 4);
          if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
          if (alpha[y * mw + x]) hits++;
        }
      }
      return hits;
    };
    const claimed = new Set();
    const unplaced = [];
    for (const f of faces) {
      const scored = dets
        .map(d => ({ d, hits: hitsIn(d, f) }))
        .filter(x => x.hits > 0 && !claimed.has(x.d))
        .sort((a, b) => b.hits - a.hits);
      if (scored.length && !scored[0].d.face) {
        scored[0].d.face = f;
        claimed.add(scored[0].d);
      } else {
        unplaced.push(f);
      }
    }
    // A face inside no mask at all — a silhouette clipped at the chin, or a
    // figure SAM never masked. Fall back to box containment for those only, so
    // one odd figure cannot cost the whole page its associations.
    for (const f of unplaced) {
      const cx = (f.box[0] + f.box[2]) / 2, cy = (f.box[1] + f.box[3]) / 2;
      const holder = dets
        .filter(d => !d.face && cx >= d.box[0] && cx <= d.box[2] && cy >= d.box[1] && cy <= d.box[3])
        .sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
      if (holder) { holder.face = f; log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}face at x${Math.round(cx)} sits in no SAM mask — fell back to box containment`); }
      else log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}face at x${Math.round(cx)} matched no mask and no box — left unassigned`);
    }
    diag.maskPairing = { faces: faces.length, placedByMask: claimed.size, fellBackToBox: unplaced.length };
  } else if (facePairing === 'global') {
    // A head sits at the TOP-CENTRE of its body, so cost = horizontal offset
    // from the box centre (weighted heaviest) + how far below the box top the
    // face starts. Global ordering means one marginal pair can no longer poison
    // a better pair that would only have been considered later.
    const pairCost = (f, d) => {
      const fcx = (f.box[0] + f.box[2]) / 2;
      const bw = Math.max(1, d.box[2] - d.box[0]), bh = Math.max(1, d.box[3] - d.box[1]);
      const dx = Math.abs(fcx - (d.box[0] + d.box[2]) / 2) / bw;
      const dy = Math.max(0, f.box[1] - d.box[1]) / bh;
      return dx * 2 + dy;
    };
    const candidates = [];
    for (const f of faces) {
      const cx = (f.box[0] + f.box[2]) / 2, cy = (f.box[1] + f.box[3]) / 2;
      for (const d of dets) {
        if (cx < d.box[0] || cx > d.box[2] || cy < d.box[1] || cy > d.box[3]) continue;
        candidates.push({ f, d, cost: pairCost(f, d) });
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const takenFaces = new Set();
    for (const c of candidates) {
      if (c.d.face || takenFaces.has(c.f)) continue;
      c.d.face = c.f; takenFaces.add(c.f);
    }
    // ONE FIGURE PER FACE. A left-over face has no body box that is plausibly
    // its own; dropping it is what made two people invisible above. Synthesise
    // a body from the face (a head is ~1/7 of a standing figure, a body ~3 face
    // widths across) and mark it so downstream knows it was derived.
    const orphans = faces.filter(f => !takenFaces.has(f));
    for (const f of orphans) {
      const fw = f.box[2] - f.box[0], fh = f.box[3] - f.box[1];
      const fcx = (f.box[0] + f.box[2]) / 2;
      const box = [
        Math.max(0, Math.round(fcx - fw * 1.5)),
        Math.max(0, Math.round(f.box[1] - fh * 0.3)),
        Math.min(W, Math.round(fcx + fw * 1.5)),
        Math.min(H, Math.round(f.box[1] + fh * 7)),
      ];
      dets.push({ box, score: f.score, face: f, synthesizedFromFace: true, bodyBox: _pxBoxToNorm(box, W, H) });
      log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}face at x${Math.round(fcx)} had no body box of its own — synthesised one from the face`);
    }
    if (orphans.length) diag.synthesizedFigures = orphans.length;
  } else {
    for (const f of faces) {
      const cx = (f.box[0] + f.box[2]) / 2, cy = (f.box[1] + f.box[3]) / 2;
      const holders = dets
        .filter(d => cx >= d.box[0] && cx <= d.box[2] && cy >= d.box[1] && cy <= d.box[3])
        .sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]));
      const holder = holders.find(h => !h.face);
      if (holder) holder.face = f;
    }
  }
  diag.assignment = dets.map((d, i) => ({
    det: i, box: d.box.map(Math.round),
    face: d.face ? d.face.box.map(Math.round) : null,
    synthesized: !!d.synthesizedFromFace,
  }));

  // NOTE: blow-out handling moved UPSTREAM to Stage 2 (_cleanMaskAndCheck) —
  // a SAM mask that is disconnected or >10% larger than its DINO box is rejected
  // at creation and the tight DINO box is used, so no box ever reaches here
  // blown. (Replaced the earlier point-prompt guard, 2026-07-20.)

  // Stage 4 — identity. Primary: Set-of-Mark — letter badges are drawn on the
  // detected figures and Gemini Flash answers WHICH letter is WHICH character
  // (pure recognition by age/gender/hair/clothing; no coordinates ever come
  // back, so Gemini's spatial sloppiness cannot corrupt the boxes). Fallback:
  // deterministic layout+gender matching — which cannot separate e.g. three
  // girls, hence SoM first.
  let nameByDet = null; // detIdx → character name
  try {
    const badgeAnchor = opts.badgeAnchor || process.env.BADGE_ANCHOR || 'face';
    diag.badgeAnchor = badgeAnchor;
    const som = await _somIdentifyFigures(imageDataUri, dets, expectedCharacters, W, H, pageLabel, badgeAnchor);
    if (som) { nameByDet = som.nameByDet; diag.identity = { method: 'som-gemini', answers: som.answers }; }
  } catch (e) {
    log.warn(`⚠️ [GDINO-DETECT] ${pageLabel}SoM identity failed (${e.message}) — layout fallback`);
  }
  if (!nameByDet) {
    require('./runMetrics').forJob(_metricsJobId()).count('som_identity_fallback');
    await loadFemaleBoxes(); // gender tiebreaker only needed here (lazy)
    const sh = getStoryHelpers();
    const chars = expectedCharacters.map(c => {
      const lcr = c.position ? sh.normalizePositionToLCR(c.position) : null;
      return {
        name: c.name,
        xTarget: lcr === 'left' ? 0.18 : lcr === 'right' ? 0.82 : lcr === 'center' ? 0.5 : null,
        depthRank: _depthRankFromProse(c.position),
        isChild: _isChildFromText(`${c.gdinoPrompt || ''} ${c.description || ''}`),
        gender: _genderFromText(`${c.gdinoPrompt || ''} ${c.description || ''}`),
      };
    });
    const geo = dets.map(d => ({
      cx: (d.bodyBox[1] + d.bodyBox[3]) / 2,
      h: d.bodyBox[2] - d.bodyBox[0],
      bottom: d.bodyBox[2],
      femaleNorm: femaleNormFor(d.box),
    }));
    const asg = _assignFiguresByLayout(chars, geo);
    nameByDet = new Map();
    chars.forEach((c, i) => { if (asg.map[i] != null) nameByDet.set(asg.map[i], c.name); });
    diag.identity = { method: 'layout-fallback' };
    diag.assignment = chars.map((c, i) => ({ name: c.name, boxIdx: asg.map[i], xTarget: c.xTarget, depthRank: c.depthRank, isChild: c.isChild, gender: c.gender, femaleNorm: asg.map[i] != null ? +(geo[asg.map[i]]?.femaleNorm ?? 0).toFixed(2) : null }));
    diag.assignmentCost = Number.isFinite(asg.cost) ? +asg.cost.toFixed(3) : null;
    diag.assignmentMargin = Number.isFinite(asg.margin) ? +asg.margin.toFixed(3) : null;
  }

  const lcrOf = (bodyBox) => {
    const cx = (bodyBox[1] + bodyBox[3]) / 2;
    return cx < 0.33 ? 'left' : cx > 0.66 ? 'right' : 'center';
  };
  const paddedFaceBox = (facePxBox, bodyBoxNorm) => _padDinoFaceBox(facePxBox, W, H, bodyBoxNorm);
  const figures = [];
  const masks = [];
  dets.forEach((d, j) => {
    const name = nameByDet.get(j) || 'UNKNOWN';
    const ec = name !== 'UNKNOWN' ? expectedCharacters.find(c => c.name === name) : null;
    figures.push({
      name,
      label: ec ? (ec.description || '').slice(0, 120) : 'unmatched person',
      position: lcrOf(d.bodyBox),
      faceBox: d.face ? paddedFaceBox(d.face.box, d.bodyBox) : null,
      // Raw (unpadded) DINO face box — debugging: when the padded faceBox
      // looks off-target, this shows whether DINO itself boxed the wrong
      // spot or the padding/pairing shifted it.
      faceBoxRaw: d.face ? _pxBoxToNorm(d.face.box, W, H) : null,
      faceScore: d.face?.score,
      bodyBox: d.bodyBox,
      gdinoBox: d.gdinoBox,
      samApplied: d.samApplied,
      // 'mask-ok' | 'mask-clipped-outside-box' | 'rejected-all-outside' |
      // 'rejected-too-small' | 'no-mask' — SAM mask validation vs the DINO box.
      maskVerdict: d.maskVerdict,
      // Share of the DINO box filled by the kept mask extent. Real silhouettes
      // measure 0.62-0.99; anything under SAM_MIN_BOX_COVERAGE is rejected.
      maskCoverage: d.maskCoverage,
      _faceSource: d.face ? 'dino' : undefined,
      _faceScore: d.face ? +d.face.score.toFixed(3) : undefined,
      confidence: name === 'UNKNOWN' ? 'low' : d.score >= 0.6 ? 'high' : d.score >= 0.4 ? 'medium' : 'low',
      score: +d.score.toFixed(3),
    });
    masks.push(d.mask?.pngBuf || null);
  });

  // Stage 5 — Visual-Bible objects, grounded individually. Grounding text is
  // the English VB description (first clause) when a hint exists — DINO's
  // English text encoder grounds story-language names (German) onto salient
  // figures instead of the prop. Locations are skipped (a location IS the
  // scene). A found box that ≈coincides with a figure is dropped as a
  // grounding failure. A DINO miss is NOT reported as a missing object
  // (miss ≠ absent — see docs/decisions.md); unfound objects only appear in
  // the diag.
  const objects = [];
  // Object grounding gated OFF (owner, 2026-08-10): the object boxes are not
  // consumed anywhere right now (entity objects check is off, a DINO miss is
  // never reported as missing), yet each expected object cost a full DINO
  // forward pass per page. Re-enable via GDINO_GROUND_OBJECTS=true when a
  // consumer exists.
  const groundObjects = process.env.GDINO_GROUND_OBJECTS === 'true';
  if (!groundObjects && expectedObjects.length > 0) {
    diag.objects.push({ skipped: 'object grounding disabled', count: expectedObjects.length });
  }
  const iouWithFigure = (bodyBox) => Math.max(0, ...figures.map(f =>
    _boxIouXyxy([bodyBox[1], bodyBox[0], bodyBox[3], bodyBox[2]], [f.bodyBox[1], f.bodyBox[0], f.bodyBox[3], f.bodyBox[2]])));
  for (const raw of (groundObjects ? expectedObjects : [])) {
    const cleaned = String(raw || '').trim();
    if (!cleaned || /^[A-Z]{3}\d{3}(\.\d+)?$/.test(cleaned)) continue; // opaque VB id — nothing to ground
    const hint = objectGroundingHints?.[cleaned.toLowerCase()];
    if (hint?.kind === 'location') { diag.objects.push({ name: cleaned, skipped: 'location' }); continue; }
    const src = (hint?.text || cleaned);
    let text = src.split(/[—,;(.]/)[0].trim().toLowerCase();
    if (text.length > 60) text = text.slice(0, 60).replace(/\s+\S*$/, ''); // word-boundary cap
    if (!text) text = cleaned.toLowerCase();
    const od = await _gdinoDetect(imageDataUri, [{ name: cleaned, text }]);
    const obj = od?.figures?.[0];
    if (obj?.box && obj.score >= GDINO_OBJECT_MIN_SCORE) {
      const bodyBox = _pxBoxToNorm(obj.box, W, H);
      const figIou = iouWithFigure(bodyBox);
      if (figIou > 0.7) {
        diag.objects.push({ name: cleaned, text, score: +obj.score.toFixed(3), found: false, dropped: `box ≈ figure (IoU ${figIou.toFixed(2)})` });
        continue;
      }
      objects.push({ name: cleaned, found: true, label: cleaned, bodyBox, position: lcrOf(bodyBox), score: +obj.score.toFixed(3) });
      diag.objects.push({ name: cleaned, text, score: +obj.score.toFixed(3), found: true });
    } else {
      diag.objects.push({ name: cleaned, text, score: obj?.score != null ? +obj.score.toFixed(3) : null, found: false });
    }
  }

  log.info(`🦖 [GDINO-DETECT] ${pageLabel}${figures.length} figures (${expectedCharacters.length} named, ${figures.length - expectedCharacters.length} unknown), ${faces.length} faces, ${objects.length}/${expectedObjects.length} objects (generic DINO→SAM)`);
  return { figures, objects, masks, diag };
}

/**
 * Attach MobileSAM silhouette masks to figures whose boxes came from a NON-DINO
 * source (the Gemini bbox path) — SAM is box-prompted, so any box works as a
 * prompt. Used by the second-opinion arbitration: when Gemini's boxes win over
 * an undercounted DINO pass, the figures still get masks, so entity-grid crops
 * are cutouts instead of neighbour-contaminated rectangles.
 *
 * Mutates each figure in place (bodyBox refined to the kept mask bounds,
 * samApplied / maskVerdict / maskCoverage stamped — same fields as the DINO
 * path) and returns the masks array (pngBuf | null, index-aligned with
 * figures) for the _gdinoMasks rider. Overlap between figures is resolved by
 * the shared masker's depth pass, not here.
 */
async function attachSamMasksToFigures(imageData, figures, { pageLabel = '' } = {}) {
  const imageDataUri = imageData.startsWith('data:')
    ? imageData
    : `data:image/jpeg;base64,${r2Lib.stripDataUriPrefix(imageData)}`;
  const meta = await sharp(Buffer.from(r2Lib.stripDataUriPrefix(imageDataUri), 'base64')).metadata();
  const W = meta.width, H = meta.height;
  // Same front-figure-first masking as the DINO path — and it matters MORE
  // here: a Gemini box for a crouching adult behind a child encloses the child
  // completely, which is exactly how job_1786780194082_s980g4s9a p-2 produced a
  // "Daniel" cutout made of Emma's red top and orange shorts.
  const boxesPx = figures.map((f) => {
    const bb = f?.bodyBox;
    return (Array.isArray(bb) && bb.length === 4)
      ? [Math.round(bb[1] * W), Math.round(bb[0] * H), Math.round(bb[3] * W), Math.round(bb[2] * H)]
      : null;
  });
  const faceBoxesPx = figures.map((f) => {
    const fb = f?.faceBox;
    return (Array.isArray(fb) && fb.length === 4)
      ? [Math.round(fb[1] * W), Math.round(fb[0] * H), Math.round(fb[3] * W), Math.round(fb[2] * H)]
      : null;
  }).filter(Boolean);
  const maskResults = await _maskBoxesFrontFirst(imageDataUri, boxesPx, W, H, pageLabel, faceBoxesPx,
    figures.map(f => f.description || f.clothing || ''));
  const entries = figures.map((f, i) => {
    const m = maskResults[i];
    if (m.keptBox) { f.bodyBox = _pxBoxToNorm(m.keptBox, W, H); f.samApplied = true; }
    f.maskVerdict = m.verdict;
    f.maskCoverage = m.coverage;
    // Occlusion facts, free from the joint depth pass. Names here because this
    // path already knows them.
    f.occluded = m.occluded;
    f.occludedBy = (m.occludedByIdx || []).map(k => figures[k]?.name).filter(Boolean);
    f.pxLostToFront = m.pxLostToFront;
    f.maskPx = m.maskPx;
    f.garmentSeeds = m.garmentSeeds;
    return { f, mask: m.mask };
  });
  const masked = entries.filter(e => e.mask).length;
  log.info(`🎭 [GDINO-DETECT] ${pageLabel}attached SAM masks to ${masked}/${figures.length} non-DINO figure box(es)`);
  return entries.map(e => e.mask?.pngBuf || null);
}

module.exports = {
  _shortGarmentPhrase,
  detectFiguresWithGroundingDino,
  detectPersonBoxInCrop,
  recoverFaceBox,
  attachSamMasksToFigures,
  _cleanMaskAndCheck,
  _boxAreaPx,
  _boxContainment,
  _assignFacesToBoxes,
  _personBoxFromFace,
  FACE_TO_BODY_W,
  FACE_TO_BODY_H,
  _garmentColourWords,
  _colourSeedPoints,
  NEUTRAL_COLOURS,
  DOT_MIN_PX,
  SAM_FACE_CONTAINMENT,
  SAM_FACE_IN_MASK,
  SAM_FRONT_CONTAINMENT,
  SAM_GROUND_TIE_PX,
  GDINO_OVERLAP_THRESHOLD,
  GDINO_SAME_FIGURE,
  GDINO_LOW_CONFIDENCE,
};
