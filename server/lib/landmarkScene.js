'use strict';
/**
 * PLATE OR FAIL — which renders may use a raw landmark photo as their scene
 * (owner, 2026-09-24; docs/decisions.md "Plate or fail").
 *
 * With no plate, packReferences used to promote landmarkPhotos[0] into the
 * scene slot and the model edited the photograph, people included (prod trial
 * job_1790169018278_n57xpnufo: two strangers from a Wikimedia photo painted
 * beside the child). Now a render that carries landmark photos must either
 * carry a people-free plate (`sceneBackground`) or declare one of these
 * roles for the photo:
 *
 *   'plate'    — the call renders the people-free plate itself: the plate IS
 *                the painted version of the photo.
 *   'castless' — THE CAST-0 EXEMPTION: a page with no named cast gets no plate
 *                (owner ruling 2026-09-02, kept 2026-09-24) — the render is the
 *                scene, and its landmark photo is its scene reference.
 *   'composite' — the composite cover route (iterateCover with compositeOn),
 *                left exactly as it was by owner decision 2026-09-24: the raw
 *                photo stays its background input.
 *
 * Anything else throws (PlateRequiredError) before a provider is called.
 * The composite generators themselves call editWithGrok directly and never
 * reach this check.
 */
const { pageCastSize } = require('./imageRouter');

const LANDMARK_SCENE_ROLES = Object.freeze(['plate', 'castless', 'composite']);

class PlateRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlateRequiredError';
  }
}

/** A usable plate is a data-URI image; anything else is not sent as one. */
function hasPlate(sceneBackground) {
  return typeof sceneBackground === 'string' && sceneBackground.startsWith('data:image');
}

/**
 * THE CAST-0 EXEMPTION. A page with no named cast has no plate by design and
 * renders directly on its landmark photo. Same cast count the router uses.
 * @param {Object} page - anything pageCastSize reads (sceneMetadata / sceneCharacters)
 */
function landmarkPhotoIsPageScene(page) {
  return pageCastSize(page) === 0;
}

/** A page that carries a landmark photo and is not exempt must have a plate. */
function pageNeedsPlate(page, landmarkPhotos) {
  return (Array.isArray(landmarkPhotos) ? landmarkPhotos.length : 0) > 0 && !landmarkPhotoIsPageScene(page);
}

/** The role a PAGE render declares for its landmark photo: 'castless' or none. */
function pageLandmarkScene(page) {
  return landmarkPhotoIsPageScene(page) ? 'castless' : null;
}

/**
 * The one check every image dispatch runs. Throws when landmark photos would
 * reach a render with no plate and no declared role.
 */
function assertLandmarkScene({ landmarkPhotos, sceneBackground, landmarkScene = null, label = 'IMAGE' } = {}) {
  if (landmarkScene != null && !LANDMARK_SCENE_ROLES.includes(landmarkScene)) {
    throw new Error(`${label}: unknown landmarkScene role "${landmarkScene}"`);
  }
  const n = Array.isArray(landmarkPhotos) ? landmarkPhotos.filter(Boolean).length : 0;
  if (n === 0 || hasPlate(sceneBackground) || landmarkScene) return;
  throw new PlateRequiredError(
    `${label}: landmark "${landmarkPhotos.find(Boolean)?.name || 'unknown'}" with no plate — a raw landmark photo is never a render's scene (plate or fail)`
  );
}

/** Stored plate bytes → data URI (rows hold a data URI, raw base64, or an R2 URL). */
async function toPlateDataUri(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return `data:image/jpeg;base64,${value.toString('base64')}`;
  if (typeof value !== 'string') return null;
  if (value.startsWith('data:image')) return value;
  if (/^https?:\/\//.test(value)) {
    const { bytesFromAnyImage } = require('./r2');
    const buf = await bytesFromAnyImage(value);
    return buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : null;
  }
  return `data:image/jpeg;base64,${value}`;
}

/**
 * The plate a stored page was rendered on: the `empty_scene` story_images row
 * (version 0), which is where every plate is persisted. Null when none.
 */
async function loadStoredPagePlate(storyId, pageNumber) {
  if (!storyId || pageNumber == null) return null;
  const { getStoryImage } = require('../services/database');
  const row = await getStoryImage(storyId, 'empty_scene', pageNumber, 0);
  return (await toPlateDataUri(row?.imageData)) || (await toPlateDataUri(row?.imageUrl));
}

/**
 * THE ONE PLATE RESOLVER for re-rendering a page of a STORED story (page
 * regenerate, repair re-render, calm-zone re-render, the Lab image stages).
 * docs/decisions.md 2026-11-07 "A re-render keeps the page's plate".
 *
 * Every page that is not cast-0 is redrawn on ITS plate, not only landmark
 * pages: the plate the caller holds, else the stored `empty_scene` row. A page
 * with none gets one rendered through `renderPlate` (the caller saves it as the
 * page's `empty_scene`); a refused or failed render throws. A page redrawn
 * with no plate came out in a palette unlike the rest of its book (Rubi p6,
 * 2026-11-07). The cast-0 exemption is unchanged: that page's landmark photo
 * IS its scene and it has no plate. Covers are not routed here.
 *
 * Without `renderPlate` (an in-run caller that cannot render), a landmark page
 * with no plate throws and any other page is left without one.
 */
async function resolveRepairScene({ page, landmarkPhotos, plate = null, storyId = null, pageNumber = null, label = 'REPAIR', renderPlate = null } = {}) {
  if (landmarkPhotoIsPageScene(page)) {
    return { sceneBackground: null, landmarkScene: pageLandmarkScene(page) };
  }
  // Through module.exports so the one DB read is stubbable in tests.
  let sceneBackground = (await toPlateDataUri(plate)) || (await module.exports.loadStoredPagePlate(storyId, pageNumber));
  if (!sceneBackground && typeof renderPlate === 'function') {
    sceneBackground = await toPlateDataUri(await renderPlate());
    if (!sceneBackground) {
      throw new PlateRequiredError(`${label} page ${pageNumber ?? '?'}: the page has no stored plate and none could be rendered — not redrawn without one`);
    }
  }
  if (!sceneBackground) {
    if (pageNeedsPlate(page, landmarkPhotos)) {
      throw new PlateRequiredError(`${label} page ${pageNumber ?? '?'}: landmark page has no stored plate — not rendered on the raw photo`);
    }
    return { sceneBackground: null, landmarkScene: null };
  }
  return { sceneBackground, landmarkScene: null };
}

module.exports = {
  resolveRepairScene,
  LANDMARK_SCENE_ROLES,
  PlateRequiredError,
  hasPlate,
  landmarkPhotoIsPageScene,
  pageNeedsPlate,
  pageLandmarkScene,
  assertLandmarkScene,
  toPlateDataUri,
  loadStoredPagePlate,
};
