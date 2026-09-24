import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyScore, entityIssuesForPage } = require('../../server/lib/scoring.js');

// Shapes taken from staging job_1790100385959_1nitlympp's back cover (page -3),
// pulled 2026-09-24: the entity check filed jagged white edges on one child's
// arm as a MAJOR `cutout_artifact` — an artefact of OUR grid crop — and the
// consolidator relabelled it `figure_completeness` with sources ['entity'].
// Both cost 0 in the canonical scorer. The admin re-evaluate route kept its own
// severity-only sum, charged it 15, and showed 70 where the stored score is 85.
const PAGE = -3;
const entityReport = {
  characters: {
    Julian: {
      issues: [{
        type: 'cutout_artifact',
        subType: 'cutout_artifact',
        severity: 'MAJOR',
        pageNumber: PAGE,
        description: "The character's left arm and part of the jacket show jagged white edges and missing regions, indicating a cropping artifact.",
      }],
    },
    // A finding on another page must not leak into this one.
    Max: { issues: [{ type: 'face_mismatch', severity: 'CRITICAL', pageNumber: 4, description: 'different face' }] },
  },
};
// The evaluator's own result: one real semantic finding (a MAJOR scale error).
const evaluation = {
  score: 85,
  qualityScore: 100,
  reasoning: 'figure inventory ...',
  fixableIssues: [],
  semanticResult: {
    semanticIssues: [{ type: 'scale', severity: 'MAJOR', character: 'Max', description: 'Max is taller than Julian' }],
  },
  threeStageResult: null,
};
const storedPlan = {
  deduped_issues: [
    { type: 'scale', sources: ['semantic'], severity: 'MAJOR', character: 'Max', description: 'Max is taller than Julian' },
    { type: 'figure_completeness', sources: ['entity'], severity: 'MAJOR', character: 'Julian', description: 'Left arm shows jagged white edges (cropping artifact)' },
  ],
};

// What the unified pipeline stamps (repairPipeline stampAtCreation).
function pipelineStamp(consolidatedPlan: unknown) {
  const ent = entityIssuesForPage(PAGE, entityReport);
  const v: any = { entityIssues: ent.issues, entityPenaltyRaw: ent.penalty };
  applyScore(v, {
    evalResult: evaluation,
    entityResult: { issues: v.entityIssues, penalty: v.entityPenaltyRaw },
    consolidatedPlan,
  });
  return v;
}

// What the re-evaluate route stamps: the evaluator's result unmodified, the
// entity bucket from the same reader.
function reEvaluateStamp(consolidatedPlan: unknown) {
  const ent = entityIssuesForPage(PAGE, entityReport);
  const v: any = {};
  applyScore(v, {
    evalResult: evaluation,
    entityResult: { issues: ent.issues, penalty: ent.penalty },
    consolidatedPlan,
  });
  return v;
}

describe('re-evaluate scores a page exactly as the pipeline does', () => {
  it('the entity reader prices a crop artefact at 0 and keeps its type', () => {
    const ent = entityIssuesForPage(PAGE, entityReport);
    expect(ent.penalty).toBe(0);
    expect(ent.issues).toHaveLength(1);
    expect(ent.issues[0]).toMatchObject({ name: 'Julian', type: 'cutout_artifact', subType: 'cutout_artifact' });
  });

  it('consolidated: the relabelled entity-only crop finding costs 0 -> 85, same as the pipeline', () => {
    const re = reEvaluateStamp(storedPlan);
    const pipe = pipelineStamp(storedPlan);
    expect(re.finalScore).toBe(85);
    expect(re.entityPenalty).toBe(0);
    expect(re.evalScore).toBe(85);
    expect(re.finalScore).toBe(pipe.finalScore);
    expect(re.entityPenalty).toBe(pipe.entityPenalty);
    // The listed entity finding survives — it is priced, not deleted.
    expect(re.deductions.entity).toHaveLength(1);
  });

  it('raw (no consolidation): same number on both paths, crop artefact free', () => {
    const re = reEvaluateStamp(null);
    const pipe = pipelineStamp(null);
    expect(re.finalScore).toBe(85);
    expect(re.finalScore).toBe(pipe.finalScore);
    expect(re.entityPenalty).toBe(0);
  });

  it('a real entity defect is still charged', () => {
    const ent = entityIssuesForPage(4, entityReport);
    expect(ent.penalty).toBe(25);
  });
});
