/**
 * THE LANDMARK GUARD SUPPRESSES THE DEDUCTION, NOT THE RECORD.
 *
 * Until 2026-09-19 the guard's removal was total: a dropped finding vanished
 * from `fixableIssues` and left NO trace anywhere in stored data, so a page
 * that had been judged with eight findings stored six and nothing said the
 * other two had ever been emitted.
 *
 * Measured on staging story job_1789759147125_p08djwhbl page 1 (the fixtures
 * below are that page's stored findings, verbatim):
 *   v0 — complianceResult.fixable_issues 8, scoreBreakdown.threeStage.issues 6.
 *        The two missing are exactly the two `landmark_element: true` entries,
 *        one of them a CRITICAL.
 *   v1 — 4 and 3, the same way.
 *
 * The fix adds a THIRD return value, `suppressed`, and a sibling stored field
 * `scoreBreakdown.threeStage.suppressedIssues`. It is a recording channel —
 * exactly like `notEvaluated` — and this file pins that it never becomes a
 * deduction: `kept` is byte-identical to before, so no score, no issue count
 * and no redo decision can move.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const lp = require_('../../server/lib/landmarkProtection');
const scoring = require_('../../server/lib/scoring');

// The stored page-1 v0 findings of job_1789759147125_p08djwhbl.
const V0 = [
  { severity: 'MAJOR', type: 'clothing', landmark_element: false, description: 'Wearing blue jeans instead of dark navy corduroy trousers as specified in clothing contract', fix: 'Repaint trousers dark navy corduroy' },
  { severity: 'MODERATE', type: 'clothing_detail', landmark_element: false, description: 'Wearing white t-shirt instead of long-sleeved white cotton shirt', fix: 'Replace t-shirt with a long-sleeved white cotton shirt' },
  { severity: 'MAJOR', type: 'clothing', landmark_element: false, description: 'Wearing brown lace-up shoes instead of brown leather ankle boots', fix: 'Replace shoes with brown leather ankle boots' },
  { severity: 'MAJOR', type: 'action_interaction', landmark_element: false, description: 'Facing right while prompt requires him to face left while drawing', fix: 'Rotate the figure to face left' },
  { severity: 'CRITICAL', type: 'action_interaction', landmark_element: false, description: 'Interacting with cracked pavement instead of pale grey gravel; no dragon shape present', fix: 'Draw a dragon shape under his hand' },
  { severity: 'MAJOR', type: 'duplicate_identity', landmark_element: false, description: 'Extra adult figures present: man leaning on stone wall and two people on bench', fix: 'Remove the two people on the bench' },
  { severity: 'MODERATE', type: 'setting', landmark_element: true, description: 'Setting includes buildings, church steeple, tiled roofs, and stone wall inconsistent with focused park scene', fix: 'Simplify background to emphasize large linden tree roots; remove distant architecture unless visually integrated' },
  { severity: 'CRITICAL', type: 'object_presence', landmark_element: true, description: "Ground surface described as 'cracked pavement' rather than gravel", fix: 'Replace cracked pavement with pale grey gravel consistent with Lindenhof park surface' },
];

// v1 of the same page: 4 findings, one landmark_element:true CRITICAL.
const V1 = [
  { severity: 'MAJOR', type: 'clothing', landmark_element: false, description: 'Levin wears blue jeans instead of specified dark navy corduroy trousers', fix: 'Repaint the trousers dark navy corduroy' },
  { severity: 'CRITICAL', type: 'action_interaction', landmark_element: false, description: 'Levin interacts with a pre-etched spiral on paved ground instead of drawing a dragon shape in loose gravel', fix: 'Draw a dragon shape in gravel' },
  { severity: 'MODERATE', type: 'duplicate_identity', landmark_element: false, description: 'Extra background figures present: man leaning on stone wall and two adults on bench', fix: 'Remove the background bench figures' },
  { severity: 'CRITICAL', type: 'object_presence', landmark_element: true, description: 'Ground surface rendered as paved stone with etched spiral, but prompt specifies gravel at Lindenhof', fix: 'Replace paved ground with pale grey loose gravel covering the area around Levin’s hands and knees' },
];

const PROTECTION = { names: ['Lindenhof'], landmarkPresent: true, eraIsHistorical: false, eraGuard: '', protect: true };

describe('filterProtectedRemovals keeps the record', () => {
  it('drops the same findings it always dropped — kept is unchanged', () => {
    const r0 = lp.filterProtectedRemovals(V0, PROTECTION, { quiet: true });
    expect(r0.kept).toHaveLength(6);
    expect(r0.dropped).toHaveLength(2);
    expect(r0.kept.every((i: any) => i.landmark_element === false)).toBe(true);

    const r1 = lp.filterProtectedRemovals(V1, PROTECTION, { quiet: true });
    expect(r1.kept).toHaveLength(3);
    expect(r1.dropped).toHaveLength(1);
  });

  it('returns the dropped findings as a marked record', () => {
    const { suppressed } = lp.filterProtectedRemovals(V0, PROTECTION, { quiet: true });
    expect(suppressed).toHaveLength(2);
    expect(suppressed.map((i: any) => i.severity).sort()).toEqual(['CRITICAL', 'MODERATE']);
    for (const s of suppressed) {
      expect(s.suppressed).toBe(lp.SUPPRESSED_REASON);
      expect(s.suppressed).toBe('landmark_protected');
      expect(s.suppressedBy).toBe('landmark_element=true');
      // The finding itself survives intact — description, type, severity, fix.
      expect(typeof s.description).toBe('string');
      expect(s.description.length).toBeGreaterThan(10);
    }
    // The CRITICAL that used to disappear without trace is one of them.
    expect(suppressed.some((i: any) => i.severity === 'CRITICAL' && i.type === 'object_presence')).toBe(true);
  });

  it('never mutates the caller\'s finding objects', () => {
    const r = lp.filterProtectedRemovals(V0, PROTECTION, { quiet: true });
    expect(r.suppressed[0]).not.toBe(r.dropped[0]);
    expect(V0.every((i: any) => i.suppressed === undefined)).toBe(true);
  });

  it('records WHICH rule fired when the subject was never declared', () => {
    const undeclared = [{ severity: 'MAJOR', type: 'object_presence', description: 'x', fix: 'Remove the tower' }];
    const { suppressed } = lp.filterProtectedRemovals(undeclared, PROTECTION, { quiet: true });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].suppressedBy).toBe('type=object_presence (subject undeclared)');
  });

  it('is empty on an unprotected page and on an empty list', () => {
    expect(lp.filterProtectedRemovals(V0, { ...PROTECTION, protect: false }, { quiet: true }).suppressed).toEqual([]);
    expect(lp.filterProtectedRemovals([], PROTECTION, { quiet: true }).suppressed).toEqual([]);
  });
});

describe('the record reaches stored data without touching the arithmetic', () => {
  const evalResult = (issues: any[], suppressedIssues: any[]) => ({
    qualityScore: 70,
    fixableIssues: issues.map(i => ({ ...i, source: 'three-stage' })),
    threeStageResult: { score: 40, fixableIssues: issues, suppressedIssues },
  });

  it('scoreBreakdown.threeStage carries suppressedIssues as a SIBLING of issues', () => {
    const { kept, suppressed } = lp.filterProtectedRemovals(V0, PROTECTION, { quiet: true });
    const version: any = {};
    scoring.applyScore(version, { evalResult: evalResult(kept, suppressed) });
    const ts = version.scoreBreakdown.threeStage;
    expect(ts.issues).toHaveLength(6);
    expect(ts.suppressedIssues).toHaveLength(2);
    // A suppressed finding is NOT in `issues` — that is what keeps every
    // consumer (deductions, issue counts, hasCatastrophic, findBadPages) intact.
    expect(ts.issues.some((i: any) => i.suppressed)).toBe(false);
  });

  it('the score is identical with and without the suppressed record', () => {
    const { kept, suppressed } = lp.filterProtectedRemovals(V1, PROTECTION, { quiet: true });
    const withRecord: any = {};
    const without: any = {};
    scoring.applyScore(withRecord, { evalResult: evalResult(kept, suppressed) });
    scoring.applyScore(without, { evalResult: evalResult(kept, []) });
    expect(withRecord.finalScore).toBe(without.finalScore);
    expect(withRecord.evalScore).toBe(without.evalScore);
    expect(withRecord.deductions).toEqual(without.deductions);
  });

  it('a suppressed CRITICAL changes neither the redo decision nor the deductions', () => {
    const { kept, suppressed } = lp.filterProtectedRemovals(V0, PROTECTION, { quiet: true });
    const withRecord: any = {};
    const without: any = {};
    scoring.applyScore(withRecord, { evalResult: evalResult(kept, suppressed) });
    scoring.applyScore(without, { evalResult: evalResult(kept, []) });
    // shouldRedo reads scoreBreakdown.*.issues (hasCatastrophic) and the score.
    expect(scoring.shouldRedo(withRecord)).toBe(scoring.shouldRedo(without));
    const all = ([] as any[]).concat(...Object.values(withRecord.deductions || {}));
    expect(all.some((d: any) => d?.suppressed)).toBe(false);
    expect(all).toHaveLength(([] as any[]).concat(...Object.values(without.deductions || {})).length);
  });

  it('defaults to an empty array when the evaluator supplied none', () => {
    const version: any = {};
    scoring.applyScore(version, { evalResult: { qualityScore: 80, fixableIssues: [], threeStageResult: { score: 90, fixableIssues: [] } } });
    expect(version.scoreBreakdown.threeStage.suppressedIssues).toEqual([]);
  });
});
