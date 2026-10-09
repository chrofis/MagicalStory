/**
 * Trial waiting-page avatar slides: ONE whole cell of a styled 2x4 character sheet per slide.
 *
 * Until 2026-10-09 a slide was a whole COLUMN (head cell stacked on body cell, 256x1024 on the
 * standard 1024x1024 sheet). The page shows a slide in a square frame, so the 1:4 strip came out
 * a quarter of the frame wide, and only front / three-quarter / profile of the head-over-body
 * pair ever showed (owner, iPhone: "the avatar is not cut properly", "I only get head avatars").
 * Each slide is now a single cell cut with the same splitter the page references use
 * (cropAvatarCell: analyzer edge detection, fixed-math fallback that honours the unequal head
 * and body rows), so a slide is a whole head or a whole body, never a slice of either.
 * See docs/decisions.md 2026-10-09 "Trial avatar slides".
 */
const sharp = require('sharp');
const { bytesFromAnyImage } = require('./r2');
const { log: defaultLog } = require('../utils/logger');
const { markCutCell, brandCutList, isSingleCellWidth, writeCutSlides } = require('./clientAvatarImages');

// front / three-quarter / profile; the back view has no face and is skipped.
const SLIDE_POSES = ['front', 'threeQuarter', 'profile'];

/** The sheet's bytes; throws on an image that is not a 2x4 sheet (a portrait is a single figure, slicing it gives a sliver). */
async function readSheet(source) {
  const buf = await bytesFromAnyImage(source);
  if (!buf) throw new Error('avatar sheet could not be read');
  const { width, height } = await sharp(buf).metadata();
  const aspect = width && height ? width / height : 0;
  if (aspect < 0.9 || aspect > 2.4) throw new Error(`image ${width}x${height} is not a 2x4 sheet`);
  return buf;
}

/**
 * The six cells of one styled sheet as JPEG data URIs, alternating head and body per angle:
 * [head front, body front, head 3/4, body 3/4, head profile, body profile].
 * Throws on an image that is not a 2x4 sheet so the caller logs it and shows no slide rather than a wrong one.
 */
async function slidesFromSheet(source) {
  const buf = await readSheet(source);
  const { cropAvatarCell } = require('./sceneComposite');
  const sheetWidth = (await sharp(buf).metadata()).width;
  const slides = [];
  for (const pose of SLIDE_POSES) {
    const { body, face } = await cropAvatarCell(buf, { pose, includeFace: true });
    for (const cell of [face, body]) slides.push(await singleCellJpeg(cell, sheetWidth));
  }
  return brandCutList(slides);
}

/** A cut cell as a JPEG data URI; throws when it is wider than one column of its source (an uncut row or sheet). */
async function singleCellJpeg(cell, sourceWidth) {
  const jpeg = await sharp(cell).jpeg({ quality: 88 }).toBuffer();
  const { width } = await sharp(jpeg).metadata();
  if (!isSingleCellWidth(width, sourceWidth)) throw new Error(`cut cell is ${width}px wide in a ${sourceWidth}px source: not a single cell`);
  return markCutCell(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
}

/**
 * The cells of a 1x4 FULL-BODY row (the body stage of a sheet, drawn before the head row): [front, threeQuarter, profile,
 * back] as JPEG data URIs. The row is drawn on four equal columns, so each cut is a quarter of its width; an image that is
 * not wide (a sheet or a single figure) is refused.
 */
async function bodyRowCells(source) {
  const buf = await bytesFromAnyImage(source);
  if (!buf) throw new Error('body row could not be read');
  const { width, height } = await sharp(buf).metadata();
  if (!width || !height || width / height < 1.5) throw new Error(`image ${width}x${height} is not a 1x4 body row`);
  const cellW = Math.floor(width / 4);
  const cells = [];
  for (let col = 0; col < 4; col++) {
    const cell = await sharp(buf).extract({ left: col * cellW, top: 0, width: cellW, height }).png().toBuffer();
    cells.push(await singleCellJpeg(cell, width));
  }
  return brandCutList(cells);
}

/** The slides a body row feeds, from its cells (bodyRowCells): front, three-quarter and profile; the back view has no face and is skipped. */
function slidesOfBodyRowCells(cells) {
  return brandCutList(cells.slice(0, SLIDE_POSES.length));
}

/**
 * The whole front-facing BODY cell of one sheet as a JPEG data URI: the hero image the wizard shows next to the
 * hero's name (the standard sheet is the only avatar the wizard draws; there is no separate preview portrait).
 */
async function frontBodyCell(source) {
  const buf = await readSheet(source);
  const { cropAvatarCell } = require('./sceneComposite');
  const { body } = await cropAvatarCell(buf, { pose: 'front' });
  return singleCellJpeg(body, (await sharp(buf).metadata()).width);
}

/** Pure: the sheet sources of one character's styled avatars, costumed first (it is ready first). */
function sheetSourcesOf(styledAvatars) {
  const sources = [];
  const pick = (v) => (typeof v === 'string' ? v : (v && (v.imageData || v.imageUrl || v.url)) || null);
  const costumed = styledAvatars && styledAvatars.costumed;
  if (costumed && typeof costumed === 'object' && !costumed.imageData && !costumed.imageUrl) {
    for (const v of Object.values(costumed)) if (pick(v)) sources.push(pick(v));
  }
  for (const [key, v] of Object.entries(styledAvatars || {})) {
    if (key !== 'costumed' && pick(v)) sources.push(pick(v));
  }
  return sources;
}

/** Pure: head+body pairs of every sheet in turn, so the costumed and the standard sheet alternate. */
function interleaveSheetSlides(perSheet) {
  const out = [];
  const pairs = Math.max(0, ...perSheet.map(s => Math.floor(s.length / 2)));
  for (let p = 0; p < pairs; p++) {
    for (const s of perSheet) if (s[2 * p]) out.push(s[2 * p], s[2 * p + 1]);
  }
  return out;
}

/**
 * Slides of every sheet of one character's styled avatars ({ standard, costumed: { default } }).
 * A sheet that cannot be cut is logged as an error and left out; the others still show.
 */
async function buildAvatarSlides(styledAvatars, log = defaultLog) {
  const perSheet = [];
  for (const source of sheetSourcesOf(styledAvatars)) {
    try { perSheet.push(await slidesFromSheet(source)); }
    catch (err) { log.error(`[TRIAL AVATARS] avatar slides: sheet skipped (${err.message})`); }
  }
  return brandCutList(interleaveSheetSlides(perSheet));
}

/**
 * The trial job calls this once its own standard sheet exists: prepare-title only ever makes the
 * COSTUMED sheet, so until now the standard sheet never reached the slideshow. Rebuilds the slides
 * of every sheet the character now has and stores them where job-status reads them.
 */
async function persistAvatarSlides({ characterId, userId, styledAvatars }, log = defaultLog) {
  const slides = await buildAvatarSlides(styledAvatars, log);
  if (slides.length === 0) throw new Error('no sheet could be cut into slides');
  const { offloadCharacterImages, modifyCharactersRow } = require('../services/database');
  const fragment = { preGeneratedAvatarSlides: slides };
  await offloadCharacterImages(characterId, userId, fragment);
  await modifyCharactersRow(characterId, userId, (fresh) => {
    const c = fresh.characters?.[0];
    if (!c) return false;
    writeCutSlides(c, slides, fragment.preGeneratedAvatarSlides);
  });
  return slides.length;
}

module.exports = { persistAvatarSlides, buildAvatarSlides, slidesFromSheet, bodyRowCells, slidesOfBodyRowCells, frontBodyCell, sheetSourcesOf, interleaveSheetSlides, SLIDE_POSES };
