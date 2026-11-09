'use strict';

/**
 * REFERENCE PAGES: earlier pages of the same book that ride along as a reference
 * when a page is redrawn (images.js iteratePageCore, option `referencePages`).
 *
 * WHY (owner, 2026-11-09, prod job_1794231161354_l3n2o3afm p6): the book review's
 * instruction was "draw the three monsters as the same green, mossy, goo-dripping
 * bog monsters as on pages 4, 5 and 7". The redraw only received the page's own
 * references, so "as on pages 4, 5 and 7" meant nothing to the image model. Built
 * for a Test Lab test; see docs/decisions.md 2026-11-09.
 *
 * ONE reference slot: the pages are composed into one sheet at the page aspect,
 * each cell carrying a printed "page N" caption. The sheet is an EXTRA slot on top
 * of the normal packing (plate, characters, Visual Bible) - nothing is dropped to
 * make room; if the provider's hard cap would be exceeded the call throws.
 */

const sharp = require('sharp');
const r2 = require('./r2');
const { log } = require('../utils/logger');

const WHITE = { r: 255, g: 255, b: 255 };

/** A failure of THIS module's own contract (slot cap, unsupported backend, bad input). images.js rethrowLocalFault never routes it to another provider. */
class ReferencePagesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReferencePagesError';
    this.localFault = true;
  }
}

/**
 * Normalise the option: [{ pageNumber, imageData }] with unique page numbers.
 * Throws on a malformed entry; an empty/absent list returns [].
 */
function normaliseReferencePages(referencePages) {
  if (referencePages == null) return [];
  if (!Array.isArray(referencePages)) throw new ReferencePagesError('referencePages must be an array of { pageNumber, imageData }');
  const seen = new Set();
  return referencePages.map((p) => {
    const n = Number(p?.pageNumber);
    if (!Number.isInteger(n) || n < 1) throw new ReferencePagesError(`referencePages entry has no valid pageNumber: ${JSON.stringify(p?.pageNumber)}`);
    if (!p.imageData) throw new ReferencePagesError(`referencePages page ${n} has no imageData`);
    if (seen.has(n)) throw new ReferencePagesError(`referencePages lists page ${n} twice`);
    seen.add(n);
    return { pageNumber: n, imageData: p.imageData };
  });
}

/**
 * Compose the pages into ONE sheet at `aspectRatio` (e.g. '3:4'). Each page sits
 * in its own cell (grid chosen so cells come closest to the page aspect, as
 * composeVbSlot does for VB cells) under a printed "page N" caption.
 *
 * @param {Array<{pageNumber:number, imageData:string}>} pages  data URL, raw base64 or R2 URL
 * @param {string} aspectRatio
 * @returns {Promise<Buffer>} JPEG exactly at the aspect
 */
async function composeReferencePagesSheet(pages, aspectRatio = '3:4') {
  const list = normaliseReferencePages(pages);
  if (list.length === 0) throw new ReferencePagesError('composeReferencePagesSheet: no pages');

  const [aw, ah] = String(aspectRatio).split(':').map(Number);
  const target = (aw > 0 && ah > 0) ? aw / ah : 1;
  const LONG = 1024;
  const W = target >= 1 ? LONG : Math.round(LONG * target);
  const H = target >= 1 ? Math.round(LONG / target) : LONG;

  // Columns whose cells come closest to the page's own aspect (a page is not squashed).
  let cols = 1;
  let best = Infinity;
  for (let c = 1; c <= list.length; c++) {
    const r = Math.ceil(list.length / c);
    const score = Math.abs(Math.log(((W / c) / (H / r)) / target));
    if (score < best - 1e-9) { best = score; cols = c; }
  }
  const rows = Math.ceil(list.length / cols);
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);
  const capH = Math.max(28, Math.round(cellH * 0.07));
  const fontSize = Math.round(capH * 0.62);
  const GAP = 6;

  const composites = [];
  for (let i = 0; i < list.length; i++) {
    const { pageNumber, imageData } = list[i];
    const buf = await r2.bytesFromAnyImage(imageData);
    if (!buf) throw new ReferencePagesError(`reference page ${pageNumber}: image bytes could not be loaded`);
    const left = (i % cols) * cellW;
    const top = Math.floor(i / cols) * cellH;
    const pic = await sharp(buf)
      .resize(cellW - GAP, cellH - capH - GAP, { fit: 'contain', background: WHITE })
      .jpeg({ quality: 90 })
      .toBuffer();
    const caption = Buffer.from(
      `<svg width="${cellW - GAP}" height="${capH}"><rect width="100%" height="100%" fill="black"/>` +
      `<text x="${Math.round((cellW - GAP) / 2)}" y="${Math.round(capH * 0.72)}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" text-anchor="middle">page ${pageNumber}</text></svg>`);
    composites.push({ input: caption, left, top });
    composites.push({ input: pic, left, top: top + capH });
  }
  log.info(`🖼️ [REFERENCE PAGES] sheet: pages ${list.map(p => p.pageNumber).join(', ')} in ${cols}x${rows} @ ${cellW}x${cellH} -> ${W}x${H} (${aspectRatio})`);
  return sharp({ create: { width: W, height: H, channels: 3, background: WHITE } })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * The prompt block. Generic words only. It sits at the ABSOLUTE END of the image
 * prompt (before a baked cover title), as withBakedTitle does: shrinkPromptForModel
 * keeps the tail verbatim, so an over-cap prompt cannot silently delete it.
 */
function referencePagesBlock(pageNumbers) {
  const nums = (pageNumbers || []).map(Number).filter(Number.isInteger);
  if (nums.length === 0) return '';
  const names = nums.map(n => `page ${n}`).join(', ');
  return [
    '**REFERENCE PAGES:**',
    `One attached reference image shows earlier pages of this book side by side, each under a caption naming its page (${names}).`,
    'Any character, creature or object of this scene that is also drawn on those pages, and anything the redraw instruction says should look as it does on those pages, must look exactly as it appears there (shape, colour, texture, size).',
    'The captions are labels for you only: never paint a caption, a page number or the reference layout into the picture.',
  ].join('\n');
}

/** prompt + the reference-pages block; unchanged when there are no pages. */
function withReferencePages(prompt, pageNumbers) {
  const block = referencePagesBlock(pageNumbers);
  return block ? `${prompt}\n\n${block}` : prompt;
}

module.exports = {
  ReferencePagesError,
  normaliseReferencePages,
  composeReferencePagesSheet,
  referencePagesBlock,
  withReferencePages,
};
