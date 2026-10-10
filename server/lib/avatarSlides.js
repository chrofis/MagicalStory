/**
 * Trial waiting-page avatar slides: ONE whole cell of a styled 2x4 character sheet per slide.
 *
 * Until 2026-10-09 a slide was a whole COLUMN (head cell stacked on body cell, 256x1024 on the
 * standard 1024x1024 sheet). The page shows a slide in a square frame, so the 1:4 strip came out
 * a quarter of the frame wide, and only front / three-quarter / profile of the head-over-body
 * pair ever showed (owner, iPhone: "the avatar is not cut properly", "I only get head avatars").
 * Each slide is now a single cell cut with the same splitter the page references use
 * (cropAvatarCell, which cuts at the figures: sheetCut.js), so a slide is a whole head or a whole body, never a slice of either.
 * See docs/decisions.md 2026-10-09 "Trial avatar slides".
 */
const sharp = require('sharp');
const { bytesFromAnyImage, uploadImage, contentKey } = require('./r2');
const { log: defaultLog } = require('../utils/logger');
const { markCutCell, brandCutList, figuresOf, isSingleCellWidth, writeCutSlides } = require('./clientAvatarImages');

// front / three-quarter / profile; the back view has no face and is skipped.
const SLIDE_POSES = ['front', 'threeQuarter', 'profile'];

/**
 * The identity of a figure on the waiting screen: sheet variant, pose, head or body. The early body-row slides and the
 * finished standard sheet's body cells are the same figure with different bytes, so the label (not the bytes) says that a
 * picture already shown is not shown again. It is the filename prefix of the stored object (storeSlides) and the client
 * reads it back from the URL (utils/trialPoll avatarFigureOf).
 */
const figureLabel = (variant, pose, kind) => `${variant}-${pose}-${kind}`.replace(/[^a-zA-Z0-9-]/g, '_');

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
async function slidesFromSheet(source, variant = 'sheet') {
  const buf = await readSheet(source);
  const { cropAvatarCell } = require('./sceneComposite');
  const sheetWidth = (await sharp(buf).metadata()).width;
  const slides = [];
  const figures = [];
  for (const pose of SLIDE_POSES) {
    const { body, face } = await cropAvatarCell(buf, { pose, includeFace: true });
    for (const [kind, cell] of [['head', face], ['body', body]]) {
      slides.push(await singleCellJpeg(cell, sheetWidth));
      figures.push(figureLabel(variant, pose, kind));
    }
  }
  return brandCutList(slides, figures);
}

/** A cut cell as a JPEG data URI; throws when it is wider than one column of its source (an uncut row or sheet). */
async function singleCellJpeg(cell, sourceWidth) {
  const jpeg = await sharp(cell).jpeg({ quality: 88 }).toBuffer();
  const { width } = await sharp(jpeg).metadata();
  if (!isSingleCellWidth(width, sourceWidth)) throw new Error(`cut cell is ${width}px wide in a ${sourceWidth}px source: not a single cell`);
  return markCutCell(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
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

/** Pure: the sheets of one character's styled avatars as { variant, source }, costumed first (it is ready first). */
function sheetEntriesOf(styledAvatars) {
  const entries = [];
  const pick = (v) => (typeof v === 'string' ? v : (v && (v.imageData || v.imageUrl || v.url)) || null);
  const costumed = styledAvatars && styledAvatars.costumed;
  if (costumed && typeof costumed === 'object' && !costumed.imageData && !costumed.imageUrl) {
    for (const [k, v] of Object.entries(costumed)) if (pick(v)) entries.push({ variant: `costumed-${k}`, source: pick(v) });
  }
  for (const [key, v] of Object.entries(styledAvatars || {})) {
    if (key !== 'costumed' && pick(v)) entries.push({ variant: key, source: pick(v) });
  }
  return entries;
}

/** Pure: the sheet sources of one character's styled avatars, costumed first. */
const sheetSourcesOf = (styledAvatars) => sheetEntriesOf(styledAvatars).map(e => e.source);

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
  for (const { variant, source } of sheetEntriesOf(styledAvatars)) {
    try {
      const cut = await slidesFromSheet(source, variant);
      const figures = figuresOf(cut);
      perSheet.push(cut.map((cell, i) => ({ cell, figure: figures[i] })));
    } catch (err) { log.error(`[TRIAL AVATARS] avatar slides: sheet skipped (${err.message})`); }
  }
  const ordered = interleaveSheetSlides(perSheet);
  return brandCutList(ordered.map(o => o.cell), ordered.map(o => o.figure));
}

/**
 * Store cut slides in R2 under a CONTENT key and return their URLs, in order. The generic row offload names an object by its
 * position in the row (`preGeneratedAvatarSlides-3.jpg`), so two slide lists written close together (the
 * costumed sheet's, the finished sheet's) overwrote each other's objects: the stored list of user 880b53c1 held the standard
 * front body at two positions and a head at two, while the cutters returned twelve distinct cells (docs/decisions.md
 * 2026-10-09 "Trial slides: content keys"). A content key can only ever hold its own bytes.
 */
async function storeSlides(characterId, userId, slides, upload = uploadImage) {
  const safe = (v) => String(v).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  const figures = figuresOf(slides) || slides.map(() => 'slide');
  const urls = [];
  for (const [i, dataUri] of slides.entries()) {
    const url = await upload(dataUri, contentKey(`characters/${safe(userId || 'unknown')}/${safe(characterId)}/slides`, figures[i], dataUri));
    if (!url) throw new Error('avatar slide could not be stored in R2');
    urls.push(url);
  }
  return urls;
}

/**
 * The trial job calls this once its own standard sheet exists: prepare-title only ever makes the
 * COSTUMED sheet, so until now the standard sheet never reached the slideshow. Rebuilds the slides
 * of every sheet the character now has and stores them where job-status reads them.
 */
async function persistAvatarSlides({ characterId, userId, styledAvatars }, log = defaultLog) {
  const slides = await buildAvatarSlides(styledAvatars, log);
  if (slides.length === 0) throw new Error('no sheet could be cut into slides');
  const { modifyCharactersRow } = require('../services/database');
  const stored = await storeSlides(characterId, userId, slides);
  await modifyCharactersRow(characterId, userId, (fresh) => {
    const c = fresh.characters?.[0];
    if (!c) return false;
    writeCutSlides(c, slides, stored);
  });
  return slides.length;
}

module.exports = { storeSlides, persistAvatarSlides, buildAvatarSlides, slidesFromSheet, frontBodyCell, sheetSourcesOf, sheetEntriesOf, interleaveSheetSlides, SLIDE_POSES };
