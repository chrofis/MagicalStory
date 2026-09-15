import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  reconcilePageClothingWithRequirements,
} = require('../../server/lib/clothingCategories.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
const { buildTrialStoryPrompt } = require('../../server/lib/promptBuilders.js');

// ── Real fixture: prod job_1788698812047_q5b1vuds7 (trial, theme mothers-day) ──
// clothingRequirements said the costumed slot was unused; pageClothing said
// "costumed" on 4 of 6 pages. The costume then reached the render as a Visual
// Bible artifact prop instead of a worn outfit.
const REQS = {
  Amian: { costumed: { used: false }, standard: { used: true, signature: 'none' } },
};

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe('reconcilePageClothingWithRequirements', () => {
  it('replaces a category the story never marked used, and logs at ERROR', () => {
    const log = fakeLogger();
    const { clothing, overrides } = reconcilePageClothingWithRequirements(
      { Mama: 'standard', Amian: 'costumed' },
      REQS,
      { pageNumber: 2, logger: log }
    );
    expect(clothing.Amian).toBe('standard');
    expect(overrides).toEqual([
      { pageNumber: 2, character: 'Amian', requested: 'costumed', replacedWith: 'standard' },
    ]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain('Amian');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('leaves a page alone when the category IS marked used', () => {
    const log = fakeLogger();
    const reqs = {
      Amian: { costumed: { used: true, costume: 'pirate' }, standard: { used: true } },
    };
    const { clothing, overrides } = reconcilePageClothingWithRequirements(
      { Amian: 'costumed' },
      reqs,
      { pageNumber: 3, logger: log }
    );
    expect(clothing.Amian).toBe('costumed');
    expect(overrides).toHaveLength(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('matches a costume subtype against the bare costumed contract', () => {
    const reqs = { Hero: { costumed: { used: true, costume: 'pirate' } } };
    const { overrides } = reconcilePageClothingWithRequirements({ Hero: 'costumed' }, reqs, {});
    expect(overrides).toHaveLength(0);
  });

  it('leaves a character with no contract entry untouched', () => {
    const log = fakeLogger();
    const { clothing, overrides } = reconcilePageClothingWithRequirements(
      { Mama: 'costumed' },
      REQS,
      { pageNumber: 4, logger: log }
    );
    expect(clothing.Mama).toBe('costumed');
    expect(overrides).toHaveLength(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not mutate the input map', () => {
    const input = { Amian: 'costumed' };
    const { clothing } = reconcilePageClothingWithRequirements(input, REQS, {});
    expect(input.Amian).toBe('costumed');
    expect(clothing.Amian).toBe('standard');
  });

  it('is a no-op without a contract', () => {
    const { clothing, overrides } = reconcilePageClothingWithRequirements(
      { Amian: 'costumed' },
      null,
      {}
    );
    expect(clothing).toEqual({ Amian: 'costumed' });
    expect(overrides).toHaveLength(0);
  });
});

describe('buildTrialStoryPrompt costume instructions', () => {
  const base = {
    language: 'de-ch',
    pages: 6,
    characters: [{ name: 'Amian', age: 1, gender: 'male' }],
    storyCategory: 'adventure',
    storyDetails: 'A day out',
  };

  it('says nothing about costumes when the theme has no configured costume', async () => {
    await loadPromptTemplates();
    const prompt = buildTrialStoryPrompt({ ...base, storyTheme: 'mothers-day' }, 6);
    expect(prompt).not.toMatch(/\{[A-Z_]+\}/);
    expect(prompt).toContain('"clothing": "standard"');
    expect(prompt).not.toContain('"clothing": "[standard | costumed]"');
    expect(prompt).not.toContain('Characters in costumed clothing');
    expect(prompt).toContain('this story has no costume variant');
    expect(prompt).not.toContain('wears it in every scene except the very first');
  });

  it('keeps the costume instructions when a costume IS configured', async () => {
    await loadPromptTemplates();
    const prompt = buildTrialStoryPrompt({ ...base, storyTheme: 'pirate' }, 6);
    expect(prompt).not.toMatch(/\{[A-Z_]+\}/);
    expect(prompt).toContain('"clothing": "[standard | costumed]"');
    expect(prompt).toContain('"clothing": "costumed"');
    expect(prompt).toContain('Characters in costumed clothing');
    expect(prompt).toContain('wears it in every scene except the very first');
    expect(prompt).not.toContain('this story has no costume variant');
  });
});
