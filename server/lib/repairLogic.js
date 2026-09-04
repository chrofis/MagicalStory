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
 * @returns {number[]} Page numbers needing redo — pages carrying a
 *   CRITICAL/CATASTROPHIC finding first (worst first matters wherever a cap
 *   or budget consumes this list from the front), then the rest by page number
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
      bad.push({ pageNum, critical: false });
      continue;
    }

    const score = computeFinalScore(result);
    const issueCount = result.fixableIssues?.length ?? 0;
    if (score == null) continue;

    // A CRITICAL/CATASTROPHIC finding makes a page bad REGARDLESS of its
    // score, and ranks it ahead of merely low-scoring pages (owner, item 15,
    // 2026-09-04). piraterun5 shipped CRITICAL fixable findings on four pages
    // whose scores cleared the threshold while the round's work went to a
    // page that was only low-scoring. Severity is read from the evaluators'
    // structured fields only — the prompts own the classification.
    const critical = hasCriticalSeverityFinding(result);
    if (critical && score >= scoreThreshold && issueCount < issueThreshold) {
      log.info(`[FIND-BAD] page ${pageNum}: score ${score} clears threshold ${scoreThreshold} but carries a CRITICAL finding — marking bad for repair`);
    }

    if (score < scoreThreshold || issueCount >= issueThreshold || critical) {
      bad.push({ pageNum, critical });
    }
  }
  // CRITICAL-carrying pages first, then by page number within each group.
  bad.sort((a, b) => (b.critical - a.critical) || (a.pageNum - b.pageNum));
  return bad.map(b => b.pageNum);
}

/**
 * Does this eval carry any CRITICAL or CATASTROPHIC finding? Reads the
 * structured severity field on the three finding pools (quality fixableIssues,
 * semantic issues, consolidated deduped_issues) — never the prose.
 */
function hasCriticalSeverityFinding(result) {
  const pools = [
    result?.fixableIssues,
    result?.semanticResult?.semanticIssues || result?.semanticResult?.issues,
    result?.consolidatedPlan?.deduped_issues,
  ];
  return pools.some(list => Array.isArray(list)
    && list.some(i => /^(critical|catastrophic)$/i.test(String(i?.severity || ''))));
}

/**
 * Select character repair tasks from an entity consistency report.
 *
 * Collects CRITICAL issues only (case-insensitive — the entity evaluator emits
 * UPPERCASE severities; owner ruling 2026-09-01: character faults route to
 * character repair "only for critical for now"), deduplicates by
 * page+character, sorts by page score, and applies budget cap.
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
      // CRITICAL only, case-insensitive — same gate as decideRepairMethod's
      // entity block (owner ruling 2026-09-01). The old lowercase-only
      // major/critical compare never matched the evaluator's UPPERCASE
      // severities, so this selector was dead code too.
      const sev = String(issue.severity || '').toLowerCase();
      if (sev !== 'critical') continue;

      const pagesToFix = issue.pagesToFix || (issue.pageNumber ? [issue.pageNumber] : []);
      for (const pageNum of pagesToFix) {
        const key = `${pageNum}-${charName}`;
        if (seenPairs.has(key)) continue; // one task per page+character
        seenPairs.add(key);
        fixTasks.push({
          pageNumber: pageNum,
          charName,
          severity: sev,
          issueDescription: issue.description || issue.fixInstruction || '',
        });
      }
    }
  }

  // Sort: worst page score (ascending) first, then page number as tiebreaker
  // (every task is critical, so severity no longer orders anything).
  fixTasks.sort((a, b) => {
    const scoreA = getPageScore(a.pageNumber);
    const scoreB = getPageScore(b.pageNumber);
    if (scoreA !== scoreB) return scoreA - scoreB;
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
  //
  // Thresholds come from REPAIR_DEFAULTS, not from literals here. They were
  // hardcoded for a month while the config carried DIFFERENT values that nothing
  // read (config 20 vs code 50) — two sources of truth, silently disagreeing.
  // Resolved toward the documented intent (20), which also cuts regenerations:
  // measured on a 14-page story, 13 pages were regenerated and 8 came back
  // WORSE than the original, with pick-best then discarding the work.
  const iterateVisualFloor = REPAIR_DEFAULTS.qualityThresholdForIterate ?? 20;
  const iterateSemanticFloor = REPAIR_DEFAULTS.semanticThresholdForIterate ?? 30;

  // SALVAGE FLOOR. Regenerating is a GAMBLE: the whole image is discarded for a
  // fresh roll, so nothing that was already right carries over. Measured on
  // job_1786287569165 (13 regenerations, outcome known per page):
  //
  //   starting finalScore >= 13  ->  1 improved, 6 WORSE
  //   starting finalScore <  0   ->  4 improved, 2 worse
  //
  // Iterate pays off only when the page is already beyond saving. Above the
  // floor there is something to lose, and local repair (char-fix / inpaint)
  // keeps the composition, likeness and background nobody complained about.
  // Applying the floor to the same story spares p3/p5/p6/p13 — and iterate made
  // ALL FOUR worse. Net: 6 of 8 regressions avoided for 1 of 5 improvements lost.
  //
  // The two NUMERIC gates only. A spec conflict (above) is a broken contract and
  // a CATASTROPHIC finding (below) means the page cannot be published — neither
  // is a gamble worth skipping, and no repaint fixes either.
  //
  // finalScore is deliberately the input rather than `visual`: visual is CLAMPED
  // at 0, so a page with 105 points of deductions and one with 300 both read 0,
  // and the gate cannot tell them apart. finalScore is un-clamped.
  const ITERATE_SALVAGE_FLOOR = REPAIR_DEFAULTS.iterateSalvageFloor ?? 0;
  const pageFinalScore = typeof evaluator.finalScore === 'number'
    ? evaluator.finalScore
    : computeFinalScore(evaluator);
  const worthSalvaging = typeof pageFinalScore === 'number' && pageFinalScore >= ITERATE_SALVAGE_FLOOR;

  if (visualScore < iterateVisualFloor && !worthSalvaging) {
    return { method: 'iterate', reason: `image visually broken (visual=${visualScore} < ${iterateVisualFloor}, finalScore=${pageFinalScore})` };
  }
  if (semanticScore < iterateSemanticFloor && !worthSalvaging) {
    return { method: 'iterate', reason: `wrong scene (semantic=${semanticScore} < ${iterateSemanticFloor}, finalScore=${pageFinalScore})` };
  }
  if ((visualScore < iterateVisualFloor || semanticScore < iterateSemanticFloor) && worthSalvaging) {
    log.info(`🛟 [REPAIR-DECIDE] page ${pageNumber}: numeric gate tripped (visual=${visualScore}, semantic=${semanticScore}) but finalScore=${pageFinalScore} >= ${ITERATE_SALVAGE_FLOOR} — repairing locally instead of regenerating`);
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

  // 1d. Composition/viewpoint change (camera angle, shot distance, reframing)
  // OR a restage — figures that must be relocated into a different supporting
  // medium/surface than the one painted (on the quay instead of wading in the
  // water, on deck instead of swimming). Inpaint edits bounded regions: it
  // cannot move the camera, and repainting a figure's whole lower staging plus
  // its contact with the medium regenerates part of the frame with no style
  // anchor and drifts the medium (photoreal). The consolidator (rule 7b) owns
  // the classification and sets this flag — code only routes on the boolean,
  // never sniffs prose.
  // ADDITIVE to SETTLED "Grok inpaint handles pose/gaze/body-rotation": those
  // are the FIGURE's orientation inside a fixed frame; camera moves and
  // medium restages are cases that verdict never covered. Overrides the
  // salvage floor deliberately — no local repair can fix framing or restaging,
  // so a decent finalScore is no reason to keep such a page in inpaint.
  if (evaluator.consolidatedPlan?.scene_fix?.requires_regeneration === true) {
    return { method: 'iterate', reason: 'scene fix requires restaging (camera/composition/medium) — full regen' };
  }

  // 2. Entity issue — char-fix wins. Scene-only (covers fall through).
  //
  // CRITICAL ONLY, CASE-INSENSITIVE (owner ruling 2026-09-01, G5/option 2:
  // character faults route to character repair "only for critical for now").
  // Two rules live in this one gate:
  //   - The compare is case-insensitive because the entity evaluator emits
  //     UPPERCASE severities ('MAJOR' x96 / 'CRITICAL' x16 on
  //     job_1788215224103) while this gate matched lowercase only — the
  //     entity→char-fix route was dead code, and every entity fault fell
  //     through to inpaint, which took the raw defect prose as its edit
  //     instruction (p16: "appears visibly older…" painted Lorena into her
  //     60s, and that version shipped).
  //   - MAJOR entity findings get NO automatic repair: not char-fix (this
  //     gate), and not inpaint either — NOT_INPAINTABLE_TYPES keeps character
  //     types out of inpaint instructions regardless of how this gate routes.
  if (pageNumber > 0 && entityReport?.characters) {
    let worst = null; // {severity, charName, issue}
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
        const sev = String(issue.severity || '').toLowerCase();
        if (sev !== 'critical') continue;
        const pages = issue.pagesToFix || (issue.pageNumber ? [issue.pageNumber] : []);
        if (!pages.includes(pageNumber)) continue;
        if (!worst) worst = { severity: sev, charName, issue };
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
      // The finding's TYPE decides face vs full-figure (owner, 2026-09-01):
      // an age_shift is a face patch, never a full-figure repaint.
      const issueTypes = [worst.issue.subType || worst.issue.type].filter(Boolean);
      const repairParams = resolveRepairAxes(issueDescription, { hasFaceBbox: true, issueTypes });
      return {
        method: 'char-fix',
        reason: `entity ${worst.severity} on ${worst.charName}`,
        charName: worst.charName,
        severity: worst.severity,
        issueDescription,
        issueTypes,
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


// WHAT INPAINT MAY NOT BE ASKED TO DO (owner, 2026-08-26).
//
// Inpaint turns a figure, moves it, changes hand pose, gaze or expression, and
// edits objects. It cannot change clothing, hair, or the form of a face: asked
// to, it repaints the figure and the identity drifts. Those defects belong to
// character repair, which is anchored to the character's avatar, or to a page
// redo — both routes already exist.
//
// Measured on job_1787689073034_1v6ew0y1kae: 5 of 11 inpaint calls carried 9
// forbidden directives ("Change the hair color to light blonde", "Add the
// square bib panel and two crossing shoulder straps", "Recolour the shorts",
// "Repaint the hair light blonde and wavy", plus two pasted age findings).
//
// Keyed on the DECLARED type, never on the description prose — classifying by
// reading the text is what docs/SETTLED.md forbids. Same contract as
// ZERO_POINT_TYPES / MAX_SEVERITY_TYPES in scoring.js: the finding is still
// reported in full, only its ROUTE is constrained.
const NOT_INPAINTABLE_TYPES = new Set([
  // identity / face
  'character_identity', 'face_mismatch', 'face_drift', 'age_shift', 'skin_tone',
  // hair
  'hair', 'hair_change', 'hair_nuance',
  // clothing (garment_colour has its own mechanical recolour path)
  'clothing', 'clothing_inconsistent', 'clothing_detail', 'garment_colour', 'garment_color',
  // body form
  'scale',
]);

module.exports = { findBadPages, selectCharRepairTasks, decideRepairMethod, NOT_INPAINTABLE_TYPES };
