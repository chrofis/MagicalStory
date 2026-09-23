/**
 * eval_calls — one row per per-image judge call: the prompt it was sent and the
 * raw text it answered (migrations/041_eval_calls.sql).
 *
 * Kinds written today: 'quality', 'quality_cover', 'semantic', 'inventory',
 * 'plate_qc', 'iterate_rebrief'. Text only.
 *
 * The story id comes from the caller or, inside a pipeline run, from the job's
 * async scope (the same scope the styled-avatar cache runs under, whose id IS
 * the story id). Outside any story (a unit test, an ad-hoc script) nothing is
 * written. A failed write is logged and never fails the judge call it records.
 */

const { log } = require('../utils/logger');

function currentStoryId() {
  try {
    return require('./styledAvatars')._cacheContext?.getStore?.() || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} call
 * @param {string} call.kind
 * @param {string} call.prompt - the text sent
 * @param {string|null} [call.rawResponse]
 * @param {number|null} [call.pageNumber]
 * @param {string|null} [call.model]
 * @param {string|null} [call.label] - the call site's context label (e.g. "vantage-LOC001-aerial")
 * @param {string|null} [call.storyId] - defaults to the running job's scope
 */
function recordEvalCall({ kind, prompt, rawResponse = null, pageNumber = null, model = null, label = null, storyId = null } = {}) {
  const sid = storyId || currentStoryId();
  if (!sid || !kind || !prompt) return;
  let dbQuery;
  try {
    ({ dbQuery } = require('../services/database'));
  } catch (err) {
    log.warn(`[EVAL-CALLS] ${kind} p${pageNumber ?? '?'} not stored: ${err.message}`);
    return;
  }
  Promise.resolve()
    .then(() => dbQuery(
      `INSERT INTO eval_calls (story_id, page_number, kind, label, model, prompt, raw_response)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sid, pageNumber != null && Number.isFinite(Number(pageNumber)) ? Number(pageNumber) : null, String(kind), label ? String(label).slice(0, 120) : null, model ? String(model) : null,
        String(prompt), rawResponse == null ? null : String(rawResponse)]
    ))
    .catch(err => log.warn(`[EVAL-CALLS] ${kind} p${pageNumber ?? '?'} not stored: ${err.message}`));
}

module.exports = { recordEvalCall };
