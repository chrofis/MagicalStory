/**
 * VersionManager — Central source of truth for version index mapping.
 *
 * The DB stores images with a version_index column. The in-memory data model
 * uses imageVersions arrays. The mapping between them differs by image type:
 *
 *   Scenes:  imageVersions[i]  →  DB version_index = i + 1
 *            (version_index 0 is the original/main image saved separately)
 *
 *   Covers:  imageVersions[i]  →  DB version_index = i
 *            (no separate "main" image offset)
 *
 * Before this module, these formulas were inlined in 12+ locations with
 * inconsistent comments and at least one bug (rehydrateStoryImages used
 * 0-indexed lookup for scenes instead of 1-indexed).
 */

const COVER_TYPES = new Set(['frontCover', 'initialPage', 'backCover']);

/**
 * Is this image type a cover?
 */
function isCoverType(imageType) {
  return COVER_TYPES.has(imageType);
}

/**
 * Convert an array index (position in imageVersions[]) to the DB version_index.
 *
 * @param {number} arrayIndex - Zero-based index into imageVersions array
 * @param {string} imageType  - 'scene' or a cover type ('frontCover', 'initialPage', 'backCover')
 * @returns {number} The version_index value for the DB
 */
function arrayToDbIndex(arrayIndex, imageType) {
  return isCoverType(imageType) ? arrayIndex : arrayIndex + 1;
}

/**
 * Convert a DB version_index back to an array index (position in imageVersions[]).
 *
 * @param {number} dbIndex   - version_index from the DB
 * @param {string} imageType - 'scene' or a cover type
 * @returns {number} Zero-based index into imageVersions array
 */
function dbToArrayIndex(dbIndex, imageType) {
  return isCoverType(imageType) ? dbIndex : dbIndex - 1;
}

/**
 * After pushing a new version onto imageVersions, return the DB version_index
 * that should be set as the active version.
 *
 * Call this AFTER the push (i.e. imageVersions already contains the new entry).
 *
 * @param {Array} imageVersions - The imageVersions array (after push)
 * @param {string} imageType    - 'scene' or a cover type
 * @returns {number} The version_index to pass to setActiveVersion
 */
function getActiveIndexAfterPush(imageVersions, imageType) {
  if (!imageVersions || imageVersions.length === 0) return 0;
  // The last element's DB index
  return arrayToDbIndex(imageVersions.length - 1, imageType);
}

module.exports = {
  arrayToDbIndex,
  dbToArrayIndex,
  getActiveIndexAfterPush,
  isCoverType,
  COVER_TYPES
};
