/**
 * A story prop is never a garment (staging showcase job_1791315635053_t0t8qpebu, Daniel).
 *
 * The bible writer's "worn object the story turns on" line listed a picnic blanket the plan has someone
 * spread and wrap as an outfit item; the avatar sheet then drew it as a scarf on every cell and every
 * page copied it. The rule is ONE constant (WARDROBE_RULES.PROP_NOT_GARMENT_DEF) filled into the bible
 * writer (generator) and the wardrobe reviewer (critic). Pins that both built prompts carry it and that
 * the writer's plot-garment line no longer lists "spread" as something a garment does.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const CAST = [{ name: 'Daniel', age: 38, gender: 'male' }];
const REQS: any = {
  Daniel: { standard: { used: true, description: 'A green waxed cotton jacket with a front zip, black jeans and brown boots.' } },
};

describe('the prop-is-not-a-garment rule reaches the writer and the reviewer', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const inputData: any = { characters: CAST, language: 'en', pages: 2, storyCategory: 'adventure', artStyle: 'watercolor' };
  const beats = [{ pageNumber: 1, planLine: 'wide — Daniel spreads a picnic blanket and wraps it around the child' }];

  it('the built bible-writer prompt carries the rule and names no unfilled placeholder', () => {
    const p = PB.buildStoryBibleFromBeatsPrompt(inputData, beats);
    expect(p).toMatch(/A prop is not a garment/);
    expect(p).toMatch(/blanket, towel, sheet/);
    expect(p).not.toContain('{PROP_NOT_GARMENT_DEF}');
  });

  it('the built wardrobe-review prompt carries the same sentence', () => {
    const w = PB.buildStoryBibleFromBeatsPrompt(inputData, beats);
    const r = PB.buildClothingReviewPrompt(inputData, REQS, beats);
    const sentence = 'A garment is clothing a person wears';
    expect(w).toContain(sentence);
    expect(r).toContain(sentence);
    expect(r).not.toContain('{PROP_NOT_GARMENT_DEF}');
  });

  it('the plot-garment line no longer lists "spread" as something a garment does', () => {
    const w = PB.buildStoryBibleFromBeatsPrompt(inputData, beats);
    expect(w).not.toMatch(/hold, lend, wrap, spread or lose/);
  });
});
