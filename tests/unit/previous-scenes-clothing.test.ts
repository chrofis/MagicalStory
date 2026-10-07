/**
 * bugs.json previous-scenes-clothing-object-object (BACKLOG.md:1943 / :1914).
 * Every caller of buildSceneDescriptionPrompt pushes
 * `clothing: pageClothing[prevPage]` into previousScenes[], which the unified
 * pipeline stores as a per-character map {Name: category}. The builder used
 * to interpolate it as a string, so the Art Director read
 * "Clothing: [object Object]" for every previous page.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// @ts-ignore — CommonJS lib
const PB = require('../../server/lib/promptBuilders.js');
// @ts-ignore
const { loadPromptTemplates } = require('../../server/services/prompts.js');

beforeAll(async () => { await loadPromptTemplates(); });

const chars = [{ id: 'a', name: 'Mia', age: 6, isMain: true }, { id: 'b', name: 'Ben', age: 8 }];

function build(previousScenes: any[]) {
  // rawOutlineContext = null → the structured previousScenes branch renders the PREVIOUS SCENES block
  return PB.buildSceneDescriptionPrompt(3, 'Page three text.', chars, '', 'en', null, previousScenes, {}, '', '', null, null, {});
}

describe('PREVIOUS SCENES clothing line', () => {
  it('renders a per-character map as "Name: category, Name2: category" and a string as-is', () => {
    const prompt = build([
      { pageNumber: 1, text: 'Page one text.', sceneHint: '', clothing: { Mia: 'standard', Ben: 'costumed' } },
      { pageNumber: 2, text: 'Page two text.', sceneHint: '', clothing: 'winter' },
    ]);
    expect(prompt).toContain('Page 1: Page one text.\n  Clothing: Mia: standard, Ben: costumed\n');
    expect(prompt).toContain('Page 2: Page two text.\n  Clothing: winter\n');
    expect(prompt).not.toContain('[object Object]');
  });

  it('omits the line when the previous page has no clothing', () => {
    const prompt = build([{ pageNumber: 2, text: 'Page two text.', sceneHint: '', clothing: null }]);
    expect(prompt).toContain('Page 2: Page two text.\n');
    expect(prompt).not.toMatch(/Page 2: Page two text\.\n\s+Clothing:/);
    expect(prompt).not.toContain('[object Object]');
  });

  it('throws on a shape it cannot render instead of stringifying it', () => {
    expect(() => build([{ pageNumber: 2, text: 'Page two text.', sceneHint: '', clothing: { Mia: { _currentClothing: 'costumed' } } }]))
      .toThrow(/previous-page clothing for "Mia"/);
    expect(() => build([{ pageNumber: 2, text: 'Page two text.', sceneHint: '', clothing: ['winter'] }]))
      .toThrow(/unsupported shape/);
  });
});
