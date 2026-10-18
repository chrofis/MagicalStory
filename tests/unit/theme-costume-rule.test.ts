/**
 * The theme's COSTUME field reaches the wardrobe step as a rule (owner decision
 * 2026-10-18, docs/decisions.md). Before: the wardrobe writer was only told to
 * costume "whenever the theme implies special clothing", and ~1 pirate-theme
 * story in 16 got everyday clothes. These pin behaviour: the structured field
 * is read (never prose), no field means nothing injected, and the adult
 * role-clothing rule stays.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const {
  guideCostume,
  themeCostumeRule,
  buildStoryBibleFromBeatsPrompt,
  buildClothingReviewPrompt,
} = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const base = {
  characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'curious' }],
  mainCharacters: ['c1'],
  language: 'en',
  languageLevel: 'medium',
  pages: 2,
};
const beats = [{ page: 1, beat: 'the child finds the door' }, { page: 2, beat: 'the door opens' }];
const wardrobe = (extra: any) => buildStoryBibleFromBeatsPrompt({ ...base, ...extra }, beats);

beforeAll(async () => { await loadPromptTemplates(); });

describe('guideCostume', () => {
  it('reads the costume id from the structured line', () => {
    expect(guideCostume('PROMISE: x\nCOSTUME: pirate (mandatory for adventure scenes)\n\nbody')).toBe('pirate');
    expect(guideCostume('COSTUME: police officer (mandatory for adventure scenes)')).toBe('police officer');
  });
  it('is empty for "not needed" and for a guide without the line', () => {
    expect(guideCostume('COSTUME: not needed - use standard avatar')).toBe('');
    expect(guideCostume('Who lives here')).toBe('');
    expect(guideCostume(null)).toBe('');
    expect(themeCostumeRule('COSTUME: not needed - use standard avatar')).toBe('');
  });
});

describe('wardrobe writer prompt', () => {
  it('a costume theme states the costume as a rule, with the role-clothing exemption', () => {
    const p = wardrobe({ storyCategory: 'adventure', storyTheme: 'pirate' });
    expect(p).toContain("The theme's costume is `pirate`");
    expect(p).toContain('`costumed.costume: pirate`');
    expect(p).toMatch(/An adult the story already dresses for their role stays `standard`/);
    expect(p).not.toContain('THEME_COSTUME_RULE');
  });
  it('the role-clothing sentence for characters is still there', () => {
    const p = wardrobe({ storyCategory: 'adventure', storyTheme: 'pirate' });
    expect(p).toContain('A character the story already dresses for their role stays `standard`');
  });
  it('a theme with no costume gets nothing', () => {
    const p = wardrobe({ storyCategory: 'adventure', storyTheme: 'dragons' });
    expect(p).not.toContain("The theme's costume is");
    expect(p).not.toContain('THEME_COSTUME_RULE');
  });
  it('a non-adventure story gets nothing', () => {
    const p = wardrobe({ storyCategory: 'life-challenge', storyTopic: 'bath-time' });
    expect(p).not.toContain("The theme's costume is");
  });
});

describe('wardrobe reviewer prompt holds the same rule', () => {
  const req = { Mira: { standard: { used: true, description: 'A red jumper and blue jeans.' } } };
  it('costume theme', () => {
    const p = buildClothingReviewPrompt({ ...base, storyCategory: 'adventure', storyTheme: 'pirate' }, req, beats);
    expect(p).toContain("The theme's costume is `pirate`");
    expect(p).not.toContain('THEME_COSTUME_CHECK');
  });
  it('no-costume theme', () => {
    const p = buildClothingReviewPrompt({ ...base, storyCategory: 'adventure', storyTheme: 'dragons' }, req, beats);
    expect(p).not.toContain("The theme's costume is");
    expect(p).not.toContain('THEME_COSTUME_CHECK');
  });
});
