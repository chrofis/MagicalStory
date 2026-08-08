// Garment colour SAMPLING — a shared toolkit, no longer a pass.
//
// This file was the lighting-aware garment HUE normalization pass: it ran before
// every eval and rotated a drifted garment hue toward the styled avatar's while
// preserving L* and chroma. RETIRED 2026-08-08 (owner decision) in favour of
// server/lib/garmentColourFix.js, which is better on the two things that decide
// whether a colour repair works:
//
//   1. IDENTIFYING the garment. This pass never did — it took the modal hue of a
//      box and assumed the garment dominated it. On a red-haired character the
//      modal hue WAS her hair, so an ORANGE shirt matched the hair at 3.8 deg and
//      passed as correct while her real yellow top sat 70 deg away.
//      garmentColourFix segments it: GroundingDINO text->box, MobileSAM box->mask.
//   2. REACHING the target. Rotating hue alone cannot. With a yellow's a*/b*,
//      L=45 is olive and L=75 is yellow — measured, this pass hit the target hue
//      exactly (102.9 vs 103.2) and still looked wrong because L* was pinned.
//      garmentColourFix moves the whole L*a*b* vector, scaled by a skin-probed
//      lighting factor.
//
// What survives is the colour MATHS both successors import — the skin/grey
// rejection and the chroma-weighted hue clustering — kept in one place so the
// page sampler and the avatar sampler cannot drift apart.
//
// Consumers: garmentColourFix.js, sheetRowHarmonize.js.

const sharp = require('sharp');
const { _rgbToLab } = require('./images');

// Sampler thresholds. The pass-level knobs (drift min/max, rotation cap, page
// cast confidence floors) were retired with the pass.
const DEFAULTS = {
  // A near-grey garment has an ill-defined hue — clusters below this are noise.
  chromaMin: numEnv('GARMENT_HUE_CHROMA_MIN', 8),
  // Angular width of a hue cluster: how far from a histogram peak a pixel may
  // sit and still count as the same colour.
  hueWindowDeg: numEnv('GARMENT_HUE_WINDOW_DEG', 40),
};

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

function numEnv(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}
function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
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
function isGarmentPixel(r, g, b) {
  const [h, s, l] = rgb2hsl(r, g, b);
  if (h >= 7 && h <= 50 && s >= 0.15 && s <= 0.65 && l >= 0.35 && l <= 0.88) return false; // skin
  if (s < 0.12) return false; // grey / white / black
  return true;
}
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

module.exports = {
  isGarmentPixel,
  sampleGarmentClusters,
  DEFAULTS,
  // Consumed as _internal by garmentColourFix (avatar target sampling).
  _internal: { avatarTorsoBand },
};
