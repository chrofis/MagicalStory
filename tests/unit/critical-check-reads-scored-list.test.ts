/**
 * THE CRITICAL CHECK, THE ROUTER AND THE TYPE RESCUE READ THE LIST THE SCORE
 * READS (2026-09-26).
 *
 * Staging job_1790446348343_z3fw660ie p9. The semantic judge filed one finding
 * on a page rendered from a real landmark photo (fixture below, verbatim from
 * the stored version): a CRITICAL `setting`, `landmark_element: true`, whose
 * fix is "Replace the ... cityscape". The landmark guard ran in the
 * consolidator only: it dropped the finding, the consolidated list came back
 * `[]`, the page scored 100. But collectCriticalFindings treated `[]` as "never
 * consolidated", fell back to the raw semantic list, found the CRITICAL,
 * admitted the page to repair, and decideRepairMethod sent it to an inpaint
 * that had "no instruction to send".
 *
 * Two fixes, both pinned here:
 *  (A) guardLandmarkRecord runs at the eval merge on the quality and semantic
 *      records, so the raw list no longer carries the finding; it is kept as
 *      `suppressedIssues` (the record, never the deduction).
 *  (B) scoredFindingPools: when a consolidated list exists — empty included —
 *      it is the only list, exactly as scoring.applyScore reads it.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repairLogic = require_('../../server/lib/repairLogic');
const lp = require_('../../server/lib/landmarkProtection');
const scoring = require_('../../server/lib/scoring');

// p9's stored semantic finding (description trimmed, fields verbatim).
const P9_SEMANTIC = {
  severity: 'CRITICAL',
  type: 'setting',
  landmark_element: true,
  description: "The landmark context specifies 'Low bridge by Hauptbahnhof' (which is in Zurich), but the background of the illustration shows a Parisian cityscape",
  fix: "Replace the Parisian cityscape and Eiffel Tower with the appropriate cityscape and bridge for Zurich's Hauptbahnhof area",
};
const PROTECTION = { names: ['Low bridge by Hauptbahnhof'], landmarkPresent: true, eraIsHistorical: false, eraGuard: '', protect: true };

const p9Version = () => ({
  finalScore: 100,
  qualityScore: 100,
  scoreBreakdown: { visual: { score: 100 }, semantic: { score: 100 } },
  fixableIssues: [],
  semanticResult: { score: 100, semanticIssues: [P9_SEMANTIC] },
  consolidatedPlan: { deduped_issues: [], skipped: true, scene_fix: { severity: 'NONE', instruction: '', preserve: [] }, per_character_fixes: [] },
});

describe('(B) an empty consolidated list is the verdict the score charged', () => {
  it('p9 as stored: not critical, not bad, no rescue, no repair', () => {
    const v = p9Version();
    expect(repairLogic.collectCriticalFindings(v)).toEqual([]);
    expect(repairLogic.hasCriticalSeverityFinding(v)).toBe(false);
    expect(repairLogic.findBadPages({ 9: v })).toEqual([]);
    expect(repairLogic.findSafeRepairableFinding(v)).toBeNull();
    expect(repairLogic.decideRepairMethod(9, v, null).method).toBe('skip');
  });

  it('the score it is checked against: consolidated [] charges nothing', () => {
    const version: any = {};
    scoring.applyScore(version, { evalResult: { ...p9Version(), reasoning: 'ok' }, consolidatedPlan: p9Version().consolidatedPlan });
    expect(version.finalScore).toBe(100);
  });

  it('a never-consolidated page still reads the raw pools', () => {
    const v: any = { ...p9Version(), consolidatedPlan: null };
    expect(repairLogic.collectCriticalFindings(v)).toHaveLength(1);
    expect(repairLogic.collectCriticalFindings(v)[0].pool).toBe('semantic');
  });

  it('a type rescue reads the merged list, not a raw MAJOR the merge set aside', () => {
    const v: any = {
      ...p9Version(),
      fixableIssues: [{ severity: 'MAJOR', type: 'object_presence', description: 'a prop is missing' }],
    };
    expect(repairLogic.findSafeRepairableFinding(v)).toBeNull();
    v.consolidatedPlan = { deduped_issues: [{ severity: 'MAJOR', type: 'object_presence', description: 'a prop is missing', sources: ['quality'] }] };
    expect(repairLogic.findSafeRepairableFinding(v)).toEqual({ type: 'object_presence', severity: 'major', pool: 'consolidated' });
  });

  it('a non-empty consolidated list still routes to inpaint', () => {
    const v: any = {
      ...p9Version(),
      consolidatedPlan: { deduped_issues: [{ severity: 'MAJOR', type: 'object_presence', description: 'a prop is missing', sources: ['semantic'] }] },
    };
    expect(repairLogic.decideRepairMethod(9, v, null).method).toBe('inpaint');
  });

  it('the identity gate joins the figure id back from the raw finding of the same type and character', () => {
    const ROSTER = [{ name: 'Dan', avatars: { standard: 'x' }, photos: { face: 'x' } }];
    const v: any = {
      ...p9Version(),
      finalScore: 40,
      fixableIssues: [{ type: 'character_identity', severity: 'CRITICAL', character: 'Dan', figure: 2, description: 'x' }],
      consolidatedPlan: { deduped_issues: [{ type: 'character_identity', severity: 'CRITICAL', character: 'Dan', description: 'x', sources: ['final_checks'] }] },
    };
    const d = repairLogic.decideRepairMethod(4, v, null, { expectedCast: [{ name: 'Dan' }] });
    expect(d).toMatchObject({ method: 'char-fix', charName: 'Dan', targetFigure: 2 });
    // The merge set it aside → no char-fix from the raw finding alone.
    v.consolidatedPlan = { deduped_issues: [] };
    expect(repairLogic.decideRepairMethod(4, v, null, { expectedCast: [{ name: 'Dan' }], characters: ROSTER }).method).toBe('skip');
  });
});

describe('(A) guardLandmarkRecord guards the record where it is made', () => {
  it('drops the p9 finding from the semantic record and keeps it as suppressedIssues', () => {
    const semanticResult: any = { score: 100, semanticIssues: [P9_SEMANTIC] };
    const added = lp.guardLandmarkRecord(semanticResult, 'semanticIssues', PROTECTION, { quiet: true });
    expect(semanticResult.semanticIssues).toEqual([]);
    expect(added).toHaveLength(1);
    expect(semanticResult.suppressedIssues).toHaveLength(1);
    expect(semanticResult.suppressedIssues[0]).toMatchObject({ severity: 'CRITICAL', type: 'setting', suppressed: 'landmark_protected' });
  });

  it('keeps a landmark_element:true finding whose fix is not a removal (a character action)', () => {
    const action = {
      severity: 'CRITICAL', type: 'action_interaction', landmark_element: true, character: 'Levin',
      description: 'Levin is walking down the steps instead of climbing up', fix: "Change Levin's action to be climbing up the stone steps.",
    };
    const rec: any = { fixableIssues: [action] };
    lp.guardLandmarkRecord(rec, 'fixableIssues', PROTECTION, { quiet: true });
    expect(rec.fixableIssues).toEqual([action]);
    expect(rec.suppressedIssues).toEqual([]);
  });

  it('an unprotected page and a null holder are left alone', () => {
    const rec: any = { semanticIssues: [P9_SEMANTIC] };
    lp.guardLandmarkRecord(rec, 'semanticIssues', { protect: false, names: [] }, { quiet: true });
    expect(rec.semanticIssues).toEqual([P9_SEMANTIC]);
    expect(lp.guardLandmarkRecord(null, 'semanticIssues', PROTECTION)).toEqual([]);
  });

  it('the stored breakdown carries the quality and semantic suppressed records as siblings, never as issues', () => {
    const version: any = {};
    const semanticResult: any = { score: 100, semanticIssues: [P9_SEMANTIC] };
    lp.guardLandmarkRecord(semanticResult, 'semanticIssues', PROTECTION, { quiet: true });
    scoring.applyScore(version, {
      evalResult: { qualityScore: 100, reasoning: 'ok', fixableIssues: [], suppressedIssues: [], semanticResult },
      consolidatedPlan: null,
    });
    expect(version.finalScore).toBe(100);
    expect(version.scoreBreakdown.semantic.issues).toEqual([]);
    expect(version.scoreBreakdown.semantic.suppressedIssues).toHaveLength(1);
    expect(version.scoreBreakdown.visual.suppressedIssues).toEqual([]);
  });
});
