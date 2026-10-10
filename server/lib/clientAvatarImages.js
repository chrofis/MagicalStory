/**
 * The ONE hand-off of avatar images to the client (owner, 2026-10-09: never show a row or a whole sheet anywhere:
 * wizard, slides, spinner, any page. Always cut first, and show only single images, one figure per image).
 *
 * Avatars are drawn as ROWS (1x4) and SHEETS (2x4). A client may only ever receive a single CELL cut from one:
 *   - the cutters in avatarSlides.js (slidesFromSheet, frontBodyCell) are the only code that produces cells;
 *     each one checks the cut is a quarter of its source's width and registers it here;
 *   - the slides persisted on the character row are written through writeCutSlides, which accepts only a list the cutters
 *     produced and stamps the row with a digest of exactly what it stored;
 *   - every route that answers with an avatar image calls heroForClient / slidesForClient, which pass a cell the cutters
 *     made or a row whose stamp matches, and THROW (or send nothing, loudly) for anything else.
 * A new route sending an avatar image has to use these two functions; tests/unit/client-avatar-images.test.ts scans the
 * trial routes for any avatar payload that bypasses them.
 */
const crypto = require('crypto');
const { log: defaultLog } = require('../utils/logger');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Digests of the cells cut in this process (bounded; a cell is handed to the client within seconds of being cut).
const MAX_REMEMBERED_CELLS = 500;
const cutCells = new Set();
const CUT_LIST = Symbol('cutAvatarCells');
const ATTESTED_LIST = Symbol('attestedAvatarSlides');
const FIGURES = Symbol('cutAvatarFigures');

/** Register one cell the cutters just produced (a data URI) and return it. */
function markCutCell(dataUri) {
  if (typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) throw new Error('markCutCell: a cut cell is an image data URI');
  cutCells.add(sha(dataUri));
  if (cutCells.size > MAX_REMEMBERED_CELLS) cutCells.delete(cutCells.values().next().value);
  return dataUri;
}

/** The cutters return their slide lists through this so writeCutSlides can tell them from any other array. */
function brandCutList(cells, figures = null) {
  const list = cells.map(markCutCell);
  Object.defineProperty(list, CUT_LIST, { value: true });
  if (figures) {
    if (figures.length !== cells.length) throw new Error('brandCutList: one figure label per cell');
    Object.defineProperty(list, FIGURES, { value: [...figures] });
  }
  return list;
}

/** The figure label of each cell of a cut list (e.g. `standard-front-body`), or null when the cutter gave none. */
function figuresOf(list) {
  return list && list[FIGURES] ? [...list[FIGURES]] : null;
}

/**
 * Pure: is `width` a single cell of a source `sourceWidth` wide? Sheets and rows are drawn on four equal columns, so a
 * cell is a quarter of the width; anything over 0.35 is the row or the sheet itself (or a cut that missed its gutter).
 */
function isSingleCellWidth(width, sourceWidth) {
  return Number.isFinite(width) && Number.isFinite(sourceWidth) && width > 0 && sourceWidth > 0 && width <= sourceWidth * 0.35;
}

const digestOfList = (urls) => sha(urls.join('\n'));

function attested(list) {
  const out = [...list];
  Object.defineProperty(out, ATTESTED_LIST, { value: true });
  return out;
}

/**
 * Store the slides on the character row object. `cut` is the list the cutters returned (checked for the brand); `stored`
 * is what the row will hold (the same images after R2 offload: URLs). Returns `stored` marked as safe for the client.
 */
function writeCutSlides(character, cut, stored) {
  if (!cut || !cut[CUT_LIST]) throw new Error('writeCutSlides: only slides cut by avatarSlides may be stored (a row or sheet is never a slide)');
  if (!Array.isArray(stored) || stored.length !== cut.length || stored.some(s => typeof s !== 'string' || !s)) {
    throw new Error(`writeCutSlides: stored list does not match the ${cut.length} cut cells`);
  }
  character.preGeneratedAvatarSlides = stored;
  character.preGeneratedAvatarSlidesDigest = digestOfList(stored);
  return attested(stored);
}

/**
 * The slides a route may send: from an attested list (writeCutSlides' return) or from a character row whose stored slides
 * match the digest writeCutSlides left. A row whose stamp does not match is logged as an error and NOT sent (empty list).
 */
function slidesForClient(source, log = defaultLog) {
  if (Array.isArray(source)) {
    if (source[ATTESTED_LIST]) return [...source];
    throw new Error('slidesForClient: an array that did not come from writeCutSlides cannot go to the client');
  }
  const slides = source?.preGeneratedAvatarSlides;
  if (!Array.isArray(slides) || slides.length === 0) return [];
  if (source.preGeneratedAvatarSlidesDigest !== digestOfList(slides)) {
    log.error('❌ [TRIAL AVATARS] stored avatar slides carry no matching cut stamp, not sent to the client (a row or sheet must never be shown)');
    return [];
  }
  return [...slides];
}

/** The one hero picture a route may send: a single cell the cutters made in this process. Throws otherwise. */
function heroForClient(dataUri) {
  if (typeof dataUri !== 'string' || !cutCells.has(sha(dataUri))) {
    throw new Error('heroForClient: only a single cell cut by avatarSlides may go to the client (a row or sheet is never shown)');
  }
  return dataUri;
}

module.exports = { markCutCell, brandCutList, figuresOf, isSingleCellWidth, writeCutSlides, slidesForClient, heroForClient };
