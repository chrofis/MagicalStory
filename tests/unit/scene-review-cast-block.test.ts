/**
 * A6 — the scene review judges briefs against the cast block the Art Director
 * wrote from: physical traits + the resolved outfit. Its checks 3b (clothing
 * completeness) and 10c (no trait the CHARACTER DETAILS does not carry) are
 * unjudgeable without them.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const { loadPromptTemplates } = require('../../server/services/prompts');
const PB = require('../../server/lib/promptBuilders');

const CHARACTERS = [
  {
    id: 'c1', name: 'Alva', age: 5, gender: 'female',
    traits: { strengths: ['Mutig'], flaws: ['Schuechtern'], specialDetails: 'Likes dinosaurs' },
    physical: { hairColor: 'dark brown', hairStyle: 'straight', hairLength: 'short', eyeColor: 'green', build: 'slim' },
  },
];
const CLOTHING = { Alva: { standard: { used: true, description: 'A red raincoat, blue trousers and yellow boots.' } } };
const inputData: any = { characters: CHARACTERS, mainCharacters: ['c1'], language: 'en', clothingRequirements: CLOTHING };
const scenes = [{ pageNumber: 1, brief: 'A child stands in the rain.' }];

function characterDetails(prompt: string): string {
  const m = prompt.match(/# CHARACTER DETAILS\n\n([\s\S]*?)\n\n# PAGE PLAN/);
  return m ? m[1] : '';
}

describe('scene review CHARACTER DETAILS', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('carries the physical traits and the resolved outfit', () => {
    const block = characterDetails(PB.buildSceneReviewPrompt(inputData, scenes, { clothingRequirements: CLOTHING }));
    expect(block).toContain('Alva');
    expect(block).toMatch(/Build:/);
    expect(block).toMatch(/Eyes:/);
    expect(block).toContain('Wearing:');
    expect(block).toContain('red raincoat');
  });

  it('drops the story-planning traits no check reads', () => {
    const block = characterDetails(PB.buildSceneReviewPrompt(inputData, scenes, { clothingRequirements: CLOTHING }));
    expect(block).not.toMatch(/Strengths:/);
    expect(block).not.toMatch(/Flaws:/);
    expect(block).not.toMatch(/Personality:/);
  });

  it('is the same block the all-pages Art Director is given', () => {
    const cast = PB.buildExpansionCastBlock(CHARACTERS, CLOTHING, null);
    const block = characterDetails(PB.buildSceneReviewPrompt(inputData, scenes, { clothingRequirements: CLOTHING }));
    expect(block.trim()).toBe(cast.block.trim());
    expect(cast.resolvedOutfits).toBe(1);
  });

  it('falls back to the story data when no clothing contract is passed in options', () => {
    const block = characterDetails(PB.buildSceneReviewPrompt(inputData, scenes, {}));
    expect(block).toContain('red raincoat');
  });
});
