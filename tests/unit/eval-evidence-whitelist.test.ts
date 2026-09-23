import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED: `notEvaluated` (and `threeStageResult`, `requiredTexts`) survive the
// result-assembly whitelists in images.js. Every provider branch of
// generateImageOnly and evaluateImageBatch rebuilds its own object from the
// evaluateImageQuality return — a field not listed there never reaches storage,
// which is why a staging run logged 8 check_not_evaluated events and stored
// notEvaluated: null on all 16 pages.

describe('carryEvalEvidence', () => {
  it('passes the evaluator evidence through, null when absent', () => {
    const { carryEvalEvidence } = require_('../../server/lib/images.js');
    const ne = [{ dimension: 'held_objects', reason: 'no_required_objects' }];
    const ts = { stage2: { issues: [] } };
    const rt = [{ id: null, label: 'cover', text: 'A Title' }];
    expect(carryEvalEvidence({ notEvaluated: ne, threeStageResult: ts, requiredTexts: rt }))
      .toEqual({ notEvaluated: ne, threeStageResult: ts, requiredTexts: rt });
    // Evaluated-and-nothing-skipped ([]) must NOT collapse to null.
    expect(carryEvalEvidence({ notEvaluated: [] }).notEvaluated).toEqual([]);
    expect(carryEvalEvidence(null)).toEqual({ notEvaluated: null, threeStageResult: null, requiredTexts: null });
  });

  it('every runEval assembly branch in images.js spreads it', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/images.js'), 'utf8');
    const branches = (src.match(/await runEval\(\)/g) || []).length;
    const spreads = (src.match(/\.\.\.carryEvalEvidence\(qualityResult\)/g) || []).length;
    // One per runEval branch, plus the Gemini fallback assembly and the batch
    // evaluator's rebuilt eval object.
    expect(spreads).toBe(branches + 2);
  });
});
