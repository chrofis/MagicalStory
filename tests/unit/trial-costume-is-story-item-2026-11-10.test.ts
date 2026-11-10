import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Owner decision 2026-11-10 "Story uses the costume": the trial costume is fixed and its avatar draws every
 * piece, so an item the writer invents for a slot the costume fills loses to the avatar (prod trials
 * 9v3igrbnb, 37p11sdnm, gr4cnr0u8). Both trial templates read {AVATAR_SELECTION}, so one constant reaches both.
 */
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');
beforeAll(async () => { await loadPromptTemplates(); });

const base = { language: 'en', languageLevel: 'standard', storyCategory: 'adventure', storyDetails: 'x', pages: 6,
  characters: [{ id: 'a', name: 'Anna', age: 6, gender: 'female' }], mainCharacters: ['a'] };
const ARC = '---STORY ARC---\nx\n---VISUAL BIBLE---\ny';

describe('costume is the story wardrobe', () => {
  it('arc and pages prompts carry the rule next to the costume line', () => {
    const inp = { ...base, storyTheme: 'unicorn' };
    for (const p of [PB.buildTrialArcPrompt(inp, 6), PB.buildTrialPagesPrompt(inp, 6, ARC)]) {
      expect(p).toContain('crystal tiara');
      expect(p).toContain(PB.COSTUME_IS_THE_STORY_ITEM_RULE);
    }
  });
  it('a theme without a costume gets no costume rule', () => {
    const inp = { ...base, storyCategory: 'educational', storyTheme: '', storyTopic: 'insects' };
    expect(PB.buildTrialPagesPrompt(inp, 6, ARC)).not.toContain(PB.COSTUME_IS_THE_STORY_ITEM_RULE);
  });
});
