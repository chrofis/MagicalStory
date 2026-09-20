import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
const { buildVariantInstructions } = require_('../../server/routes/storyIdeas');

describe('buildVariantInstructions', () => {
  it('gives the two arms different instructions when both play in the real world', () => {
    const [first, second] = buildVariantInstructions('location', 'location');
    expect(second).not.toBe(first);
  });

  it('states the second location arm place class and event class as values, not as a choice', () => {
    const [, second] = buildVariantInstructions('location', 'location', { characters: [{ name: 'Mia', age: 5 }], storyTopic: 'making-friends' });
    expect(second).toMatch(/requirements, not choices/i);
    expect(second).toMatch(/this story plays (indoors|outdoors|at home|in a public place)/i);
    expect(second).toMatch(/what makes it hard is \S/i);
    expect(second).toMatch(/responsible for the youngest character/i);
    // no open-ended "pick a different X" phrasing left for the model to resolve
    expect(second).not.toMatch(/a different class of place/i);
  });

  it('is deterministic for the same inputs and varies with them', () => {
    const a = buildVariantInstructions('location', 'location', { characters: [{ name: 'Mia', age: 5 }], storyTopic: 'making-friends' })[1];
    const b = buildVariantInstructions('location', 'location', { characters: [{ name: 'Mia', age: 5 }], storyTopic: 'making-friends' })[1];
    expect(a).toBe(b);
    const seen = new Set<string>();
    for (const topic of ['making-friends', 'not-giving-up', 'going-outside', 'managing-emotions', 'sharing', 'bedtime', 'new-school', 'losing-a-pet']) {
      seen.add(buildVariantInstructions('location', 'location', { characters: [{ name: 'Lena', age: 1 }], storyTopic: topic })[1]);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('never asks the fantasy arm for a place class', () => {
    const [, second] = buildVariantInstructions('location', 'fantasy', { characters: [{ name: 'Mia', age: 5 }] });
    expect(second).not.toMatch(/requirements, not choices/i);
  });

  it('leaves the location+fantasy pair on the generic instruction', () => {
    const [, second] = buildVariantInstructions('location', 'fantasy');
    expect(second).not.toMatch(/class of place/i);
    expect(second).toMatch(/Avoid local landmarks/);
  });

  it('keeps the first arm keyed to its own world', () => {
    expect(buildVariantInstructions('fantasy', 'location')[0]).toMatch(/adventure world/);
    expect(buildVariantInstructions('location', 'fantasy')[0]).toMatch(/local landmarks/);
  });
});
