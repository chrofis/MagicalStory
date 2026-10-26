/**
 * Filled page background for the printed single layout (decisions.md, "Print page
 * strip filled by a mirrored, blurred picture", 2026-10-26).
 *
 * The single layout puts the scene picture on top and the text in a strip below. That
 * strip used to be plain white. It is now the lower half of the picture, flipped
 * vertically, squeezed into the strip, blurred and lightened, with the seam to the
 * picture feathered. Nothing else is drawn on it: the text gets a thin white outline in
 * pdf.js instead (the owner rejected a text board, it looked like a pale box).
 *
 * One raster comes out (picture + fill); pdf.js draws it full-bleed and sets
 * the text over it as vector text. No fallback: a failure throws.
 *
 * All sizes below are in "reference pixels" of an 850 px wide page (the width the
 * prototype rounds were judged at) and scale with the real page width.
 */

const sharp = require('sharp');

const REF_WIDTH = 850;
const FILL_BLUR_SIGMA = 22;
const FILL_LIGHTEN = 0.35;        // uniform lighten towards white
const FILL_LIGHTEN_RAMP = 0.12;   // share of the strip over which the lighten fades in
const SEAM_FEATHER = 30;          // rows of the picture blended into the fill
const SEAM_STRENGTH = 0.9;
const JPEG_QUALITY = 92;

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * @param {Object} p
 * @param {Buffer} p.imageBuffer       scene picture (any format sharp reads)
 * @param {number} p.pageWidthPx       full page raster width
 * @param {number} p.pageHeightPx      full page raster height
 * @param {number} p.imageHeightPx     height the picture occupies at the top; the rest is the strip
 * @returns {Promise<{buffer: Buffer}>} buffer is a JPEG of the whole page
 */
async function buildFilledPageBackground({ imageBuffer, pageWidthPx, pageHeightPx, imageHeightPx }) {
  const W = Math.round(pageWidthPx);
  const H = Math.round(pageHeightPx);
  const IH = Math.round(imageHeightPx);
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new Error('pageFill: imageBuffer missing');
  if (!(W > 0 && H > 0)) throw new Error('pageFill: bad page size');
  const EXTH = H - IH;
  if (!(IH >= 2 && EXTH >= 2)) throw new Error(`pageFill: image height ${IH} leaves no strip in a ${H}px page`);

  const u = W / REF_WIDTH;                 // reference px -> real px
  const ws = Math.min(1, REF_WIDTH / W);   // working scale for the heavy blur

  // 1. Picture, scale-to-cover pinned to the top edge (same crop as drawImageCovering).
  const img = await sharp(imageBuffer)
    .resize(W, IH, { fit: 'cover', position: 'top' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer();

  // 2. Fill: bottom half of the picture, flipped, squeezed into the strip, blurred (at working size).
  const n = Math.max(1, Math.min(IH, Math.round(IH / 2)));
  const Ww = Math.max(2, Math.round(W * ws));
  const EXTHw = Math.max(2, Math.round(EXTH * ws));
  const rawLow = await sharp(img, { raw: { width: W, height: IH, channels: 3 } })
    .extract({ left: 0, top: IH - n, width: W, height: n })
    .resize(Ww, EXTHw, { fit: 'fill' })
    .flip()
    .blur(Math.max(0.3, FILL_BLUR_SIGMA * Ww / REF_WIDTH))
    .raw()
    .toBuffer();

  // Unlightened first row = what the picture's feathered bottom rows melt into.
  const seamRow = await sharp(rawLow.subarray(0, Ww * 3), { raw: { width: Ww, height: 1, channels: 3 } })
    .resize(W, 1, { fit: 'fill' })
    .raw()
    .toBuffer();

  const lightLow = Buffer.from(rawLow);
  for (let y = 0; y < EXTHw; y++) {
    const t = EXTHw > 1 ? y / (EXTHw - 1) : 1;
    const l = FILL_LIGHTEN * smooth(Math.min(1, t / FILL_LIGHTEN_RAMP));
    for (let i = y * Ww * 3, e = i + Ww * 3; i < e; i++) lightLow[i] = Math.round(rawLow[i] * (1 - l) + 255 * l);
  }
  const ext = await sharp(lightLow, { raw: { width: Ww, height: EXTHw, channels: 3 } })
    .resize(W, EXTH, { fit: 'fill' })
    .raw()
    .toBuffer();

  // 3. Page = picture on top, fill below.
  const page = Buffer.allocUnsafe(W * H * 3);
  img.copy(page, 0);
  ext.copy(page, W * IH * 3);

  // 4. Feathered seam: the picture's last rows melt into the fill.
  const F = Math.min(Math.round(SEAM_FEATHER * u), IH - 1);
  for (let y = IH - F; y < IH; y++) {
    const a = smooth((y - (IH - F)) / F) * SEAM_STRENGTH;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const s = x * 3;
      page[o] = Math.round(page[o] * (1 - a) + seamRow[s] * a);
      page[o + 1] = Math.round(page[o + 1] * (1 - a) + seamRow[s + 1] * a);
      page[o + 2] = Math.round(page[o + 2] * (1 - a) + seamRow[s + 2] * a);
    }
  }

  const buffer = await sharp(page, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { buffer };
}

module.exports = { buildFilledPageBackground };
