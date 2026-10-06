/**
 * Owner 2026-10-06 (docs/decisions.md "Every named figure leads a page" and "sceneIntent describes the picture only").
 * Pins behaviour: a focal page is ONE character's when the book has a page to spare for each (generator and critic read
 * one sentence), a CAST block that gives a page to two characters is reported, and the Art Director's sceneIntent rule
 * (both variants) forbids naming the cover's copy band.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const CC = req('../../server/lib/castCoverage');
const PC = req('../../server/lib/planCounters');
const PB = req('../../server/lib/promptBuilders');

describe('a page leads with one character', () => {
  it('leadEach holds when every character can have a page of their own', () => {
    expect(CC.castCoverage({ pageCount: 10, castCount: 5 }).leadEach).toBe(true);
    expect(CC.castCoverage({ pageCount: 18, castCount: 4 }).leadEach).toBe(true);
    expect(CC.castCoverage({ pageCount: 10, castCount: 7 }).leadEach).toBe(false);
    expect(CC.castCoverage({ pageCount: 10, castCount: 1 }).leadEach).toBe(false);
  });
  it('the planner (CAST block and cast rule) and the checker share the sentence only when it applies', () => {
    const cov = CC.castCoverage({ pageCount: 10, castCount: 5 });
    expect(CC.castTableSpec(cov, 10)).toContain(CC.LEAD_RULE);
    expect(CC.castActionRule(cov)).toContain(CC.LEAD_RULE);
    const big = CC.castCoverage({ pageCount: 10, castCount: 7 });
    expect(CC.castTableSpec(big, 10)).not.toContain(CC.LEAD_RULE);
    expect(CC.castActionRule(big)).not.toContain(CC.LEAD_RULE);
  });
  const names = ['Emma', 'Noah', 'Sarah'];
  const rows = [1, 2, 3, 4, 5, 6].map(n => ({ pageNumber: n, present: n === 3 ? ['Emma', 'Sarah'] : ['Emma'] }));
  const table = (deeds: number[]) => ({ characters: names.map((name, i) => ({ name, deedPage: deeds[i], deed: 'x', alsoOn: [] })), ending: null });
  const run = (deeds: number[], leadEach: boolean) => PC.castTablePromises({ rows, castTable: table(deeds), actions: null, cast: { all: names, aliases: {} }, focalEach: true, leadEach });
  it('a deed page named by two characters is reported, not filed as a re-plan finding', () => {
    const r = run([1, 3, 3], true);
    expect(r.sharedLead).toEqual([{ page: 3, names: ['Noah', 'Sarah'] }]);
    expect(r.broken.every((b: any) => b.promise !== 'lead')).toBe(true);
  });
  it('distinct deed pages, or a book too small for one each, report nothing', () => {
    expect(run([1, 2, 3], true).sharedLead).toEqual([]);
    expect(run([1, 3, 3], false).sharedLead).toEqual([]);
  });
});

describe('sceneIntent describes the picture only (Lab #1674: "keeping the top third of the frame empty")', () => {
  it('both variants of the rule carry the clause, from one constant', () => {
    for (const rule of [PB.SCENE_INTENT_FIELD_RULE, PB.SCENE_INTENT_FIELD_FIXED_RULE]) {
      expect(rule).toContain('never names a band, a third or an edge of the frame');
    }
  });
});
