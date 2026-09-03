/**
 * Our own copy of every landmark_index reference photo, on R2.
 *
 * photo_url[_2..6] are Wikimedia Commons URLs (provenance — they stay, and the
 * per-slot attribution is a licence condition tied to that source). Commons
 * throttles sustained pulls, so every story that drew a landmark was one 429
 * away from losing its reference plate. photo_r2_url[_2..6] hold the same
 * picture on our bucket, ~1280px wide, JPEG. Readers go through
 * `servedPhotoUrl` (R2 copy when set, else Commons) — the ONE chokepoint that
 * decides which URL the pipeline fetches.
 *
 * Key design: `landmarks/index/<id>/<sha1(sourceUrl)[:12]>.jpg` — derived from
 * the landmark and the source, NOT the slot. merge-landmark-descriptions.js
 * compacts slots when a photo is discarded; a slot-numbered key would have to
 * be copied/re-keyed on every shift. With a content-stable key the column
 * simply moves with its slot and a discard is a single delete.
 *
 * Writers: prep-landmark-descriptions.js (stores while it downloads the agent
 * thumbnail) and scripts/admin/backfill-landmark-photos-to-r2.js.
 */
'use strict';

const r2 = require('./r2');

const SLOTS = [1, 2, 3, 4, 5, 6];
const STORE_WIDTH = 1280;
const STORE_QUALITY = 85;

/** Column name for a per-slot field: slot 1 is unsuffixed. */
function colName(field, slot) {
  return slot === 1 ? field : `${field}_${slot}`;
}

/**
 * The URL the pipeline should fetch for one slot of an index row: our R2 copy
 * when stored, else the Commons source. Pure; accepts any row/object that
 * carries the photo_url / photo_r2_url columns.
 */
function servedPhotoUrl(row, slot = 1) {
  if (!row) return null;
  return row[colName('photo_r2_url', slot)] || row[colName('photo_url', slot)] || null;
}

/**
 * Width-limited Commons rendering of a Commons file URL. photo_url can be a
 * 100 MB master; Special:FilePath?width= returns a server-side thumbnail.
 * Non-Commons URLs pass through unchanged.
 */
function commonsThumbUrl(url, width = STORE_WIDTH) {
  const m = /\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/.exec(url || '');
  if (!m) return url;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}?width=${width}`;
}

/**
 * Fetch one landmark photo from its source, normalise to ~1280px JPEG, upload
 * to R2 and write photo_r2_url_<slot>. Returns `{ url, bytes, skipped }`.
 *
 * Idempotent: when the column already holds a URL whose object exists, nothing
 * is fetched or written (`skipped: true`, `bytes: null`). The DB write is
 * guarded on the slot still holding `sourceUrl`, so a slot that compacted
 * between the caller's read and this write is left alone (rowCount 0 → the
 * object is removed again and `url` is null).
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} landmarkId
 * @param {number} slot 1-6
 * @param {string} sourceUrl the Commons photo_url_<slot> value
 * @param {Object} [opts]
 * @param {string|null} [opts.currentR2Url] the row's current photo_r2_url_<slot>
 * @param {Buffer|null} [opts.bytes] already-downloaded source bytes (skips the fetch)
 * @returns {Promise<{url: string|null, bytes: Buffer|null, skipped: boolean}>}
 */
async function storeLandmarkPhoto(db, landmarkId, slot, sourceUrl, opts = {}) {
  if (!SLOTS.includes(slot)) throw new Error(`storeLandmarkPhoto: slot ${slot} out of range`);
  if (!sourceUrl) throw new Error(`storeLandmarkPhoto: #${landmarkId}_${slot} has no source URL`);
  if (!r2.isConfigured()) throw new Error('storeLandmarkPhoto: R2 is not configured (R2_* env vars)');

  const key = r2.keyForLandmarkIndexPhoto(landmarkId, sourceUrl);
  const expectedUrl = r2.publicUrlForKey(key);
  if (opts.currentR2Url === expectedUrl && await r2.objectExists(key)) {
    return { url: expectedUrl, bytes: null, skipped: true };
  }

  const raw = opts.bytes || await r2.fetchImageBytes(commonsThumbUrl(sourceUrl), { retries: 4, timeoutMs: 45000 });
  if (!raw) throw new Error(`fetch failed: ${commonsThumbUrl(sourceUrl)}`);
  const sharp = require('sharp');
  const jpeg = await sharp(raw)
    .rotate()
    .resize(STORE_WIDTH, STORE_WIDTH, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: STORE_QUALITY })
    .toBuffer();

  const url = await r2.uploadImage(jpeg, key, 'image/jpeg');
  if (!url) throw new Error(`R2 upload failed for ${key}`);

  const col = colName('photo_r2_url', slot);
  const srcCol = colName('photo_url', slot);
  const res = await db.query(
    `UPDATE landmark_index SET ${col} = $2, updated_at = NOW() WHERE id = $1 AND ${srcCol} = $3`,
    [landmarkId, url, sourceUrl]);
  if (res.rowCount !== 1) {
    await r2.deleteObject(key);
    throw new Error(`slot ${slot} no longer holds ${sourceUrl} (compacted?) — object removed`);
  }
  return { url, bytes: jpeg, skipped: false };
}

/**
 * Delete the R2 objects behind a list of photo_r2_url values. Called AFTER the
 * DB transaction that dropped the slots has committed. Non-R2 URLs are ignored.
 * @returns {Promise<number>} objects deleted
 */
async function deleteStoredPhotos(r2Urls) {
  let n = 0;
  for (const url of r2Urls || []) {
    const key = r2.keyFromPublicUrl(url);
    if (key && await r2.deleteObject(key)) n++;
  }
  return n;
}

module.exports = {
  SLOTS,
  STORE_WIDTH,
  colName,
  servedPhotoUrl,
  commonsThumbUrl,
  storeLandmarkPhoto,
  deleteStoredPhotos,
};
