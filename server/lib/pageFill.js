/**
 * Filled page background for the printed single layout (decisions.md, "Print page
 * strip filled by a mirrored, blurred picture", 2026-10-26).
 *
 * The single layout puts the scene picture on one edge of the page and the text in a strip on
 * the other (textRegion.chooseStripEdge, decisions.md 2026-10-27). That strip used to be plain
 * white. At the BOTTOM edge it is the picture's lower half, flipped vertically, squeezed into the
 * strip, blurred and lightened, with the seam to the picture feathered. At the TOP edge it is the
 * picture's outermost rows stretched to the band height and blurred, with no lightening and no
 * feathering: the same colour as the sky or wall it continues. Nothing else is drawn on it: the text gets a thin white outline in
 * pdf.js instead (the owner rejected a text board, it looked like a pale box).
 *
 * One raster comes out (picture + fill); pdf.js draws it full-bleed and sets
 * the text over it as vector text. No fallback: a failure throws.
 *
 * All sizes below are in "reference pixels" of an 850 px wide page (the width the
 * prototype rounds were judged at) and scale with the real page width.
 */

const sharp = require('sharp');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

const FILL_METHODS = ['mirror', 'grok'];
// Grok edit returns the aspect of the picture it is given; the page canvas is snapped to the
// nearest ratio xAI documents, then the answer is stretched back to the page size.
const GROK_ASPECTS = [['1:1', 1], ['3:4', 3 / 4], ['4:3', 4 / 3], ['2:3', 2 / 3], ['3:2', 3 / 2], ['9:16', 9 / 16], ['16:9', 16 / 9]];
const GROK_HINT_WIDTH = 1536;    // width of the canvas sent to Grok; 850 (the prototype width) came back at 850 px and blurred the 300 dpi strip
const GROK_FILL_MODEL = 'grok-imagine-image';   // USD 0.02 per call
const GROK_FEATHER = 30;          // reference px: picture melts into the model's strip

const REF_WIDTH = 850;
const FILL_BLUR_SIGMA = 22;
const TOP_BAND_SHARE = 0.05;      // top edge: share of the picture's outermost rows stretched into the band
const TOP_BLUR_SIGMA = 16;
const FILL_LIGHTEN = 0.35;        // uniform lighten towards white
const FILL_LIGHTEN_RAMP = 0.12;   // share of the strip over which the lighten fades in
const SEAM_FEATHER = 30;          // rows of the picture blended into the fill
const SEAM_STRENGTH = 0.9;
const JPEG_QUALITY = 92;

const smooth = (t) => t * t * (3 - 2 * t);
const STRIP_EDGES = ['top', 'bottom', 'sides'];
const OUTPAINT_DIRECTION = {
  top: 'upward into the empty upper band',
  bottom: 'downward into the empty lower band',
  sides: 'sideways into the empty left and right bands',
};

// A raw RGB page flipped top-to-bottom (the 'top' edge is built as a 'bottom' page, then flipped).
const flipRows = (buf, w, h) => sharp(buf, { raw: { width: w, height: h, channels: 3 } }).flip().raw().toBuffer();

/**
 * @param {Object} p
 * @param {Buffer} p.imageBuffer       scene picture (any format sharp reads)
 * @param {number} p.pageWidthPx       full page raster width
 * @param {number} p.pageHeightPx      full page raster height
 * @param {number} p.imageHeightPx     height the picture occupies; the rest is the strip
 * @param {'top'|'bottom'|'sides'} [p.edge='bottom']  where the STRIP goes. 'sides': a portrait picture on a
 *   squarer page (covers, dedication): the WHOLE picture is fitted by height and centred, nothing is cropped, and
 *   a band on each side is filled (outermost columns stretched and blurred, or outpainted by Grok); imageHeightPx
 *   is ignored (see buildSidesFilledPage). 'bottom': picture pinned to the top,
 *   fill below (mirror, blur, eased lighten, feathered seam). 'top': picture pinned to the bottom, fill above
 *   (top TOP_BAND_SHARE rows stretched, blurred, no lighten, no feather). One code path: everything is built as
 *   a bottom-strip page and flipped at the raster boundaries (output, and the Grok canvas / answer, which the
 *   model must see upright); only the band construction differs per edge.
 * @param {'mirror'|'grok'} p.fillMethod  REQUIRED, no default (decisions.md 2026-10-26, print vs view fill).
 *   'mirror': flipped blurred lower half of the picture, free. 'grok': Grok outpaints the strip
 *   (USD 0.02 per call); the original picture pixels stay on top, only the model's strip is used.
 * @param {Function} [p.editFn]        'grok' only: stand-in for grok.editWithGrok (unit tests)
 * @returns {Promise<{buffer: Buffer}>} buffer is a JPEG of the whole page
 */
async function buildFilledPageBackground({ imageBuffer, pageWidthPx, pageHeightPx, imageHeightPx, fillMethod, edge = 'bottom', editFn }) {
  if (!FILL_METHODS.includes(fillMethod)) throw new Error(`pageFill: fillMethod must be one of ${FILL_METHODS.join('|')}, got ${fillMethod}`);
  if (!STRIP_EDGES.includes(edge)) throw new Error(`pageFill: edge must be one of ${STRIP_EDGES.join('|')}, got ${edge}`);
  if (edge === 'sides') return buildSidesFilledPage({ imageBuffer, pageWidthPx, pageHeightPx, fillMethod, editFn });
  const flipped = edge === 'top';
  const W = Math.round(pageWidthPx);
  const H = Math.round(pageHeightPx);
  const IH = Math.round(imageHeightPx);
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new Error('pageFill: imageBuffer missing');
  if (!(W > 0 && H > 0)) throw new Error('pageFill: bad page size');
  const EXTH = H - IH;
  if (!(IH >= 2 && EXTH >= 2)) throw new Error(`pageFill: image height ${IH} leaves no strip in a ${H}px page`);

  const u = W / REF_WIDTH;                 // reference px -> real px
  const ws = Math.min(1, REF_WIDTH / W);   // working scale for the heavy blur

  // 1. Picture, scale-to-cover pinned to the edge away from the strip (same crop as drawImageCovering).
  //    Work orientation = strip at the bottom; for edge 'top' the picture is flipped into it.
  const upright = await sharp(imageBuffer)
    .resize(W, IH, { fit: 'cover', position: flipped ? 'bottom' : 'top' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const img = flipped ? await flipRows(upright, W, IH) : upright;

  // 2. Fill (at working size), by edge. bottom: the picture half next to the strip, flipped, squeezed into the
  //    strip, blurred. top: the outermost rows stretched to the band height, blurred, nothing else.
  const n = Math.max(1, Math.min(IH, Math.round(IH * (flipped ? TOP_BAND_SHARE : 0.5))));
  const Ww = Math.max(2, Math.round(W * ws));
  const EXTHw = Math.max(2, Math.round(EXTH * ws));
  let band = sharp(img, { raw: { width: W, height: IH, channels: 3 } })
    .extract({ left: 0, top: IH - n, width: W, height: n })
    .resize(Ww, EXTHw, { fit: 'fill' });
  if (!flipped) band = band.flip();
  const rawLow = await band
    .blur(Math.max(0.3, (flipped ? TOP_BLUR_SIGMA : FILL_BLUR_SIGMA) * Ww / REF_WIDTH))
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
    const l = flipped ? 0 : FILL_LIGHTEN * smooth(Math.min(1, t / FILL_LIGHTEN_RAMP));
    for (let i = y * Ww * 3, e = i + Ww * 3; i < e; i++) lightLow[i] = Math.round(rawLow[i] * (1 - l) + 255 * l);
  }
  const ext = await sharp(lightLow, { raw: { width: Ww, height: EXTHw, channels: 3 } })
    .resize(W, EXTH, { fit: 'fill' })
    .raw()
    .toBuffer();

  if (fillMethod === 'grok') {
    const buffer = await grokOutpaint({ img, rawLow, Ww, EXTHw, W, H, IH, EXTH, u, editFn, flipped });
    return { buffer, usedGrok: true };
  }

  // 3. Page = picture on top, fill below.
  const page = Buffer.allocUnsafe(W * H * 3);
  img.copy(page, 0);
  ext.copy(page, W * IH * 3);

  // 4. Feathered seam: the picture's last rows melt into the fill.
  const F = flipped ? 0 : Math.min(Math.round(SEAM_FEATHER * u), IH - 1);   // top edge: no feathering beyond the blur
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

  const buffer = await sharp(flipped ? await flipRows(page, W, H) : page, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { buffer };
}

/**
 * Grok fill (decisions.md 2026-10-26, "Print PDF strip is outpainted by Grok"). The canvas sent
 * to the model is the picture on top and the (unlightened) mirror fill as a hint in the strip.
 * The model redraws the whole frame, so its upper area is discarded: the page is the ORIGINAL
 * picture pixels on top, the model's strip below, and a feathered seam between them.
 * A model failure throws: no mirror fallback.
 */
async function grokOutpaint({ img, rawLow, Ww, EXTHw, W, H, IH, EXTH, u, editFn, flipped }) {
  const template = PROMPT_TEMPLATES.stripOutpaint;
  if (!template) throw new Error('pageFill: prompts/strip-outpaint.txt not loaded (loadPromptTemplates)');
  const prompt = fillTemplate(template, { DIRECTION: OUTPAINT_DIRECTION[flipped ? 'top' : 'bottom'] });

  const hw = Math.min(W, GROK_HINT_WIDTH);
  const hh = Math.round(H * hw / W);
  const hih = Math.max(1, Math.min(hh - 1, Math.round(IH * hw / W)));
  const top = await sharp(img, { raw: { width: W, height: IH, channels: 3 } }).resize(hw, hih, { fit: 'fill' }).raw().toBuffer();
  const strip = await sharp(rawLow, { raw: { width: Ww, height: EXTHw, channels: 3 } }).resize(hw, hh - hih, { fit: 'fill' }).raw().toBuffer();
  // The model sees the page upright: for edge 'top' the work-orientation canvas is flipped back.
  const canvas = await sharp(Buffer.concat([top, strip]), { raw: { width: hw, height: hh, channels: 3 } })
    .flip(flipped).jpeg({ quality: JPEG_QUALITY }).toBuffer();

  const model = await callGrokCanvas({ canvas, prompt, W, H, editFn, flipped });

  const page = Buffer.allocUnsafe(W * H * 3);
  img.copy(page, 0);                                           // original picture, never the model's
  model.copy(page, W * IH * 3, W * IH * 3, W * H * 3);         // the model's strip
  const F = Math.min(Math.round(GROK_FEATHER * u), IH - 1);
  for (let y = IH - F; y < IH; y++) {
    const a = smooth((y - (IH - F)) / F);
    for (let i = y * W * 3, e = i + W * 3; i < e; i++) page[i] = Math.round(img[i] * (1 - a) + model[i] * a);
  }
  return sharp(flipped ? await flipRows(page, W, H) : page, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

/**
 * One Grok edit call on a hint canvas; returns the answer as raw RGB stretched to W x H (flipped back
 * to work orientation when `flipped`). Throws when the model returns nothing: no fallback.
 */
async function callGrokCanvas({ canvas, prompt, W, H, editFn, flipped = false }) {
  const call = editFn || require('./grok').editWithGrok;
  const ratio = W / H;
  const aspectRatio = GROK_ASPECTS.reduce((best, a) => (Math.abs(a[1] - ratio) < Math.abs(best[1] - ratio) ? a : best))[0];
  const res = await call(prompt, ['data:image/jpeg;base64,' + canvas.toString('base64')], { model: GROK_FILL_MODEL, aspectRatio, skipOutputCrop: true });
  if (!res?.imageData) throw new Error('pageFill: Grok returned no image');
  return sharp(Buffer.from(String(res.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    .resize(W, H, { fit: 'fill' }).flip(flipped).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
}

/**
 * Sides fill (decisions.md 2026-10-27, portrait covers on square pages): the picture is fitted by HEIGHT,
 * centred, with every pixel kept, and the band on each side is its outermost columns stretched and blurred
 * (mirror, free, no lightening: the same colour as the sky or wall it continues) or outpainted by Grok
 * (original pixels kept, feathered seam). Needs a page wider than the picture; otherwise it throws and the
 * caller covers the page instead (pdf.js drawFittedPicture).
 * @returns {Promise<{buffer: Buffer, usedGrok?: boolean, pictureLeftPx: number, pictureWidthPx: number}>}
 */
async function buildSidesFilledPage({ imageBuffer, pageWidthPx, pageHeightPx, fillMethod, editFn }) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new Error('pageFill: imageBuffer missing');
  const W = Math.round(pageWidthPx);
  const H = Math.round(pageHeightPx);
  if (!(W > 0 && H > 0)) throw new Error('pageFill: bad page size');
  const meta = await sharp(imageBuffer).metadata();
  if (!(meta.width > 0 && meta.height > 0)) throw new Error('pageFill: picture has no size');
  const IW = Math.round(H * meta.width / meta.height);
  if (W - IW < 4) throw new Error(`pageFill: picture width ${IW} leaves no side bands in a ${W}px page`);
  const LW = Math.floor((W - IW) / 2);
  const RW = W - IW - LW;
  const u = W / REF_WIDTH;
  const ws = Math.min(1, REF_WIDTH / W);

  const img = await sharp(imageBuffer).resize(IW, H, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();

  // Band = the picture's outermost TOP_BAND_SHARE columns stretched to the band width, blurred.
  const n = Math.max(1, Math.round(IW * TOP_BAND_SHARE));
  const makeBand = async (left, bandW) => {
    const bw = Math.max(2, Math.round(bandW * ws));
    const bh = Math.max(2, Math.round(H * ws));
    const small = await sharp(img, { raw: { width: IW, height: H, channels: 3 } })
      .extract({ left, top: 0, width: n, height: H })
      .resize(bw, bh, { fit: 'fill' })
      .blur(Math.max(0.3, TOP_BLUR_SIGMA * bh / (REF_WIDTH * H / W)))
      .raw().toBuffer();
    return sharp(small, { raw: { width: bw, height: bh, channels: 3 } }).resize(bandW, H, { fit: 'fill' }).raw().toBuffer();
  };
  const leftFull = await makeBand(0, LW);
  const rightFull = await makeBand(IW - n, RW);

  const compose = (page) => {
    for (let y = 0; y < H; y++) {
      leftFull.copy(page, y * W * 3, y * LW * 3, (y + 1) * LW * 3);
      img.copy(page, (y * W + LW) * 3, y * IW * 3, (y + 1) * IW * 3);
      rightFull.copy(page, (y * W + LW + IW) * 3, y * RW * 3, (y + 1) * RW * 3);
    }
  };
  const page = Buffer.allocUnsafe(W * H * 3);
  const jpeg = (buf) => sharp(buf, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  const geometry = { pictureLeftPx: LW, pictureWidthPx: IW };
  compose(page);
  if (fillMethod !== 'grok') return { buffer: await jpeg(page), ...geometry };

  const template = PROMPT_TEMPLATES.stripOutpaint;
  if (!template) throw new Error('pageFill: prompts/strip-outpaint.txt not loaded (loadPromptTemplates)');
  const prompt = fillTemplate(template, { DIRECTION: OUTPAINT_DIRECTION.sides });
  const hw = Math.min(W, GROK_HINT_WIDTH);
  const hh = Math.round(H * hw / W);
  const canvas = await sharp(page, { raw: { width: W, height: H, channels: 3 } }).resize(hw, hh, { fit: 'fill' }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  const model = await callGrokCanvas({ canvas, prompt, W, H, editFn });

  // Original pixels in the middle, the model's bands outside, a feathered seam on each side.
  model.copy(page);
  const F = Math.max(1, Math.min(Math.round(GROK_FEATHER * u), Math.floor(IW / 2) - 1));
  for (let y = 0; y < H; y++) {
    for (let x = LW; x < LW + IW; x++) {
      const d = Math.min(x - LW, LW + IW - 1 - x);
      const a = d >= F ? 1 : smooth(d / F);
      const o = (y * W + x) * 3;
      const sIdx = (y * IW + (x - LW)) * 3;
      for (let c = 0; c < 3; c++) page[o + c] = Math.round(img[sIdx + c] * a + model[o + c] * (1 - a));
    }
  }
  return { buffer: await jpeg(page), usedGrok: true, ...geometry };
}

module.exports = { buildFilledPageBackground, STRIP_EDGES, FILL_METHODS, GROK_FILL_MODEL };
