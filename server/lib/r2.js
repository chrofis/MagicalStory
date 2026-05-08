/**
 * Cloudflare R2 image storage helper.
 *
 * R2 speaks the S3 API, so we use @aws-sdk/client-s3 with R2's endpoint.
 *
 * Required env vars (all four needed for upload to work):
 *   R2_ACCOUNT_ID         — Cloudflare account ID
 *   R2_ACCESS_KEY_ID      — R2 API token's access key
 *   R2_SECRET_ACCESS_KEY  — R2 API token's secret
 *   R2_BUCKET             — bucket name (e.g. "magicalstory-images")
 *
 * Optional:
 *   R2_PUBLIC_URL         — public URL prefix for the bucket. Either:
 *                           a custom domain (https://images.magicalstory.ch)
 *                           or the dev URL (https://pub-xxx.r2.dev). When
 *                           unset, uploadImage returns null (graceful no-op).
 *
 * If any required env is missing, isConfigured() returns false and
 * uploadImage() returns null. Callers must fall back to the existing
 * inline-bytes storage path. This makes the rollout safe: the code can
 * be deployed before R2 credentials are added; it activates the moment
 * env vars land.
 */

const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { log } = require('../utils/logger');

let _client = null;
let _configured = null;

function isConfigured() {
  if (_configured !== null) return _configured;
  _configured = !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_PUBLIC_URL
  );
  if (_configured) {
    log.info(`☁️  [R2] Configured for bucket "${process.env.R2_BUCKET}"`);
  } else {
    log.info(`☁️  [R2] Not configured — image uploads will fall back to inline storage`);
  }
  return _configured;
}

function getClient() {
  if (!isConfigured()) return null;
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

// ─── Key generation (stable, idempotent) ────────────────────────────────────
//
// Stable keys mean we can safely re-run the backfill — re-uploading the same
// (storyId, type, page, version) yields the same key, so it just overwrites
// the existing object with identical bytes. No duplicates accumulate.

function keyForStoryImage(storyId, imageType, pageNumber, versionIndex) {
  // imageType: 'scene' | 'frontCover' | 'initialPage' | 'backCover'
  // pageNumber: integer for scenes, null for covers
  // versionIndex: integer (0 = active, higher = retry version)
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  return `stories/${storyId}/${imageType}/${pageSlug}/v${versionIndex ?? 0}.jpg`;
}

function keyForRetryImage(storyId, pageNumber, retryIndex, imageType, gridIndex = null) {
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  const grid = gridIndex != null ? `-g${gridIndex}` : '';
  return `stories/${storyId}/retry/${pageSlug}/${imageType}-r${retryIndex}${grid}.jpg`;
}

function keyForStyleLabImage(storyId, pageNumber, runId, modelId) {
  const safeModel = String(modelId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `stories/${storyId}/style-lab/p${pageNumber}/${runId}-${safeModel}.jpg`;
}

function keyForCharacterPhoto(storyId, characterId, slot) {
  return `stories/${storyId}/characters/${characterId}/${slot}.jpg`;
}

// User-scoped character photos (the canonical row in the characters table —
// distinct from the per-story snapshot above).
function keyForUserCharacterPhoto(userId, characterId, slot) {
  return `characters/${userId}/${characterId}/photos/${slot}.jpg`;
}

function keyForHistoricalLocationPhoto(rowId, slug) {
  const cleanSlug = String(slug || 'photo').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return `landmarks/historical/${rowId}-${cleanSlug}.jpg`;
}

// User order PDFs (book-N-stories.pdf delivered to print-on-demand). The IDs
// are random UUIDs so the public R2 URL is effectively private.
function keyForOrderPdf(fileId) {
  const safe = String(fileId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `orders/${safe}.pdf`;
}

// Account-scoped avatar keys (Phase 0 of the avatar→R2 migration). The
// existing keyForCharacterPhoto above is *story-scoped* and is for the
// per-story photo uploads. Avatars live on the characters table, so they
// need their own key shape rooted at the userId.
function keyForCharacterAvatar(userId, characterId, slot) {
  return `characters/${userId}/${characterId}/avatars/${slot}.jpg`;
}

function keyForCharacterStyledAvatar(userId, characterId, key) {
  return `characters/${userId}/${characterId}/avatars/styled/${key}.jpg`;
}

function keyForCharacterThumb(userId, characterId, kind, slot) {
  return `characters/${userId}/${characterId}/avatars/thumbs/${kind}-${slot}.jpg`;
}

function keyForVbReference(storyId, entryId) {
  return `stories/${storyId}/vb/${entryId}.jpg`;
}

// ─── Debug-image keys ───────────────────────────────────────────────────────
// All under stories/{storyId}/debug/… so a future retention sweep can
// enumerate and prune them in one prefix delete.

function keyForGrokRef(storyId, pageNumber, versionIndex, slot) {
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  return `stories/${storyId}/debug/${pageSlug}/v${versionIndex ?? 0}/grok-ref-${slot}.jpg`;
}

function keyForInpaintRef(storyId, pageNumber, versionIndex, slot) {
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  return `stories/${storyId}/debug/${pageSlug}/v${versionIndex ?? 0}/inpaint-ref-${slot}.jpg`;
}

function keyForEntityGrid(storyId, pageNumber, gridIndex) {
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  return `stories/${storyId}/debug/${pageSlug}/entity-grid-${gridIndex}.jpg`;
}

function keyForCharGrid(storyId, pageNumber, charKey, clothing, gridIndex) {
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  const cleanChar = String(charKey || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanClothing = String(clothing || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const idxSuffix = gridIndex != null ? `-${gridIndex}` : '';
  return `stories/${storyId}/debug/${pageSlug}/char-grid-${cleanChar}-${cleanClothing}${idxSuffix}.jpg`;
}

function keyForBboxOverlay(storyId, pageNumber, versionIndex) {
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  return `stories/${storyId}/debug/${pageSlug}/bbox-overlay-v${versionIndex ?? 0}.jpg`;
}

function keyForVbGrid(storyId, pageNumber) {
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  return `stories/${storyId}/debug/${pageSlug}/vb-grid.jpg`;
}

function keyForRepairCompare(storyId, charKey, pageNumber, kind) {
  const cleanChar = String(charKey || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanKind = String(kind || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `stories/${storyId}/debug/repair/${cleanChar}/p${pageNumber}/${cleanKind}.jpg`;
}

function keyForStyledAvatarInput(storyId, entryIndex, field) {
  const cleanField = String(field || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `stories/${storyId}/debug/styled-avatar/${entryIndex}/${cleanField}.jpg`;
}

function keyForLandmarkPhoto(storyId, pageNumber, slot) {
  const pageSlug = pageNumber != null ? `p${pageNumber}` : 'cover';
  return `stories/${storyId}/debug/${pageSlug}/landmark-${slot}.jpg`;
}

// Per-story styled avatar (the snapshot inside stories.data — distinct from
// the canonical character-table avatar). Used by the per-story strip walker.
function keyForStoryStyledAvatar(storyId, charKey, artStyle, clothingCategory) {
  const cleanChar = String(charKey || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanArt = String(artStyle || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanClothing = String(clothingCategory || 'standard').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `stories/${storyId}/styled-avatars/${cleanChar}/${cleanArt}/${cleanClothing}.jpg`;
}

function keyForStoryCostumedAvatar(storyId, charKey, artStyle, costumeName) {
  const cleanChar = String(charKey || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanArt = String(artStyle || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanCostume = String(costumeName || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `stories/${storyId}/styled-avatars/${cleanChar}/${cleanArt}/costumed-${cleanCostume}.jpg`;
}

function publicUrlForKey(key) {
  if (!process.env.R2_PUBLIC_URL) return null;
  const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/${key}`;
}

/**
 * Upload bytes to R2 at the given key. Idempotent — overwrites existing.
 * Returns the public URL on success, null on failure or when not configured.
 *
 * Image input: base64 string (with or without "data:image/..;base64," prefix)
 * or a Buffer.
 */
async function uploadImage(input, key, contentType = 'image/jpeg') {
  if (!isConfigured()) return null;
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (typeof input === 'string') {
    const stripped = input.replace(/^data:image\/\w+;base64,/, '');
    buf = Buffer.from(stripped, 'base64');
  } else {
    log.warn(`[R2] uploadImage got unexpected type: ${typeof input}`);
    return null;
  }
  if (!buf || buf.length === 0) {
    log.warn(`[R2] uploadImage skipped — empty buffer for key ${key}`);
    return null;
  }
  try {
    const client = getClient();
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buf,
      ContentType: contentType,
    }));
    return publicUrlForKey(key);
  } catch (err) {
    log.warn(`[R2] uploadImage failed for ${key}: ${err.message}`);
    return null;
  }
}

/**
 * Universal image-bytes loader. Accepts:
 *   - http(s) URL          → fetched from R2/CDN
 *   - data:image/...;base64,XYZ → decoded
 *   - raw base64 (/9j/, iVBOR…) → decoded
 *   - Buffer               → returned as-is
 *   - null/undefined/empty → null
 *
 * Use everywhere a field could now hold either a URL (post-Phase-2) or
 * inline base64 (legacy / R2 outage fallback).
 *
 * Returns Buffer on success, null on failure.
 */
async function bytesFromAnyImage(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^https?:\/\//i.test(value)) {
    return await fetchImageBytes(value);
  }
  if (value.startsWith('data:')) {
    const stripped = value.replace(/^data:image\/\w+;base64,/, '');
    try {
      return Buffer.from(stripped, 'base64');
    } catch (err) {
      log.warn(`[R2] bytesFromAnyImage data: decode failed: ${err.message}`);
      return null;
    }
  }
  // Reject any other URL scheme (e.g. magicalstory://tell-curated/...) — these
  // are synthetic identifiers that no fetcher knows how to resolve. Falling
  // through to `Buffer.from(string, 'base64')` would silently produce garbage
  // bytes that look like a Buffer downstream, then crash sharp with
  // "Input buffer contains unsupported image format" on every reader.
  // Callers must fall back to a different field (e.g. photoData) when this
  // returns null.
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(value)) {
    log.warn(`[R2] bytesFromAnyImage: unsupported URL scheme "${value.slice(0, 40)}..." — returning null`);
    return null;
  }
  // Otherwise treat as raw base64
  try {
    return Buffer.from(value, 'base64');
  } catch (err) {
    log.warn(`[R2] bytesFromAnyImage decode failed: ${err.message}`);
    return null;
  }
}

/**
 * Delete every object under a given key prefix. Used by story-delete paths
 * to prune all R2 artefacts for a story (active scenes/covers, debug refs,
 * VB references, retry images, style-lab outputs — everything under
 * `stories/{storyId}/`).
 *
 * Idempotent: missing objects / empty prefix are no-ops. Returns the number
 * of objects actually deleted. Logs but does not throw on partial failure;
 * callers should not rely on R2 cleanup blocking DB deletion.
 *
 * Safety: caller MUST pass a prefix specific enough to avoid collateral
 * deletes. `stories/abc/` is fine; `stories/` would delete everything.
 * The function refuses to run on prefixes shorter than 12 chars or that
 * don't end with '/'.
 *
 * @param {string} prefix  e.g. "stories/job_1234.../"
 * @returns {Promise<number>} count of objects deleted (0 when not configured)
 */
async function deleteByPrefix(prefix) {
  if (!isConfigured()) return 0;
  if (typeof prefix !== 'string' || prefix.length < 12 || !prefix.endsWith('/')) {
    log.warn(`[R2] deleteByPrefix refused unsafe prefix: "${prefix}"`);
    return 0;
  }
  const client = getClient();
  const Bucket = process.env.R2_BUCKET;
  let total = 0;
  let ContinuationToken;
  try {
    do {
      const listed = await client.send(new ListObjectsV2Command({
        Bucket, Prefix: prefix, ContinuationToken, MaxKeys: 1000,
      }));
      const keys = (listed.Contents || []).map(o => ({ Key: o.Key }));
      if (keys.length > 0) {
        await client.send(new DeleteObjectsCommand({
          Bucket, Delete: { Objects: keys, Quiet: true },
        }));
        total += keys.length;
      }
      ContinuationToken = listed.IsTruncated ? listed.NextContinuationToken : null;
    } while (ContinuationToken);
    if (total > 0) log.info(`☁️  [R2] deleted ${total} objects under "${prefix}"`);
    return total;
  } catch (err) {
    log.warn(`[R2] deleteByPrefix(${prefix}) failed: ${err.message}`);
    return total;
  }
}

/**
 * Convenience: delete every R2 artefact for a story. Equivalent to
 * deleteByPrefix(`stories/{storyId}/`).
 */
async function deleteStoryArtefacts(storyId) {
  if (!storyId || typeof storyId !== 'string' || storyId.length < 4) return 0;
  return await deleteByPrefix(`stories/${storyId}/`);
}

/**
 * Fetch image bytes from a public R2 URL. Used when an endpoint needs the
 * actual bytes (e.g. text-overlay compositing, PDF rendering) but the row's
 * image_data column has been cleared post-migration.
 *
 * Returns Buffer on success, null on failure.
 */
async function fetchImageBytes(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log.warn(`[R2] fetchImageBytes ${url}: HTTP ${res.status}`);
      return null;
    }
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch (err) {
    log.warn(`[R2] fetchImageBytes ${url}: ${err.message}`);
    return null;
  }
}

module.exports = {
  isConfigured,
  uploadImage,
  fetchImageBytes,
  bytesFromAnyImage,
  deleteByPrefix,
  deleteStoryArtefacts,
  publicUrlForKey,
  keyForStoryImage,
  keyForRetryImage,
  keyForStyleLabImage,
  keyForCharacterPhoto,
  keyForCharacterAvatar,
  keyForCharacterStyledAvatar,
  keyForCharacterThumb,
  keyForVbReference,
  keyForGrokRef,
  keyForInpaintRef,
  keyForEntityGrid,
  keyForCharGrid,
  keyForBboxOverlay,
  keyForVbGrid,
  keyForRepairCompare,
  keyForStyledAvatarInput,
  keyForLandmarkPhoto,
  keyForStoryStyledAvatar,
  keyForStoryCostumedAvatar,
  keyForUserCharacterPhoto,
  keyForHistoricalLocationPhoto,
  keyForOrderPdf,
};
