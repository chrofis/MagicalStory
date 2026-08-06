// Mechanical garment-colour repair — the CONSUMER of the entity check's
// `garmentColourMismatches` channel.
//
// The entity consistency grid already tells us, for free, which page shows a
// character's garment in the wrong colour (see decisions.md 2026-08-06). That
// finding deliberately carries no severity points and never triggers a redraw,
// because a garment of the right shape in the wrong colour is fixable
// deterministically. This module is that fix.
//
// Why it does NOT reuse garmentHueNormalize's approach:
//   1. That pass never identifies the garment — it takes the modal hue of a box
//      and hopes the garment dominates. On a red-haired character the modal hue
//      WAS her hair, and an orange shirt matched it at 3.8 deg and was blessed.
//      Here the garment comes from GroundingDINO (text -> box) + MobileSAM
//      (box -> silhouette), so the mask is the garment and nothing else.
//   2. That pass rotates hue only, preserving L*. That cannot reach yellow: with
//      a yellow's a*/b*, L=45 is olive and L=75 is yellow. The measured case
//      landed on the exact target hue (102.9 vs 103.2) and still looked wrong.
//      Here the whole L*a*b* vector moves.
//
// The move is a mean OFFSET, not a replacement — every pixel keeps its own
// deviation from the garment mean, so folds, seams and highlights survive.
//
// Lighting: the target is the character's canonical garment colour from the
// STYLED AVATAR, scaled by a per-figure lighting factor probed from SKIN. Skin
// is the same material on both images, so a lightness difference between the
// page face and the avatar face is illumination, not drift. Without that scale
// a night scene would be dragged to studio brightness.

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { _rgbToLab, _labToRgb } = require('./images');
const { sampleGarmentClusters, isGarmentPixel } = require('./garmentHueNormalize');

const DEG = 180 / Math.PI;

const DEFAULTS = {
  // GroundingDINO garment query. Colour-agnostic on purpose: naming the colour
  // we EXPECT would bias the detector toward finding it, and naming the colour
  // we SEE requires knowing it first. Measured 0.62-0.82 across three pages.
  garmentPrompt: 'the shirt or top worn by the person',
  boxThreshold: 0.18,
  textThreshold: 0.14,
  // Crop padding around the figure box before asking for the garment.
  cropPad: 0.02,
  // Lighting factor bounds. Outside these the skin probe is not believable
  // (blown highlights, a face in deep shadow) and we fall back to 1.
  lightingMin: 0.55,
  lightingMax: 1.35,
  // Hard caps on the L*a*b* move, so a mis-detected mask can never repaint a
  // garment into an arbitrary colour.
  maxDeltaL: 40,
  maxDeltaAB: 60,
  // Colour-gated mask growth — see dilateMaskByColour. Radius is the hard
  // bound (hair can sit ~6 deltaE from an orange shirt, so the colour gate
  // alone is not enough); deltaE keeps the growth on-garment.
  dilateRadius: 3,
  dilateDeltaE: 12,
  // Below this the garment is already right; skip rather than churn bytes.
  minDeltaE: 6,
  minMaskPx: 200,
};

function _photoAnalyzerUrl() {
  return process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
}
const bytesOf = (input) => {
  if (Buffer.isBuffer(input)) return input;
  const m = String(input).match(/^data:[^;]+;base64,(.*)$/);
  return Buffer.from(m ? m[1] : String(input), 'base64');
};
const toDataUri = (buf) => 'data:image/jpeg;base64,' + buf.toString('base64');

/** GroundingDINO: garment box inside a crop. Returns pixel box in crop coords. */
async function detectGarmentBox(cropUri, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const res = await fetch(`${_photoAnalyzerUrl()}/detect-figures-text`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: cropUri,
      prompts: [{ name: 'garment', text: cfg.garmentPrompt }],
      box_threshold: cfg.boxThreshold, text_threshold: cfg.textThreshold,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`detect-figures-text HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.success) throw new Error(`detect-figures-text: ${j?.error}`);
  const g = (j.figures || [])[0];
  if (!g?.box) return null;
  return { box: g.box, score: g.score };
}

/** MobileSAM: box -> silhouette, as a 0/255 mask at the crop's size. */
async function segmentGarment(cropUri, box, w, h) {
  const res = await fetch(`${_photoAnalyzerUrl()}/figure-mask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: cropUri, box }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!res.ok) throw new Error(`figure-mask HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.success) throw new Error(`figure-mask: ${j?.error}`);
  const png = Buffer.from(String(j.image).replace(/^data:[^;]+;base64,/, ''), 'base64');
  const { data, info } = await sharp(png).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * info.channels + 3];
  return { alpha, pngBuf: png };
}

/**
 * Grow the garment mask outward into pixels that are still the GARMENT.
 *
 * SAM's silhouette tends to sit a pixel or two inside the true edge. When the
 * correction is large that leftover rim reads as an outline in the ORIGINAL
 * colour — an orange fringe around a shirt repainted yellow. Plain morphological
 * dilation would swallow skin and hair; gating each candidate on its distance to
 * the measured garment mean keeps the growth on-garment.
 *
 * The radius is deliberately small. On a red-haired character the hair sits ~6
 * ΔE from an orange shirt, so the colour gate ALONE cannot separate them — the
 * bound on how far the mask may travel is what does. Two guards, not one.
 *
 * Newly added pixels get full weight: they are garment, and a partial weight is
 * exactly what leaves a fringe. The soft edge now falls on the true boundary,
 * where neighbours are skin or background and the gate rejects them.
 *
 * @returns {{alpha: Buffer, added: number}}
 */
function dilateMaskByColour(alpha, raw, w, h, meanLab, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const out = Buffer.from(alpha);
  let added = 0;
  const dE2 = cfg.dilateDeltaE * cfg.dilateDeltaE;
  for (let ring = 0; ring < cfg.dilateRadius; ring++) {
    const frontier = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (out[i] > 8) continue;
      let touches = false;
      if (x > 0 && out[i - 1] > 8) touches = true;
      else if (x < w - 1 && out[i + 1] > 8) touches = true;
      else if (y > 0 && out[i - w] > 8) touches = true;
      else if (y < h - 1 && out[i + w] > 8) touches = true;
      if (!touches) continue;
      const l = _rgbToLab(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
      const d2 = (l[0] - meanLab.L) ** 2 + (l[1] - meanLab.a) ** 2 + (l[2] - meanLab.b) ** 2;
      if (d2 <= dE2) frontier.push(i);
    }
    if (!frontier.length) break;
    for (const i of frontier) { out[i] = 255; added++; }
  }
  return { alpha: out, added };
}

/** Mean L*a*b* over pixels whose mask alpha is above `thr`. */
function meanLabMasked(raw, alpha, thr = 128) {
  let sL = 0, sa = 0, sb = 0, n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] <= thr) continue;
    const l = _rgbToLab(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
    sL += l[0]; sa += l[1]; sb += l[2]; n++;
  }
  return n ? { L: sL / n, a: sa / n, b: sb / n, count: n } : null;
}

/** Median L* of skin-looking pixels in a box — the illumination probe. */
function medianSkinL(raw, W, H, box01) {
  if (!Array.isArray(box01) || box01.length !== 4) return null;
  const y0 = Math.max(0, Math.round(box01[0] * H)), x0 = Math.max(0, Math.round(box01[1] * W));
  const y1 = Math.min(H, Math.round(box01[2] * H)), x1 = Math.min(W, Math.round(box01[3] * W));
  const Ls = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    // Skin is exactly what isGarmentPixel REJECTS in the warm band — invert it.
    if (isGarmentPixel(r, g, b)) continue;
    const l = _rgbToLab(r, g, b);
    if (l[0] < 15 || l[0] > 96) continue; // crushed black / blown white carry no signal
    Ls.push(l[0]);
  }
  if (Ls.length < 50) return null;
  Ls.sort((p, q) => p - q);
  return Ls[Math.floor(Ls.length / 2)];
}

/**
 * The canonical garment colour for a character, read from the styled avatar's
 * torso band (hair-free by construction — see garmentHueNormalize.avatarTorsoBand).
 * @returns {{L,a,b,chroma,hueDeg}|null}
 */
async function avatarGarmentLab(avatarUri) {
  const { _internal } = require('./garmentHueNormalize');
  const buf = bytesOf(avatarUri);
  const meta = await sharp(buf).metadata();
  const band = await _internal.avatarTorsoBand(buf, meta.width, meta.height);
  const { data, info } = await sharp(buf).extract(band).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const cl = sampleGarmentClusters(data, info.width * info.height, null, { a: 0, b: 0 }, {}, 3);
  if (!cl.length) return null;
  const c = cl[0];
  return { L: c.L, a: c.a, b: c.b, chroma: c.chroma, hueDeg: +(c.hueRad * DEG).toFixed(1) };
}

/**
 * Repair ONE figure's garment colour on a page.
 *
 * @param {string|Buffer} pageImageData
 * @param {object} figure   detection figure: { name, bodyBox, faceBox }
 * @param {string} avatarUri styled avatar for this page's clothing category
 * @param {object} options  { opts, collectSteps }
 * @returns {Promise<{changed, imageData, report, steps}>}
 */
async function fixFigureGarmentColour(pageImageData, figure, avatarUri, options = {}) {
  const cfg = { ...DEFAULTS, ...(options.opts || {}) };
  const t0 = Date.now();
  const report = { name: figure?.name || 'figure', applied: false, reason: null };
  const pageBuf = bytesOf(pageImageData);
  const meta = await sharp(pageBuf).metadata();
  const W = meta.width, H = meta.height;
  const steps = [];

  const target = await avatarGarmentLab(avatarUri);
  if (!target) { report.reason = 'no avatar garment sample'; return { changed: false, imageData: pageImageData, report, steps }; }
  report.target = { L: +target.L.toFixed(1), hueDeg: target.hueDeg, chroma: +target.chroma.toFixed(1) };

  // Crop to the figure so the garment query has one unambiguous referent — a
  // whole-page "shirt" query on a multi-figure page returns person-sized boxes.
  const bb = figure.bodyBox;
  if (!Array.isArray(bb)) { report.reason = 'no bodyBox'; return { changed: false, imageData: pageImageData, report, steps }; }
  const x0 = Math.max(0, Math.round((bb[1] - cfg.cropPad) * W)), y0 = Math.max(0, Math.round((bb[0] - cfg.cropPad) * H));
  const x1 = Math.min(W, Math.round((bb[3] + cfg.cropPad) * W)), y1 = Math.min(H, Math.round((bb[2] + cfg.cropPad) * H));
  const cw = x1 - x0, ch = y1 - y0;
  if (cw < 16 || ch < 16) { report.reason = 'figure box too small'; return { changed: false, imageData: pageImageData, report, steps }; }
  const cropBuf = await sharp(pageBuf).extract({ left: x0, top: y0, width: cw, height: ch }).jpeg({ quality: 95 }).toBuffer();
  const cropUri = toDataUri(cropBuf);

  let det = null, seg = null;
  try {
    det = await detectGarmentBox(cropUri, cfg);
    if (!det) { report.reason = 'DINO found no garment'; return { changed: false, imageData: pageImageData, report, steps }; }
    seg = await segmentGarment(cropUri, det.box, cw, ch);
  } catch (e) {
    report.reason = `segmentation failed: ${e.message}`;
    return { changed: false, imageData: pageImageData, report, steps };
  }
  report.dinoScore = +Number(det.score).toFixed(2);

  const { data: cropRaw } = await sharp(cropBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let cur = meanLabMasked(cropRaw, seg.alpha);
  // Grow the mask onto the rim SAM left behind, then re-measure from the full
  // garment so the target offset is computed against every pixel it will touch.
  if (cur && cur.count >= cfg.minMaskPx && cfg.dilateRadius > 0) {
    const grown = dilateMaskByColour(seg.alpha, cropRaw, cw, ch, cur, cfg);
    if (grown.added) {
      seg.alpha = grown.alpha;
      report.maskDilated = grown.added;
      cur = meanLabMasked(cropRaw, seg.alpha) || cur;
    }
  }
  if (!cur || cur.count < cfg.minMaskPx) { report.reason = `garment mask too small (${cur?.count || 0}px)`; return { changed: false, imageData: pageImageData, report, steps }; }
  report.current = { L: +cur.L.toFixed(1), hueDeg: +(Math.atan2(cur.b, cur.a) * DEG).toFixed(1), chroma: +Math.hypot(cur.a, cur.b).toFixed(1), px: cur.count };

  // Lighting factor from skin: page face vs avatar face, same material.
  let lighting = 1, lightingSource = 'default';
  try {
    const { data: pageRaw } = await sharp(pageBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pageSkinL = medianSkinL(pageRaw, W, H, figure.faceBox);
    const abuf = bytesOf(avatarUri);
    const am = await sharp(abuf).metadata();
    const { data: avRaw } = await sharp(abuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Avatar head cells occupy the top band of the sheet.
    const avSkinL = medianSkinL(avRaw, am.width, am.height, [0, 0, 0.45, 1]);
    if (pageSkinL && avSkinL) {
      const f = pageSkinL / avSkinL;
      if (f >= cfg.lightingMin && f <= cfg.lightingMax) { lighting = f; lightingSource = 'skin'; }
      else { lightingSource = `skin out of range (${f.toFixed(2)})`; }
      report.skin = { page: +pageSkinL.toFixed(1), avatar: +avSkinL.toFixed(1) };
    }
  } catch { /* lighting probe is advisory; 1.0 is a safe default */ }
  report.lighting = +lighting.toFixed(2);
  report.lightingSource = lightingSource;

  // Target scaled by lighting: only L* is illumination-dependent this way; the
  // hue and chroma of the pigment do not change with light level.
  const cap = (v, m) => Math.max(-m, Math.min(m, v));
  const targetL = target.L * lighting;
  const dL = cap(targetL - cur.L, cfg.maxDeltaL);
  const da = cap(target.a - cur.a, cfg.maxDeltaAB);
  const db = cap(target.b - cur.b, cfg.maxDeltaAB);
  const deltaE = Math.hypot(dL, da, db);
  report.delta = { L: +dL.toFixed(1), a: +da.toFixed(1), b: +db.toFixed(1), deltaE: +deltaE.toFixed(1) };
  if (deltaE < cfg.minDeltaE) {
    report.reason = `already on colour (ΔE ${deltaE.toFixed(1)} < ${cfg.minDeltaE})`;
    return { changed: false, imageData: pageImageData, report, steps };
  }

  // Apply inside the crop, weighted by the SAM alpha (free feathered edge).
  const out = Buffer.from(cropRaw);
  for (let i = 0; i < cw * ch; i++) {
    const a8 = seg.alpha[i];
    if (a8 <= 8) continue;
    const w = Math.min(1, a8 / 255);
    const l = _rgbToLab(cropRaw[i * 3], cropRaw[i * 3 + 1], cropRaw[i * 3 + 2]);
    const rgb = _labToRgb(l[0] + w * dL, l[1] + w * da, l[2] + w * db);
    out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
  }
  const fixedCrop = await sharp(out, { raw: { width: cw, height: ch, channels: 3 } }).png().toBuffer();
  const merged = await sharp(pageBuf).composite([{ input: fixedCrop, left: x0, top: y0 }]).jpeg({ quality: 95 }).toBuffer();

  if (options.collectSteps) {
    steps.push({ label: `${report.name} BEFORE (${report.current.hueDeg}°, L ${report.current.L})`, data: toDataUri(cropBuf) });
    steps.push({ label: `${report.name} MASK (DINO ${report.dinoScore} → SAM, ${cur.count}px)`, data: 'data:image/png;base64,' + seg.pngBuf.toString('base64') });
    steps.push({ label: `${report.name} AFTER (→ ${target.hueDeg}°, L ${targetL.toFixed(0)})`, data: toDataUri(await sharp(fixedCrop).jpeg({ quality: 95 }).toBuffer()) });
  }
  report.applied = true;
  report.elapsedMs = Date.now() - t0;
  log.info(`🎨 [GARMENT-COLOUR] ${report.name}: ${report.current.hueDeg}°→${target.hueDeg}° L ${report.current.L}→${targetL.toFixed(0)} (ΔE ${deltaE.toFixed(1)}, lighting ×${lighting.toFixed(2)}, DINO ${report.dinoScore}, ${cur.count}px, ${report.elapsedMs}ms)`);
  return { changed: true, imageData: toDataUri(merged), report, steps };
}

module.exports = {
  fixFigureGarmentColour,
  avatarGarmentLab,
  detectGarmentBox,
  segmentGarment,
  medianSkinL,
  meanLabMasked,
  dilateMaskByColour,
  DEFAULTS,
};
