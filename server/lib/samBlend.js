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
  const { _rgbToLab, _labToRgb, _deltaE, _ccKMeans } = require('./images');
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
    let fCnt = 0, ringPx = 0;
    for (let i = 0; i < n; i++) {
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
      if (F[i]) cF[ci] = 1;
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
      if (!F[i]) { for (let c = 0; c < 3; c++) LB[i * 3 + c] = lowOrig[i * 3 + c]; continue; }
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
        if (!F[i]) continue;
        let c0 = 0; const acc = [0, 0, 0];
        const nb = [i - 1, i + 1, i - cropW, i + cropW];
        const ok = [x > 0, x < cropW - 1, y > 0, y < cropH - 1];
        for (let k = 0; k < 4; k++) {
          if (!ok[k]) continue;
          const j = nb[k];
          const jBoundary = !F[j] && newTight[j] <= 128 && !isOld(j);
          if (!F[j] && !jBoundary) continue; // figure / covered-old never a source
          c0++; for (let c = 0; c < 3; c++) acc[c] += F[j] ? LB[j * 3 + c] : lowOrig[j * 3 + c];
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
    for (let i = 0; i < n; i++) {
      if (!F[i]) continue;
      // TEXTURE CONFIDENCE — where the model's LOW band was overruled (it
      // disagrees with LB), its HIGH band must not survive either: a soft
      // shadow whose body LB removed would otherwise leave its EDGE as an
      // orphaned crisp dark stroke (the "knee shadow line" of exp #275). Fade
      // texture to zero as low-band disagreement approaches ~35.
      let dis = 0;
      for (let c = 0; c < 3; c++) dis = Math.max(dis, Math.abs(lowModel[i * 3 + c] - LB[i * 3 + c]));
      const conf = Math.max(0, 1 - dis / 35);
      for (let c = 0; c < 3; c++) {
        const tex = Math.max(-40, Math.min(40, pasteRaw[i * 3 + c] - lowModel[i * 3 + c]));
        pasteRaw[i * 3 + c] = cl(LB[i * 3 + c] + wTex[i] * conf * tex);
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
      const figBlurRgb = await sharpL(figMaskedRgb, { raw: { width: cropW, height: cropH, channels: 3 } }).blur(5).raw().toBuffer();
      const figBlurW = await sharpL(figMaskW, { raw: { width: cropW, height: cropH, channels: 1 } }).blur(5).raw().toBuffer();
      const fwStride = Math.max(1, Math.round(figBlurW.length / n));
      for (let i = 0; i < n; i++) {
        if (!(newTight[i] > 128 && newEro[i] <= 128 && alpha1[i] > 128)) continue;
        const fw = figBlurW[i * fwStride] / 255;
        if (fw < 0.03) continue;
        const lab = _rgbToLab(pasteRaw[i * 3], pasteRaw[i * 3 + 1], pasteRaw[i * 3 + 2]);
        const figRef = _rgbToLab(figBlurRgb[i * 3] / fw, figBlurRgb[i * 3 + 1] / fw, figBlurRgb[i * 3 + 2] / fw);
        const dFig = _deltaE(lab, figRef);
        const ref = F[i] ? [LB[i * 3], LB[i * 3 + 1], LB[i * 3 + 2]] : [origRaw[i * 3], origRaw[i * 3 + 1], origRaw[i * 3 + 2]];
        const dBg = _deltaE(lab, _rgbToLab(ref[0], ref[1], ref[2]));
        if (dBg < dFig) {
          pasteRaw[i * 3] = cl(ref[0]); pasteRaw[i * 3 + 1] = cl(ref[1]); pasteRaw[i * 3 + 2] = cl(ref[2]);
          bandPx++;
        }
      }
    }
    log.info(`[TESTLAB] two-band footprint: ${fCnt}px = original low band (coarse-to-fine) + confidence-weighted model texture; pad ring ${ringPx}px → original; edge band ${bandPx}px glow replaced`);
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
async function samUnionBlend({ originalCropBuf, candidateCropBuf, boxInCrop, cropW, cropH, oldMaskPng = null, addStep = async () => {}, failCtx = {}, clipRect = null, maskPoints = null, maskFetcher = null, colorCorrect = true, featherPx = null, erodeFeather = true, colorBorderRefine = true, bodyColorMode = false, bgBorderMatch = true, garmentOnly = true, featherMode = null, padMode = 'union', blendShape = 'padded-union', iouThreshold = 0.55, whiteCardMaxFrac = 0.22, gateIou = true, gateWhiteCard = true }) {
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
        if (hits) for (const j of comp) keep2[j] = 255;
      }
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
  {
    const candRaw0 = await sharp(candidateCropBuf).resize(cropW, cropH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
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
  const { correctColorShift } = require('./images');
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
  if (redZonePx > 0 || bgBorderMatch) {
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
  if (blendShape === 'figure-exact') {
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
  const mode = blendShape === 'figure-exact' ? 'outward' : (featherMode || (erodeFeather === false ? 'centered' : 'erode'));
  let alphaSrc = Buffer.from(alpha1);
  if (fpx >= 1 && mode === 'erode') alphaSrc = await maskBlurThreshold(alphaSrc, cropW, cropH, fpx, 200); // blur+high-thr shrinks ~fpx inward
  else if (fpx >= 1 && mode === 'outward') alphaSrc = await maskBlurThreshold(alphaSrc, cropW, cropH, fpx / 1.5, 16); // grows ~fpx outward
  const alphaBlur = await sharp(alphaSrc, raw1).blur(Math.max(0.3, fpx || 1.2)).raw().toBuffer();
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
  return { feathered, iou, redPx, colorInfo, blendRule: blendShape === 'figure-exact' ? 'figure-exact-pad6' : BLEND_RULE_VERSION };
}

module.exports = { samUnionBlend, maskBlurThreshold, _faceConnectedComponent, _interiorSeedPoints, fetchMaskWithRetry, BLEND_RULE_VERSION };
