/**
 * Filled page background for the printed single layout (decisions.md, "Print page
 * strip filled by a mirrored, blurred picture", 2026-10-26).
 *
 * The single layout puts the scene picture on top and the text in a strip below. That
 * strip used to be plain white. It is now the lower half of the picture, flipped
 * vertically, squeezed into the strip, blurred and lightened, with the seam to the
 * picture feathered. The text sits on a small translucent white board whose opacity
 * is raised in 5% steps until the text zone is bright enough to read dark text on.
 *
 * One raster comes out (picture + fill + board); pdf.js draws it full-bleed and sets
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
const BOARD_PAD = 16;
const BOARD_FEATHER = 25;
const BOARD_RADIUS = 20;
const BOARD_OPACITY_START = 0.70;
const BOARD_OPACITY_STEP = 0.05;
const BOARD_OPACITY_MAX = 1.0;
const TARGET_LUMINANCE = 0.80;    // mean luminance under the text box
const JPEG_QUALITY = 92;

const smooth = (t) => t * t * (3 - 2 * t);
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * @param {Object} p
 * @param {Buffer} p.imageBuffer       scene picture (any format sharp reads)
 * @param {number} p.pageWidthPx       full page raster width
 * @param {number} p.pageHeightPx      full page raster height
 * @param {number} p.imageHeightPx     height the picture occupies at the top; the rest is the strip
 * @param {{x:number,y:number,w:number,h:number}} p.textBox  rendered text block, px, page coordinates
 * @returns {Promise<{buffer: Buffer, boardOpacity: number, textZoneLuminance: number|null}>}
 *   buffer is a JPEG of the whole page. boardOpacity is 0 and textZoneLuminance null when the text box is empty.
 */
async function buildFilledPageBackground({ imageBuffer, pageWidthPx, pageHeightPx, imageHeightPx, textBox }) {
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

  // 5. Text board.
  let boardOpacity = 0;
  let textZoneLuminance = null;
  const bx0 = Math.max(0, Math.floor(textBox.x));
  const by0 = Math.max(0, Math.floor(textBox.y));
  const bx1 = Math.min(W, Math.ceil(textBox.x + textBox.w));
  const by1 = Math.min(H, Math.ceil(textBox.y + textBox.h));
  if (bx1 > bx0 && by1 > by0) {
    const pad = BOARD_PAD * u;
    const feather = BOARD_FEATHER * u;
    const radius = BOARD_RADIUS * u;
    const margin = Math.ceil(pad + feather * 1.5);
    const rx0 = Math.max(0, bx0 - margin);
    const ry0 = Math.max(0, by0 - margin);
    const rx1 = Math.min(W, bx1 + margin);
    const ry1 = Math.min(H, by1 + margin);
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;

    // Soft rounded rectangle, rendered small and scaled up (the mask is smooth).
    const lw = Math.max(2, Math.round(rw * ws));
    const lh = Math.max(2, Math.round(rh * ws));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw}" height="${lh}">`
      + `<rect width="${lw}" height="${lh}" fill="black"/>`
      + `<rect x="${(bx0 - pad - rx0) * ws}" y="${(by0 - pad - ry0) * ws}" `
      + `width="${(bx1 - bx0 + 2 * pad) * ws}" height="${(by1 - by0 + 2 * pad) * ws}" `
      + `rx="${radius * ws}" fill="white"/></svg>`;
    const maskLow = await sharp(Buffer.from(svg))
      .blur(Math.max(0.3, (feather / 2) * ws))
      .removeAlpha()
      .extractChannel(0)
      .raw()
      .toBuffer();
    const mask = await sharp(maskLow, { raw: { width: lw, height: lh, channels: 1 } })
      .resize(rw, rh, { fit: 'fill', kernel: 'cubic' })
      .extractChannel(0) // resize returns 3 channels for a 1-channel raw input
      .raw()
      .toBuffer();

    // Sample the text box (every few px), raise the opacity until it is bright enough.
    const st = Math.max(1, Math.round(u));
    const baseL = [];
    const maskK = [];
    for (let y = by0; y < by1; y += st) {
      for (let x = bx0; x < bx1; x += st) {
        const o = (y * W + x) * 3;
        baseL.push(luma(page[o], page[o + 1], page[o + 2]));
        maskK.push(mask[(y - ry0) * rw + (x - rx0)] / 255);
      }
    }
    const meanAt = (a) => {
      let s = 0;
      for (let i = 0; i < baseL.length; i++) { const k = maskK[i] * a; s += baseL[i] * (1 - k) + k; }
      return s / baseL.length;
    };
    boardOpacity = BOARD_OPACITY_START;
    textZoneLuminance = meanAt(boardOpacity);
    while (textZoneLuminance < TARGET_LUMINANCE && boardOpacity < BOARD_OPACITY_MAX - 1e-9) {
      boardOpacity = Math.min(BOARD_OPACITY_MAX, Math.round((boardOpacity + BOARD_OPACITY_STEP) * 100) / 100);
      textZoneLuminance = meanAt(boardOpacity);
    }

    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const k = mask[y * rw + x] / 255 * boardOpacity;
        if (k <= 0) continue;
        const o = ((ry0 + y) * W + rx0 + x) * 3;
        page[o] = Math.round(page[o] * (1 - k) + 255 * k);
        page[o + 1] = Math.round(page[o + 1] * (1 - k) + 255 * k);
        page[o + 2] = Math.round(page[o + 2] * (1 - k) + 255 * k);
      }
    }
  }

  const buffer = await sharp(page, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { buffer, boardOpacity, textZoneLuminance };
}

module.exports = { buildFilledPageBackground };
