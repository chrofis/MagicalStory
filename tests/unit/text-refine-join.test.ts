import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import {
  computeTextRefineJoinTimeoutMs,
  selectJoinResult,
  shouldGraceJoin,
  isTotalTextAuditLoss,
  TEXT_REFINE_JOIN_GRACE_MS,
} from '../../server/lib/textRefine.js';

/**
 * The pipeline joins the text-refine stage against a deadline. Nothing cancels
 * the refine when that race is lost — the chain runs to completion and bills in
 * full — so the deadline only ever discards paid work (owner ruling
 * 2026-09-14). Two things follow, and both are pinned here:
 *
 *   1. One base for every reading level. The old split gave `standard` and
 *      `advanced` 600s and everything else 300s.
 *   2. A bounded grace when a round is actually in flight at the deadline.
 *
 * The regression that motivated it: staging job_1789343124794_z2c779f7i, an
 * 18-page young-reader book, got 380s, no round finished, and it shipped a
 * five-page text/picture mismatch the audit checklist exists to catch.
 */
describe('computeTextRefineJoinTimeoutMs', () => {
  it('gives every reading level the same base — the level is not an input', () => {
    // `standard`, `advanced`, a young-reader level and an absent one all used to
    // pick a different base; the budget no longer takes a level at all, and a
    // stray third argument cannot change the answer.
    expect(computeTextRefineJoinTimeoutMs(10)).toBe(600000);
    expect(computeTextRefineJoinTimeoutMs(0)).toBe(600000);
    for (const level of ['standard', 'advanced', '1st-grade', undefined]) {
      expect((computeTextRefineJoinTimeoutMs as any)(18, undefined, level)).toBe(680000);
    }
  });

  it('adds 10s per page beyond ten', () => {
    expect(computeTextRefineJoinTimeoutMs(11)).toBe(610000);
    expect(computeTextRefineJoinTimeoutMs(18)).toBe(680000);
    expect(computeTextRefineJoinTimeoutMs(24)).toBe(740000);
  });

  it('never subtracts for a short book', () => {
    expect(computeTextRefineJoinTimeoutMs(4)).toBe(600000);
  });

  it('REGRESSION: an 18-page young-reader book gets 680000, not 380000', () => {
    expect(computeTextRefineJoinTimeoutMs(18)).toBe(680000);
    expect(computeTextRefineJoinTimeoutMs(18)).not.toBe(380000);
  });

  it('lets the env override win outright', () => {
    expect(computeTextRefineJoinTimeoutMs(18, '90000')).toBe(90000);
    expect(computeTextRefineJoinTimeoutMs(18, 90000)).toBe(90000);
  });

  it('ignores an unset or unparsable override', () => {
    expect(computeTextRefineJoinTimeoutMs(18, undefined)).toBe(680000);
    expect(computeTextRefineJoinTimeoutMs(18, '')).toBe(680000);
    expect(computeTextRefineJoinTimeoutMs(18, 'soon')).toBe(680000);
    expect(computeTextRefineJoinTimeoutMs(18, '0')).toBe(680000);
  });

  it('handles a missing page count', () => {
    expect(computeTextRefineJoinTimeoutMs(undefined)).toBe(600000);
    expect(computeTextRefineJoinTimeoutMs(null)).toBe(600000);
  });
});

describe('shouldGraceJoin', () => {
  it('opens the grace only when a step is in flight at the deadline', () => {
    expect(shouldGraceJoin({ inFlight: true, changed: [] })).toBe(true);
  });

  it('does not open it when the last published step had completed', () => {
    expect(shouldGraceJoin({ inFlight: false, changed: [3] })).toBe(false);
  });

  it('does not open it when the refiner never published', () => {
    expect(shouldGraceJoin(null)).toBe(false);
    expect(shouldGraceJoin(undefined)).toBe(false);
    expect(shouldGraceJoin({})).toBe(false);
  });

  it('keeps the grace bounded', () => {
    expect(TEXT_REFINE_JOIN_GRACE_MS).toBe(120000);
  });
});

describe('selectJoinResult', () => {
  const complete = { changed: [1, 2], rounds: [{}, {}] };
  const partial = { changed: [5], rounds: [{}] };
  const nothingYet = { changed: [], rounds: [] };

  it('ships the refiner’s own result when it won the race', () => {
    expect(selectJoinResult(complete, partial, false)).toEqual({ usable: complete, source: 'complete' });
  });

  it('keeps a failed refine failed — it does not silently promote a snapshot', () => {
    expect(selectJoinResult(null, partial, false)).toEqual({ usable: null, source: 'failed' });
  });

  it('salvages the last published snapshot on timeout', () => {
    expect(selectJoinResult(null, partial, true)).toEqual({ usable: partial, source: 'partial' });
  });

  it('falls back to the original text when no round had finished', () => {
    expect(selectJoinResult(null, nothingYet, true)).toEqual({ usable: nothingYet, source: 'original' });
    expect(selectJoinResult(null, null, true)).toEqual({ usable: null, source: 'original' });
  });

  it('a round that landed inside the grace ships as a complete run', () => {
    // The grace hands the join the refiner's real result, so the caller reports
    // `timedOut` as false from that point on.
    expect(selectJoinResult(complete, partial, false).source).toBe('complete');
  });
});

/**
 * The predicate that decides the LOG LEVEL of a lost join (owner, 2026-09-14):
 * losing the whole text-quality gate ranks as an error, a partial loss as a
 * warning. Asserted on the severity decision, never on the sentence.
 */
describe('isTotalTextAuditLoss', () => {
  it('is a total loss — error level — when nothing was published', () => {
    expect(isTotalTextAuditLoss(null)).toBe(true);
    expect(isTotalTextAuditLoss(undefined)).toBe(true);
    expect(isTotalTextAuditLoss({ changed: [], rounds: [] })).toBe(true);
  });

  it('is a partial loss — warn level — when rewritten pages shipped', () => {
    expect(isTotalTextAuditLoss({ changed: [3], rounds: [{}] })).toBe(false);
    expect(isTotalTextAuditLoss({ changed: [3, 4, 5], rounds: [{}] })).toBe(false);
  });

  it('a round that finished and changed nothing still checked the pages — but ships no evidence, so it ranks as a total loss', () => {
    // Pinning the current contract: `changed` is the only signal the join has.
    expect(isTotalTextAuditLoss({ changed: [], rounds: [{ ok: true }] })).toBe(true);
  });
});
