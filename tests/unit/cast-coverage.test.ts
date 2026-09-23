/**
 * Every commissioned child gets a moment, and the planner and the counters hold
 * the book to the SAME numbers (owner, 2026-09-23: "Every child gets a moment.
 * And ideally we have them in multiple images … ideally each one is on 3-4
 * images … for 7 characters in 10 pages it will not work").
 *
 * Pins behaviour: the numbers castCoverage() gives, that the built planner
 * prompt states them, and that the counters fire against the same floor.
 * Offline and free.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const { castCoverage, castCoverageRule, commissionedCast } = require('../../server/lib/castCoverage');
const { runPlanCounters } = require('../../server/lib/planCounters');
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

describe('castCoverage scales with the book and the cast', () => {
  it('4 children in 18 pages: a focal page each, 3 to 4 pages in frame', () => {
    const c = castCoverage({ pageCount: 18, castCount: 4 });
    expect(c.focalEach).toBe(true);
    expect(c.appearances).toEqual({ min: 3, max: 4 });
  });
  it('7 children in 10 pages: still a focal page each, but the appearance target scales down', () => {
    const c = castCoverage({ pageCount: 10, castCount: 7 });
    expect(c.focalEach).toBe(true);
    expect(c.appearances.max).toBeLessThan(3);
    expect(c.appearances.min).toBeGreaterThanOrEqual(1);
  });
  it('2 children in 24 pages: the full 3 to 4', () => {
    expect(castCoverage({ pageCount: 24, castCount: 2 }).appearances).toEqual({ min: 3, max: 4 });
  });
  it('a cast too large for a focal page each shares group moments and nobody is dropped', () => {
    const c = castCoverage({ pageCount: 10, castCount: 12 });
    expect(c.focalEach).toBe(false);
    expect(c.appearances.min).toBeGreaterThanOrEqual(1);
    expect(castCoverageRule(c)).toMatch(/group moments/);
    // A floor, never a range a reader could take for a cap.
    expect(castCoverageRule(castCoverage({ pageCount: 18, castCount: 4 }))).toContain('at least 3 pages');
  });
  it('no cast, no rule', () => {
    expect(castCoverage({ pageCount: 10, castCount: 0 })).toBeNull();
    expect(castCoverageRule(null)).toBe('');
  });
});

describe('commissionedCast: one definition of who the commission supplied', () => {
  it('the character list owes the book coverage; supplied figures are commissioned but owe nothing', () => {
    const c = commissionedCast({ characters: [{ name: 'Ana' }, { name: 'Ben' }] }, ['Rex', 'ana']);
    expect(c.listed).toEqual(['Ana', 'Ben']);
    expect(c.supplied).toEqual(['Rex']);
    expect(c.all).toEqual(['Ana', 'Ben', 'Rex']);
  });
});

describe('generator and critic use the same numbers', () => {
  const chars = ['Ana', 'Ben', 'Cara', 'Dev'];
  const inputData: any = {
    title: 'T', characters: chars.map((name, i) => ({ id: `c${i}`, name, age: 6, gender: 'female' })),
    mainCharacters: ['c0'], language: 'en', languageLevel: 'standard', pages: 18,
    storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor',
  };
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the built planner prompt states the rule castCoverage gives this book', () => {
    const prompt = PB.buildBeatsPrompt(inputData, 18, { finalArc: '1. A thing happens.' });
    expect(prompt).toContain(castCoverageRule(castCoverage({ pageCount: 18, castCount: 4 })));
    expect(prompt).not.toContain('{CAST_COVERAGE}');
  });

  it('the counters fire UNDER_COVERED_CHARACTER at the floor the planner was told, and never for a supplied figure', () => {
    // Ana on every page; Ben, Cara, Dev on two pages each; the supplied dog on one.
    const pages = Array.from({ length: 18 }, (_, i) => {
      const n = i + 1;
      const who = n <= 2 ? 'Ana, Ben' : n <= 4 ? 'Ana, Cara' : n <= 6 ? 'Ana, Dev' : n === 7 ? 'Ana, Rex' : 'Ana';
      return { pageNumber: n, planLine: `${n % 2 ? 'medium' : 'wide'} — ${who} — she acts — something changes` };
    });
    const roster = new Map(pages.map(p => [p.pageNumber, { people: p.planLine.split(' — ')[1].split(', '), things: [], covers: [] }]));
    const commission = commissionedCast(inputData, ['Rex']);
    const r = runPlanCounters({ pages, roster, commissionedNames: commission.all, listedNames: commission.listed });
    const under = r.findings.filter((f: any) => f.code === 'UNDER_COVERED_CHARACTER').map((f: any) => f.detail).join(' ');
    for (const n of ['Ben', 'Cara', 'Dev']) expect(under).toContain(n);
    expect(under).not.toContain('Rex');
    expect(under).toContain(`at least ${castCoverage({ pageCount: 18, castCount: 4 }).appearances.min}`);
    expect(r.cast.invented).not.toContain('Rex');
  });
});
