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

/**
 * True when a page or cover record lists no versions yet, so a route adding a version must first
 * seed the original (DB version_index 0). A trial page is stored with `imageVersions: []` beside
 * its version-0 image: treating [] as seeded put the new version in slot 0, which saved it over
 * the original's R2 key (2026-11-03).
 *
 * @param {object|null} record - a sceneImages entry or a coverImages entry
 * @returns {boolean}
 */
function needsOriginalSeed(record) {
  return !Array.isArray(record?.imageVersions) || record.imageVersions.length === 0;
}

/**
 * Pick the story_images row of the ACTIVE version. No fallback: if the pinned
 * active version has no loadable row (e.g. an unpromoted Lab test row, which every
 * user-facing read filters out - decisions.md "Test Lab: is_test sandbox versions"),
 * throw, because silently substituting version 0 makes an edit/repair act on a
 * different picture than the one the customer sees (bug page-edit-silently-edits-version-0).
 * @param {Array} rows rows with version_index
 * @param {number} activeDbIndex image_version_meta activeVersion
 * @param {string} label for the error message
 */
function requireActiveRow(rows, activeDbIndex, label) {
  const row = rows.find(r => r.version_index === activeDbIndex);
  if (!row) {
    const err = new Error(`Active version ${activeDbIndex} of ${label} has no loadable image row (versions present: ${rows.map(r => r.version_index).join(', ') || 'none'}). Refusing to use another version.`);
    err.code = 'ACTIVE_VERSION_NOT_LOADABLE';
    err.status = 409;
    throw err;
  }
  return row;
}

module.exports = {
  requireActiveRow,
  needsOriginalSeed,
  arrayToDbIndex,
  dbToArrayIndex,
  dbIndexFor,
  arrayIndexForDb,
  getActiveIndexAfterPush
};
