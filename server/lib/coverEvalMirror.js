/**
 * ONE mirror of the pipeline's per-image eval record onto a cover record.
 *
 * "Cover and normal pages must be the same." A cover IS a page in the repair
 * pipeline: it enters `rawImages` with pageNumber -1/-2/-3, runs the identical
 * evaluate → regen → pick-best → character-fix loop, and comes out of
 * `repairPipeline`'s page mapping with the identical field set. Pages are then
 * stored as that mapped record verbatim; covers were copied back into
 * `data.coverImages[key]` by a HAND-LISTED assignment block in
 * storyJobPipeline.js, and that list went stale.
 *
 * Measured on staging (2026-09-14, 25 most recent stories): 61 stored cover
 * roots, 0 carrying `threeStageResult` — while 78 of 78 of those same covers'
 * VERSION records carry one. The prompt-compliance stage has run on covers
 * since 4e36d92fd (2026-06-28) and its findings already merge into the cover's
 * fixableIssues and its finalScore; only the cover ROOT lost the evidence. Same
 * for `qualityRawOutput`, `evalTemplateHash`, `identityAgreement`,
 * `unrepairedCritical` and `notEvaluated` — every one of them present on the
 * page record of the same story, absent on all three covers.
 *
 * So this is a persistence whitelist, not an evaluator gate: nothing new is
 * called, no extra paid model request, no cover reaches a repair route it did
 * not already reach (the char-fix / clothing / inpaint gates are all
 * `pageNumber > 0`). What changes is that a stored cover can now answer "what
 * did the compliance judge say" without digging into imageVersions.
 *
 * The list is exported so the guard test can hold it against a REAL stored page
 * record: any eval field a page carries and this list omits is a drift.
 */

/**
 * Every field the repair pipeline's page mapping stamps that describes the
 * EVALUATION of the shipped image. Image bytes, versions and the scene contract
 * are handled separately by the caller (they have cover-specific rules).
 */
const COVER_EVAL_MIRROR_FIELDS = [
  // Scores — canonical mirrors of the picked version.
  'qualityScore',
  'finalScore',
  'semanticScore',
  // Verbatim evaluator output.
  'qualityReasoning',
  'qualityRawOutput',
  'evalTemplateHash',
  'issuesSummary',
  'semanticResult',
  // The prompt-compliance judge's record. Ran on covers all along; never stored.
  'threeStageResult',
  // Findings.
  'fixTargets',
  'fixableIssues',
  'unrepairedCritical',
  // Dimensions the evaluator could NOT judge (null = never evaluated, [] = clean).
  'notEvaluated',
  // Detection + identity.
  'bboxDetection',
  'bboxOverlayImage',
  'figures',
  'matches',
  'identityAgreement',
];

/**
 * Copy the pipeline's eval record for one image onto a cover record, in place.
 *
 * @param {object} coverRecord - data.coverImages[key], mutated
 * @param {object} img - the repair pipeline's mapped image record for that cover
 * @returns {object} the same coverRecord
 */
function applyCoverEvalMirror(coverRecord, img) {
  if (!coverRecord || typeof coverRecord !== 'object') return coverRecord;
  const src = img && typeof img === 'object' ? img : {};
  for (const field of COVER_EVAL_MIRROR_FIELDS) {
    // `?? null` and never a skip-if-absent: an eval field missing from the
    // pipeline result must clear the previous round's value on the cover, or a
    // repaired cover keeps a stale finding from the image it replaced.
    coverRecord[field] = src[field] ?? null;
  }
  return coverRecord;
}

module.exports = { COVER_EVAL_MIRROR_FIELDS, applyCoverEvalMirror };
