/**
 * Shared repair logic — single source of truth for bad-page detection
 * and character repair task selection.
 *
 * Used by:
 *   - server/lib/images.js (unified pipeline)
 *   - server/routes/regeneration.js (repair workflow endpoints)
 *
 * Scoring is delegated to lib/scoring.js. This module just decides which
 * pages need redo based on the canonical finalScore + fixableIssues count.
 */

const { REPAIR_DEFAULTS } = require('../config/models');
const { computeFinalScore, SCORE_THRESHOLDS } = require('./scoring');
const { log } = require('../utils/logger');

/**
 * Identify pages that need redo. Reads the canonical finalScore via
 * computeFinalScore() — same chain as pickBestVersionIndex / shouldRedo.
 * No more per-site priority chains.
 *
 * @param {Object} evalPages - Map of pageNumber → version-shaped object
 * @param {Object} [options]
 * @param {number} [options.scoreThreshold] - Pages scoring below this need redo
 * @param {number} [options.issueThreshold] - Pages with >= this many fixable issues need redo
 * @returns {number[]} Sorted page numbers needing redo
 */
function findBadPages(evalPages, options = {}) {
  const scoreThreshold = options.scoreThreshold ?? REPAIR_DEFAULTS.scoreThreshold ?? SCORE_THRESHOLDS.REDO;
  const issueThreshold = options.issueThreshold ?? REPAIR_DEFAULTS.issueThreshold ?? SCORE_THRESHOLDS.ISSUES;

  const bad = [];
  for (const [pageNumStr, result] of Object.entries(evalPages || {})) {
    const pageNum = parseInt(pageNumStr, 10);
    if (isNaN(pageNum)) continue;

    // Eval failure (timeout, API error, etc.) — treat as bad and redo on the
    // next pass. Without this, a transient Gemini outage means a broken image
    // ships as "completed" because score==null skipped the threshold check.
    if (result?.evaluated === false) {
      log.warn(`[FIND-BAD] page ${pageNum}: eval failed (${result.evalError || 'unknown'}) — marking bad for redo`);
      bad.push(pageNum);
      continue;
    }

    const score = computeFinalScore(result);
    const issueCount = result.fixableIssues?.length ?? 0;
    if (score == null) continue;

    if (score < scoreThreshold || issueCount >= issueThreshold) {
      bad.push(pageNum);
    }
  }
  return bad.sort((a, b) => a - b);
}

/**
 * Select character repair tasks from an entity consistency report.
 *
 * Collects major/critical issues, deduplicates by page+character (keeping highest
 * severity), sorts by severity then page score, and applies budget cap.
 *
 * @param {Object} entityReport - Entity consistency report with `.characters`
 * @param {Object} [options]
 * @param {number} [options.maxTasks] - Max repair tasks (defaults to REPAIR_DEFAULTS.maxCharRepairPages)
 * @param {Map|Object} [options.pageScores] - Map or object of pageNumber → score (for sort tiebreaking)
 * @returns {{ tasks: Array<{pageNumber, charName, severity, issueDescription}>, repairs: Array<{character, pages}>, dropped: number }}
 */
function selectCharRepairTasks(entityReport, options = {}) {
  const maxTasks = options.maxTasks ?? REPAIR_DEFAULTS.maxCharRepairPages;

  // Accept Map or plain object for pageScores
  const pageScoresRaw = options.pageScores;
  const getPageScore = (pageNum) => {
    if (!pageScoresRaw) return 100;
    if (pageScoresRaw instanceof Map) return pageScoresRaw.get(pageNum) ?? 100;
    return pageScoresRaw[pageNum] ?? 100;
  };

  const fixTasks = [];
  const seenPairs = new Set();

  for (const [charName, charResult] of Object.entries(entityReport?.characters || {})) {
    // Collect all issues: top-level + byClothing
    const allIssues = [...(charResult.issues || [])];
    if (charResult.byClothing) {
      for (const clothingResult of Object.values(charResult.byClothing)) {
        for (const issue of (clothingResult.issues || [])) {
          if (!allIssues.some(i => i.id === issue.id)) {
            allIssues.push(issue);
          }
        }
      }
    }

    for (const issue of allIssues) {
      if (issue.severity !== 'major' && issue.severity !== 'critical') continue;

      const pagesToFix = issue.pagesToFix || (issue.pageNumber ? [issue.pageNumber] : []);
      for (const pageNum of pagesToFix) {
        const key = `${pageNum}-${charName}`;
        if (seenPairs.has(key)) {
          // Deduplicate: upgrade severity if this one is higher
          const existing = fixTasks.find(t => t.pageNumber === pageNum && t.charName === charName);
          if (existing && issue.severity === 'critical' && existing.severity !== 'critical') {
            existing.severity = 'critical';
            existing.issueDescription = issue.description || issue.fixInstruction || '';
          }
          continue;
        }
        seenPairs.add(key);
        fixTasks.push({
          pageNumber: pageNum,
          charName,
          severity: issue.severity,
          issueDescription: issue.description || issue.fixInstruction || '',
        });
      }
    }
  }

  // Sort: critical first, then worst page score (ascending), then page number as tiebreaker
  fixTasks.sort((a, b) => {
    // Severity: critical before major
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    // Page score: lower (worse) first
    const scoreA = getPageScore(a.pageNumber);
    const scoreB = getPageScore(b.pageNumber);
    if (scoreA !== scoreB) return scoreA - scoreB;
    // Page number tiebreaker
    return a.pageNumber - b.pageNumber;
  });

  // Apply budget cap
  const dropped = Math.max(0, fixTasks.length - maxTasks);
  const selectedTasks = fixTasks.slice(0, maxTasks);

  // Group by character for API calls
  const repairMap = new Map();
  for (const task of selectedTasks) {
    if (!repairMap.has(task.charName)) {
      repairMap.set(task.charName, []);
    }
    repairMap.get(task.charName).push(task.pageNumber);
  }
  const repairs = Array.from(repairMap.entries()).map(([character, pages]) => ({ character, pages }));

  return { tasks: selectedTasks, repairs, dropped };
}

/**
 * Decide ONE repair method for a single page based on its evaluation +
 * the entity consistency report. Single source of truth for the per-page
 * decision; replaces the historical split between `chooseRepairStrategy`
 * (inpaint vs iterate) and `selectCharRepairTasks` (char-fix as a
 * separate post-loop pass).
 *
 * Decision order:
 *   1. Catastrophic visual / semantic break    → iterate (regenerate)
 *   2. Major/critical entity (character) issue → char-fix
 *   3. Has fixable quality / semantic content   → inpaint
 *   4. Otherwise                                → skip
 *
 * Catastrophic outranks entity intentionally: a visually broken image
 * fails entity checks for the wrong reason (the figure isn't recognisable
 * yet). Iterate first; if the next round still has identity issues,
 * char-fix on the iterated result.
 *
 * Char-fix is scene-only (covers don't get char-fix). Cover pages with
 * entity issues — rare — fall through to inpaint/iterate.
 *
 * @param {number} pageNumber - Page number; negative for covers (-1/-2/-3)
 * @param {Object} evaluation - Per-page eval with qualityScore, semanticScore, fixableIssues, etc.
 * @param {Object} entityReport - Story-level entity consistency report
 * @param {Object} [options]
 * @param {Function} [options.chooseRepairStrategy] - Helper to pick inpaint/iterate when entity isn't the answer (DI for testability)
 * @returns {{method: 'skip'|'inpaint'|'iterate'|'char-fix', reason: string, charName?: string, severity?: string, issueDescription?: string}}
 */
function decideRepairMethod(pageNumber, evaluation, entityReport, options = {}) {
  const evaluator = evaluation || {};
  // Canonical reads via scoreBreakdown (post chunk-2 scoring migration). Each
  // evaluator's NATIVE score lives in scoreBreakdown.<evaluator>.score; the
  // combined number lives in evaluator.finalScore. Legacy fallbacks
  // (qualityScore / rawQualityScore / semanticScore on the evaluator object
  // itself) kept for stories that predate the migration. Default of 100 keeps
  // the legacy "no eval data → don't trigger catastrophic gate" behavior.
  const visualRead =
    evaluator.scoreBreakdown?.visual?.score
    ?? evaluator.qualityScore
    ?? evaluator.rawQualityScore
    ?? null;
  const semanticRead =
    evaluator.scoreBreakdown?.semantic?.score
    ?? evaluator.semanticScore
    ?? null;

  // A page that reaches the repair decision with NO readable score is a bug,
  // not a pass. The `?? 100` defaults below keep the historical behaviour
  // (an un-evaluated page must not trip the catastrophic gate on a phantom 0),
  // but the condition is now LOUD: silently treating an unscored page as
  // perfect is exactly how an entire repair stage can go missing without a
  // single line in the logs.
  if (visualRead == null) {
    log.error(`❌ [REPAIR-DECIDE] page ${pageNumber}: no readable visual score (scoreBreakdown.visual.score / qualityScore / rawQualityScore all absent) — defaulting to 100, so the catastrophic-iterate gate CANNOT fire for this page`);
  }
  const visualScore = visualRead ?? 100;
  const semanticScore = semanticRead ?? 100;

  // 0. Spec conflict — the consolidator judged the declared requirements
  // mutually unsatisfiable. No render can fix a broken contract: iterate
  // (scene rewrite) is the only method that can resolve it, and repaint
  // methods must never be chosen for it.
  const specConflicts = evaluator.consolidatedPlan?.spec_conflicts;
  if (Array.isArray(specConflicts) && specConflicts.length > 0) {
    const c = specConflicts[0] || {};
    const why = String(c.why || `${c.a || '?'} vs ${c.b || '?'}`).slice(0, 140);
    return { method: 'iterate', reason: `spec conflict — scene rewrite required: ${why}` };
  }

  // 1. Catastrophic — iterate immediately (figure unrecognisable).
  if (visualScore < 50) {
    return { method: 'iterate', reason: `image visually broken (visual=${visualScore})` };
  }
  if (semanticScore < 30) {
    return { method: 'iterate', reason: `wrong scene (semantic=${semanticScore})` };
  }
  // Severity-based catastrophic gate: a CATASTROPHIC finding (large wrong
  // text, unrecognisable figure) is beyond what inpaint can recover even when
  // the numeric subscores stay above the floors — the eval rubric reserves
  // this severity for defects only a full regen can fix. Same case-insensitive
  // match the round loop's unresolved-issue surfacing uses (images.js).
  const severityIssues = [
    ...(evaluator.fixableIssues || []),
    ...(evaluator.semanticResult?.semanticIssues || evaluator.semanticResult?.issues || []),
    ...(Array.isArray(evaluator.consolidatedPlan?.deduped_issues) ? evaluator.consolidatedPlan.deduped_issues : []),
  ];
  const catastrophicIssue = severityIssues.find(i => /catastrophic/i.test(String(i?.severity || '')));
  if (catastrophicIssue) {
    const desc = String(catastrophicIssue.description || catastrophicIssue.problem || '').slice(0, 80);
    return { method: 'iterate', reason: `CATASTROPHIC issue — ${desc || 'full regen required'}` };
  }

  // 2. Entity issue — char-fix wins. Scene-only (covers fall through).
  if (pageNumber > 0 && entityReport?.characters) {
    let worst = null; // {severity, charName, issue}
    const sevRank = (s) => (s === 'critical' ? 4 : s === 'major' ? 3 : s === 'moderate' ? 2 : s === 'minor' ? 1 : 0);
    for (const [charName, charResult] of Object.entries(entityReport.characters)) {
      const allIssues = [...(charResult.issues || [])];
      if (charResult.byClothing) {
        for (const cr of Object.values(charResult.byClothing)) {
          for (const i of (cr.issues || [])) {
            if (!allIssues.some(x => x.id === i.id)) allIssues.push(i);
          }
        }
      }
      for (const issue of allIssues) {
        if (issue.severity !== 'major' && issue.severity !== 'critical') continue;
        const pages = issue.pagesToFix || (issue.pageNumber ? [issue.pageNumber] : []);
        if (!pages.includes(pageNumber)) continue;
        if (!worst || sevRank(issue.severity) > sevRank(worst.severity)) {
          worst = { severity: issue.severity, charName, issue };
        }
      }
    }
    if (worst) {
      const issueDescription = worst.issue.description || worst.issue.fixInstruction || '';
      // repairParams: the 3-axis repair plan for this char-fix, resolved from the
      // issue text by the ONE central rule (resolveRepairAxes). Emitted here so the
      // decision — not a scattered per-caller `useFaceOnly` derivation — owns which
      // axes a char-fix uses. faceOnly here is the INTENT (assumes a face box is
      // available); executeCharFixAction finalises it against the actual bbox.
      const { resolveRepairAxes } = require('./faceRepair');
      const repairParams = resolveRepairAxes(issueDescription, { hasFaceBbox: true });
      return {
        method: 'char-fix',
        reason: `entity ${worst.severity} on ${worst.charName}`,
        charName: worst.charName,
        severity: worst.severity,
        issueDescription,
        repairParams,
      };
    }
  }

  // 2b. Clothing is a FIGURE REDO, never an inpaint patch or a scene rewrite.
  //
  // Owner decision 2026-08-09, after reviewing a full 14-page story: a wrong
  // outfit is a property of the FIGURE, so repainting a masked region around it
  // (inpaint) fights the surrounding pixels, and rewriting the scene (iterate)
  // throws away a composition that was fine. Redrawing the figure is the only
  // method that actually owns the defect.
  //
  // Only reachable when the entity check (step 2) did not already claim the
  // page — entity findings carry cross-page evidence and keep priority.
  // `accessory` is deliberately EXCLUDED: it caps at MODERATE, and a bandana
  // knot is not worth redrawing a person over.
  if (pageNumber > 0) {
    const clothingIssue = severityIssues.find(i =>
      String(i?.type || '').toLowerCase() === 'clothing'
      && /^(major|critical|catastrophic)$/i.test(String(i?.severity || ''))
      && String(i?.character || '').trim());
    if (clothingIssue) {
      const charName = String(clothingIssue.character).trim();
      const issueDescription = clothingIssue.description || clothingIssue.problem || '';
      const { resolveRepairAxes } = require('./faceRepair');
      // forceTarget 'body' so this never degrades into a face-only cutout:
      // the whole figure is redrawn, which is the point of the route.
      const repairParams = resolveRepairAxes(issueDescription, { hasFaceBbox: true, forceTarget: 'body' });
      return {
        method: 'char-fix',
        reason: `clothing ${String(clothingIssue.severity).toLowerCase()} on ${charName} — figure redo`,
        charName,
        severity: String(clothingIssue.severity).toLowerCase(),
        issueDescription,
        repairParams,
      };
    }
  }

  // 3. Inpaint when there's something inpaintable.
  if (typeof options.chooseRepairStrategy === 'function') {
    return mapStrategyToMethod(options.chooseRepairStrategy(evaluator));
  }
  // Inline fallback when chooseRepairStrategy isn't injected (tests).
  const fixableCount = evaluator.fixableIssues?.length || 0;
  const enrichedCount = evaluator.enrichedFixTargets?.length || 0;
  const fixTargetCount = evaluator.fixTargets?.length || 0;
  const semanticIssueCount = (evaluator.semanticResult?.issues?.length
    || evaluator.semanticResult?.semanticIssues?.length || 0);
  if (fixableCount + enrichedCount + fixTargetCount + semanticIssueCount > 0) {
    const parts = [];
    if (fixableCount) parts.push(`${fixableCount} quality`);
    if (semanticIssueCount) parts.push(`${semanticIssueCount} semantic`);
    if (enrichedCount || fixTargetCount) parts.push(`${enrichedCount + fixTargetCount} targets`);
    return { method: 'inpaint', reason: parts.join(', ') || 'default' };
  }

  // 4. Nothing actionable.
  return { method: 'skip', reason: 'no repair needed' };
}

function mapStrategyToMethod(s) {
  if (!s) return { method: 'skip', reason: 'no strategy' };
  return { method: s.strategy || 'skip', reason: s.reason || '' };
}

module.exports = { findBadPages, selectCharRepairTasks, decideRepairMethod };
