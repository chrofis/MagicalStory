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

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
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

module.exports = {
  isConfigured,
  uploadImage,
  publicUrlForKey,
  keyForStoryImage,
  keyForRetryImage,
  keyForStyleLabImage,
  keyForCharacterPhoto,
};
