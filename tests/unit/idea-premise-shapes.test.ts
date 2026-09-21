import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
const { pickPremiseShapes, premiseShapeInstruction } = require_('../../server/routes/storyIdeas');

const cast = (...ages: Array<[string, number, boolean?]>) =>
  ages.map(([name, age, isMain]) => ({ name, age, isMain: !!isMain }));

describe('pickPremiseShapes', () => {
  it('gives the two arms different shapes', () => {
    for (const topic of ['making-friends', 'not-giving-up', 'going-outside', 'managing-emotions', 'sharing', 'bedtime']) {
      const [a, b] = pickPremiseShapes({ characters: cast(['Mia', 5, true], ['Leo', 8]), storyTopic: topic });
      expect(a.id).not.toBe(b.id);
    }
  });

  it('never picks a shape above the youngest character age', () => {
    const [a, b] = pickPremiseShapes({ characters: cast(['Lena', 1, true]), storyTopic: 'going-outside' });
    expect(a.minAge).toBeLessThanOrEqual(1);
    expect(b.minAge).toBeLessThanOrEqual(1);
  });

  it('reads the youngest of the whole cast, not the main character', () => {
    const [a, b] = pickPremiseShapes({ characters: cast(['Finn', 12, true], ['Tim', 2]), storyTopic: 'x' });
    for (const s of [a, b]) expect(s.minAge).toBeLessThanOrEqual(2);
  });

  it('withholds the two-mains shape from a cast with one main', () => {
    const one = pickPremiseShapes({ characters: cast(['Solo', 9, true], ['Helper', 9]), storyTopic: 'x' });
    expect(one.some((s: any) => /between the two mains/.test(s.name))).toBe(false);
  });

  it('is deterministic for the same inputs and varies with them', () => {
    const args = { characters: cast(['Mia', 5, true]), storyTopic: 'making-friends', storyTheme: 'realistic', language: 'de' };
    expect(pickPremiseShapes(args).map((s: any) => s.id)).toEqual(pickPremiseShapes(args).map((s: any) => s.id));
    const seen = new Set<string>();
    for (const topic of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      seen.add(pickPremiseShapes({ ...args, storyTopic: topic }).map((s: any) => s.id).join('-'));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('states the shape as a requirement, with its definition', () => {
    const [a] = pickPremiseShapes({ characters: cast(['Mia', 5, true]), storyTopic: 'x' });
    const text = premiseShapeInstruction(a);
    expect(text).toContain(a.name);
    expect(text).toContain(a.definition);
    expect(text).toMatch(/requirement, not a choice/);
  });
});

describe('peril-prone shapes', () => {
  it('withholds rescue from a cast whose youngest is five or under', () => {
    for (const topic of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      const picked = pickPremiseShapes({ characters: cast(['Mia', 5, true], ['Leo', 8]), storyTopic: topic });
      expect(picked.some((s: any) => s.name === 'rescue')).toBe(false);
    }
  });

  it('keeps rescue available above that age', () => {
    const seen = new Set<string>();
    for (const topic of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
      for (const s of pickPremiseShapes({ characters: cast(['Finn', 10, true]), storyTopic: topic })) seen.add(s.name);
    }
    expect(seen.has('rescue')).toBe(true);
  });
});
