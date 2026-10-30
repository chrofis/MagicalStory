/**
 * TWO MAINS ARE EQUAL STARS (owner, 2026-10-30; docs/decisions.md). Every main character holds the
 * "in frame on at least half the pages" floor: the planner rule names each main, the counter
 * MAIN_UNDER_HALF checks each main separately. Only the story SHAPE (age band) keys off the oldest main.
 * Customer case: two mains, the younger the birthday child, got no page guarantee.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const CC = req('../../server/lib/castCoverage');
const PC = req('../../server/lib/planCounters');
const PB = req('../../server/lib/promptBuilders');
const { loadPromptTemplates } = req('../../server/services/prompts');

const line = (type: string, who: string) => `${type} — ${who} — they do one thing here — something changed`;
const pagesOf = (lines: string[]) => lines.map((l, i) => ({ pageNumber: i + 1, planLine: l }));
const LISTED = ['Ana', 'Ben', 'Cy'];

const base = { language: 'en', pages: 12, storyCategory: 'adventure' };
const twoMains = {
  ...base,
  characters: [{ id: 1, name: 'Ana', age: 7, gender: 'female' }, { id: 2, name: 'Ben', age: 3, gender: 'male' }, { id: 3, name: 'Cy', age: 5, gender: 'male' }],
  mainCharacters: [1, 2],
};
const oneMain = { ...twoMains, mainCharacters: [1] };
const soloTrial = { characters: [{ id: 1, name: 'Ana', age: 5 }] };

describe('pickMainNames', () => {
  it('lists every main, oldest first; one main stays one name', () => {
    expect(PB.pickMainNames(twoMains)).toEqual(['Ana', 'Ben']);
    expect(PB.pickMainNames(oneMain)).toEqual(['Ana']);
  });
  it('a one-child (trial) story still has exactly one main, as the focus fallback', () => {
    expect(PB.pickMainNames(soloTrial)).toEqual(['Ana']);
    expect(PB.pickMainNames({})).toEqual([]);
  });
  it('the cap is unchanged: three declared mains in a four-child cast keep two', () => {
    const inp = { characters: [...twoMains.characters, { id: 4, name: 'Di', age: 2 }], mainCharacters: [1, 2, 3] };
    expect(PB.pickMainNames(inp)).toEqual(['Ana', 'Cy']);
  });
});

describe('mainFloorRule', () => {
  it('one main: unchanged wording', () => {
    expect(CC.mainFloorRule(8, ['Ana'])).toBe('Ana is in frame on at least 8 pages;');
    expect(CC.mainFloorRule(8)).toBe('The main character is in frame on at least 8 pages;');
  });
  it('two mains: each is named and each holds the floor', () => {
    expect(CC.mainFloorRule(8, ['Ana', 'Ben'])).toBe('Ana and Ben are each in frame on at least 8 pages;');
  });
  it('the typed targets block and its pointer name both', () => {
    const t = CC.typedPlanTargets({ pageCount: 16, listed: LISTED, maxCharactersPerScene: 6 });
    expect(CC.typedTargetsRule(t, ['Ana', 'Ben'])).toContain('Ana and Ben are each in frame on at least 8 pages of 16');
    expect(CC.mainFloorPointer(['Ana', 'Ben'])).toContain("Ana's and Ben's floors stand");
    expect(CC.mainFloorPointer(['Ana'])).toBe("Ana's floor stands in THE BOOK'S TARGETS above;");
  });
});

describe('the planner prompt (real builder) states the floor for every main', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('production and typed modes both name both mains', () => {
    const t = CC.typedPlanTargets({ pageCount: 12, listed: LISTED, maxCharactersPerScene: 6 });
    const prod = PB.buildBeatsPrompt(twoMains, 12, { finalArc: '1. A story.' });
    const typed = PB.buildBeatsPrompt(twoMains, 12, { finalArc: '1. A story.', typedPlan: true });
    expect(prod).toContain(CC.mainFloorRule(t.mainMin, ['Ana', 'Ben']));
    expect(typed).toContain(CC.typedTargetsRule(t, ['Ana', 'Ben']));
    expect(typed).toContain(CC.mainFloorPointer(['Ana', 'Ben']));
  });
  it('a one-main book is worded as before', () => {
    const t = CC.typedPlanTargets({ pageCount: 12, listed: LISTED, maxCharactersPerScene: 6 });
    expect(PB.buildBeatsPrompt(oneMain, 12, { finalArc: '1. A story.' })).toContain(CC.mainFloorRule(t.mainMin, ['Ana']));
  });
});

describe('MAIN_UNDER_HALF counts each main separately', () => {
  // 8 pages, floor 4: Ana on 5, Ben on 2.
  const book = [
    line('wide', 'Ana and Ben'), line('medium', 'Ana'), line('medium', 'Ana and Cy'), line('medium', 'Ana'),
    line('wide', 'Ana and Ben'), line('medium', 'Cy'), line('medium', 'Cy'), line('medium', 'Cy'),
  ];
  const run = (mainNames: string[]) => PC.typedPlanCounters({ pages: pagesOf(book), listedNames: LISTED, mainNames, maxCharactersPerScene: 6 });
  it('flags the second main under half while the first is fine', () => {
    const r = run(['Ana', 'Ben']);
    const under = r.findings.filter((f: any) => f.code === 'MAIN_UNDER_HALF');
    expect(under).toHaveLength(1);
    expect(under[0].detail).toMatch(/^Ben is in frame on 2 of 8/);
    expect(r.stats.mainCharacters.map((m: any) => [m.name, m.pages.length])).toEqual([['Ana', 5], ['Ben', 2]]);
  });
  it('with only the oldest as main (the old behaviour) Ben was never flagged', () => {
    expect(run(['Ana']).findings.filter((f: any) => f.code === 'MAIN_UNDER_HALF')).toHaveLength(0);
  });
  it('flags both when both are short', () => {
    const r = run(['Ben', 'Cy']);
    expect(r.findings.filter((f: any) => f.code === 'MAIN_UNDER_HALF').map((f: any) => f.detail.split(' ')[0])).toEqual(['Ben']);
  });
});

describe('story shape and title name every main', () => {
  it('a simple-band shape lists both mains and calls them equal stars; the band still follows the oldest', () => {
    const young = { characters: [{ id: 1, name: 'Ana', age: 3 }, { id: 2, name: 'Ben', age: 2 }, { id: 3, name: 'Cy', age: 5 }], mainCharacters: [1, 2] };
    const shape = PB.buildStoryShapeSection(young, 10);
    expect(shape).toContain('Main characters: Ana (3) and Ben (2)');
    expect(shape).toContain('Both are equal stars.');
  });
  it('one main keeps the singular line', () => {
    const young = { characters: [{ id: 1, name: 'Ana', age: 3 }, { id: 2, name: 'Ben', age: 2 }, { id: 3, name: 'Cy', age: 5 }], mainCharacters: [1] };
    const shape = PB.buildStoryShapeSection(young, 10);
    expect(shape).toContain('Main character: Ana (3)');
    expect(shape).not.toContain('equal stars');
  });
  it('the title rule names both mains', () => {
    expect(PB.buildTitleRule(twoMains)).toContain('both names: Ana and Ben');
  });
});
