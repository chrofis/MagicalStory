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

const { setActiveVersion, getActiveVersionMeta } = require('../services/database');
const { dbIndexFor, arrayIndexForDb } = require('./versionManager');
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
//   promptFinalScore = the evaluator/consolidator merged score — AUDIT ONLY
//   finalScore       = mathFinalScore, always (single scale, 2026-07-10)
//
// Writers call `applyScore(version, {evalResult, entityResult, promptFinalScore})`
// — single entry point. Readers (`findBadPages`, `pickBestVersionIndex`)
// read `version.finalScore` only.
//
// Severity points calibrated for tolerance — minor wobbles shouldn't
// trip the redo gate.
//
// THREE severity→number tables exist ON PURPOSE — do not "unify" one
// against the others:
//   SEVERITY_POINTS (here)          — the SCORE: what finalScore charges.
//   RANK_SEVERITY_WEIGHT (below)    — the RANKING tiebreak: deliberately
//                                     different calibration (un-clamped,
//                                     dedup-clustered) for pick-best.
//   SEVERITY_PENALTY (images.js)    — the legacy 0-10 audit blend + the
//                                     repair-method gates; feeds
//                                     qualityScore/rawScore, never
//                                     finalScore.
// Entity display/rank derives from SEVERITY_POINTS (see images.js
// ENTITY_PENALTIES).
// =====================================================================
const SEVERITY_POINTS = {
  catastrophic: 50,
  critical:     25,
  major:        15,
  moderate:      5,
  minor:         2,
};

// Entity-penalty cap (Jul 2026). Uncapped entity penalties (−70/−90 on one
// page) zeroed out 90-scoring versions and could never converge — the repair
// loop kept redoing pages whose flags the consolidator itself marked
// "not actionable as inpaint edits". Policy: at most 40 points of entity
// penalty apply to a version's finalScore; when ALL of the page's entity
// issues that round were classified not-actionable by the consolidator, the
// capped penalty is halved (advisory signal, not a fixable defect). The raw
// uncapped value stays on the version as `entityPenaltyRaw` for diagnosis.
const ENTITY_PENALTY_CAP = 40;

/**
 * Applied entity penalty for a version. Single chokepoint — every writer
 * (setVersionScores, applyScore) and every legacy read-time fallback
 * (computeFinalScore, composeFinalScore) must go through this so the
 * round-loop scores and the finalize-time recompute can't diverge.
 *
 * @param {number} rawPenalty  uncapped sum of entity issue penalties
 * @param {{allNonActionable?: boolean}} [opts]
 * @returns {number} penalty to subtract from the score
 */
function capEntityPenalty(rawPenalty, { allNonActionable = false } = {}) {
  const raw = Math.max(0, Number(rawPenalty) || 0);
  const capped = Math.min(raw, ENTITY_PENALTY_CAP);
  return allNonActionable ? capped / 2 : capped;
}

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
      // Consolidator deduped issues carry the evaluator names that flagged
      // them — keep for the dev panel's dedupe display.
      ...(Array.isArray(it.sources) && it.sources.length ? { sources: it.sources } : {}),
    });
  }
  return out;
}

/**
 * Build the deductions structure from evaluator outputs. Each input is
 * the raw eval result; the helper extracts the issues lists and normalizes.
 *
 * CONSOLIDATED MODE (Jul 2026, owner decision "3-4 evals, ONE summarize"):
 * when `consolidated` is an array (the feedback consolidator's deduped_issues
 * — one entry per unique defect, highest severity, cross-evaluator sources),
 * the deductions come from IT instead of the raw evaluator lists — the same
 * defect flagged by quality + semantic + compliance counts ONCE. Entity-only
 * findings (sources === ['entity']) keep their own capped bucket
 * (capEntityPenalty chokepoint), mirroring the raw path's entity handling.
 *
 * @param {object} params
 * @param {object} [params.evalResult]       output of evaluateImageQuality (has fixableIssues, semanticResult, threeStageResult)
 * @param {object} [params.entityResult]     { issues: [{name, severity, description, ...}], ... }
 * @param {Array|null} [params.consolidated] consolidator deduped_issues ([{description, severity, sources}])
 * @returns {{quality, semantic, compliance, consolidated, entity}}
 */
function composeDeductions({ evalResult = null, entityResult = null, consolidated = null } = {}) {
  if (Array.isArray(consolidated)) {
    const entityOnly = (i) => Array.isArray(i?.sources)
      && i.sources.length > 0
      && i.sources.every(s => s === 'entity');
    return {
      quality: [],
      semantic: [],
      compliance: [],
      consolidated: normalizeIssues(consolidated.filter(i => !entityOnly(i)), 'consolidated'),
      entity: normalizeIssues(consolidated.filter(entityOnly), 'entity'),
    };
  }
  // evaluateImageQuality merges threeStageResult.fixableIssues into
  // evalResult.fixableIssues for display (tagged `source: 'three-stage'`,
  // images.js). The compliance bucket below reads threeStageResult directly —
  // the single source for those issues — so drop the merged copies from the
  // quality bucket or every compliance issue is deducted twice.
  const qualityRaw = Array.isArray(evalResult?.fixableIssues)
    ? evalResult.fixableIssues.filter(i => i?.source !== 'three-stage')
    : evalResult?.fixableIssues;
  const quality    = normalizeIssues(qualityRaw, 'quality');
  const semantic   = normalizeIssues(evalResult?.semanticResult?.semanticIssues, 'semantic');
  const compliance = normalizeIssues(evalResult?.threeStageResult?.fixableIssues
                                  || evalResult?.threeStageResult?.issues, 'compliance');
  const entity     = normalizeIssues(entityResult?.issues, 'entity');
  return { quality, semantic, compliance, consolidated: [], entity };
}

/**
 * Sum severity points across every category and clamp 100−sum to [0, 100].
 */
function computeMathFinalScore(deductions) {
  if (!deductions || typeof deductions !== 'object') return 100;
  let total = 0;
  // `consolidated` is the deduped cross-evaluator list (one entry per unique
  // defect) — mutually exclusive with the raw buckets by construction in
  // composeDeductions, so summing all four never double-counts.
  for (const cat of ['quality', 'semantic', 'compliance', 'consolidated']) {
    const list = deductions[cat] || [];
    for (const d of list) total += SEVERITY_POINTS[d.severity] || 0;
  }
  // Entity penalty capped (see capEntityPenalty): an uncapped −70/−90 entity
  // sum zeroed otherwise-good versions on flags the consolidator itself
  // marked not-actionable. capEntityPenalty is idempotent, so it's safe to
  // apply at every entity-penalty site.
  const entityRaw = (deductions.entity || []).reduce((s, d) => s + (SEVERITY_POINTS[d.severity] || 0), 0);
  total += capEntityPenalty(entityRaw);
  return Math.max(0, Math.min(100, 100 - total));
}

/**
 * Single entry point that mutates a version with the canonical scoring
 * fields. Writers call this; readers read `version.finalScore`.
 *
 * SINGLE SCALE (2026-07-10): finalScore is ALWAYS the math model
 * (100 − Σ SEVERITY_POINTS over structured issues, entity capped). The former
 * 'prompt' score model was dead in the pipeline (nothing ever plumbed the
 * consolidator's final_score into evaluation.promptFinalScore) while the regen
 * routes laundered the merged-eval score through the promptFinalScore
 * parameter — leaving two incomparable finalScore scales in the same
 * imageVersions[] arrays that pickBestVersionIndex compared directly.
 * promptFinalScore is kept as an AUDIT field only; it never drives finalScore.
 *
 * CONSOLIDATED SCORING (Jul 2026): pass `consolidatedPlan` (the feedback
 * consolidator's plan for THIS evaluation) and the math runs over its
 * deduped_issues — one deduction per unique defect — instead of the raw
 * evaluator lists. When absent/failed, fail-soft to math over the raw
 * (undeduped) lists with a WARN so missed consolidation is visible in logs.
 *
 * @param {object} version  mutated in place
 * @param {object} params
 * @param {object} [params.evalResult]     evaluateImageQuality output
 * @param {object} [params.entityResult]   { penalty, issues } from getEntityPenaltyAndIssues
 * @param {number|null} [params.promptFinalScore]   audit-only: the evaluator/consolidator combined score, if any
 * @param {object|null} [params.consolidatedPlan]   consolidator plan whose deduped_issues drive the deductions
 */
function applyScore(version, { evalResult = null, entityResult = null, promptFinalScore = null, consolidatedPlan = null } = {}) {
  if (!version || typeof version !== 'object') return;
  const dedupedIssues = Array.isArray(consolidatedPlan?.deduped_issues)
    ? consolidatedPlan.deduped_issues
    : null;
  const deductions = composeDeductions({ evalResult, entityResult, consolidated: dedupedIssues });
  if (!dedupedIssues) {
    const rawCount = deductions.quality.length + deductions.semantic.length
      + deductions.compliance.length + deductions.entity.length;
    if (rawCount > 0) {
      const pnWarn = version.pageNumber != null ? `page ${version.pageNumber}` : 'version';
      log.warn(`[SCORE] ${pnWarn}: no consolidated evaluation — scoring ${rawCount} raw (undeduped) evaluator issue(s)`);
    }
  }
  const mathFinalScore = computeMathFinalScore(deductions);
  const finalScore = mathFinalScore;

  // Canonical fields written by the single writer.
  version.deductions = deductions;
  version.mathFinalScore = mathFinalScore;
  version.promptFinalScore = (typeof promptFinalScore === 'number') ? promptFinalScore : null;
  version.finalScore = finalScore;
  version.scoreModel = 'math';
  // Which issue set fed the math: 'consolidated' (deduped) or 'raw'.
  version.scoreSource = dedupedIssues ? 'consolidated' : 'raw';
  // Persist the consolidator output on the version (same shape/field the
  // repair paths already store) so the dev panel can show the dedupe.
  if (consolidatedPlan) version.consolidatedPlan = consolidatedPlan;

  // scoreBreakdown — per-evaluator card for the dev panel's breakdown view.
  // Built from the same evalResult so it stays consistent with deductions.
  // Shape: { visual: {score, reasoning, issues}, semantic: {...}|null, threeStage: {...}|null, entity: {penalty, issues} }
  version.scoreBreakdown = _buildBreakdownFromEvalResult(evalResult, entityResult);

  // evalScore (pre-entity) + entityPenalty kept as separate fields so an
  // entity-only re-run can recompute finalScore without re-running visual.
  // The previous evalScore math (MIN of visual/semantic/threeStage subscores
  // from composeEvalScore) was the legacy behavior; new model derives
  // evalScore from deductions ÷ entity-penalty split.
  const entityRaw = (deductions.entity || []).reduce((s, d) => s + (SEVERITY_POINTS[d.severity] || 0), 0);
  const entityPoints = capEntityPenalty(entityRaw);
  version.entityPenaltyRaw = entityRaw;
  version.entityPenalty = entityPoints;
  version.evalScore = Math.max(0, Math.min(100, finalScore + entityPoints));

  // Info-level visibility for threshold calibration. Without this, prod logs
  // show "page X scored Y" with no indication whether Y came from the
  // consolidator (lenient) or the math fallback (conservative) — meaning the
  // 60-threshold can't be tuned from logs alone.
  const pn = version.pageNumber != null ? `page ${version.pageNumber}` : 'version';
  log.info(`[SCORE] ${pn}: math model (${version.scoreSource}) → finalScore=${finalScore} (evalAudit=${promptFinalScore}, entity=−${entityPoints})`);

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
    // Same filter as composeDeductions: three-stage issues merged into
    // fixableIssues are listed on the threeStage card below — keep the
    // visual card to genuine quality-eval findings so the dev panel
    // doesn't show each compliance issue twice.
    issues: Array.isArray(evalResult.fixableIssues)
      ? evalResult.fixableIssues.filter(i => i?.source !== 'three-stage')
      : [],
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
// DELIBERATELY different calibration from SEVERITY_POINTS (the score) —
// see the three-tables note above SEVERITY_POINTS before changing either.
const RANK_SEVERITY_WEIGHT = { CATASTROPHIC: 50, CRITICAL: 30, MAJOR: 20, MODERATE: 10, MINOR: 5 };

// Words too common to signal that two issue descriptions are about the same
// thing — stripped before the overlap check below.
const RANK_STOPWORDS = new Set([
  'the','and','not','instead','should','with','that','this','have','has','are','being','rendered',
  'scene','image','prompt','character','characters','specified','expected','expects','declared',
  'interaction','interactions','shows','show','show n','wrong','incorrect','missing','appears',
  'must','only','their','they','from','into','onto','toward','towards','than','but','for','his',
  'her','its','both','one','two','left','right','side','front','back','color','colour','colors',
]);

function significantWords(desc) {
  return new Set(
    String(desc || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 4 && !RANK_STOPWORDS.has(w))
  );
}

/**
 * Un-clamped total weighted deduction for a version. This is the RANKING
 * signal the clamped 0–100 finalScore throws away: once a page accrues >100
 * deduction points its finalScore pins to 0, and several failing candidates
 * all read 0 — pick-best can no longer tell them apart and selection
 * collapses to "earliest version" (pure luck). This number keeps growing past
 * the 0 floor, so the candidate with the FEWEST / LIGHTEST DISTINCT issues
 * still ranks above a more-broken one even when all of them score 0.
 *
 * DEDUPLICATED across evaluators: the visual, semantic, and three-stage evals
 * overlap heavily — the same conceptual flaw ("wrong setting") gets flagged by
 * all three, which without dedup counts 3× and lets a clean-but-off-scene
 * image (one error, triple-counted) rank below a broken-but-on-scene one
 * (job_1781086474294 p9). Issues whose descriptions share enough significant
 * words are merged into one cluster scored at its MAX severity. Entity
 * penalties are per-character consistency, disjoint from scene issues, so they
 * add as-is.
 *
 * Lower is better. Returns Infinity when the version has no scoreable data so
 * it never wins a tiebreak by accident.
 */
function versionDeductionTotal(version) {
  if (!version || typeof version !== 'object') return Infinity;
  const bd = version.scoreBreakdown;
  const sceneIssues = [];
  let entityPenalty = 0;
  let sawAny = false;

  if (bd) {
    for (const cat of ['visual', 'semantic', 'threeStage']) {
      for (const i of (bd[cat]?.issues || [])) { sceneIssues.push(i); sawAny = true; }
    }
    if (typeof bd.entity?.penalty === 'number') { entityPenalty = capEntityPenalty(bd.entity.penalty); sawAny = true; }
  } else {
    for (const i of (version.fixableIssues || [])) { sceneIssues.push(i); sawAny = true; }
    for (const i of (version.semanticResult?.semanticIssues || version.semanticResult?.issues || [])) { sceneIssues.push(i); sawAny = true; }
    if (typeof version.entityPenalty === 'number') { entityPenalty = capEntityPenalty(version.entityPenalty); sawAny = true; }
  }
  if (!sawAny) return Infinity;

  // Cluster scene issues by significant-word overlap; each cluster counts once
  // at its heaviest severity.
  const weightOf = (i) => RANK_SEVERITY_WEIGHT[String(i?.severity || '').toUpperCase()] ?? 10;
  const clusters = []; // { words:Set, weight:number }
  for (const issue of sceneIssues) {
    const w = significantWords(issue?.description || issue?.problem);
    const wt = weightOf(issue);
    let merged = false;
    for (const c of clusters) {
      // shared ≥ 2 significant words OR Jaccard ≥ 0.4 → same conceptual issue
      let shared = 0;
      for (const word of w) if (c.words.has(word)) shared++;
      const union = c.words.size + w.size - shared;
      if (shared >= 2 || (union > 0 && shared / union >= 0.4)) {
        for (const word of w) c.words.add(word);
        c.weight = Math.max(c.weight, wt);
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ words: w, weight: wt });
  }
  return clusters.reduce((sum, c) => sum + c.weight, 0) + entityPenalty;
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
  const entityPenalty = capEntityPenalty((breakdown.entity && Number(breakdown.entity.penalty)) || 0);
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
 * LEGACY writer (scoring audit 2026-07-10): no production code path calls
 * this anymore — every version writer now goes through applyScore (single
 * scale). Only applyScoreBreakdown (itself dead in prod, tests-only) still
 * calls it. Kept per mark-not-delete. Note its finalScore is the SIGNED
 * merged-eval scale, NOT comparable with applyScore's math finalScore.
 */
function setVersionScores(version, evalScore, entityPenalty) {
  if (!version || typeof version !== 'object') return;
  version.evalScore = evalScore;
  const rawPenalty = (Number(entityPenalty) || 0);
  version.entityPenaltyRaw = rawPenalty;
  version.entityPenalty = capEntityPenalty(rawPenalty);
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
function pickBestVersionIndex(versions, { tieBreak = 'latest' } = {}) {
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
    // issues), which the 0-floor erased. Final full-tie break is direction-
    // parameterized — BOTH directions are deliberate, do not "fix" one:
    //   'latest'   (<=): newer version wins a full tie — interactive flows,
    //               where the user's just-made regen should show.
    //   'earliest' (<): the earlier version keeps a full tie — the repair
    //               pipeline, where the least-mangled original beats a repair
    //               that changed nothing measurable (job_1781289599516).
    const tie = (s === bestScore) && (tieBreak === 'latest' ? ded <= bestDeduction : ded < bestDeduction);
    if (s > bestScore || tie) {
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
 * Respects a user pin: when image_version_meta[key].pinned is true (manual
 * version pick, iterate, style-transfer, scale-repair, regen), the explicit
 * choice wins and this recompute leaves the pointer alone. Pass metaEntry
 * when the caller already fetched the meta map (recomputeAllActiveVersions)
 * to avoid a per-key query.
 *
 * @param {string} storyId
 * @param {number|string} key  pageNumber for scenes, coverType for covers
 * @param {Array<object>} versions  imageVersions[] from the blob
 * @param {string} type  'scene' | 'frontCover' | 'initialPage' | 'backCover'
 *                       (used for the array→DB index mapping)
 * @param {object} [opts]
 * @param {object|null} [opts.metaEntry]  pre-fetched image_version_meta[key]
 * @returns {Promise<{activeIndex: number, finalScore: number|null}|null>}
 */
async function recomputeActiveVersion(storyId, key, versions, type = 'scene', { metaEntry } = {}) {
  const meta = metaEntry !== undefined
    ? metaEntry
    : (await getActiveVersionMeta(storyId))[String(key)];
  if (meta?.pinned) return null;
  const idx = pickBestVersionIndex(versions || []);
  if (idx < 0) return null;
  const dbIdx = dbIndexFor(versions[idx], idx, type);
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

  // One meta fetch for the whole story — recomputeActiveVersion skips
  // user-pinned keys, and for those we still mirror the pinned choice onto
  // the blob so blob readers agree with the meta column.
  let versionMeta = {};
  try {
    versionMeta = await getActiveVersionMeta(storyId);
  } catch (err) {
    // Non-fatal: without meta we recompute everything (pre-pin behaviour).
  }

  // Mirror a pinned meta choice (DB version_index) back onto the blob's
  // array-index activeVersion field so blob readers agree with the pin.
  const mirrorPinned = (entry, metaEntry, type) => {
    if (!metaEntry?.pinned || typeof metaEntry.activeVersion !== 'number') return;
    const arrayIdx = arrayIndexForDb(entry.imageVersions, metaEntry.activeVersion, type);
    if (arrayIdx >= 0 && arrayIdx < entry.imageVersions.length) entry.activeVersion = arrayIdx;
  };

  if (Array.isArray(storyData.sceneImages)) {
    for (const s of storyData.sceneImages) {
      if (!s?.pageNumber || !Array.isArray(s.imageVersions) || s.imageVersions.length === 0) continue;
      const metaEntry = versionMeta[String(s.pageNumber)] ?? null;
      const r = await recomputeActiveVersion(storyId, s.pageNumber, s.imageVersions, 'scene', { metaEntry });
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
      } else {
        mirrorPinned(s, metaEntry, 'scene');
      }
    }
  }
  if (storyData.coverImages && typeof storyData.coverImages === 'object') {
    for (const kind of ['frontCover', 'initialPage', 'backCover']) {
      const cv = storyData.coverImages[kind];
      if (!cv?.imageVersions || cv.imageVersions.length === 0) continue;
      const metaEntry = versionMeta[kind] ?? null;
      const r = await recomputeActiveVersion(storyId, kind, cv.imageVersions, kind, { metaEntry });
      covers++;
      if (r) {
        switches++;
        cv.activeVersion = r.activeIndex;
      } else {
        mirrorPinned(cv, metaEntry, kind);
      }
    }
  }
  return { scenes, covers, switches };
}

// Single-sourced from REPAIR_DEFAULTS (config/models.js) — these used to be
// independent literals that could drift from the values the repair pipeline
// actually runs with. Lazy require avoids a config↔scoring load cycle.
const { REPAIR_DEFAULTS: _REPAIR_DEFAULTS } = require('../config/models');
const SCORE_THRESHOLDS = {
  // Pages scoring below this trigger a redo in the repair workflow.
  REDO: _REPAIR_DEFAULTS?.scoreThreshold ?? 60,
  // Pages with this many or more fixable issues trigger a redo even if
  // the score is acceptable (something visually subtle is off).
  ISSUES: _REPAIR_DEFAULTS?.issueThreshold ?? 5,
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
  capEntityPenalty,
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
