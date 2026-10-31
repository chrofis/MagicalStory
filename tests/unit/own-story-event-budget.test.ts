import { describe, it, expect } from 'vitest';
// @ts-ignore CommonJS
import PB from '../../server/lib/promptBuilders';

// Owner decision 2026-10-31: the story wins over the arc's event limit. The
// own-story wording must appear in generator AND critic only for ownStory === true.
const cast = [{ id: 1, name: 'Mia', age: 8, isMain: true }];
const loose = { characters: cast, languageLevel: 'standard' } as any;
const own = { ...loose, ownStory: true };

describe('own-story event budget (open upper bound)', () => {
  it('loose ideas keep the plain range exactly', () => {
    expect(PB.arcEventRange(loose, 10)).toEqual({ lo: 3, hi: 5 });
    expect(PB.happeningsLabel(loose, 10)).toBe('3-5 happenings');
    expect(PB.arcShapeCounts({ sentences: 10, logic: { chain: Array(7).fill('x'), invented: [] }, inputData: loose, pageCount: 10 }).chainInRange).toBe(false);
  });

  it('own story: same lo/hi, flagged open, label and counter read it', () => {
    expect(PB.arcEventRange(own, 10)).toEqual({ lo: 3, hi: 5, open: true });
    expect(PB.happeningsLabel(own, 10)).toBe(`3-5 happenings, ${PB.OWN_STORY_EVENTS_OPEN}`);
    const over = PB.arcShapeCounts({ sentences: 10, logic: { chain: Array(7).fill('x'), invented: [] }, inputData: own, pageCount: 10 });
    expect(over.chainInRange).toBe(true);        // more events than the budget is fine
    const under = PB.arcShapeCounts({ sentences: 10, logic: { chain: ['x'], invented: [] }, inputData: own, pageCount: 10 });
    expect(under.chainInRange).toBe(false);      // the lower bound still holds
  });

  it('generator: principles, STORY LOGIC and re-tell state the open bound only for an own story', () => {
    expect(PB.arcPrinciples(own, 10)).toContain(PB.OWN_STORY_EVENTS_OPEN);
    expect(PB.arcPrinciples(loose, 10)).not.toContain(PB.OWN_STORY_EVENTS_OPEN);
    expect(PB.arcLogicSpec(own, 10)).toContain(`Events: the number of happenings, 3-5, ${PB.OWN_STORY_EVENTS_OPEN}.`);
    expect(PB.arcLogicSpec(loose, 10)).toContain('Events: the number of happenings, 3-5.');
    expect(PB.arcPrinciples(own, 10).toLowerCase()).toContain(PB.OWN_STORY_EVENT_STAYS);
    expect(PB.arcPrinciples(loose, 10).toLowerCase()).not.toContain(PB.OWN_STORY_EVENT_STAYS);
  });

  it('critic: the LOGIC check does not call a parent event a dead end, only for an own story', () => {
    expect(PB.arcLogicCheck(loose)).toBe(PB.ARC_LOGIC_CHECK);
    expect(PB.arcLogicCheck(own)).toContain(PB.OWN_STORY_EVENT_STAYS);
    expect(PB.arcLogicCheck(own)).not.toBe(PB.ARC_LOGIC_CHECK);
  });
});
