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
 * DB version_index for one version entry: an explicit dbVersionIndex stamp
 * (regen routes allocate via getNextVersionIndex, which can run ahead of the
 * array position on lazy-migrated stories) wins over the identity mapping.
 *
 * @param {object|null} version - imageVersions[arrayIndex]
 * @param {number} arrayIndex - Position in imageVersions[]
 * @param {string} imageType
 * @returns {number}
 */
function dbIndexFor(version, arrayIndex, imageType) {
  return Number.isInteger(version?.dbVersionIndex)
    ? version.dbVersionIndex
    : arrayToDbIndex(arrayIndex, imageType);
}

/**
 * Inverse of dbIndexFor: locate the imageVersions[] position for a DB
 * version_index — stamped entry first, identity mapping otherwise. No bounds
 * check (matches dbToArrayIndex); callers that need one clamp themselves.
 *
 * @param {Array|null} versions - imageVersions[]
 * @param {number} dbIndex - version_index from the DB / meta column
 * @param {string} imageType
 * @returns {number}
 */
function arrayIndexForDb(versions, dbIndex, imageType) {
  const stamped = Array.isArray(versions)
    ? versions.findIndex(v => v?.dbVersionIndex === dbIndex)
    : -1;
  return stamped >= 0 ? stamped : dbToArrayIndex(dbIndex, imageType);
}

/**
 * After pushing a new version onto imageVersions, return the DB version_index
 * that should be set as the active version.
 *
 * Picks by canonical scoring (pickBestVersionIndex from scoring.js) so the
 * BEST-scoring version wins, not the LAST-pushed one. Previously this
 * returned `imageVersions.length - 1` unconditionally, which made every
 * regen overwrite the picked-best active version with the newly-pushed
 * (potentially worse) attempt. Observed on staging job_1778925296736_*
 * pages 10-14: meta pointed to the last attempt even when an earlier
 * version had a higher score.
 *
 * Call this AFTER the push (i.e. imageVersions already contains the new entry).
 *
 * @param {Array} imageVersions - The imageVersions array (after push)
 * @param {string} imageType    - 'scene' | 'frontCover' | 'initialPage' | 'backCover'
 * @returns {number} The DB version_index to pass to setActiveVersion
 */
function getActiveIndexAfterPush(imageVersions, imageType) {
  if (!imageVersions || imageVersions.length === 0) return 0;
  // Lazy require to avoid a circular dep: scoring.js → versionManager.js
  // (arrayToDbIndex) → would loop back here on early load.
  const { pickBestVersionIndex } = require('./scoring');
  const arrayIdx = pickBestVersionIndex(imageVersions);
  if (arrayIdx < 0) {
    // No version has a score yet (all-null) — fall back to newest.
    return dbIndexFor(imageVersions[imageVersions.length - 1], imageVersions.length - 1, imageType);
  }
  return dbIndexFor(imageVersions[arrayIdx], arrayIdx, imageType);
}

module.exports = {
  arrayToDbIndex,
  dbToArrayIndex,
  dbIndexFor,
  arrayIndexForDb,
  getActiveIndexAfterPush
};
