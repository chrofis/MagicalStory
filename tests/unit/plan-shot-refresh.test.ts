import { describe, it, expect } from 'vitest';

// The plan line states the shot the planner asked for; the scene review then
// deliberately rewrites a close-up to medium (scene-review.txt 7b/10) and
// nothing updated the plan. Measured 6.0% of pages (25 of 417 over 27 staging
// stories), one-way, 21 of them close-up into medium. The writer is told the
// PLAN line names the shot, so the shot column is refreshed from the finished
// brief before the writer sees it.
const { refreshPlanShot } = require('../../server/lib/planCounters');

const PLAN = 'close-up — the main character — she lifts the lantern — the path is lit';

describe('refreshPlanShot', () => {
  it('moves the shot column to the brief\'s shot', () => {
    const r = refreshPlanShot(PLAN, 'medium');
    expect(r.changed).toBe(true);
    expect(r.from).toBe('close-up');
    expect(r.to).toBe('medium');
    expect(r.planLine).toBe('medium — the main character — she lifts the lantern — the path is lit');
  });

  it('leaves everything after the shot column untouched', () => {
    expect(refreshPlanShot(PLAN, 'medium').planLine.slice('medium'.length))
      .toBe(PLAN.slice('close-up'.length));
  });

  it('is a no-op when the shots already agree', () => {
    const r = refreshPlanShot(PLAN, 'close-up');
    expect(r.changed).toBe(false);
    expect(r.planLine).toBe(PLAN);
  });

  // 'other' on either side means we cannot be sure it is a shot column at all.
  it('does not overwrite an unrecognised plan column', () => {
    const odd = 'the market at dawn — a trader — he opens the stall — the market is awake';
    const r = refreshPlanShot(odd, 'wide');
    expect(r.changed).toBe(false);
    expect(r.planLine).toBe(odd);
  });

  it('ignores an unrecognised brief shot', () => {
    const r = refreshPlanShot(PLAN, 'somewhat closer than before');
    expect(r.changed).toBe(false);
    expect(r.planLine).toBe(PLAN);
  });

  it('is a no-op on a missing shot, a blank line, or a line with no segments', () => {
    expect(refreshPlanShot(PLAN, '').changed).toBe(false);
    expect(refreshPlanShot(PLAN, null).changed).toBe(false);
    expect(refreshPlanShot('', 'medium').changed).toBe(false);
    expect(refreshPlanShot('close-up only, no separator', 'medium').changed).toBe(false);
  });

  it('handles the en-dash separator as well as the em-dash', () => {
    const en = 'close-up – the main character – she lifts the lantern – the path is lit';
    const r = refreshPlanShot(en, 'wide');
    expect(r.changed).toBe(true);
    expect(r.planLine.startsWith('wide – the main character')).toBe(true);
  });

  it('the measured direction: close-up into medium', () => {
    const r = refreshPlanShot(PLAN, 'medium shot');
    expect(r.from).toBe('close-up');
    expect(r.to).toBe('medium');
    expect(r.planLine.startsWith('medium shot —')).toBe(true);
  });
});
