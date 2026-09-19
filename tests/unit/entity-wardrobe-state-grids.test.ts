import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const {
  groupAppearancesByClothing, planEntityGridTasks, hasWardrobeVariantSheet,
} = require_('../../server/lib/entityConsistency.js');

/**
 * THE BODY GRID IS KEYED BY WARDROBE STATE; THE HEAD GRID IS NOT.
 *
 * Measured fault (staging job_1789759147125_p08djwhbl, 18 pages): the grid key
 * was the bare clothing category, so a character whose jacket comes off partway
 * through the story had jacket-on and jacket-off cells in ONE grid against ONE
 * reference cell. The judge read the garment off the reference and reported it
 * "entirely missing" from the cells that correctly did not wear it. The
 * mitigation — dropping any garment off on ANY page from the expected text of
 * ALL pages — cost two spurious MAJORs on correctly-worn pages and left eight
 * pages unjudged, while the false finding fired anyway.
 *
 * These pin the BEHAVIOUR of the split, never any prompt wording.
 */

const app = (pageNumber: number, clothing: string, offIds: string[] = []) =>
  ({ pageNumber, clothing, offIds, offItemNames: offIds.map(id => `${id.toLowerCase()} garment`) });

const plan = (apps: any[], opts: any = {}) =>
  planEntityGridTasks(apps, groupAppearancesByClothing(apps), { minAppearances: 1, hasOffSheet: () => true, ...opts });

describe('grid grouping carries the wardrobe state', () => {
  it('different off-sets land in different body-grid groups; the same off-set groups together', () => {
    const apps = [
      app(1, 'standard'), app(2, 'standard'),
      app(3, 'standard', ['CLO002']), app(4, 'standard', ['CLO002']),
      app(5, 'standard', ['CLO001', 'CLO002']),
    ];
    const groups = groupAppearancesByClothing(apps);
    expect([...groups.keys()].sort()).toEqual([
      'standard', 'standard--off:CLO001+CLO002', 'standard--off:CLO002',
    ]);
    expect(groups.get('standard--off:CLO002').map((a: any) => a.pageNumber)).toEqual([3, 4]);
  });

  it('the off-set key does not depend on the order the page declared it', () => {
    const groups = groupAppearancesByClothing([app(1, 'standard', ['CLO002', 'CLO001']), app(2, 'standard', ['CLO001', 'CLO002'])]);
    expect(groups.size).toBe(1);
  });

  it('a story with no off-declarations groups exactly as before', () => {
    const apps = [app(1, 'standard'), app(2, 'winter'), app(3, 'standard')];
    expect([...groupAppearancesByClothing(apps).keys()]).toEqual(['standard', 'winter']);
    const { tasks } = plan(apps);
    expect(tasks.map((t: any) => [t.mode, t.reportKey])).toEqual([['both', 'standard'], ['both', 'winter']]);
  });
});

describe('identity is judged over the base category, wardrobe per state', () => {
  const apps = [
    app(1, 'standard'), app(2, 'standard'),
    app(3, 'standard', ['CLO002']),
    app(4, 'standard', ['CLO001', 'CLO002']),
  ];

  it('the head grid is NOT split by off-state — one identity corpus', () => {
    const { tasks } = plan(apps);
    const identity = tasks.filter((t: any) => t.mode === 'identity');
    expect(identity.length).toBe(1);
    expect(identity[0].clothingCategory).toBe('standard');
    expect(identity[0].appearances.map((a: any) => a.pageNumber)).toEqual([1, 2, 3, 4]);
    // ...and no task both splits by state AND judges identity.
    expect(tasks.filter((t: any) => t.mode === 'both')).toEqual([]);
  });

  it('one wardrobe task per state, each with its own key', () => {
    const { tasks } = plan(apps);
    expect(tasks.filter((t: any) => t.mode === 'wardrobe').map((t: any) => t.reportKey))
      .toEqual(['standard', 'standard--off:CLO002', 'standard--off:CLO001+CLO002']);
  });

  it('a single-page off-group is still judged (minRequired 1)', () => {
    const { tasks } = plan(apps, { minAppearances: 3 });
    const single = tasks.find((t: any) => t.reportKey === 'standard--off:CLO002');
    expect(single).toBeTruthy();
    expect(single.minRequired).toBe(1);
    expect(single.appearances.length).toBe(1);
  });
});

describe('no off-sheet means wardrobe-unjudgeable, never the worn sheet', () => {
  it('the wardrobe task is skipped with a reason and identity still covers the pages', () => {
    const apps = [app(1, 'standard'), app(2, 'standard', ['CLO002'])];
    const { tasks, skipped } = plan(apps, { hasOffSheet: (c: string) => !c.includes('--off:') });
    expect(skipped).toEqual([expect.objectContaining({
      reportKey: 'standard--off:CLO002', reason: 'no-wardrobe-variant-sheet',
    })]);
    expect(tasks.map((t: any) => t.reportKey)).not.toContain('standard--off:CLO002');
    const identity = tasks.find((t: any) => t.mode === 'identity');
    expect(identity.appearances.map((a: any) => a.pageNumber)).toEqual([1, 2]);
  });

  it('when the state is the only group, the task degrades to identity-only — not to the worn sheet', () => {
    const apps = [app(1, 'standard', ['CLO002']), app(2, 'standard', ['CLO002'])];
    const { tasks, skipped } = plan(apps, { hasOffSheet: () => false });
    expect(tasks.length).toBe(1);
    expect(tasks[0].mode).toBe('identity');
    expect(tasks[0].notEvaluated).toBe('no-wardrobe-variant-sheet');
    expect(skipped[0].reason).toBe('no-wardrobe-variant-sheet');
  });

  it('the sheet lookup is exact — a base sheet never answers for a state', () => {
    const character = { avatars: { styledAvatars: { pixar: { standard: 'x', 'standard--off:CLO002': 'y' } } } };
    expect(hasWardrobeVariantSheet(character, 'pixar', 'standard--off:CLO002')).toBe(true);
    expect(hasWardrobeVariantSheet(character, 'pixar', 'standard--off:CLO001')).toBe(false);
    expect(hasWardrobeVariantSheet(character, 'pixar', 'standard')).toBe(true);
  });
});

describe('the expected clothing text is the group state only', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server/lib/entityConsistency.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  it('no union across states reaches the judge', () => {
    // The union-drop is deleted, not left inert.
    expect(src).not.toMatch(/groupWornMetas/);
    expect(src).not.toMatch(/sceneMetadatas/);
  });

  it('the base contract is built for the group, and removals are stated positively', () => {
    expect(src).toMatch(/buildClothingDescription\(\s*\n?\s*character, baseCategory, artStyle/);
    expect(src).toMatch(/deliberately removed/);
  });
});
