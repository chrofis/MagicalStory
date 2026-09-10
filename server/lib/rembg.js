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
const { photoAnalyzerUrl } = require('./photoAnalyzerClient');

const PHOTO_ANALYZER_URL = photoAnalyzerUrl();

/**
 * One retry. The analyzer loads rembg lazily and the cold load runs past the
 * 60 s call budget, so the FIRST call after every deploy timed out and the
 * caller fell to a white-threshold cut-out - the whole sheet card pasted into
 * the page (Lab exp 1084, 2026-09-10). The second call lands on the model the
 * first one woke. A warm failure fails twice, quickly, and still returns null.
 */
async function rembgRemoveBackground(buf, opts = {}) {
  const first = await _rembgOnce(buf, opts);
  if (first) return first;
  log.warn('[REMBG] retrying once (the first call usually wakes a cold model)');
  return _rembgOnce(buf, opts);
}

async function _rembgOnce(buf, { maxSize } = {}) {
  try {
    const body = {
      image: `data:image/png;base64,${buf.toString('base64')}`,
      ...(maxSize ? { max_size: maxSize } : {}),
    };
    // analyzerFetch, not fetch: the analyzer restarts itself when idle to
    // reclaim fragmentation, and this path has NO fallback — a refused
    // connection here is a failed photo upload in the user's face.
    const { analyzerFetch } = require('./analyzerClient');
    const r = await analyzerFetch('/remove-bg', {
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
