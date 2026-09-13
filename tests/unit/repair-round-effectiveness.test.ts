import { describe, it, expect } from 'vitest';

// @ts-ignore — plain CommonJS module
const { summarizeRepairRound, repairAttemptFromResult } = require('../../server/lib/repairLogic.js');

const attempt = (pageNumber: number, method: string, ok = true, error: string | null = null) =>
  ({ pageNumber, method, ok, error });

describe('summarizeRepairRound', () => {
  it('classifies improved / unchanged / regressed from the score delta', () => {
    const s = summarizeRepairRound({
      round: 1,
      attempts: [attempt(1, 'iterate'), attempt(2, 'inpaint'), attempt(3, 'char-fix')],
      beforeScores: { 1: 30, 2: 60, 3: 45 },
      afterScores: { 1: 70, 2: 50, 3: 45 },
    });
    expect(s.byMethod.iterate.improved).toBe(1);
    expect(s.byMethod.inpaint.regressed).toBe(1);
    expect(s.byMethod['char-fix'].unchanged).toBe(1);
    expect(s.improved).toBe(1);
    expect(s.regressed).toBe(1);
  });

  it('records avgDelta per method over scored pages only', () => {
    const s = summarizeRepairRound({
      round: 1,
      attempts: [attempt(1, 'iterate'), attempt(2, 'iterate')],
      beforeScores: { 1: 20, 2: 40 },
      afterScores: { 1: 50, 2: 50 },
    });
    // deltas +30 and +10 → 20
    expect(s.byMethod.iterate.avgDelta).toBe(20);
    expect(s.byMethod.iterate.attempted).toBe(2);
  });

  it('counts a failed attempt as failed, never as unchanged', () => {
    const s = summarizeRepairRound({
      round: 2,
      attempts: [attempt(5, 'inpaint', false, 'grok 500')],
      beforeScores: { 5: 33 },
      afterScores: {},
    });
    expect(s.byMethod.inpaint.failed).toBe(1);
    expect(s.byMethod.inpaint.unchanged).toBe(0);
    expect(s.byMethod.inpaint.repaired).toBe(0);
    expect(s.failed).toBe(1);
    expect(s.pages[0]).toMatchObject({ page: 5, outcome: 'failed', error: 'grok 500', after: null });
  });

  it('records a missing after-score as unknown, not unchanged', () => {
    const s = summarizeRepairRound({
      round: 1,
      attempts: [attempt(7, 'iterate')],
      beforeScores: { 7: 40 },
      afterScores: { 7: null },
    });
    expect(s.byMethod.iterate.unknown).toBe(1);
    expect(s.byMethod.iterate.unchanged).toBe(0);
    expect(s.byMethod.iterate.avgDelta).toBe(null);
    expect(s.pages[0].outcome).toBe('unknown');
  });

  it('a repair that scores worse is reported, even though the best version still ships', () => {
    const s = summarizeRepairRound({
      round: 3,
      attempts: [attempt(9, 'inpaint')],
      beforeScores: { 9: 72 },
      afterScores: { 9: 41 },
    });
    expect(s.pages[0]).toMatchObject({ page: 9, outcome: 'regressed', delta: -31 });
    expect(s.byMethod.inpaint.avgDelta).toBe(-31);
  });

  it('buckets an attempt with no method under "unknown" rather than dropping it', () => {
    const s = summarizeRepairRound({
      round: 1,
      attempts: [attempt(1, null as any)],
      beforeScores: { 1: 10 },
      afterScores: { 1: 20 },
    });
    expect(s.byMethod.unknown.improved).toBe(1);
    expect(s.attempted).toBe(1);
  });

  it('an empty round summarises to zeros without throwing', () => {
    const s = summarizeRepairRound({ round: 1, attempts: [], beforeScores: {}, afterScores: {} });
    expect(s).toMatchObject({ round: 1, attempted: 0, repaired: 0, failed: 0, improved: 0, regressed: 0 });
    expect(s.byMethod).toEqual({});
  });

  it('drops internal accumulators from the stored record', () => {
    const s = summarizeRepairRound({
      round: 1,
      attempts: [attempt(1, 'iterate')],
      beforeScores: { 1: 10 },
      afterScores: { 1: 20 },
    });
    expect(s.byMethod.iterate).not.toHaveProperty('totalDelta');
    expect(s.byMethod.iterate).not.toHaveProperty('scoredPages');
  });

  it('keeps per-page rows so a story can be read page by page', () => {
    const s = summarizeRepairRound({
      round: 2,
      attempts: [attempt(4, 'iterate'), attempt(6, 'char-fix', false, 'no avatar')],
      beforeScores: { 4: 22, 6: 35 },
      afterScores: { 4: 66 },
    });
    expect(s.pages).toEqual([
      { page: 4, method: 'iterate', before: 22, after: 66, delta: 44, outcome: 'improved' },
      { page: 6, method: 'char-fix', before: 35, after: null, delta: null, outcome: 'failed', error: 'no avatar' },
    ]);
  });
});

describe('repairAttemptFromResult — the method a repair result actually carries', () => {
  it('reads the method from `source` when only `source` is set (iterate / inpaint / char-fix results)', () => {
    expect(repairAttemptFromResult({ pageNumber: 14, imageData: 'x', source: 'iterate-round-1' }).method).toBe('iterate-round-1');
    expect(repairAttemptFromResult({ pageNumber: 2, imageData: 'x', source: 'char-fix-round-1' }).method).toBe('char-fix-round-1');
  });
  it('prefers an explicit `method` (the composite path sets one)', () => {
    expect(repairAttemptFromResult({ pageNumber: 3, imageData: 'x', source: 'composite-iterate-round-1', method: 'composite' }).method).toBe('composite');
  });
  it('a failed result is not ok and keeps its error; a missing error reads "no result"', () => {
    const a = repairAttemptFromResult({ pageNumber: 5, imageData: null, source: 'inpaint-round-2', error: 'boom' });
    expect(a).toEqual({ pageNumber: 5, method: 'inpaint-round-2', ok: false, error: 'boom' });
    expect(repairAttemptFromResult({ pageNumber: 6, imageData: null }).error).toBe('no result');
  });
  it('summarises under the source name, never "unknown", for a normal iterate result', () => {
    const s = summarizeRepairRound({ round: 1, attempts: [repairAttemptFromResult({ pageNumber: 14, imageData: 'x', source: 'iterate-round-1' })], beforeScores: { 14: -30 }, afterScores: { 14: -10 } });
    expect(Object.keys(s.byMethod)).toEqual(['iterate-round-1']);
    expect(s.pages[0].method).toBe('iterate-round-1');
  });
});
