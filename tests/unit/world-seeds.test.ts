import { describe, it, expect } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const { parseWorldSeeds, pickWorldSeeds, worldSeedInstruction } = require(path.join(ROOT, 'server/lib/worldSeeds'));
const { parseTeachingGuideFile, getAdventureGuide } = require(path.join(ROOT, 'server/lib/promptBuilders'));

const GUIDES = parseTeachingGuideFile(path.join(ROOT, 'prompts', 'adventure-guides.txt'));

describe('parseWorldSeeds', () => {
  it('parses ten centres and ten turns for every adventure world', () => {
    expect(GUIDES.size).toBeGreaterThanOrEqual(30);
    for (const [id, text] of GUIDES) {
      const seeds = parseWorldSeeds(text);
      expect(seeds, `world ${id} has no seed lists`).not.toBeNull();
      expect(seeds.centres.length, `world ${id} centres`).toBe(10);
      expect(seeds.turns.length, `world ${id} turns`).toBe(10);
      for (const line of [...seeds.centres, ...seeds.turns]) {
        expect(line.length).toBeGreaterThan(10);
        expect(line.startsWith('-')).toBe(false);
      }
    }
  });

  it('returns null when a guide carries no lists', () => {
    expect(parseWorldSeeds('COSTUME: none\n\nStory guidance:\n- be nice')).toBeNull();
    expect(parseWorldSeeds('')).toBeNull();
    expect(parseWorldSeeds(null)).toBeNull();
  });
});

describe('pickWorldSeeds', () => {
  const cast = [{ name: 'Noah', age: 3, isMain: true }];
  const input = { theme: 'pirate', characters: cast, topic: '', language: 'de' };

  it('is deterministic for the same seed inputs', () => {
    const a = pickWorldSeeds({ ...input, arm: 0 });
    const b = pickWorldSeeds({ ...input, arm: 0 });
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });

  it('gives the two arms a different centre AND a different turn', () => {
    for (const theme of [...GUIDES.keys()]) {
      for (const cast2 of [cast, [{ name: 'Mia', age: 7, isMain: true }, { name: 'Leo', age: 9, isMain: true }]]) {
        const a = pickWorldSeeds({ theme, characters: cast2, topic: 'x', language: 'de', arm: 0 });
        const b = pickWorldSeeds({ theme, characters: cast2, topic: 'x', language: 'de', arm: 1 });
        expect(a, theme).not.toBeNull();
        expect(a.centre, `${theme} centre`).not.toBe(b.centre);
        expect(a.turn, `${theme} turn`).not.toBe(b.turn);
      }
    }
  });

  it('picks from the named world only', () => {
    const seeds = parseWorldSeeds(getAdventureGuide('pirate'));
    const picked = pickWorldSeeds({ ...input, arm: 1 });
    expect(seeds.centres).toContain(picked.centre);
    expect(seeds.turns).toContain(picked.turn);
  });

  it('is null for a theme with no adventure guide, and injects nothing', () => {
    expect(pickWorldSeeds({ theme: 'realistic-no-such-world', characters: cast, arm: 0 })).toBeNull();
    expect(pickWorldSeeds({ theme: '', characters: cast, arm: 0 })).toBeNull();
    expect(pickWorldSeeds({ characters: cast, arm: 0 })).toBeNull();
    expect(worldSeedInstruction(null)).toBe('');
  });

  it('names the centre and the turn in the instruction', () => {
    const picked = pickWorldSeeds({ ...input, arm: 0 });
    const line = worldSeedInstruction(picked);
    expect(line).toContain(`Centre: ${picked.centre}.`);
    expect(line).toContain(`Turn: ${picked.turn}.`);
  });
});

describe('both idea templates carry the world seed', () => {
  const fs = require('fs');
  const single = fs.readFileSync(path.join(ROOT, 'prompts/generate-story-idea-single.txt'), 'utf-8');
  const pair = fs.readFileSync(path.join(ROOT, 'prompts/generate-story-ideas.txt'), 'utf-8');
  it('single template has {WORLD_SEED}', () => expect(single).toContain('{WORLD_SEED}'));
  it('two-idea template has one per arm', () => {
    expect(pair).toContain('{WORLD_SEED_1}');
    expect(pair).toContain('{WORLD_SEED_2}');
  });
});
