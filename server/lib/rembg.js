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
 * The failure itself is NOT silent (owner, 2026-10-07): after the retry it
 * is reported at ERROR + failure_log (analyzer_remove_bg_failed), so a
 * caller's degraded cut-out is always traceable to the outage that caused it.
 */

const { log } = require('../utils/logger');
const { stripDataUriPrefix } = require('./r2');
const { analyzerJson, AnalyzerError, reportAnalyzerFailure } = require('./photoAnalyzerClient');

/**
 * One retry. The analyzer loads rembg lazily and the cold load runs past the
 * 60 s call budget, so the FIRST call after every deploy timed out and the
 * caller fell to a white-threshold cut-out - the whole sheet card pasted into
 * the page (Lab exp 1084, 2026-09-10). The second call lands on the model the
 * first one woke. A warm failure fails twice, quickly, and still returns null.
 */
async function rembgRemoveBackground(buf, opts = {}) {
  try {
    return await _rembgOnce(buf, opts);
  } catch (first) {
    log.warn(`[REMBG] ${first.message} — retrying once (the first call usually wakes a cold model)`);
  }
  try {
    return await _rembgOnce(buf, opts);
  } catch (err) {
    reportAnalyzerFailure('[REMBG] both attempts failed — caller degrades to its own cut-out', err);
    return null;
  }
}

async function _rembgOnce(buf, { maxSize } = {}) {
  const body = {
    image: `data:image/png;base64,${buf.toString('base64')}`,
    ...(maxSize ? { max_size: maxSize } : {}),
  };
  // retryRestart (analyzerFetch), not a bare fetch: the analyzer restarts
  // itself when idle to reclaim fragmentation, and this path has NO fallback
  // — a refused connection here is a failed photo upload in the user's face.
  const j = await analyzerJson('/remove-bg', body, { timeoutMs: 60000, retryRestart: true });
  const out = j.image || j.result || j.data;
  if (!out) throw new AnalyzerError('/remove-bg', 'answered without an image');
  return Buffer.from(stripDataUriPrefix(String(out)), 'base64');
}

module.exports = { rembgRemoveBackground };
