// Row-to-row garment colour consistency for the 2×4 character reference sheet.
//
// Problem this solves: the sheet is generated in two passes — Pass 1 renders a
// photorealistic 2×4 grid (4 heads on top, 4 full bodies below), Pass 2 asks the
// model to re-render the WHOLE grid in the story's art style. Pass 2 sometimes
// stylises only the top row and leaves the bottom row photographic. The visible
// symptom is a garment that reads as two different colours on the same sheet:
// measured on a real staging sheet, the same pink top came out hue 0.0° /
// chroma 32.8 in the head row and hue 7.3° / chroma 10.0 in the body row — same
// hue, 3.3× the saturation, which the eye reads as "a totally different pink".
//
// That sheet is the CANONICAL reference: story pages are generated against it
// and `garmentHueNormalize` corrects page garments toward it. A sheet that
// disagrees with itself makes "the character's colour" undefined, so every
// downstream consumer picks whichever row happened to dominate its sample.
//
// Two functions, deliberately separate:
//   measureRowConsistency() — pure measurement, no mutation. Used as a
//     DETERMINISTIC gate in the Pass-2 retry loop, because the Gemini judge
//     that is supposed to catch this ("No cell may stay photographic while the
//     others are stylised") demonstrably passes sheets that exhibit it.
//   harmonizeSheetRows()   — the backstop. Moves the WEAKER row's garment onto
//     the stronger row's colour by a mean LAB offset, inside the matched
//     garment's hue window only.
//
// Authority row: whichever side shows the matched garment with HIGHER chroma.
// This is not a head-row/body-row preference — it follows the failure mode.
// Stylisation raises saturation; an unstylised (still photographic) row is the
// washed-out one. Picking by chroma therefore repairs whichever row failed,
// without assuming which pass dropped the ball.
//
// The head cells are specified as "head and neck only", so on many sheets the
// top row shows little or no garment. When either row lacks a usable garment
// sample we SKIP rather than invent a colour — same principle as
// garmentHueNormalize's chroma floor.

const sharp = require('sharp');
const { _rgbToLab, _labToRgb } = require('./imageCompositing');
const { sampleGarmentClusters, isGarmentPixel } = require('./garmentHueNormalize');

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

const DEFAULTS = {
  // Rows disagree beyond either of these → the sheet is inconsistent.
  maxRowHueDeg: 12,
  maxChromaRatio: 1.6,
  // A row's garment sample must clear these to be usable at all.
  chromaMin: 8,
  minRowGarmentPx: 300,
  // The two rows' clusters must be within this angle to be considered the SAME
  // garment. Beyond it they are different garments (a head-row scarf vs a
  // body-row coat) and there is nothing to harmonise.
  maxAssocDeg: 30,
  // Selection window + falloff around the matched hue, mirroring
  // garmentHueNormalize so the two passes agree on what "the garment" is.
  hueWindowDeg: 40,
  sigmaDeg: 22,
  // Hard caps on the LAB move — a mis-association can never repaint a garment
  // wholesale. These are a SECOND belt: maxAssocDeg has already guaranteed the
  // two clusters share a hue family, so the cap only has to bound how far apart
  // "vivid" and "washed out" may be. A real stylised-vs-photographic pink pair
  // measures ~48 in a*, so a tighter cap would leave the correction visibly
  // short of the authority colour.
  maxDeltaL: 35,
  maxDeltaAB: 55,
  // Hair-free sampling bands (fractions). The head cells are "head and neck
  // only", so their garment is the bottom sliver; the body cells put the torso
  // between the head and the legs.
  // Application gates — see applyGarmentColorMatch. A pixel must carry at least
  // this much chroma, and sit within this much lightness of the garment cluster,
  // to be considered part of the garment at all.
  // Deliberately LOW. A washed-out garment is itself low-chroma (a real
  // photographic pink measured 9.8), so a floor set high enough to reject a
  // backdrop on its own would reject most of the garment and leave the shirt
  // mottled. The backdrop is excluded by the LIGHTNESS window instead — white
  // paper sits at L*~97, a garment ~20+ points below it.
  applyChromaMin: 4,
  applyLightnessWindow: 12,
  headRowGarmentBand: 0.25,
  bodyRowTorsoTop: 0.22,
  bodyRowTorsoBottom: 0.60,
};

function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Decode to raw RGB at native size. */
async function rawOf(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { raw: data, w: info.width, h: info.height, n: info.width * info.height };
}

function bytesOf(input) {
  if (Buffer.isBuffer(input)) return input;
  const m = String(input).match(/^data:[^;]+;base64,(.*)$/);
  return Buffer.from(m ? m[1] : String(input), 'base64');
}

/**
 * Pair the two rows' garment clusters: take each row's strongest cluster, then
 * find the other row's cluster nearest to it. Returns the best-matching pair,
 * or null when nothing associates within maxAssocDeg.
 */
function pairRowClusters(topClusters, bottomClusters, cfg) {
  const maxAssoc = cfg.maxAssocDeg * RAD;
  let best = null;
  for (const t of topClusters) {
    for (const b of bottomClusters) {
      const d = Math.abs(angDiff(t.hueRad, b.hueRad));
      if (d > maxAssoc) continue;
      // Prefer the pair carrying the most garment evidence, not the closest —
      // a tiny incidental colour match must not beat the actual outfit.
      const weight = Math.min(t.weight, b.weight);
      if (!best || weight > best.weight) best = { top: t, bottom: b, dHueRad: d, weight };
    }
  }
  return best;
}

/**
 * MEASURE row-to-row garment agreement. Pure — never mutates the sheet.
 * @param {string|Buffer} sheetImageData  the full 2×4 sheet
 * @param {number} splitY  row divider (px). Caller supplies it from the shared
 *        detector so this module never re-derives the layout.
 * @param {object} opts
 * @returns {Promise<{consistent:boolean, reason:string, dHueDeg:number|null,
 *          chromaRatio:number|null, top:object|null, bottom:object|null}>}
 */
async function measureRowConsistency(sheetImageData, splitY, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const buf = bytesOf(sheetImageData);
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  if (!(splitY > 0 && splitY < H)) {
    return { consistent: true, reason: `unusable split (y=${splitY} of ${H})`, dHueDeg: null, chromaRatio: null, top: null, bottom: null };
  }
  // Sample BANDS, not whole rows. `isGarmentPixel` rejects skin and grey but NOT
  // hair, and hair is a large, saturated region in both rows — on a real sheet
  // the strongest cross-row pair was the character's brown hair (head 49.9°/
  // chroma 26.8 vs body 43.9°/9.0), not the pink top, and "correcting" that pair
  // darkened the whole body row by ΔL −35. So:
  //   head row → only its BOTTOM band: the neck/shoulder/chest sliver under the
  //     chin, which is the only garment those "head and neck only" cells show.
  //   body row → the TORSO band: below the head, above the legs.
  // Both bands are hair-free by construction.
  const headBandTop = Math.round(splitY * (1 - cfg.headRowGarmentBand));
  const bodyH = H - splitY;
  const [topR, botR] = await Promise.all([
    rawOf(await sharp(buf).extract({ left: 0, top: headBandTop, width: W, height: splitY - headBandTop }).png().toBuffer()),
    rawOf(await sharp(buf).extract({
      left: 0,
      top: splitY + Math.round(bodyH * cfg.bodyRowTorsoTop),
      width: W,
      height: Math.max(1, Math.round(bodyH * (cfg.bodyRowTorsoBottom - cfg.bodyRowTorsoTop))),
    }).png().toBuffer()),
  ]);
  const zero = { a: 0, b: 0 };
  const topC = sampleGarmentClusters(topR.raw, topR.n, null, zero, cfg, 3);
  const botC = sampleGarmentClusters(botR.raw, botR.n, null, zero, cfg, 3);
  const usable = (c) => c.chroma >= cfg.chromaMin && c.count >= cfg.minRowGarmentPx;
  const topU = topC.filter(usable), botU = botC.filter(usable);
  if (!topU.length) return { consistent: true, reason: 'head row shows no usable garment (head-and-neck cells)', dHueDeg: null, chromaRatio: null, top: null, bottom: botU[0] || null };
  if (!botU.length) return { consistent: true, reason: 'body row shows no usable garment', dHueDeg: null, chromaRatio: null, top: topU[0], bottom: null };

  const pair = pairRowClusters(topU, botU, cfg);
  if (!pair) {
    return { consistent: true, reason: `no shared garment between rows (nearest > ${cfg.maxAssocDeg}°)`, dHueDeg: null, chromaRatio: null, top: topU[0], bottom: botU[0] };
  }
  const dHueDeg = +(pair.dHueRad * DEG).toFixed(1);
  const hi = Math.max(pair.top.chroma, pair.bottom.chroma);
  const lo = Math.max(0.1, Math.min(pair.top.chroma, pair.bottom.chroma));
  const chromaRatio = +(hi / lo).toFixed(2);
  const consistent = dHueDeg <= cfg.maxRowHueDeg && chromaRatio <= cfg.maxChromaRatio;
  return {
    consistent,
    reason: consistent
      ? `rows agree (Δhue ${dHueDeg}°, chroma ratio ${chromaRatio})`
      : `rows disagree — Δhue ${dHueDeg}° (max ${cfg.maxRowHueDeg}°), chroma ratio ${chromaRatio} (max ${cfg.maxChromaRatio})`,
    dHueDeg,
    chromaRatio,
    // Display fields PLUS the raw cluster (hueRad/a/b/L) — harmonizeSheetRows
    // computes its LAB offset from these, so they must not be pre-rounded.
    top: { hueDeg: +(pair.top.hueRad * DEG).toFixed(1), chroma: +pair.top.chroma.toFixed(1), px: pair.top.count, hueRad: pair.top.hueRad, a: pair.top.a, b: pair.top.b, L: pair.top.L },
    bottom: { hueDeg: +(pair.bottom.hueRad * DEG).toFixed(1), chroma: +pair.bottom.chroma.toFixed(1), px: pair.bottom.count, hueRad: pair.bottom.hueRad, a: pair.bottom.a, b: pair.bottom.b, L: pair.bottom.L },
  };
}

/**
 * Move the weak row's garment onto the authority's colour by a MEAN OFFSET in
 * full LAB — ΔL*, Δa*, Δb* — applied per pixel with the hue-window weight.
 *
 * Why an offset and not "rotate hue, scale chroma": the two differ in what they
 * can reach. A washed-out photographic pink and a stylised vivid pink differ in
 * LIGHTNESS as much as in saturation (measured: L* 81 vs 57), and you cannot
 * reach the vivid one's chroma at the pale one's lightness — that colour is
 * outside sRGB, so `_labToRgb` clamps, which silently drags L* anyway and still
 * lands short. An offset walks the whole LAB vector to a colour that is in
 * gamut by construction (the authority row is a real rendered pixel), and
 * because it is an offset rather than a replacement it preserves the weak row's
 * own fold/shading variation.
 *
 * Touching L* here is correct ONLY because this is a reference SHEET: both rows
 * are the same garment under the same flat studio light, so a lightness gap is
 * drift. On a story page it would be wrong — there L* carries scene lighting,
 * which is why garmentHueNormalize deliberately preserves it.
 *
 * @returns {Buffer} new RGB buffer (input not mutated)
 */
function applyGarmentColorMatch(raw, n, { clusterHueRad, clusterChroma, clusterL, dL, da, db, hueWindowDeg, sigmaDeg, applyChromaMin, maxDeltaL: lWin }) {
  const win = hueWindowDeg * RAD;
  const sigma = sigmaDeg * RAD;
  // A hue ANGLE alone does not identify the garment: a near-white background
  // pixel has a tiny (a*,b*) vector whose angle can land anywhere, including
  // inside the window — and then the LAB offset slams it to saturated colour.
  // That is exactly how a first cut of this repainted a white studio backdrop
  // pink. Gate on the full colour: the pixel must carry real chroma, sit near
  // the cluster's lightness, and its weight ramps with how close its saturation
  // is to the garment's.
  const chromaFloor = Math.max(applyChromaMin, 0.25 * clusterChroma);
  const out = Buffer.from(raw);
  for (let i = 0; i < n; i++) {
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    if (!isGarmentPixel(r, g, b)) continue;
    const lab = _rgbToLab(r, g, b);
    const a = lab[1], bb = lab[2];
    const chroma = Math.hypot(a, bb);
    if (chroma < chromaFloor) continue;
    const dist = Math.abs(angDiff(clusterHueRad, Math.atan2(bb, a)));
    if (dist > win) continue;
    // Lightness gate: the garment's own shading spans a range, but a pixel far
    // outside it (a white backdrop at L*98 vs a garment at L*72) is not it.
    const dLpix = Math.abs(lab[0] - clusterL);
    if (dLpix > lWin) continue;
    // Weight on HUE DISTANCE ONLY. The chroma and lightness tests above are
    // hard in/out gates — folding them into the weight as well made the move
    // proportional to each pixel's own saturation, so the pale highlights of a
    // washed-out garment barely moved while its saturated folds moved fully,
    // and the shirt came out visibly mottled. Inside the garment the offset
    // must be UNIFORM; because it is an offset and not a replacement, the
    // garment's own shading survives it. The hue ramp is kept so the correction
    // fades smoothly at the boundary with a neighbouring colour.
    const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
    const rgb = _labToRgb(lab[0] + w * dL, a + w * da, bb + w * db);
    out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
  }
  return out;
}

/**
 * BACKSTOP: bring the weaker row's garment onto the stronger row's colour.
 * No-op (returns the input unchanged) whenever the rows already agree, either
 * row has no usable garment sample, or the two rows show different garments.
 * @param {string|Buffer} sheetImageData
 * @param {number} splitY  row divider from the shared detector
 * @returns {Promise<{changed:boolean, imageData:string, measurement:object,
 *          authority:string|null, deltaLab:{L:number,a:number,b:number}|null}>}
 */
async function harmonizeSheetRows(sheetImageData, splitY, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const asDataUri = (b) => 'data:image/jpeg;base64,' + b.toString('base64');
  const buf = bytesOf(sheetImageData);
  const measurement = await measureRowConsistency(buf, splitY, cfg);
  const noop = { changed: false, imageData: typeof sheetImageData === 'string' ? sheetImageData : asDataUri(buf), measurement, authority: null, deltaLab: null };
  if (measurement.consistent || !measurement.top || !measurement.bottom) return noop;

  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  // The authority is the row whose matched garment carries MORE chroma — the
  // stylised one. The other row gets corrected onto it.
  const topIsAuthority = measurement.top.chroma >= measurement.bottom.chroma;
  const authority = topIsAuthority ? measurement.top : measurement.bottom;
  const weak = topIsAuthority ? measurement.bottom : measurement.top;
  const weakBox = topIsAuthority
    ? { left: 0, top: splitY, width: W, height: H - splitY }
    : { left: 0, top: 0, width: W, height: splitY };

  // Mean LAB offset weak → authority, capped so a bad association can never
  // repaint a garment wholesale.
  const cap = (v, m) => Math.max(-m, Math.min(m, v));
  const dL = cap(authority.L - weak.L, cfg.maxDeltaL);
  const da = cap(authority.a - weak.a, cfg.maxDeltaAB);
  const db = cap(authority.b - weak.b, cfg.maxDeltaAB);

  const weakPng = await sharp(buf).extract(weakBox).png().toBuffer();
  const { raw, w, h, n } = await rawOf(weakPng);
  const corrected = applyGarmentColorMatch(raw, n, {
    clusterHueRad: weak.hueRad,
    clusterChroma: weak.chroma,
    clusterL: weak.L,
    dL, da, db,
    hueWindowDeg: cfg.hueWindowDeg,
    sigmaDeg: cfg.sigmaDeg,
    applyChromaMin: cfg.applyChromaMin,
    maxDeltaL: cfg.applyLightnessWindow,
  });
  const correctedPng = await sharp(corrected, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const merged = await sharp(buf)
    .composite([{ input: correctedPng, left: weakBox.left, top: weakBox.top }])
    .jpeg({ quality: 95 })
    .toBuffer();

  return {
    changed: true,
    imageData: asDataUri(merged),
    measurement,
    authority: topIsAuthority ? 'headRow' : 'bodyRow',
    deltaLab: { L: +dL.toFixed(1), a: +da.toFixed(1), b: +db.toFixed(1) },
  };
}

module.exports = {
  measureRowConsistency,
  harmonizeSheetRows,
  // pure pieces — unit-tested directly
  pairRowClusters,
  applyGarmentColorMatch,
  DEFAULTS,
};
