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
const BLEND_RULE_VERSION = 'union-soft2-pad6-figreg';

// ---------------------------------------------------------------------------
// Figure-registration math — pure, exposed for unit tests.
// Boxes are pixel bboxes [x0, y0, x1, y1] of a silhouette's alpha.
// The affine maps candidate pixel p → p * scale + (dx, dy).
//   scale : old height / new height (HEIGHT ratio — width varies with pose),
//           clamped so a wild SAM box cannot blow the paste up or shrink it away
//   dy    : anchors the bbox BOTTOMS (feet stay on the ground)
//   dx    : aligns the bbox horizontal centres
// ---------------------------------------------------------------------------
function computeFigureRegistration({ oldBox, newBox, minScale = 0.6, maxScale = 1.45 }) {
  if (!Array.isArray(oldBox) || !Array.isArray(newBox)) return null;
  const [ox0, oy0, ox1, oy1] = oldBox, [nx0, ny0, nx1, ny1] = newBox;
  const oh = oy1 - oy0, nh = ny1 - ny0;
  if (oh < 8 || nh < 8) return null;
  const scale = Math.min(maxScale, Math.max(minScale, oh / nh));
  const dx = Math.round((ox0 + ox1) / 2 - scale * (nx0 + nx1) / 2);
  const dy = Math.round(oy1 - scale * ny1);
  return { scale: +scale.toFixed(4), dx, dy };
}

function transformBox(box, { scale, dx, dy }) {
  return [box[0] * scale + dx, box[1] * scale + dy, box[2] * scale + dx, box[3] * scale + dy];
}

function boxIou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const uni = areaA + areaB - inter;
  return uni > 0 ? inter / uni : 0;
}

async function fetchMaskWithRetry(buf, box, tries = 5, opts = {}) {
  const { fetchFigureMaskPng } = require('./imageCompositing');
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
    // Rows sampled down the mask. 0.25/0.5/0.75 on a FULL-BODY mask are chest,
    // waist and thighs — NOTHING anchors the head, so on a figure whose head is
    // low-contrast against the background (grey hair on a dark bridge) SAM grows
    // the bright garment and stops at the collar: the catastrophic round-2 mask
    // in exp #381 was cardigan + trousers only. 0.12 puts a point on the head.
    for (const fy of [0.12, 0.3, 0.55, 0.8]) {
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
 * Colour-match the BACKGROUND pixels the paste INTRODUCES back to the surrounding
 * scene, so the silhouette edge doesn't read as a cut-out. Two sources of
 * introduced background: the RED ZONE (old head wider than the new — the paste
 * reveals scene there) and, when bgBorderMatch is on, a ring just inside the
 * dilated union edge (the model redrew sky/wall/ground there). Per BACKGROUND
 * material (clustered — snow, grass, wall, sky separated by colour) shift the
 * model's pixels back toward the surrounding original (texture kept, not replaced);
 * snow and grass corrected INDEPENDENTLY, figure pixels (hair/coat at the edge)
 * left to the figure policy. Mutates pasteRaw in place. Returns { bgPx, materials }.
 *
 * localField (figure-exact): TWO-BAND footprint reconstruction. The model's
 * output in the old-figure footprint carries the old outline itself — Grok
 * under-paints the whiteout silhouette, so "keep model content" reproduces the
 * ghost no matter how good the colour correction is (exp #274: A and C differed
 * by mean 2.0/channel — the blob is IN the content). Per footprint pixel:
 *     out = LB + w·clamp(model − blur(model), ±40)
 * LB = the ORIGINAL's low band (old figure masked out of the blur so it cannot
 * ghost), solved as a Laplace field over the footprint on a COARSE grid first
 * (converges across a 100px+ region — the naive fine-grid Jacobi never did,
 * which is what produced the flat-wash blob of exp #268), then refined at full
 * resolution. w fades the model's texture in from 0 at the old edge to 1 over
 * ~8px, so there is no texture step at the seam. The ghost is low-frequency —
 * it lives in the band LB replaces; real painted texture is high-frequency and
 * survives. The pad ring outside the old silhouette takes the original exactly.
 */
async function matchIntroducedBackground({ origRaw, pasteRaw, cropW, cropH, alpha1, redZone, newDil, bgBorderMatch, localField = false, oldBin = null, newBin = null }) {
  const n = cropW * cropH;
  const { _rgbToLab, _labToRgb, _deltaE, _ccKMeans } = require('./imageCompositing');
  const sharpL = require('sharp');
  if (localField) {
    // The old mask is DILATED ~2px before defining the footprint: the original's
    // painted INK OUTLINE of the old figure sits just outside SAM's fill mask,
    // and left as "valid background" it survives as a thin dark line tracing the
    // old silhouette (seen in the first local run). The dilation pulls it into
    // the reconstruction. The figure buffer is TIGHT (~1.5px, the true AA edge):
    // the old 3px buffer preserved a strip of the model's whiteout glow hugging
    // the figure — a pale line down the trouser edge.
    const oldX = await maskBlurThreshold(Buffer.from(oldBin), cropW, cropH, 1.6, 16);
    const newTight = newBin ? await maskBlurThreshold(Buffer.from(newBin), cropW, cropH, 1.0, 16) : newDil;
    const isOld = (i) => oldX[i] > 128;
    // Footprint = dilated old silhouette beyond the figure's tight edge buffer.
    // Pad ring = paste pixels outside it — the original is valid there, take it.
    const F = new Uint8Array(n);
    // Fs = the LB solve domain: every old-silhouette pixel that is not actual
    // figure (newBin). Wider than the paste domain F so the field is DEFINED in
    // thin gaps the newTight dilation bridges (between the legs) — the edge
    // band needs a valid background reference there; the original is the OLD
    // FIGURE's torso, which made white glow pass as "not background".
    const Fs = new Uint8Array(n);
    let fCnt = 0, ringPx = 0;
    for (let i = 0; i < n; i++) {
      if (isOld(i)) Fs[i] = 1; // ALL old pixels — the reference field must exist under SAM-bridged areas too
      if (newTight[i] > 128) continue;
      if (isOld(i)) { F[i] = 1; fCnt++; }
      else if (alpha1[i] > 128) {
        pasteRaw[i * 3] = origRaw[i * 3]; pasteRaw[i * 3 + 1] = origRaw[i * 3 + 1]; pasteRaw[i * 3 + 2] = origRaw[i * 3 + 2];
        ringPx++;
      }
    }
    if (fCnt === 0) { log.info(`[TESTLAB] two-band footprint: none (ring ${ringPx}px → original)`); return { bgPx: ringPx, materials: 0, localField: true }; }
    // Masked low band of the ORIGINAL — the old figure is excluded from the blur
    // (normalized masked convolution), so its colour cannot leak into LB.
    const sigma = 8;
    const w1 = Buffer.alloc(n);
    const rgbMasked = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
      const keep = (!isOld(i) && newTight[i] <= 128) ? 1 : 0;
      w1[i] = keep ? 255 : 0;
      if (keep) { rgbMasked[i * 3] = origRaw[i * 3]; rgbMasked[i * 3 + 1] = origRaw[i * 3 + 1]; rgbMasked[i * 3 + 2] = origRaw[i * 3 + 2]; }
    }
    const blurRgb = await sharpL(rgbMasked, { raw: { width: cropW, height: cropH, channels: 3 } }).blur(sigma).raw().toBuffer();
    const blurW = await sharpL(w1, { raw: { width: cropW, height: cropH, channels: 1 } }).blur(sigma).raw().toBuffer();
    const wStride = Math.max(1, Math.round(blurW.length / n));
    const lowOrig = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const wgt = blurW[i * wStride] / 255;
      for (let c = 0; c < 3; c++) lowOrig[i * 3 + c] = wgt > 0.02 ? blurRgb[i * 3 + c] / wgt : 0;
    }
    const lowModel = await sharpL(Buffer.from(pasteRaw), { raw: { width: cropW, height: cropH, channels: 3 } }).blur(sigma).raw().toBuffer();
    // LB Laplace solve, COARSE-TO-FINE. Coarse cell = 8px: boundary cells carry
    // the mean masked-original low band; footprint cells relax 400 iterations
    // (the region is ~15 cells wide — converges); bilinear upsample; 60 fine
    // iterations polish the boundary transition.
    const S = 8, Wc = Math.ceil(cropW / S), Hc = Math.ceil(cropH / S), nc = Wc * Hc;
    const cVal = new Float32Array(nc * 3), cW = new Float32Array(nc), cF = new Uint8Array(nc), cB = new Uint8Array(nc);
    for (let y = 0; y < cropH; y++) for (let x = 0; x < cropW; x++) {
      const i = y * cropW + x, ci = ((y / S) | 0) * Wc + ((x / S) | 0);
      if (Fs[i]) cF[ci] = 1;
      else if (newTight[i] <= 128 && !isOld(i) && blurW[i * wStride] > 5) {
        cB[ci] = 1; cW[ci]++;
        for (let c = 0; c < 3; c++) cVal[ci * 3 + c] += lowOrig[i * 3 + c];
      }
    }
    for (let ci = 0; ci < nc; ci++) if (cW[ci] > 0) for (let c = 0; c < 3; c++) cVal[ci * 3 + c] /= cW[ci];
    for (let it = 0; it < 400; it++) {
      for (let cy = 0; cy < Hc; cy++) for (let cx = 0; cx < Wc; cx++) {
        const ci = cy * Wc + cx;
        if (!cF[ci] || cB[ci]) continue;
        let c0 = 0; const acc = [0, 0, 0];
        for (const d of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = cx + d[0], ny = cy + d[1];
          if (nx < 0 || ny < 0 || nx >= Wc || ny >= Hc) continue;
          const cj = ny * Wc + nx;
          if (!cF[cj] && !cB[cj]) continue;
          c0++; for (let c = 0; c < 3; c++) acc[c] += cVal[cj * 3 + c];
        }
        if (c0) for (let c = 0; c < 3; c++) cVal[ci * 3 + c] = acc[c] / c0;
      }
    }
    const LB = new Float32Array(n * 3);
    for (let y = 0; y < cropH; y++) for (let x = 0; x < cropW; x++) {
      const i = y * cropW + x;
      if (!Fs[i]) { for (let c = 0; c < 3; c++) LB[i * 3 + c] = lowOrig[i * 3 + c]; continue; }
      const gx = Math.min(Wc - 1.001, Math.max(0, x / S - 0.5)), gy = Math.min(Hc - 1.001, Math.max(0, y / S - 0.5));
      const x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0;
      for (let c = 0; c < 3; c++) {
        const v00 = cVal[(y0 * Wc + x0) * 3 + c], v10 = cVal[(y0 * Wc + x0 + 1) * 3 + c];
        const v01 = cVal[((y0 + 1) * Wc + x0) * 3 + c], v11 = cVal[((y0 + 1) * Wc + x0 + 1) * 3 + c];
        LB[i * 3 + c] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      }
    }
    for (let it = 0; it < 60; it++) {
      for (let y = 0; y < cropH; y++) for (let x = 0; x < cropW; x++) {
        const i = y * cropW + x;
        if (!Fs[i]) continue;
        let c0 = 0; const acc = [0, 0, 0];
        const nb = [i - 1, i + 1, i - cropW, i + cropW];
        const ok = [x > 0, x < cropW - 1, y > 0, y < cropH - 1];
        for (let k = 0; k < 4; k++) {
          if (!ok[k]) continue;
          const j = nb[k];
          const jBoundary = !Fs[j] && newTight[j] <= 128 && !isOld(j);
          if (!Fs[j] && !jBoundary) continue; // figure never a source
          c0++; for (let c = 0; c < 3; c++) acc[c] += Fs[j] ? LB[j * 3 + c] : lowOrig[j * 3 + c];
        }
        if (c0) for (let c = 0; c < 3; c++) LB[i * 3 + c] = acc[c] / c0;
      }
    }
    // Distance-based texture fade: 0 at the old edge (no texture step at the
    // seam) → 1 at ~8px inside. Eight 1px erosions of F.
    const wTex = new Float32Array(n);
    let er = Buffer.alloc(n);
    for (let i = 0; i < n; i++) er[i] = F[i] ? 255 : 0;
    for (let k = 0; k < 8; k++) {
      er = await maskBlurThreshold(er, cropW, cropH, 0.8, 200);
      for (let i = 0; i < n; i++) if (er[i] > 128) wTex[i] += 1 / 8;
    }
    const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
    // STRUCTURE CONFIDENCE m — per pixel: is the model's content here REAL
    // painted structure (curtain folds, wall, window — keep it, ALL frequencies)
    // or FLAT under-painted whiteout (the ghost — replace with the field)?
    // Unconditional low-band replacement wiped Grok's crisp curtain into a blur
    // (exp #276 B vs C, owner catch); flatness is exactly what separates ghost
    // from content. m = smoothed local high-frequency energy, faded to 0 at the
    // old edge (seam stays field-anchored).
    const hpBuf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      if (!F[i]) continue;
      const e = (Math.abs(pasteRaw[i * 3] - lowModel[i * 3]) + Math.abs(pasteRaw[i * 3 + 1] - lowModel[i * 3 + 1]) + Math.abs(pasteRaw[i * 3 + 2] - lowModel[i * 3 + 2])) / 3;
      hpBuf[i] = Math.min(255, Math.round(e * 8)); // ×8 so the σ4 blur keeps resolution
    }
    const eBlur = await sharpL(hpBuf, { raw: { width: cropW, height: cropH, channels: 1 } }).blur(4).raw().toBuffer();
    const eStride = Math.max(1, Math.round(eBlur.length / n));
    // Broad tone alignment for kept model content: the LB−lowModel difference
    // blurred wide (σ20), so the model's local shapes survive and only the
    // overall tone is pulled to the scene.
    const dBuf = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) dBuf[i * 3 + c] = cl(LB[i * 3 + c] - lowModel[i * 3 + c] + 128);
    const dBlur = await sharpL(dBuf, { raw: { width: cropW, height: cropH, channels: 3 } }).blur(20).raw().toBuffer();
    for (let i = 0; i < n; i++) {
      if (!F[i]) continue;
      const E = eBlur[i * eStride] / 8;               // mean local high-freq energy
      const m = Math.max(0, Math.min(1, (E - 3) / 7)) * wTex[i];
      for (let c = 0; c < 3; c++) {
        const toned = pasteRaw[i * 3 + c] + (dBlur[i * 3 + c] - 128);
        pasteRaw[i * 3 + c] = cl(m * toned + (1 - m) * LB[i * 3 + c]);
      }
    }
    // UNKNOWN BAND at the figure edge (newBin..newTight): Grok's whiteout glow
    // hugs the hair/shoulders exactly where the AA edge must be preserved.
    // Split per pixel: keep what reads as the FIGURE'S INTERIOR (palette from
    // the eroded figure — glow cannot be sampled into it), replace what reads
    // as the local background field. Glow beside a white garment stays — and is
    // invisible by definition.
    let bandPx = 0;
    if (newBin) {
      const newEro = await maskBlurThreshold(Buffer.from(newBin), cropW, cropH, 1.2, 200); // erode ~2px
      // LOCAL figure reference — a global palette contains the WHITE SHIRT, so
      // white glow anywhere on the silhouette matched "figure" and survived
      // (the head halo of iter 5: glow beside brown hair must be judged against
      // HAIR). Normalized masked blur of the model over the figure interior
      // gives the local figure colour at every band pixel.
      const figMaskedRgb = Buffer.alloc(n * 3);
      const figMaskW = Buffer.alloc(n);
      for (let i = 0; i < n; i++) {
        if (newEro[i] <= 128) continue;
        figMaskW[i] = 255;
        figMaskedRgb[i * 3] = pasteRaw[i * 3]; figMaskedRgb[i * 3 + 1] = pasteRaw[i * 3 + 1]; figMaskedRgb[i * 3 + 2] = pasteRaw[i * 3 + 2];
      }
      const figBlurRgb = await sharpL(figMaskedRgb, { raw: { width: cropW, height: cropH, channels: 3 } }).blur(10).raw().toBuffer();
      const figBlurW = await sharpL(figMaskW, { raw: { width: cropW, height: cropH, channels: 1 } }).blur(10).raw().toBuffer();
      const fwStride = Math.max(1, Math.round(figBlurW.length / n));
      for (let i = 0; i < n; i++) {
        if (!(newTight[i] > 128 && newEro[i] <= 128 && alpha1[i] > 128)) continue;
        const fw = figBlurW[i * fwStride] / 255;
        if (fw < 0.03) continue;
        const lab = _rgbToLab(pasteRaw[i * 3], pasteRaw[i * 3 + 1], pasteRaw[i * 3 + 2]);
        const figRef = _rgbToLab(figBlurRgb[i * 3] / fw, figBlurRgb[i * 3 + 1] / fw, figBlurRgb[i * 3 + 2] / fw);
        const dFig = _deltaE(lab, figRef);
        const ref = isOld(i) ? [LB[i * 3], LB[i * 3 + 1], LB[i * 3 + 2]] : [origRaw[i * 3], origRaw[i * 3 + 1], origRaw[i * 3 + 2]];
        const dBg = _deltaE(lab, _rgbToLab(ref[0], ref[1], ref[2]));
        if (dBg < dFig - 6) {
          pasteRaw[i * 3] = cl(ref[0]); pasteRaw[i * 3 + 1] = cl(ref[1]); pasteRaw[i * 3 + 2] = cl(ref[2]);
          bandPx++;
        }
      }
    }
    // ELONGATED BRIGHT RIM inside the figure mask (owner: "the specs are ON the
    // outline") — SAM bridges thin gaps, so an under-painted light rim along the
    // figure's TRUE content outline sits deep inside newBin where no edge-derived
    // band reaches, and its colour is statistically identical to real highlights.
    // The separator is SHAPE: rim residue is a thin ELONGATED strip; legitimate
    // bright details (buttons, hem highlights) are compact. Flag old-silhouette
    // figure pixels that are bright OUTLIERS vs their σ8 neighbourhood, connect
    // them, and remove only components elongated ≥5:1 (≥12px) — replaced by the
    // reference field, which is defined under bridged masks.
    let rimPx = 0;
    {
      const allBlur = await sharpL(Buffer.from(pasteRaw), { raw: { width: cropW, height: cropH, channels: 3 } }).blur(8).raw().toBuffer();
      // OUTLINE BAND ONLY (~3px inside the figure edge). The rim residue lives on
      // the silhouette; scanning the whole figure let the rule reach content deep
      // inside the new figure, where a legitimate elongated highlight (a fold, a
      // strap edge) can be flagged and overwritten (owner, exp #307). newBin
      // eroded ~3px marks "safely interior" — never a candidate.
      const deepIn = await maskBlurThreshold(Buffer.from(newBin || newTight), cropW, cropH, 1.8, 200);
      const cand2 = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!(isOld(i) && newTight[i] > 128 && alpha1[i] > 128)) continue;
        if (deepIn[i] > 128) continue; // deep interior of the new figure — untouchable
        const mnP = Math.min(pasteRaw[i * 3], pasteRaw[i * 3 + 1], pasteRaw[i * 3 + 2]);
        const mnB = Math.min(allBlur[i * 3], allBlur[i * 3 + 1], allBlur[i * 3 + 2]);
        if (mnP - mnB > 30) cand2[i] = 1;
      }
      const seen2 = new Uint8Array(n);
      for (let s0 = 0; s0 < n; s0++) {
        if (!cand2[s0] || seen2[s0]) continue;
        const comp = [s0]; const stack = [s0]; seen2[s0] = 1;
        let x0 = cropW, x1 = 0, y0 = cropH, y1 = 0;
        while (stack.length) {
          const k = stack.pop(); const x = k % cropW, y = (k / cropW) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          for (const d of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nx = x + d[0], ny = y + d[1];
            if (nx < 0 || ny < 0 || nx >= cropW || ny >= cropH) continue;
            const j = ny * cropW + nx;
            if (cand2[j] && !seen2[j]) { seen2[j] = 1; stack.push(j); comp.push(j); }
          }
        }
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        const elong = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
        if (comp.length >= 10 && elong >= 4) {
          for (const j of comp) {
            pasteRaw[j * 3] = cl(LB[j * 3]); pasteRaw[j * 3 + 1] = cl(LB[j * 3 + 1]); pasteRaw[j * 3 + 2] = cl(LB[j * 3 + 2]);
            rimPx++;
          }
        }
      }
    }
    log.info(`[TESTLAB] two-band footprint: ${fCnt}px = original low band (coarse-to-fine) + confidence-weighted model texture; pad ring ${ringPx}px → original; edge band ${bandPx}px glow replaced; elongated rim ${rimPx}px removed`);
    return { bgPx: fCnt + ringPx, materials: 0, localField: true };
  }
  const borderRing = Buffer.alloc(n);
  if (bgBorderMatch) {
    const eroded = await maskBlurThreshold(Buffer.from(alpha1), cropW, cropH, 12, 200); // shrink union ~12px inward
    for (let i = 0; i < n; i++) borderRing[i] = (alpha1[i] > 128 && eroded[i] <= 128) ? 255 : 0; // union edge margin
  }
  // FIGURE palette = K-cluster the model over the figure (newDil) → skin/hair/cloth.
  const figPts = [];
  for (let i = 0; i < n; i++) if (newDil[i] > 128) { const l = _rgbToLab(pasteRaw[i * 3], pasteRaw[i * 3 + 1], pasteRaw[i * 3 + 2]); figPts.push(l[0], l[1], l[2]); }
  const figCent = (figPts.length ? _ccKMeans(Float32Array.from(figPts), 3, 6).cent : []);
  // BACKGROUND palette = K-cluster the ORIGINAL just OUTSIDE the union — the real
  // scene materials (snow, grass, …), EACH with its true target colour. K=5: a full
  // figure can abut 3+ bg materials (sky, wall, ground, snow, grass) at once.
  const ring = await maskBlurThreshold(Buffer.from(alpha1), cropW, cropH, 8, 16); // union → ~8px outer ring
  const bgPts = [];
  for (let i = 0; i < n; i++) if (ring[i] > 128 && alpha1[i] <= 128) { const l = _rgbToLab(origRaw[i * 3], origRaw[i * 3 + 1], origRaw[i * 3 + 2]); bgPts.push(l[0], l[1], l[2]); }
  const bgCent = (bgPts.length ? _ccKMeans(Float32Array.from(bgPts), 5, 8).cent : []);
  // Classify each candidate pixel: FIGURE (keep model) vs BACKGROUND (shift toward
  // the real material). Per bg material, offset = original mean − model mean.
  const bgAssign = new Int32Array(n).fill(-1); // per-pixel background cluster (or -1)
  const srcSum = bgCent.map(() => [0, 0, 0, 0]); // model mean per bg material
  let bgPx = 0;
  for (let i = 0; i < n; i++) {
    const inZone = redZone[i] || borderRing[i] > 128;
    if (!inZone) continue;
    const r = pasteRaw[i * 3], g = pasteRaw[i * 3 + 1], b = pasteRaw[i * 3 + 2];
    if (!bgCent.length) continue;
    const lab = _rgbToLab(r, g, b);
    let bk = -1, dBg = Infinity; for (let k = 0; k < bgCent.length; k++) { const d = _deltaE(lab, bgCent[k]); if (d < dBg) { dBg = d; bk = k; } }
    let dFig = Infinity; for (const c of figCent) { const d = _deltaE(lab, c); if (d < dFig) dFig = d; }
    if (bk >= 0 && dBg < dFig) { bgAssign[i] = bk; srcSum[bk][0] += lab[0]; srcSum[bk][1] += lab[1]; srcSum[bk][2] += lab[2]; srcSum[bk][3]++; bgPx++; }
  }
  {
    // Legacy: per-material MEAN shift (padded-union path, byte-identical).
    const bgOff = bgCent.map((c, k) => srcSum[k][3] ? [c[0] - srcSum[k][0] / srcSum[k][3], c[1] - srcSum[k][1] / srcSum[k][3], c[2] - srcSum[k][2] / srcSum[k][3]] : [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const bk = bgAssign[i]; if (bk < 0) continue;
      const lab = _rgbToLab(pasteRaw[i * 3], pasteRaw[i * 3 + 1], pasteRaw[i * 3 + 2]);
      const rgb = _labToRgb(lab[0] + bgOff[bk][0], lab[1] + bgOff[bk][1], lab[2] + bgOff[bk][2]);
      pasteRaw[i * 3] = rgb[0]; pasteRaw[i * 3 + 1] = rgb[1]; pasteRaw[i * 3 + 2] = rgb[2];
    }
    return { bgPx, materials: bgCent.length };
  }
}

/**
 * White-hole measurement (pure — unit-tested). Counts old-silhouette pixels
 * that the redrawn figure's cut (+~3px edge ring, `newDil`) does NOT cover and
 * whose candidate content is near-white (>=243 on all channels — same
 * threshold as the white-card gate). Those pixels are treatment residue the
 * union would paste onto the page as a white hole.
 *   oldA    : old SAM mask alpha (possibly strided — pass sOld)
 *   newDil  : dilated new-figure binary mask (stride 1, length n)
 *   candRaw : candidate crop, raw RGB (3 bytes/px)
 */
function measureWhiteHole({ oldA, sOld, newDil, candRaw, n }) {
  let oldCnt = 0, uncoveredWhite = 0;
  for (let i = 0; i < n; i++) {
    if ((oldA[i * sOld] || 0) <= 128) continue;
    oldCnt++;
    if (newDil[i] > 128) continue; // covered by the new figure's cut
    if (candRaw[i * 3] >= 243 && candRaw[i * 3 + 1] >= 243 && candRaw[i * 3 + 2] >= 243) uncoveredWhite++;
  }
  return { oldCnt, uncoveredWhite, frac: oldCnt ? uncoveredWhite / oldCnt : 0 };
}

/**
 * THE shared repair blend — engine-agnostic. Given the original crop and a
 * candidate crop (any model's output for the same region), put ONLY the
 * repainted figure back:
 *   1. SAM masks the figure in BOTH crops (old mask reusable by the caller).
 *   2. IoU gate: masks barely overlapping = the figure moved → reject.
 *   3. Union = pixels owned by the candidate. RED zones (figure shrank —
 *      old-figure remnants underneath) keep the model's pixels, colour-matched
 *      per background material back to the surrounding scene.
 *   4. Alpha: CRISP along the entire new-figure edge (a real figure boundary
 *      — agreed or grown), feather ONLY the red-zone borders (background
 *      meeting background, where feathering is safe and useful).
 * Returns a feathered RGBA PNG to composite at the crop position; throws
 * (with steps attached) on gate failures. Every mask is emitted as a step.
 */
async function samUnionBlend({ originalCropBuf, candidateCropBuf: candidateCropBufIn, boxInCrop, cropW, cropH, oldMaskPng = null, addStep = async () => {}, failCtx = {}, clipRect = null, maskPoints = null, maskFetcher = null, colorCorrect = true, featherPx = null, erodeFeather = true, colorBorderRefine = true, bodyColorMode = false, bgBorderMatch = true, garmentOnly = true, featherMode = null, padMode = 'union', blendShape = 'padded-union', rawPaste = false, registerCandidate = false, protectedBoxesInCrop = null, faceBoxInCrop = null, newBoxInCrop = null, r2Prompt = 'face', iouThreshold = 0.55, whiteCardMaxFrac = 0.22, gateIou = true, gateWhiteCard = true, gateWhiteHole = true, whiteHoleMaxFrac = 0.02 }) {
  const sharp = require('sharp');
  let candidateCropBuf = candidateCropBufIn;
  const fail = (msg) => {
    const err = new Error(msg);
    err.partialResult = failCtx;
    return err;
  };

  const oldMask = oldMaskPng || (maskFetcher ? await maskFetcher(originalCropBuf) : await fetchMaskWithRetry(originalCropBuf, boxInCrop, 5, maskPoints || {}));
  if (!oldMask) throw fail('SAM could not mask the original figure (mask service unavailable?) — retry.');
  const n0 = cropW * cropH;
  let newMask;
  // The exact round-2 segmentation procedure, reusable on a REGISTERED
  // candidate: figure registration must re-prompt SAM with the same padded box
  // and seeds, or the refetch degrades to an unseeded box prompt (measured:
  // exp #967 replay — box-only on the registered p16 candidate returned the
  // sky again, pixel IoU 5%).
  let refetchRound2 = null;
  if (maskFetcher) {
    refetchRound2 = maskFetcher;
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
    // Seeds come from ROUND 1's mask — points inside the OLD figure — but they
    // are applied to the MODEL'S output. If the model drew the figure narrower or
    // shifted (it usually does, a few percent), a seed lands on background or on
    // a NEIGHBOUR, and SAM grows that instead: this is the main reason round 2
    // returns someone else's sleeve or shoe. Keep only seeds that still sit on
    // figure-like content in the candidate: erode round 1's mask hard first, so
    // a seed must be deep inside the shared area of both figures.
    const eroded = await maskBlurThreshold(
      await sharp(oldMask).resize(cropW, cropH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer().then(a => {
        const st = Math.max(1, Math.round(a.length / n0));
        const b = Buffer.alloc(n0);
        for (let i = 0; i < n0; i++) b[i] = a[i * st] > 128 ? 255 : 0;
        return b;
      }), cropW, cropH, 6, 200);
    const erodedPng = await sharp(Buffer.alloc(n0 * 3, 255), { raw: { width: cropW, height: cropH, channels: 3 } })
      .ensureAlpha().joinChannel(eroded, { raw: { width: cropW, height: cropH, channels: 1 } }).png().toBuffer();
    const seeds = await _interiorSeedPoints(erodedPng, cropW, cropH);
    const r2Opts = { ...(maskPoints || {}) };
    if (seeds.length) r2Opts.points = [...(r2Opts.points || []), ...seeds];
    // HEAD ANCHOR FROM DINO, not guessed. Our seed rows are synthesised from
    // round-1 geometry (widest interior run at fixed height fractions), but the
    // DETECTOR already provides a FACE BOX for this character. Its centre is a
    // far better head point than any fraction of mask height - evidence rather
    // than inference. The height heuristic remains as the fallback.
    if (Array.isArray(faceBoxInCrop) && faceBoxInCrop.length === 4) {
      const fx = Math.round((faceBoxInCrop[0] + faceBoxInCrop[2]) / 2);
      const fy = Math.round((faceBoxInCrop[1] + faceBoxInCrop[3]) / 2);
      if (fx > 0 && fy > 0 && fx < cropW && fy < cropH) {
        r2Opts.points = [[fx, fy], ...(r2Opts.points || [])];
        log.info(`[TESTLAB] round-2 head seed from the DINO face box at (${fx},${fy})`);
      }
    }
    // HOW round 2 is prompted. DEFAULT 'face' (owner, 2026-08-06), and ROUND 1
    // uses the SAME construction — the CHARACTER must be segmented identically in
    // both rounds or the IoU gate compares two different procedures rather than
    // two figures. (Face-specific handling may differ; the character mask may not.)
    //   'face'  — box + ONE point at the detector's face-box centre. Detector
    //             evidence only, nothing invented.
    //   'box'   — box only, no points.
    //   'seeds' — adds points synthesised from ROUND-1's shape at fixed height
    //             fractions: guesses applied to a DIFFERENT image that can land off
    //             the figure or on a neighbour. Opt-in only.
    // Measured on identical pixels (exp #392): all three passed once the head was
    // anchored, so the guessing buys nothing and can only misfire.
    if (r2Prompt === 'box') {
      delete r2Opts.points;
    } else if (r2Prompt === 'face') {
      const fb = Array.isArray(faceBoxInCrop) && faceBoxInCrop.length === 4 ? faceBoxInCrop : null;
      if (fb) {
        const fx = Math.round((fb[0] + fb[2]) / 2), fy = Math.round((fb[1] + fb[3]) / 2);
        r2Opts.points = [[fx, fy]];
      } else delete r2Opts.points;
    }
    log.info(`[TESTLAB] round-2 prompt mode '${r2Prompt}': ${(r2Opts.points || []).length} point(s)`);
    // HEAD ANCHOR FROM DINO, not guessed. Our seed rows are synthesised from
    // round-1 geometry (widest interior run at fixed height fractions) — but the
    // detector already gives a FACE BOX for this character. Its centre is a far
    // better head point than any fraction of mask height, and it is evidence
    // rather than inference. Falls back to the height heuristic when absent.
    if (Array.isArray(faceBoxInCrop) && faceBoxInCrop.length === 4) {
      const fx = Math.round((faceBoxInCrop[0] + faceBoxInCrop[2]) / 2);
      const fy = Math.round((faceBoxInCrop[1] + faceBoxInCrop[3]) / 2);
      if (fx > 0 && fy > 0 && fx < cropW && fy < cropH) {
        r2Opts.points = [[fx, fy], ...(r2Opts.points || [])];
        log.info();
      }
    }
    // DETECTOR-ANCHORED round 2 (owner principle: evidence, not inference).
    // When the caller supplies DINO's re-detected body box for the CANDIDATE
    // (faceRepair's round-2 re-detect), prompt SAM where the figure actually
    // IS: padded new box + one seed at its centre. The old-geometry prompt on
    // a moved/rescaled figure puts the face seed on background and SAM returns
    // the sky (measured: p16 verify run + exps #967/#968, pixel IoU 5-13%).
    let fetchBox = padBox, fetchOpts = r2Opts;
    if (Array.isArray(newBoxInCrop) && newBoxInCrop.length === 4) {
      const nw = newBoxInCrop[2] - newBoxInCrop[0], nh = newBoxInCrop[3] - newBoxInCrop[1];
      // A near-whole-crop "person" box is not evidence of anything — on a busy
      // page DINO returns the enclosing crowd (exp #969: [16,14,301,779] on a
      // 301x779 crop) and its centre seed grabs figure+neighbours as one blob.
      const degenerate = (nw * nh) > 0.85 * cropW * cropH;
      if (nw > 8 && nh > 8 && !degenerate) {
        fetchBox = [
          Math.max(0, Math.round(newBoxInCrop[0] - nw * 0.04)),
          Math.max(0, Math.round(newBoxInCrop[1] - nh * 0.04)),
          Math.min(cropW, Math.round(newBoxInCrop[2] + nw * 0.04)),
          Math.min(cropH, Math.round(newBoxInCrop[3] + nh * 0.04)),
        ];
        fetchOpts = { points: [[Math.round((newBoxInCrop[0] + newBoxInCrop[2]) / 2), Math.round((newBoxInCrop[1] + newBoxInCrop[3]) / 2)]] };
        log.info(`[TESTLAB] round-2 prompt anchored on DINO's re-detected body box [${newBoxInCrop.join(',')}] (centre seed)`);
      }
    }
    // OLD-geometry fetcher, for the post-registration refetch: after the
    // affine the figure sits at the ORIGINAL geometry, so the original padded
    // box + face-centre seed are the right prompt there.
    refetchRound2 = (buf) => fetchMaskWithRetry(buf, padBox, 5, r2Opts);
    newMask = await fetchMaskWithRetry(candidateCropBuf, fetchBox, 5, fetchOpts);
    // WHAT ROUND 2 WAS PROMPTED WITH — box (yellow) + seed points (red). Round 1
    // has such a view; round 2 never did, so a bad box or a seed landing off the
    // figure was invisible (owner asked to see the box and points).
    try {
      const dots = (fetchOpts.points || []).map(([px, py]) =>
        `<circle cx="${px}" cy="${py}" r="6" fill="#ff2d2d" stroke="#fff" stroke-width="2"/>`).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cropW}" height="${cropH}">`
        + `<rect x="${fetchBox[0]}" y="${fetchBox[1]}" width="${fetchBox[2] - fetchBox[0]}" height="${fetchBox[3] - fetchBox[1]}" fill="none" stroke="#ffcc00" stroke-width="3"/>`
        + dots + `</svg>`;
      const viz = await sharp(candidateCropBuf).resize(cropW, cropH, { fit: 'fill' })
        .composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 92 }).toBuffer();
      await addStep(`SAM round 2 PROMPT: box (yellow) + ${(fetchOpts.points || []).length} seed point(s) (red)${fetchBox !== padBox ? ' — DINO re-detect anchored' : ''}`, `data:image/jpeg;base64,${viz.toString('base64')}`);
    } catch { /* viz only */ }
  }
  // ---- OCCLUDER SUBTRACT on ROUND 2 ---------------------------------------
  // The hatch builder already removes other characters from the TARGET
  // silhouette, so round 1 is clean — but round 2 is segmented straight off the
  // model output with no such treatment, and SAM happily returns a neighbour's
  // sleeve or shoe as part of the figure (owner, exp #362: Sarah's clothing in
  // round 2). Subtract every protected character's silhouette from round 2 the
  // same way. Guard: if a subtraction removes >70% of the target it was a label
  // mismatch — revert it rather than delete the figure.
  if (Array.isArray(protectedBoxesInCrop) && protectedBoxesInCrop.length && newMask) {
    try {
      const { fetchFigureMaskPng } = require('./imageCompositing');
      const opaque = async (buf) => { try { const st = await sharp(buf).stats(); const ch = st?.channels?.[3]; return ch ? ch.mean / 255 : null; } catch { return null; } };
      const before = await opaque(newMask);
      let removed = 0;
      for (const box of protectedBoxesInCrop) {
        if (!Array.isArray(box) || box.length !== 4) continue;
        const [x0, y0, x1, y1] = box.map(Math.round);
        if (x1 - x0 < 8 || y1 - y0 < 8) continue;
        const occ = await fetchFigureMaskPng(candidateCropBuf, [x0, y0, x1, y1], {});
        if (!occ) continue;
        const trial = await sharp(newMask).ensureAlpha()
          .composite([{ input: await sharp(occ).resize(cropW, cropH, { fit: 'fill' }).png().toBuffer(), blend: 'dest-out' }])
          .png().toBuffer();
        const after = await opaque(trial);
        if (before != null && after != null && after < before * 0.3) {
          log.warn(`[TESTLAB] occluder subtract on round 2 would remove ${(100 * (1 - after / before)).toFixed(0)}% of the figure — reverted (label mismatch)`);
          continue;
        }
        newMask = trial;
        removed++;
      }
      if (removed) {
        const after = await opaque(newMask);
        log.info(`[TESTLAB] round 2: subtracted ${removed} protected character silhouette(s) — mask ${(before * 100).toFixed(1)}% → ${(after * 100).toFixed(1)}% of the crop`);
        await addStep('SAM round 2 after removing other characters', `data:image/png;base64,${(await sharp(await sharp(candidateCropBuf).resize(cropW, cropH, { fit: 'fill' }).ensureAlpha().joinChannel(
          await sharp(newMask).resize(cropW, cropH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer(),
          { raw: { width: cropW, height: cropH, channels: 1 } }).png().toBuffer()).png().toBuffer()).toString('base64')}`);
      }
    } catch (err) {
      log.warn(`[TESTLAB] round-2 occluder subtract failed (${err.message}) — using the raw round-2 mask`);
    }
  }

  if (!newMask) throw fail('SAM found no figure in the model output inside the target box — the model likely painted the figure elsewhere or not at all. See the raw output step; Redo.');

  const raw1 = { raw: { width: cropW, height: cropH, channels: 1 } };
  const n = cropW * cropH;

  // ---- CANDIDATE REGISTRATION on the BACKGROUND (cutout mode) --------------
  // The figure is the thing that CHANGED, so aligning on its silhouette is
  // circular — and round-2 SAM sometimes grabs a neighbour's shoe, which then
  // drags the whole paste sideways (owner, exp #360). The BACKGROUND is common
  // to input and output and the model is instructed to preserve it, so it is
  // the honest alignment signal: find the (dx,dy[,scale]) that best re-aligns
  // the background, apply it, and if even the best alignment leaves the
  // background clearly mismatched, REJECT the candidate — the model redrew the
  // scene, not just the figure.
  let registration = null;
  // What the background comparison concluded: 'aligned' (figure geometry
  // trustworthy as-is), 'shifted' (aligned after a shift), 'rerendered' (the
  // model repainted the scene — background unusable), null (no information:
  // too little background visible, or the comparison failed).
  let bgVerdict = null;
  if (registerCandidate) {
    try {
      const SW = 200, SH = Math.max(1, Math.round(cropH * (SW / cropW)));   // small grid: the search is O(candidates × pixels)
      const grey = async (buf) => sharp(buf).resize(SW, SH, { fit: 'fill' }).greyscale().raw().toBuffer();
      const maskSmall = async (m) => {
        const a = await sharp(m).resize(SW, SH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
        const st = Math.max(1, Math.round(a.length / (SW * SH)));
        const o = new Uint8Array(SW * SH);
        for (let i = 0; i < SW * SH; i++) o[i] = a[i * st] > 128 ? 1 : 0;
        return o;
      };
      const gOrig = await grey(originalCropBuf);
      const gCand = await grey(candidateCropBuf);
      const mOld = await maskSmall(oldMask);
      const mNew = await maskSmall(newMask);
      // BACKGROUND = outside both silhouettes, dilated a little so the figure's
      // soft edge never enters the score.
      const bg = new Uint8Array(SW * SH);
      let bgCount = 0;
      const R = 3;
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        let near = false;
        for (let dy = -R; dy <= R && !near; dy++) for (let dx = -R; dx <= R; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= SH || xx >= SW) continue;
          if (mOld[yy * SW + xx] || mNew[yy * SW + xx]) { near = true; break; }
        }
        if (!near) { bg[y * SW + x] = 1; bgCount++; }
      }
      if (bgCount > 0.06 * SW * SH) {
        // Score a (dx,dy,scale) by mean |diff| over background pixels only.
        const score = (dx, dy, sc) => {
          let sum = 0, n2 = 0;
          for (let y = 0; y < SH; y += 2) for (let x = 0; x < SW; x += 2) {
            if (!bg[y * SW + x]) continue;
            const sx = Math.round((x - SW / 2) / sc + SW / 2 - dx);
            const sy = Math.round((y - SH / 2) / sc + SH / 2 - dy);
            if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) continue;
            sum += Math.abs(gOrig[y * SW + x] - gCand[sy * SW + sx]); n2++;
          }
          return n2 > 0.3 * bgCount / 4 ? sum / n2 : Infinity;
        };
        const base = score(0, 0, 1);
        let best = { dx: 0, dy: 0, sc: 1, err: base };
        const RANGE = Math.round(SW * 0.12);                 // ±12% of the crop
        for (const sc of [1, 0.97, 0.94, 1.03, 1.06]) {      // scale ONLY if the background proves it
          for (let dy = -RANGE; dy <= RANGE; dy += 2) for (let dx = -RANGE; dx <= RANGE; dx += 2) {
            const e = score(dx, dy, sc);
            if (e < best.err) best = { dx, dy, sc, err: e };
          }
        }
        for (let dy = best.dy - 2; dy <= best.dy + 2; dy++) for (let dx = best.dx - 2; dx <= best.dx + 2; dx++) {
          const e = score(dx, dy, best.sc);
          if (e < best.err) best = { dx, dy, sc: best.sc, err: e };
        }
        const k = cropW / SW;                                 // small grid → crop pixels
        const dxF = best.dx * k, dyF = best.dy * k;
        // Above this residual the model re-rendered the scene and the
        // background is not a usable alignment signal. That is NOT a rejection:
        // the composite takes only the figure union from the candidate, so the
        // shipped background is the original's by construction (the pre-spine
        // fullScene design). This used to throw here — Grok Imagine ALWAYS
        // re-renders the whole scene in box mode, so the throw refused 11/12
        // owner repairs on job_1788215224103_avu132n7je p16 while the paste
        // itself would have been background-safe. We only refuse to APPLY a
        // background-derived shift; figure registration below aligns the
        // silhouettes instead, and the IoU gate still judges the result.
        const BG_TRUST_ERR = 26;   // mean |grey diff| over background
        if (best.err > BG_TRUST_ERR) {
          registration = { mode: 'bg-rerendered', bgErr: +best.err.toFixed(1) };
          bgVerdict = 'rerendered';
          log.info(`[TESTLAB] background re-rendered by the model (err ${best.err.toFixed(1)} grey levels at best alignment) — no background shift applied; relying on figure registration + IoU gate`);
        } else if (Math.abs(best.dx) > 0 || Math.abs(best.dy) > 0 || best.sc !== 1) {
          const sw = Math.max(1, Math.round(cropW * best.sc)), sh = Math.max(1, Math.round(cropH * best.sc));
          const scaled = await sharp(candidateCropBuf).resize(sw, sh, { fit: 'fill' }).png().toBuffer();
          const canvas = await sharp(candidateCropBuf).resize(cropW, cropH, { fit: 'fill' }).png().toBuffer();
          const left = Math.round((cropW - sw) / 2 + dxF), top = Math.round((cropH - sh) / 2 + dyF);
          const registered = await sharp(canvas).composite([{ input: scaled, left, top }]).png().toBuffer();
          const newMask2 = maskFetcher ? await maskFetcher(registered) : await fetchMaskWithRetry(registered, boxInCrop, 5, maskPoints || {});
          if (newMask2) {
            candidateCropBuf = registered;
            newMask = newMask2;
            registration = { mode: 'background', dx: Math.round(dxF), dy: Math.round(dyF), scale: best.sc, bgErrBefore: +base.toFixed(1), bgErrAfter: +best.err.toFixed(1) };
            bgVerdict = 'shifted';
            require('./runMetrics').forJob(require('./styledAvatars')._cacheContext?.getStore?.()).count('repair_registration');
            log.info(`[TESTLAB] registered on BACKGROUND: dx=${registration.dx} dy=${registration.dy} scale=${registration.scale} — bg mismatch ${registration.bgErrBefore} → ${registration.bgErrAfter} grey levels`);
            await addStep(`registered on background (dx ${registration.dx}, dy ${registration.dy}, scale ${registration.scale}) — bg err ${registration.bgErrBefore}→${registration.bgErrAfter}`, `data:image/png;base64,${registered.toString('base64')}`);
          }
        } else {
          bgVerdict = 'aligned';
          log.info(`[TESTLAB] background already aligned (err ${base.toFixed(1)}) — no registration needed`);
        }
      } else {
        log.info('[TESTLAB] too little background visible to register on — blending unregistered');
      }
    } catch (err) {
      if (err.partialResult) throw err;               // a gate throw passing through
      log.warn(`[TESTLAB] background registration failed (${err.message}) — blending unregistered`);
    }
  }

  // ---- FIGURE REGISTRATION (body blends) -----------------------------------
  // When the model re-renders in place, the repainted figure routinely comes
  // back a little larger or shifted even though it is the RIGHT figure in the
  // RIGHT spot — the pre-spine fullScene design absorbed that with its
  // old∪new feather composite; the spine's IoU gate refused it instead
  // (job_1788215224103 p16: draws ~1.3-1.6x oversized, every one rejected).
  // Restore the absorption without losing the gate: align the new silhouette's
  // bbox onto the old one (uniform scale from the HEIGHT ratio — width varies
  // with pose; dy anchors the bbox BOTTOMS, feet stay on the ground; dx aligns
  // the centres), apply the same affine to candidate and mask, and only keep
  // it when the bbox IoU improves. A genuinely re-posed figure still fails the
  // pixel-IoU gate afterwards — this normalises geometry, it does not excuse a
  // different figure. Body blends only: the face path's masks nearly coincide
  // by construction and its blend is separately calibrated.
  // Only when the background says the scene was RE-RENDERED (or told us
  // nothing). An aligned background is the strongest available evidence that
  // the figure's geometry is trustworthy in box mode — exp #969: bg err 7.4
  // (aligned) while DINO returned a degenerate whole-crop box, and the
  // resulting 0.85 "correction" shrank an already-aligned candidate into a
  // guaranteed IoU failure.
  if (registerCandidate && blendShape === 'figure-exact' && bgVerdict !== 'aligned' && bgVerdict !== 'shifted') {
    try {
      const alphaBox = async (maskPng) => {
        const a = await sharp(maskPng).resize(cropW, cropH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
        const st = Math.max(1, Math.round(a.length / (cropW * cropH)));
        let x0 = cropW, y0 = cropH, x1 = -1, y1 = -1;
        for (let y = 0; y < cropH; y++) for (let x = 0; x < cropW; x++) {
          if (a[(y * cropW + x) * st] > 128) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
      };
      // Transform source: DINO box → DINO box when the caller re-detected the
      // candidate (same instrument on both sides; immune to a poisoned SAM
      // mask — exp #968: the sky-blob bbox produced a plausible-looking but
      // meaningless transform). SAM alpha bboxes are the fallback.
      const haveDino = Array.isArray(newBoxInCrop) && newBoxInCrop.length === 4
        && (newBoxInCrop[2] - newBoxInCrop[0]) > 8 && (newBoxInCrop[3] - newBoxInCrop[1]) > 8
        && Array.isArray(boxInCrop) && boxInCrop.length === 4;
      const ob = haveDino ? boxInCrop : await alphaBox(oldMask);
      const nb = haveDino ? newBoxInCrop : await alphaBox(newMask);
      const reg = (ob && nb) ? computeFigureRegistration({ oldBox: ob, newBox: nb }) : null;
      const meaningful = reg && (Math.abs(reg.scale - 1) > 0.03 || Math.abs(reg.dx) > cropW * 0.02 || Math.abs(reg.dy) > cropH * 0.02);
      if (meaningful) {
        const tb = transformBox(nb, reg);
        const before = boxIou(ob, nb), after = boxIou(ob, tb);
        if (after > before + 0.05) {
          const applyAffine = async (buf, blank) => {
            const sw = Math.max(1, Math.round(cropW * reg.scale));
            const sh = Math.max(1, Math.round(cropH * reg.scale));
            const scaled = await sharp(buf).ensureAlpha().resize(sw, sh, { fit: 'fill' }).png().toBuffer();
            // Destination canvas: the (unscaled) candidate itself for the image
            // (best available filler outside the moved frame), transparent for
            // the mask. Composite handles negative offsets by pre-cropping.
            const base = blank
              ? await sharp({ create: { width: cropW, height: cropH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
              : await sharp(buf).ensureAlpha().resize(cropW, cropH, { fit: 'fill' }).png().toBuffer();
            const L = Math.round(reg.dx), T = Math.round(reg.dy);
            const sx = Math.max(0, -L), sy = Math.max(0, -T);
            const dx2 = Math.max(0, L), dy2 = Math.max(0, T);
            const w = Math.min(sw - sx, cropW - dx2), h = Math.min(sh - sy, cropH - dy2);
            if (w <= 0 || h <= 0) return null;
            const piece = await sharp(scaled).extract({ left: sx, top: sy, width: w, height: h }).png().toBuffer();
            return sharp(base).composite([{ input: piece, left: dx2, top: dy2 }]).png().toBuffer();
          };
          const regCand = await applyAffine(candidateCropBuf, false);
          let regMask = null;
          if (regCand) {
            // RE-SEGMENT on the registered candidate, exactly like the
            // background branch above. The round-2 mask was fetched on the
            // UNREGISTERED output with seeds from the ORIGINAL geometry — when
            // the model moved/rescaled the figure, a seed lands on background
            // and SAM segments the sky (measured: the 2026-09-01 p16 verify
            // run cut out the sunset behind Lorena's enlarged head, pixel IoU
            // 13% under a bbox IoU of 0.90). On the registered candidate the
            // old-geometry box and seeds are valid again. Affine-transforming
            // the old round-2 mask is only the fallback when the refetch fails
            // — it faithfully preserves whatever round 2 found, poisoned or not.
            try {
              // SAME padded box + seeds as the initial round-2 fetch — on the
              // registered candidate the old-geometry prompt is valid again.
              regMask = refetchRound2 ? await refetchRound2(regCand) : null;
            } catch { /* fall back below */ }
            if (!regMask) {
              log.warn('[TESTLAB] round-2 refetch on the registered candidate failed — using the affine-transformed mask');
              regMask = await applyAffine(newMask, true);
            }
          }
          if (regCand && regMask) {
            candidateCropBuf = regCand;
            newMask = regMask;
            registration = { ...(registration || {}), mode: registration?.mode === 'background' ? 'background+figure' : 'figure', figDx: reg.dx, figDy: reg.dy, figScale: reg.scale, bboxIouBefore: +before.toFixed(2), bboxIouAfter: +after.toFixed(2) };
            require('./runMetrics').forJob(require('./styledAvatars')._cacheContext?.getStore?.()).count('repair_figure_registration');
            log.info(`[TESTLAB] registered on FIGURE: scale=${reg.scale} dx=${reg.dx} dy=${reg.dy} — silhouette bbox IoU ${before.toFixed(2)} → ${after.toFixed(2)}`);
            await addStep(`registered on figure (scale ${reg.scale}, dx ${reg.dx}, dy ${reg.dy}) — bbox IoU ${before.toFixed(2)}→${after.toFixed(2)}`, `data:image/png;base64,${regCand.toString('base64')}`);
          }
        }
      }
    } catch (err) {
      log.warn(`[TESTLAB] figure registration failed (${err.message}) — blending unregistered`);
    }
  }

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
    let keep = _faceConnectedComponent(union, cropW, cropH, cxF, cyF);
    if (blendShape === 'figure-exact' && boxInCrop?.length === 4) {
      // FIGURE mode: every OLD-mask island is a ghost by definition — the old
      // kneeling foot cut off by a foreground object (the wand) is a separate
      // component, and dropping it left an orphan sandal on the floor (local
      // iter 2). Keep every union component that intersects the padded
      // detection box; only fragments clearly outside the figure's area (a
      // neighbour caught by the crop) are still dropped.
      const bw = boxInCrop[2] - boxInCrop[0], bh = boxInCrop[3] - boxInCrop[1];
      const pb = [
        Math.max(0, boxInCrop[0] - bw * 0.08), Math.max(0, boxInCrop[1] - bh * 0.08),
        Math.min(cropW, boxInCrop[2] + bw * 0.08), Math.min(cropH, boxInCrop[3] + bh * 0.08),
      ];
      const visited = new Uint8Array(n);
      const keep2 = Buffer.from(keep);
      let mainCompPx = 0;
      for (let i = 0; i < n; i++) if (keep[i]) mainCompPx++;
      let strayDropped = 0;
      for (let s = 0; s < n; s++) {
        if (union[s] <= 128 || visited[s] || keep[s]) continue;
        // flood this unseen component, test box overlap
        const comp = [s]; const stack = [s]; visited[s] = 1;
        let hits = false;
        while (stack.length) {
          const k = stack.pop(); const x = k % cropW, y = (k / cropW) | 0;
          if (x >= pb[0] && x < pb[2] && y >= pb[1] && y < pb[3]) hits = true;
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cropW || ny >= cropH) continue;
            const j = ny * cropW + nx;
            if (union[j] > 128 && !visited[j]) { visited[j] = 1; stack.push(j); comp.push(j); }
          }
        }
        // Size gate: keeping EVERY component that merely touches the padded box
        // let stray SAM specks outside the figure into the paste (owner, after
        // #315: "the SAM mask finds small areas outside the figure"). A severed
        // body part — the reason this rule exists — is substantial; a speck is
        // not. Keep only components >= 0.8% of the main silhouette (min 150px).
        if (hits && comp.length >= Math.max(150, Math.round(mainCompPx * 0.008))) {
          for (const j of comp) keep2[j] = 255;
        } else if (hits) {
          strayDropped += comp.length;
        }
      }
      if (strayDropped > 0) log.info(`[TESTLAB] dropped ${strayDropped}px stray fragments near the figure box (below the 0.8% size gate)`);
      keep = keep2;
    }
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
  // Gate tunable via opts (default 0.55 = today's hardcoded value, byte-identical
  // behaviour). The unified faceRepair.js exposes it as opts.gates.iou so a Test
  // Lab A/B can calibrate before the legacy box-blur/crosshatch paths (which
  // never faced this gate) route through here in production.
  if (gateIou && iou < iouThreshold) {
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
  // padMode — WHERE the 6px safety pad is applied.
  //  'union'     (default, historical): pad the whole union. Around the old-only
  //              boundary this pushes the paste 6px into REAL background, carrying
  //              the model's unfilled whiteout glow with it → white halo.
  //  'newFigure': pad only the NEW figure's edge (the anti-aliased edge the pad
  //              exists for) and take the old-only boundary EXACTLY. Outside the old
  //              silhouette the original background is correct and available, so
  //              there is nothing to gain by pasting over it.
  // blendShape — the SHAPE of the full-opacity paste region:
  //  'padded-union'  (historical): dilate(old ∪ new, 6). Around the old-only
  //                  boundary the pad lands in REAL background and carries the
  //                  model's pixels (incl. whiteout glow) 6px out → white halo.
  //  'figure-exact'  (the correct construction): old ∪ dilate(new, 6). Full
  //                  opacity over the ENTIRE old silhouette (nothing old can ever
  //                  show through) and over the new figure + its anti-aliased
  //                  edge (the only place the pad has a purpose). The paste
  //                  never extends beyond the old edge into background the
  //                  original already renders correctly. Combined with content
  //                  substitution below, model pixels are STRUCTURALLY unable
  //                  to appear outside this region — the halo has no source.
  const padPx = 6;
  const unionPadded = await maskBlurThreshold(union, cropW, cropH, padPx / 1.5, 16);
  const alpha1 = Buffer.from(unionPadded);
  const sOld = Math.max(1, Math.round(oldA.length / n));
  if (blendShape === 'figure-exact') {
    const newPad = await maskBlurThreshold(Buffer.from(newBin), cropW, cropH, padPx / 1.5, 16);
    // Old mask dilated ~2px: the original's painted ink outline of the old figure
    // sits just OUTSIDE SAM's fill mask — it must be inside the paste region or
    // it survives as a thin dark line tracing the old silhouette.
    const oldBinT = Buffer.alloc(n);
    for (let i = 0; i < n; i++) oldBinT[i] = oldA[i * sOld] > 128 ? 255 : 0;
    const oldPad = await maskBlurThreshold(oldBinT, cropW, cropH, 1.6, 16);
    for (let i = 0; i < n; i++) alpha1[i] = (oldPad[i] > 128 || newPad[i] > 128) ? 255 : 0;
  } else if (padMode === 'newFigure') {
    const newPad = await maskBlurThreshold(Buffer.from(newBin), cropW, cropH, padPx / 1.5, 16);
    for (let i = 0; i < n; i++) alpha1[i] = (union[i] > 128 || newPad[i] > 128) ? 255 : 0;
  }

  // Split figure vs background by the SAM MASK (newBin), NOT brightness: Qwen
  // lightens BOTH the background and parts of the face, so a luminance threshold
  // misclassifies lightened face as background. The 6px margin, though, exists
  // because SAM's mask is sometimes too tight and clips the figure's edge, so we
  // must NOT blanket-correct it. Protect a ~3px ring around the figure (its edge),
  // background-match only beyond that:
  //   FIGURE  = newBin (+3px edge ring) → face correction, kept from candidate
  //   BG      = alpha1 && !dilate(newBin,3) → red zone + outer glow → background
  const s1r = Math.max(1, Math.round(oldA.length / n));
  const newDil = await maskBlurThreshold(Buffer.from(newBin), cropW, cropH, 2, 16); // real ≈3px OUTWARD dilation
  const redZone = Buffer.alloc(n);
  let redZonePx = 0;
  for (let i = 0; i < n; i++) {
    if (alpha1[i] && newDil[i] <= 128) { redZone[i] = 255; redZonePx++; }
  }
  if (redZonePx) log.info(`[TESTLAB] bg-match mask: ${redZonePx}px (red zone + outer margin beyond the figure's 3px edge ring)`);

  // White-card gate: a face painted on a white panel passes IoU (geometry
  // aligns) and the style gate (a colorless panel has no "style") — v92's
  // Roger shipped exactly that. Mechanical check: the pixels TAKEN from the
  // new image must not be substantially near-white.
  const candRaw0 = await sharp(candidateCropBuf).resize(cropW, cropH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  {
    let unionCnt = 0, whiteCnt = 0;
    for (let i = 0; i < n; i++) {
      if (!alpha1[i]) continue;
      unionCnt++;
      if (candRaw0[i * 3] >= 243 && candRaw0[i * 3 + 1] >= 243 && candRaw0[i * 3 + 2] >= 243) whiteCnt++;
    }
    const whiteFrac = unionCnt ? whiteCnt / unionCnt : 0;
    if (gateWhiteCard && whiteFrac > whiteCardMaxFrac) {
      throw fail(`Blended region is ${(whiteFrac * 100).toFixed(0)}% near-white — the model painted the face on a white card. Redo.`);
    }
  }

  // WHITE-HOLE coverage guard (owner, 2026-09-02): every treated pixel — the
  // old silhouette that was whited out / crosshatched in the input — must come
  // back covered, either by the redrawn figure's cut or by real painted
  // background. Where the model instead reproduced the treatment's white, the
  // union pastes it onto the page as a white rectangle (G7 p16 evidence:
  // v2-f1-s5). Colour-matching cannot rescue a pure-white region, and the
  // white-card gate averages over the WHOLE union so a partial hole slips
  // under its 22%. Reject BEFORE compositing. Geometric-only coverage would
  // be wrong — a legitimate shrink repair (extra limb removed, slimmer build)
  // leaves old-only pixels filled with the model's painted background, which
  // is exactly what the red-zone colour match is for. Only NEAR-WHITE
  // uncovered content is a hole.
  {
    const hole = measureWhiteHole({ oldA, sOld: Math.max(1, Math.round(oldA.length / n)), newDil, candRaw: candRaw0, n });
    if (hole.uncoveredWhite > 0) log.info(`[TESTLAB] white-hole check: ${hole.uncoveredWhite}px near-white in the uncovered old silhouette (${(hole.frac * 100).toFixed(1)}% of ${hole.oldCnt}px)`);
    if (gateWhiteHole && hole.frac > whiteHoleMaxFrac && hole.uncoveredWhite > 150) {
      throw fail(`Treated region not covered — ${(hole.frac * 100).toFixed(0)}% of the old silhouette (${hole.uncoveredWhite}px) is near-white in the model output where the redrawn figure does not cover it. That ships as a white hole. Redo.`);
    }
  }

  // Applied mask views instead of raw black/white masks: (a) the original
  // with the padded union whited out — the region the blend treats as
  // figure; (b) the pixels actually TAKEN from the new image.
  const candResized = await sharp(candidateCropBuf).resize(cropW, cropH, { fit: 'fill' }).png().toBuffer(); // PNG: lossless paste source
  const origResized = await sharp(originalCropBuf).resize(cropW, cropH, { fit: 'fill' }).png().toBuffer(); // PNG: lossless colour reference
  const unionAlphaPng = await sharp(Buffer.alloc(n * 3, 255), { raw: { width: cropW, height: cropH, channels: 3 } })
    .ensureAlpha().joinChannel(Buffer.from(alpha1), raw1).png().toBuffer();
  const whiteVis = await sharp(origResized).composite([{ input: unionAlphaPng }]).jpeg().toBuffer();
  await addStep(blendShape === 'figure-exact' ? 'original with paste region whited out (old ∪ new+6px pad)' : 'original with SAM union whited out (padded 6px)', `data:image/jpeg;base64,${whiteVis.toString('base64')}`);
  const cutoutPng = await sharp(candResized).ensureAlpha().joinChannel(Buffer.from(alpha1), raw1).png().toBuffer();
  const cutVis = await sharp({ create: { width: cropW, height: cropH, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .composite([{ input: cutoutPng }]).jpeg().toBuffer();
  await addStep('SAM-identified region — pixels taken from the new image', `data:image/jpeg;base64,${cutVis.toString('base64')}`);

  // Qwen colour-shift correction — remap the pasted figure's tone back toward
  // the original (histogram) and close the border gap (harmonic seam) so the
  // paste doesn't read as a different-coloured patch. No-op below threshold.
  // Reference distribution = the ORIGINAL figure mask (oldA), applied to the
  // union being pasted (alpha1).
  // Build the paste as RAW RGB: start from the candidate, colour-correct the
  // figure, then colour-match the background the paste introduces.
  const { correctColorShift } = require('./imageCompositing');
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
  if (colorCorrect && !bodyColorMode && !rawPaste) {
    try {
      // FIGURE correction (material-aware), referenced to the ORIGINAL figure
      // (refMask = oldA) so the white glow / red zone can't skew the palette.
      const refMaskBin = Buffer.alloc(n);
      for (let i = 0; i < n; i++) refMaskBin[i] = oldA[i * s1r] > 128 ? 255 : 0;
      // Correct the NEW figure AND the red zone (old-only pixels kept from the
      // model, e.g. the chin the round-2 mask missed) as ONE region. The material-
      // aware shift matches each pasted pixel to its own original material; the
      // background halo at the edge is handled separately by the background-match
      // below, which never touches the figure.
      const ccMask = Buffer.alloc(n);
      for (let i = 0; i < n; i++) ccMask[i] = (newDil[i] > 128 || redZone[i] > 128) ? 255 : 0;
      const cc = await correctColorShift(origRaw, pasteRaw, ccMask, cropW, cropH, { refMask: refMaskBin, borderRefine: colorBorderRefine, garmentOnly });
      if (cc.applied) {
        pasteRaw = Buffer.from(cc.correctedRaw);
        colorInfo = { deltaEBefore: cc.deltaEBefore, seamBefore: cc.seamDeltaEBefore, seamAfter: cc.seamDeltaEAfter, clusters: cc.clusterInfo };
      }
    } catch (err) {
      log.warn(`[TESTLAB] colour correction skipped (${err.message})`);
    }
  }
  // Colour-match the BACKGROUND the paste INTRODUCES (red zone + silhouette-border
  // margin) back to the surrounding scene, so the edge doesn't read as a cut-out.
  // See matchIntroducedBackground. Runs whenever there's a red zone or bgBorderMatch.
  // rawPaste: the DIAGNOSTIC variant — model content across the whole paste
  // region, hard, untouched. What you see minus the FINAL card = the blend's
  // contribution; what is ugly in BOTH = the model output's own defects.
  if (!rawPaste && (redZonePx > 0 || bgBorderMatch)) {
    const oldBinBuf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) oldBinBuf[i] = oldA[i * s1r] > 128 ? 255 : 0;
    const { bgPx, materials } = await matchIntroducedBackground({
      origRaw, pasteRaw, cropW, cropH, alpha1, redZone, newDil, bgBorderMatch,
      // figure-exact: two-band footprint (original low band + model texture).
      // Legacy shape keeps the per-material mean shift.
      localField: blendShape === 'figure-exact', oldBin: oldBinBuf, newBin,
    });
    if (bgPx > 0) log.info(`[TESTLAB] ${bodyColorMode ? 'figure-mode border' : 'red-zone'}: colour-matched ${bgPx}px background (${materials} materials${blendShape === 'figure-exact' ? ', local two-band field' : ''}) to the scene`);
    if (!colorInfo && bodyColorMode) colorInfo = { deltaEBefore: null, seamBefore: null, seamAfter: null, figureColorKept: true };
    if (colorInfo) { colorInfo.redZonePx = redZonePx; colorInfo.bgMatchedPx = bgPx; }
  }
  // figure-exact: CONTENT SUBSTITUTION outside the paste region. The feather
  // ramp extends beyond alpha1, and whatever pixels sit there get partially
  // composited — under 'padded-union' that is the model's redrawn background
  // (glow included), the halo's source. Substituting the ORIGINAL there means
  // the ramp blends original-with-original: geometrically soft, visually
  // invisible, and the model cannot contribute a single pixel beyond the
  // paste region no matter how wide the feather is.
  if (blendShape === 'figure-exact' && !rawPaste) {
    for (let i = 0; i < n; i++) {
      if (alpha1[i] <= 128) {
        pasteRaw[i * 3] = origRaw[i * 3];
        pasteRaw[i * 3 + 1] = origRaw[i * 3 + 1];
        pasteRaw[i * 3 + 2] = origRaw[i * 3 + 2];
      }
    }
  }
  const pasteBuf = await sharp(pasteRaw, { raw: { width: cropW, height: cropH, channels: 3 } }).png().toBuffer(); // PNG: lossless corrected paste
  // Applied view: exactly what gets pasted (colour-corrected figure + filled bg).
  const ccCut = await sharp(pasteBuf).ensureAlpha().joinChannel(Buffer.from(alpha1), raw1).png().toBuffer();
  const ccVis = await sharp({ create: { width: cropW, height: cropH, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .composite([{ input: ccCut }]).jpeg().toBuffer();
  await addStep(`pasted region (colour${colorInfo ? ` ΔE ${colorInfo.deltaEBefore}, seam ${colorInfo.seamBefore}→${colorInfo.seamAfter}` : ' n/a'}${redZonePx ? `, red-zone ${redZonePx}px kept from model` : ''})`, `data:image/jpeg;base64,${ccVis.toString('base64')}`);

  // Edge feather — industry paste-back recipe: ERODE the alpha inward by the feather
  // radius, THEN Gaussian-feather, so the blend ramp lives INSIDE the pasted figure
  // and the composite never samples original beyond the new content's edge. A wider
  // feather (vs the old hard ~2px) dissolves the silhouette seam instead of stamping
  // a 1px step. featherPx/erodeFeather are exposed so the Test Lab can A/B each stage
  // on the SAME model output. (sharp's raw blur can come back multi-channel — stride.)
  const fpx = featherPx == null ? 6 : Math.max(0, Number(featherPx));
  // featherMode — WHERE the alpha ramp sits relative to the union edge. Net
  // opacity coverage is (pad − erosion), so this decides whether a wide feather
  // dissolves the seam or eats the paste:
  //  'erode'    ramp INSIDE  (erode fpx, then blur) → net 6 − fpx. Correct ONLY
  //             when the union edge is a real content boundary and the original
  //             just outside it is untouched background (a face repair whose
  //             masks agree). On a figure repair the union edge IS the OLD
  //             silhouette, so eroding re-exposes the old figure: at fpx 14 the
  //             paste stops 8px inside the union and the old body shows through.
  //  'centered' blur only → net 6. Ramp straddles the edge.
  //  'outward'  dilate fpx, then blur → alpha 255 across the ENTIRE union, with
  //             the falloff beyond it where both sides are background. Coverage
  //             never shrinks, so the feather can be widened freely.
  // Default is unchanged ('erode', or 'centered' when erodeFeather === false).
  // figure-exact FORCES 'outward': erode would re-expose the old figure (the
  // measured 8-27px uncovered ring), and with content substitution the outward
  // band costs nothing — it blends original into original.
  const mode = rawPaste ? 'raw' : (blendShape === 'figure-exact' ? 'outward' : (featherMode || (erodeFeather === false ? 'centered' : 'erode')));
  let alphaSrc = Buffer.from(alpha1);
  if (mode === 'raw') { /* binary union alpha — no ramp at all */ }
  else if (fpx >= 1 && mode === 'erode') alphaSrc = await maskBlurThreshold(alphaSrc, cropW, cropH, fpx, 200); // blur+high-thr shrinks ~fpx inward
  else if (fpx >= 1 && mode === 'outward') alphaSrc = await maskBlurThreshold(alphaSrc, cropW, cropH, fpx / 1.5, 16); // grows ~fpx outward
  const alphaBlur = mode === 'raw' ? Buffer.from(alphaSrc) : await sharp(alphaSrc, raw1).blur(Math.max(0.3, fpx || 1.2)).raw().toBuffer();
  const abStride = Math.max(1, Math.round(alphaBlur.length / n));
  const alphaSoft = abStride === 1 ? alphaBlur : (() => { const o = Buffer.alloc(n); for (let i = 0; i < n; i++) o[i] = alphaBlur[i * abStride]; return o; })();
  // Outward ramp is ONE-SIDED: the Gaussian tail also bleeds ~10% inward past
  // the region edge, and inside the old silhouette "10% of original" is 10% of
  // the OLD FIGURE (measured min alpha 223-228 → a faint ghost edge). Clamp the
  // paste region itself back to full opacity; the ramp lives strictly outside.
  if (mode === 'outward') {
    for (let i = 0; i < n; i++) if (alpha1[i] > 128) alphaSoft[i] = 255;
  }
  await addStep(blendShape === 'figure-exact'
    ? `composite alpha (figure-exact: full opacity over old ∪ new+pad, feather ${fpx}px outward into substituted-original band)`
    : `composite alpha (feather ${fpx}px, ramp ${mode}${padMode === 'newFigure' ? ', pad new-figure only' : ''} → net coverage ${mode === 'erode' ? padPx - fpx : mode === 'outward' ? padPx + fpx : padPx}px)`, `data:image/png;base64,${(await sharp(alphaSoft, raw1).png().toBuffer()).toString('base64')}`);
  const feathered = await sharp(pasteBuf).ensureAlpha().joinChannel(alphaSoft, raw1).png().toBuffer();
  return { feathered, iou, redPx, colorInfo, registration, blendRule: blendShape === 'figure-exact' ? 'figure-exact-pad6' : BLEND_RULE_VERSION };
}

module.exports = { samUnionBlend, maskBlurThreshold, _faceConnectedComponent, _interiorSeedPoints, fetchMaskWithRetry, BLEND_RULE_VERSION, computeFigureRegistration, transformBox, boxIou, measureWhiteHole };
