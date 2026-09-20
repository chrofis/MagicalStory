/**
 * THE RE-PLAN CONVERGENCE TEST IS CLASSED, NOT A RAW TOTAL (2026-09-20).
 *
 * Two questions that used to share one integer:
 *   MANDATE     — must the re-plan answer this finding?   → replanRank()
 *   CONVERGENCE — did the round earn its keep?            → convergenceMustFixCount()
 *
 * Six shot-distribution codes became must-fix on 2026-09-20. A shot finding is
 * satisfied by relabelling one page's shot word; a cast or focal finding costs
 * the book a picture. Counting both in one total let cheap shot clears pay for
 * a lost wanted picture.
 *
 * MEASURED, staging job_1789853503332_riqncqg1i: round 2 rewrote 17 of 18 pages
 * and moved the cast/focal set from
 *   [NO_PEOPLELESS_PAGE, NO_COMMISSIONED_ON_PAGE, Q4, Q4, Q8]
 * to
 *   [NO_PEOPLELESS_PAGE, NO_COMMISSIONED_ON_PAGE, Q4, Q4, Q4]
 * — Q4 wanted-picture findings 2 → 3 (worse), Q8 dropped off. Under the raw
 * total the round reads 6 → 5 (SHOT_ULTRAWIDE_COUNT fell) and would be KEPT;
 * under the class it reads 5 → 5 and is DISCARDED.
 *
 * Behaviour is pinned here, never the wording of a log line.
 */
import { describe, it, expect } from 'vitest';

const {
  replanRank, countsTowardConvergence, convergenceMustFixCount,
  REPLAN_CONVERGENCE_EXEMPT_CODES,
} = require('../../server/lib/promptBuilders');

const counter = (code: string) => ({ kind: 'counter', code, line: `PLAN[${code}]: ...` });
const check = (n: number) => ({ kind: 'check', check: n, line: `CHECK[${n}]: ...` });

// The verdict the loop reaches, expressed exactly as beatsPipeline expresses it:
// a round is discarded when its cast/focal count does not FALL.
const verdict = (before: any[], after: any[]) =>
  convergenceMustFixCount({ findings: after }) >= convergenceMustFixCount({ findings: before })
    ? 'discarded' : 'kept';

describe('shot codes keep the mandate', () => {
  it.each([...REPLAN_CONVERGENCE_EXEMPT_CODES] as string[])('%s still ranks must-fix', (code) => {
    expect(replanRank(counter(code))).toBe('must');
  });

  it('but none of them counts toward convergence', () => {
    for (const code of REPLAN_CONVERGENCE_EXEMPT_CODES) {
      expect(countsTowardConvergence(counter(code))).toBe(false);
    }
    expect(convergenceMustFixCount({ findings: [...REPLAN_CONVERGENCE_EXEMPT_CODES].map(counter) })).toBe(0);
  });

  it('the cast/focal must-fix codes and checks do count', () => {
    for (const code of ['NO_FOCAL_PAGE', 'NO_COMMISSIONED_ON_PAGE', 'NO_PEOPLELESS_PAGE',
      'UNDER_COVERED_CHARACTER', 'MAIN_UNDER_HALF', 'PEOPLELESS_ON_INTERACTION_PAGE']) {
      expect(countsTowardConvergence(counter(code))).toBe(true);
    }
    expect(countsTowardConvergence(check(4))).toBe(true);
    expect(countsTowardConvergence(check(8))).toBe(true);
  });

  it('an advisory finding counts toward neither', () => {
    expect(replanRank(counter('SHOT_VARIETY'))).toBe('also');
    expect(countsTowardConvergence(counter('SHOT_VARIETY'))).toBe(false);
    expect(countsTowardConvergence('a legacy string')).toBe(false);
  });
});

describe('the round-keeping verdict — job_1789853503332_riqncqg1i', () => {
  // Its real before/after sets, shot findings included.
  const before = [
    counter('NO_PEOPLELESS_PAGE'), counter('NO_COMMISSIONED_ON_PAGE'),
    check(4), check(4), check(8),
    counter('SHOT_ULTRAWIDE_COUNT'),
  ];
  const after = [
    counter('NO_PEOPLELESS_PAGE'), counter('NO_COMMISSIONED_ON_PAGE'),
    check(4), check(4), check(4),
  ];

  it('the raw total would have kept it — that is the defect', () => {
    expect(before.length).toBe(6);
    expect(after.length).toBe(5);
  });

  it('the classed count discards it: cast/focal 5 → 5, Q4 2 → 3', () => {
    expect(convergenceMustFixCount({ findings: before })).toBe(5);
    expect(convergenceMustFixCount({ findings: after })).toBe(5);
    expect(verdict(before, after)).toBe('discarded');
  });
});

describe('the three verdicts the classed count produces', () => {
  it('clears every shot finding while cast/focal RISES → discarded', () => {
    const before = [counter('NO_FOCAL_PAGE'), counter('SHOT_CLOSEUP_COUNT'), counter('SHOT_OTS_COUNT')];
    const after = [counter('NO_FOCAL_PAGE'), check(4)];
    expect(verdict(before, after)).toBe('discarded');
  });

  it('reduces cast/focal while shot findings RISE → kept', () => {
    const before = [counter('NO_FOCAL_PAGE'), check(8)];
    const after = [check(8), counter('SHOT_CLOSEUP_COUNT'), counter('SHOT_AERIAL_COUNT'),
      counter('SHOT_OTS_COUNT'), counter('SHOT_NO_CAMERA_POSITION')];
    expect(convergenceMustFixCount({ findings: before })).toBe(2);
    expect(convergenceMustFixCount({ findings: after })).toBe(1);
    expect(verdict(before, after)).toBe('kept');
  });

  it('flat on cast/focal → discarded, the semantics that did not change', () => {
    const before = [counter('NO_FOCAL_PAGE'), check(4)];
    const after = [counter('MAIN_UNDER_HALF'), check(8)];
    expect(verdict(before, after)).toBe('discarded');
  });
});
