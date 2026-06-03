/**
 * Image metadata stripping.
 *
 * User-uploaded photos (real children's faces in this app) carry EXIF
 * by default — GPS coordinates, camera model, timestamps. Storing those
 * alongside Swiss-landmark-themed story metadata is a deanonymization
 * surface in any data breach.
 *
 * sharp() strips ALL metadata by default — unless `.withMetadata()` is
 * called. Running an uploaded image through sharp() once is sufficient.
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');

/**
 * Re-encode a base64 data URI through sharp to strip EXIF + other metadata.
 * Idempotent: re-stripping an already-stripped image is a no-op (just a
 * re-encode). Returns the original value unchanged if it's not a valid
 * data URI we can decode.
 *
 * @param {string} dataUri - data:image/<format>;base64,<bytes>
 * @returns {Promise<string>} same shape, with metadata removed
 */
async function stripExif(dataUri) {
  if (!dataUri || typeof dataUri !== 'string') return dataUri;
  if (!dataUri.startsWith('data:image/')) return dataUri;

  const match = dataUri.match(/^data:image\/([\w+-]+);base64,(.+)$/);
  if (!match) return dataUri;

  const [, mime, b64] = match;
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return dataUri;
  }

  const isPng = mime.toLowerCase() === 'png';
  try {
    const out = isPng
      ? await sharp(buf).png().toBuffer()
      : await sharp(buf).jpeg({ quality: 95 }).toBuffer();
    const outMime = isPng ? 'png' : 'jpeg';
    return `data:image/${outMime};base64,${out.toString('base64')}`;
  } catch (err) {
    log.warn(`[imageMetadata] stripExif failed (${err.message}), returning original`);
    return dataUri;
  }
}

/**
 * Strip EXIF from every value in a photos object (face, body, bodyNoBg, ...).
 * Non-string / non-data-URI values pass through. Returns a NEW object —
 * does not mutate the input.
 */
async function stripExifFromPhotos(photos) {
  if (!photos || typeof photos !== 'object') return photos;
  const stripped = {};
  for (const [key, value] of Object.entries(photos)) {
    if (typeof value === 'string' && value.startsWith('data:image/')) {
      stripped[key] = await stripExif(value);
    } else {
      stripped[key] = value;
    }
  }
  return stripped;
}

module.exports = { stripExif, stripExifFromPhotos };
