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

  it('names the three variety axes on the second location arm', () => {
    const [, second] = buildVariantInstructions('location', 'location');
    expect(second).toMatch(/class of place/i);
    expect(second).toMatch(/responsible adult/i);
    expect(second).toMatch(/outside event/i);
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
