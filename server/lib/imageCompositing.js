/**
 * Compositing — masks, colour science and exact-size Grok round-trips.
 *
 * Split out of images.js 2026-08-09. This cluster has ZERO inbound calls from
 * generation, evaluation or the repair pipeline: it is consumed almost entirely
 * by faceRepair.js and samBlend.js, which do the character-repair blending.
 *
 * What lives here:
 *   - computePresetAlignedExtract  crop geometry aligned to a Grok aspect preset
 *   - detectGrokBorder             finds the border Grok sometimes paints on
 *   - fetch*MaskPng                silhouette / face / head / figure masks from
 *                                  the Python analyzer (SAM + rembg)
 *   - Lab/sRGB helpers + correctColorShift   seam colour matching
 *   - resizeGrokToSceneDims, grokEditSceneExact   pixel-exact edit round-trip
 *   - measureRegionSharpness, sanitizeIssueForInpaint, and the interaction
 *     context helper used to phrase a repair prompt
 *
 * The analyzer URL and in-flight cap come from photoAnalyzerClient.js so this
 * module and figure detection share one definition.
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { closestGrokAspect } = require('./grokAspect');
const { editWithGrok } = require('./grok');
const r2Lib = require('./r2');
const { MODEL_DEFAULTS } = require('../config/models');
const { withAnalyzerSlot } = require('./photoAnalyzerClient');

function computePresetAlignedExtract({ pixelLeft, pixelTop, pixelWidth, pixelHeight, padFactor, sceneWidth, sceneHeight }) {
  // Start from the minimum-padded box
  const minPadX = Math.floor(pixelWidth * padFactor);
  const minPadY = Math.floor(pixelHeight * padFactor);
  const baseLeft = Math.max(0, pixelLeft - minPadX);
  const baseTop = Math.max(0, pixelTop - minPadY);
  const baseRight = Math.min(sceneWidth, pixelLeft + pixelWidth + minPadX);
  const baseBottom = Math.min(sceneHeight, pixelTop + pixelHeight + minPadY);
  const baseW = baseRight - baseLeft;
  const baseH = baseBottom - baseTop;

  // Pick closest preset to the padded box aspect
  const baseRatio = baseW / baseH;
  const presetName = closestGrokAspect(baseW, baseH);
  const best = GROK_ASPECT_PRESETS.find(p => p.name === presetName);

  // Expand one axis to match preset exactly. Whichever axis grows, the other
  // stays at baseW / baseH so we only ADD scene pixels, never subtract.
  const targetRatio = best.value;
  let targetW, targetH;
  if (baseRatio < targetRatio) {
    // Too tall — grow width
    targetH = baseH;
    targetW = Math.round(baseH * targetRatio);
  } else {
    // Too wide — grow height
    targetW = baseW;
    targetH = Math.round(baseW / targetRatio);
  }

  // If the preset-aligned target exceeds scene bounds on either axis, shrink
  // both axes proportionally so the crop fits (keeps the preset ratio exact).
  // This happens when the base box is already near a scene edge.
  if (targetW > sceneWidth || targetH > sceneHeight) {
    const scale = Math.min(sceneWidth / targetW, sceneHeight / targetH);
    targetW = Math.floor(targetW * scale);
    targetH = Math.floor(targetH * scale);
  }

  // Center the expanded box on the bbox center, then clamp left/top so the
  // full box fits. Because targetW ≤ sceneWidth and targetH ≤ sceneHeight,
  // clamping can never produce negative coordinates.
  const cx = pixelLeft + pixelWidth / 2;
  const cy = pixelTop + pixelHeight / 2;
  let left = Math.round(cx - targetW / 2);
  let top = Math.round(cy - targetH / 2);
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (left + targetW > sceneWidth) left = sceneWidth - targetW;
  if (top + targetH > sceneHeight) top = sceneHeight - targetH;

  return { left, top, width: targetW, height: targetH, preset: best.name };
}

/**
 * Detect uniform pale border in an image (from Grok aspect drift / letterboxing).
 * Returns { left, top, width, height, imgWidth, imgHeight } of the content box, or null.
 */
async function detectGrokBorder(buffer) {
  try {
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (width < 100 || height < 100) return null;

    const px = (x, y) => {
      const i = (y * width + x) * channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];
    const baseline = [
      Math.round((corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4),
      Math.round((corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4),
      Math.round((corners[0][2] + corners[1][2] + corners[2][2] + corners[3][2]) / 4),
    ];
    for (const c of corners) {
      if (Math.abs(c[0] - baseline[0]) > 20 || Math.abs(c[1] - baseline[1]) > 20 || Math.abs(c[2] - baseline[2]) > 20) {
        return null;
      }
    }

    const THRESH = 40;
    const deviates = (r, g, b) =>
      Math.abs(r - baseline[0]) > THRESH || Math.abs(g - baseline[1]) > THRESH || Math.abs(b - baseline[2]) > THRESH;

    const maxInset = Math.floor(Math.min(width, height) * 0.4);
    let top = 0;
    for (; top < maxInset; top++) {
      let hit = false;
      for (let x = 0; x < width; x++) { const [r, g, b] = px(x, top); if (deviates(r, g, b)) { hit = true; break; } }
      if (hit) break;
    }
    let bottom = height - 1;
    for (; bottom > height - 1 - maxInset; bottom--) {
      let hit = false;
      for (let x = 0; x < width; x++) { const [r, g, b] = px(x, bottom); if (deviates(r, g, b)) { hit = true; break; } }
      if (hit) break;
    }
    let left = 0;
    for (; left < maxInset; left++) {
      let hit = false;
      for (let y = 0; y < height; y++) { const [r, g, b] = px(left, y); if (deviates(r, g, b)) { hit = true; break; } }
      if (hit) break;
    }
    let right = width - 1;
    for (; right > width - 1 - maxInset; right--) {
      let hit = false;
      for (let y = 0; y < height; y++) { const [r, g, b] = px(right, y); if (deviates(r, g, b)) { hit = true; break; } }
      if (hit) break;
    }

    const contentW = right - left + 1;
    const contentH = bottom - top + 1;
    const maxSideInset = Math.max((width - contentW) / width, (height - contentH) / height);
    if (maxSideInset > 0.45) return null;

    return { left, top, right, bottom, width: contentW, height: contentH, imgWidth: width, imgHeight: height };
  } catch { return null; }
}

/**
 * Run rembg on a JPEG crop via the Python photo_analyzer service and return
 * the figure-silhouette PNG (white-on-transparent, alpha=255 inside, 0
 * outside). Returns null on any failure — callers fall back to a non-shape
 * path so the pipeline never blocks on a Python outage.
 *
 * Used by both the inpaint repair (clips the magenta crosshatch to the
 * figure shape) and the blended repair (clips the face blur to the face
 * shape). One source of truth for "fetch a silhouette mask"; future
 * tweaks to colour, alpha, or transport go in one place.
 */
async function fetchSilhouettePng(cropJpegBuffer) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  try {
    const res = await fetch(`${photoAnalyzerUrl}/silhouette-edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: `data:image/jpeg;base64,${cropJpegBuffer.toString('base64')}`,
        color: [255, 255, 255],
        alpha: 255,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const m = j?.image?.match?.(/^data:image\/\w+;base64,(.+)$/);
    if (!j?.success || !m) return null;
    return Buffer.from(m[1], 'base64');
  } catch {
    return null;
  }
}

/**
 * Figure mask for char-repair blend masks — backend-selectable.
 * MODEL_DEFAULTS.figureMaskBackend 'mobilesam' → box-prompted /figure-mask
 * in photo_analyzer (selects ONLY the target figure; won the 2026-07-10
 * mask shootout — docs/research-log.html). Any failure, and every other
 * backend value, falls back to the rembg silhouette (fetchSilhouettePng),
 * which masks every salient figure in the crop.
 */
/**
 * Head mask (face INCLUDING hair) for face repairs. MobileSAM box prompts
 * anchor on the face and segment hair as a separate object — so union TWO
 * prompts: the face box (with face+hair positive points) and a dedicated
 * hair box (upper 55% of the head). Returns a BINARIZED white-on-transparent
 * PNG at outW×outH, or null when no mask is available.
 * maskFetch is injectable so callers with retry policies (Test Lab) reuse
 * this exact logic.
 */
async function fetchFaceHeadMaskPng(cropJpegBuffer, faceBoxInCrop, outW, outH, maskFetch = fetchFigureMaskPng, opts = {}) {
  // opts (all optional — empty = current production behaviour):
  //   rawFaceBox  [x1,y1,x2,y2] the TIGHT DINO face box (unpadded) — dots are
  //               placed on it so the hair dot lands on real hair, not padding.
  //   boxScale    SAM box = boxScale × the raw face box, centered (e.g. 1.5).
  //   singleCall  one SAM call (box + 2 dots), no separate hair box.
  //   onGeom      callback({samBox, hairBox, facePt, hairPt}) for visualization.
  const { rawFaceBox = null, boxScale = null, singleCall = false, faceDotOnly = false, onGeom = null } = opts;
  let samBox = faceBoxInCrop.slice();
  let facePt;
  if (rawFaceBox && rawFaceBox.length === 4) {
    // Dots anchored to the REAL (tight) face box — independent of box sizing.
    const [rx1, ry1, rx2, ry2] = rawFaceBox;
    const cx = (rx1 + rx2) / 2, cy = (ry1 + ry2) / 2;
    const rw = rx2 - rx1, rh = ry2 - ry1;
    if (boxScale) {
      samBox = [Math.max(0, Math.round(cx - rw * boxScale / 2)), Math.max(0, Math.round(cy - rh * boxScale / 2)),
        Math.min(outW, Math.round(cx + rw * boxScale / 2)), Math.min(outH, Math.round(cy + rh * boxScale / 2))];
    }
    facePt = [Math.round(cx), Math.round(ry1 + rh * 0.45)];          // eyes/nose of the real face
  } else {
    facePt = [Math.round((samBox[0] + samBox[2]) / 2), Math.round(samBox[1] + (samBox[3] - samBox[1]) * 0.5)];
  }
  // Hair box = upper part of the head region; hair DOT = its centre nudged 25%
  // toward the face dot (recommended). That keeps the hair dot solidly ON the
  // head (never in the background above it — a positive seed there makes SAM
  // flood the whole background: exp #122 Verena 11.9×/107× balloon).
  const hairBox = [samBox[0], samBox[1], samBox[2], Math.round(samBox[1] + (samBox[3] - samBox[1]) * 0.55)];
  const hbcx = (hairBox[0] + hairBox[2]) / 2, hbcy = (hairBox[1] + hairBox[3]) / 2;
  const hairPt = [Math.round(hbcx + 0.25 * (facePt[0] - hbcx)), Math.round(hbcy + 0.25 * (facePt[1] - hbcy))];
  // faceDotOnly (used for the RESULT/round-2): a single face point, no hair dot
  // and no hair box — just locate the repainted face, minimise flood risk. The
  // over-segmentation salvage falls back to round 1 if this still balloons.
  const points = { points: faceDotOnly ? [facePt] : [facePt, hairPt] };
  if (onGeom) { try { onGeom({ samBox, hairBox: (singleCall || faceDotOnly) ? null : hairBox, facePt, hairPt: faceDotOnly ? null : hairPt }); } catch { /* viz only */ } }
  const calls = [maskFetch(cropJpegBuffer, samBox, points)];
  if (!singleCall && !faceDotOnly) calls.push(maskFetch(cropJpegBuffer, hairBox, {}));
  const masks = await Promise.all(calls);
  if (masks.every(m => !m)) return null;
  const n = outW * outH;
  const decode = async (png) => {
    if (!png) return null;
    const raw = await sharp(png).resize(outW, outH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
    const s = Math.max(1, Math.round(raw.length / n));
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = raw[i * s] > 128 ? 255 : 0;
    return out;
  };
  const decoded = await Promise.all(masks.map(decode));
  const merged = Buffer.alloc(n);
  for (let i = 0; i < n; i++) merged[i] = Math.max(...decoded.map(d => (d ? d[i] : 0)));
  return sharp(Buffer.alloc(n * 3, 255), { raw: { width: outW, height: outH, channels: 3 } })
    .ensureAlpha().joinChannel(merged, { raw: { width: outW, height: outH, channels: 1 } }).png().toBuffer();
}

/**
 * Head mask via the WHOLE FIGURE — robust alternative to segmenting the face
 * directly. SAM segments a whole figure from its body box reliably (it's the
 * detection path, validated 5/5); segmenting a profile/occluded FACE from a
 * box+dots is fragile and over-segments (exp #123 Verena: loose blob on the
 * original, balloon on the repaint, same prompt). So: segment the figure with
 * the body box, then keep only the pixels inside the face box → a clean head
 * silhouette, no dots. bodyBoxInCrop / faceBoxInCrop are [x1,y1,x2,y2] px in
 * the crop. Returns a binarized white-on-transparent PNG, or null.
 */
async function fetchFigureHeadMaskPng(cropJpegBuffer, bodyBoxInCrop, faceBoxInCrop, outW, outH, maskFetch = fetchFigureMaskPng, opts = {}) {
  // clipMode — how the whole-figure mask is clipped to a HEAD:
  //   'facebox'  (default): figure ∩ the face box rectangle. A narrow face box
  //              clips the hair left/right (the figure mask HAS the hair).
  //   'bottom':  keep the figure ABOVE the face-box bottom, no left/right/top
  //              clip → captures ALL the hair; only the neck/body below is cut.
  //   'hairunion': figure ∩ (face box ∪ hairBox) — widen the clip with a hair
  //              box (opts.hairBox [x1,y1,x2,y2]).
  const { onGeom = null, clipMode = 'facebox', hairBox = null, onFullMask = null } = opts;
  const [fx1, fy1, fx2, fy2] = faceBoxInCrop;
  if (onGeom) { try { onGeom({ samBox: bodyBoxInCrop, faceClip: faceBoxInCrop, hairBox: clipMode === 'hairunion' ? hairBox : null, clipMode }); } catch { /* viz only */ } }
  const figPng = await maskFetch(cropJpegBuffer, bodyBoxInCrop, {});
  if (!figPng) return null;
  // Expose the FULL unclipped figure silhouette (before the head clip) so the
  // caller can show it — disconnected SAM islands are visible here, before the
  // connected-component filter drops them.
  if (onFullMask) { try { await onFullMask(figPng); } catch { /* viz only */ } }
  const n = outW * outH;
  const raw = await sharp(figPng).resize(outW, outH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
  const s = Math.max(1, Math.round(raw.length / n));
  const inHair = (x, y) => hairBox && x >= hairBox[0] && x < hairBox[2] && y >= hairBox[1] && y < hairBox[3];
  const inClip = (x, y) => {
    if (clipMode === 'bottom') return y < fy2;                       // only the bottom cut
    if (clipMode === 'hairunion') return (x >= fx1 && x < fx2 && y >= fy1 && y < fy2) || inHair(x, y);
    return x >= fx1 && x < fx2 && y >= fy1 && y < fy2;               // 'facebox'
  };
  const out = Buffer.alloc(n);
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const i = y * outW + x;
    out[i] = (raw[i * s] > 128 && inClip(x, y)) ? 255 : 0;
  }
  return sharp(Buffer.alloc(n * 3, 255), { raw: { width: outW, height: outH, channels: 3 } })
    .ensureAlpha().joinChannel(out, { raw: { width: outW, height: outH, channels: 1 } }).png().toBuffer();
}

// ── Colour-shift correction for the repair blend ────────────────────────────
// The edit model repaints the masked figure but shifts its colour distribution
// (measured: skin ΔL +14..+22, Δb +7..+16 — a lighten + warm push; ΔE 16-28).
// Because only the masked figure is pasted onto the untouched page, that shift
// shows as a colour discontinuity at the paste boundary. `correctColorShift`
// (below) fixes it MATERIAL-AWARE: cluster the region into materials (skin/hair/
// cloth), and shift each pasted pixel by its own material's offset, but ONLY for
// materials that continue outside the paste (a same-material border to match to).
// No pixel outside the mask is touched.
const _LAB_Xn = 0.95047, _LAB_Yn = 1.0, _LAB_Zn = 1.08883;
function _srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function _linearToSrgb(c) { const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(v * 255))); }
function _fLab(t) { return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116); }
function _fInv(t) { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; }
function _rgbToLab(r, g, b) {
  const R = _srgbToLinear(r), G = _srgbToLinear(g), B = _srgbToLinear(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / _LAB_Xn;
  const Y = (0.2126 * R + 0.7152 * G + 0.0722 * B) / _LAB_Yn;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / _LAB_Zn;
  const fx = _fLab(X), fy = _fLab(Y), fz = _fLab(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function _labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = _LAB_Xn * _fInv(fx), Y = _LAB_Yn * _fInv(fy), Z = _LAB_Zn * _fInv(fz);
  return [_linearToSrgb(3.2406 * X - 1.5372 * Y - 0.4986 * Z), _linearToSrgb(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), _linearToSrgb(0.0557 * X - 0.2040 * Y + 1.0570 * Z)];
}
function _deltaE(l1, l2) { return Math.sqrt((l1[0] - l2[0]) ** 2 + (l1[1] - l2[1]) ** 2 + (l1[2] - l2[2]) ** 2); }
function _ccStripMask(buf, n) { const s = Math.max(1, Math.round(buf.length / n)); if (s === 1) return buf; const out = Buffer.alloc(n); for (let i = 0; i < n; i++) out[i] = buf[i * s]; return out; }
function _seamDeltaE(resultRaw, originalRaw, maskBin, w, h) {
  const n = w * h; const isMask = (i) => maskBin[i] > 128;
  const nb = (x, y) => [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]; let sum = 0, cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!isMask(i)) continue;
    let oCnt = 0, sL = 0, sa = 0, sb = 0;
    for (const [nx, ny] of nb(x, y)) { if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx; if (!isMask(j)) { const l = _rgbToLab(originalRaw[j * 3], originalRaw[j * 3 + 1], originalRaw[j * 3 + 2]); oCnt++; sL += l[0]; sa += l[1]; sb += l[2]; } }
    if (!oCnt) continue;
    const r = _rgbToLab(resultRaw[i * 3], resultRaw[i * 3 + 1], resultRaw[i * 3 + 2]); sum += _deltaE(r, [sL / oCnt, sa / oCnt, sb / oCnt]); cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/**
 * Farthest-point-seeded k-means in LAB. pts = Float32Array(m*3). Returns
 * { cent:[[L,a,b]..], counts:[..] }. Cheap (few iters) — used to learn the
 * material palette of a repair region (skin / hair / cloth).
 */
function _ccKMeans(pts, K, iters) {
  const m = pts.length / 3;
  if (m === 0) return { cent: [], counts: [] };
  K = Math.min(K, m);
  const cent = [[pts[0], pts[1], pts[2]]];
  for (let k = 1; k < K; k++) {
    let best = -1, bi = 0;
    for (let i = 0; i < m; i++) {
      let dmin = Infinity;
      for (const c of cent) { const dl = pts[i * 3] - c[0], da = pts[i * 3 + 1] - c[1], db = pts[i * 3 + 2] - c[2]; const d = dl * dl + da * da + db * db; if (d < dmin) dmin = d; }
      if (dmin > best) { best = dmin; bi = i; }
    }
    cent.push([pts[bi * 3], pts[bi * 3 + 1], pts[bi * 3 + 2]]);
  }
  const assign = new Int32Array(m);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < m; i++) {
      let bk = 0, bd = Infinity;
      for (let k = 0; k < cent.length; k++) { const dl = pts[i * 3] - cent[k][0], da = pts[i * 3 + 1] - cent[k][1], db = pts[i * 3 + 2] - cent[k][2]; const d = dl * dl + da * da + db * db; if (d < bd) { bd = d; bk = k; } }
      assign[i] = bk;
    }
    const s = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < m; i++) { const k = assign[i]; s[k][0] += pts[i * 3]; s[k][1] += pts[i * 3 + 1]; s[k][2] += pts[i * 3 + 2]; s[k][3]++; }
    for (let k = 0; k < cent.length; k++) if (s[k][3]) cent[k] = [s[k][0] / s[k][3], s[k][1] / s[k][3], s[k][2] / s[k][3]];
  }
  const counts = cent.map(() => 0);
  for (let i = 0; i < m; i++) counts[assign[i]]++;
  return { cent, counts };
}

/**
 * Border rings of a mask: `inner` = the ringPx band just INSIDE the mask edge,
 * `outer` = the band just OUTSIDE. Used to seam-match a paste — sample the
 * candidate on the inner ring and the original on the outer ring.
 */
function _ccBorderRings(mask, W, H, ringPx) {
  const n = W * H;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = mask[i] > 128 ? 1 : 0;
  const inner = new Uint8Array(n), outer = new Uint8Array(n);
  const anyNb = (band, x, y) => {
    if (x > 0 && band[y * W + x - 1]) return true;
    if (x < W - 1 && band[y * W + x + 1]) return true;
    if (y > 0 && band[(y - 1) * W + x]) return true;
    if (y < H - 1 && band[(y + 1) * W + x]) return true;
    return false;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let edgeIn = false, edgeOut = false;
    const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of nb) { if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (m[i] && !m[j]) edgeIn = true; if (!m[i] && m[j]) edgeOut = true; }
    if (m[i] && edgeIn) inner[i] = 1;
    if (!m[i] && edgeOut) outer[i] = 1;
  }
  for (let it = 1; it < ringPx; it++) {
    const iAdd = [], oAdd = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (m[i] && !inner[i]) { if (anyNb(inner, x, y)) iAdd.push(i); }
      else if (!m[i] && !outer[i]) { if (anyNb(outer, x, y)) oAdd.push(i); }
    }
    for (const i of iAdd) inner[i] = 1;
    for (const i of oAdd) outer[i] = 1;
  }
  return { inner, outer };
}

/**
 * Correct the edit model's colour shift on the masked repair figure, MATERIAL-
 * AWARE. Inputs may be encoded images OR raw RGB (width*height*3). maskAlpha =
 * the union pixels pasted back; opts.refMask = original-side mask to sample the
 * reference tone from (default maskAlpha). Learns K material colours from the
 * original reference region and shifts each candidate pixel by its own material's
 * offset (soft colour-weighted blend), so a cloth band inside a face mask matches
 * the original dress instead of getting the face's skin-tuned shift. With
 * garmentOnly (default) only materials that continue OUTSIDE the paste (a
 * same-material border to match to) are shifted; skin/hair with no continuation
 * keep the model's rendering. Returns { applied, correctedRaw (RGB), deltaEBefore,
 * seamDeltaEBefore/After, clusterInfo }.
 */
async function correctColorShift(originalCropBuf, candidateCropBuf, maskAlpha, width, height, opts = {}) {
  const { strength = 0.9, refMask = null, clusters = 3, sigmaScale = 0.6, maxOffsetDeltaE = 30, borderRefine = true, garmentOnly = true } = opts;
  const n = width * height;
  const toRaw = async (buf) => (Buffer.isBuffer(buf) && buf.length === n * 3) ? buf : sharp(buf).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const O = await toRaw(originalCropBuf);
  const C = await toRaw(candidateCropBuf);
  const mCand = _ccStripMask(maskAlpha, n);
  const mRef = refMask ? _ccStripMask(refMask, n) : mCand;
  const mo = [0, 0, 0], mc = [0, 0, 0]; let cnt = 0;
  const candLab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (mCand[i] > 128) {
      const lab = _rgbToLab(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]);
      candLab[i * 3] = lab[0]; candLab[i * 3 + 1] = lab[1]; candLab[i * 3 + 2] = lab[2];
      const olab = _rgbToLab(O[i * 3], O[i * 3 + 1], O[i * 3 + 2]);
      for (let ch = 0; ch < 3; ch++) { mo[ch] += olab[ch]; mc[ch] += lab[ch]; }
      cnt++;
    }
  }
  if (!cnt) return { applied: false, reason: 'empty mask', correctedRaw: Buffer.from(C) };
  for (let ch = 0; ch < 3; ch++) { mo[ch] /= cnt; mc[ch] /= cnt; }
  const deltaEBefore = _deltaE(mo, mc);
  const out = Buffer.from(C);
  let clusterInfo = null;
  {
    // 1. Learn the scene palette from the ORIGINAL reference region.
    const refPts = [];
    for (let i = 0; i < n; i++) if (mRef[i] > 128) { const l = _rgbToLab(O[i * 3], O[i * 3 + 1], O[i * 3 + 2]); refPts.push(l[0], l[1], l[2]); }
    const { cent, counts } = _ccKMeans(Float32Array.from(refPts), clusters, 8);
    const totalRef = counts.reduce((a, b) => a + b, 0) || 1;
    const keep = cent.map((_, k) => counts[k] >= 0.03 * totalRef);
    // 2. Candidate per-cluster means — assign each pasted pixel by ITS colour.
    const cs = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      if (mCand[i] <= 128) continue;
      const lab = [candLab[i * 3], candLab[i * 3 + 1], candLab[i * 3 + 2]];
      let bk = -1, bd = Infinity;
      for (let k = 0; k < cent.length; k++) { if (!keep[k]) continue; const dl = lab[0] - cent[k][0], da = lab[1] - cent[k][1], db = lab[2] - cent[k][2]; const d = dl * dl + da * da + db * db; if (d < bd) { bd = d; bk = k; } }
      if (bk >= 0) { cs[bk][0] += lab[0]; cs[bk][1] += lab[1]; cs[bk][2] += lab[2]; cs[bk][3]++; }
    }
    // 3. Per-material offset. Prefer the OLD/NEW BORDER: shift each material so
    //    the candidate on the inner ring matches the original on the outer ring
    //    → the seam between paste and surroundings is zero. Where a material has
    //    no same-material neighbour outside (hair/skin against background), fall
    //    back to the whole-region mean (tone match to scene).
    const nearestKept = (lab) => { let bk = -1, bd = Infinity; for (let k = 0; k < cent.length; k++) { if (!keep[k]) continue; const dl = lab[0] - cent[k][0], da = lab[1] - cent[k][1], db = lab[2] - cent[k][2]; const d = dl * dl + da * da + db * db; if (d < bd) { bd = d; bk = k; } } return [bk, bd]; };
    const { inner, outer } = _ccBorderRings(mCand, width, height, 5);
    // SAME-MATERIAL border only: match blue coat to blue coat, never to the white/
    // blue-shadow snow it sits in. A loose gate let snow-shadow (~15-25 ΔE from the
    // coat) into the coat's outer ring and dragged the whole coat darker. So (1) build
    // a BACKGROUND palette from outer pixels far from every figure material, then
    // (2) keep an outer pixel for material k only if it is within a tight same-material
    // ΔE of k AND closer to k than to any background colour. If a material has no true
    // same-material neighbour outside, it falls back to the region mean below.
    const SAME2 = 6 * 6;    // NARROW: outer pixel must be within ~6 ΔE of the figure material.
    const FARBG = 12 * 12;  // outer pixel this far from every figure material = background
    const bIn = cent.map(() => [0, 0, 0, 0]);   // candidate, inner ring, per material
    const bOut = cent.map(() => [0, 0, 0, 0]);  // original, outer ring — SAME material only
    const outerLab = [];
    for (let i = 0; i < n; i++) {
      if (inner[i]) { const lab = [candLab[i * 3], candLab[i * 3 + 1], candLab[i * 3 + 2]]; const [bk] = nearestKept(lab); if (bk >= 0) { bIn[bk][0] += lab[0]; bIn[bk][1] += lab[1]; bIn[bk][2] += lab[2]; bIn[bk][3]++; } }
      if (outer[i]) outerLab.push(_rgbToLab(O[i * 3], O[i * 3 + 1], O[i * 3 + 2]));
    }
    const bgPts = [];
    for (const l of outerLab) { const [, bd] = nearestKept(l); if (bd > FARBG) bgPts.push(l[0], l[1], l[2]); }
    const bgCent = bgPts.length >= 90 ? _ccKMeans(Float32Array.from(bgPts), 3, 6).cent : [];
    const nearestBg = (l) => { let bd = Infinity; for (const c of bgCent) { const dl = l[0] - c[0], da = l[1] - c[1], db = l[2] - c[2]; const d = dl * dl + da * da + db * db; if (d < bd) bd = d; } return bd; };
    for (const l of outerLab) { const [bk, bd] = nearestKept(l); if (bk >= 0 && bd < SAME2 && (!bgCent.length || bd < nearestBg(l))) { bOut[bk][0] += l[0]; bOut[bk][1] += l[1]; bOut[bk][2] += l[2]; bOut[bk][3]++; } }
    const MINB = 20;
    // BASE: region mean-match per material (cluster the colour in BOTH images, shift
    // candidate mean → original mean). Reliable, uses the whole region.
    const meanOffK = cent.map((c, k) => (keep[k] && cs[k][3]) ? [c[0] - cs[k][0] / cs[k][3], c[1] - cs[k][1] / cs[k][3], c[2] - cs[k][2] / cs[k][3]] : [0, 0, 0]);
    const hasBorder = cent.map((_, k) => borderRefine && keep[k] && bIn[k][3] >= MINB && bOut[k][3] >= MINB);
    // REFINE: the border is a SEAM-CLOSER on top of the mean, never a second bulk
    // shift. Cap it to a small fraction of the mean move (+0.5 ΔE floor): if the
    // border wants to move MORE than ~20% of the mean, the inner/outer rings are
    // straddling the material's natural lightness gradient (top-of-clip in shadow
    // vs lower coat lit) — a gradient, not a tone error — so we clamp it hard.
    const offK = cent.map((c, k) => {
      if (!keep[k]) return [0, 0, 0];
      const m = meanOffK[k];
      // garmentOnly (default): only materials that CONTINUE OUTSIDE the paste (a
      // same-material border — the shirt/coat below the neck clip) are colour-matched.
      // Skin/hair have no same-material neighbour outside, so they get ZERO shift and
      // keep Grok's rendering (a skin/hair colour shift is fine, even intentional). The
      // old behaviour region-mean-matched them too, which tinted skin — switch off.
      if (!hasBorder[k]) return garmentOnly ? [0, 0, 0] : m;
      const r = [bOut[k][0] / bOut[k][3] - (bIn[k][0] / bIn[k][3] + m[0]), bOut[k][1] / bOut[k][3] - (bIn[k][1] / bIn[k][3] + m[1]), bOut[k][2] / bOut[k][3] - (bIn[k][2] / bIn[k][3] + m[2])];
      const cap = Math.max(0.5, 0.2 * Math.hypot(m[0], m[1], m[2])); // ≤20% of the mean move
      const rm = Math.hypot(r[0], r[1], r[2]); if (rm > cap) { const s = cap / rm; r[0] *= s; r[1] *= s; r[2] *= s; }
      return [m[0] + r[0], m[1] + r[1], m[2] + r[2]];
    });
    for (const o of offK) { const mag = Math.hypot(o[0], o[1], o[2]); if (mag > maxOffsetDeltaE) { const s = maxOffsetDeltaE / mag; o[0] *= s; o[1] *= s; o[2] *= s; } }
    // Cloth with a real same-material border gets the full offset (exact join); face/
    // hair (mean-only tone match to scene) keep the gentle nudge so they aren't slammed.
    const sK = cent.map((_, k) => hasBorder[k] ? 1 : strength);
    // 4. sigma from the spread of kept centroids → soft colour-weighted blend.
    const kc = cent.filter((_, k) => keep[k]); const dd = [];
    for (let a = 0; a < kc.length; a++) for (let b = a + 1; b < kc.length; b++) dd.push(Math.hypot(kc[a][0] - kc[b][0], kc[a][1] - kc[b][1], kc[a][2] - kc[b][2]));
    dd.sort((x, y) => x - y);
    const sigma = Math.max(6, sigmaScale * (dd.length ? dd[Math.floor(dd.length / 2)] : 20));
    for (let i = 0; i < n; i++) {
      if (mCand[i] <= 128) continue;
      const lab = [candLab[i * 3], candLab[i * 3 + 1], candLab[i * 3 + 2]];
      let wsum = 0; const woff = [0, 0, 0];
      for (let k = 0; k < cent.length; k++) { if (!keep[k]) continue; const dl = lab[0] - cent[k][0], da = lab[1] - cent[k][1], db = lab[2] - cent[k][2]; const w = Math.exp(-(dl * dl + da * da + db * db) / (2 * sigma * sigma)); wsum += w; woff[0] += w * sK[k] * offK[k][0]; woff[1] += w * sK[k] * offK[k][1]; woff[2] += w * sK[k] * offK[k][2]; }
      if (wsum > 0) { woff[0] /= wsum; woff[1] /= wsum; woff[2] /= wsum; }
      const rgb = _labToRgb(lab[0] + woff[0], lab[1] + woff[1], lab[2] + woff[2]);
      out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
    }
    clusterInfo = cent.map((c, k) => keep[k] ? { lab: c.map(v => +v.toFixed(1)), count: counts[k], off: offK[k].map(v => +v.toFixed(1)), mean: meanOffK[k].map(v => +v.toFixed(1)), src: hasBorder[k] ? 'mean+border' : 'mean' } : null).filter(Boolean);
  }
  // seamDeltaE is a diagnostic on the corrected paste's border vs the neighbouring
  // page (before === after: the figure seam is closed by the paste itself, not a
  // separate harmonic diffusion — that pass was removed as it altered the face).
  const maskBin = Buffer.alloc(n);
  for (let i = 0; i < n; i++) maskBin[i] = mCand[i] > 128 ? 255 : 0;
  const seamBefore = _seamDeltaE(out, O, maskBin, width, height);
  return { applied: true, deltaEBefore: +deltaEBefore.toFixed(2), seamDeltaEBefore: +seamBefore.toFixed(2), seamDeltaEAfter: +seamBefore.toFixed(2), correctedRaw: out, clusterInfo };
}

async function fetchFigureMaskPng(cropJpegBuffer, boxInCrop, opts = {}) {
  const backend = CONFIG_DEFAULTS.figureMaskBackend || 'rembg';
  if (backend === 'mobilesam' && Array.isArray(boxInCrop) && boxInCrop.length === 4) {
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
    try {
      const res = await withAnalyzerSlot(() => fetch(`${photoAnalyzerUrl}/figure-mask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: `data:image/jpeg;base64,${cropJpegBuffer.toString('base64')}`,
          box: boxInCrop,
          // Optional positive point prompts ([x,y] pairs) — face repairs pass
          // a hair point so SAM includes the hair, not just the face.
          ...(Array.isArray(opts.points) && opts.points.length ? { points: opts.points, point_labels: opts.pointLabels || opts.points.map(() => 1) } : {}),
          color: [255, 255, 255],
          alpha: 255,
        }),
        // 150s: an aborted request does NOT cancel the analyzer's computation —
        // short timeouts under CPU contention stack zombie work until the
        // service starves (observed SAM outage: 12 consecutive 30s aborts).
        signal: AbortSignal.timeout(150_000),
      }));
      if (res.ok) {
        const j = await res.json();
        const m = j?.image?.match?.(/^data:image\/\w+;base64,(.+)$/);
        if (j?.success && m && j.fill_pixels > 0) {
          log.info(`👤 [FIGURE MASK] mobilesam mask, ${j.fill_pixels}px filled`);
          return Buffer.from(m[1], 'base64');
        }
        log.warn(`⚠️ [FIGURE MASK] mobilesam returned ${j?.success ? 'an empty mask' : `no mask (${j?.error || 'unknown'})`} — falling back to rembg`);
      } else {
        log.warn(`⚠️ [FIGURE MASK] /figure-mask HTTP ${res.status} — falling back to rembg`);
      }
    } catch (err) {
      log.warn(`⚠️ [FIGURE MASK] mobilesam failed (${err.message}) — ${opts.requireMobilesam ? 'no fallback (caller requires SAM)' : 'falling back to rembg'}`);
    }
  }
  // Face repairs REQUIRE the box-prompted SAM head mask: rembg's whole-figure
  // salient mask whited a rectangle over a church tower instead of the head
  // (all-5 chain during a SAM outage) — for those callers a null (retry/fail
  // loudly upstream) beats a garbage mask.
  if (opts.requireMobilesam) return null;
  return fetchSilhouettePng(cropJpegBuffer);
}

/**
 * Resize a Grok edit-API output buffer to the source scene's exact dims.
 * Handles aspect-ratio mismatches: Grok sometimes returns the closest preset
 * (e.g. 1024×1024 for a 3:4 ask). Same aspect → proportional `fit:fill`
 * (no distortion). Different aspect → centred cover-crop. Used by both the
 * blended and inpaint repair branches; keeping it in one place stops the
 * two branches drifting on aspect-handling logic.
 */
async function resizeGrokToSceneDims(grokBuffer, sceneWidth, sceneHeight) {
  const grokMeta = await sharp(grokBuffer).metadata();
  if (grokMeta.width === sceneWidth && grokMeta.height === sceneHeight) {
    return grokBuffer;
  }
  const grokAspect = grokMeta.width / grokMeta.height;
  const sceneAspect = sceneWidth / sceneHeight;
  const aspectMatches = Math.abs(grokAspect - sceneAspect) / sceneAspect < 0.02;
  log.warn(`⚠️ [CHAR REPAIR GROK] Grok returned ${grokMeta.width}x${grokMeta.height} (aspect ${grokAspect.toFixed(3)}), scene ${sceneWidth}x${sceneHeight} (aspect ${sceneAspect.toFixed(3)}), aspect ${aspectMatches ? 'matches' : 'MISMATCH'} — ${aspectMatches ? 'proportional resize' : 'cover-crop to recover'}`);
  if (aspectMatches) {
    return sharp(grokBuffer).resize(sceneWidth, sceneHeight, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
  }
  return sharp(grokBuffer)
    .resize(sceneWidth, sceneHeight, { fit: 'cover', position: 'center' })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/**
 * Round-trip a full-scene buffer through Grok's edit endpoint WITHOUT scale
 * drift. Grok only returns preset aspect ratios; when the scene's own aspect
 * sits between presets (square-book pages, some covers), resizing the output
 * back cover-crops — a uniform scale+shift misregistration that scene-space
 * blend masks can't tolerate, and that the translation-only registration
 * guard correctly refuses to "fix". Instead: mirror-pad the scene to EXACTLY
 * the closest preset before the call and unpad afterwards — every original
 * pixel returns to its original coordinates by construction.
 *
 * @param {string} prompt
 * @param {string[]} referenceUris - data URIs placed BEFORE the scene slot
 * @param {Buffer} sceneBuf - the (whited-out / hatched) scene to edit
 * @param {number} sceneW  @param {number} sceneH
 * @param {object} [opts]  - encode: 'jpeg'|'png' for the padded scene (png
 *                           keeps hatch/whiteout edges crisp), plus any
 *                           editWithGrok passthrough options.
 * @returns {Promise<{buffer: Buffer|null, grokResult: object, aspectStr: string}>}
 *          buffer is at exactly sceneW×sceneH.
 */
async function grokEditSceneExact(prompt, referenceUris, sceneBuf, sceneW, sceneH, opts = {}) {
  const { encode = 'jpeg', ...grokOptions } = opts;
  const aspectStr = closestGrokAspect(sceneW, sceneH);
  const [aw, ah] = aspectStr.split(':').map(Number);
  const target = aw / ah;
  const current = sceneW / sceneH;
  let padLeft = 0, padRight = 0, padTop = 0, padBottom = 0;
  if (current < target - 1e-6) {
    const targetW = Math.round(sceneH * target);
    padLeft = Math.floor((targetW - sceneW) / 2);
    padRight = targetW - sceneW - padLeft;
  } else if (current > target + 1e-6) {
    const targetH = Math.round(sceneW / target);
    padTop = Math.floor((targetH - sceneH) / 2);
    padBottom = targetH - sceneH - padTop;
  }
  const changed = (padLeft + padRight + padTop + padBottom) > 0;
  const paddedW = sceneW + padLeft + padRight;
  const paddedH = sceneH + padTop + padBottom;
  let paddedBuf = sceneBuf;
  if (changed) {
    const pipeline = sharp(sceneBuf).extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, extendWith: 'mirror' });
    paddedBuf = encode === 'png'
      ? await pipeline.png().toBuffer()
      : await pipeline.jpeg({ quality: 92 }).toBuffer();
    log.info(`📐 [CHAR REPAIR GROK] Scene ${sceneW}x${sceneH} mirror-padded to ${paddedW}x${paddedH} (preset ${aspectStr}) — exact-aspect round-trip`);
  }
  const mime = encode === 'png' ? 'image/png' : 'image/jpeg';
  const sceneUri = `data:${mime};base64,${paddedBuf.toString('base64')}`;
  const grokResult = await editWithGrok(prompt, [...referenceUris, sceneUri], { aspectRatio: aspectStr, skipOutputPadding: true, ...grokOptions });
  if (!grokResult.imageData) return { buffer: null, grokResult, aspectStr };
  // Same-aspect proportional resize (no crop), then strip the padding.
  let out = Buffer.from(r2Lib.stripDataUriPrefix(grokResult.imageData), 'base64');
  out = await resizeGrokToSceneDims(out, paddedW, paddedH);
  if (changed) {
    out = await sharp(out).extract({ left: padLeft, top: padTop, width: sceneW, height: sceneH }).jpeg({ quality: 95 }).toBuffer();
  }
  return { buffer: out, grokResult, aspectStr };
}


// Build action context from structured interactions[] for the named character.
// Replaces the prose-name-slicing fallback that leaked the metadata JSON block
// and other characters' clauses into per-character inpaint prompts.
function buildCharActionContextFromInteractions(sceneDescription, charName) {
  if (!sceneDescription || !charName) return '';
  try {
    const meta = require('./storyHelpers').extractSceneMetadata(sceneDescription);
    const interactions = meta?.fullData?.interactions || [];
    const lower = charName.toLowerCase();
    const lines = interactions
      .filter(i => i?.character && i.character.toLowerCase() === lower)
      .map(i => `- ${String(i.where || '').trim()} ${String(i.object || '').trim()}`.replace(/\s+/g, ' ').trim())
      .filter(l => l.length > 2);
    if (lines.length === 0) return '';
    return `\n\n${charName} in this scene:\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * Strip cross-image-comparison vocabulary from an issue description before
 * embedding it in an inpaint prompt. Entity-consistency findings are written
 * against a labelled comparison grid ("cells A, D, E, and F", "the reference
 * (R)") that the inpaint model never sees — to Grok those phrases are noise.
 * Also collapses label-concatenation slips ("costume costume").
 */
function sanitizeIssueForInpaint(text) {
  if (!text) return text;
  let out = String(text);
  const CELL_LIST = String.raw`[A-H](?:\s*,\s*[A-H])*(?:\s*,?\s*(?:and|&)\s*[A-H])?`;
  out = out.replace(new RegExp(String.raw`\b(?:in|across|on)\s+cells?\s+${CELL_LIST}\b`, 'gi'), '');
  out = out.replace(new RegExp(String.raw`\bcells?\s+${CELL_LIST}\b`, 'gi'), '');
  out = out.replace(/\bthe reference(?:\s+photo)?\s*\(\s*R\s*\)/gi, 'the reference');
  out = out.replace(/\(\s*R\s*\)/g, '');
  out = out.replace(/\b(\w+)['’]?\s+\1\b/gi, '$1');
  out = out.replace(/\s+(?:and|&)\s*([,.;])/gi, '$1');
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/,\s*,/g, ',').trim();
  return out;
}



/**
 * Edge energy (Laplacian variance) of a region — the standard blur metric.
 * Used to reject repairs whose figure came back soft: the blended repair
 * signals "redraw this" with a blur, and diffusion editors sometimes enhance
 * the blur instead of replacing it (the known failure that gave the cutout
 * path its crosshatch). Comparing repaired vs original edge energy in the
 * figure bbox catches that deterministically.
 */
async function measureRegionSharpness(imageBuffer, rect) {
  const { data, info } = await sharp(imageBuffer)
    .extract(rect)
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) { const v = data[i]; sum += v; sumSq += v * v; }
  return sumSq / n - (sum / n) ** 2;
}

module.exports = {
  computePresetAlignedExtract,
  // Lab/sRGB primitives — samBlend.js does its own colour work with these.
  _rgbToLab,
  _labToRgb,
  _deltaE,
  _ccKMeans,
  detectGrokBorder,
  fetchSilhouettePng,
  fetchFaceHeadMaskPng,
  fetchFigureHeadMaskPng,
  fetchFigureMaskPng,
  correctColorShift,
  resizeGrokToSceneDims,
  grokEditSceneExact,
  buildCharActionContextFromInteractions,
  sanitizeIssueForInpaint,
  measureRegionSharpness,
};
