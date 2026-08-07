// Lighting-aware garment HUE normalization (pre-eval pass).
//
// Problem this solves: a character's clothing colour is specified only as TEXT
// ("red jacket"). Each page's image model re-interprets that text independently,
// so the same jacket renders red on one page and orange on another. Today the
// quality/semantic/entity eval flags the drift and the pipeline does a FULL
// figure redraw — hugely expensive for what is only a hue shift.
//
// This module replaces that, for the colour-drift case only, with a cheap,
// deterministic, LIGHTING-PRESERVING hue correction that runs BEFORE eval (so
// eval scores the already-corrected image and never triggers a redraw for a
// hue drift). The canonical colour is the character's STYLED AVATAR garment.
//
// The crux is separating INTRINSIC hue drift (fix it) from SCENE ILLUMINATION
// (preserve it). A naive LAB match to the avatar would DESTROY legitimate scene
// lighting — a red jacket SHOULD look dim/cool at night and bright/warm at noon.
//   - Illumination applies a GLOBAL cast to the whole page (sunset warms
//     everything, moonlight cools it). Intrinsic drift is LOCAL (only the
//     garment goes orange).
//   - We estimate the page's global illumination cast (gray-world / white
//     balance over the whole scene), DISCOUNT it from the garment hue, and
//     compare the discounted garment hue to the avatar's discounted hue.
//   - We correct ONLY the residual local HUE ANGLE (rotate the a*/b* direction),
//     while PRESERVING L* (lightness = the lighting; keeps night dark) and the
//     CHROMA MAGNITUDE (saturation = also lighting; don't over-saturate a dim
//     scene). A rotation of the (a*,b*) vector preserves both L* and |(a*,b*)|
//     exactly — it is a hue rotation inside the garment mask, NOT a colour
//     replacement.
//
// We ALWAYS CHECK every figure with a resolvable avatar and correct ONLY the
// outliers (illumination-discounted hue drift above a threshold); otherwise
// no-op. If the drift is very large (a hue that far off is probably a
// garment-TYPE error, not a tint) or the illumination estimate is low
// confidence, we SKIP and defer to the normal eval+repair pipeline rather than
// smear.
//
// Reuse: LAB conversion (`_rgbToLab`/`_labToRgb`) comes from images.js; the
// skin/grey rejection thresholds are ported verbatim from
// coverTypography.js `garmentColors` (the sibling garment sampler); the figure
// silhouette is the shared detection SAM mask (`_gdinoMasks`, see decisions.md
// "Detection SAM mask is computed once, shared by eval + repair") — we never
// re-detect.

const sharp = require('sharp');
const { _rgbToLab, _labToRgb } = require('./images');

// ── Tunable thresholds (env-overridable; opts.* wins for Test Lab A/B) ────────
const DEFAULTS = {
  // Below this illumination-discounted hue drift → the garment is already the
  // right colour → NO-OP. Never touch a garment that's already correct.
  hueDriftMinDeg: numEnv('GARMENT_HUE_DRIFT_MIN_DEG', 10),
  // Above this → probably a garment-TYPE error (wrong outfit), not a tint.
  // SKIP and defer to eval+repair (which may legitimately redraw). Also the
  // hard cap on how far we ever rotate (analogous to correctColorShift's
  // maxOffsetDeltaE): we never rotate more than this.
  hueDriftMaxDeg: numEnv('GARMENT_HUE_DRIFT_MAX_DEG', 45),
  // Garment cluster chroma floor. A near-grey / white / black garment has an
  // ill-defined hue — rotating it would invent a colour. Skip below this.
  chromaMin: numEnv('GARMENT_HUE_CHROMA_MIN', 8),
  // Selection window around the drifted garment cluster hue: only pixels whose
  // (illumination-discounted) hue is within this angle of the cluster get
  // corrected, so a differently-coloured garment on the same figure (blue
  // trousers under a red jacket), skin and hair are left untouched.
  hueWindowDeg: numEnv('GARMENT_HUE_WINDOW_DEG', 40),
  // Gaussian falloff (deg) for the soft per-pixel selection weight inside the
  // window — a smooth edge, like correctColorShift's colour-weighted blend.
  sigmaDeg: numEnv('GARMENT_HUE_SIGMA_DEG', 22),
  // A candidate avatar target must carry at least this share of the strongest
  // cluster's chroma-weighted evidence. Keeps hair/trim/incidental patches from
  // being chosen as "the garment"; a real second garment easily clears it.
  minTargetWeightFrac: numEnv('GARMENT_HUE_MIN_TARGET_WEIGHT_FRAC', 0.2),
  // Region growing (growGarmentRegion): max LAB distance for a pixel to join the
  // garment region, and the smallest region worth considering. deltaE 14 is
  // roughly "clearly a different colour to the eye" — loose enough to span a
  // garment's own shading, tight enough to stop at skin or hair.
  regionDeltaE: numEnv('GARMENT_HUE_REGION_DELTA_E', 14),
  minRegionPx: numEnv('GARMENT_HUE_MIN_REGION_PX', 250),
  // Confidence floors: too few pixels → estimate is noise → skip.
  minGarmentPixels: 40,
  minPagePixels: 400,
};

function numEnv(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

// Smallest signed angular difference b−a, wrapped to (−180°, 180°] in radians.
function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// ── skin / grey rejection (ported verbatim from coverTypography.garmentColors)─
// HSL from 0..255 RGB. Matches the sibling garment sampler so the page and the
// avatar are classified identically.
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h, s; const l = (mx + mn) / 2;
  if (mx === mn) { h = s = 0; }
  else {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}
// A garment material pixel: NOT skin, NOT grey/white/black. Same thresholds as
// coverTypography.garmentColors so the two samplers agree.
function isGarmentPixel(r, g, b) {
  const [h, s, l] = rgb2hsl(r, g, b);
  if (h >= 7 && h <= 50 && s >= 0.15 && s <= 0.65 && l >= 0.35 && l <= 0.88) return false; // skin
  if (s < 0.12) return false; // grey / white / black
  return true;
}

/**
 * Gray-world illumination cast: the mean (a*, b*) over the sampled pixels. Under
 * the gray-world assumption the average scene reflectance is neutral, so a
 * non-zero page mean IS the global illumination cast (sunset warms +a,+b;
 * moonlight cools −b). Sampled over the WHOLE frame (maskBin=null) for the
 * scene cast, or over a mask for a region.
 * @returns {{ a:number, b:number, count:number }}
 */
function estimateCast(raw, n, maskBin = null) {
  let sa = 0, sb = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (maskBin && maskBin[i] <= 128) continue;
    const lab = _rgbToLab(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
    sa += lab[1]; sb += lab[2]; cnt++;
  }
  return cnt ? { a: sa / cnt, b: sb / cnt, count: cnt } : { a: 0, b: 0, count: 0 };
}

/**
 * Dominant garment hue inside a mask, in ILLUMINATION-DISCOUNTED space. Builds a
 * chroma-weighted circular histogram of the discounted hue of every garment
 * (non-skin, non-grey) pixel, finds the peak, and returns the chroma-weighted
 * mean discounted (a*,b*) of the pixels within one window of the peak.
 *   discounted (a,b) = raw (a,b) − cast   (removes the global tint before we
 *   read the hue, so a red jacket under a sunset cast reads as RED, not orange).
 * @param {Buffer} raw  RGB (n*3)
 * @param {number} n    pixel count
 * @param {Buffer|null} maskBin  figure silhouette (0/255) or null for whole image
 * @param {{a:number,b:number}} cast  illumination cast to discount
 * @param {object} opts
 * @returns {{ hueRad:number, chroma:number, a:number, b:number, count:number }|null}
 */
function sampleGarmentClusters(raw, n, maskBin, cast, opts = {}, maxClusters = 3) {
  const { hueWindowDeg } = { ...DEFAULTS, ...opts };
  const BINS = 72; // 5° per bin
  const hist = new Float64Array(BINS);
  // Single pass: collect the qualifying garment pixels in discounted space AND
  // build the chroma-weighted hue histogram. Keeping the pixel list lets us peel
  // off several clusters without re-decoding LAB per cluster.
  const pa = [], pb = [], pc = [], pang = [], pL = [];
  for (let i = 0; i < n; i++) {
    if (maskBin && maskBin[i] <= 128) continue;
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    if (!isGarmentPixel(r, g, b)) continue;
    const lab = _rgbToLab(r, g, b);
    const da = lab[1] - cast.a, db = lab[2] - cast.b;
    const chroma = Math.hypot(da, db);
    if (chroma < 1) continue; // no hue
    let ang = Math.atan2(db, da); if (ang < 0) ang += 2 * Math.PI;
    pa.push(da); pb.push(db); pc.push(chroma); pang.push(ang); pL.push(lab[0]);
    const bin = Math.min(BINS - 1, Math.floor((ang / (2 * Math.PI)) * BINS));
    hist[bin] += chroma; // weight strongly-coloured pixels
  }
  const win = hueWindowDeg * RAD;
  const clusters = [];
  for (let c = 0; c < maxClusters; c++) {
    // Peak bin of what's left.
    let peak = -1, peakVal = 0;
    for (let k = 0; k < BINS; k++) if (hist[k] > peakVal) { peakVal = hist[k]; peak = k; }
    if (peak < 0) break;
    const peakHue = (peak + 0.5) / BINS * 2 * Math.PI;
    // Chroma-weighted mean discounted (a,b) of pixels near the peak.
    let sa = 0, sb = 0, sL = 0, wsum = 0, cnt = 0;
    for (let i = 0; i < pang.length; i++) {
      if (Math.abs(angDiff(peakHue, pang[i])) > win) continue;
      sa += pa[i] * pc[i]; sb += pb[i] * pc[i]; sL += pL[i] * pc[i]; wsum += pc[i]; cnt++;
    }
    // Consume this cluster's bins so the next iteration finds a DIFFERENT hue.
    for (let k = 0; k < BINS; k++) {
      const binHue = (k + 0.5) / BINS * 2 * Math.PI;
      if (Math.abs(angDiff(peakHue, binHue)) <= win) hist[k] = 0;
    }
    if (!cnt || wsum <= 0) continue;
    const a = sa / wsum, bb = sb / wsum;
    // L is the chroma-weighted mean LIGHTNESS of the cluster. Page correction
    // never touches it (lightness is scene lighting), but sheet-row
    // harmonization needs it: both rows of a reference sheet are the same
    // garment under the same studio light, so a lightness gap there is drift,
    // not illumination.
    clusters.push({ hueRad: Math.atan2(bb, a), chroma: Math.hypot(a, bb), a, b: bb, L: sL / wsum, count: cnt, weight: wsum });
  }
  return clusters;
}

/**
 * Dominant garment hue = the highest-weight cluster. Thin wrapper over
 * sampleGarmentClusters, kept as the single-cluster entry point.
 * @returns {{ hueRad:number, chroma:number, a:number, b:number, count:number }|null}
 */
function sampleGarmentHue(raw, n, maskBin, cast, opts = {}) {
  const clusters = sampleGarmentClusters(raw, n, maskBin, cast, opts, 1);
  return clusters.length ? clusters[0] : null;
}

/**
 * DECISION: given the page garment sample and the avatar target, decide whether
 * to correct and by how much. Pure — no image output.
 * @param {{hueRad,chroma,count}} garment  page garment sample (discounted)
 * @param {{hueRad,chroma}} avatar         avatar garment sample (discounted)
 * @param {object} opts  thresholds
 * @returns {{ applied:boolean, reason:string, driftDeg:number, rotationDeg:number,
 *             garmentHueDeg:number, avatarHueDeg:number }}
 */
function decideHueCorrection(garment, avatarIn, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!garment) return { applied: false, reason: 'no garment sample', driftDeg: 0, rotationDeg: 0, garmentHueDeg: null, avatarHueDeg: null };
  // The avatar target may be a single sample (legacy) or a list of hue clusters.
  // A character usually wears TWO coloured garments (pink top + blue jeans); the
  // page mask and the avatar sheet can each be dominated by a different one, so
  // comparing dominant-to-dominant invents a ~180° "drift". Match the page
  // cluster to the NEAREST avatar cluster instead — the association threshold IS
  // hueDriftMaxDeg, so an unmatchable hue still reads as a garment-TYPE error.
  const avatarList = Array.isArray(avatarIn) ? avatarIn.filter(Boolean) : (avatarIn ? [avatarIn] : []);
  if (!avatarList.length) return { applied: false, reason: 'no avatar sample', driftDeg: 0, rotationDeg: 0, garmentHueDeg: +(garment.hueRad * DEG).toFixed(1), avatarHueDeg: null };
  const garmentHueDeg = +(garment.hueRad * DEG).toFixed(1);
  // A target must (a) have a usable hue and (b) be a MAJOR colour on the sheet.
  // Cropping the avatar to its torso band removes most hair, but long hair falls
  // over the torso and still yields a small cluster — and nearest-cluster
  // matching will happily choose it. On a red-haired character that let an
  // ORANGE shirt match her hair (18.7 chroma, ~11% of the sheet's garment
  // evidence) at 3.8 deg and be blessed, while the real YELLOW shirt sat 67 deg
  // away. Requiring a target to carry a real share of the evidence keeps minor
  // patches out of the running while leaving genuine second garments (a top AND
  // trousers) eligible.
  const maxWeight = avatarList.reduce((m, c) => Math.max(m, c.weight || 0), 0);
  const usable = avatarList.filter(c =>
    c.chroma >= cfg.chromaMin && (!maxWeight || (c.weight || 0) >= cfg.minTargetWeightFrac * maxWeight));
  if (garment.chroma < cfg.chromaMin || !usable.length) {
    const best = avatarList.reduce((m, c) => (c.chroma > m.chroma ? c : m), avatarList[0]);
    return { applied: false, reason: `low chroma (garment ${garment.chroma.toFixed(1)}, avatar ${best.chroma.toFixed(1)}; min ${cfg.chromaMin})`, driftDeg: 0, rotationDeg: 0, garmentHueDeg, avatarHueDeg: +(best.hueRad * DEG).toFixed(1) };
  }
  // Nearest avatar cluster by absolute hue distance.
  let avatar = usable[0], driftRad = angDiff(garment.hueRad, usable[0].hueRad);
  for (const c of usable) {
    const d = angDiff(garment.hueRad, c.hueRad);
    if (Math.abs(d) < Math.abs(driftRad)) { avatar = c; driftRad = d; }
  }
  const avatarHueDeg = +(avatar.hueRad * DEG).toFixed(1);
  // Carry the matched cluster itself out: callers render a colour swatch of the
  // exact target, and "hue 43.7°" alone cannot be turned back into a colour.
  const avatarCluster = avatar;
  const driftDeg = +(driftRad * DEG).toFixed(1);
  const absDrift = Math.abs(driftDeg);
  if (absDrift < cfg.hueDriftMinDeg) {
    return { applied: false, reason: `below threshold (${absDrift.toFixed(1)}° < ${cfg.hueDriftMinDeg}°)`, driftDeg, rotationDeg: 0, garmentHueDeg, avatarHueDeg, avatarCluster };
  }
  if (absDrift > cfg.hueDriftMaxDeg) {
    return { applied: false, reason: `drift too large (${absDrift.toFixed(1)}° > ${cfg.hueDriftMaxDeg}° — likely garment-type error, defer to eval/repair)`, driftDeg, rotationDeg: 0, garmentHueDeg, avatarHueDeg, avatarCluster };
  }
  // Apply the drift, hard-capped (redundant with the max check but explicit).
  const rotationDeg = Math.max(-cfg.hueDriftMaxDeg, Math.min(cfg.hueDriftMaxDeg, driftDeg));
  return { applied: true, reason: 'correct outlier', driftDeg, rotationDeg, garmentHueDeg, avatarHueDeg, avatarCluster };
}

/**
 * APPLICATION: rotate the (a*,b*) vector of the selected garment pixels by
 * `rotationRad`, preserving L* and the chroma magnitude |(a*,b*)|. Selection is
 * soft: a pixel's weight is a Gaussian on the angular distance between its
 * ILLUMINATION-DISCOUNTED hue and the cluster hue, zeroed outside the window —
 * so only the drifted garment colour rotates; other garments / skin / hair /
 * background stay put. Rotation about the ORIGIN preserves L* and total chroma
 * EXACTLY (a 2D rotation is norm-preserving; L* is never read or written).
 * @returns {Buffer} new RGB buffer (input is not mutated)
 */
function applyHueRotation(raw, n, maskBin, { clusterHueRad, cast, rotationRad, hueWindowDeg, sigmaDeg } = {}) {
  const win = (hueWindowDeg ?? DEFAULTS.hueWindowDeg) * RAD;
  const sigma = (sigmaDeg ?? DEFAULTS.sigmaDeg) * RAD;
  const out = Buffer.from(raw);
  for (let i = 0; i < n; i++) {
    if (maskBin && maskBin[i] <= 128) continue;
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    if (!isGarmentPixel(r, g, b)) continue;
    const lab = _rgbToLab(r, g, b);
    const a = lab[1], bb = lab[2];
    // Selection by DISCOUNTED hue (so the cast doesn't push a pixel out of the
    // window). Application rotates the FULL vector (preserves total chroma).
    const da = a - cast.a, db = bb - cast.b;
    const chroma = Math.hypot(da, db);
    if (chroma < 1) continue;
    const ang = Math.atan2(db, da);
    const dist = Math.abs(angDiff(clusterHueRad, ang));
    if (dist > win) continue;
    const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
    const phi = w * rotationRad;
    const cs = Math.cos(phi), sn = Math.sin(phi);
    const na = a * cs - bb * sn;
    const nb = a * sn + bb * cs;
    const rgb = _labToRgb(lab[0], na, nb); // L* untouched
    out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
  }
  return out;
}

/**
 * Full deterministic core on RAW buffers + masks. Estimates the cast, samples
 * the page garment + avatar garment (both discounted), decides, and (if an
 * outlier) applies the masked hue rotation.
 * @param {object} args
 * @param {Buffer} args.pageRaw     page RGB (n*3)
 * @param {number} args.n           page pixel count
 * @param {Buffer|null} args.pageMask  figure silhouette (0/255) or null
 * @param {Buffer} args.avatarRaw   avatar RGB (avatarN*3)
 * @param {number} args.avatarN     avatar pixel count
 * @param {Buffer|null} args.avatarMask  avatar figure silhouette or null
 * @param {object} args.opts        thresholds
 * @returns {{ applied, reason, driftDeg, rotationDeg, garmentHueDeg, avatarHueDeg,
 *             cast, avatarCast, correctedRaw }}
 */
function normalizeGarmentRaw({ pageRaw, n, pageMask, sampleMask, castMask, avatarRaw, avatarN, avatarMask, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts };
  // Scene cast: gray-world over the page BACKGROUND (outside every figure), not
  // the whole frame. A figure that fills much of the frame otherwise dominates
  // the mean, so its own garment colour lands in the "illumination" estimate and
  // discounting cancels the very signal we came to measure. Fall back to the
  // whole frame when the background is too small to be a confident estimate.
  let cast = estimateCast(pageRaw, n, castMask || null);
  if (cast.count < cfg.minPagePixels) cast = estimateCast(pageRaw, n, null);
  if (cast.count < cfg.minPagePixels) {
    return { applied: false, reason: `low-confidence cast (${cast.count} px)`, driftDeg: 0, rotationDeg: 0, garmentHueDeg: null, avatarHueDeg: null, cast, correctedRaw: pageRaw };
  }
  // Avatar cast: NONE. A styled avatar sheet is a neutral-lit reference render
  // on a plain background — it carries no scene illumination to discount, and a
  // gray-world mean over it is mostly the garment itself (measured: a pink top
  // yields cast (6.9, 3.6), and discounting it collapses chroma 27.2 → 6.5 and
  // flips the hue ~162°). Read the avatar hue in ABSOLUTE LAB space.
  const avatarCast = { a: 0, b: 0, count: avatarN };
  // MEASURE inside sampleMask (tight, high signal — e.g. the torso band), but
  // APPLY across pageMask (the whole figure). They must not be the same mask: a
  // full-length dress reads its hue from the bodice yet has to rotate all the
  // way down, and rotating only the sampling rectangle leaves a hard horizontal
  // seam mid-garment. Which pixels actually move is decided by the hue window in
  // applyHueRotation, not by the extent of the mask.
  const garment = sampleGarmentHue(pageRaw, n, sampleMask || pageMask, cast, cfg);
  const avatar = sampleGarmentClusters(avatarRaw, avatarN, avatarMask, avatarCast, cfg, 3);
  if (garment && garment.count < cfg.minGarmentPixels) {
    return { applied: false, reason: `too few garment px (${garment.count})`, driftDeg: 0, rotationDeg: 0, garmentHueDeg: +(garment.hueRad * DEG).toFixed(1), avatarHueDeg: avatar.length ? +(avatar[0].hueRad * DEG).toFixed(1) : null, cast, avatarCast, correctedRaw: pageRaw };
  }
  const decision = decideHueCorrection(garment, avatar, cfg);
  // Colour SWATCHES for the Test Lab shift summary. Hue angles alone cannot be
  // turned back into a colour, so emit the three actual RGB triples the reader
  // needs: what the page garment IS, what the avatar target is, and what the
  // garment BECOMES. The garment sample lives in cast-discounted space, so the
  // cast is added back to recover the colour as actually rendered on the page.
  const swatches = (() => {
    if (!garment) return null;
    const asRgb = (L, a, b) => { const c = _labToRgb(L, a, b); return [c[0], c[1], c[2]]; };
    const before = asRgb(garment.L, garment.a + cast.a, garment.b + cast.b);
    const target = decision.avatarCluster
      ? asRgb(decision.avatarCluster.L, decision.avatarCluster.a, decision.avatarCluster.b)
      : null;
    // AFTER = the same rotation applyHueRotation performs, at full weight.
    const phi = (decision.rotationDeg || 0) * RAD;
    const cs = Math.cos(phi), sn = Math.sin(phi);
    const ra = garment.a * cs - garment.b * sn, rb = garment.a * sn + garment.b * cs;
    const after = asRgb(garment.L, ra + cast.a, rb + cast.b);
    return { before, target, after };
  })();
  if (!decision.applied) {
    return { ...decision, cast, avatarCast, swatches, correctedRaw: pageRaw };
  }
  const correctedRaw = applyHueRotation(pageRaw, n, pageMask, {
    clusterHueRad: garment.hueRad,
    cast,
    rotationRad: decision.rotationDeg * RAD,
    hueWindowDeg: cfg.hueWindowDeg,
    sigmaDeg: cfg.sigmaDeg,
  });
  return { ...decision, cast, avatarCast, swatches, garmentChroma: +garment.chroma.toFixed(1), avatarClusters: avatar.map(c => ({ hueDeg: +(c.hueRad * DEG).toFixed(1), chroma: +c.chroma.toFixed(1) })), correctedRaw };
}

// ── async orchestration (decode + mask + composite) ──────────────────────────

/** Decode an image (data URI / Buffer) to a fixed-size raw RGB buffer. */
async function toRawAt(input, width, height) {
  const { data } = await sharp(await bytes(input))
    .resize(width, height, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return data;
}
async function bytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') {
    const m = input.match(/^data:[^;]+;base64,(.*)$/);
    return Buffer.from(m ? m[1] : input, 'base64');
  }
  throw new Error('unsupported image input');
}

/**
 * Binarize a page-resolution mask PNG to a 0/255 Buffer at (width,height). The
 * mask can be alpha-carrying or grayscale; we read luma + alpha. Returns null if
 * the mask can't be decoded at the page size.
 */
async function maskToBin(maskPng, width, height) {
  try {
    const { data, info } = await sharp(await bytes(maskPng))
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = width * height;
    const ch = info.channels || 4;
    const bin = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      // dest-in masks carry the silhouette in ALPHA; grayscale masks in luma.
      const alpha = data[i * ch + 3];
      const luma = data[i * ch]; // R (grayscale masks are equal-channel)
      bin[i] = (alpha > 128 && luma > 40) ? 255 : 0;
    }
    return bin;
  } catch {
    return null;
  }
}

/**
 * Torso sub-region of a full-body box [ymin,xmin,ymax,xmax] (0..1). Used ONLY as
 * the fallback when no SAM silhouette is available: the raw bodyBox rectangle
 * includes head (skin + hair), legs and the background in the corners, all of
 * which dilute the garment sample. The torso band is where the primary garment
 * lives, so it is the highest-signal rectangle we can name without a silhouette.
 */
function torsoBoxFromBody(box) {
  if (!Array.isArray(box) || box.length !== 4) return box;
  const [ymin, xmin, ymax, xmax] = box;
  const h = ymax - ymin, w = xmax - xmin;
  return [ymin + 0.20 * h, xmin + 0.18 * w, ymin + 0.58 * h, xmax - 0.18 * w];
}

/**
 * The torso band of a 2×4 styled avatar sheet: the region of the BODY row that
 * shows the primary garment and nothing else. Everything above it is head cells
 * (hair — which `isGarmentPixel` does not reject) and everything below is legs.
 *
 * The row divider is found with the SAME production detector the sheet splitter
 * uses (grok.detectMinVarianceSeparator): the divider is a thin near-uniform
 * line, so it is the minimum-variance row in the middle half. The head and body
 * rows are NOT equal height, so the divider is not at H/2 and must be detected.
 * Falls back to proportional bands if detection fails — never throws.
 */
async function avatarTorsoBand(buf, width, height) {
  const BODY_TOP = 0.22, BODY_BOTTOM = 0.60; // fractions WITHIN the body row
  let splitY = Math.round(height * 0.5);
  try {
    const { detectMinVarianceSeparator } = require('./grok');
    const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const y = detectMinVarianceSeparator(data, info.width, info.height, 'h', 0.25, 0.75);
    if (Number.isFinite(y) && y > 0 && y < height) splitY = Math.round(y * (height / info.height));
  } catch { /* proportional fallback */ }
  const bodyH = height - splitY;
  const top = Math.max(0, Math.min(height - 2, splitY + Math.round(bodyH * BODY_TOP)));
  const h = Math.max(1, Math.min(height - top, Math.round(bodyH * (BODY_BOTTOM - BODY_TOP))));
  return { left: 0, top, width, height: h };
}

/**
 * SEGMENT the garment: the largest connected region of one colour on the figure,
 * plus any same-colour patches elsewhere on it (a sleeve cut off by an arm).
 *
 * This replaces statistical sampling for both measuring AND applying. The
 * histogram sampler never decides "this pixel is shirt" — it assumes the garment
 * dominates a box and takes the modal hue. That assumption is what let a
 * red-haired character's HAIR become the reference, and it is also why a large
 * rotation smeared skin and hair: measurement and application shared one weak
 * criterion, so neither could be trusted past a gentle nudge.
 *
 * Connectivity is the missing signal. Hair, skin and a shirt are contiguous
 * regions of distinct colour; a flood fill gated on LAB distance separates them
 * even when their hues are neighbours, because it also has to cross a colour
 * boundary in SPACE. The head is additionally excluded up front via the
 * detection's faceBox.
 *
 * @param {Buffer} raw   page RGB (n*3)
 * @param {number} W,H   page dims
 * @param {number[]} bodyBox  [ymin,xmin,ymax,xmax] 0..1
 * @param {number[]|null} faceBox  same, excluded from the search
 * @param {object} opts  { regionDeltaE, minRegionPx }
 * @returns {{ mask:Buffer, count:number, meanLab:number[] }|null}
 */
function growGarmentRegion(raw, W, H, bodyBox, faceBox, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const px = (v, d) => Math.max(0, Math.min(d, Math.round(v * d)));
  const y0 = px(bodyBox[0], H), x0 = px(bodyBox[1], W);
  const y1 = px(bodyBox[2], H), x1 = px(bodyBox[3], W);
  if (y1 - y0 < 8 || x1 - x0 < 8) return null;
  const sw = x1 - x0, sh = y1 - y0;

  const lab = new Float32Array(sw * sh * 3);
  const ok = new Uint8Array(sw * sh);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const si = (y - y0) * sw + (x - x0), i = y * W + x;
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    if (!isGarmentPixel(r, g, b)) continue;
    const l = _rgbToLab(r, g, b);
    lab[si * 3] = l[0]; lab[si * 3 + 1] = l[1]; lab[si * 3 + 2] = l[2];
    ok[si] = 1;
  }

  // SEED from the CHEST, not from "the largest region anywhere". Scanning for
  // the biggest connected blob finds dark hair merged with shadow — on the
  // reported page that blob was 12% of the frame and the shirt was untouched.
  // The chest (centre of the body box, just below the chin) is the one place a
  // torso garment is reliably visible.
  const headBottom = faceBox ? px(faceBox[2], H) : y0;
  const sy0 = Math.max(y0, Math.min(y1 - 2, headBottom + Math.round(sh * 0.04)));
  const sy1 = Math.max(sy0 + 1, Math.min(y1, headBottom + Math.round(sh * 0.30)));
  const sx0 = x0 + Math.round(sw * 0.30), sx1 = x0 + Math.round(sw * 0.70);
  const seedLabs = [];
  for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
    const si = (y - y0) * sw + (x - x0);
    if (ok[si]) seedLabs.push([lab[si * 3], lab[si * 3 + 1], lab[si * 3 + 2]]);
  }
  if (seedLabs.length < cfg.minRegionPx / 4) return null;
  // Median per channel — robust to hair strands crossing the chest patch, which
  // a mean would let drag the reference.
  const medOf = (k) => { const v = seedLabs.map(x => x[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const ref = [medOf(0), medOf(1), medOf(2)];
  const dRef = (si) => Math.hypot(ref[0] - lab[si * 3], ref[1] - lab[si * 3 + 1], ref[2] - lab[si * 3 + 2]);

  // Flood fill judged against the FROZEN seed colour. A running mean lets the
  // region walk shade-by-shade out of the garment and into hair or shadow —
  // that is exactly how the first version escaped.
  const seen = new Uint8Array(sw * sh);
  const stack = new Int32Array(sw * sh);
  let top = 0, count = 0;
  const sumLab = [0, 0, 0];
  for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
    const si = (y - y0) * sw + (x - x0);
    if (ok[si] && !seen[si] && dRef(si) <= cfg.regionDeltaE) { seen[si] = 1; stack[top++] = si; }
  }
  const mask = Buffer.alloc(W * H);
  while (top > 0) {
    const si = stack[--top];
    const sy = Math.floor(si / sw), sx = si % sw;
    mask[(y0 + sy) * W + (x0 + sx)] = 255;
    count++;
    sumLab[0] += lab[si * 3]; sumLab[1] += lab[si * 3 + 1]; sumLab[2] += lab[si * 3 + 2];
    for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ny = sy + dy, nx = sx + dx;
      if (ny < 0 || nx < 0 || ny >= sh || nx >= sw) continue;
      const ni = ny * sw + nx;
      if (!ok[ni] || seen[ni] || dRef(ni) > cfg.regionDeltaE) continue;
      seen[ni] = 1; stack[top++] = ni;
    }
  }
  if (count < cfg.minRegionPx) return null;
  const meanLab = [sumLab[0] / count, sumLab[1] / count, sumLab[2] / count];

  // Same-colour patches elsewhere on the figure (a sleeve cut off by an arm).
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const si = (y - y0) * sw + (x - x0), i = y * W + x;
    if (ok[si] && !mask[i] && dRef(si) <= cfg.regionDeltaE) { mask[i] = 255; count++; }
  }
  return { mask, count, meanLab, seedLab: ref };
}

/** A rectangle bodyBox [ymin,xmin,ymax,xmax] (0..1) → 0/255 mask at (w,h). */
function bboxToBin(box, width, height) {
  const n = width * height;
  const bin = Buffer.alloc(n);
  if (!Array.isArray(box) || box.length !== 4) return bin;
  const [ymin, xmin, ymax, xmax] = box;
  const y0 = Math.max(0, Math.round(ymin * height)), y1 = Math.min(height, Math.round(ymax * height));
  const x0 = Math.max(0, Math.round(xmin * width)), x1 = Math.min(width, Math.round(xmax * width));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) bin[y * width + x] = 255;
  return bin;
}

/**
 * Normalize every resolvable figure's garment hue on ONE page image, in place
 * of the eval-triggered redraw. Reuses the SHARED detection SAM mask
 * (`bboxDetection._gdinoMasks`, index-aligned with figures) — no re-detection.
 *
 * @param {string} pageImageData  data URI / base64 of the page image
 * @param {object} bboxDetection  the shared detection (figures[] + _gdinoMasks)
 * @param {Function} resolveAvatar  async (figure) => data-URI of the styled
 *        avatar matching THIS page's clothing for that figure, or null to skip
 * @param {object} options  { opts (thresholds), logLabel, collectCrops }
 * @returns {Promise<{ changed:boolean, correctedImageData:string, perFigure:Array }>}
 */
async function normalizeGarmentHue(pageImageData, bboxDetection, resolveAvatar, options = {}) {
  const { opts = {}, logLabel = '', collectCrops = false } = options;
  const cfg = { ...DEFAULTS, ...opts };
  // disable: hard no-op that returns the page untouched — used by the Test Lab
  // "colour on/off" A/B as the OFF baseline (same input, no normalization).
  if (cfg.disable) return { changed: false, correctedImageData: pageImageData, perFigure: [], disabled: true };
  const figures = bboxDetection?.figures || [];
  const masks = bboxDetection?._gdinoMasks || null;
  const perFigure = [];
  if (!figures.length) return { changed: false, correctedImageData: pageImageData, perFigure };

  const pageBuf = await bytes(pageImageData);
  const meta = await sharp(pageBuf).metadata();
  // Work at a bounded resolution for the deterministic math (speed); composite
  // the correction back at full resolution at the end.
  const W = Math.min(meta.width || 768, 768);
  const H = Math.round((meta.height || 1024) * (W / (meta.width || 768)));
  const n = W * H;
  const pageRaw = await toRawAt(pageBuf, W, H);
  let workingRaw = pageRaw;
  let anyChange = false;

  // Background mask for the illumination estimate: everything outside EVERY
  // figure (SAM silhouette when present, full bodyBox otherwise — deliberately
  // the full box here, not the torso band, so no part of a figure leaks into the
  // "illumination" mean). Built once and shared by all figures on this page.
  const castMask = Buffer.alloc(n, 255);
  for (let fi = 0; fi < figures.length; fi++) {
    let occ = null;
    if (masks && masks[fi]) occ = await maskToBin(masks[fi], W, H);
    if ((!occ || !occ.some(v => v)) && Array.isArray(figures[fi]?.bodyBox)) occ = bboxToBin(figures[fi].bodyBox, W, H);
    if (!occ) continue;
    for (let i = 0; i < n; i++) if (occ[i] > 128) castMask[i] = 0;
  }

  for (let fi = 0; fi < figures.length; fi++) {
    const fig = figures[fi];
    const name = fig?.name || `fig${fi}`;
    let avatarUri = null;
    try { avatarUri = await resolveAvatar(fig); } catch { avatarUri = null; }
    if (!avatarUri) { perFigure.push({ name, applied: false, reason: 'no avatar resolved' }); continue; }

    // TWO masks, deliberately different (see normalizeGarmentRaw):
    //   pageMask   — where the rotation may be APPLIED: the whole figure.
    //   sampleMask — where the hue is MEASURED: tight and high-signal.
    // With a SAM silhouette both are the silhouette. Without one we apply over
    // the full bodyBox but measure only its TORSO band, because the raw
    // rectangle carries head, legs and corner background that dilute the sample.
    let pageMask = null, sampleMask = null, maskSource = 'sam';
    if (masks && masks[fi]) pageMask = await maskToBin(masks[fi], W, H);
    if ((!pageMask || !pageMask.some(v => v)) && Array.isArray(fig.bodyBox)) {
      pageMask = bboxToBin(fig.bodyBox, W, H);
      sampleMask = bboxToBin(torsoBoxFromBody(fig.bodyBox), W, H);
      maskSource = 'bodyBox+torsoSample';
    }
    if (!pageMask) { perFigure.push({ name, applied: false, reason: 'no mask' }); continue; }

    // Avatar raw, cropped to the styled sheet's TORSO BAND.
    //
    // This crop is not an optimisation, it is a correctness fix. `isGarmentPixel`
    // rejects skin and grey but NOT hair, and a 2×4 sheet is mostly head cells —
    // so on a red-haired character the sheet yields a strong red-orange cluster
    // that is her HAIR. Sampling the whole sheet then offers that cluster as a
    // legitimate target, and nearest-cluster matching happily picks it: an
    // ORANGE shirt on the page landed 3.8° from the hair cluster and was blessed
    // as "below threshold", while the real target — her YELLOW shirt at 106.3° —
    // sat 70° away and would have been deferred as a garment-type error.
    // Cropping to the torso of the body row makes hair unreachable as a target.
    let avatarRaw, avatarN;
    try {
      const abuf = await bytes(avatarUri);
      const am = await sharp(abuf).metadata();
      const band = await avatarTorsoBand(abuf, am.width, am.height);
      const aw = Math.min(band.width || 384, 384);
      const ah = Math.max(1, Math.round(band.height * (aw / band.width)));
      avatarRaw = await toRawAt(await sharp(abuf).extract(band).png().toBuffer(), aw, ah);
      avatarN = aw * ah;
    } catch (e) {
      perFigure.push({ name, applied: false, reason: `avatar decode failed: ${e.message}` });
      continue;
    }

    const res = normalizeGarmentRaw({ pageRaw: workingRaw, n, pageMask, sampleMask, castMask, avatarRaw, avatarN, avatarMask: null, opts: cfg });
    const entry = {
      name,
      applied: res.applied,
      reason: res.reason,
      driftDeg: res.driftDeg,
      rotationDeg: res.rotationDeg,
      garmentHueDeg: res.garmentHueDeg,
      avatarHueDeg: res.avatarHueDeg,
      avatarClusters: res.avatarClusters || null,
      cast: res.cast ? { a: +res.cast.a.toFixed(1), b: +res.cast.b.toFixed(1) } : null,
      maskSource,
    };
    // Crops + reference for EVERY figure, corrected or not. "How did each
    // character shift" has to include the ones that did NOT shift and say why —
    // a summary that only shows the corrected figures hides the skips, which are
    // the majority and the more interesting half.
    entry.swatches = res.swatches || null;
    if (collectCrops && Array.isArray(fig.bodyBox)) {
      try {
        entry.beforeCrop = await cropDataUri(workingRaw, W, H, fig.bodyBox);
        entry.afterCrop = res.applied
          ? await cropDataUri(res.correctedRaw, W, H, fig.bodyBox)
          : entry.beforeCrop; // unchanged — same bytes both sides
        // The styled avatar sheet the target hue was read FROM — so a reviewer
        // can judge the correction against its reference, not just before/after.
        entry.referenceSheet = avatarUri;
      } catch { /* crops are a debugging aid; ignore failure */ }
    }
    if (res.applied) {
      workingRaw = res.correctedRaw;
      anyChange = true;
      log.info(`🎨 [GARMENT-HUE] ${logLabel}${name}: rotated ${res.rotationDeg}° (drift ${res.driftDeg}°, garment ${res.garmentHueDeg}°→avatar ${res.avatarHueDeg}°, mask ${entry.maskSource})`);
    } else {
      log.debug(`🎨 [GARMENT-HUE] ${logLabel}${name}: no-op (${res.reason})`);
    }
    perFigure.push(entry);
  }

  if (!anyChange) return { changed: false, correctedImageData: pageImageData, perFigure };

  // Composite the low-res correction back at FULL resolution: upscale the
  // corrected working buffer to the page size and re-encode. The correction is
  // a per-pixel hue rotation, so a resize is a benign resample (no geometry).
  const corrected = await sharp(workingRaw, { raw: { width: W, height: H, channels: 3 } })
    .resize(meta.width, meta.height, { fit: 'fill' })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { changed: true, correctedImageData: `data:image/jpeg;base64,${corrected.toString('base64')}`, perFigure };
}

// ── Full-chain batch driver (shared by the initial pre-eval pass AND every
//    repair round) ────────────────────────────────────────────────────────────
//
// The garment-hue correction must run BEFORE every quality eval in the
// generation→repair chain, not just the first. The initial pass (server.js
// Phase 5b-hue) corrects the freshly-generated pages; but the repair pipeline
// then REDRAWS pages over up to 3 rounds (iterate / char-fix / inpaint), and a
// redraw can reintroduce the exact colour drift the first pass fixed — so a
// repaired page could ship with garment-colour drift, and a redraw's drift
// could even waste a repair round. This one driver runs the per-page
// normalizeGarmentHue on a batch and is called at BOTH seams, so there is ONE
// implementation for the whole chain.
//
// Each call site supplies its own avatar/clothing lookup (resolveAvatarForPage)
// and its own image/detection accessors, so the initial pass (img.imageData +
// img.sharedBboxDetection) and the per-round pass (roundResult.imageData +
// roundResult.bboxDetection) reuse this code path without copy-paste.
//
// Detection is REUSED, never forced: only images that already carry a detection
// with ≥1 figure are eligible (the round's own iterate detection, or the shared
// pre-eval detection). An image without a fresh detection at the seam is skipped
// (no-op) rather than paying for an extra detect.

/** Minimal concurrency-limited map (no p-limit dependency — keeps this module
 *  requireable in unit tests that stub the native deps). */
async function _mapLimit(items, limit, fn) {
  const lim = Math.max(1, Math.min(limit | 0 || 1, items.length));
  let idx = 0;
  const workers = Array.from({ length: lim }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * Normalize garment hue across a batch of image entries, reusing each entry's
 * already-computed detection (never forcing a fresh detect). For every changed
 * image: writes the corrected bytes back onto the entry and re-stamps the
 * detection's sourceImageFp so a downstream eval that REUSES the detection reads
 * it against the corrected bytes.
 *
 * @param {Array} images  entries to normalize
 * @param {object} o
 * @param {(pageNumber:number, figure:object)=>Promise<string|null>|string|null} o.resolveAvatarForPage
 *        per-(page,figure) styled-avatar resolver — the avatar data-URI matching
 *        THIS page's clothing for that figure, or null to skip the figure.
 * @param {(img)=>number}        [o.getPageNumber]  read the entry's page number
 * @param {(img)=>string}        [o.getImageData]   read the entry's image bytes
 * @param {(img,data)=>void}     [o.setImageData]   write corrected bytes back
 * @param {(img)=>object|null}   [o.getDetection]   read the entry's detection
 * @param {(data:string)=>string|null} [o.imageFingerprint] re-stamp fingerprinter (injected;
 *        lazily required from ./images when omitted)
 * @param {boolean} [o.enabled=true]   feature gate (call sites pass the flag / wrap the call)
 * @param {number}  [o.concurrency=50] parallel pages
 * @param {string}  [o.logLabel='']    log prefix (e.g. 'Round 2 ')
 * @param {object}  [o.opts={}]        threshold overrides forwarded to normalizeGarmentHue
 * @returns {Promise<{pagesChanged:number, figuresApplied:number, perImage:Array}>}
 */
async function normalizeGarmentHueBatch(images, o = {}) {
  const {
    resolveAvatarForPage,
    getPageNumber = (img) => img.pageNumber,
    getImageData = (img) => img.imageData,
    setImageData = (img, data) => { img.imageData = data; },
    getDetection = (img) => img.sharedBboxDetection,
    imageFingerprint = null,
    enabled = true,
    concurrency = 50,
    logLabel = '',
    opts = {},
  } = o;

  const result = { pagesChanged: 0, figuresApplied: 0, perImage: [] };
  if (!enabled) return result;
  if (!Array.isArray(images) || images.length === 0) return result;
  if (typeof resolveAvatarForPage !== 'function') return result;

  // Only entries that already carry a detection with ≥1 figure are eligible —
  // reuse the detection's SAM mask, never force a fresh detect. The rest no-op.
  const eligible = images.filter((img) => {
    const det = getDetection(img);
    return getImageData(img) && det && Array.isArray(det.figures) && det.figures.length > 0;
  });
  if (eligible.length === 0) return result;

  // Fingerprinter for the re-stamp: injected (server.js / pipeline both pass the
  // canonical images.imageFingerprint) or lazily required. Never fatal.
  let fp = imageFingerprint;
  if (typeof fp !== 'function') {
    try { fp = require('./images').imageFingerprint; } catch { fp = null; }
  }

  await _mapLimit(eligible, concurrency, async (img) => {
    const page = getPageNumber(img);
    try {
      const detection = getDetection(img);
      const resolveAvatar = (fig) => resolveAvatarForPage(page, fig);
      // Call through module.exports so the batch is unit-testable by stubbing
      // normalizeGarmentHue (a same-module reference would not be interceptable).
      const out = await module.exports.normalizeGarmentHue(
        getImageData(img), detection, resolveAvatar,
        { opts, logLabel: `${logLabel}P${page} ` }
      );
      const applied = (out.perFigure || []).filter((f) => f.applied).length;
      result.figuresApplied += applied;
      result.perImage.push({ pageNumber: page, changed: !!out.changed, figuresApplied: applied, perFigure: out.perFigure || [] });
      if (out.changed) {
        setImageData(img, out.correctedImageData);
        // Boxes + SAM masks are geometry — a hue rotation moves nothing. Re-stamp
        // the detection to the corrected bytes so a downstream eval that REUSES
        // it reads it on the corrected pixels instead of paying for a re-detect.
        if (fp && detection) detection.sourceImageFp = fp(out.correctedImageData);
        result.pagesChanged += 1;
      }
    } catch (err) {
      result.perImage.push({ pageNumber: page, changed: false, error: err.message });
      log.warn(`⚠️ [GARMENT-HUE] ${logLabel}P${page}: ${err.message} — leaving page unchanged`);
    }
  });
  return result;
}

async function cropDataUri(raw, W, H, box) {
  const [ymin, xmin, ymax, xmax] = box;
  const left = Math.max(0, Math.round(xmin * W)), top = Math.max(0, Math.round(ymin * H));
  const width = Math.max(1, Math.min(W - left, Math.round((xmax - xmin) * W)));
  const height = Math.max(1, Math.min(H - top, Math.round((ymax - ymin) * H)));
  const buf = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left, top, width, height }).jpeg({ quality: 88 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

// Lazy logger to avoid a require cycle at module load.
const log = new Proxy({}, { get: (_t, level) => (...a) => { try { require('../utils/logger')[level](...a); } catch { /* no logger in unit tests */ } } });

module.exports = {
  normalizeGarmentHue,
  // full-chain batch driver (initial pre-eval pass + every repair round)
  normalizeGarmentHueBatch,
  // deterministic core — unit-tested directly on synthetic buffers
  normalizeGarmentRaw,
  estimateCast,
  sampleGarmentHue,
  sampleGarmentClusters,
  growGarmentRegion,
  torsoBoxFromBody,
  decideHueCorrection,
  applyHueRotation,
  isGarmentPixel,
  DEFAULTS,
  _internal: { avatarTorsoBand },
};
