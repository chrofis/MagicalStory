'use strict';

// The text-side reports of a beats run, assembled ONCE.
//
// A full run stores them in stories.data (storyJobPipeline.js, the storyData
// object); a text-only run (skipImages, `POST /api/admin/jobs/:id/rerun-text`)
// stores the same keys, through the same function. Before this existed the
// text-only branch returned before any of them was read, so a plot rerun left
// no arc report, no panel findings and no beats report to diagnose from
// (docs/decisions.md 2026-11-07 "Text-only runs store the text-side reports").

/**
 * @param {object|null} beatsResult        generateStoryViaBeats() return (null on the trial writer)
 * @param {object}      [opts]
 * @param {Array}       [opts.scenePromptTable] rolled-up Art Director prompts (rollUpScenePrompts)
 * @returns {object} keys exactly as stories.data names them
 */
function collectTextSideReports(beatsResult, { scenePromptTable = [] } = {}) {
  const b = beatsResult || {};
  const call = b.meta?.storyTextCall;
  return {
    // Drafted arc + the arc reviewer's analysis (panel findings, re-telling rounds, STORY LOGIC).
    arcReviewReport: b.arcReviewReport || null,
    challengeDrawIds: b.challengeDrawIds || null,
    challengeTakenIds: b.challengeTakenIds || null,
    challengeDraw: b.challengeDraw || null,
    challengeSelection: b.challengeSelection || null,
    // Per-page before/after of the beats review.
    beatsReviewReport: b.beatsReviewReport || null,
    jevDecisions: b.jevDecisions || null,
    jevFallback: b.jevFallback || null,
    storyBibleReport: b.storyBibleReport || null,
    clothingReviewReport: b.clothingReviewReport || null,
    wardrobeBibleReport: b.wardrobeBibleReport || null,
    briefCheckReport: b.briefCheckReport || null,
    sceneExpansionReport: { ...(b.sceneExpansionReport || {}), prompts: scenePromptTable },
    // The page-text writer's own call (beats writes every page in one call).
    storyTextPrompts: call
      ? [{
        batch: 1,
        startPage: call.startPage,
        endPage: call.endPage,
        prompt: call.prompt,
        rawResponse: call.rawResponse,
        analysis: call.analysis,
        modelId: call.modelId,
        usage: call.usage,
      }]
      : [],
  };
}

/**
 * Merge a text-only run's text-side document into the (pre-created, empty)
 * stories row. A JSONB merge on `data` ONLY: `metadata` stays untouched, so the
 * run does not become a library entry (the library reads metadata), and the
 * existing readers of stories.data (GET /api/stories/:id/metadata, the Test Lab
 * replay stages) find the arc / beats reports where they look for a full run's.
 * A missing row is an error, not a silent no-op: ensureStoryRow ran at job start.
 *
 * @param {{query: Function}} pool
 * @param {string} storyId   the job id (a story's id IS its job id)
 * @param {object} doc
 */
async function saveTextOnlyStoryData(pool, storyId, doc) {
  const r = await pool.query(
    `UPDATE stories SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb WHERE id = $1 RETURNING id`,
    [storyId, JSON.stringify(doc)]
  );
  if (r.rowCount === 0) throw new Error(`saveTextOnlyStoryData: no stories row for ${storyId}`);
}

module.exports = { collectTextSideReports, saveTextOnlyStoryData };
