import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED: the batch evaluator's rebuilt eval record carries the
// judge's `notEvaluated` / `threeStageResult`. Own file: images.js destructures
// evaluateImageQuality at load, so the stub must be installed before anything
// requires images.js.

describe('evaluateImageBatch stores the evaluator evidence', () => {
  it('notEvaluated from the judge reaches the batch eval record', async () => {
    const ep = require_('../../server/lib/evalPipeline.js');
    const notEvaluated = [{ dimension: 'held_objects', reason: 'no_required_objects', detail: 'x' }];
    ep.evaluateImageQuality = vi.fn(async () => ({
      score: 50, figures: [], matches: [], detectedProblems: [],
      notEvaluated,
      threeStageResult: { stage1: 'what I see' },
    }));
    const { evaluateImageBatch } = require_('../../server/lib/images.js');
    const out = await evaluateImageBatch(
      [{ pageNumber: 1, imageData: 'data:image/jpeg;base64,AAAA', prompt: 'p', sceneDescription: 's', characterPhotos: [] }],
      { concurrency: 1 }
    );
    expect(out[0].notEvaluated).toEqual(notEvaluated);
    expect(out[0].threeStageResult).toEqual({ stage1: 'what I see' });
  });
});
