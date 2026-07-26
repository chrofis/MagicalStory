// server/lib/faceRepair.js
// ============================================================================
// THE unified character-repair spine — 5 legacy methods collapsed to 3 axes.
//
//   regionSource : 'box'    (mark the region inside the full page)
//                  'cutout' (extract a crop, treat it, paste it back)
//   treatment    : 'blur' | 'crosshatch' | 'whiteout'
//   model        : 'grok' | 'qwen' | 'gemini'
//   + faceOnly   : head/face vs whole figure
//   + requireMobilesam : bool
//
// EVERY combination routes through the ONE shared blend engine
// `samUnionBlend` (server/lib/samBlend.js) and faces the SAME uniform gates —
// style-match, IoU, white-card, coverage, requireMobilesam and sharpness —
// all default ON. There is no path to the output that skips them. This is the
// whole point of the merge: the legacy box-blur / crosshatch paths carried
// their own private blend engines and only a partial gate set; here they get
// the shared spine and the full gate battery (see docs/face-repair-merge-
// design.md for the axis mapping and the accepted IoU-gate behaviour change).
//
// The core was lifted from `grokFaceInsertRepair` (images.js) — the dominant
// production path (cutout+whiteout+grok+face) that already routed through
// samUnionBlend. The three treatment-mask builders were extracted BYTE-
// FAITHFULLY from the four legacy inline branches; every extraction carries a
// `// FAITHFULNESS-CHECK:` marker citing the original images.js/testlab.js line.
//
// Colour helpers, mask fetchers, prompt templates and provider clients come
// from images.js / grok.js / runware.js via LAZY require inside the functions
// (images.js lazy-requires this module back from its ~20-line adapter, so a
// top-level require here would be a load-time cycle).
// ============================================================================

const { log } = require('../utils/logger');

// Stable descriptor replacing the old free-text `method` strings for
// logs / telemetry / the dev panel: e.g. "grok:cutout:whiteout:face".
function repairDescriptor({ model, regionSource, treatment, faceOnly }) {
  return `${model}:${regionSource}:${treatment}:${faceOnly ? 'face' : 'body'}`;
}

// Legacy method-name aliases so consumers keyed on the old strings keep
// working during the migration (dev panel, retryHistory, tests).
function legacyMethodAlias({ regionSource, treatment, faceOnly }) {
  if (treatment === 'whiteout') return 'grok_face_insert';
  if (treatment === 'blur') return 'grok_blended';
  if (treatment === 'crosshatch') return regionSource === 'cutout' ? 'grok_cutout' : 'grok_inpaint';
  return 'grok_blended';
}

// ---------------------------------------------------------------------------
// Input normalisation — scene + avatar may be base64, data: URI or https R2 URL.
// FAITHFULNESS-CHECK: images.js:11418-11449 (avatar + scene fetch/decode).
// ---------------------------------------------------------------------------
async function normalizeSceneBuffer(imageData) {
  const r2Lib = require('./r2');
  if (typeof imageData === 'string' && /^https?:\/\//i.test(imageData)) {
    const buf = await r2Lib.fetchImageBytes(imageData);
    if (!buf) throw new Error(`Failed to fetch scene image from R2: ${imageData}`);
    return buf;
  }
  return Buffer.from(r2Lib.stripDataUriPrefix(imageData), 'base64');
}

async function normalizeAvatar(characterPhoto, opts) {
  const sharp = require('sharp');
  const r2Lib = require('./r2');
  const { cropToFrontColumn } = require('./grok');
  let avatarBuffer;
  if (typeof characterPhoto === 'string' && /^https?:\/\//i.test(characterPhoto)) {
    avatarBuffer = await require('./r2').fetchImageBytes(characterPhoto);
    if (!avatarBuffer) throw new Error(`Failed to fetch character reference from R2: ${characterPhoto}`);
  } else {
    avatarBuffer = Buffer.from(r2Lib.stripDataUriPrefix(characterPhoto), 'base64');
  }
  if (!avatarBuffer || avatarBuffer.length < 1000) {
    throw new Error(`Character reference is empty/invalid (${avatarBuffer?.length || 0} bytes) — refusing to send to the model`);
  }
  // FAITHFULNESS-CHECK: images.js:11431-11433 (styled-avatar grid → front column).
  const isAvatarGrid = opts.photoType && (opts.photoType.startsWith('styled-') || opts.photoType.startsWith('costumed-') || opts.photoType.startsWith('clothing-'));
  const cropped = isAvatarGrid ? await cropToFrontColumn(avatarBuffer) : avatarBuffer;
  return `data:image/jpeg;base64,${cropped.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Region resolver — deterministic crop geometry. Exposed for unit tests.
//
//   faceOnly  → SQUARE crop centred on the head (side ≈ 3× head, floor 384),
//               a valid 1:1 Grok edit aspect BY CONSTRUCTION (no mid-pipeline
//               reshape that would desync the paste).
//   body/box  → the figure bbox + a small pad, used as the blend crop.
//   body/cutout → preset-aligned extract (computePresetAlignedExtract) so the
//               crop lands exactly on a Grok aspect preset.
//
// FAITHFULNESS-CHECK: images.js:11155-11199 (face square crop + boxInCrop +
// hairBox + faceClip) and images.js:12084-12114 (body cutout preset extract).
// ---------------------------------------------------------------------------
function resolveRegion({ regionSource, faceOnly, faceBbox, bodyBbox, sceneWidth, sceneHeight }) {
  const W = sceneWidth, H = sceneHeight;
  if (faceOnly) {
    const fb = faceBbox;
    if (!Array.isArray(fb) || fb.length !== 4) throw new Error('faceOnly region needs a 4-value faceBbox');
    const pad = 0.35;
    const padX = (fb[3] - fb[1]) * pad, padY = (fb[2] - fb[0]) * pad * 0.6;
    let crop = {
      x: Math.round(Math.max(0, fb[1] - padX) * W),
      y: Math.round(Math.max(0, fb[0] - padY) * H),
      w: Math.round(Math.min(1, fb[3] - fb[1] + 2 * padX) * W),
      h: Math.round(Math.min(1, fb[2] - fb[0] + 2 * padY) * H),
    };
    const fwPx = Math.round((fb[3] - fb[1]) * W), fhPx = Math.round((fb[2] - fb[0]) * H);
    const cx0 = crop.x + crop.w / 2, cy0 = crop.y + crop.h / 2;
    const side = Math.min(W, H, Math.max(3 * fwPx, 3 * fhPx, 384));
    crop = {
      x: Math.max(0, Math.min(W - side, Math.round(cx0 - side / 2))),
      y: Math.max(0, Math.min(H - side, Math.round(cy0 - side / 2))),
      w: side, h: side,
    };
    const boxInCrop = [
      Math.max(0, Math.round(fb[1] * W) - crop.x),
      Math.max(0, Math.round(fb[0] * H) - crop.y),
      Math.min(crop.w, Math.round(fb[3] * W) - crop.x),
      Math.min(crop.h, Math.round(fb[2] * H) - crop.y),
    ];
    const bb = (Array.isArray(bodyBbox) && bodyBbox.length === 4) ? bodyBbox : fb;
    const bodyBoxInCrop = [
      Math.max(0, Math.round(bb[1] * W) - crop.x),
      Math.max(0, Math.round(bb[0] * H) - crop.y),
      Math.min(crop.w, Math.round(bb[3] * W) - crop.x),
      Math.min(crop.h, Math.round(bb[2] * H) - crop.y),
    ];
    const fbw = boxInCrop[2] - boxInCrop[0], fbh = boxInCrop[3] - boxInCrop[1];
    const hairBox = [
      Math.max(0, Math.round(boxInCrop[0] - fbw * 0.5)),
      Math.max(0, Math.round(boxInCrop[1] - fbh * 0.35)),
      Math.min(crop.w, Math.round(boxInCrop[2] + fbw * 0.5)),
      boxInCrop[3],
    ];
    const clipBottom = Math.min(crop.h, Math.round(fb[2] * H) - crop.y);
    const faceClip = [0, 0, crop.w, clipBottom];
    return { crop, boxInCrop, bodyBoxInCrop, hairBox, faceClip, aspect: '1:1' };
  }

  // Body modes work from the body bbox.
  const bb = (Array.isArray(bodyBbox) && bodyBbox.length === 4) ? bodyBbox : faceBbox;
  if (!Array.isArray(bb) || bb.length !== 4) throw new Error('body region needs a 4-value bodyBbox');
  const [ymin, xmin, ymax, xmax] = bb;
  const pixelLeft = Math.max(0, Math.floor(xmin * W));
  const pixelTop = Math.max(0, Math.floor(ymin * H));
  const pixelWidth = Math.min(W - pixelLeft, Math.ceil((xmax - xmin) * W));
  const pixelHeight = Math.min(H - pixelTop, Math.ceil((ymax - ymin) * H));

  if (regionSource === 'cutout') {
    // FAITHFULNESS-CHECK: images.js:12102-12114 (PAD_FACTOR 0.4 preset-aligned extract).
    const { computePresetAlignedExtract } = require('./images');
    const PAD_FACTOR = 0.4;
    const aligned = computePresetAlignedExtract({
      pixelLeft, pixelTop, pixelWidth, pixelHeight,
      padFactor: PAD_FACTOR, sceneWidth: W, sceneHeight: H,
    });
    const crop = { x: aligned.left, y: aligned.top, w: aligned.width, h: aligned.height };
    const boxInCrop = [pixelLeft - crop.x, pixelTop - crop.y, pixelLeft - crop.x + pixelWidth, pixelTop - crop.y + pixelHeight];
    return { crop, boxInCrop, bodyBoxInCrop: boxInCrop, hairBox: null, faceClip: null, aspect: aligned.preset };
  }

  // box mode: the blend crop is the figure bbox + 10% pad (the model itself
  // sees the full scene; only this crop region gets the union-blend + composite).
  // FAITHFULNESS-CHECK: images.js:11751-11763 (BLEND_PADDING 0.1 region).
  const BLEND_PADDING = 0.1;
  const padX = (xmax - xmin) * BLEND_PADDING;
  const padY = (ymax - ymin) * BLEND_PADDING;
  const bxmin = Math.max(0, xmin - padX), bymin = Math.max(0, ymin - padY);
  const bxmax = Math.min(1, xmax + padX), bymax = Math.min(1, ymax + padY);
  const left = Math.floor(bxmin * W), top = Math.floor(bymin * H);
  const crop = {
    x: left, y: top,
    w: Math.min(W - left, Math.ceil((bxmax - bxmin) * W)),
    h: Math.min(H - top, Math.ceil((bymax - bymin) * H)),
  };
  const boxInCrop = [
    Math.max(0, Math.round(xmin * W) - crop.x),
    Math.max(0, Math.round(ymin * H) - crop.y),
    Math.min(crop.w, Math.round(xmax * W) - crop.x),
    Math.min(crop.h, Math.round(ymax * H) - crop.y),
  ];
  return { crop, boxInCrop, bodyBoxInCrop: boxInCrop, hairBox: null, faceClip: null, aspect: null };
}

// ---------------------------------------------------------------------------
// TREATMENT BUILDERS — extracted byte-faithfully from the legacy branches.
// Each returns { treatedBuf, oldMaskPng, coverage } for the given crop.
// `maskFetch` is the ONE requireMobilesam-honouring fetcher (built in the spine).
// ---------------------------------------------------------------------------

// WHITEOUT — SAM head/figure silhouette → binarized → whited out over the crop.
// FAITHFULNESS-CHECK: images.js:11205-11220 (grokFaceInsertRepair head whiteout).
async function buildWhiteoutTreatment({ cropBuf, crop, bodyBoxInCrop, boxInCrop, faceClip, hairBox, maskFetch, requireMobilesam, gateCoverage }) {
  const sharp = require('sharp');
  const { fetchFigureHeadMaskPng } = require('./images');
  const rawMask = await fetchFigureHeadMaskPng(cropBuf, bodyBoxInCrop, boxInCrop, crop.w, crop.h, maskFetch, { clipMode: 'bottom', hairBox });
  if (!rawMask) throw new Error('SAM head mask unavailable for whiteout (MobileSAM down?)');
  const a = await sharp(rawMask).resize(crop.w, crop.h, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
  const stride = Math.max(1, Math.round(a.length / (crop.w * crop.h)));
  const hard = Buffer.alloc(crop.w * crop.h);
  const clip = faceClip || [0, 0, crop.w, crop.h];
  for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) {
    const i = y * crop.w + x;
    const inClip = x >= clip[0] && x < clip[2] && y >= clip[1] && y < clip[3];
    hard[i] = inClip && a[i * stride] > 128 ? 255 : 0;
  }
  let cov = 0; for (let i = 0; i < hard.length; i++) if (hard[i]) cov++;
  if (gateCoverage && cov < 40) throw new Error('SAM head mask empty for whiteout');
  const oldMaskPng = await sharp(Buffer.alloc(crop.w * crop.h * 3, 255), { raw: { width: crop.w, height: crop.h, channels: 3 } })
    .ensureAlpha().joinChannel(Buffer.from(hard), { raw: { width: crop.w, height: crop.h, channels: 1 } }).png().toBuffer();
  const treatedBuf = await sharp(cropBuf).composite([{ input: oldMaskPng, left: 0, top: 0 }]).png().toBuffer();
  return { treatedBuf, oldMaskPng, coverage: cov };
}

// CROSSHATCH — magenta SVG crosshatch clipped to the figure silhouette (dest-in).
// FAITHFULNESS-CHECK: images.js:12163-12172 (grok_cutout hatch SVG) +
//                     images.js:12483-12496 / 12689-12695 (grok_inpaint hatch + silhouette clip).
async function buildCrosshatchTreatment({ cropBuf, crop, boxInCrop, maskFetch, gateCoverage }) {
  const sharp = require('sharp');
  const { fetchFigureMaskPng } = require('./images');
  const figureLeft = boxInCrop[0], figureTop = boxInCrop[1];
  const figureWidth = boxInCrop[2] - boxInCrop[0], figureHeight = boxInCrop[3] - boxInCrop[1];
  // FAITHFULNESS-CHECK: images.js:12140-12148 (HATCH_SAFETY 0.12 margin around figure box).
  const HATCH_SAFETY = 0.12;
  const hatchMarginX = Math.round(figureWidth * HATCH_SAFETY);
  const hatchMarginY = Math.round(figureHeight * HATCH_SAFETY);
  const hatchLeft = Math.max(0, figureLeft - hatchMarginX);
  const hatchTop = Math.max(0, figureTop - hatchMarginY);
  const hatchRight = Math.min(crop.w, figureLeft + figureWidth + hatchMarginX);
  const hatchBottom = Math.min(crop.h, figureTop + figureHeight + hatchMarginY);
  const hatchWidth = hatchRight - hatchLeft;
  const hatchHeight = hatchBottom - hatchTop;
  const hatchSpacing = Math.max(16, Math.round(Math.min(hatchWidth, hatchHeight) * 0.06));
  const HATCH_STROKE = 2;
  const HATCH_COLOR = '#FF00FF';
  // FAITHFULNESS-CHECK: images.js:12163-12172 (hatch SVG pattern, sub-region composite).
  const hatchSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${hatchWidth}" height="${hatchHeight}">
  <defs>
    <pattern id="hatch" x="0" y="0" width="${hatchSpacing}" height="${hatchSpacing}" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="${hatchSpacing}" y2="${hatchSpacing}" stroke="${HATCH_COLOR}" stroke-width="${HATCH_STROKE}"/>
      <line x1="${hatchSpacing}" y1="0" x2="0" y2="${hatchSpacing}" stroke="${HATCH_COLOR}" stroke-width="${HATCH_STROKE}"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="${hatchWidth}" height="${hatchHeight}" fill="url(#hatch)"/>
</svg>`;
  // Build the hatch on a transparent canvas, then clip it to the figure
  // silhouette so only the figure gets marked (not the surrounding rectangle).
  const hatchOnly = await sharp(Buffer.from(hatchSvg)).png().toBuffer();
  let hatchRegion = hatchOnly;
  let oldMaskPng = null;
  let cov = 0;
  try {
    // Silhouette over the hatch region for the dest-in clip AND the blend union.
    const boxInHatch = [figureLeft - hatchLeft, figureTop - hatchTop, figureLeft - hatchLeft + figureWidth, figureTop - hatchTop + figureHeight];
    const hatchCrop = await sharp(cropBuf).extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight }).jpeg({ quality: 90 }).toBuffer();
    const sil = await fetchFigureMaskPng(hatchCrop, boxInHatch, {});
    if (sil) {
      // FAITHFULNESS-CHECK: images.js:12689-12695 (dest-in clip of hatch to silhouette).
      hatchRegion = await sharp(hatchOnly).extract({ left: 0, top: 0, width: hatchWidth, height: hatchHeight })
        .composite([{ input: sil, blend: 'dest-in' }]).png().toBuffer();
      // Build the crop-sized old mask (white figure on black) for the union blend.
      const silAlpha = await sharp(sil).resize(hatchWidth, hatchHeight, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
      const st = Math.max(1, Math.round(silAlpha.length / (hatchWidth * hatchHeight)));
      const hard = Buffer.alloc(crop.w * crop.h);
      for (let y = 0; y < hatchHeight; y++) for (let x = 0; x < hatchWidth; x++) {
        if (silAlpha[(y * hatchWidth + x) * st] > 128) { hard[(hatchTop + y) * crop.w + (hatchLeft + x)] = 255; cov++; }
      }
      oldMaskPng = await sharp(Buffer.alloc(crop.w * crop.h * 3, 255), { raw: { width: crop.w, height: crop.h, channels: 3 } })
        .ensureAlpha().joinChannel(Buffer.from(hard), { raw: { width: crop.w, height: crop.h, channels: 1 } }).png().toBuffer();
    }
  } catch (err) {
    log.warn(`[FACE REPAIR] crosshatch silhouette clip failed (${err.message}) — rectangular hatch`);
  }
  const treatedBuf = await sharp(cropBuf).composite([{ input: hatchRegion, top: hatchTop, left: hatchLeft }]).png().toBuffer();
  return { treatedBuf, oldMaskPng, coverage: cov, hatchRect: { left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight } };
}

// BLUR — shape-aware silhouette-clipped blur over the figure.
// FAITHFULNESS-CHECK: images.js:11535-11582 (blurFace shapeAware branch).
async function buildBlurTreatment({ cropBuf, crop, boxInCrop, faceOnly, gateCoverage }) {
  const sharp = require('sharp');
  const { fetchFaceHeadMaskPng, fetchSilhouettePng } = require('./images');
  const fLeft = boxInCrop[0], fTop = boxInCrop[1];
  const fWidth = boxInCrop[2] - boxInCrop[0], fHeight = boxInCrop[3] - boxInCrop[1];
  // FAITHFULNESS-CHECK: images.js:11524 + 11547 (FACE_BLUR_RADIUS_FACTOR 0.03, min 10).
  const FACE_BLUR_RADIUS_FACTOR = 0.03;
  const blurRadius = Math.max(10, Math.round(fWidth * FACE_BLUR_RADIUS_FACTOR));
  const cropJpeg = await sharp(cropBuf).extract({ left: fLeft, top: fTop, width: fWidth, height: fHeight }).jpeg({ quality: 90 }).toBuffer();
  const blurred = await sharp(cropJpeg).blur(blurRadius).toBuffer();
  let composite = { input: blurred, left: fLeft, top: fTop };
  let oldMaskPng = null, cov = 0;
  // FAITHFULNESS-CHECK: images.js:11558-11576 (head mask ∪ hair → dest-in clip of blur).
  const innerFaceBox = [0, 0, fWidth, fHeight];
  const silhouettePng = await fetchFaceHeadMaskPng(cropJpeg, innerFaceBox, fWidth, fHeight) || await fetchSilhouettePng(cropJpeg);
  if (silhouettePng) {
    const blurredWithAlpha = await sharp(blurred).ensureAlpha().composite([{ input: silhouettePng, blend: 'dest-in' }]).png().toBuffer();
    composite = { input: blurredWithAlpha, left: fLeft, top: fTop };
    const silAlpha = await sharp(silhouettePng).resize(fWidth, fHeight, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
    const st = Math.max(1, Math.round(silAlpha.length / (fWidth * fHeight)));
    const hard = Buffer.alloc(crop.w * crop.h);
    for (let y = 0; y < fHeight; y++) for (let x = 0; x < fWidth; x++) {
      if (silAlpha[(y * fWidth + x) * st] > 128) { hard[(fTop + y) * crop.w + (fLeft + x)] = 255; cov++; }
    }
    oldMaskPng = await sharp(Buffer.alloc(crop.w * crop.h * 3, 255), { raw: { width: crop.w, height: crop.h, channels: 3 } })
      .ensureAlpha().joinChannel(Buffer.from(hard), { raw: { width: crop.w, height: crop.h, channels: 1 } }).png().toBuffer();
  }
  const treatedBuf = await sharp(cropBuf).composite([composite]).png().toBuffer();
  return { treatedBuf, oldMaskPng, coverage: cov };
}

// ---------------------------------------------------------------------------
// Model dispatch — the ONLY axis-3 difference. Same treated input, same refs.
// grok edit coerces output to the slot-0 (treated crop / scene) aspect, so the
// output geometry matches qwen's rw×rh; everything downstream (SAM re-detect,
// union blend) is shared.
// ---------------------------------------------------------------------------
async function callModel({ model, prompt, treatedUri, avatarUri, aspect, cropW, cropH }) {
  if (model === 'grok') {
    const { editWithGrok } = require('./grok');
    const r = await editWithGrok(prompt, [treatedUri, avatarUri], { aspectRatio: aspect || '1:1', resolution: '1k' });
    if (!r?.imageData) throw new Error('Grok returned no image');
    return { imageData: r.imageData, usage: r.usage };
  }
  if (model === 'qwen') {
    const { editWithQwen } = require('./runware');
    // Runware dims must be multiples of 64 in [512,2048]; render ~2x for detail.
    const snap = v => Math.max(512, Math.min(2048, Math.round(v / 64) * 64));
    const r = await editWithQwen(prompt, [treatedUri, avatarUri], { width: snap(cropW * 2), height: snap(cropH * 2) });
    if (!r?.imageData) throw new Error('Qwen returned no image');
    return { imageData: r.imageData, usage: { model: r.modelId, cost: r.cost } };
  }
  if (model === 'gemini') {
    // Gemini repaint of the treated crop. Folded in as a MODEL (Stage 5): it no
    // longer ships verbatim — it flows through the same samUnionBlend + gates.
    const { editImageWithPrompt } = require('./images');
    const r = await editImageWithPrompt(treatedUri, prompt, 'gemini-2.5-flash-image', [avatarUri]);
    if (!r?.imageData) throw new Error('Gemini returned no image');
    return { imageData: r.imageData, usage: r.usage };
  }
  throw new Error(`Unknown model axis "${model}" — use grok|qwen|gemini`);
}

// ---------------------------------------------------------------------------
// Prompt builder — lifted from grokFaceInsertRepair (whiteout/face) and the
// character-repair templates (body). Kept internal so the merge stays single-
// source; the adapter passes context via opts.
// FAITHFULNESS-CHECK: images.js:11236-11251 (whiteout face-insert prompt).
// ---------------------------------------------------------------------------
async function buildPrompt({ treatment, faceOnly, charName, opts, sceneBuffer, faceBbox, sceneW, sceneH }) {
  const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
  const clothingContext = opts.clothingDescription ? `\nClothing: ${opts.clothingDescription}` : '';
  const issueContext = opts.issueContext || (opts.issueDescription ? `\nIssues to fix: ${opts.issueDescription}` : '');
  const textPositionContext = opts.textPositionContext || '';
  const actionContext = opts.actionContext || '';

  if (treatment === 'whiteout' && faceOnly) {
    const sharp = require('sharp');
    const { describeHeadPose } = require('./images');
    let poseText = null;
    try {
      const fb = faceBbox;
      const fp = 0.3;
      const fhn = fb[2] - fb[0], fwn = fb[3] - fb[1];
      const fx = Math.max(0, Math.round((fb[1] - fwn * fp) * sceneW));
      const fy = Math.max(0, Math.round((fb[0] - fhn * fp) * sceneH));
      const fww = Math.min(sceneW - fx, Math.round(fwn * (1 + 2 * fp) * sceneW));
      const fhh2 = Math.min(sceneH - fy, Math.round(fhn * (1 + 2 * fp) * sceneH));
      const faceCrop = await sharp(sceneBuffer).extract({ left: fx, top: fy, width: fww, height: fhh2 }).jpeg({ quality: 92 }).toBuffer();
      const p = await describeHeadPose(`data:image/jpeg;base64,${faceCrop.toString('base64')}`);
      poseText = [p.facing ? `facing ${p.facing}` : null, p.headTilt ? `head ${p.headTilt}` : null, p.gaze ? `gaze ${p.gaze}` : null, p.expression ? `expression: ${p.expression}` : null, p.mouth ? `mouth ${p.mouth}` : null].filter(Boolean).join('; ');
    } catch (e) { log.warn(`[FACE REPAIR] head-pose failed (${e.message}) — omitting pose facts`); }
    let styleLine = ' Match the visual style and lighting of the first image.';
    try {
      const { ART_STYLES } = require('./storyHelpers');
      const raw = ART_STYLES[opts.artStyle];
      const txt = typeof raw === 'string' ? raw : (raw && raw.default) || '';
      if (txt) styleLine = ` Match the exact visual style, medium and rendering of the first image: ${txt}`;
    } catch { /* generic */ }
    const rich = (typeof opts.characterDescription === 'string' ? opts.characterDescription : opts.richDescription) || '';
    const faceFacts = rich ? ` The person: ${rich.split(/Wearing:/i)[0].replace(/\s+/g, ' ').trim().slice(0, 380)}` : '';
    const hasGlasses = /\bglasses\b|\bbrille\b/i.test(rich);
    const glassesClause = rich ? (hasGlasses ? ', including the same glasses' : '. The person does NOT wear glasses — do not add any') : '';
    const poseClause = poseText
      ? ` HEAD POSE AND EXPRESSION (from the original scene; directions are from the viewer's perspective): ${poseText}. Paint the head in exactly this pose — never turn it toward the camera unless stated.`
      : '';
    return `Paint the FACE and head of the person from the second image into the white area of the first image. The white area shows the head's exact position and scale. IDENTITY comes from the second image: exact same facial features, age, hair style and hair color${glassesClause}.${faceFacts}${poseClause} Keep everything outside the white area exactly unchanged: same body, same clothing, same pose, same background, same other people.${styleLine}`;
  }

  // Body / crosshatch / blur — use the matching character-repair template.
  const artStyleContext = opts.artStyle ? `\n\nArt style: ${opts.artStyle}` : '';
  if (treatment === 'blur') {
    const tpl = !faceOnly && PROMPT_TEMPLATES.characterRepairBodyBlended ? PROMPT_TEMPLATES.characterRepairBodyBlended : PROMPT_TEMPLATES.characterRepairBlended;
    if (tpl) return fillTemplate(tpl, { charName, clothingContext, actionContext, issueContext, textPositionContext });
  }
  if (treatment === 'crosshatch') {
    const tpl = PROMPT_TEMPLATES.characterRepairCutout;
    if (tpl) return fillTemplate(tpl, { charName, clothingContext, actionContext, issueContext, artStyleContext, textPositionContext });
  }
  return `This is a children's book illustration. Redraw the marked figure to look like ${charName} from the reference photo. Match face, hair, skin tone, build and clothing exactly. Preserve the original pose, expression and gaze. Keep art style and background unchanged.${clothingContext}${actionContext}${issueContext}${artStyleContext}`;
}

// ===========================================================================
// THE unified entry point.
// ===========================================================================
async function repairCharacterFace(sceneInput, avatarInput, opts = {}) {
  const sharp = require('sharp');
  const { samUnionBlend, fetchMaskWithRetry } = require('./samBlend');
  const {
    fetchFigureHeadMaskPng, detectPersonBoxInCrop, checkStyleMatch,
    measureRegionSharpness, REPAIR_SHARPNESS_MIN_ORIG, REPAIR_SHARPNESS_REJECT_RATIO,
    grokEditSceneExact,
  } = require('./images');

  // --- Axis normalisation + defaults (reproduce today's dominant path) -------
  const model = opts.model || 'grok';
  const faceOnly = opts.faceOnly !== undefined ? !!opts.faceOnly : (opts.treatment === 'whiteout');
  const treatment = opts.treatment || 'whiteout';
  const regionSource = opts.regionSource || (treatment === 'whiteout' ? 'cutout' : (treatment === 'crosshatch' && !faceOnly ? 'box' : 'cutout'));
  const requireMobilesam = opts.requireMobilesam !== undefined ? !!opts.requireMobilesam : true;
  const gates = {
    styleMatch: true, iou: true, whiteCard: true, coverage: true, requireMobilesam: true, sharpness: true,
    ...(opts.gates || {}),
  };
  const charName = opts.charName || opts.characterName || 'the character';
  const descriptor = repairDescriptor({ model, regionSource, treatment, faceOnly });
  const legacyMethod = legacyMethodAlias({ regionSource, treatment, faceOnly });

  const faceBbox = opts.faceBbox && opts.faceBbox.length === 4 ? opts.faceBbox : null;
  const bodyBbox = opts.bodyBbox && opts.bodyBbox.length === 4 ? opts.bodyBbox : (opts.bbox && opts.bbox.length === 4 ? opts.bbox : null);
  if (faceOnly && !faceBbox) throw new Error(`${descriptor}: faceOnly repair needs a faceBbox`);
  if (!faceOnly && !bodyBbox) throw new Error(`${descriptor}: body repair needs a bodyBbox`);

  const sceneBuffer = await normalizeSceneBuffer(sceneInput);
  const avatarUri = await normalizeAvatar(avatarInput, opts);
  const meta = await sharp(sceneBuffer).metadata();
  const W = meta.width, H = meta.height;

  // --- Region ----------------------------------------------------------------
  const region = resolveRegion({ regionSource, faceOnly, faceBbox, bodyBbox, sceneWidth: W, sceneHeight: H });
  const { crop, boxInCrop, bodyBoxInCrop, hairBox, faceClip, aspect } = region;
  const cropBuf = await sharp(sceneBuffer).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer();

  // The ONE requireMobilesam-honouring SAM fetcher (whiteout path uses it).
  // FAITHFULNESS-CHECK: images.js:11203 (requireMobilesam retry fetcher).
  const maskFetch = (b, box, o) => fetchMaskWithRetry(b, box, 4, { ...(o || {}), requireMobilesam: gates.requireMobilesam && requireMobilesam });

  // --- Treatment -------------------------------------------------------------
  let treated;
  if (treatment === 'whiteout') {
    treated = await buildWhiteoutTreatment({ cropBuf, crop, bodyBoxInCrop, boxInCrop, faceClip, hairBox, maskFetch, requireMobilesam, gateCoverage: gates.coverage });
  } else if (treatment === 'crosshatch') {
    treated = await buildCrosshatchTreatment({ cropBuf, crop, boxInCrop, maskFetch, gateCoverage: gates.coverage });
  } else if (treatment === 'blur') {
    treated = await buildBlurTreatment({ cropBuf, crop, boxInCrop, faceOnly, gateCoverage: gates.coverage });
  } else {
    throw new Error(`${descriptor}: unknown treatment "${treatment}"`);
  }
  const { treatedBuf, oldMaskPng } = treated;

  // --- Prompt + model call ---------------------------------------------------
  const prompt = opts.prompt || await buildPrompt({ treatment, faceOnly, charName, opts, sceneBuffer, faceBbox, sceneW: W, sceneH: H });

  let candidateCrop;      // model output resized to crop dims (the paste source)
  let usage;
  let grokRawResult;
  if (regionSource === 'box') {
    // The model edits the WHOLE scene (treatment already painted on the crop
    // region of the scene). Composite the treated crop back into the scene,
    // send the full scene through the exact-aspect round-trip, then extract the
    // same crop from the returned scene as the blend candidate.
    const treatedScene = await sharp(sceneBuffer).composite([{ input: treatedBuf, left: crop.x, top: crop.y }]).png().toBuffer();
    const treatedSceneUri = `data:image/png;base64,${treatedScene.toString('base64')}`;
    if (model === 'grok') {
      const exact = await grokEditSceneExact(prompt, [avatarUri], treatedScene, W, H, { encode: 'png' });
      if (!exact.buffer) throw new Error('Grok returned no image (box mode)');
      usage = exact.grokResult?.usage;
      grokRawResult = exact.grokResult?.imageData;
      candidateCrop = await sharp(exact.buffer).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer();
    } else {
      const r = await callModel({ model, prompt, treatedUri: treatedSceneUri, avatarUri, aspect: null, cropW: W, cropH: H });
      usage = r.usage; grokRawResult = r.imageData;
      const outBuf = Buffer.from(r.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      candidateCrop = await sharp(outBuf).resize(W, H, { fit: 'fill' }).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer();
    }
  } else {
    // cutout: the model edits ONLY the crop.
    const treatedUri = `data:image/png;base64,${treatedBuf.toString('base64')}`;
    const r = await callModel({ model, prompt, treatedUri, avatarUri, aspect, cropW: crop.w, cropH: crop.h });
    usage = r.usage; grokRawResult = r.imageData;
    const outBuf = Buffer.from(r.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    candidateCrop = await sharp(outBuf).resize(crop.w, crop.h, { fit: 'fill' }).png().toBuffer();
  }

  // --- Style-match gate ------------------------------------------------------
  if (gates.styleMatch) {
    try {
      const sm = await checkStyleMatch(
        `data:image/jpeg;base64,${(await sharp(cropBuf).jpeg({ quality: 92 }).toBuffer()).toString('base64')}`,
        `data:image/jpeg;base64,${(await sharp(candidateCrop).jpeg({ quality: 92 }).toBuffer()).toString('base64')}`
      );
      if (sm && sm.sameStyle === false) {
        log.warn(`🚫 [FACE REPAIR] ${descriptor} for ${charName} REJECTED: style drift (${sm.styleB} vs ${sm.styleA})`);
        return { imageData: null, character: charName, method: legacyMethod, descriptor, rejectedReason: 'style_drift', usage };
      }
    } catch (e) { log.warn(`[FACE REPAIR] style gate unavailable (${e.message}) — continuing without`); }
  }

  // --- Round-2 re-detect of the repainted figure (better SAM box) ------------
  let r2BodyBox = null;
  try {
    const candFull = await sharp(sceneBuffer).composite([{ input: candidateCrop, left: crop.x, top: crop.y }]).jpeg({ quality: 92 }).toBuffer();
    const anchor = faceOnly ? faceBbox : bodyBbox;
    const pagePx = [Math.round(anchor[1] * W), Math.round(anchor[0] * H), Math.round(anchor[3] * W), Math.round(anchor[2] * H)];
    const pageBox = await detectPersonBoxInCrop(candFull, pagePx, `faceRepair ${charName}: `);
    if (pageBox) r2BodyBox = [Math.max(0, pageBox[0] - crop.x), Math.max(0, pageBox[1] - crop.y), Math.min(crop.w, pageBox[2] - crop.x), Math.min(crop.h, pageBox[3] - crop.y)];
  } catch (e) { log.warn(`[FACE REPAIR] round-2 re-detect failed (${e.message}) — using copied box`); }

  // --- The ONE shared blend --------------------------------------------------
  // colorCorrect / bodyColorMode default to today's per-path values: face-insert
  // = colorCorrect:false; body = colorCorrect on + bodyColorMode on (protect bg).
  const colorCorrect = opts.colorCorrect !== undefined ? opts.colorCorrect : !faceOnly;
  const bodyColorMode = opts.bodyColorMode !== undefined ? opts.bodyColorMode : !faceOnly;
  let blend;
  try {
    blend = await samUnionBlend({
      originalCropBuf: cropBuf,
      candidateCropBuf: candidateCrop,
      boxInCrop,
      cropW: crop.w,
      cropH: crop.h,
      oldMaskPng: oldMaskPng || null,
      // Test Lab threads an addStep so the shared blend emits its SAM round-1/2
      // views into the run timeline; production omits it (no-op default).
      ...(typeof opts.addStep === 'function' ? { addStep: opts.addStep } : {}),
      failCtx: {},
      maskFetcher: (faceOnly && oldMaskPng) ? async (buf) => {
        const r2Body = r2BodyBox || bodyBoxInCrop;
        return fetchFigureHeadMaskPng(buf, r2Body, boxInCrop, crop.w, crop.h, maskFetch, { clipMode: 'bottom', hairBox });
      } : null,
      clipRect: faceClip,
      colorCorrect,
      bodyColorMode,
      featherPx: opts.featherPx,
      erodeFeather: opts.erodeFeather,
      // Uniform gates — tunable for the Test Lab A/B, default ON in production.
      gateIou: gates.iou,
      gateWhiteCard: gates.whiteCard,
      ...(opts.iouThreshold != null ? { iouThreshold: opts.iouThreshold } : {}),
      ...(opts.whiteCardMaxFrac != null ? { whiteCardMaxFrac: opts.whiteCardMaxFrac } : {}),
    });
  } catch (blendErr) {
    log.warn(`🚫 [FACE REPAIR] ${descriptor} for ${charName} REJECTED by blend gate: ${blendErr.message}`);
    return { imageData: null, character: charName, method: legacyMethod, descriptor, rejectedReason: 'blend_gate', gateMessage: blendErr.message, usage };
  }

  const composited = await sharp(sceneBuffer).composite([{ input: blend.feathered, left: crop.x, top: crop.y }]).jpeg({ quality: 95 }).toBuffer();

  // --- Sharpness gate --------------------------------------------------------
  if (gates.sharpness) {
    try {
      const anchor = faceOnly ? faceBbox : bodyBbox;
      const figureRect = {
        left: Math.max(0, Math.min(Math.floor(anchor[1] * W), W - 2)),
        top: Math.max(0, Math.min(Math.floor(anchor[0] * H), H - 2)),
      };
      figureRect.width = Math.max(1, Math.min(Math.ceil((anchor[3] - anchor[1]) * W), W - figureRect.left));
      figureRect.height = Math.max(1, Math.min(Math.ceil((anchor[2] - anchor[0]) * H), H - figureRect.top));
      const [origSharpness, repairedSharpness] = await Promise.all([
        measureRegionSharpness(sceneBuffer, figureRect),
        measureRegionSharpness(composited, figureRect),
      ]);
      if (origSharpness >= REPAIR_SHARPNESS_MIN_ORIG && repairedSharpness < origSharpness * REPAIR_SHARPNESS_REJECT_RATIO) {
        log.warn(`🚫 [FACE REPAIR] ${descriptor} for ${charName} REJECTED: repaired figure blurred (${repairedSharpness.toFixed(0)} vs ${origSharpness.toFixed(0)})`);
        return { imageData: null, character: charName, method: legacyMethod, descriptor, rejectedReason: 'repaired_figure_blurred', sharpness: { original: origSharpness, repaired: repairedSharpness }, usage };
      }
    } catch (e) { log.warn(`[FACE REPAIR] sharpness gate failed (${e.message}) — accepting unchecked`); }
  }

  const finalImageData = `data:image/jpeg;base64,${composited.toString('base64')}`;
  const originalSceneDataUri = `data:image/jpeg;base64,${sceneBuffer.toString('base64')}`;
  const treatedDataUri = `data:image/png;base64,${treatedBuf.toString('base64')}`;
  log.info(`✅ [FACE REPAIR] ${descriptor} for ${charName} completed. Crop ${crop.w}x${crop.h}@(${crop.x},${crop.y}). Cost: $${usage?.cost || 0.02}`);
  return {
    imageData: finalImageData,
    comparison: { before: originalSceneDataUri, after: finalImageData },
    blackoutImage: treatedDataUri,
    grokRawResult,
    croppedAvatar: avatarUri,
    character: charName,
    usage,
    method: legacyMethod,
    descriptor,
    promptSent: prompt,
    iou: blend.iou,
    blendRule: blend.blendRule,
    debug: opts.includeDebug ? { prompt, sceneSent: treatedDataUri, avatarSent: avatarUri, grokRawResult, bbox: bodyBbox, faceBbox, crop, descriptor } : null,
  };
}

// ---------------------------------------------------------------------------
// resolveRepairAxes — THE single place the "which axes for this issue" decision
// lives. Replaces the scattered `useFaceOnly` derivations (images.js:8174 +
// regeneration.js:5444). Face issue → whiteout + cutout + face; body issue →
// crosshatch + body. Keyword lists match the legacy derivations verbatim.
// FAITHFULNESS-CHECK: images.js:8174-8177 / regeneration.js:5443-5450.
// ---------------------------------------------------------------------------
function resolveRepairAxes(issueDescription, { hasFaceBbox = false, model = 'grok', forceTarget = null } = {}) {
  const issueText = (issueDescription || '').toLowerCase();
  const hasFaceIssue = issueText.includes('face') || issueText.includes('hair') || issueText.includes('skin') || issueText.includes('eye') || issueText.includes('age');
  const hasClothingIssue = issueText.includes('cloth') || issueText.includes('outfit') || issueText.includes('dress') || issueText.includes('shirt') || issueText.includes('jacket') || issueText.includes('color');
  // forceTarget: explicit 'face' | 'body' override (user/dev toggle) beats the
  // keyword heuristic, mirroring regeneration.js's whiteoutTarget override.
  let faceOnly;
  if (forceTarget === 'face') faceOnly = hasFaceBbox;
  else if (forceTarget === 'body') faceOnly = false;
  else faceOnly = hasFaceIssue && !hasClothingIssue && hasFaceBbox;
  return faceOnly
    ? { regionSource: 'cutout', treatment: 'whiteout', model, faceOnly: true }
    : { regionSource: 'box', treatment: 'crosshatch', model, faceOnly: false };
}

// ---------------------------------------------------------------------------
// legacyFlagsToAxes — maps the OLD repairCharacterMismatchWithGrok flag set
// (useBlended / useCutout / useFullScene + whiteoutTarget + faceBbox presence)
// onto the 3 axes, reproducing that function's mode-selection precedence:
// the face-insert early-return fires first when whiteoutTarget==='face' AND a
// faceBbox exists (images.js:11459). Otherwise the explicit flags pick the mode.
// FAITHFULNESS-CHECK: images.js:11350-11401 + 11459.
// ---------------------------------------------------------------------------
function legacyFlagsToAxes({ useBlended = null, useCutout = null, useFullScene = null, whiteoutTarget = null, hasFaceBbox = false, model = 'grok' } = {}) {
  const target = whiteoutTarget || 'body';
  // Face-insert precedence: face target + face box → cutout+whiteout+face.
  if (target === 'face' && hasFaceBbox) {
    return { regionSource: 'cutout', treatment: 'whiteout', model, faceOnly: true };
  }
  // Explicit flags.
  if (useBlended === true) return { regionSource: 'box', treatment: 'blur', model, faceOnly: target === 'face' };
  if (useCutout === true) return { regionSource: 'cutout', treatment: 'crosshatch', model, faceOnly: false };
  if (useFullScene === true) return { regionSource: 'box', treatment: 'crosshatch', model, faceOnly: false };
  // Default: body → inpaint (box+crosshatch); face (no faceBbox) → blur+box+face.
  if (target === 'face') return { regionSource: 'box', treatment: 'blur', model, faceOnly: true };
  // grok_blackout is deprecated (Stage 5): route through the gated crosshatch
  // box path instead of a no-gate verbatim full-scene repaint.
  return { regionSource: 'box', treatment: 'crosshatch', model, faceOnly: false };
}

module.exports = {
  repairCharacterFace,
  // Deterministic pieces exposed for unit tests.
  resolveRegion,
  repairDescriptor,
  legacyMethodAlias,
  resolveRepairAxes,
  legacyFlagsToAxes,
};
