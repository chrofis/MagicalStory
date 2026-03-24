/**
 * VersionManager — Central source of truth for version index mapping.
 *
 * The DB stores images with a version_index column. The in-memory data model
 * uses imageVersions arrays. The mapping is:
 *
 *   All types:  imageVersions[i]  →  DB version_index = i
 *
 * These functions exist as a central abstraction point. They are currently
 * identity operations after the offset unification (migration 021).
 */

/**
 * Convert an array index (position in imageVersions[]) to the DB version_index.
 *
 * @param {number} arrayIndex - Zero-based index into imageVersions array
 * @param {string} _imageType - Unused (kept for API stability)
 * @returns {number} The version_index value for the DB
 */
function arrayToDbIndex(arrayIndex, _imageType) {
  return arrayIndex;
}

/**
 * Convert a DB version_index back to an array index (position in imageVersions[]).
 *
 * @param {number} dbIndex   - version_index from the DB
 * @param {string} _imageType - Unused (kept for API stability)
 * @returns {number} Zero-based index into imageVersions array
 */
function dbToArrayIndex(dbIndex, _imageType) {
  return dbIndex;
}

/**
 * After pushing a new version onto imageVersions, return the DB version_index
 * that should be set as the active version.
 *
 * Call this AFTER the push (i.e. imageVersions already contains the new entry).
 *
 * @param {Array} imageVersions - The imageVersions array (after push)
 * @param {string} _imageType   - Unused (kept for API stability)
 * @returns {number} The version_index to pass to setActiveVersion
 */
function getActiveIndexAfterPush(imageVersions, _imageType) {
  if (!imageVersions || imageVersions.length === 0) return 0;
  return imageVersions.length - 1;
}

module.exports = {
  arrayToDbIndex,
  dbToArrayIndex,
  getActiveIndexAfterPush
};
