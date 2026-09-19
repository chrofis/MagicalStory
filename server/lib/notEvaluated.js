/**
 * NOT-EVALUATED RECORDS — "I had nothing to check" is part of a check's RESULT.
 *
 * Three checks shipped blind on 2026-09-14 and every one of them failed in
 * silence for weeks or months:
 *   - the batch quality judge received `[]` reference photos and no clothing
 *     contract (dead since the February character-storage normalisation);
 *   - a sheet's cell-identification reply was destroyed by a greedy regex, so
 *     the whole batch lost its reference pictures;
 *   - the head-row garment evaluator was handed the literal `{REQUESTED_OUTFIT}`.
 *
 * The common generator is not any one of those bugs. It is that **silence from
 * a check that ran clean and silence from a check that could not run are the
 * same signal.** The canonical example was already logging — evalPipeline's
 * "no clothing contract available — clothing findings suppressed (N-16)" — and
 * it still did not help, because the evaluation then returned a perfectly
 * normal score with nothing in the result, and nothing in the stored story,
 * saying that dimension was never judged.
 *
 * This module makes that absence structured, returned, and persisted.
 *
 * RECORDING ONLY. A `notEvaluated` entry is never a deduction. It must not
 * change `finalScore`, must not change a severity, and must not change which
 * pages enter repair — the owner measured page-score stacking on 2026-09-14
 * and deliberately left scoring as-is (docs/decisions.md). Nothing here reads
 * or writes a score, and nothing here throws: a check that had no input ships
 * with a warning, it never kills a paid run.
 */

/**
 * Create a recorder for one check invocation (one page, one stage).
 *
 * @param {{pageContext?: string, genLog?: object}} opts
 * @returns {{record: Function, list: Function, isEmpty: Function}}
 */
function createNotEvaluatedRecorder({ pageContext = '', genLog = null } = {}) {
  const entries = [];

  return {
    /**
     * Record that `dimension` went unjudged.
     *
     * @param {string} dimension the thing that was NOT judged — a short,
     *   machine-stable noun: 'clothing', 'identity', 'text_audit', ...
     * @param {string} reason a machine-stable snake_case cause, e.g.
     *   'no_clothing_contract'. Never a sentence — the sentence goes in
     *   `detail`, so a grep over stored stories stays stable when wording moves.
     * @param {string|null} detail human-readable extra context (optional).
     */
    record(dimension, reason, detail = null) {
      if (!dimension || !reason) return;
      const dim = String(dimension);
      const why = String(reason);
      // One entry per (dimension, reason): a check that loops over characters
      // must not write the same absence N times.
      if (entries.some(e => e.dimension === dim && e.reason === why)) return;
      const entry = {
        dimension: dim,
        reason: why,
        detail: detail == null ? null : String(detail),
        pageContext: pageContext || null,
      };
      entries.push(entry);
      // One generation-log event per absence, at warn level, so it is greppable
      // in a LIVE run as well as in stored data.
      try {
        const gl = genLog || require('./generationLogger').getCurrentLogger();
        gl?.warn?.(
          'check_not_evaluated',
          `${pageContext || 'page'}: "${dim}" was NOT evaluated (${why})${entry.detail ? ` — ${entry.detail}` : ''}`,
          null,
          entry
        );
      } catch { /* a recording channel never breaks the check it records */ }
    },

    /** @returns {Array<object>} a copy; `[]` when everything was judged. */
    list() {
      return entries.map(e => ({ ...e }));
    },

    isEmpty() {
      return entries.length === 0;
    },
  };
}

/**
 * Roll per-page records up into one report for `finalChecksReport`, so an
 * analyst reading `stories.data` can answer "which dimensions were never
 * judged, on which pages" without replaying the run's logs.
 *
 * Same contract as the sibling records (`repairRounds`, `shippedDefective`):
 * null when there is nothing to say, never an empty husk.
 *
 * @param {Array<{pageNumber?: number, notEvaluated?: Array<object>}>} pages
 * @returns {{recordedAt: string, entryCount: number, dimensions: string[], pages: Array}|null}
 */
function collectNotEvaluated(pages) {
  const rows = [];
  const dimensions = new Set();
  for (const p of (Array.isArray(pages) ? pages : [])) {
    const list = Array.isArray(p?.notEvaluated) ? p.notEvaluated : [];
    if (!list.length) continue;
    for (const e of list) if (e?.dimension) dimensions.add(String(e.dimension));
    rows.push({
      pageNumber: p.pageNumber ?? null,
      entries: list.map(e => ({
        dimension: e?.dimension ?? null,
        reason: e?.reason ?? null,
        detail: e?.detail ?? null,
      })),
    });
  }
  if (!rows.length) return null;
  return {
    recordedAt: new Date().toISOString(),
    entryCount: rows.reduce((n, r) => n + r.entries.length, 0),
    dimensions: [...dimensions].sort(),
    pages: rows,
  };
}

module.exports = { createNotEvaluatedRecorder, collectNotEvaluated };
