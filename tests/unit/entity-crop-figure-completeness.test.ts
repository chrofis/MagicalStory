import { describe, it, expect } from 'vitest';

// Owner, 2026-09-24: "log only". The entity check sees our grid CROP, never the
// page, so a `figure_completeness` finding that ONLY it reported is a crop
// artefact: it stays in the report, costs 0 and takes no repair route. Staging
// job_1790100385959_1nitlympp's back cover lost 15 points and got an inpaint
// plan for white edges that existed only in the crop. The same type from the
// quality judge (which sees the page) keeps its full cost and every route.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const scoring = require('../../server/lib/scoring');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isCropArtifact, collectCriticalFindings, decideRepairMethod, selectCharRepairTasks } = require('../../server/lib/repairLogic');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dropCropArtifactFixes } = require('../../server/lib/feedbackConsolidator');

const deduped = (sources: string[], severity = 'MAJOR') => ({
  type: 'figure_completeness', character: 'CharA', sources, severity, description: 'x',
});

describe('entity-only figure_completeness is logged, never deducted', () => {
  it('costs 0 from the entity check and full points from the page judges', () => {
    expect(scoring.deductionPoints({ type: 'figure_completeness', severity: 'major', source: 'entity' })).toBe(0);
    expect(scoring.deductionPoints({ type: 'figure_completeness', severity: 'major', source: 'consolidated' })).toBe(15);
    expect(scoring.deductionPoints({ type: 'figure_completeness', severity: 'major', sources: ['entity', 'quality'] })).toBe(15);
    expect(scoring.deductionPoints({ type: 'figure_completeness', severity: 'major', sources: ['quality'] })).toBe(15);
    // A raw entity-report issue states its origin through the caller.
    expect(scoring.deductionPoints({ subType: 'figure_completeness', severity: 'MAJOR', source: 'character' }, { entity: true })).toBe(0);
  });

  it('a consolidated entity-only finding is kept in the deductions but does not lower the score', () => {
    const d = scoring.composeDeductions({ consolidated: [deduped(['entity']), { type: 'scale', sources: ['semantic'], severity: 'MAJOR', description: 'y' }] });
    expect(d.entity).toHaveLength(1);
    expect(scoring.computeMathFinalScore(d)).toBe(85);
  });

  it('never makes a page critical and never routes a char-fix', () => {
    const v = { consolidatedPlan: { deduped_issues: [deduped(['entity'], 'CRITICAL')] } };
    expect(collectCriticalFindings(v)).toEqual([]);
    const seen = { consolidatedPlan: { deduped_issues: [deduped(['entity', 'quality'], 'CRITICAL')] } };
    expect(collectCriticalFindings(seen)).toHaveLength(1);
    const report = { characters: { CharA: { issues: [{ id: 'i', type: 'figure_completeness', severity: 'CRITICAL', pagesToFix: [4] }] } } };
    expect(selectCharRepairTasks(report, {}).tasks).toEqual([]);
    const okEval = { scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } }, fixableIssues: [] };
    expect(decideRepairMethod(4, okEval, report).method).not.toBe('char-fix');
  });

  it('reads the declared type and source, never the text', () => {
    expect(isCropArtifact(deduped(['entity']))).toBe(true);
    expect(isCropArtifact(deduped(['quality']))).toBe(false);
    expect(isCropArtifact({ type: 'figure_completeness', severity: 'MAJOR' })).toBe(false);
    expect(isCropArtifact({ type: 'figure_completeness' }, { entity: true })).toBe(true);
    expect(isCropArtifact({ type: 'face_drift', sources: ['entity'], description: 'cropping artifact' })).toBe(false);
  });

  it('the plan drops the crop-artefact fix and keeps the rest', () => {
    const plan = {
      deduped_issues: [deduped(['entity']), { type: 'figure_completeness', character: 'CharB', sources: ['quality'], severity: 'MAJOR', description: 'z' }],
      per_character_fixes: [
        { characterName: 'CharA', types: ['figure_completeness'], severity: 'MAJOR', fix_instruction: 'fill', issues: ['a'] },
        { characterName: 'CharB', types: ['figure_completeness'], severity: 'MAJOR', fix_instruction: 'fill', issues: ['b'] },
        { characterName: 'CharA', types: ['cutout_artifact'], severity: 'MAJOR', fix_instruction: 'fill', issues: ['c'] },
      ],
      dropped_issues: [] as any[],
    };
    expect(dropCropArtifactFixes(plan, 1)).toBe(2);
    expect(plan.per_character_fixes.map(f => f.characterName)).toEqual(['CharB']);
    expect(plan.dropped_issues).toHaveLength(2);
    expect(plan.deduped_issues).toHaveLength(2);
  });
});
