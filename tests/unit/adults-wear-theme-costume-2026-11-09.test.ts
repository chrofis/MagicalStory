/**
 * Adults in a theme story get a costume too (owner, 2026-11-09: "I never said that adults don't
 * get a costume, reverse that"). The 2026-10-18 rule told the wardrobe step that an adult stays
 * `standard`; the wardrobe reviewer then wrote "Fabiola is the adult, stays standard" although the
 * customer's own text asked for her as a warrior with a sword (prod job_1794231161354_l3n2o3afm).
 * Owner choice: role first, else theme: an adult the story request dresses for a role wears that
 * role's outfit, every other character in the adventure wears the theme's costume.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const { themeCostumeRule, buildStoryBibleFromBeatsPrompt, buildClothingReviewPrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const base = {
  characters: [
    { id: 'c1', name: 'Mira', age: 4, gender: 'girl', personality: 'brave' },
    { id: 'c2', name: 'Lena', age: 33, gender: 'woman', personality: 'protective' },
  ],
  mainCharacters: ['c1'],
  language: 'en',
  languageLevel: 'medium',
  pages: 2,
  storyCategory: 'adventure',
  storyTheme: 'wizard',
};
const beats = [{ page: 1, beat: 'mother and daughter set out' }, { page: 2, beat: 'they face the witch' }];

beforeAll(async () => { await loadPromptTemplates(); });

describe('theme costume rule covers adults', () => {
  const rule = themeCostumeRule('COSTUME: wizard (mandatory for adventure scenes)');
  it('no longer keeps adults in everyday clothes', () => {
    expect(rule).not.toMatch(/adult[^.]*stays `standard`/i);
    expect(rule).not.toMatch(/The child characters/);
  });
  it('costumes every character in the adventure, children and adults alike', () => {
    expect(rule).toContain('children and adults alike');
    expect(rule).toContain('`costumed.costume` is `wizard`');
  });
  it('a character the request dresses for a role wears that role\'s outfit', () => {
    expect(rule).toMatch(/story request asks to be dressed for a role of their own/);
    expect(rule).toMatch(/names that role's outfit/);
  });
  it('the writer and the reviewer both hold it', () => {
    const w = buildStoryBibleFromBeatsPrompt(base, beats);
    const r = buildClothingReviewPrompt(base, { Mira: { standard: { used: true, description: 'A red jumper.' } } }, beats);
    for (const p of [w, r]) expect(p).toContain('children and adults alike');
    expect(r).not.toMatch(/A child the theme is about who has no/);
    expect(r).toMatch(/A character in the theme's adventure who has no `costumed` outfit is a missing entry/);
  });
});
