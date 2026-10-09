/**
 * Two stored names compare ONLY through castResolver.sameEntity (docs/SETTLED.md).
 * The token matcher `sceneMetadata.isSameFigureName` is gone. Replayed over 120
 * stored staging stories (docs/decisions.md 2026-10-09, "one name matcher in the
 * brief checks"): 7 false vb_page_uncited names removed ("boy in striped scarf"
 * against "The boy in the striped scarf"), 5 findings added, all from one story
 * where "Rossa" is ambiguous between two bible entries and the resolver refuses.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildCastIndex, sameEntity } = require_('../../server/lib/castResolver');
const { checkBiblePageTable, checkCastNotInPlan, checkPage } = require_('../../server/lib/sceneBriefCheck');
const { findCastMissingFromMetadata } = require_('../../server/lib/sceneMetadata');
const { whoColumnDropped } = require_('../../server/lib/briefChecks');

const idx = (characters: any[], vb: any = null) => buildCastIndex({ characters }, vb);

describe('sameEntity as the one name comparison', () => {
  it('matches an article form and a descriptor form of one bible figure', () => {
    const vb = { secondaryCharacters: [
      { id: 'CHR001', name: 'The boy in the striped scarf' },
      { id: 'CHR002', name: 'The boy with the pole lantern' },
    ] };
    const i = idx([{ name: 'Lukas' }], vb);
    expect(sameEntity('boy in striped scarf', 'The boy in the striped scarf', i)).toBe(true);
    expect(sameEntity('boy with pole lantern', 'The boy with the pole lantern', i)).toBe(true);
  });

  it('keeps "Mother Dragon" and "Mother" two different figures', () => {
    const vb = { animals: [{ id: 'ANI002', name: 'Mother Dragon' }] };
    const i = idx([{ name: 'Mother' }, { name: 'Levin' }], vb);
    expect(sameEntity('Mother Dragon', 'Mother', i)).toBe(false);
    expect(sameEntity('Mother', 'Mother', i)).toBe(true);
  });

  it('refuses an ambiguous short name instead of picking one of its candidates', () => {
    const vb = { secondaryCharacters: [
      { id: 'CHR001', name: 'Kapitänin Rossa' },
      { id: 'CHR003', name: 'Rossa crew member' },
    ] };
    const i = idx([{ name: 'Sarah' }], vb);
    expect(sameEntity('Rossa', 'Kapitänin Rossa', i)).toBe(false);
    expect(sameEntity('Rossa', 'Rossa crew member', i)).toBe(false);
    expect(i.stats.ambiguous.length).toBeGreaterThan(0);
  });

  it('resolves a bible id to its figure\'s name', () => {
    const vb = { secondaryCharacters: [{ id: 'CHR001', name: 'Kapitänin Rossa' }] };
    const i = idx([{ name: 'Sarah' }], vb);
    expect(sameEntity('CHR001', 'Kapitänin Rossa', i)).toBe(true);
    expect(sameEntity('CHR001.2', 'Kapitänin Rossa', i)).toBe(true);
    expect(sameEntity('CHR001', 'Sarah', i)).toBe(false);
  });
});

describe('the brief checks compare through the resolver, with the story\'s index', () => {
  const vb = { secondaryCharacters: [
    { id: 'CHR001', name: 'The boy in the striped scarf', pages: [3] },
  ] };

  it('checkBiblePageTable: a characters[] row written without articles counts as the bible figure', () => {
    const f = checkBiblePageTable(
      { pageNumber: 3 },
      { objects: ['LOC003'], characters: [{ name: 'boy in striped scarf' }] },
      vb, idx([{ name: 'Lukas' }], vb),
    );
    expect(f.filter((x: any) => x.type === 'vb_page_uncited')).toEqual([]);
  });

  it('checkBiblePageTable: "Mother" on the roster does not excuse the uncited "Mother Dragon"', () => {
    const dragon = { animals: [{ id: 'ANI002', name: 'Mother Dragon', pages: [2] }] };
    const f = checkBiblePageTable(
      { pageNumber: 2 },
      { objects: ['LOC001'], characters: [{ name: 'Mother' }] },
      dragon, idx([{ name: 'Mother' }], dragon),
    );
    expect(f.map((x: any) => x.type)).toContain('vb_page_uncited');
  });

  it('checkBiblePageTable and findCastMissingFromMetadata: "Rossa" is not "Rossa crew member"', () => {
    const rvb = { secondaryCharacters: [
      { id: 'CHR001', name: 'Rossa crew member', pages: [4] },
    ] };
    const i = idx([{ name: 'Rossa' }], rvb);
    const f = checkBiblePageTable({ pageNumber: 4 }, { objects: ['LOC001'], characters: [{ name: 'Rossa' }] }, rvb, i);
    expect(f.map((x: any) => x.type)).toContain('vb_page_uncited');
    const prose = 'Rossa crew member waves.\n\n---METADATA---\n{"characters":[{"name":"Rossa"}]}';
    expect(findCastMissingFromMetadata(prose, ['Rossa crew member'], null, [], i)).toEqual(['Rossa crew member']);
  });

  it('findCastMissingFromMetadata: a bible id cited by the brief lists the figure under its name', () => {
    const rvb = { secondaryCharacters: [{ id: 'CHR001', name: 'Kapitänin Rossa' }] };
    const i = idx([{ name: 'Sarah' }], rvb);
    const prose = 'Kapitänin Rossa stands at the rail.\n\n---METADATA---\n{"characters":[{"name":"Sarah"}]}';
    expect(findCastMissingFromMetadata(prose, ['Kapitänin Rossa'], null, [], i)).toEqual(['Kapitänin Rossa']);
    expect(findCastMissingFromMetadata(prose, ['Kapitänin Rossa'], null, ['Kapitänin Rossa'], i)).toEqual([]);
  });

  it('checkCastNotInPlan: an article form in the head count matches the listed row', () => {
    const i = idx([{ name: 'Lukas' }, { name: 'The boy with the pole lantern' }]);
    const page = { pageNumber: 2, inFrame: ['the boy with the pole lantern'], planLine: 'PLAN: x | boy | y' };
    expect(checkCastNotInPlan(page, { characters: [{ name: 'The boy with the pole lantern' }] }, ['The boy with the pole lantern'], i)).toEqual([]);
    expect(checkCastNotInPlan(page, { characters: [{ name: 'Lukas' }] }, ['Lukas'], i).map((x: any) => x.names)).toEqual([['Lukas']]);
  });
});

describe('a missing cast index fails loudly, never degrades to string comparison', () => {
  it('throws from every entry that compares names', () => {
    expect(() => checkPage({ pageNumber: 1, brief: 'Anna waves.' }, ['Anna'], null, {})).toThrow(/castIndex is required/);
    expect(() => checkBiblePageTable({ pageNumber: 1 }, {}, null)).toThrow(/castIndex is required/);
    expect(() => checkCastNotInPlan({ pageNumber: 1, inFrame: [] }, {}, [])).toThrow(/castIndex is required/);
    expect(() => findCastMissingFromMetadata('Anna waves.', ['Anna'], { characters: [] })).toThrow(/castIndex is required/);
    expect(() => whoColumnDropped('', '', 'PLAN: a | b', null, [])).toThrow(/castIndex is required/);
  });
});
