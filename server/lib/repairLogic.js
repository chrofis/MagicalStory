/**
 * Shared repair logic — single source of truth for bad-page detection
 * and character repair task selection.
 *
 * Used by:
 *   - server/lib/images.js (unified pipeline)
 *   - server/routes/regeneration.js (repair workflow endpoints)
 */

const { REPAIR_DEFAULTS } = require('../config/models');

/**
 * Identify pages that need redo based on score and issue count thresholds.
 *
 * The score field read by this function (in priority order) is:
 *   1. `finalScore` — entity-penalty-adjusted, set explicitly by the unified
 *      pipeline round loop. PREFERRED — distinguishes itself from raw visual.
 *   2. `score` / `qualityScore` — legacy fields, may be either raw visual or
 *      adjusted depending on the call site. Used as fallback for endpoints
 *      that haven't migrated to finalScore yet.
 *
 * @param {Object} evalPages - Map of pageNumber → { finalScore?, score?, qualityScore?, fixableIssues? }
 * @param {Object} [options]
 * @param {number} [options.scoreThreshold] - Pages scoring below this need redo
 * @param {number} [options.issueThreshold] - Pages with >= this many fixable issues need redo
 * @returns {number[]} Sorted page numbers needing redo
 */
function findBadPages(evalPages, options = {}) {
  const scoreThreshold = options.scoreThreshold ?? REPAIR_DEFAULTS.scoreThreshold;
  const issueThreshold = options.issueThreshold ?? REPAIR_DEFAULTS.issueThreshold;

  const bad = [];
  for (const [pageNumStr, result] of Object.entries(evalPages || {})) {
    const pageNum = parseInt(pageNumStr, 10);
    if (isNaN(pageNum)) continue;

    // Prefer the explicit finalScore (set by unified pipeline round loop).
    // Fall back to the ambiguous score/qualityScore fields for legacy callers.
    const score = result.finalScore ?? result.score ?? result.qualityScore ?? null;
    const issueCount = result.fixableIssues?.length ?? 0;

    // Skip pages with no score data
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
  const visualScore = evaluator.qualityScore ?? evaluator.rawQualityScore ?? 100;
  const semanticScore = evaluator.semanticScore ?? 100;

  // 1. Catastrophic — iterate immediately (figure unrecognisable).
  if (visualScore < 50) {
    return { method: 'iterate', reason: `image visually broken (visual=${visualScore})` };
  }
  if (semanticScore < 30) {
    return { method: 'iterate', reason: `wrong scene (semantic=${semanticScore})` };
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
      return {
        method: 'char-fix',
        reason: `entity ${worst.severity} on ${worst.charName}`,
        charName: worst.charName,
        severity: worst.severity,
        issueDescription: worst.issue.description || worst.issue.fixInstruction || '',
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
