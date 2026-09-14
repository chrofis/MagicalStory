import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// @ts-ignore — CommonJS lib
import {
  computeTextRefineJoinWarnMs,
  awaitTextRefineJoin,
  selectJoinResult,
  isTotalTextAuditLoss,
} from '../../server/lib/textRefine.js';

/**
 * THE JOIN HAS NO DEADLINE (owner, 2026-09-14).
 *
 * It used to race the refine chain against a budget and take whatever had been
 * published when the timer fired. Nothing cancels the chain when that race is
 * lost, so it ran to completion and billed in full either way — the deadline
 * only ever discarded paid work, and the text audit's checks with it.
 *
 * The race became unwinnable when 2beda5425 moved the join from after the
 * repair pipeline to the end of pure generation, on the stated premise that
 * "images take ~25 min". They do not: pure page generation is ~55s and the ~25
 * minutes is the repair phase. Headroom fell from ~1460s to ~99s and 3 of 3
 * staging stories lost the race, two of them with ZERO refine rounds
 * (job_1789348171785_9oxos7dwv: round 1 alone took 294.8s and $1.01 of paid
 * text_refine/audit/lector work was thrown away).
 *
 * These tests pin BEHAVIOUR: the chain is never truncated, and what the join
 * hands downstream is the FINAL result, not an intermediate snapshot.
 */

/** Real snapshot shape — as published by textRefine's publish()/beginStep(). */
const snapshot = (over: any = {}) => ({
  pages: [{ pageNumber: 3, text: 'Julian legte seine Wange gegen die Schale.' }],
  original: [{ pageNumber: 3, text: 'Julian legte seine Wange gegen die Schale.' }],
  changed: [],
  rounds: [],
  audits: [],
  mergedFindings: [],
  partial: true,
  inFlight: true,
  ...over,
});

/** Real completed-result shape — job_1789348171785_9oxos7dwv, repair round 1. */
const completeResult = {
  pages: [{ pageNumber: 3, text: 'Julian legte seine Wange an die Schale. Er schloss die Augen halb und lächelte.' }],
  original: [{ pageNumber: 3, text: 'Julian legte seine Wange gegen die Schale.' }],
  changed: [3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  rounds: [{ round: 1, kind: 'repair', ok: true, elapsedMs: 294781, changedPages: [3, 4, 5] }],
  audits: [{ source: 'arc-informed', ok: true, faults: 7 }, { source: 'blind', ok: true, faults: 4 }],
  mergedFindings: [],
};

describe('awaitTextRefineJoin — the chain is never truncated', () => {
  it('a chain that outlives the warn budget is still awaited in full', async () => {
    // The old code raced this promise against the budget and took the snapshot.
    // Here the budget is 5ms and the chain answers at ~60ms: the join must
    // still return the COMPLETE result.
    let published: any = snapshot({ changed: [3], rounds: [{ round: 1, ok: true }] });
    const promise = new Promise((resolve) => setTimeout(() => resolve(completeResult), 60));
    const slowSeen: number[] = [];
    const out = await awaitTextRefineJoin(promise, () => published, {
      warnAfterMs: 5,
      onSlow: (ms: number) => slowSeen.push(ms),
    });
    expect(out.source).toBe('complete');
    expect(out.usable).toBe(completeResult);
    expect(out.slow).toBe(true);
    expect(slowSeen).toEqual([5]);          // reported, not acted on
    expect(out.waitedMs).toBeGreaterThanOrEqual(5);
  });

  it('the downstream text is the FINAL wording, not the intermediate snapshot', async () => {
    // The published snapshot carries the pre-repair prose; the completed chain
    // carries the rewrite. The old join shipped the snapshot whenever the timer
    // won — which is how a book audit got prose the book would not contain.
    const published = snapshot({ changed: [3], rounds: [{ round: 1, ok: true }] });
    const promise = new Promise((resolve) => setTimeout(() => resolve(completeResult), 40));
    const { usable } = await awaitTextRefineJoin(promise, () => published, { warnAfterMs: 1 });
    expect(usable.pages[0].text).toBe(completeResult.pages[0].text);
    expect(usable.pages[0].text).not.toBe(published.pages[0].text);
    expect(usable.partial).toBeUndefined();  // a complete run is not flagged partial
  });

  it('reads the snapshot getter at join time, never a value captured at call time', async () => {
    // textRefinePartial is reassigned by onProgress while the join waits.
    let published: any = null;
    const promise = new Promise((resolve) => setTimeout(() => { resolve(null); }, 20));
    setTimeout(() => { published = snapshot({ changed: [3], rounds: [{ round: 1, ok: true }] }); }, 5);
    const { usable, source } = await awaitTextRefineJoin(promise, () => published, {});
    expect(source).toBe('partial');
    expect(usable.changed).toEqual([3]);
  });

  it('no warning fires when the chain finishes inside the budget', async () => {
    const slowSeen: number[] = [];
    const out = await awaitTextRefineJoin(Promise.resolve(completeResult), () => null, {
      warnAfterMs: 5000,
      onSlow: (ms: number) => slowSeen.push(ms),
    });
    expect(out.slow).toBe(false);
    expect(slowSeen).toEqual([]);
    expect(out.source).toBe('complete');
  });

  it('a failed chain salvages the last published snapshot instead of losing the stage', async () => {
    const published = snapshot({ changed: [3, 4], rounds: [{ round: 1, ok: true }] });
    const { usable, source } = await awaitTextRefineJoin(Promise.resolve(null), () => published, {});
    expect(source).toBe('partial');
    expect(usable).toBe(published);
  });

  it('a REJECTED chain never throws the story away', async () => {
    const published = snapshot({ changed: [3], rounds: [{ round: 1, ok: true }] });
    const { usable, source } = await awaitTextRefineJoin(
      Promise.reject(new Error('provider exploded')), () => published, {}
    );
    expect(source).toBe('partial');
    expect(usable).toBe(published);
  });

  it('a chain that failed with nothing published leaves the original text', async () => {
    const { usable, source } = await awaitTextRefineJoin(Promise.resolve(null), () => null, {});
    expect(source).toBe('original');
    expect(usable).toBe(null);
  });
});

describe('computeTextRefineJoinWarnMs — a warning threshold, not a deadline', () => {
  it('is the same base for every reading level', () => {
    expect(computeTextRefineJoinWarnMs(10)).toBe(600000);
    expect(computeTextRefineJoinWarnMs(0)).toBe(600000);
    for (const level of ['standard', 'advanced', '1st-grade', undefined]) {
      expect((computeTextRefineJoinWarnMs as any)(18, undefined, level)).toBe(680000);
    }
  });

  it('adds 10s per page beyond ten and never subtracts', () => {
    expect(computeTextRefineJoinWarnMs(11)).toBe(610000);
    expect(computeTextRefineJoinWarnMs(18)).toBe(680000);
    expect(computeTextRefineJoinWarnMs(4)).toBe(600000);
    expect(computeTextRefineJoinWarnMs(undefined)).toBe(600000);
  });

  it('lets the env override win, and ignores junk', () => {
    expect(computeTextRefineJoinWarnMs(18, '90000')).toBe(90000);
    expect(computeTextRefineJoinWarnMs(18, '')).toBe(680000);
    expect(computeTextRefineJoinWarnMs(18, 'soon')).toBe(680000);
    expect(computeTextRefineJoinWarnMs(18, '0')).toBe(680000);
  });
});

describe('selectJoinResult', () => {
  const partial = { changed: [5], rounds: [{}] };

  it('ships the chain’s own result when there is one', () => {
    expect(selectJoinResult(completeResult, partial, false)).toEqual({ usable: completeResult, source: 'complete' });
  });

  it('salvages the last published snapshot when there is not', () => {
    expect(selectJoinResult(null, partial, true)).toEqual({ usable: partial, source: 'partial' });
    expect(selectJoinResult(null, null, true)).toEqual({ usable: null, source: 'original' });
  });
});

/**
 * The predicate that decides the LOG LEVEL of a lost refine (owner,
 * 2026-09-14): losing the whole text-quality gate ranks as an error, a partial
 * loss as a warning. Asserted on the severity decision, never on the sentence.
 */
describe('isTotalTextAuditLoss', () => {
  it('is a total loss — error level — when nothing was published', () => {
    expect(isTotalTextAuditLoss(null)).toBe(true);
    expect(isTotalTextAuditLoss({ changed: [], rounds: [] })).toBe(true);
  });

  it('is a partial loss — warn level — when rewritten pages shipped', () => {
    expect(isTotalTextAuditLoss({ changed: [3], rounds: [{}] })).toBe(false);
  });
});

describe('wiring: the join cannot be re-bounded', () => {
  const pipeline = fs.readFileSync(new URL('../../storyJobPipeline.js', import.meta.url), 'utf8');
  const lib = fs.readFileSync(new URL('../../server/lib/textRefine.js', import.meta.url), 'utf8');

  it('the pipeline joins through awaitTextRefineJoin and races nothing', () => {
    expect(pipeline).toContain('awaitTextRefineJoin(');
    // The exact regressed shape: the refine promise inside a Promise.race.
    expect(pipeline).not.toMatch(/Promise\.race\(\[\s*textRefinePromise/);
    expect(pipeline).not.toContain('text-refine-join-timeout');
  });

  it('the deadline machinery is gone from the library too', () => {
    expect(lib).not.toContain('computeTextRefineJoinTimeoutMs');
    expect(lib).not.toContain('shouldGraceJoin');
  });
});
