/**
 * EVERY RE-PLAN ROUND FACES THE REGRESSION GUARD, ROUND 1 INCLUDED (2026-09-24).
 *
 * Owner, on how often the page plan's re-plan makes the plan worse: "That is a
 * serious defect and must be fixed." Round 1 used to be exempt (`round > 1`),
 * and over every stored round-1 recheck on staging and prod (31 distinct books)
 * 8 raised the cast/focal must-fix count and every one of those divisions
 * shipped — job_1790100385959_1nitlympp went 5 → 7.
 *
 * The fixtures below are those stored findings (code / check number + the
 * pages each names), not invented shapes. Behaviour is pinned, never wording.
 */
import { describe, it, expect } from 'vitest';

const { replanRoundRegressed } = require('../../server/lib/promptBuilders');

const c = (code: string, pages: number[] = []) => ({ kind: 'counter', code, pages, line: `PLAN[${code}]${pages.length ? ` page ${pages.join(', ')}` : ''}: x` });
const q = (check: number, pages: number[]) => ({ kind: 'check', check, line: `CHECK[${check}]: Page ${pages.join(', ')} x` });

describe('job_1790100385959_1nitlympp — the audit case (stored round 0 vs round 1)', () => {
  const given = { findings: [
    c('NO_COMMISSIONED_ON_PAGE', [13]), c('NO_FOCAL_PAGE'), c('NO_FOCAL_PAGE'), c('UNDER_COVERED_CHARACTER'), q(4, [17]),
    c('SHOT_ULTRAWIDE_COUNT'),
  ] };
  const recheck = { findings: [
    c('NO_COMMISSIONED_ON_PAGE', [13, 17]), c('NO_FOCAL_PAGE'), c('NO_FOCAL_PAGE'), c('UNDER_COVERED_CHARACTER'),
    q(4, [16]), q(4, [18]), q(8, [18]),
  ] };
  const changed = [1, 5, 6, 17, 18];

  it('round 1 is discarded: it raised the cast/focal must-fix count', () => {
    const v = replanRoundRegressed(given, recheck, changed, { round: 1 });
    expect(v.regressed).toBe(true);
    expect(v.discard).toBe(true);
  });

  it('the Q4 verdict that appeared on untouched page 16 is set aside as checker noise (5 → 6, not 5 → 7)', () => {
    const v = replanRoundRegressed(given, recheck, changed, { round: 1 });
    expect(v.before).toBe(5);
    expect(v.after).toBe(6);
    expect(v.noise.map((f: any) => f.check)).toEqual([4]);
  });
});

describe('job_1789853503332_riqncqg1i — a raw regression that is only checker noise', () => {
  const given = { findings: [c('NO_PEOPLELESS_PAGE'), c('NO_COMMISSIONED_ON_PAGE', [7, 9]), q(4, [2, 10, 17, 18]), q(8, [18])] };
  const recheck = { findings: [c('NO_PEOPLELESS_PAGE'), c('NO_COMMISSIONED_ON_PAGE', [7]), q(4, [10]), q(4, [18]), q(8, [18])] };
  const changed = [2, 3, 6, 9, 10, 12, 13, 14, 15, 16];

  it('raw 4 → 5, but the new Q4 names only untouched page 18: 4 → 4, round 1 is kept', () => {
    const v = replanRoundRegressed(given, recheck, changed, { round: 1 });
    expect(v.before).toBe(4);
    expect(v.after).toBe(4);
    expect(v.discard).toBe(false);
  });

  it('the same tie on round 2 is discarded — a later round must reduce', () => {
    expect(replanRoundRegressed(given, recheck, changed, { round: 2 }).discard).toBe(true);
  });
});

describe('one guard, two callers', () => {
  // The re-plan loop is inline in beatsPipeline.js and cannot be called; the
  // Lab's beats_replan stage replays it. Both must decide with THIS function —
  // a hand-kept copy of the comparison is how round 1 stayed exempt unnoticed.
  const fs = require('fs');
  const path = require('path');
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

  it('the production loop and the Lab replay both call replanRoundRegressed, and nothing exempts round 1', () => {
    const pipeline = read('server/lib/beatsPipeline.js');
    expect(pipeline).toMatch(/replanRoundRegressed\(pendingCheck, check2, changedThisRound, \{ round \}\)/);
    expect(pipeline).not.toMatch(/&& round > 1\)/);
    expect(read('server/lib/testlab.js')).toMatch(/replanRoundRegressed\(\{ findings \}, \{ findings: recheck\.findings \}/);
  });
});

describe('the measure', () => {
  it('round 1 may tie: a first check with no cast/focal must-fix starts at zero', () => {
    const v = replanRoundRegressed({ findings: [c('SHOT_ULTRAWIDE_COUNT'), q(9, [3])] }, { findings: [] }, [3], { round: 1 });
    expect(v.before).toBe(0);
    expect(v.discard).toBe(false);
  });

  it('a strict reduction is kept on any round', () => {
    const given = { findings: [c('NO_FOCAL_PAGE'), q(4, [5])] };
    const recheck = { findings: [c('NO_FOCAL_PAGE')] };
    expect(replanRoundRegressed(given, recheck, [5], { round: 1 }).discard).toBe(false);
    expect(replanRoundRegressed(given, recheck, [5], { round: 2 }).discard).toBe(false);
  });

  it('a COUNTER finding on an untouched page always counts — counters are arithmetic, not a verdict', () => {
    const v = replanRoundRegressed({ findings: [] }, { findings: [c('NO_COMMISSIONED_ON_PAGE', [9])] }, [2], { round: 1 });
    expect(v.after).toBe(1);
    expect(v.discard).toBe(true);
  });

  it('a model finding on a CHANGED page counts — the round did that', () => {
    const v = replanRoundRegressed({ findings: [] }, { findings: [q(4, [2])] }, [2], { round: 1 });
    expect(v.noise).toEqual([]);
    expect(v.discard).toBe(true);
  });

  it('a model finding that names no page counts', () => {
    const v = replanRoundRegressed({ findings: [] }, { findings: [q(8, [])] }, [2], { round: 1 });
    expect(v.after).toBe(1);
  });

  it('noise is symmetric: a model finding vanishing from an untouched page is no credit either', () => {
    const v = replanRoundRegressed({ findings: [q(4, [7]), c('NO_FOCAL_PAGE')] }, { findings: [c('NO_FOCAL_PAGE')] }, [2], { round: 2 });
    expect(v.before).toBe(1);
    expect(v.after).toBe(1);
    expect(v.discard).toBe(true);
  });

  it('a model finding standing in BOTH checks on an untouched page counts on both sides', () => {
    const v = replanRoundRegressed({ findings: [q(4, [7])] }, { findings: [q(4, [7])] }, [2], { round: 1 });
    expect(v.before).toBe(1);
    expect(v.after).toBe(1);
    expect(v.noise).toEqual([]);
  });

  it('shot and advisory findings never count', () => {
    const v = replanRoundRegressed({ findings: [] }, { findings: [c('SHOT_CLOSEUP_COUNT'), q(9, [2]), c('CAST_NOT_IN_WHO_COLUMN', [2])] }, [2], { round: 1 });
    expect(v.after).toBe(0);
    expect(v.discard).toBe(false);
  });
});
