/**
 * One garment, one outfit (staging job_1790373080139_vnx5l8iy7).
 *
 * The plan hands an older brother's jacket to his younger brother from a later
 * page; the wardrobe reviewer read its plot-garment check as "put it in the
 * receiver's outfit" and copied the jacket into the second outfit, so both
 * sheets wore the same jacket. The handoff is carried per page by the plan
 * line and `wornItems`. The rule is ONE constant filled into the bible writer
 * (generator) and the wardrobe reviewer (critic); this pins that both built
 * prompts carry it. Pins behaviour, never wording. Offline, no paid call.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const CAST = [
  { name: 'Pim', age: 5, gender: 'male' },
  { name: 'Ottilie', age: 3, gender: 'female' },
];
const REQS: any = {
  Pim: { standard: { used: true, description: 'A red cotton shirt, blue denim jeans, white canvas trainers and a green quilted jacket with a front zip.' } },
  Ottilie: { standard: { used: true, description: 'A yellow knit pullover, brown corduroy trousers and orange rubber boots.' } },
};

describe('the one-garment-one-outfit rule reaches the writer and the reviewer', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const inputData: any = { characters: CAST, language: 'en', pages: 2, storyCategory: 'adventure', artStyle: 'watercolor' };
  const beats = [
    { pageNumber: 1, planLine: 'wide — the older child — wraps his jacket around the egg' },
    { pageNumber: 2, planLine: 'medium — the younger child — carries the wrapped egg' },
  ];

  it('is a non-empty shared constant', () => {
    expect(typeof PB.GARMENT_ONE_OUTFIT_RULE).toBe('string');
    expect(PB.GARMENT_ONE_OUTFIT_RULE.length).toBeGreaterThan(40);
  });

  it('the built bible-writer prompt carries it', () => {
    const p = PB.buildStoryBibleFromBeatsPrompt(inputData, beats);
    expect(p).toContain(PB.GARMENT_ONE_OUTFIT_RULE);
    expect(p).not.toContain('{GARMENT_ONE_OUTFIT_RULE}');
  });

  it('the built wardrobe-review prompt carries it', () => {
    const p = PB.buildClothingReviewPrompt(inputData, REQS, beats);
    expect(p).toContain(PB.GARMENT_ONE_OUTFIT_RULE);
    expect(p).not.toContain('{GARMENT_ONE_OUTFIT_RULE}');
  });
});
