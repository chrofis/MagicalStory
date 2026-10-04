/**
 * Reading the scene review's STORED Test Lab artifacts.
 *
 * The scene review is deleted (docs/decisions.md 2026-09-28 "The scene review
 * is deleted"); beats_scenes experiments stored before then still carry
 * `reviewedBrief` / `reviewedBriefs` and their review's `ok` / `error`. A
 * `fromExperiment` read of those artifacts goes through these two guards: a
 * failed review (experiments 1109/1121 came back empty, 1122/1124 cut at the
 * output cap) is refused rather than measured as reviewed.
 */

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


module.exports = { assertReviewedArtifactUsable, pickReviewedBrief };
