/**
 * Filled page background for the printed single layout (decisions.md, "Print page
 * strip filled by a mirrored, blurred picture", 2026-10-26).
 *
 * The single layout puts the scene picture on one edge of the page and the text in a strip on
 * the other (the calmer picture edge, textRegion.chooseStripEdge, decisions.md 2026-10-27). That
 * strip used to be plain white. It is now the picture's own half next to the strip, flipped
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
const FILL_LIGHTEN = 0.35;        // uniform lighten towards white
const FILL_LIGHTEN_RAMP = 0.12;   // share of the strip over which the lighten fades in
const SEAM_FEATHER = 30;          // rows of the picture blended into the fill
const SEAM_STRENGTH = 0.9;
const JPEG_QUALITY = 92;

const smooth = (t) => t * t * (3 - 2 * t);
const STRIP_EDGES = ['top', 'bottom'];
const OUTPAINT_DIRECTION = { top: 'upward into the empty upper band', bottom: 'downward into the empty lower band' };

// A raw RGB page flipped top-to-bottom (the 'top' edge is built as a 'bottom' page, then flipped).
const flipRows = (buf, w, h) => sharp(buf, { raw: { width: w, height: h, channels: 3 } }).flip().raw().toBuffer();

/**
 * @param {Object} p
 * @param {Buffer} p.imageBuffer       scene picture (any format sharp reads)
 * @param {number} p.pageWidthPx       full page raster width
 * @param {number} p.pageHeightPx      full page raster height
 * @param {number} p.imageHeightPx     height the picture occupies; the rest is the strip
 * @param {'top'|'bottom'} [p.edge='bottom']  where the STRIP goes. 'bottom': picture pinned to the top,
 *   fill below. 'top': picture pinned to the bottom, fill above (the mirror/hint comes from the picture's
 *   upper half). One code path: everything is built as a bottom-strip page and flipped at the raster
 *   boundaries (output, and the Grok canvas / answer, which the model must see upright).
 * @param {'mirror'|'grok'} p.fillMethod  REQUIRED, no default (decisions.md 2026-10-26, print vs view fill).
 *   'mirror': flipped blurred lower half of the picture, free. 'grok': Grok outpaints the strip
 *   (USD 0.02 per call); the original picture pixels stay on top, only the model's strip is used.
 * @param {Function} [p.editFn]        'grok' only: stand-in for grok.editWithGrok (unit tests)
 * @returns {Promise<{buffer: Buffer}>} buffer is a JPEG of the whole page
 */
async function buildFilledPageBackground({ imageBuffer, pageWidthPx, pageHeightPx, imageHeightPx, fillMethod, edge = 'bottom', editFn }) {
  if (!FILL_METHODS.includes(fillMethod)) throw new Error(`pageFill: fillMethod must be one of ${FILL_METHODS.join('|')}, got ${fillMethod}`);
  if (!STRIP_EDGES.includes(edge)) throw new Error(`pageFill: edge must be one of ${STRIP_EDGES.join('|')}, got ${edge}`);
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

  // 2. Fill: the picture half next to the strip, flipped, squeezed into the strip, blurred (at working size).
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

  if (fillMethod === 'grok') {
    const buffer = await grokOutpaint({ img, rawLow, Ww, EXTHw, W, H, IH, EXTH, u, editFn, flipped });
    return { buffer, usedGrok: true };
  }

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
  const call = editFn || require('./grok').editWithGrok;

  const hw = Math.min(W, GROK_HINT_WIDTH);
  const hh = Math.round(H * hw / W);
  const hih = Math.max(1, Math.min(hh - 1, Math.round(IH * hw / W)));
  const top = await sharp(img, { raw: { width: W, height: IH, channels: 3 } }).resize(hw, hih, { fit: 'fill' }).raw().toBuffer();
  const strip = await sharp(rawLow, { raw: { width: Ww, height: EXTHw, channels: 3 } }).resize(hw, hh - hih, { fit: 'fill' }).raw().toBuffer();
  // The model sees the page upright: for edge 'top' the work-orientation canvas is flipped back.
  const canvas = await sharp(Buffer.concat([top, strip]), { raw: { width: hw, height: hh, channels: 3 } })
    .flip(flipped).jpeg({ quality: JPEG_QUALITY }).toBuffer();

  const ratio = W / H;
  const aspectRatio = GROK_ASPECTS.reduce((best, a) => (Math.abs(a[1] - ratio) < Math.abs(best[1] - ratio) ? a : best))[0];
  const res = await call(prompt, ['data:image/jpeg;base64,' + canvas.toString('base64')], { model: GROK_FILL_MODEL, aspectRatio, skipOutputCrop: true });
  if (!res?.imageData) throw new Error('pageFill: Grok returned no image');
  const model = await sharp(Buffer.from(String(res.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    .resize(W, H, { fit: 'fill' }).flip(flipped).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();

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

module.exports = { buildFilledPageBackground, FILL_METHODS, GROK_FILL_MODEL };
