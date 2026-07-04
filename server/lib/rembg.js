/**
 * Shared rembg (background removal) HTTP call.
 *
 * Leaf-ish module: only depends on ./r2 for stripDataUriPrefix and
 * ../utils/logger. The rembg service call is the shared part; each caller
 * supplies its own fallback (chroma-key, white-threshold, etc.) because
 * those genuinely differ per use case.
 *
 * Returns a decoded PNG Buffer on success, or null on any failure (non-ok
 * response, missing/failed payload, or network exception). Callers must
 * handle null by running their own fallback — this function never throws.
 */

const { log } = require('../utils/logger');
const { stripDataUriPrefix } = require('./r2');

const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

async function rembgRemoveBackground(buf, { maxSize } = {}) {
  try {
    const body = {
      image: `data:image/png;base64,${buf.toString('base64')}`,
      ...(maxSize ? { max_size: maxSize } : {}),
    };
    const r = await fetch(`${PHOTO_ANALYZER_URL}/remove-bg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      log.warn(`[REMBG] rembg returned ${r.status}`);
      return null;
    }
    const j = await r.json();
    const out = j.image || j.result || j.data;
    if (j.success === false || !out) {
      log.warn('[REMBG] rembg returned no usable image');
      return null;
    }
    return Buffer.from(stripDataUriPrefix(String(out)), 'base64');
  } catch (err) {
    log.warn(`[REMBG] rembg call failed: ${err.message}`);
    return null;
  }
}

module.exports = { rembgRemoveBackground };
