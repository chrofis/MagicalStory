/**
 * A FURTHER RE-PLAN ROUND MUST BE MOPPING UP, NOT RE-ROLLING (2026-09-21).
 *
 * The planner re-emits the whole division each round (~39k chars of prompt,
 * ~$0.09 and ~160s with its recheck), so a round is only worth buying when the
 * one before it CONVERGED: strictly fewer cast/focal must-fix findings than it
 * was given, and not one of them new.
 *
 * MEASURED by replaying this predicate over stored staging `beatsReviewReport`
 * rows (28 books with a recheck in 45 days, zero paid calls): 6 rechecks are a
 * strict subset, 22 are not, 10 of those because the recheck minted a cast/focal
 * must-fix the check before it never raised. Exactly 2 books ran a round 2 in
 * that window; this predicate skips both, and both were discarded after running.
 *
 * Behaviour is pinned here, never the wording of a log line.
 */
import { describe, it, expect } from 'vitest';

const { replanRoundConverged, replanFindingKey } = require('../../server/lib/promptBuilders');

const f = (code: string, pages: number[]) => ({ code, pages, line: `${code} on ${pages.join(',')}` });
const q = (check: number, page: number) => ({ check, line: `Page ${page} stages two actions` });

describe('replanRoundConverged', () => {
  it('converges when the surviving set is strictly smaller and holds nothing new', () => {
    const given = { findings: [f('NO_PEOPLELESS_PAGE', [3]), f('NO_COMMISSIONED_ON_PAGE', [7])] };
    const recheck = { findings: [f('NO_PEOPLELESS_PAGE', [3])] };
    const r = replanRoundConverged(given, recheck);
    expect(r.converged).toBe(true);
    expect(r.given).toBe(2);
    expect(r.surviving).toBe(1);
    expect(r.minted).toEqual([]);
  });

  it('does NOT converge when the recheck mints a finding the check never raised', () => {
    const given = { findings: [f('NO_PEOPLELESS_PAGE', [3]), f('NO_COMMISSIONED_ON_PAGE', [7])] };
    const recheck = { findings: [f('NO_COMMISSIONED_ON_PAGE', [11])] };
    const r = replanRoundConverged(given, recheck);
    expect(r.converged).toBe(false);
    expect(r.minted.length).toBe(1);
  });

  it('does NOT converge when the count merely holds level', () => {
    const given = { findings: [f('NO_PEOPLELESS_PAGE', [3]), f('NO_COMMISSIONED_ON_PAGE', [7])] };
    const r = replanRoundConverged(given, { findings: [...given.findings] });
    expect(r.converged).toBe(false);
    expect(r.minted).toEqual([]);
  });

  it('does NOT converge when nothing survives — an empty set is not strictly smaller than nothing', () => {
    expect(replanRoundConverged({ findings: [] }, { findings: [] }).converged).toBe(false);
  });

  it('reads a finding identity off its code/check and pages, never its prose', () => {
    expect(replanFindingKey(f('NO_PEOPLELESS_PAGE', [3, 1]))).toBe('NO_PEOPLELESS_PAGE|1,3');
    expect(replanFindingKey(q(4, 9))).toBe('check4|9');
    // Same code, different page = a different finding.
    expect(replanFindingKey(f('X', [2]))).not.toBe(replanFindingKey(f('X', [3])));
  });

  it('ignores findings that do not count toward convergence (shot distribution)', () => {
    const shot = { code: 'SHOT_ULTRAWIDE_COUNT', pages: [5], line: 'too few ultra-wides' };
    const r = replanRoundConverged(
      { findings: [f('NO_PEOPLELESS_PAGE', [3]), shot] },
      { findings: [shot] },
    );
    // given = 1 (the shot finding is exempt), surviving = 0 → nothing left, but
    // 0 < 1, so this IS convergence.
    expect(r.given).toBe(1);
    expect(r.surviving).toBe(0);
    expect(r.converged).toBe(true);
  });
});
