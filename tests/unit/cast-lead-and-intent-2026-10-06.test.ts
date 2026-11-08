/**
 * Owner 2026-10-06 (docs/decisions.md "sceneIntent describes the picture only"; its lead-page rule was replaced 2026-11-08 by
 * the deed-source rule). Pins behaviour: generator and critic read one deed-source sentence, and the Art Director's
 * sceneIntent rule (both variants) forbids naming the cover's copy band.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const CC = req('../../server/lib/castCoverage');
const PC = req('../../server/lib/planCounters');
const PB = req('../../server/lib/promptBuilders');

describe('a deed page belongs to the character the story gives the deed (2026-11-08 replaces "a page leads with one character")', () => {
  it('leadEach holds when every character can have a page of their own', () => {
    expect(CC.castCoverage({ pageCount: 10, castCount: 5 }).leadEach).toBe(true);
    expect(CC.castCoverage({ pageCount: 18, castCount: 4 }).leadEach).toBe(true);
    expect(CC.castCoverage({ pageCount: 10, castCount: 7 }).leadEach).toBe(false);
    expect(CC.castCoverage({ pageCount: 10, castCount: 1 }).leadEach).toBe(false);
  });
  it('the planner (CAST block and cast rule) and the checker share the deed-source sentence; the "also on" sentence only where each has a page', () => {
    const cov = CC.castCoverage({ pageCount: 10, castCount: 5 });
    expect(CC.castTableSpec(cov, 10)).toContain(CC.DEED_SOURCE_RULE);
    expect(CC.castActionRule(cov)).toContain(CC.DEED_SOURCE_RULE);
    expect(CC.castTableSpec(cov, 10)).toContain("never another character's \"also on\" page, except the main character's");
    const big = CC.castCoverage({ pageCount: 10, castCount: 7 });
    expect(CC.castTableSpec(big, 10)).toContain(CC.DEED_SOURCE_RULE);
    expect(CC.castActionRule(big)).toContain(CC.DEED_SOURCE_RULE);
    expect(CC.castTableSpec(big, 10)).not.toContain('"also on" page, except');
  });
  const names = ['Emma', 'Noah', 'Sarah'];
  const rows = [1, 2, 3, 4, 5, 6].map(n => ({ pageNumber: n, present: n === 3 ? ['Emma', 'Sarah'] : ['Emma'] }));
  const table = (deeds: number[]) => ({ characters: names.map((name, i) => ({ name, deedPage: deeds[i], deed: 'x', alsoOn: [] })), ending: null });
  const run = (deeds: number[], leadEach: boolean) => PC.castTablePromises({ rows, castTable: table(deeds), actions: null, cast: { all: names, aliases: {} }, focalEach: true, leadEach });
  it('a deed page two characters share (one action the story gives them together) is kept by both, not set aside', () => {
    const shared = [1, 2, 3, 4, 5, 6].map(n => ({ pageNumber: n, present: n === 3 ? ['Noah', 'Sarah'] : ['Emma'] }));
    const r = PC.castTablePromises({ rows: shared, castTable: table([1, 3, 3]), actions: [{ key: 'Emma', page: 1 }, { key: 'Noah', page: 3 }, { key: 'Sarah', page: 3 }], cast: { all: names, aliases: {} }, focalEach: true, leadEach: true });
    expect(r.sharedLead).toBeUndefined();
    expect(r.broken).toEqual([]);
    expect(r.kept).toBe(3);
  });
});

describe('sceneIntent describes the picture only (Lab #1674: "keeping the top third of the frame empty")', () => {
  it('both variants of the rule carry the clause, from one constant', () => {
    for (const rule of [PB.SCENE_INTENT_FIELD_RULE, PB.SCENE_INTENT_FIELD_FIXED_RULE]) {
      expect(rule).toContain('never names a band, a third or an edge of the frame');
    }
  });
});
