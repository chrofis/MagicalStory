import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * EMPTY IS NOT ABSENT.
 *
 * `collectStyleRefSheets` filtered the styled-avatar sheets to the page cast
 * with `wanted.size === 0 || wanted.has(name)` — a truthiness check that reads
 * an EMPTY cast as "no filter given" and therefore collects the first two
 * character sheets in the book.
 *
 * Real on staging: job_1789337998754_apslnsq1z pages 13, 15 and 19 store
 * `sceneCharacters: []` with `sceneCharacterClothing: {"Lantern man":"standard"}`
 * — pages carrying only a secondary figure, no main cast. Style repair on p13
 * would have attached Levin's and Julian's sheets: two people who are not on
 * that page, which is precisely the foreign-cast leak the sheet mechanism
 * exists to avoid (the 2026-08-09 sibling-page finding). 38 such page records
 * sit in the last 60 staging stories.
 *
 * ABSENT keeps its documented behaviour: covers (page < 0) have no scene
 * record at all, so "the caller did not say" stays unfiltered — see the JSDoc.
 *
 * Fixtures below are the REAL stored shapes for that story (pulled from
 * staging), trimmed to the fields the function reads.
 */

// @ts-expect-error - JS module without types
import { collectStyleRefSheets } from '../../server/lib/repairPipeline.js';

const ENTITY = require.resolve('../../server/lib/entityConsistency');

/** Install a fake entityConsistency whose sheet resolver records its calls. */
function withSheets(fn: (asked: string[]) => Promise<void>) {
  const asked: string[] = [];
  const prev = require.cache[ENTITY];
  require.cache[ENTITY] = {
    exports: {
      getStyledAvatarForClothing: async (char: any) => {
        asked.push(char?.name);
        return { imageData: `data:image/png;base64,${char?.name}` };
      },
    },
  } as any;
  return fn(asked).finally(() => {
    if (prev) require.cache[ENTITY] = prev; else delete require.cache[ENTITY];
  });
}

// Real staging story job_1789337998754_apslnsq1z, trimmed.
const CHARACTERS = [{ name: 'Levin' }, { name: 'Julian' }, { name: 'Max' }, { name: 'Kiaan' }];
const SCENES = [
  { pageNumber: 12, sceneCharacters: [{ name: 'Julian' }, { name: 'Max' }], sceneCharacterClothing: { Max: 'standard', Julian: 'standard' } },
  // p13: cast declared, and declared as NOBODY main — only a secondary figure.
  { pageNumber: 13, sceneCharacters: [], sceneCharacterClothing: { 'Lantern man': 'standard' } },
  { pageNumber: 14, sceneCharacters: [{ name: 'Levin' }, { name: 'Max' }, { name: 'Kiaan' }], sceneCharacterClothing: { Max: 'standard', Kiaan: 'standard', Levin: 'standard' } },
  // Real second shape: some stories store no `sceneCharacters` key at all
  // (e.g. job_1788721172453_0cg5c6ny7 every page).
  { pageNumber: 20 },
];

afterEach(() => { delete require.cache[ENTITY]; });

describe('collectStyleRefSheets — an empty cast is a cast of nobody', () => {
  it('REGRESSION: page 13 (sceneCharacters: []) collects NO sheets', async () => {
    await withSheets(async (asked) => {
      const sheets = await collectStyleRefSheets(13, SCENES, CHARACTERS, 'watercolor');
      // Before the fix: ['data:...Levin', 'data:...Julian'] — two absent people.
      expect(sheets).toEqual([]);
      expect(asked).toEqual([]);
    });
  });

  it('a populated cast filters to exactly those characters', async () => {
    await withSheets(async (asked) => {
      const sheets = await collectStyleRefSheets(12, SCENES, CHARACTERS, 'watercolor');
      expect(asked).toEqual(['Julian', 'Max']);
      expect(sheets).toHaveLength(2);
    });
  });

  it('caps at 2 sheets even when the declared cast is larger', async () => {
    await withSheets(async (asked) => {
      const sheets = await collectStyleRefSheets(14, SCENES, CHARACTERS, 'watercolor');
      expect(asked).toEqual(['Levin', 'Max']);
      expect(sheets).toHaveLength(2);
    });
  });

  it('ABSENT (no sceneCharacters key) stays unfiltered — documented behaviour', async () => {
    await withSheets(async (asked) => {
      await collectStyleRefSheets(20, SCENES, CHARACTERS, 'watercolor');
      expect(asked).toEqual(['Levin', 'Julian']);
    });
  });

  it('ABSENT (no scene record at all — a cover, page < 0) stays unfiltered', async () => {
    await withSheets(async (asked) => {
      await collectStyleRefSheets(-1, SCENES, CHARACTERS, 'watercolor');
      expect(asked).toEqual(['Levin', 'Julian']);
    });
  });
});

describe('the ambiguity cannot be reintroduced', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/repairPipeline.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function collectStyleRefSheets'));
  const body = fn.slice(0, fn.indexOf('\nasync function '));

  it('branches on Array.isArray, not on the cast being truthy/non-empty', () => {
    expect(body).toContain("Array.isArray(scene?.sceneCharacters)");
    // The old guard, and the `|| []` that erased the absent/empty distinction.
    expect(body).not.toContain('wanted.size === 0 ||');
    expect(body).not.toMatch(/sceneCharacters \|\| \[\]/);
  });

  it('the Test Lab style_repair stage uses the pipeline function, not a copy', () => {
    const testlab = fs.readFileSync(path.join(process.cwd(), 'server/lib/testlab.js'), 'utf8');
    expect(testlab).toMatch(/const \{ collectStyleRefSheets \} = require\('\.\/repairPipeline'\)/);
    expect(testlab).not.toMatch(/function collectStyleRefSheets/);
    expect(src).toMatch(/^\s*collectStyleRefSheets,\s*$/m); // still exported
  });
});
