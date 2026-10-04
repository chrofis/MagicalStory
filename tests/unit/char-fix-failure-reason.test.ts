import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// @ts-ignore — plain CommonJS module
const { describeCharFixFailure, repairAttemptFromResult, summarizeRepairRound } = require('../../server/lib/repairLogic.js');

// BEHAVIOUR PINNED 2026-09-26: a char-fix that returns no image names the gate
// that refused it. The pipeline used to replace faceRepair's rejectedReason /
// gateMessage with the fixed "char-fix produced no usable image", so the round
// log, retryHistory, failedRepairs and repairRounds never said which gate it was.

describe('describeCharFixFailure', () => {
  it.each([
    ['blend_gate', 'IoU 0.41 below 0.6'],
    ['style_drift', 'photographic vs watercolour'],
    ['repair_unnatural', 'figure-integrity: face does not match the page\'s other faces'],
  ])('carries the %s reason and its message', (rejectedReason, gateMessage) => {
    const e = describeCharFixFailure({ imageData: null, rejectedReason, gateMessage, attempts: 3 });
    expect(e).toContain(rejectedReason);
    expect(e).toContain(gateMessage);
    expect(e).toContain('3 attempt');
  });

  it('carries a reason that has no message (the blur gate)', () => {
    expect(describeCharFixFailure({ imageData: null, rejectedReason: 'repaired_figure_blurred' })).toContain('repaired_figure_blurred');
  });

  it('carries a plain error and says so when nothing was reported', () => {
    expect(describeCharFixFailure({ imageData: null, error: 'Invalid bounding box' })).toContain('Invalid bounding box');
    expect(describeCharFixFailure(null)).toContain('no reason reported');
  });

  it('reaches the round summary unchanged', () => {
    const error = describeCharFixFailure({ imageData: null, rejectedReason: 'blend_gate', gateMessage: 'IoU 0.41' });
    const s = summarizeRepairRound({
      round: 1,
      attempts: [repairAttemptFromResult({ pageNumber: 4, imageData: null, method: 'char-fix', error })],
      beforeScores: { 4: 40 },
      afterScores: {},
    });
    expect(s.pages[0].error).toContain('blend_gate');
  });

  it('is what the pipeline returns for a no-image char-fix', () => {
    const src = readFileSync(resolve(__dirname, '../../server/lib/repairPipeline.js'), 'utf8');
    expect(src).toContain("require('./repairLogic').describeCharFixFailure(repairResult)");
    expect(src).not.toContain("error: 'char-fix produced no usable image'");
  });
});
