import { describe, it, expect } from 'vitest';
// @ts-expect-error - JS module without types
import { decideRepairMethod, ITERATE_ROUTED_TYPES } from '../../server/lib/repairLogic.js';

// Owner 2026-10-07: extra_character / missing_character / setting are page
// redos. Measured over 39 stories, iterate cleared 22/23, 10/11, 15/22;
// inpaint 12/18, 4/6, 2/3.
const SCORES = { scoreBreakdown: { visual: { score: 70 }, semantic: { score: 60 } }, finalScore: 30, qualityScore: 70 };

describe('re-staging defects route to iterate', () => {
  it('are iterate-routed types', () => {
    for (const t of ['extra_character', 'missing_character', 'setting']) expect(ITERATE_ROUTED_TYPES.has(t)).toBe(true);
  });
  for (const type of ['extra_character', 'setting']) {
    it(`a MAJOR ${type} alone → iterate`, () => {
      const d = decideRepairMethod(4, { ...SCORES, fixableIssues: [{ type, severity: 'MAJOR', description: 'x' }] }, null, { characters: [], expectedCast: null });
      expect(d.method).toBe('iterate');
    });
  }
  it('an executable CRITICAL (object_presence) still takes the round before the redo', () => {
    const d = decideRepairMethod(4, { ...SCORES, fixableIssues: [
      { type: 'setting', severity: 'MAJOR', description: 'x' },
      { type: 'object_presence', severity: 'CRITICAL', description: 'y' },
    ] }, null, { characters: [], expectedCast: null });
    expect(d.method).toBe('inpaint');
  });
});
