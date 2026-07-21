// server/lib/samBlend.js
// THE shared SAM-union repair blend, engine-agnostic. Extracted from testlab.js so
// PRODUCTION character repair (face) and the Test Lab both call one implementation.
// Colour helpers + mask fetchers come from images.js via lazy require inside the
// functions (acyclic at load time; images.js lazy-requires this module back for the
// face-insert path). addStep defaults to a no-op so production callers omit it.
const { log } = require('../utils/logger');

// Stamped on every blended entry so the UI can show WHICH blend generation
// produced an image — mixed-generation comparisons were repeatedly mistaken
// for bugs. Bump on every blend-behavior change.
const BLEND_RULE_VERSION = 'union-soft2-pad6';

async function fetchMaskWithRetry(buf, box, tries = 5, opts = {}) {
  const { fetchFigureMaskPng } = require('./images');
  for (let i = 0; i < tries; i++) {
    const m = await fetchFigureMaskPng(buf, box, opts);
    if (m) return m;
    if (i < tries - 1) {
      log.info(`[TESTLAB] figure mask unavailable (attempt ${i + 1}/${tries}) — waiting for model warm-up`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  return null;
}

// Keep only ONE connected component of a binary mask: the one containing the
// seed (sx,sy) — or, if the seed isn't on the mask, the LARGEST component.
// Drops disconnected islands (stray SAM fragments of a neighbouring figure).
// Returns Uint8Array(w*h) with 255 for kept pixels.
function _faceConnectedComponent(mask, W, H, sx, sy) {
  const n = W * H;
  const on = new Uint8Array(n);
  for (let i = 0; i < n; i++) on[i] = mask[i] > 128 ? 1 : 0;
  const keep = new Uint8Array(n);
  const flood = (start, visited) => {
    const comp = [start]; const stack = [start]; visited[start] = 1;
    while (stack.length) {
      const k = stack.pop(); const x = k % W, y = (k / W) | 0;
      if (x > 0 && on[k - 1] && !visited[k - 1]) { visited[k - 1] = 1; stack.push(k - 1); comp.push(k - 1); }
      if (x < W - 1 && on[k + 1] && !visited[k + 1]) { visited[k + 1] = 1; stack.push(k + 1); comp.push(k + 1); }
      if (y > 0 && on[k - W] && !visited[k - W]) { visited[k - W] = 1; stack.push(k - W); comp.push(k - W); }
      if (y < H - 1 && on[k + W] && !visited[k + W]) { visited[k + W] = 1; stack.push(k + W); comp.push(k + W); }
    }
    return comp;
  };
  const seedIdx = (sx >= 0 && sy >= 0 && sx < W && sy < H && on[sy * W + sx]) ? sy * W + sx : -1;
  const visited = new Uint8Array(n);
  if (seedIdx >= 0) { for (const j of flood(seedIdx, visited)) keep[j] = 255; return keep; }
  // seed off the mask → keep the largest component
  let best = [];
  for (let i = 0; i < n; i++) { if (on[i] && !visited[i]) { const c = flood(i, visited); if (c.length > best.length) best = c; } }
  for (const j of best) keep[j] = 255;
  return keep;
}

// Blur a binary mask, then threshold the blurred BYTES in JS.
// sharp's CHAINED .blur(σ).threshold(t) does NOT threshold the blurred pixels —
// it returns a slightly ERODED mask instead of the intended dilation (verified:
// a 40px square stays 40px wide with its corners eaten). Splitting the two makes
// the mask actually grow outward. Returns a single-channel Buffer(w*h).
async function maskBlurThreshold(buf, w, h, sigma, thr) {
  const sharp = require('sharp');
  const n = w * h;
  const bl = await sharp(buf, { raw: { width: w, height: h, channels: 1 } }).blur(sigma).raw().toBuffer();
  const st = Math.max(1, Math.round(bl.length / n));
  const o = Buffer.alloc(n);
  for (let i = 0; i < n; i++) o[i] = bl[i * st] >= thr ? 255 : 0;
  return o;
}

/**
 * Interior seed points for SAM round 2, sampled from round 1's mask: erode a
 * few px (so points sit deep inside the figure) and take the widest-run
 * centers at 25/50/75% of the mask's height (head/torso/legs).
 */
async function _interiorSeedPoints(maskPng, w, h) {
  try {
    const sharp = require('sharp');
    const a = await sharp(maskPng).resize(w, h, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
    const s = Math.max(1, Math.round(a.length / (w * h)));
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && a[(y * w + x) * s] > 128;
    let minx = w, maxx = -1, miny = h, maxy = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) {
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (maxx < 0) return [];
    const R = 4;
    const interior = (x, y) => on(x, y) && on(x - R, y) && on(x + R, y) && on(x, y - R) && on(x, y + R);
    const pts = [];
    for (const fy of [0.25, 0.5, 0.75]) {
      const y = Math.round(miny + (maxy - miny) * fy);
      let best = null, run = 0, start = 0;
      for (let x = minx; x <= maxx + 1; x++) {
        if (x <= maxx && interior(x, y)) { if (run === 0) start = x; run++; }
        else { if (run > 0 && (!best || run > best.run)) best = { run, cx: Math.round(start + run / 2) }; run = 0; }
      }
      if (best && best.run >= 2 * R) pts.push([best.cx, y]);
    }
    return pts;
  } catch { return []; }
}

/**
 * THE shared repair blend — engine-agnostic. Given the original crop and a
 * candidate crop (any model's output for the same region), put ONLY the
 * repainted figure back:
 *   1. SAM masks the figure in BOTH crops (old mask reusable by the caller).
 *   2. IoU gate: masks barely overlapping = the figure moved → reject.
 *   3. Union = pixels owned by the candidate. RED zones (figure shrank —
 *      old-figure remnants underneath) are restored from the REAL background
 *      via diffusion fill, never the model's hallucinated infill.
 *   4. Alpha: CRISP along the entire new-figure edge (a real figure boundary
 *      — agreed or grown), feather ONLY the red-zone borders (background
 *      meeting background, where feathering is safe and useful).
 * Returns a feathered RGBA PNG to composite at the crop position; throws
 * (with steps attached) on gate failures. Every mask is emitted as a step.
 */
async function samUnionBlend({ originalCropBuf, candidateCropBuf, boxInCrop, cropW, cropH, oldMaskPng = null, addStep = async () => {}, failCtx = {}, clipRect = null, maskPoints = null, maskFetcher = null, colorCorrect = true, featherPx = null, erodeFeather = true, colorBorderRefine = true, bodyColorMode = false, bgBorderMatch = true, garmentOnly = true }) {
  const sharp = require('sharp');
  const fail = (msg) => {
    const err = new Error(msg);
    err.partialResult = failCtx;
    return err;
  };

  const oldMask = oldMaskPng || (maskFetcher ? await maskFetcher(originalCropBuf) : await fetchMaskWithRetry(originalCropBuf, boxInCrop, 5, maskPoints || {}));
  if (!oldMask) throw fail('SAM could not mask the original figure (mask service unavailable?) — retry.');
  let newMask;
  if (maskFetcher) {
    newMask = await maskFetcher(candidateCropBuf);
  } else {
    // Round 2 runs on the SAME box — a valid repair keeps the figure in place
    // (the IoU gate rejects moves) — padded 4% for figure growth, and seeded
    // with points sampled from INSIDE round 1's mask: the original box on a
    // changed image can straddle background and SAM latches onto whatever
    // sits there (exp #68: a mountain). Interior points anchor it to the figure.
    const bw = boxInCrop[2] - boxInCrop[0], bh = boxInCrop[3] - boxInCrop[1];
    const padBox = [
      Math.max(0, Math.round(boxInCrop[0] - bw * 0.04)),
      Math.max(0, Math.round(boxInCrop[1] - bh * 0.04)),
      Math.min(cropW, Math.round(boxInCrop[2] + bw * 0.04)),
      Math.min(cropH, Math.round(boxInCrop[3] + bh * 0.04)),
    ];
    const seeds = await _interiorSeedPoints(oldMask, cropW, cropH);
    const r2Opts = { ...(maskPoints || {}) };
    if (seeds.length) r2Opts.points = [...(r2Opts.points || []), ...seeds];
    newMask = await fetchMaskWithRetry(candidateCropBuf, padBox, 5, r2Opts);
  }
  if (!newMask) throw fail('SAM found no figure in the model output inside the target box — the model likely painted the figure elsewhere or not at all. See the raw output step; Redo.');

  const raw1 = { raw: { width: cropW, height: cropH, channels: 1 } };
  const n = cropW * cropH;
  const strip = (buf) => {
    const s = Math.max(1, Math.round(buf.length / n));
    if (s === 1) return buf;
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = buf[i * s];
    return out;
  };

  // Both SAM rounds as APPLIED views (image-with-region-white + cutout) —
  // never raw masks.
  const emitMaskViews = async (roundLabel, imgBuf, maskPngBuf) => {
    const sharpL = require('sharp');
    const img = await sharpL(imgBuf).resize(cropW, cropH, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
    // Binarize the SAM alpha — soft mask edges would read as feathering.
    const mAlphaRaw = await sharpL(maskPngBuf).resize(cropW, cropH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
    const s2 = Math.max(1, Math.round(mAlphaRaw.length / n));
    const mAlpha = Buffer.alloc(n);
    for (let i = 0; i < n; i++) mAlpha[i] = mAlphaRaw[i * s2] > 128 ? 255 : 0;
    const mask = await sharpL(Buffer.alloc(n * 3, 255), { raw: { width: cropW, height: cropH, channels: 3 } })
      .ensureAlpha().joinChannel(Buffer.from(mAlpha), raw1).png().toBuffer();
    const white = await sharpL(img).composite([{ input: mask, left: 0, top: 0 }]).jpeg().toBuffer();
    await addStep(`${roundLabel}: region whited out`, `data:image/jpeg;base64,${white.toString('base64')}`);
    const figPng = await sharpL(img).ensureAlpha().joinChannel(Buffer.from(mAlpha), raw1).png().toBuffer();
    const cut = await sharpL({ create: { width: cropW, height: cropH, channels: 3, background: { r: 30, g: 30, b: 30 } } })
      .composite([{ input: figPng }]).jpeg().toBuffer();
    await addStep(`${roundLabel}: figure cutout`, `data:image/jpeg;base64,${cut.toString('base64')}`);
  };
  await emitMaskViews('SAM round 1 (original)', originalCropBuf, oldMask);
  await emitMaskViews('SAM round 2 (model output)', candidateCropBuf, newMask);

  const oldA = await sharp(oldMask).resize(cropW, cropH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
  const newA = await sharp(newMask).resize(cropW, cropH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();

  // Face-scoped repairs: BOTH masks hard-clipped to the target region — round 2
  // SAM routinely over-segments (grabs head+torso+background) but that raw
  // sprawl is irrelevant: the clip bounds the union to the face box. (Do NOT
  // gate on the pre-clip round-2 size — it false-rejected perfect repairs where
  // SAM merely over-segmented, exp #122 Verena. The real defenses are the
  // post-clip IoU gate and the white-card gate below.)
  if (clipRect?.length === 4) {
    for (let y = 0; y < cropH; y++) for (let x = 0; x < cropW; x++) {
      if (x < clipRect[0] || x >= clipRect[2] || y < clipRect[1] || y >= clipRect[3]) {
        const i = y * cropW + x;
        oldA[i * Math.max(1, Math.round(oldA.length / n))] = 0;
        newA[i * Math.max(1, Math.round(newA.length / n))] = 0;
      }
    }
  }

  // Round-2 over-segmentation salvage: if, AFTER clipping, round 2 fills nearly
  // the whole clip box (SAM returned the box, not a silhouette), it carries no
  // real silhouette — fall back to round 1's head mask for the union. A face
  // repair keeps the head in place, so round 1 IS the correct paste shape; this
  // avoids pasting a rectangular face-box patch.
  if (clipRect?.length === 4) {
    const s1 = Math.max(1, Math.round(oldA.length / n));
    const s2 = Math.max(1, Math.round(newA.length / n));
    const clipArea = Math.max(1, (clipRect[2] - clipRect[0]) * (clipRect[3] - clipRect[1]));
    let po = 0, pn = 0;
    for (let i = 0; i < n; i++) { if (oldA[i * s1] > 128) po++; if (newA[i * s2] > 128) pn++; }
    if (pn > 0.9 * clipArea && po > 0) {
      for (let i = 0; i < n; i++) newA[i * s2] = oldA[i * s1];
      log.warn(`[TESTLAB] round-2 mask filled ${Math.round(100 * pn / clipArea)}% of the clip box — using round-1 head silhouette for the union (face stays in place).`);
    }
  }

  const union = Buffer.alloc(n);
  const newBin = Buffer.alloc(n);
  const redMask = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const o = (oldA[i] || 0) > 128 ? 255 : 0;
    const w = (newA[i] || 0) > 128 ? 255 : 0;
    union[i] = Math.max(o, w);
    newBin[i] = w;
  }
  // Drop disconnected islands — keep ONLY the union component that contains the
  // FACE. A stray SAM fragment (e.g. a neighbour's clothing the crop caught)
  // would otherwise get pasted AND fold into the colour-match statistics,
  // throwing the tone off. Filtering oldA/newA here also cleans every downstream
  // consumer (colour ref, red zone, figExclude).
  let interPx = 0, unionPx = 0, redPx = 0;
  {
    const cxF = boxInCrop?.length === 4 ? Math.round((boxInCrop[0] + boxInCrop[2]) / 2) : (cropW >> 1);
    const cyF = boxInCrop?.length === 4 ? Math.round((boxInCrop[1] + boxInCrop[3]) / 2) : (cropH >> 1);
    const keep = _faceConnectedComponent(union, cropW, cropH, cxF, cyF);
    let dropped = 0;
    for (let i = 0; i < n; i++) {
      if (!keep[i]) { if (union[i]) dropped++; union[i] = 0; newBin[i] = 0; oldA[i] = 0; newA[i] = 0; }
      const o = oldA[i] > 128, w = newBin[i] > 128;
      redMask[i] = (o && !w) ? 255 : 0;
      if (o && w) interPx++;
      if (o || w) unionPx++;
      if (o && !w) redPx++;
    }
    if (dropped > 0) log.info(`[TESTLAB] dropped ${dropped}px disconnected mask islands (kept the face component)`);
  }
  const iou = unionPx > 0 ? interPx / unionPx : 0;
  if (iou < 0.55) {
    throw fail(`Painted figure barely overlaps the original (mask IoU ${(iou * 100).toFixed(0)}%) — the figure moved or changed pose. Redo instead of blending a misaligned figure.`);
  }

  // Disagreement visualization: red = old-only, green = new-only.
  const diffRgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const o = (oldA[i] || 0) > 128, w = (newA[i] || 0) > 128;
    diffRgb[i * 3] = o && !w ? 255 : 40;
    diffRgb[i * 3 + 1] = w && !o ? 255 : 40;
    diffRgb[i * 3 + 2] = 40;
  }
  await addStep('mask difference (red = old-only, green = new-only)',
    `data:image/jpeg;base64,${(await sharp(diffRgb, { raw: { width: cropW, height: cropH, channels: 3 } }).jpeg().toBuffer()).toString('base64')}`);

  // THE RULE: every pixel in EITHER mask (the union) comes from the NEW image
  // at FULL opacity — the figure is never feathered. The union is DILATED a
  // few px first: SAM masks are tight and the figure's anti-aliased edge
  // pixels sit just outside them — a zero-pad hard cut slices that soft edge
  // and leaves a background fringe against the figure. Feathering exists only
  // OUTSIDE the padded union: a falloff band where the model's background
  // fades into the original background.
  // NO FEATHERING — the blend is the hard padded union, nothing else.
  // Every pixel in the union comes from the new image at 255; every pixel
  // outside stays original at 255. Binary, no falloff band.
  // Real ≈6px OUTWARD dilation via maskBlurThreshold (sharp's chained
  // blur().threshold() erodes instead — it under-covered the figure, so thin
  // protrusions like the nose poked past the union → old feature at the border,
  // the "ghost nose").
  const padPx = 6;
  const unionPadded = await maskBlurThreshold(union, cropW, cropH, padPx / 1.5, 16);
  const alpha1 = Buffer.from(unionPadded);

  // Split figure vs background by the SAM MASK (newBin), NOT brightness: Qwen
  // lightens BOTH the background and parts of the face, so a luminance threshold
  // misclassifies lightened face as background. The 6px margin, though, exists
  // because SAM's mask is sometimes too tight and clips the figure's edge, so we
  // must NOT blanket-fill it. Protect a ~3px ring around the figure (its edge),
  // background-fill only beyond that:
  //   FIGURE  = newBin (+3px edge ring) → face correction, kept from candidate
  //   BG-FILL = alpha1 && !dilate(newBin,3) → red zone + outer glow → background
  const s1r = Math.max(1, Math.round(oldA.length / n));
  const newDil = await maskBlurThreshold(Buffer.from(newBin), cropW, cropH, 2, 16); // real ≈3px OUTWARD dilation
  const redZone = Buffer.alloc(n);
  let redZonePx = 0;
  for (let i = 0; i < n; i++) {
    if (alpha1[i] && newDil[i] <= 128) { redZone[i] = 255; redZonePx++; }
  }
  if (redZonePx) log.info(`[TESTLAB] bg-fill mask: ${redZonePx}px (red zone + outer margin beyond the figure's 3px edge ring)`);

  // White-card gate: a face painted on a white panel passes IoU (geometry
  // aligns) and the style gate (a colorless panel has no "style") — v92's
  // Roger shipped exactly that. Mechanical check: the pixels TAKEN from the
  // new image must not be substantially near-white.
  {
    const candRaw0 = await sharp(candidateCropBuf).resize(cropW, cropH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    let unionCnt = 0, whiteCnt = 0;
    for (let i = 0; i < n; i++) {
      if (!alpha1[i]) continue;
      unionCnt++;
      if (candRaw0[i * 3] >= 243 && candRaw0[i * 3 + 1] >= 243 && candRaw0[i * 3 + 2] >= 243) whiteCnt++;
    }
    const whiteFrac = unionCnt ? whiteCnt / unionCnt : 0;
    if (whiteFrac > 0.22) {
      throw fail(`Blended region is ${(whiteFrac * 100).toFixed(0)}% near-white — the model painted the face on a white card. Redo.`);
    }
  }

  // Applied mask views instead of raw black/white masks: (a) the original
  // with the padded union whited out — the region the blend treats as
  // figure; (b) the pixels actually TAKEN from the new image.
  const candResized = await sharp(candidateCropBuf).resize(cropW, cropH, { fit: 'fill' }).png().toBuffer(); // PNG: lossless paste source
  const origResized = await sharp(originalCropBuf).resize(cropW, cropH, { fit: 'fill' }).png().toBuffer(); // PNG: lossless colour reference
  const unionAlphaPng = await sharp(Buffer.alloc(n * 3, 255), { raw: { width: cropW, height: cropH, channels: 3 } })
    .ensureAlpha().joinChannel(Buffer.from(unionPadded), raw1).png().toBuffer();
  const whiteVis = await sharp(origResized).composite([{ input: unionAlphaPng }]).jpeg().toBuffer();
  await addStep('original with SAM union whited out (padded 6px)', `data:image/jpeg;base64,${whiteVis.toString('base64')}`);
  const cutoutPng = await sharp(candResized).ensureAlpha().joinChannel(Buffer.from(unionPadded), raw1).png().toBuffer();
  const cutVis = await sharp({ create: { width: cropW, height: cropH, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .composite([{ input: cutoutPng }]).jpeg().toBuffer();
  await addStep('SAM-identified region — pixels taken from the new image', `data:image/jpeg;base64,${cutVis.toString('base64')}`);

  // Qwen colour-shift correction — remap the pasted figure's tone back toward
  // the original (histogram) and close the border gap (harmonic seam) so the
  // paste doesn't read as a different-coloured patch. No-op below threshold.
  // Reference distribution = the ORIGINAL figure mask (oldA), applied to the
  // union being pasted (alpha1).
  // Build the paste as RAW RGB: start from the candidate, colour-correct the
  // figure, then replace the red zone with the harmonic background fill.
  const { correctColorShift, harmonicBackgroundFill } = require('./images');
  const origRaw = await sharp(origResized).removeAlpha().raw().toBuffer();
  let pasteRaw = await sharp(candResized).removeAlpha().raw().toBuffer();
  let colorInfo = null;
  // FIGURE colour policy differs by repair mode:
  //  - FACE mode (bodyColorMode=false): the pasted head/coat butts against the
  //    ORIGINAL figure, so protect the figure colour (mean+border match below).
  //  - FIGURE/BODY mode (bodyColorMode=true): the WHOLE figure is redrawn, so a
  //    slight coat drift is fine (no adjacent original figure to clash with) — we
  //    SKIP the figure colour-match and instead protect the BACKGROUND at the
  //    silhouette border (the snow-in-cutout must match the surrounding original;
  //    that's what the eye catches). Handled by the generalized bg-match below.
  if (colorCorrect && !bodyColorMode) {
    try {
      // FACE correction on the FIGURE (+ its 3px edge ring), referenced to the
      // original figure — histogram built from figure pixels only, so the white
      // glow/red zone can't skew it.
      const refMaskBin = Buffer.alloc(n);
      for (let i = 0; i < n; i++) refMaskBin[i] = oldA[i * s1r] > 128 ? 255 : 0;
      // borderMatch:false — do NOT diffuse the seam offset into the face. The
      // edge transition is handled separately by the background-fill on the red
      // zone + margin, which never touches the figure. Pass-2 diffusion ran the
      // offset into the face interior (altering it) — that's wrong.
      // colorAware — learn the scene palette (skin / hair / cloth) and shift
      // each pasted pixel by its OWN material's mean offset, so the orange cloth
      // band inside the head mask matches the original dress instead of getting
      // the face's skin-tuned shift.
      // Correct the NEW figure AND the red zone (old-only pixels kept from the
      // model, e.g. the chin the round-2 mask missed) as ONE region — the
      // border-match then makes the red-zone outer edge match the surroundings
      // exactly, instead of leaving raw (uncorrected) model pixels there.
      const ccMask = Buffer.alloc(n);
      for (let i = 0; i < n; i++) ccMask[i] = (newDil[i] > 128 || redZone[i] > 128) ? 255 : 0;
      const cc = await correctColorShift(origRaw, pasteRaw, ccMask, cropW, cropH, { refMask: refMaskBin, borderMatch: false, colorAware: true, borderRefine: colorBorderRefine, garmentOnly });
      if (cc.applied) {
        pasteRaw = Buffer.from(cc.correctedRaw);
        colorInfo = { deltaEBefore: cc.deltaEBefore, seamBefore: cc.seamDeltaEBefore, seamAfter: cc.seamDeltaEAfter, clusters: cc.clusterInfo };
      }
    } catch (err) {
      log.warn(`[TESTLAB] colour correction skipped (${err.message})`);
    }
  }
  // Red zone = where the OLD head mask was but the NEW one isn't. The model
  // repainted this area (usually coherent face/scene — e.g. the crisp chin the
  // round-2 mask missed by a few px), so KEEP the model's pixels here — there is
  // no better source. ONLY where the model left GARBAGE (unfilled whiteout white
  // or a black fill) do we diffuse the TRUE scene background in, so garbage gets
  // a surrounding-matched colour instead of a white/black halo. Blanket-filling
  // the whole red zone (the old behaviour) smeared over the good chin.
  // figExclude = both heads → the diffusion sources only real background, never
  // the old skin (which would ghost a "2nd nose").
  // BACKGROUND protection — BOTH modes. The dilated union edge always catches some
  // background that Grok redrew: sky/wall ABOVE the head (face mode), or ground/wall/
  // sky all around a full figure (body mode). Wherever that redrawn background abuts
  // the ORIGINAL background just outside the silhouette, a colour step reads as a
  // cut-out. So we build a ring just inside the silhouette edge and, per BACKGROUND
  // material (clustered — snow, grass, wall, sky are separated by colour), shift the
  // model's pixels back to the surrounding original. Multiple materials around one
  // silhouette are matched independently. Texture is kept (shift, not replace).
  // bgBorderMatch toggle: the NEW silhouette-border extension (on by default). Turn
  // OFF to A/B against the old red-zone-only behaviour. The red zone always runs.
  const borderRing = Buffer.alloc(n);
  if (bgBorderMatch) {
    const eroded = await maskBlurThreshold(Buffer.from(alpha1), cropW, cropH, 12, 200); // shrink union ~12px inward
    for (let i = 0; i < n; i++) borderRing[i] = (alpha1[i] > 128 && eroded[i] <= 128) ? 255 : 0; // union edge margin
  }
  if (redZonePx > 0 || bgBorderMatch) {
    const { _rgbToLab, _labToRgb, _deltaE, _ccKMeans } = require('./images');
    const figExclude = Buffer.alloc(n);
    for (let i = 0; i < n; i++) figExclude[i] = (newDil[i] > 128 || oldA[i * s1r] > 128) ? 255 : 0;
    // FIGURE palette = K-cluster the model over the figure (newDil) → skin/hair/cloth.
    const figPts = [];
    for (let i = 0; i < n; i++) if (newDil[i] > 128) { const l = _rgbToLab(pasteRaw[i * 3], pasteRaw[i * 3 + 1], pasteRaw[i * 3 + 2]); figPts.push(l[0], l[1], l[2]); }
    const figCent = (figPts.length ? _ccKMeans(Float32Array.from(figPts), 3, 6).cent : []);
    // BACKGROUND palette = K-cluster the ORIGINAL just OUTSIDE the union — the real
    // scene materials (snow, grass, …), EACH with its true target colour.
    const ring = await maskBlurThreshold(Buffer.from(alpha1), cropW, cropH, 8, 16); // union → ~8px outer ring
    const bgPts = [];
    for (let i = 0; i < n; i++) if (ring[i] > 128 && alpha1[i] <= 128) { const l = _rgbToLab(origRaw[i * 3], origRaw[i * 3 + 1], origRaw[i * 3 + 2]); bgPts.push(l[0], l[1], l[2]); }
    // K=5: separate sky, wall, ground, snow, grass — a full figure can abut 3+ bg
    // materials at once, each needing its own target colour.
    const bgCent = (bgPts.length ? _ccKMeans(Float32Array.from(bgPts), 5, 8).cent : []);
    // Classify each red-zone pixel: FIGURE (chin → keep model) vs BACKGROUND (the
    // halo margin). For each BACKGROUND material, shift the model's pixels by
    // (original material colour − model material colour) so the model's snow is
    // pushed back to the real snow — snow and grass corrected INDEPENDENTLY, and
    // the figure/other materials untouched. This keeps the model's texture and
    // kills the halo (vs replacing the pixels).
    const garbage = Buffer.alloc(n);
    const bgAssign = new Int32Array(n).fill(-1); // per-pixel background cluster (or -1)
    const srcSum = bgCent.map(() => [0, 0, 0, 0]); // model mean per bg material
    let garbagePx = 0, bgPx = 0;
    for (let i = 0; i < n; i++) {
      // Candidate pixels: the red zone + the silhouette border margin (both modes).
      // A pixel here is corrected ONLY if it classifies as background below — figure
      // pixels (hair/coat at the edge) are left to the figure policy.
      const inZone = redZone[i] || borderRing[i] > 128;
      if (!inZone) continue;
      const r = pasteRaw[i * 3], g = pasteRaw[i * 3 + 1], b = pasteRaw[i * 3 + 2];
      if ((r > 235 && g > 235 && b > 235) || (r < 22 && g < 22 && b < 22)) { garbage[i] = 255; garbagePx++; continue; }
      if (!bgCent.length) continue;
      const lab = _rgbToLab(r, g, b);
      let dFig = Infinity; for (const c of figCent) { const d = _deltaE(lab, c); if (d < dFig) dFig = d; }
      let bk = -1, dBg = Infinity; for (let k = 0; k < bgCent.length; k++) { const d = _deltaE(lab, bgCent[k]); if (d < dBg) { dBg = d; bk = k; } }
      if (bk >= 0 && dBg < dFig) { bgAssign[i] = bk; srcSum[bk][0] += lab[0]; srcSum[bk][1] += lab[1]; srcSum[bk][2] += lab[2]; srcSum[bk][3]++; bgPx++; }
    }
    // Per-material offset = original target (bgCent) − model source mean.
    const bgOff = bgCent.map((c, k) => srcSum[k][3] ? [c[0] - srcSum[k][0] / srcSum[k][3], c[1] - srcSum[k][1] / srcSum[k][3], c[2] - srcSum[k][2] / srcSum[k][3]] : [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const bk = bgAssign[i]; if (bk < 0) continue;
      const lab = _rgbToLab(pasteRaw[i * 3], pasteRaw[i * 3 + 1], pasteRaw[i * 3 + 2]);
      const rgb = _labToRgb(lab[0] + bgOff[bk][0], lab[1] + bgOff[bk][1], lab[2] + bgOff[bk][2]);
      pasteRaw[i * 3] = rgb[0]; pasteRaw[i * 3 + 1] = rgb[1]; pasteRaw[i * 3 + 2] = rgb[2];
    }
    // Garbage (unfilled white/black) still gets diffused scene background.
    if (garbagePx > 0) {
      const bgFill = harmonicBackgroundFill(origRaw, garbage, figExclude, cropW, cropH);
      for (let i = 0; i < n; i++) { if (garbage[i]) { pasteRaw[i * 3] = bgFill[i * 3]; pasteRaw[i * 3 + 1] = bgFill[i * 3 + 1]; pasteRaw[i * 3 + 2] = bgFill[i * 3 + 2]; } }
    }
    if (bgPx > 0) log.info(`[TESTLAB] ${bodyColorMode ? 'figure-mode border' : 'red-zone'}: colour-matched ${bgPx}px background (${bgCent.length} materials) to the scene, ${garbagePx}px garbage bg-filled`);
    if (!colorInfo && bodyColorMode) colorInfo = { deltaEBefore: null, seamBefore: null, seamAfter: null, figureColorKept: true };
    if (colorInfo) { colorInfo.redZonePx = redZonePx; colorInfo.garbagePx = garbagePx; colorInfo.bgMatchedPx = bgPx; }
  }
  const pasteBuf = await sharp(pasteRaw, { raw: { width: cropW, height: cropH, channels: 3 } }).png().toBuffer(); // PNG: lossless corrected paste
  // Applied view: exactly what gets pasted (colour-corrected figure + filled bg).
  const ccCut = await sharp(pasteBuf).ensureAlpha().joinChannel(Buffer.from(unionPadded), raw1).png().toBuffer();
  const ccVis = await sharp({ create: { width: cropW, height: cropH, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .composite([{ input: ccCut }]).jpeg().toBuffer();
  await addStep(`pasted region (colour${colorInfo ? ` ΔE ${colorInfo.deltaEBefore}, seam ${colorInfo.seamBefore}→${colorInfo.seamAfter}` : ' n/a'}${redZonePx ? `, red-zone ${redZonePx}px kept from model, ${colorInfo?.garbagePx ?? 0}px garbage bg-filled` : ''})`, `data:image/jpeg;base64,${ccVis.toString('base64')}`);

  // Edge feather — industry paste-back recipe: ERODE the alpha inward by the feather
  // radius, THEN Gaussian-feather, so the blend ramp lives INSIDE the pasted figure
  // and the composite never samples original beyond the new content's edge. A wider
  // feather (vs the old hard ~2px) dissolves the silhouette seam instead of stamping
  // a 1px step. featherPx/erodeFeather are exposed so the Test Lab can A/B each stage
  // on the SAME model output. (sharp's raw blur can come back multi-channel — stride.)
  const fpx = featherPx == null ? 6 : Math.max(0, Number(featherPx));
  const doErode = erodeFeather !== false && fpx >= 1;
  let alphaSrc = Buffer.from(alpha1);
  if (doErode) alphaSrc = await maskBlurThreshold(alphaSrc, cropW, cropH, fpx, 200); // blur+high-thr shrinks ~fpx inward
  const alphaBlur = await sharp(alphaSrc, raw1).blur(Math.max(0.3, fpx || 1.2)).raw().toBuffer();
  const abStride = Math.max(1, Math.round(alphaBlur.length / n));
  const alphaSoft = abStride === 1 ? alphaBlur : (() => { const o = Buffer.alloc(n); for (let i = 0; i < n; i++) o[i] = alphaBlur[i * abStride]; return o; })();
  await addStep(`composite alpha (feather ${fpx}px${doErode ? ', eroded-then-feathered' : ', feather only'})`, `data:image/png;base64,${(await sharp(alphaSoft, raw1).png().toBuffer()).toString('base64')}`);
  const feathered = await sharp(pasteBuf).ensureAlpha().joinChannel(alphaSoft, raw1).png().toBuffer();
  return { feathered, iou, redPx, colorInfo, blendRule: BLEND_RULE_VERSION };
}

module.exports = { samUnionBlend, maskBlurThreshold, _faceConnectedComponent, _interiorSeedPoints, fetchMaskWithRetry, BLEND_RULE_VERSION };
