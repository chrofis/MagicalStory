/**
 * identity_swap — a figure whose hair AND face both differ from the reference
 * reads as another person: CRITICAL, and it takes a char-fix (owner, 2026-09-27,
 * reversing the 2026-09-04 critical-only ruling for this one case;
 * docs/decisions.md 2026-09-27).
 *
 * Motivating case: staging job_1790446348343_z3fw660ie initial page (-2). The
 * grid judge filed a MAJOR hair_change for Fiona drawn as another woman, the
 * consolidator dropped it as `profile_says_trait_is_correct`, the page scored 96
 * and was never repaired.
 *
 * Pinned here: the five registration sites of a scored type, the char-fix
 * route, and that the consolidator can neither drop nor relabel the finding.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const { ENTITY_CHECK_TYPES, bucketForType } = require('../../server/lib/evalBuckets.js');
const { deductionPoints, composeDeductions } = require('../../server/lib/scoring.js');
const { decideRepairMethod, findBadPages, hasCriticalSeverityFinding } = require('../../server/lib/repairLogic.js');
const { CHAR_FIX_DEFECT_PHRASES } = require('../../server/lib/faceRepair.js');
const consolidator = require('../../server/lib/feedbackConsolidator.js');
/* eslint-enable @typescript-eslint/no-var-requires */

const SWAP = {
  name: 'Fiona', type: 'identity_swap', subType: 'identity_swap', severity: 'CRITICAL',
  pagesToFix: [-2], description: 'Cell B: short dark curly hair and an older, rounder face; the reference has long straight light-brown hair.',
};

describe('identity_swap is a registered entity type', () => {
  it('is on the entity judge closed list and bills as character_identity', () => {
    expect(ENTITY_CHECK_TYPES).toContain('identity_swap');
    expect(bucketForType('identity_swap')).toBe('character_identity');
  });

  it('costs CRITICAL even when the judge slips to MAJOR — both finding shapes', () => {
    expect(deductionPoints({ type: 'consistency', subType: 'identity_swap', severity: 'MAJOR' })).toBe(25);
    expect(deductionPoints({ type: 'identity_swap', severity: 'MAJOR' })).toBe(25);
    // A hair change alone stays MAJOR.
    expect(deductionPoints({ type: 'consistency', subType: 'hair_change', severity: 'MAJOR' })).toBe(15);
  });

  it('the client mirror bills it the same', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../client/src/hooks/useRepairWorkflow.ts'), 'utf8');
    const floors = src.slice(src.indexOf('const MIN_SEVERITY_TYPES'), src.indexOf('};', src.indexOf('const MIN_SEVERITY_TYPES')));
    expect(floors).toMatch(/identity_swap:\s*'critical'/);
  });

  it('a char-fix prompt names face and hair, never the judge sentence', () => {
    expect(CHAR_FIX_DEFECT_PHRASES.identity_swap).toMatch(/face and hair/);
  });
});

describe('identity_swap routes to char-fix', () => {
  const evaluator = { scoreBreakdown: { visual: { score: 100 }, semantic: { score: 100 } }, fixableIssues: [], consolidatedPlan: { deduped_issues: [] } };
  const report = (issues: unknown[]) => ({ characters: { Fiona: { issues } } });

  it('a CRITICAL identity_swap on a cover page is a face char-fix', () => {
    const d = decideRepairMethod(-2, evaluator, report([SWAP]));
    expect(d.method).toBe('char-fix');
    expect(d.charName).toBe('Fiona');
    expect(d.issueTypes).toEqual(['identity_swap']);
    expect(d.repairParams.faceOnly).toBe(true);
  });

  it('NEGATIVE CONTROL — a MAJOR hair_change alone still gets no char-fix (2026-09-04 stands for single-trait drift)', () => {
    const d = decideRepairMethod(-2, evaluator, report([{ ...SWAP, type: 'hair_change', subType: 'hair_change', severity: 'MAJOR' }]));
    expect(d.method).not.toBe('char-fix');
  });
});

describe('the consolidator cannot drop or relabel an identity swap', () => {
  const entry = consolidator.identitySwapEntries([{ ...SWAP, characterName: 'Fiona', sources: ['entity'] }])[0];

  it('a plan whose model dropped it as profile_says_trait_is_correct still charges it', () => {
    const plan: any = {
      deduped_issues: [],
      dropped_issues: [{ issue: 'Fiona hair', reason: 'profile_says_trait_is_correct', ids: ['E1'], type: 'hair', character: 'Fiona' }],
    };
    const idx = consolidator.indexFindings({ entityIssues: [{ characterName: 'Fiona', description: 'hair differs', severity: 'MAJOR' }] });
    plan.deduped_issues = consolidator.resolveDedupedIssues(plan, idx, -2).deduped;
    expect(consolidator.appendIdentitySwaps(plan, [{ ...SWAP, characterName: 'Fiona' }], -2)).toBe(1);
    expect(plan.deduped_issues).toEqual([entry]);
    expect(entry).toMatchObject({ type: 'identity_swap', severity: 'CRITICAL', character: 'Fiona', sources: ['entity'] });
    // Appending twice adds nothing.
    expect(consolidator.appendIdentitySwaps(plan, [{ ...SWAP, characterName: 'Fiona' }], -2)).toBe(0);
  });

  it('the charged entry makes the page critical, bad, and bills 25 in the entity pool', () => {
    const evalResult = { finalScore: 96, qualityScore: 100, fixableIssues: [], consolidatedPlan: { deduped_issues: [entry] } };
    expect(hasCriticalSeverityFinding(evalResult)).toBe(true);
    expect(findBadPages({ '-2': evalResult })).toEqual([-2]);
    const d = composeDeductions({ consolidated: [entry] });
    expect(d.entity.map((i: any) => i.subType || i.type)).toEqual(['identity_swap']);
    expect(d.consolidated).toEqual([]);
  });

  it('a page whose only finding is a swap skips the model call and is still charged', async () => {
    const out = await consolidator.consolidateEvaluation({
      evalResult: { fixableIssues: [], semanticResult: null },
      entityIssues: [{ name: 'Fiona', type: 'identity_swap', subType: 'identity_swap', severity: 'CRITICAL', description: SWAP.description, source: 'character' }],
      pageNumber: -2,
    });
    expect(out.skipped).toBe(true);
    expect(out.dedupedIssues).toHaveLength(1);
    expect(out.dedupedIssues[0]).toMatchObject({ type: 'identity_swap', severity: 'CRITICAL', character: 'Fiona' });
  });

  it('consolidateFeedback holds swaps out of the model input and appends them after its guards', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/feedbackConsolidator.js'), 'utf8');
    expect(src).toMatch(/const identitySwaps = entityIssues\.filter\(isIdentitySwap\);\s*\r?\n\s*entityIssues = entityIssues\.filter\(e => !isIdentitySwap\(e\)\);/);
    expect(src).toMatch(/dropCropArtifactFixes\(plan, pageNumber\);\s*\r?\n\s*appendIdentitySwaps\(plan, identitySwaps, pageNumber\);/);
    // The pre-flattened entity path carries the declared type (it used to drop it).
    expect(src).toMatch(/type: e\.subType \|\| e\.type \|\| null,/);
  });
});
