import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const nodeRequire = createRequire(import.meta.url);

const { resolveStoryPageAspect } = nodeRequire('../../server/lib/layout.js');
const { charactersByIds } = nodeRequire('../../server/lib/castResolver.js');
const { buildCharacterRestriction } = nodeRequire('../../server/lib/promptBuilders.js');
const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('regenerate route - page aspect comes from the story layout', () => {
  it('square-below story resolves 1:1 even when no scene is stamped', () => {
    const story = { layout: { mode: 'square-below', imageAspect: '1:1' }, sceneImages: [{ pageNumber: 1 }] };
    expect(resolveStoryPageAspect(story)).toBe('1:1');
  });
  it('overlay story resolves 3:4', () => {
    expect(resolveStoryPageAspect({ layout: { imageAspect: '3:4' } })).toBe('3:4');
  });
  it('throws (no default) when the layout is missing, even if a scene is stamped', () => {
    expect(() => resolveStoryPageAspect({ sceneImages: [{ pageNumber: 1, imageAspect: '1:1' }] })).toThrow(/layout\.imageAspect/);
    expect(() => resolveStoryPageAspect(null)).toThrow();
    expect(() => resolveStoryPageAspect({ layout: { imageAspect: '16:9' } })).toThrow();
  });
  it('no route or repair site reads a per-scene imageAspect or the 3:4 default any more', () => {
    for (const f of ['server/routes/regeneration.js', 'server/lib/repairPipeline.js']) {
      const src = read(f);
      expect(src, f).not.toMatch(/\.imageAspect\s*\|\|/);
      expect(src, f).not.toMatch(/sceneAspect \|\| MODEL_DEFAULTS\.pageAspect/);
    }
  });
});

describe('regenerate route - scene brief rewrite goes through the iterate call, no prefill', () => {
  it('no site sends the previewMismatches prefill', () => {
    for (const f of ['server/routes/regeneration.js', 'server/lib/testlab.js']) {
      expect(read(f), f).not.toContain(`prefill: '{"previewMismatches":['`);
    }
  });
  it('both regen routes and the Lab mirror call callIterateBrief', () => {
    expect((read('server/routes/regeneration.js').match(/callIterateBrief\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(read('server/lib/testlab.js')).toContain('callIterateBrief(');
  });
  it('an expansion failure is not swallowed into a raw-summary render', () => {
    expect(read('server/routes/regeneration.js')).not.toContain('Scene expansion failed, using original summary');
  });
});

describe('regenerate route - characterIds guard', () => {
  const cast = [{ id: 7, name: 'A' }, { id: 8, name: 'B' }];
  it('matches string ids against numeric stored ids', () => {
    expect(charactersByIds(cast, ['7']).map((c: any) => c.name)).toEqual(['A']);
    expect(charactersByIds(cast, [8]).map((c: any) => c.name)).toEqual(['B']);
  });
  it('returns nothing for unknown ids (the route answers 400)', () => {
    expect(charactersByIds(cast, ['99'])).toEqual([]);
  });
  it('buildCharacterRestriction refuses an empty selection', () => {
    expect(() => buildCharacterRestriction([], ['A', 'B'])).toThrow(/empty selection/);
    expect(buildCharacterRestriction(['A'], ['B'])).toContain('Do NOT include: B');
    expect(buildCharacterRestriction(['A'], [])).toBe('');
  });
});

describe('regenerate route - edited-scene expansion gets the PAGE clothing, not the clothingRequirements table', () => {
  const PB = nodeRequire('../../server/lib/promptBuilders.js');
  beforeAll(async () => { await nodeRequire('../../server/services/prompts.js').loadPromptTemplates(); });
  const chars = [{ id: 1, name: 'Ada', physical: { hairColor: 'blonde', eyeColor: 'blue' }, avatars: {} }];
  const clothingRequirements = { Ada: { standard: { used: true, garments: [{ name: 'jacket', slot: 'top', colour: 'red' }] }, costumed: { used: false } } };
  const build = (clothing: unknown) => PB.buildSceneDescriptionPrompt(3, 'Ada waves.', chars, 'Ada waves at the boat.', 'en', null, [], clothing, '', '', { planLine: 'Ada waves.' }, null, { clothingRequirements });

  it('the table in the clothing slot crashes the builder (the 2026-10-17 staging 500)', () => {
    expect(() => build(clothingRequirements)).toThrow(/trim is not a function/);
  });
  it('the page clothing map builds a prompt with the character', () => {
    expect(build({ Ada: 'standard' })).toContain('Ada');
  });
  it('the edited-scene expansion call passes the page clothing', () => {
    const src = read('server/routes/regeneration.js');
    const call = src.slice(src.indexOf('const expansionPrompt = buildSceneDescriptionPrompt('), src.indexOf('const expansionPrompt = buildSceneDescriptionPrompt(') + 1200);
    expect(call).toContain('storyData.pageClothing?.pageClothing?.[pageNumber] || storyData.pageClothing?.primaryClothing');
    expect(call).not.toMatch(/previousScenes,\s*clothingData,/);
  });
});
