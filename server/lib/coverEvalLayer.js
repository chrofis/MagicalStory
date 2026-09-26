/**
 * COVER EVAL LAYER — the pixels a cover version is JUDGED on.
 *
 * Owner, 2026-09-26: "the app texts (magicalstory.ch, dedication, composited
 * title) should not be part of the evaluated image — evaluate first, then add
 * the text."
 *
 * A cover renders TEXTLESS and the app composites its title / dedication /
 * "magicalstory.ch" onto it (coverTypography.composeCover). The served row
 * (`story_images` image_type=<coverKey>) carries that stamp; the textless
 * original of the same version is the `${coverKey}Art` row with the SAME
 * version_index. The story run judges the art before the post-persist stamp,
 * but every eval of a stored cover — Test Lab, admin re-evaluate and
 * evaluate-single, the cover edit, the cover iterate, the entity / style /
 * book checks on a stored book — used to read the stamped served bytes, so a
 * judge read the app's own lettering (Lab 1521, back cover of staging
 * job_1790446348343_z3fw660ie: "magicalstory.ch").
 *
 * One rule, one resolver:
 *   - the `${coverKey}Art` row of THAT version exists → judge it;
 *   - it does not, and the cover was never stamped (no Art row for the cover
 *     at all and no typography marker: a cover still inside its first run, a
 *     baked-title front cover, a pre-typography story whose text the model
 *     painted) → the served bytes ARE the art;
 *   - it does not, and the cover IS stamped → NO_ART_LAYER, thrown. The
 *     stamped image is never judged in its place, and no other version's art
 *     stands in for it.
 *
 * A baked title (painted into the art by design, a REQUIRED TEXT item) stays:
 * it is part of the art layer, and a baked front cover has no Art row.
 */

const COVER_KEYS = Object.freeze(['frontCover', 'initialPage', 'backCover']);

function noArtLayerError(storyId, coverKey, versionIndex) {
  const e = new Error(`${coverKey} v${versionIndex} of ${storyId} carries the app's stamped text and has no textless art layer (${coverKey}Art v${versionIndex}) — refusing to judge the stamped image`);
  e.code = 'NO_ART_LAYER';
  return e;
}

async function rowToDataUri(row) {
  const r2 = require('./r2');
  const src = row.image_url || (row.image_data ? 'data:image/jpeg;base64,' + Buffer.from(row.image_data).toString('base64') : null);
  const bytes = src ? await r2.bytesFromAnyImage(src) : null;
  return bytes ? 'data:image/jpeg;base64,' + bytes.toString('base64') : null;
}

/**
 * Has the app stamped its text onto this cover? True once the post-persist
 * bake (or any restamp) ran: it writes a production `${coverKey}Art` row and
 * the cover's `typography` marker.
 */
async function isCoverStamped(storyId, coverKey) {
  const { dbQuery } = require('../services/database');
  const rows = await dbQuery(
    `SELECT EXISTS (SELECT 1 FROM story_images WHERE story_id = $1 AND image_type = $2 AND NOT is_test) AS art,
            (SELECT jsonb_typeof(data->'coverImages'->$3->'typography') = 'object' FROM stories WHERE id = $1) AS typo`,
    [storyId, `${coverKey}Art`, coverKey]);
  return !!(rows[0]?.art || rows[0]?.typo);
}

/**
 * The textless image of one cover version.
 *
 * @param {string} storyId
 * @param {'frontCover'|'initialPage'|'backCover'} coverKey
 * @param {number|null} [versionIndex] DB version_index; null = the active version
 * @returns {Promise<{imageData: string, versionIndex: number, layer: 'art'|'unstamped'}>}
 * @throws {Error} code NO_ART_LAYER when the version is stamped and has no art row
 */
async function resolveCoverEvalImage(storyId, coverKey, versionIndex = null) {
  if (!COVER_KEYS.includes(coverKey)) throw new Error(`resolveCoverEvalImage: unknown cover key "${coverKey}"`);
  if (!storyId) throw new Error(`resolveCoverEvalImage: ${coverKey} has no story id`);
  const { dbQuery, getActiveVersion } = require('../services/database');
  const v = versionIndex === null || versionIndex === undefined ? await getActiveVersion(storyId, coverKey) : Number(versionIndex);
  if (!Number.isInteger(v)) throw new Error(`resolveCoverEvalImage: ${coverKey} version "${versionIndex}" is not an index`);
  const pick = (type) => dbQuery(
    'SELECT image_url, image_data FROM story_images WHERE story_id = $1 AND image_type = $2 AND page_number IS NULL AND version_index = $3 LIMIT 1',
    [storyId, type, v]);

  const art = (await pick(`${coverKey}Art`))[0];
  if (art) {
    const imageData = await rowToDataUri(art);
    if (!imageData) throw new Error(`${coverKey}Art v${v} of ${storyId}: could not resolve the art bytes`);
    return { imageData, versionIndex: v, layer: 'art' };
  }
  const served = (await pick(coverKey))[0];
  if (!served) throw new Error(`${coverKey} v${v} of ${storyId} does not exist`);
  if (await isCoverStamped(storyId, coverKey)) throw noArtLayerError(storyId, coverKey, v);
  const imageData = await rowToDataUri(served);
  if (!imageData) throw new Error(`${coverKey} v${v} of ${storyId}: could not resolve the image bytes`);
  return { imageData, versionIndex: v, layer: 'unstamped' };
}

/**
 * Turn a REHYDRATED story into the view a whole-book judge reads: every cover's
 * active image replaced by its textless art. For the entity, style and book
 * checks, which read `coverImages[key].imageData` straight off the story.
 *
 * Mutates `storyData` — pass the eval-only copy, never an object that is saved.
 * The cover's stored detection is re-pointed at the art bytes on a CLONE: the
 * stamp moves no figure (restampDetectionForCoverText), so the boxes are the
 * art's boxes. A stamped cover with no art layer is REMOVED from the view and
 * logged as an error: that cover is not judged, and the caller reports it.
 *
 * @returns {Promise<{notEvaluated: Array<{coverKey: string, reason: string}>, servedByKey: Object<string,string>}>}
 *   `servedByKey` holds the stamped bytes each cover had, for a caller that
 *   must re-point a new detection back at what is served.
 */
async function applyCoverEvalView(storyId, storyData) {
  const { log } = require('../utils/logger');
  const notEvaluated = [];
  const servedByKey = {};
  const covers = storyData && storyData.coverImages;
  if (!covers) return { notEvaluated, servedByKey };
  for (const coverKey of COVER_KEYS) {
    const cover = covers[coverKey];
    if (!cover || typeof cover !== 'object' || !cover.imageData) continue;
    try {
      const { imageData, versionIndex, layer } = await resolveCoverEvalImage(storyId, coverKey, null);
      servedByKey[coverKey] = cover.imageData;
      cover.imageData = imageData;
      if (cover.bboxDetection) {
        cover.bboxDetection = require('./bboxDetection').restampDetectionForCoverText({ ...cover.bboxDetection }, imageData);
      }
      log.info(`🅰️ [COVER EVAL LAYER] ${storyId} ${coverKey}: judging v${versionIndex} ${layer === 'art' ? 'textless art layer' : 'unstamped render'}`);
    } catch (err) {
      if (err.code !== 'NO_ART_LAYER') throw err;
      log.error(`❌ [COVER EVAL LAYER] ${err.message} — ${coverKey} left out of this check`);
      delete covers[coverKey];
      notEvaluated.push({ coverKey, reason: err.message });
    }
  }
  return { notEvaluated, servedByKey };
}

/**
 * A cover REPAIR starts from the same layer a judge reads (owner, 2026-09-26:
 * "repair art, then restamp"). Puts the textless art of the active version on
 * the in-memory cover record the repair methods read (`cover.imageData`), with
 * a clone of its detection re-pointed at those bytes (the stamp moves no
 * figure). Only for a record that is never persisted as-is: a stored story's
 * top-level cover bytes are not written back (saveStoryData writes versions).
 *
 * @returns {Promise<{restamp: boolean, versionIndex: number}>} `restamp` — the
 *   repaired art must get the app's text back (the cover was stamped).
 * @throws {Error} code NO_ART_LAYER — a stamped cover without its art layer.
 */
async function loadCoverArtForRepair(storyId, coverKey, cover) {
  const layer = await resolveCoverEvalImage(storyId, coverKey, null);
  cover.imageData = layer.imageData;
  if (cover.bboxDetection) {
    cover.bboxDetection = require('./bboxDetection').restampDetectionForCoverText({ ...cover.bboxDetection }, layer.imageData);
  }
  return { restamp: layer.layer === 'art', versionIndex: layer.versionIndex };
}

/**
 * The version a cover repair produces: its served bytes (the repaired art with
 * the title / dedication / brand line restamped, coverTypography.restampCover)
 * and its `${coverKey}Art` row (the repaired art). A cover the app never
 * stamped serves the repaired art and stores no art row.
 *
 * @returns {Promise<{servedImageData: string, artImageData: string|null}>}
 */
async function restampRepairedCover(storyData, coverKey, repairedArt, { restamp, figures = [] } = {}) {
  if (!restamp) return { servedImageData: repairedArt, artImageData: null };
  const { restampCover } = require('./coverTypography');
  const stamped = await restampCover(storyData, coverKey, repairedArt, { seed: storyData?.title, figures });
  return { servedImageData: stamped.titledData, artImageData: stamped.textlessData };
}

module.exports = { resolveCoverEvalImage, applyCoverEvalView, isCoverStamped, loadCoverArtForRepair, restampRepairedCover, COVER_KEYS };
