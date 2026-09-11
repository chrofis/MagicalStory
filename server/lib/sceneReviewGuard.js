/**
 * Scene-review truncation guard (Test Lab).
 *
 * A review that came back empty, or that stopped exactly at the output-token
 * ceiling, is NOT a review — yet until 2026-09-11 the Lab harness kept every
 * untouched page's `fromBeats` as its "reviewed" brief and the hazard judge
 * measured it as reviewed. Experiments 1109/1121 (0 chars, out=16000) and
 * 1122/1124 (cut mid-output at out=16000) went unnoticed; #920 returned 0 chars
 * with no cap hit at all. These helpers make both failure kinds loud and
 * stop the downstream stage from consuming them.
 */

/**
 * Decide whether a scene review response is usable.
 *
 * @param {object} p
 * @param {string} p.text             raw model output
 * @param {number|null} p.outputTokens usage.output_tokens as reported
 * @param {string|null} p.stopReason  provider finish reason when exposed
 *                                    (Anthropic streams `stop_reason`)
 * @param {number|null} p.capInForce  the max-tokens ceiling the call actually
 *                                    ran under (model max when no numeric cap)
 * @param {number} p.parsedPageCount  pages the SCENES parser extracted
 * @returns {{ ok: boolean, error: string|null }}
 */
function assessSceneReview({ text, outputTokens = null, stopReason = null, capInForce = null, parsedPageCount = 0 }) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: `scene review returned an EMPTY response (${outputTokens ?? '?'} output tokens)` };
  }
  if (stopReason && /^(max_tokens|length|MAX_TOKENS)$/.test(String(stopReason))) {
    return { ok: false, error: `scene review TRUNCATED: stop_reason=${stopReason} at ${outputTokens ?? '?'} output tokens (cap ${capInForce ?? '?'})` };
  }
  if (capInForce != null && outputTokens != null && Number(outputTokens) >= Number(capInForce)) {
    return { ok: false, error: `scene review TRUNCATED: ${outputTokens} output tokens hit the ${capInForce}-token ceiling` };
  }
  // A review that produced substantial prose but no parseable SCENES block is
  // a format failure, not a "found nothing" — never let it pass as reviewed.
  if (parsedPageCount === 0 && trimmed.length > 2000 && !/no (changes|rewrites?|faults?)/i.test(trimmed.slice(-400))) {
    return { ok: false, error: `scene review returned ${trimmed.length} chars but the SCENES parser found 0 pages — format failure or cut-off` };
  }
  return { ok: true, error: null };
}

/**
 * Refuse to treat a beats_scenes result's `reviewedBrief`s as reviewed when
 * its scene review failed. Throws with the stored reason.
 */
function assertReviewedArtifactUsable(out, expId) {
  const sr = out && out.sceneReview;
  if (sr && sr.ok === false) {
    throw new Error(
      `fromExperiment ${expId}: artifact 'reviewed' refused — its scene review FAILED (${sr.error || 'no reason recorded'}); ` +
      `measure artifact=raw or rerun the review`
    );
  }
}

/**
 * Pick the brief the hazard judge should measure for one page of a
 * beats_scenes result.
 *
 * No `reviewer`: the primary reviewer's brief (`reviewedBrief`, else the raw
 * expansion) — the historical behaviour, guarded by assertReviewedArtifactUsable.
 * With `reviewer` (a TEXT_MODELS key): that reviewer's rewrite. The primary's
 * rewrites live in `reviewedBrief`; every other successful reviewer's live in
 * `reviewedBriefs[modelKey]` (stored once, never duplicated for the primary).
 * A reviewer that is absent from the experiment or whose review failed is
 * REFUSED — never silently swapped for the primary or the raw brief.
 */
function pickReviewedBrief(page, out, reviewer, expId) {
  if (!reviewer) return page.reviewedBrief || page.fromBeats;
  const reviews = Array.isArray(out && out.sceneReviews) ? out.sceneReviews : [];
  const review = reviews.find(r => r && r.modelKey === reviewer);
  if (!review) {
    throw new Error(`fromExperiment ${expId}: reviewer "${reviewer}" did not run on this experiment (reviewers: ${reviews.map(r => r && r.modelKey).filter(Boolean).join(', ') || 'none'})`);
  }
  if (review.ok === false) {
    throw new Error(`fromExperiment ${expId}: reviewer "${reviewer}" FAILED on this experiment (${review.error || 'no reason recorded'}) — nothing to measure as reviewed`);
  }
  const isPrimary = reviews[0] === review;
  const fixed = (page.reviewedBriefs && page.reviewedBriefs[reviewer]) || (isPrimary ? page.reviewedBrief : null);
  return fixed || page.fromBeats;
}

module.exports = { assessSceneReview, assertReviewedArtifactUsable, pickReviewedBrief };
