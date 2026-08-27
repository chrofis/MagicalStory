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

// Run counters, keyed to the current job's cache scope. Module-level so every
// function here shares ONE definition (it used to be a closure-local const in
// repairCharacterFace, so _repairCharacterFaceOnce could not count anything).
const metrics = () => require('./runMetrics').forJob(require('./styledAvatars')._cacheContext?.getStore?.());

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
    const { computePresetAlignedExtract } = require('./imageCompositing');
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
async function buildWhiteoutTreatment({ cropBuf, crop, bodyBoxInCrop, boxInCrop, faceClip, hairBox, maskFetch, requireMobilesam, gateCoverage, providedMaskPng = null }) {
  const sharp = require('sharp');
  const { fetchFigureHeadMaskPng } = require('./imageCompositing');
  // A caller that already KNOWS the figure's exact silhouette passes it in and
  // SAM is not consulted. The scene composite is that caller: it painted the
  // placeholder itself, so its colour mask is pixel-exact, while asking a
  // segmenter to re-find a flat blob is both wasteful and a failure point —
  // /figure-mask 503 makes an otherwise valid repair impossible.
  const rawMask = providedMaskPng
    || await fetchFigureHeadMaskPng(cropBuf, bodyBoxInCrop, boxInCrop, crop.w, crop.h, maskFetch, { clipMode: 'bottom', hairBox });
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
async function buildCrosshatchTreatment({ cropBuf, crop, boxInCrop, maskFetch, gateCoverage, sceneBuffer, sceneWidth, sceneHeight, protectedBodies, bodyBbox, faceBoxInCrop = null, blurFace = true, blurStrength = 'slight', providedMaskPng = null, blurFigure = false }) {
  const sharp = require('sharp');
  const { fetchFigureMaskPng } = require('./imageCompositing');
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
  let sil = null;   // figure silhouette (hatch coords) — reused to clip the face blur
  try {
    // Silhouette over the hatch region for the dest-in clip AND the blend union.
    const boxInHatch = [figureLeft - hatchLeft, figureTop - hatchTop, figureLeft - hatchLeft + figureWidth, figureTop - hatchTop + figureHeight];
    const hatchCrop = await sharp(cropBuf).extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight }).jpeg({ quality: 90 }).toBuffer();
    // Use the RETRYING fetcher (maskFetch), like every other treatment. A single
    // transient MobileSAM miss used to leave sil=null, which silently degrades to
    // a RECTANGULAR hatch and skips the face blur — works on most pages, fails on
    // one, with only a warn that production never stores (owner: story
    // job_1786024729214_zrjgzqiey p5).
    // SAME CHARACTER SEGMENTATION AS ROUND 2. Round 2 prompts SAM with the figure
    // box plus one point at the detector's face-box centre; round 1 must do the
    // same, or the IoU gate is comparing two different procedures instead of two
    // figures (owner, 2026-08-06). Face-specific paths may differ; this one may not.
    const r1Points = (() => {
      if (!Array.isArray(faceBoxInCrop) || faceBoxInCrop.length !== 4) return {};
      const fx = Math.round((faceBoxInCrop[0] + faceBoxInCrop[2]) / 2) - hatchLeft;
      const fy = Math.round((faceBoxInCrop[1] + faceBoxInCrop[3]) / 2) - hatchTop;
      if (fx <= 0 || fy <= 0 || fx >= hatchWidth || fy >= hatchHeight) return {};
      log.info(`[FACE REPAIR] round-1 head seed from the DINO face box at (${fx},${fy}) in hatch coords`);
      return { points: [[fx, fy]] };
    })();
    // A caller holding the exact silhouette supplies it and SAM is skipped. This
    // is the difference between the real recipe and the degraded one: without a
    // silhouette the hatch stays RECTANGULAR and the face blur is skipped
    // entirely, which is a different treatment wearing the same name.
    sil = providedMaskPng
      ? await sharp(providedMaskPng).extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight }).png().toBuffer()
      : (maskFetch ? await maskFetch(hatchCrop, boxInHatch, r1Points) : await fetchFigureMaskPng(hatchCrop, boxInHatch, r1Points));
    if (!sil) log.warn('[FACE REPAIR] crosshatch: no figure silhouette after retries — RECTANGULAR hatch, face blur skipped');
    if (sil) {
      // Occluder-subtract: rembg/SAM in the target crop returns ALL foreground
      // figures — a neighbour standing in front lands inside the hatch too. For
      // each protected body overlapping the hatch region, dest-out its silhouette
      // so the crosshatch only covers the target. Pathological-revert guard: if a
      // subtract removes >70% of the target silhouette it was a label mismatch —
      // revert. FAITHFULNESS-CHECK: images.js:12560-12675.
      if (sceneBuffer && Array.isArray(protectedBodies) && protectedBodies.length && sceneWidth && sceneHeight) {
        const W = sceneWidth, H = sceneHeight;
        const opaqueFrac = async (buf) => { try { const s = await sharp(buf).stats(); const ch = s?.channels?.[3]; return ch ? ch.mean / 255 : null; } catch { return null; } };
        const silBefore = sil;
        const fracBefore = await opaqueFrac(sil);
        // hatch region origin in PAGE pixels.
        const hatchPageLeft = crop.x + hatchLeft, hatchPageTop = crop.y + hatchTop;
        for (const pb of protectedBodies) {
          if (!Array.isArray(pb) || pb.length !== 4) continue;
          const [pyMin, pxMin, pyMax, pxMax] = pb;
          if ([pyMin, pxMin, pyMax, pxMax].some(v => v == null || isNaN(v))) continue;
          // Skip the self bbox (within tolerance).
          if (Array.isArray(bodyBbox) && bodyBbox.length === 4) {
            const eps = 0.005;
            if (Math.abs(pxMin - bodyBbox[1]) < eps && Math.abs(pyMin - bodyBbox[0]) < eps && Math.abs(pxMax - bodyBbox[3]) < eps && Math.abs(pyMax - bodyBbox[2]) < eps) continue;
          }
          const OCC_PAD = 0.20;
          const pbW = pxMax - pxMin, pbH = pyMax - pyMin;
          const occLeft = Math.max(0, Math.floor((pxMin - pbW * OCC_PAD) * W));
          const occTop = Math.max(0, Math.floor((pyMin - pbH * OCC_PAD) * H));
          const occRight = Math.min(W, Math.ceil((pxMax + pbW * OCC_PAD) * W));
          const occBottom = Math.min(H, Math.ceil((pyMax + pbH * OCC_PAD) * H));
          const occW = occRight - occLeft, occH = occBottom - occTop;
          if (occW <= 1 || occH <= 1) continue;
          // Intersection with the hatch region (page coords).
          const ixmin = Math.max(occLeft, hatchPageLeft), iymin = Math.max(occTop, hatchPageTop);
          const ixmax = Math.min(occRight, hatchPageLeft + hatchWidth), iymax = Math.min(occBottom, hatchPageTop + hatchHeight);
          if (ixmax - ixmin <= 0 || iymax - iymin <= 0) continue;
          try {
            const occCrop = await sharp(sceneBuffer).extract({ left: occLeft, top: occTop, width: occW, height: occH }).jpeg({ quality: 90 }).toBuffer();
            const occBoxInCrop = [
              Math.max(0, Math.round(pxMin * W) - occLeft), Math.max(0, Math.round(pyMin * H) - occTop),
              Math.min(occW, Math.round(pxMax * W) - occLeft), Math.min(occH, Math.round(pyMax * H) - occTop),
            ];
            const occSil = await fetchFigureMaskPng(occCrop, occBoxInCrop, {});
            if (!occSil) continue;
            const occClipped = await sharp(occSil)
              .extract({ left: ixmin - occLeft, top: iymin - occTop, width: ixmax - ixmin, height: iymax - iymin })
              .png().toBuffer();
            sil = await sharp(sil)
              .composite([{ input: occClipped, left: ixmin - hatchPageLeft, top: iymin - hatchPageTop, blend: 'dest-out' }])
              .png().toBuffer();
          } catch (occErr) {
            log.warn(`[FACE REPAIR] occluder subtract failed (${occErr.message})`);
          }
        }
        const fracAfter = await opaqueFrac(sil);
        if (fracBefore != null && fracBefore > 0 && fracAfter != null && fracAfter < fracBefore * 0.30) {
          log.warn(`[FACE REPAIR] occluder subtract removed ${Math.round((1 - fracAfter / fracBefore) * 100)}% of the target silhouette — reverting (likely label mismatch)`);
          sil = silBefore;
        }
      }
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
  // FACE BLUR, then CROSSHATCH ON TOP (owner, 2026-08-05). Two rules:
  //  - the blur is clipped to the SAM HEAD SILHOUETTE, never the face box: a
  //    rectangle blurs the wall/window behind the head, destroying background
  //    the model must keep (visible in exp #326's "sent to model").
  //  - the hatch goes OVER the blurred head, so the whole figure — head
  //    included — carries the repaint marker; the blur only removes the
  //    identity underneath it.
  const blurLayers = [];
  let faceBlurInfo = { applied: false, reason: blurFace ? 'no face box for this figure' : 'blurFace disabled' };
  // FULL-FIGURE blur under the hatch. The template tells the model to infer
  // pose, hands and gaze from "the figure still faintly visible through the
  // crosshatch" — blurring the whole silhouette leaves exactly that: shape,
  // stance and tone survive, identity does not. Clipped to the silhouette, so
  // the background and neighbouring figures are untouched.
  if (blurFigure && sil) {
    try {
      const hatchCropBuf = await sharp(cropBuf)
        .extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight })
        .jpeg({ quality: 90 }).toBuffer();
      const factor = blurStrength === 'slight' ? 0.045 : 0.12;
      const radius = Math.max(6, Math.round(Math.min(figureWidth, figureHeight) * factor));
      const blurredFig = await sharp(hatchCropBuf).blur(radius).png().toBuffer();
      const silHatch = await sharp(sil).resize(hatchWidth, hatchHeight, { fit: 'fill' }).png().toBuffer();
      const clippedFig = await sharp(blurredFig).ensureAlpha()
        .composite([{ input: silHatch, blend: 'dest-in' }]).png().toBuffer();
      blurLayers.push({ input: clippedFig, top: hatchTop, left: hatchLeft });
      log.info(`[FACE REPAIR] crosshatch: FULL-FIGURE blur (${blurStrength}, r=${radius}) clipped to the silhouette, hatch on top`);
    } catch (err) {
      log.warn(`[FACE REPAIR] full-figure blur failed (${err.message}) — hatch only`);
    }
  }

  if (blurFace && Array.isArray(faceBoxInCrop) && faceBoxInCrop.length === 4) {
    try {
      const fl = Math.max(0, Math.round(faceBoxInCrop[0])), ft = Math.max(0, Math.round(faceBoxInCrop[1]));
      const fw = Math.min(crop.w - fl, Math.round(faceBoxInCrop[2] - faceBoxInCrop[0]));
      const fh = Math.min(crop.h - ft, Math.round(faceBoxInCrop[3] - faceBoxInCrop[1]));
      // The clip is the FIGURE silhouette (already segmented for the hatch)
      // restricted to the face box — literally "the SAM part". A fresh head-mask
      // call on the face crop returned nearly the whole box, so the blur showed
      // as a grey rectangle over the wall (exp #329).
      if (fw > 8 && fh > 8 && sil) {
        // The silhouette lives in HATCH coords; the face box is in CROP coords.
        // Paste the silhouette onto a crop-sized transparent canvas first, THEN
        // extract the face box from it. Chaining resize().extract() in one sharp
        // pipeline threw "extract_area: bad extract area" — the catch swallowed
        // it and every run shipped an unblurred hatch (exp #331).
        const silCropSized = await sharp({
          create: { width: crop.w, height: crop.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        })
          .composite([{ input: await sharp(sil).resize(hatchWidth, hatchHeight, { fit: 'fill' }).png().toBuffer(), left: hatchLeft, top: hatchTop }])
          .png().toBuffer();
        const silHead = await sharp(silCropSized)
          .extract({ left: fl, top: ft, width: fw, height: fh })
          .png().toBuffer();
        const faceCrop = await sharp(cropBuf).extract({ left: fl, top: ft, width: fw, height: fh }).jpeg({ quality: 90 }).toBuffer();
        // blurStrength: 'slight' (DEFAULT, owner-chosen 2026-08-05: shape and tone
        // survive so pose/lighting read, identity does not) | 'strong' (r~12%).
        const factor = blurStrength === 'slight' ? 0.045 : 0.12;
        const radius = Math.max(4, Math.round(fw * factor));
        const blurredFull = await sharp(faceCrop).blur(radius).png().toBuffer();
        const clipped = await sharp(blurredFull).ensureAlpha()
          .composite([{ input: silHead, blend: 'dest-in' }]).png().toBuffer();
        blurLayers.push({ input: clipped, top: ft, left: fl });
        faceBlurInfo = { applied: true, strength: blurStrength, radius, w: fw, h: fh };
        log.info(`[FACE REPAIR] crosshatch+faceblur: figure-silhouette head blurred (${blurStrength}, r=${radius}) inside ${fw}x${fh}, hatch on top`);
      } else if (fw > 8 && fh > 8) {
        faceBlurInfo = { applied: false, reason: 'no figure silhouette (SAM returned nothing after retries)' };
        log.warn('[FACE REPAIR] no figure silhouette — skipping the face blur (a box blur would destroy the background)');
      }
    } catch (err) {
      faceBlurInfo = { applied: false, reason: `error: ${err.message}` };
      log.warn(`[FACE REPAIR] face blur over crosshatch failed (${err.message}) — hatch only`);
    }
  }
  // blur UNDER, hatch OVER.
  const treatedBuf = await sharp(cropBuf)
    .composite([...blurLayers, { input: hatchRegion, top: hatchTop, left: hatchLeft }])
    .png().toBuffer();
  return { treatedBuf, oldMaskPng, coverage: cov, faceBlur: faceBlurInfo, hatchClipped: !!sil, hatchRect: { left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight } };
}

// BLUR — shape-aware silhouette-clipped blur over the figure.
// FAITHFULNESS-CHECK: images.js:11535-11582 (blurFace shapeAware branch).
async function buildBlurTreatment({ cropBuf, crop, boxInCrop, faceOnly, gateCoverage, providedMaskPng = null, maskFetch = null }) {
  const sharp = require('sharp');
  const { fetchFaceHeadMaskPng, fetchSilhouettePng, fetchFigureMaskPng } = require('./imageCompositing');
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
  // FACE blur wants the HEAD mask; a BODY blur must segment the whole FIGURE.
  // fetchFaceHeadMaskPng places face/hair dots and clips to a head — run on a
  // full-body box it returns a head-shaped/partial mask, and that mask IS
  // "SAM round 1" downstream (exp #304: red zone 51864px under blur vs 5032px
  // under crosshatch on the SAME box, because round 1 covered only part of the
  // figure). Body blur now uses the plain figure mask, like every other path.
  // Same rule as whiteout: a caller holding the exact silhouette supplies it
  // and no segmenter runs. Without it a body blur falls back to blurring the
  // whole BOX, which smears the neighbouring figures too.
  // THE BLUR IS CLIPPED TO THE SAM SILHOUETTE — never to the box (owner,
  // 2026-08-27: "you now blur the box. You must blur only the SAM cutout part").
  // Without a silhouette this used to fall through and blur the whole rectangle,
  // which smears the background and any neighbour inside it: on Lab 867 that
  // painted a blurred slab across the tower behind the target's head. A missing
  // silhouette is a FAILURE, exactly as it is for whiteout — the retrying
  // fetcher is tried first, and only then do we give up loudly, instead of
  // shipping a different treatment under the same name.
  const silhouettePng = providedMaskPng
    ? await sharp(providedMaskPng).extract({ left: fLeft, top: fTop, width: fWidth, height: fHeight }).png().toBuffer()
    : (maskFetch ? await maskFetch(cropJpeg, innerFaceBox, {}) : null)
      || (faceOnly
        ? (await fetchFaceHeadMaskPng(cropJpeg, innerFaceBox, fWidth, fHeight) || await fetchSilhouettePng(cropJpeg))
        : (await fetchFigureMaskPng(cropJpeg, innerFaceBox, {}) || await fetchSilhouettePng(cropJpeg)));
  if (!silhouettePng) throw new Error('SAM silhouette unavailable for blur — refusing to blur the raw box (MobileSAM down?)');
  {
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
// Action context (expression / pose / gaze / holding) from scene metadata,
// falling back to interaction text. FAITHFULNESS-CHECK: images.js:11639-11667.
function buildActionContext(sceneDescription, charName) {
  if (!sceneDescription) return '';
  try {
    const { extractSceneMetadata } = require('./storyHelpers');
    const md = extractSceneMetadata(sceneDescription);
    const charData = md?.fullData?.characters?.find(c => c.name?.toLowerCase() === charName.toLowerCase());
    if (charData) {
      const parts = [];
      if (charData.expression) parts.push(`Expression: ${charData.expression}`);
      if (charData.pose) parts.push(`Pose: ${charData.pose}`);
      if (charData.action) parts.push(`Action: ${charData.action}`);
      if (charData.gaze) parts.push(`Gaze: ${charData.gaze}`);
      if (charData.holding && typeof charData.holding === 'object') {
        const holding = [];
        if (charData.holding.leftHand && charData.holding.leftHand !== 'empty') holding.push(`left hand: ${charData.holding.leftHand}`);
        if (charData.holding.rightHand && charData.holding.rightHand !== 'empty') holding.push(`right hand: ${charData.holding.rightHand}`);
        if (holding.length) parts.push(`Holding: ${holding.join(', ')}`);
      }
      if (parts.length) return `\n\n${charName}'s state in this scene (MUST be preserved in the redrawn face):\n- ${parts.join('\n- ')}`;
    }
  } catch { /* fall through */ }
  try {
    const { buildCharActionContextFromInteractions } = require('./imageCompositing');
    return buildCharActionContextFromInteractions(sceneDescription, charName) || '';
  } catch { return ''; }
}

// Quiet-zone instruction for the text overlay position.
// FAITHFULNESS-CHECK: images.js:11476-11498.
function buildTextPositionContext(textPosition, sceneDescription) {
  if (!textPosition) return '';
  const TEXT_POSITION_DESC = {
    'top-left': 'upper left corner', 'top-right': 'upper right corner',
    'bottom-left': 'lower left corner', 'bottom-right': 'lower right corner',
    'top-full': 'upper third (full width)', 'bottom-full': 'lower third (full width)',
  };
  const desc = TEXT_POSITION_DESC[textPosition];
  if (!desc) return '';
  let zoneDesc = null;
  if (sceneDescription) {
    try {
      const { extractSceneMetadata } = require('./storyHelpers');
      zoneDesc = extractSceneMetadata(sceneDescription)?.textZoneDescription || null;
    } catch { /* null */ }
  }
  return `\n\nQuiet zone: keep the ${desc} as ${zoneDesc ? `the established ${zoneDesc} — preserve its existing atmospheric character (clouds, gradient, texture)` : 'soft and visually calm'}. Do not place the character's face or any high-contrast detail there, and do not flatten it to a uniform color. It is intentional negative space in the composition.`;
}

async function buildPrompt({ treatment, faceOnly, charName, opts, sceneBuffer, faceBbox, sceneW, sceneH }) {
  const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
  // IDENTITY vs REGION. Every "paint <name>" / "match <name>'s clothing" line must
  // name the person we WANT (opts.promptName), while scene-state lookups stay keyed
  // on the character who is actually IN the scene (charName). Without this an
  // identity swap sent B's avatar but still ordered "paint one A, match A's
  // clothing" — the text won and nothing changed (exp #329).
  const identityName = opts.promptName || charName;
  // APPEARANCE FACTS. The reference image carries identity, but the crosshatch
  // template had NO text description at all — the model got a name, a clothing
  // line and an avatar (owner, exp #360). The stored per-character description
  // (face, hair, build — the text the detector itself matches on) makes identity
  // explicit. Clothing is stripped: clothingContext is authoritative.
  const richDesc = (typeof opts.characterDescription == "string" ? opts.characterDescription : opts.richDescription) || "";
  const appearanceContext = richDesc
    ? `\n${richDesc.split(/Wearing:/i)[0].replace(/\s+/g, ' ').trim().slice(0, 380)}`
    : '';
  const clothingContext = opts.clothingDescription ? `\nClothing: ${opts.clothingDescription}` : '';
  const issueContext = opts.issueContext || (opts.issueDescription ? `\nIssues to fix: ${opts.issueDescription}` : '');
  const textPositionContext = opts.textPositionContext || buildTextPositionContext(opts.textPosition, opts.sceneDescription);
  const actionContext = opts.actionContext || buildActionContext(opts.sceneDescription, charName);

  if (treatment === 'whiteout' && faceOnly) {
    const sharp = require('sharp');
    const { describeHeadPose } = require('./styleAnalysis');
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
  // Carry the FULL style description, not the bare id. The face path already
  // does this; the body path passed "Art style: watercolor" and nothing more,
  // which is too thin to hold the model to a medium — with a flat placeholder
  // as the target region it leans entirely on the avatar and repaints a
  // photographic face into a painted scene, which the style gate then
  // (correctly) rejects as drift.
  const artStyleContext = (() => {
    if (!opts.artStyle) return '';
    try {
      const { ART_STYLES } = require('./storyHelpers');
      const raw = ART_STYLES[opts.artStyle];
      const txt = typeof raw === 'string' ? raw : (raw && raw.default) || '';
      if (txt) return `\n\nArt style — match this medium and rendering exactly: ${txt}`;
    } catch { /* fall through to the bare id */ }
    return `\n\nArt style: ${opts.artStyle}`;
  })();
  if (treatment === 'blur') {
    const tpl = !faceOnly && PROMPT_TEMPLATES.characterRepairBodyBlended ? PROMPT_TEMPLATES.characterRepairBodyBlended : PROMPT_TEMPLATES.characterRepairBlended;
    if (tpl) return fillTemplate(tpl, { charName: identityName, identityName, appearanceContext, clothingContext, actionContext, issueContext, textPositionContext });
  }
  if (treatment === 'crosshatch') {
    const tpl = PROMPT_TEMPLATES.characterRepairCutout;
    if (tpl) return fillTemplate(tpl, { charName: identityName, identityName, appearanceContext, clothingContext, actionContext, issueContext, artStyleContext, textPositionContext });
  }
  return `This is a children's book illustration. Redraw the marked figure to look like ${identityName} from the reference photo. Match face, hair, skin tone, build and clothing exactly. Preserve the original pose, expression and gaze. Keep art style and background unchanged.${clothingContext}${actionContext}${issueContext}${artStyleContext}`;
}

// ===========================================================================
// THE unified entry point.
// ===========================================================================
// Gate rejections a RE-DRAW can plausibly fix. Each is the model producing
// something unusable, not a wrong instruction — so the same prompt drawn again
// is a genuine new roll of the dice, and measurably a different one.
//   blend_gate           the figure was re-posed / moved (registration already
//                        shifts and rescales; if it is still under the IoU floor
//                        the pose changed, which a shift cannot rescue)
//   style_drift          the redraw came back in a different art style
//   repaired_figure_blurred  the redraw lost its edge detail
// NOT retried: invalid bbox, missing avatar, SAM unavailable — a second call
// fails identically and costs another $0.02.
const RETRYABLE_REJECTIONS = new Set(['blend_gate', 'style_drift', 'repaired_figure_blurred', 'repair_unnatural']);
const REPAIR_ATTEMPTS = 3;

/**
 * Up to REPAIR_ATTEMPTS draws before giving up (owner, 2026-08-17).
 *
 * A user pressing "repair face" and seeing NOTHING happen is the worst outcome
 * this code can produce, and it is what shipped: Noah on p6 of
 * job_1786917840874_rur4nskfv was rejected at mask IoU 34% and the endpoint
 * returned "Grok repair returned no image" with no retry, no reason, and no
 * record. The gate was right — blending a re-posed figure would have smeared
 * him — but "the gate was right" is not an outcome for the person who clicked.
 *
 * The last attempt's rejection is what comes back, so the caller reports a real
 * gate reason rather than a generic failure, and `attempts` says how hard we
 * tried. Every rejection is counted (see runMetrics) — before this, the blend
 * and style gates were not counted at all and manual repairs counted nothing,
 * so nobody could say how often users hit it.
 */
// ---------------------------------------------------------------------------
// Repair-acceptance figure-integrity check (owner recipe, 2026-08-22).
//
// After a successful blend, ONE cheap vision call rates the repaired figure:
// describe their face, describe the OTHER figures' faces, then two yes/no
// observations (MATCH: same medium/detail as the other faces? EDGES: hard
// cut-out boundary around the head?) mapped mechanically onto the owner's
// enum (good / slightly off / clearly off / strongly distorted). clearly off
// or worse rejects the repaint as 'repair_unnatural' (retryable → redraw;
// exhausted → the original is kept).
//
// Why this exact shape — every part was measured on a 21-image corpus and
// cross-checked on a second story's production repairs:
//   - absolute judgment ("does she look natural?") flagged half the CLEAN
//     pages (identical untouched figures rated differently run to run);
//   - the enum alone under-graded: the judge SAW "uncanny, processed" faces
//     and still said "slightly off" (4/9);
//   - comparing the face to the PAGE false-fired: this house's styles
//     legitimately render faces finer than backgrounds (5 false positives);
//   - comparing to the OTHER FIGURES' FACES self-calibrates per style, and
//     deriving the verdict mechanically from the two booleans spares the
//     model the big severity claim it demonstrably ducks: 8/9 caught,
//     0/12 false positives, Flash.
// Skipped when the figure is alone on the page (no other faces to compare),
// when no clothing descriptor exists to identify the figure, or on any API
// failure — the check may only ever reject, never block a repair by erroring.
async function checkRepairNaturalness(imageData, opts = {}) {
  try {
    const others = Array.isArray(opts.protectedBodies) ? opts.protectedBodies.length : 0;
    if (others < 1) return { skipped: 'solo figure — no other faces to compare' };
    const clothing = String(opts.clothingDescription || '').trim();
    if (!clothing) return { skipped: 'no clothing descriptor to identify the figure' };
    const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
    if (!PROMPT_TEMPLATES.repairNaturalness) return { skipped: 'template not loaded' };
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { skipped: 'no GEMINI_API_KEY' };
    const desc = `the figure wearing ${clothing.split(/[.;]/)[0].slice(0, 140)}`;
    const prompt = fillTemplate(PROMPT_TEMPLATES.repairNaturalness, { CHARACTER_DESC: desc });
    const r2Lib = require('./r2');
    const base64 = r2Lib.stripDataUriPrefix(imageData);
    const body = {
      contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0 },
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { skipped: `HTTP ${res.status}` };
    const j = await res.json();
    const t = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!t) return { skipped: 'empty response' };
    // The verdict derives from the two OBSERVATIONS, not the model's own
    // RATING line — the mechanical mapping is the deterministic part, and
    // RATING formatting drifts (a cross-story test lost one to markdown bold).
    const match = (t.match(/MATCH:?\**\s*(yes|no)/i) || [])[1]?.toLowerCase() || null;
    const edges = (t.match(/EDGES:?\**\s*(yes|no)/i) || [])[1]?.toLowerCase() || null;
    if (!match || !edges) return { skipped: 'observations unparseable', raw: t.slice(0, 200) };
    const bad = (match === 'no' || edges === 'yes');
    return { checked: true, bad, match, edges, raw: t.slice(0, 300) };
  } catch (err) {
    return { skipped: err.message };
  }
}

async function repairCharacterFace(sceneInput, avatarInput, opts = {}) {
  let last = null;
  // EVERY attempt's frames, not just the last (owner, 2026-08-24). The loop
  // overwrote `last` on each redraw, so attempts 1 and 2 were garbage-collected
  // and only attempt 3 could ever be inspected — and the route dropped even
  // that. When three draws are all rejected, the three pictures ARE the
  // evidence: they are what says whether the gate was right or miscalibrated.
  // _repairCharacterFaceOnce already carries them on a rejection ("a rejected
  // run is exactly the one you need to LOOK at"); this keeps them.
  const attemptFrames = [];
  const recordFrame = (attempt, r) => {
    attemptFrames.push({
      attempt,
      rejectedReason: r?.rejectedReason || null,
      gateMessage: r?.gateMessage || null,
      grokRawResult: r?.grokRawResult || null,
      blackoutImage: r?.blackoutImage || null,
      blendMask: r?.blendMask || null,
      // Every mask the blend emitted for THIS attempt, so three refusals leave
      // three inspectable sequences instead of three sentences.
      blendSteps: r?.blendSteps || [],
      samRecomputed: r?.samRecomputed ?? null,
      cutoutSent: r?.cutoutSent || null,
      iou: r?.iou ?? r?.blend?.iou ?? null,
    });
  };
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
    last = await _repairCharacterFaceOnce(sceneInput, avatarInput, opts);
    if (last?.imageData) {
      const nat = await checkRepairNaturalness(last.imageData, opts);
      if (nat.checked && nat.bad) {
        metrics().count('repair_reject_repair_unnatural');
        log.info(`🧿 [FACE REPAIR] ${opts.charName || 'character'}: figure-integrity check rejected the repaint (match=${nat.match} edges=${nat.edges}) on attempt ${attempt}/${REPAIR_ATTEMPTS}`);
        last = { ...last, imageData: null, rejectedReason: 'repair_unnatural', gateMessage: `figure-integrity: face does not match the page's other faces (match=${nat.match}, edges=${nat.edges})`, naturalness: nat };
        recordFrame(attempt, last);
        continue;
      }
      if (nat.skipped) log.debug(`🧿 [FACE REPAIR] naturalness check skipped: ${nat.skipped}`);
      if (attempt > 1) {
        metrics().count('char_repair_retry_saved');
        log.info(`✅ [FACE REPAIR] ${opts.charName || 'character'}: accepted on attempt ${attempt}/${REPAIR_ATTEMPTS}`);
      }
      return { ...last, attempts: attempt, attemptFrames, ...(nat.checked ? { naturalness: nat } : {}) };
    }
    const reason = last?.rejectedReason || null;
    recordFrame(attempt, last);
    if (reason) metrics().count(`repair_reject_${reason}`);
    if (!reason || !RETRYABLE_REJECTIONS.has(reason)) break;
    if (attempt < REPAIR_ATTEMPTS) {
      log.info(`🔁 [FACE REPAIR] ${opts.charName || 'character'}: ${reason} on attempt ${attempt}/${REPAIR_ATTEMPTS} — redrawing`);
    }
  }
  const reason = last?.rejectedReason || null;
  if (reason && RETRYABLE_REJECTIONS.has(reason)) {
    metrics().count('char_repair_exhausted');
    log.warn(`🚫 [FACE REPAIR] ${opts.charName || 'character'}: ${REPAIR_ATTEMPTS} attempts all rejected (${reason}) — giving up`);
  }
  return { ...(last || {}), attempts: REPAIR_ATTEMPTS, attemptFrames, exhausted: !!(reason && RETRYABLE_REJECTIONS.has(reason)) };
}

async function _repairCharacterFaceOnce(sceneInput, avatarInput, opts = {}) {
  const sharp = require('sharp');
  const { samUnionBlend, fetchMaskWithRetry } = require('./samBlend');
  const {
    REPAIR_SHARPNESS_MIN_ORIG, REPAIR_SHARPNESS_REJECT_RATIO,
  } = require('./images');
  const { detectPersonBoxInCrop } = require('./figureDetection');
  const {
    fetchFigureHeadMaskPng, measureRegionSharpness, grokEditSceneExact,
  } = require('./imageCompositing');
  const { checkStyleMatch } = require('./styleAnalysis');

  // --- Axis normalisation + defaults (reproduce today's dominant path) -------
  const model0 = opts.model || 'grok';
  const faceOnly0 = opts.faceOnly !== undefined ? !!opts.faceOnly : (opts.treatment === 'whiteout');
  const treatment0 = opts.treatment || 'whiteout';
  const regionSource0 = opts.regionSource || (treatment0 === 'whiteout' ? 'cutout' : (treatment0 === 'crosshatch' && !faceOnly0 ? 'box' : 'cutout'));
  // Bespoke bbox-shape guards (degenerate-cutout, large-face-box) — same
  // downgrades the legacy branches applied before picking a method.
  const guarded = applyGeometryGuards(
    { model: model0, faceOnly: faceOnly0, treatment: treatment0, regionSource: regionSource0 },
    { faceBbox: opts.faceBbox, bodyBbox: opts.bodyBbox || opts.bbox }
  );
  if (guarded._guard) log.info(`👤 [FACE REPAIR] geometry guard applied: ${guarded._guard}`);
  const model = guarded.model, faceOnly = guarded.faceOnly, treatment = guarded.treatment, regionSource = guarded.regionSource;
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

  // Reuse the silhouette detection already produced. `repairPipeline` sets
  // `detectionBodyMask` and the treatments read `figureMaskPng` — the two names
  // were never bridged, so every repair re-segmented from scratch. Re-running
  // SAM is a degradation, not a fallback: detection masks the figure on the FULL
  // page, this path masks it again on a crop, and the crop call is what returned
  // background instead of the child (job_1787689073034_1v6ew0y1kae, IoU 0%).
  // Logged and stamped on the result so a miss surfaces instead of being absorbed.
  const figureMask = opts.figureMaskPng || opts.detectionBodyMask || null;
  const samRecomputed = !figureMask;
  if (samRecomputed) {
    log.warn(`🚨 [FACE REPAIR] ${charName}: no stored figure mask — re-segmenting on the crop (reuse MISS; cause is upstream)`);
    metrics().count('char_repair_sam_recomputed');
  }
  const cropProvidedMask = figureMask
    ? await sharp(figureMask).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer()
    : null;

  // --- Treatment -------------------------------------------------------------
  let treated;
  if (treatment === 'whiteout') {
    treated = await buildWhiteoutTreatment({
      cropBuf, crop, bodyBoxInCrop, boxInCrop, faceClip, hairBox, maskFetch, requireMobilesam,
      gateCoverage: gates.coverage,
      providedMaskPng: cropProvidedMask,
    });
  } else if (treatment === 'crosshatch') {
    // Face box mapped into crop pixels so the hatch can carry a blurred head.
    const fbForBlur = (!faceOnly && Array.isArray(faceBbox) && faceBbox.length === 4) ? [
      Math.max(0, Math.round(faceBbox[1] * W) - crop.x),
      Math.max(0, Math.round(faceBbox[0] * H) - crop.y),
      Math.min(crop.w, Math.round(faceBbox[3] * W) - crop.x),
      Math.min(crop.h, Math.round(faceBbox[2] * H) - crop.y),
    ] : null;
    treated = await buildCrosshatchTreatment({
      cropBuf, crop, boxInCrop, maskFetch, gateCoverage: gates.coverage, sceneBuffer,
      sceneWidth: W, sceneHeight: H, protectedBodies: opts.protectedBodies, bodyBbox,
      faceBoxInCrop: fbForBlur, blurFace: opts.blurFace !== false, blurStrength: opts.blurStrength || 'slight',
      blurFigure: opts.blurFigure === true,
      // Without a silhouette the hatch stays RECTANGULAR and the face blur is
      // skipped — a different treatment wearing the same name.
      providedMaskPng: cropProvidedMask,
    });
  } else if (treatment === 'blur') {
    treated = await buildBlurTreatment({
      cropBuf, crop, boxInCrop, faceOnly, gateCoverage: gates.coverage,
      providedMaskPng: cropProvidedMask,
      maskFetch,
    });
  } else {
    throw new Error(`${descriptor}: unknown treatment "${treatment}"`);
  }
  const { treatedBuf, oldMaskPng } = treated;
  // What the treatment ACTUALLY did — persisted by callers so a silent
  // degradation (rectangular hatch, skipped blur) is visible after the fact.
  const treatmentInfo = { treatment, regionSource, faceOnly, faceBlur: treated.faceBlur || null, hatchClipped: treated.hatchClipped !== false };

  // --- Prompt + model call ---------------------------------------------------
  const prompt = opts.prompt || await buildPrompt({ treatment, faceOnly, charName, opts, sceneBuffer, faceBbox, sceneW: W, sceneH: H });

  let candidateCrop;      // model output resized to crop dims (the paste source)
  let usage;
  let grokRawResult;
  let sentToModelUri = null;   // EXACTLY what went to the model (scene or crop)
  // REUSE: skip the model entirely and blend a stored output again. Registration,
  // gates and the paste are deterministic, so this isolates blend changes from
  // Grok's run-to-run variance — and costs nothing.
  const reuseUri = opts.reuseCandidate || null;
  if (reuseUri) {
    const buf = Buffer.from(String(reuseUri).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    grokRawResult = String(reuseUri);
    usage = { cost: 0, reused: true };
    sentToModelUri = `data:image/png;base64,${treatedBuf.toString('base64')}`;
    candidateCrop = regionSource === 'box'
      ? await sharp(buf).resize(W, H, { fit: 'fill' }).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer()
      : await sharp(buf).resize(crop.w, crop.h, { fit: 'fill' }).png().toBuffer();
    log.info(`[FACE REPAIR] reusing a stored model output — no model call (${descriptor})`);
  } else if (regionSource === 'box') {
    // The model edits the WHOLE scene (treatment already painted on the crop
    // region of the scene). Composite the treated crop back into the scene,
    // send the full scene through the exact-aspect round-trip, then extract the
    // same crop from the returned scene as the blend candidate.
    const treatedScene = await sharp(sceneBuffer).composite([{ input: treatedBuf, left: crop.x, top: crop.y }]).png().toBuffer();
    const treatedSceneUri = `data:image/png;base64,${treatedScene.toString('base64')}`;
    // "sent to model" must BE what the model received. In box mode that is the
    // full treated SCENE, not the treated crop — showing the crop next to a
    // full-page raw output made the pair impossible to compare (owner, #307).
    sentToModelUri = treatedSceneUri;
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
        // rejectedReason below is 'style_drift' — the retry loop classifies on it.
        // Carry the images, same as the blend gate does — a rejected run is
        // exactly the one you need to look at, and a style verdict with no
        // picture behind it cannot be judged or argued with.
        return {
          imageData: null, character: charName, method: legacyMethod, descriptor,
          rejectedReason: 'style_drift',
          gateMessage: `${sm.styleB} vs ${sm.styleA}`,
          grokRawResult,
          blackoutImage: sentToModelUri || `data:image/png;base64,${treatedBuf.toString('base64')}`,
          promptSent: prompt,
          usage,
        };
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
  // Colour matching ON for BOTH paths by default.
  //  - FACE (bodyColorMode=false): garmentOnly correction runs — it tone-matches
  //    only material that CONTINUES past the bottom clip into the untouched body
  //    (a coat collar, or the neck's own skin), so the seam has no colour line.
  //    Covers all three clip contents: only-clothing, clothing+skin, only-skin
  //    (neck skin → matched to the body's neck; the face shifts with it as one
  //    tone). Hair / the face with no continuation get zero shift (identity kept).
  //  - BODY (bodyColorMode=true): figure correction is skipped inside the blend;
  //    only the background at the silhouette border is protected.
  // Either path can be overridden (Test Lab A/B) via explicit opts.
  const colorCorrect = opts.colorCorrect !== undefined ? opts.colorCorrect : true;
  const bodyColorMode = opts.bodyColorMode !== undefined ? opts.bodyColorMode : !faceOnly;
  let blend;
  // EVERY mask the blend computes is emitted through addStep — the SAM masks,
  // the union, the red zone, the red/green IoU disagreement view and the final
  // alpha. Production used to pass nothing, so the no-op default swallowed all
  // of them: `charRepairBlendMask` has been null in every story since
  // 2026-06-27, and a gate rejection ("mask IoU 48%") could not be looked at,
  // only read about. The Test Lab saw them and production did not, which is
  // exactly backwards — a refused repair on a customer's page is the one you
  // most need to see. Collected here for every caller; the Test Lab's own
  // addStep still runs alongside.
  const blendSteps = [];
  const collectStep = async (label, dataUri) => {
    if (dataUri) blendSteps.push({ label, image: dataUri });
    if (typeof opts.addStep === 'function') {
      try { await opts.addStep(label, dataUri); } catch { /* a viewer must never break a repair */ }
    }
  };
  try {
    blend = await samUnionBlend({
      originalCropBuf: cropBuf,
      candidateCropBuf: candidateCrop,
      boxInCrop,
      cropW: crop.w,
      cropH: crop.h,
      oldMaskPng: oldMaskPng || null,
      addStep: collectStep,
      failCtx: {},
      maskFetcher: (faceOnly && oldMaskPng) ? async (buf) => {
        const r2Body = r2BodyBox || bodyBoxInCrop;
        return fetchFigureHeadMaskPng(buf, r2Body, boxInCrop, crop.w, crop.h, maskFetch, { clipMode: 'bottom', hairBox });
      } : null,
      clipRect: faceClip,
      colorCorrect,
      bodyColorMode,
      // Other characters, in crop pixels — round 2 must not adopt their limbs.
      // DINO's face box in crop pixels — round 2 uses its centre as the head seed.
      faceBoxInCrop: (Array.isArray(faceBbox) && faceBbox.length === 4) ? [
        Math.max(0, Math.round(faceBbox[1] * W) - crop.x),
        Math.max(0, Math.round(faceBbox[0] * H) - crop.y),
        Math.min(crop.w, Math.round(faceBbox[3] * W) - crop.x),
        Math.min(crop.h, Math.round(faceBbox[2] * H) - crop.y),
      ] : null,
      r2Prompt: opts.r2Prompt || 'face',
      protectedBoxesInCrop: (Array.isArray(opts.protectedBodies) ? opts.protectedBodies : [])
        .filter(b => Array.isArray(b) && b.length === 4)
        .map(b => [
          Math.max(0, Math.round(b[1] * W) - crop.x),
          Math.max(0, Math.round(b[0] * H) - crop.y),
          Math.min(crop.w, Math.round(b[3] * W) - crop.x),
          Math.min(crop.h, Math.round(b[2] * H) - crop.y),
        ])
        .filter(b => b[2] > b[0] + 8 && b[3] > b[1] + 8),
      // CUTOUT has no scene anchor, so the model redraws the figure a few
      // percent off (exp #345: ~40px lower, IoU 53% -> gate reject). Register
      // the candidate onto the original silhouette first; only kept if IoU
      // improves, so a genuinely re-posed figure is still rejected.
      // ALWAYS on. In cutout mode it also SHIFTS the candidate; in box mode the
      // model edits in place, so a background that still mismatches after the
      // best alignment means the model redrew the scene — reject it. Box-mode
      // production repairs previously had no background check at all, which is
      // why a misaligned paste shipped (story job_1786024729214_zrjgzqiey p5)
      // while the same page was rejected in the Lab.
      registerCandidate: true,
      // garmentOnly / bgBorderMatch default to true inside samUnionBlend; thread
      // them only when a caller (Test Lab A/B) overrides, so prod keeps the defaults.
      ...(opts.garmentOnly !== undefined ? { garmentOnly: opts.garmentOnly } : {}),
      ...(opts.bgBorderMatch !== undefined ? { bgBorderMatch: opts.bgBorderMatch } : {}),
      featherPx: opts.featherPx,
      erodeFeather: opts.erodeFeather,
      // Ramp placement / pad scope — same reason as above: thread only when a
      // caller overrides, so production keeps samUnionBlend's defaults.
      ...(opts.featherMode !== undefined ? { featherMode: opts.featherMode } : {}),
      ...(opts.padMode !== undefined ? { padMode: opts.padMode } : {}),
      // BODY repairs default to the figure-exact blend (two-band footprint,
      // structure confidence, elongated-rim removal) — calibrated through Lab
      // experiments #278-#288 on 2026-08-05: old outline invisible, crisp model
      // content kept, no halo. FACE repairs keep the legacy padded-union shape
      // (old/new head masks nearly coincide; separately calibrated) until their
      // own A/B. opts.blendShape still overrides both ways.
      blendShape: opts.blendShape !== undefined ? opts.blendShape : (faceOnly ? 'padded-union' : 'figure-exact'),
      // Uniform gates — tunable for the Test Lab A/B, default ON in production.
      gateIou: gates.iou,
      gateWhiteCard: gates.whiteCard,
      ...(opts.iouThreshold != null ? { iouThreshold: opts.iouThreshold } : {}),
      ...(opts.whiteCardMaxFrac != null ? { whiteCardMaxFrac: opts.whiteCardMaxFrac } : {}),
    });
  } catch (blendErr) {
    log.warn(`🚫 [FACE REPAIR] ${descriptor} for ${charName} REJECTED by blend gate: ${blendErr.message}`);
    // Carry the images: a rejected run is exactly the one you need to LOOK at.
    return {
      imageData: null, character: charName, method: legacyMethod, descriptor,
      rejectedReason: 'blend_gate', gateMessage: blendErr.message, usage,
      blackoutImage: sentToModelUri || `data:image/png;base64,${treatedBuf.toString('base64')}`,
      grokRawResult,
      promptSent: prompt,
      // The masks the gate judged. `blendMask` is the last one emitted (the
      // composite alpha) — the field the version viewer already renders and
      // which has been null since the blend moved onto SAM. blendSteps carries
      // the whole sequence, including the red/green disagreement view that
      // shows WHY an IoU came out at 48%.
      blendSteps,
      blendMask: blendSteps.length ? blendSteps[blendSteps.length - 1].image : null,
      iou: blendErr?.partialResult?.iou ?? null,
      samRecomputed,
    };
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
        require('./runMetrics').forJob(require('./styledAvatars')._cacheContext?.getStore?.()).count('blur_gate_reject');
        return { imageData: null, character: charName, method: legacyMethod, descriptor, rejectedReason: 'repaired_figure_blurred', sharpness: { original: origSharpness, repaired: repairedSharpness }, usage };
      }
    } catch (e) { log.warn(`[FACE REPAIR] sharpness gate failed (${e.message}) — accepting unchecked`); }
  }

  const finalImageData = `data:image/jpeg;base64,${composited.toString('base64')}`;
  const originalSceneDataUri = `data:image/jpeg;base64,${sceneBuffer.toString('base64')}`;
  const treatedDataUri = sentToModelUri || `data:image/png;base64,${treatedBuf.toString('base64')}`;
  const ci = blend.colorInfo;
  const ccLog = ci
    ? ` Colour-match: figure ΔE ${ci.deltaEBefore ?? 'n/a'}, seam ${ci.seamBefore ?? 'n/a'}→${ci.seamAfter ?? 'n/a'}${ci.bgMatchedPx ? `, bg ${ci.bgMatchedPx}px` : ''}${Array.isArray(ci.clusters) ? `, ${ci.clusters.filter(c => c.src === 'mean+border').length} bordered material(s) matched` : ''}.`
    : ' Colour-match: nothing continued past the clip (no seam material to match).';
  log.info(`✅ [FACE REPAIR] ${descriptor} for ${charName} completed. Crop ${crop.w}x${crop.h}@(${crop.x},${crop.y}).${ccLog} Cost: $${usage?.cost || 0.02}`);
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
    treatmentInfo,
    promptSent: prompt,
    iou: blend.iou,
    colorInfo: blend.colorInfo || null,
    blendRule: blend.blendRule,
    // Same masks on the way OUT as on a rejection — a successful repair that
    // still looks wrong needs them just as much (the viewer's "Blend mask"
    // slot has rendered nothing since the blend moved onto SAM).
    blendSteps,
    blendMask: blendSteps.length ? blendSteps[blendSteps.length - 1].image : null,
    samRecomputed,
    debug: opts.includeDebug ? { prompt, sceneSent: treatedDataUri, avatarSent: avatarUri, grokRawResult, bbox: bodyBbox, faceBbox, crop, descriptor } : null,
  };
}

// ---------------------------------------------------------------------------
// applyGeometryGuards — the bespoke bbox-shape downgrades the legacy branches
// applied BEFORE picking a method, ported into axis space. Deterministic;
// exposed for unit tests.
//
//  degenerate-cutout : a body cutout whose bbox covers >50% of the page (or is
//                      >85% wide/tall) would repaint nearly the whole page →
//                      downgrade cutout→box (mask-hatch only the figure region).
//                      FAITHFULNESS-CHECK: images.js:11372-11381.
//  large-face-box    : a "face" box covering >=60% of the body box is not a real
//                      face box (faceBox==bodyBox) — a face BLUR would blur the
//                      whole figure to mush → downgrade to body crosshatch.
//                      Does NOT apply to whiteout (the face-insert whiteout marks
//                      only the SAM head silhouette). FAITHFULNESS-CHECK:
//                      images.js:11390-11399 + 11453-11456.
// ---------------------------------------------------------------------------
function applyGeometryGuards(axes, { faceBbox, bodyBbox } = {}) {
  const out = { ...axes };
  const bb = Array.isArray(bodyBbox) && bodyBbox.length === 4 ? bodyBbox : null;
  if (out.regionSource === 'cutout' && !out.faceOnly && bb) {
    const bboxW = Math.max(0, bb[3] - bb[1]);
    const bboxH = Math.max(0, bb[2] - bb[0]);
    if (bboxW * bboxH > 0.5 || bboxW > 0.85 || bboxH > 0.85) {
      out.regionSource = 'box';
      out._guard = 'degenerate-cutout→box';
    }
  }
  if (out.treatment === 'blur' && out.faceOnly && Array.isArray(faceBbox) && faceBbox.length === 4 && bb) {
    const faceArea = Math.max(0, faceBbox[2] - faceBbox[0]) * Math.max(0, faceBbox[3] - faceBbox[1]);
    const bodyArea = Math.max(1e-6, (bb[2] - bb[0]) * (bb[3] - bb[1]));
    if (faceArea / bodyArea >= 0.6) {
      out.treatment = 'crosshatch';
      out.faceOnly = false;
      out.regionSource = 'box';
      out._guard = 'large-face-box→body-crosshatch';
    }
  }
  return out;
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
  // FACE = BLUR (owner, 2026-08-26). A blur destroys the features while keeping
  // head size and tilt, so the pose survives and identity has to come from the
  // reference avatar; a whiteout hands the model an empty region and loses that
  // anchor. Same reasoning the whole-figure decision already used for the head
  // it blurs over the hatch (2026-08-05, exp #315). The whiteout default was
  // never an experiment verdict — face-repair-merge-design.md records it only as
  // "reproduce today's dominant path". Only the TREATMENT axis moves: region
  // stays `cutout` and every gate still applies.
  return faceOnly
    ? { regionSource: 'cutout', treatment: 'blur', model, faceOnly: true }
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
  // Face target + face box → cutout+BLUR+face (owner, 2026-08-26; see
  // resolveRepairAxes). Was whiteout; only the treatment axis changed.
  if (target === 'face' && hasFaceBbox) {
    return { regionSource: 'cutout', treatment: 'blur', model, faceOnly: true };
  }
  // Explicit flags.
  if (useBlended === true) return { regionSource: 'box', treatment: 'blur', model, faceOnly: target === 'face' };
  if (useCutout === true) return { regionSource: 'cutout', treatment: 'crosshatch', model, faceOnly: false };
  if (useFullScene === true) return { regionSource: 'box', treatment: 'crosshatch', model, faceOnly: false };
  // Default: body → inpaint (box+crosshatch); face (no faceBbox) → blur+box+face.
  if (target === 'face') { require('./runMetrics').forJob(require('./styledAvatars')._cacheContext?.getStore?.()).count('legacy_blend_fallback'); return { regionSource: 'box', treatment: 'blur', model, faceOnly: true }; }
  // grok_blackout is deprecated (Stage 5): route through the gated crosshatch
  // box path instead of a no-gate verbatim full-scene repaint.
  return { regionSource: 'box', treatment: 'crosshatch', model, faceOnly: false };
}

module.exports = {
  repairCharacterFace,
  checkRepairNaturalness,
  // Deterministic pieces exposed for unit tests.
  resolveRegion,
  repairDescriptor,
  legacyMethodAlias,
  resolveRepairAxes,
  legacyFlagsToAxes,
  applyGeometryGuards,
  buildActionContext,
};
