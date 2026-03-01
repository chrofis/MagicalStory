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
 * @param {Object} evalPages - Map of pageNumber → { score?, qualityScore, fixableIssues? }
 *   Each value needs at least `qualityScore` (number) or `score` (number).
 *   `fixableIssues` is an optional array — its length is compared to issueThreshold.
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

    const score = result.score ?? result.qualityScore ?? null;
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

module.exports = { findBadPages, selectCharRepairTasks };
