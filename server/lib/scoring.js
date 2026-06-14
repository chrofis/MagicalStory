/**
 * Image scoring — single source of truth.
 *
 * Every image (scene page or cover) goes through up to four evaluators:
 *
 *   visual      — Gemini quality eval (composition, lighting, anatomy).
 *                 Always runs. Range 0–100.
 *
 *   semantic    — Story-text fidelity eval. Scenes only (covers have no
 *                 narrative text to compare against). Range 0–100, null
 *                 when not evaluated.
 *
 *   threeStage  — Vision-inventory + Sonnet-compliance eval. Scenes only
 *                 (gated by evaluationType === 'scene' in evaluateImageQuality).
 *                 Range 0–100, null when not evaluated.
 *
 *   entity      — Per-character consistency check across pages. Returns
 *                 issues at critical/major/minor severity. Penalty:
 *                 30 / 20 / 10 per issue. Scenes only.
 *
 * The scoring chain produces a single number per version:
 *
 *   evalScore  = visual − semanticPenalty − threeStagePenalty
 *   finalScore = evalScore − entityPenalty
 *
 * The penalty formulas are encoded in the eval functions themselves
 * (semanticPenalty inside the semantic eval, etc.) — by the time we get
 * here, `visual` already has them subtracted (= `evalScore`). We keep
 * `entity` separate because entity penalties can be added or revised
 * by a re-run of entity consistency, after the visual eval.
 *
 * COVERS vs SCENES: same fields, same helper, same picker. Covers just
 * have null for semantic/threeStage and zero entity penalty — they
 * naturally collapse to `finalScore = visual`.
 *
 * VERSION SHAPE on the wire:
 *
 *   version = {
 *     ...existing fields,
 *     evalScore,                      // number (visual − semantic − threeStage penalties)
 *     entityPenalty,                  // number (0 if no entity issues)
 *     finalScore,                     // number = evalScore − entityPenalty
 *     scoreBreakdown: {
 *       visual:     { score, reasoning, issues: [...] },
 *       semantic:   { score, issues: [...] } | null,
 *       threeStage: { score, issues: [...] } | null,
 *       entity:     { penalty, issues: [...] },
 *     },
 *   }
 *
 * For LEGACY versions written before this module existed, computeFinalScore
 * falls back through the old field names: finalScore → evalScore → score
 * → qualityScore. Same chain everywhere. No more divergence.
 */

const { setActiveVersion } = require('../services/database');
const { arrayToDbIndex } = require('./versionManager');
const { log } = require('../utils/logger');

// =====================================================================
// NEW DEDUCTIONS-FIRST MODEL (May 2026 redesign)
// ---------------------------------------------------------------------
// One canonical version shape. Each evaluator produces ISSUES with a
// severity. We sum the severity points into a math final score. The
// consolidator (when it runs) emits a tolerant deduplicated score.
// ONE flag picks which one becomes `version.finalScore`.
//
//   deductions = {
//     quality:    [{severity, description, type, ...}, …],   // image-evaluation.txt
//     semantic:   [{severity, description, ...}, …],          // image-semantic.txt
//     compliance: [{severity, description, ...}, …],          // image-prompt-compliance.txt
//     entity:     [{severity, description, name, ...}, …],    // entityConsistency.js
//   }
//
//   mathFinalScore   = max(0, 100 − Σ SEVERITY_POINTS[d.severity])
//   promptFinalScore = consolidator's tolerant deduplicated score (0–100), or null
//   finalScore       = (scoreModel === 'prompt' && promptFinalScore != null) ? promptFinalScore : mathFinalScore
//
// Writers call `applyScore(version, {evalResult, entityResult, complianceResult, promptFinalScore, scoreModel})`
// — single entry point. Readers (`findBadPages`, `pickBestVersionIndex`)
// read `version.finalScore` only.
//
// Severity points calibrated for tolerance — minor wobbles shouldn't
// trip the redo gate.
// =====================================================================
const SEVERITY_POINTS = {
  catastrophic: 50,
  critical:     25,
  major:        15,
  moderate:      5,
  minor:         2,
};

/**
 * Normalize a list of raw evaluator issues into the deductions shape.
 * Filters out anything without a severity.
 */
function normalizeIssues(rawIssues, source) {
  if (!Array.isArray(rawIssues)) return [];
  const out = [];
  for (const it of rawIssues) {
    if (!it || typeof it !== 'object') continue;
    const sev = String(it.severity || '').toLowerCase();
    if (!SEVERITY_POINTS[sev]) continue; // unknown severity → drop
    out.push({
      severity: sev,
      description: it.description || it.problem || it.issue || '',
      type: it.type || it.category || null,
      name: it.character || it.name || it.element || null,
      source,
    });
  }
  return out;
}

/**
 * Build the deductions structure from evaluator outputs. Each input is
 * the raw eval result; the helper extracts the issues lists and normalizes.
 *
 * @param {object} params
 * @param {object} [params.evalResult]       output of evaluateImageQuality (has fixableIssues, semanticResult, threeStageResult)
 * @param {object} [params.entityResult]     { issues: [{name, severity, description, ...}], ... }
 * @returns {{quality, semantic, compliance, entity}}
 */
function composeDeductions({ evalResult = null, entityResult = null } = {}) {
  const quality    = normalizeIssues(evalResult?.fixableIssues, 'quality');
  const semantic   = normalizeIssues(evalResult?.semanticResult?.semanticIssues, 'semantic');
  const compliance = normalizeIssues(evalResult?.threeStageResult?.fixableIssues
                                  || evalResult?.threeStageResult?.issues, 'compliance');
  const entity     = normalizeIssues(entityResult?.issues, 'entity');
  return { quality, semantic, compliance, entity };
}

/**
 * Sum severity points across every category and clamp 100−sum to [0, 100].
 */
function computeMathFinalScore(deductions) {
  if (!deductions || typeof deductions !== 'object') return 100;
  let total = 0;
  for (const cat of ['quality', 'semantic', 'compliance', 'entity']) {
    const list = deductions[cat] || [];
    for (const d of list) total += SEVERITY_POINTS[d.severity] || 0;
  }
  return Math.max(0, Math.min(100, 100 - total));
}

/**
 * Single entry point that mutates a version with the canonical scoring
 * fields. Writers call this; readers read `version.finalScore`.
 *
 * @param {object} version  mutated in place
 * @param {object} params
 * @param {object} [params.evalResult]     evaluateImageQuality output
 * @param {object} [params.entityResult]   { penalty, issues } from getEntityPenaltyAndIssues
 * @param {number|null} [params.promptFinalScore]   consolidator's final_score (null if no consolidator ran)
 * @param {'prompt'|'math'} [params.scoreModel='prompt']
 */
function applyScore(version, { evalResult = null, entityResult = null, promptFinalScore = null, scoreModel = 'prompt' } = {}) {
  if (!version || typeof version !== 'object') return;
  const deductions = composeDeductions({ evalResult, entityResult });
  const mathFinalScore = computeMathFinalScore(deductions);
  const usePrompt = scoreModel === 'prompt' && typeof promptFinalScore === 'number';
  const finalScore = usePrompt ? promptFinalScore : mathFinalScore;

  // Canonical fields written by the single writer.
  version.deductions = deductions;
  version.mathFinalScore = mathFinalScore;
  version.promptFinalScore = (typeof promptFinalScore === 'number') ? promptFinalScore : null;
  version.finalScore = finalScore;
  version.scoreModel = scoreModel;

  // scoreBreakdown — per-evaluator card for the dev panel's breakdown view.
  // Built from the same evalResult so it stays consistent with deductions.
  // Shape: { visual: {score, reasoning, issues}, semantic: {...}|null, threeStage: {...}|null, entity: {penalty, issues} }
  version.scoreBreakdown = _buildBreakdownFromEvalResult(evalResult, entityResult);

  // evalScore (pre-entity) + entityPenalty kept as separate fields so an
  // entity-only re-run can recompute finalScore without re-running visual.
  // The previous evalScore math (MIN of visual/semantic/threeStage subscores
  // from composeEvalScore) was the legacy behavior; new model derives
  // evalScore from deductions ÷ entity-penalty split.
  const entityPoints = (deductions.entity || []).reduce((s, d) => s + (SEVERITY_POINTS[d.severity] || 0), 0);
  version.entityPenalty = entityPoints;
  version.evalScore = Math.max(0, Math.min(100, finalScore + entityPoints));

  // Info-level visibility for threshold calibration. Without this, prod logs
  // show "page X scored Y" with no indication whether Y came from the
  // consolidator (lenient) or the math fallback (conservative) — meaning the
  // 60-threshold can't be tuned from logs alone.
  const pn = version.pageNumber != null ? `page ${version.pageNumber}` : 'version';
  log.info(`[SCORE] ${pn}: ${scoreModel} model → finalScore=${finalScore} (math=${mathFinalScore}, prompt=${promptFinalScore}, entity=−${entityPoints})`);

  return version;
}

/**
 * Internal helper: derive a scoreBreakdown from an evaluator output + entity
 * result. Lives next to applyScore so the single writer owns both layouts
 * (deductions + breakdown) from the same input.
 *
 * @param {object|null} evalResult     evaluateImageQuality output
 * @param {object|null} entityResult   { penalty, issues } from getEntityPenaltyAndIssues
 */
function _buildBreakdownFromEvalResult(evalResult, entityResult) {
  const visual = evalResult ? {
    score: typeof evalResult.qualityScore === 'number'
      ? evalResult.qualityScore
      : (typeof evalResult.score === 'number' ? evalResult.score : 0),
    reasoning: evalResult.reasoning || null,
    issues: Array.isArray(evalResult.fixableIssues) ? evalResult.fixableIssues : [],
  } : { score: 0, reasoning: null, issues: [] };
  const semantic = evalResult?.semanticResult ? {
    score: typeof evalResult.semanticResult.score === 'number' ? evalResult.semanticResult.score : 0,
    issues: Array.isArray(evalResult.semanticResult.semanticIssues) ? evalResult.semanticResult.semanticIssues : [],
  } : null;
  const threeStage = evalResult?.threeStageResult ? {
    score: typeof evalResult.threeStageResult.score === 'number' ? evalResult.threeStageResult.score : 0,
    issues: Array.isArray(evalResult.threeStageResult.fixableIssues) ? evalResult.threeStageResult.fixableIssues : [],
  } : null;
  const entity = entityResult ? {
    penalty: Number(entityResult.penalty) || 0,
    issues: Array.isArray(entityResult.issues) ? entityResult.issues : [],
  } : { penalty: 0, issues: [] };
  return { visual, semantic, threeStage, entity };
}

/**
 * Emit a per-story summary of which scoreModel produced each version's
 * finalScore. Call once at story completion so we can see the mix in logs
 * without grepping per-page lines.
 *
 * @param {string} storyId
 * @param {Array<{scoreModel?: string}>} versions  Flat list of all scored versions
 */
function logScoreModelSummary(storyId, versions) {
  if (!Array.isArray(versions) || versions.length === 0) return;
  const counts = { prompt: 0, math: 0, unknown: 0 };
  for (const v of versions) {
    const m = v?.scoreModel;
    if (m === 'prompt') counts.prompt++;
    else if (m === 'math') counts.math++;
    else counts.unknown++;
  }
  const total = versions.length;
  const pct = (n) => Math.round((n / total) * 100);
  log.info(`[SCORE-SUMMARY] story ${storyId}: ${total} versions scored — ${pct(counts.prompt)}% prompt, ${pct(counts.math)}% math${counts.unknown ? `, ${pct(counts.unknown)}% unknown` : ''}`);
}



/**
 * Pick the score that represents this version's quality, in canonical
 * priority. Returns null when the version has no score at all (un-evaluated).
 *
 * @param {object} version
 * @returns {number|null}
 */
function computeFinalScore(version) {
  if (!version || typeof version !== 'object') return null;
  // New shape (May 2026): applyScore wrote finalScore directly. Trust it.
  // mathFinalScore + promptFinalScore are stored alongside for audit.
  if (typeof version.finalScore === 'number') return version.finalScore;
  // Older shape: evalScore + entityPenalty separate, no finalScore field.
  if (typeof version.evalScore === 'number') {
    return version.evalScore - (Number(version.entityPenalty) || 0);
  }
  // Legacy shapes — `score` and `qualityScore` are duplicates here, both
  // representing the visual − semantic − threeStage composite (the entity
  // penalty was computed separately and never folded in).
  const fallback =
    (typeof version.score === 'number' ? version.score : null) ??
    (typeof version.qualityScore === 'number' ? version.qualityScore : null);
  if (fallback == null) return null;
  return fallback - (Number(version.entityPenalty) || 0);
}

// Canonical severity → weight for the un-clamped ranking tiebreak below.
const RANK_SEVERITY_WEIGHT = { CATASTROPHIC: 50, CRITICAL: 30, MAJOR: 20, MODERATE: 10, MINOR: 5 };

/**
 * Un-clamped total weighted deduction for a version, summed across every
 * evaluator's issue list + the entity penalty. This is the RANKING signal
 * that the clamped 0–100 finalScore throws away: once a page accrues >10
 * deduction points its finalScore pins to 0, and several failing candidates
 * all read 0 — so pick-best can no longer tell them apart and selection
 * collapses to "earliest version" (pure luck). This number keeps growing
 * past the 0 floor, so the candidate with the FEWEST / LIGHTEST issues still
 * ranks above a more-broken one even when all of them score 0.
 *
 * Lower is better. Returns Infinity when the version has no scoreable data
 * so it never wins a tiebreak by accident.
 */
function versionDeductionTotal(version) {
  if (!version || typeof version !== 'object') return Infinity;
  let total = 0;
  let sawAny = false;
  const addIssues = (issues) => {
    if (!Array.isArray(issues)) return;
    for (const i of issues) {
      sawAny = true;
      total += RANK_SEVERITY_WEIGHT[String(i?.severity || '').toUpperCase()] ?? 10;
    }
  };
  const bd = version.scoreBreakdown;
  if (bd) {
    addIssues(bd.visual?.issues);
    addIssues(bd.semantic?.issues);
    addIssues(bd.threeStage?.issues);
    if (typeof bd.entity?.penalty === 'number') { total += bd.entity.penalty; sawAny = true; }
  } else {
    // Fallback to the flat fields a version carries before applyScore folds
    // them into a breakdown.
    addIssues(version.fixableIssues);
    addIssues(version.semanticResult?.semanticIssues || version.semanticResult?.issues);
    if (typeof version.entityPenalty === 'number') { total += version.entityPenalty; sawAny = true; }
  }
  return sawAny ? total : Infinity;
}

/**
 * Build the canonical scoreBreakdown structure from an evaluator output.
 * Used by evaluateImageQuality + re-evaluate endpoint so the version object
 * has a uniform shape regardless of which path produced it.
 *
 * Inputs are nullable — covers pass null for semantic/threeStage.
 *
 * @param {object} params
 * @param {{score: number, reasoning?: string, issues?: any[]}} params.visual
 * @param {{score: number, issues?: any[]}|null} [params.semantic]
 * @param {{score: number, issues?: any[]}|null} [params.threeStage]
 * @param {{penalty: number, issues?: any[]}|null} [params.entity]
 * @returns {object} scoreBreakdown
 */
function buildScoreBreakdown({ visual, semantic = null, threeStage = null, entity = null } = {}) {
  return {
    visual: visual ? {
      score: Number(visual.score) || 0,
      reasoning: visual.reasoning || null,
      issues: Array.isArray(visual.issues) ? visual.issues : [],
    } : { score: 0, reasoning: null, issues: [] },
    semantic: semantic ? {
      score: Number(semantic.score) || 0,
      issues: Array.isArray(semantic.issues) ? semantic.issues : [],
    } : null,
    threeStage: threeStage ? {
      score: Number(threeStage.score) || 0,
      issues: Array.isArray(threeStage.issues) ? threeStage.issues : [],
    } : null,
    entity: entity ? {
      penalty: Number(entity.penalty) || 0,
      issues: Array.isArray(entity.issues) ? entity.issues : [],
    } : { penalty: 0, issues: [] },
  };
}

/**
 * Compose evalScore from a breakdown. evalScore is the score AFTER visual,
 * semantic, and three-stage penalties — but BEFORE entity penalty.
 *
 * The evaluator functions return penalised numbers directly (semantic eval
 * already subtracts its own penalty internally, etc.), so the canonical
 * "after non-entity penalties" number is the MIN of the three available
 * subscores. This matches what evaluateImageQuality has always returned
 * as `score`: take the worst of the parallel evaluators.
 *
 * @param {object} breakdown
 * @returns {number}
 */
function composeEvalScore(breakdown) {
  if (!breakdown) return 0;
  const candidates = [];
  if (breakdown.visual && typeof breakdown.visual.score === 'number') candidates.push(breakdown.visual.score);
  if (breakdown.semantic && typeof breakdown.semantic.score === 'number') candidates.push(breakdown.semantic.score);
  if (breakdown.threeStage && typeof breakdown.threeStage.score === 'number') candidates.push(breakdown.threeStage.score);
  if (candidates.length === 0) return 0;
  return Math.max(0, Math.min(...candidates));
}

/**
 * Compute the canonical final score from a breakdown. evalScore − entity penalty.
 *
 * @param {object} breakdown
 * @returns {number}
 */
function composeFinalScore(breakdown) {
  if (!breakdown) return 0;
  const evalScore = composeEvalScore(breakdown);
  const entityPenalty = (breakdown.entity && Number(breakdown.entity.penalty)) || 0;
  return Math.max(0, evalScore - entityPenalty);
}

/**
 * Stamp the canonical score fields on a version object from a breakdown.
 * Mutates `version` in place. Both the unified pipeline and the
 * re-evaluate endpoint call this — single point where evalScore /
 * entityPenalty / finalScore land on the version.
 *
 * @param {object} version
 * @param {object} breakdown
 */
/**
 * Single source of truth for writing scoring fields onto a version
 * object. Used by every code path that produces a new version (the
 * round-loop push in images.js, applyScoreBreakdown below, the
 * regeneration routes). Keeps finalScore SIGNED — clamping to 0
 * collapses "marginal" and "broken" into the same value and the
 * picker's later-wins-ties rule then promotes the broken one.
 */
function setVersionScores(version, evalScore, entityPenalty) {
  if (!version || typeof version !== 'object') return;
  version.evalScore = evalScore;
  version.entityPenalty = (Number(entityPenalty) || 0);
  version.finalScore = (typeof evalScore === 'number')
    ? evalScore - version.entityPenalty
    : null;
}

function applyScoreBreakdown(version, breakdown) {
  if (!version || typeof version !== 'object') return;
  version.scoreBreakdown = breakdown;
  const evalScore = composeEvalScore(breakdown);
  const entityPenalty = (breakdown && breakdown.entity && Number(breakdown.entity.penalty)) || 0;
  setVersionScores(version, evalScore, entityPenalty);
}

/**
 * Pick the best version index out of an `imageVersions[]` array.
 * Tie-break: HIGHER index wins (newer version preferred when scores tie),
 * because newer versions usually incorporate later repair work.
 *
 * Returns -1 when no version has a non-null score (e.g. all just-pushed,
 * un-evaluated). Caller should leave activeVersion alone in that case.
 *
 * @param {Array<object>} versions
 * @returns {number} index in versions[], or -1 when none scoreable
 */
function pickBestVersionIndex(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return -1;
  let bestIdx = -1;
  let bestScore = -Infinity;
  let bestDeduction = Infinity;
  for (let i = 0; i < versions.length; i++) {
    const s = computeFinalScore(versions[i]);
    if (s == null) continue;
    const ded = versionDeductionTotal(versions[i]);
    // Primary: clamped finalScore (higher better). Tiebreak when the clamped
    // scores are equal — typically several candidates pinned at 0: prefer the
    // one with the smallest un-clamped deduction total (fewest/lightest
    // issues), which the 0-floor erased. Final tiebreak: later index wins.
    if (s > bestScore || (s === bestScore && ded <= bestDeduction)) {
      bestScore = s;
      bestDeduction = ded;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Recompute and persist the active version for a scene or cover, based on
 * the canonical pickBestVersionIndex. Call this immediately after any code
 * path that pushed a new version, so the activeVersion marker reflects
 * actual quality rather than "last-pushed".
 *
 * Safe to call when no version has a score yet — falls back to leaving the
 * existing activeVersion alone.
 *
 * @param {string} storyId
 * @param {number|string} key  pageNumber for scenes, coverType for covers
 * @param {Array<object>} versions  imageVersions[] from the blob
 * @param {string} type  'scene' | 'frontCover' | 'initialPage' | 'backCover'
 *                       (used for arrayToDbIndex mapping)
 * @returns {Promise<{activeIndex: number, finalScore: number|null}|null>}
 */
async function recomputeActiveVersion(storyId, key, versions, type = 'scene') {
  const idx = pickBestVersionIndex(versions || []);
  if (idx < 0) return null;
  // arrayToDbIndex maps blob array index → DB version_index. For scenes
  // it's identity; for covers there's a +1 offset historically.
  const dbIdx = arrayToDbIndex(idx, type);
  await setActiveVersion(storyId, key, dbIdx);
  return { activeIndex: idx, finalScore: computeFinalScore(versions[idx]) };
}

/**
 * Walk every scene + cover in a story blob, recompute and persist the
 * canonical activeVersion for each. Single hook that every save path
 * (saveStoryData, upsertStory, the regen routes) calls so "newest stamped
 * as active" never out-runs scoring.
 *
 * Returns a small summary of any changes for logging.
 *
 * @param {string} storyId
 * @param {object} storyData  shape: { sceneImages: [...], coverImages: { frontCover, initialPage, backCover } }
 * @returns {Promise<{scenes: number, covers: number, switches: number}>}
 */
async function recomputeAllActiveVersions(storyId, storyData) {
  if (!storyId || !storyData) return { scenes: 0, covers: 0, switches: 0 };
  let scenes = 0, covers = 0, switches = 0;

  if (Array.isArray(storyData.sceneImages)) {
    for (const s of storyData.sceneImages) {
      if (!s?.pageNumber || !Array.isArray(s.imageVersions) || s.imageVersions.length === 0) continue;
      const r = await recomputeActiveVersion(storyId, s.pageNumber, s.imageVersions, 'scene');
      scenes++;
      if (r) {
        switches++;
        // Mirror the canonical active version onto the JSONB blob too. Without
        // this, stories.data.sceneImages[N].activeVersion stays undefined and
        // any client/code path that reads from the blob (instead of from the
        // image_version_meta column) falls back to "last index" — see staging
        // story job_1778925296736 where every page's blob activeVersion was
        // undefined while the meta correctly tracked the best version.
        s.activeVersion = r.activeIndex;
      }
    }
  }
  if (storyData.coverImages && typeof storyData.coverImages === 'object') {
    for (const kind of ['frontCover', 'initialPage', 'backCover']) {
      const cv = storyData.coverImages[kind];
      if (!cv?.imageVersions || cv.imageVersions.length === 0) continue;
      const r = await recomputeActiveVersion(storyId, kind, cv.imageVersions, kind);
      covers++;
      if (r) {
        switches++;
        cv.activeVersion = r.activeIndex;
      }
    }
  }
  return { scenes, covers, switches };
}

const SCORE_THRESHOLDS = {
  // Pages scoring below this trigger a redo in the repair workflow.
  REDO: 60,
  // Pages with this many or more fixable issues trigger a redo even if
  // the score is acceptable (something visually subtle is off).
  ISSUES: 5,
};

/**
 * Decide whether a version is "bad enough" to warrant a redo. Used by
 * findBadPages and the auto-redo gate. Single rule, no per-site variation.
 *
 * @param {object} version
 * @returns {boolean}
 */
function shouldRedo(version) {
  if (!version) return false;
  const score = computeFinalScore(version);
  if (score != null && score < SCORE_THRESHOLDS.REDO) return true;
  const issues = Array.isArray(version.fixableIssues) ? version.fixableIssues.length : 0;
  if (issues >= SCORE_THRESHOLDS.ISSUES) return true;
  return false;
}

module.exports = {
  // New deductions-first model (canonical)
  SEVERITY_POINTS,
  composeDeductions,
  computeMathFinalScore,
  applyScore,
  logScoreModelSummary,
  // Legacy helpers (still used by some readers/writers — to be migrated)
  computeFinalScore,
  versionDeductionTotal,
  buildScoreBreakdown,
  composeEvalScore,
  composeFinalScore,
  applyScoreBreakdown,
  setVersionScores,
  pickBestVersionIndex,
  recomputeActiveVersion,
  recomputeAllActiveVersions,
  shouldRedo,
  SCORE_THRESHOLDS,
};
