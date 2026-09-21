import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
const { loadPatternSeeds, pickPatternSeeds, patternSeedInstruction } = require_('../../server/lib/patternSeeds');
const { worldSeedInstruction } = require_('../../server/lib/worldSeeds');

const ROOT = path.join(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const cast = (...ages: Array<[string, number, boolean?]>) =>
  ages.map(([name, age, isMain]) => ({ name, age, isMain: isMain !== false }));

describe('pattern-seeds.txt', () => {
  it('parses ten seeds, every one of the six fields non-empty', () => {
    const seeds = loadPatternSeeds();
    expect(seeds).toHaveLength(10);
    for (const s of seeds) {
      expect(Number.isFinite(s.id)).toBe(true);
      for (const f of ['name', 'pattern', 'variation', 'resists', 'refrain']) {
        expect(typeof s[f]).toBe('string');
        expect(s[f].length).toBeGreaterThan(0);
      }
    }
    expect(new Set(seeds.map((s: any) => s.id)).size).toBe(10);
    expect(new Set(seeds.map((s: any) => s.name)).size).toBe(10);
  });

  it('is world-neutral: no seed names a world, a place or a creature the world seed supplies', () => {
    for (const s of loadPatternSeeds()) {
      const text = `${s.name} ${s.pattern} ${s.variation} ${s.resists}`.toLowerCase();
      for (const word of ['farm', 'pony', 'goat', 'duck', 'castle', 'pirate', 'dragon', 'fence']) {
        expect(text).not.toContain(word);
      }
    }
  });
});

describe('pickPatternSeeds', () => {
  it('gives the two arms different seeds, for every topic', () => {
    for (const topic of ['going-outside', 'first-words', 'bedtime', 'sharing', 'making-friends', 'managing-emotions']) {
      const [a, b] = pickPatternSeeds({ characters: cast(['Lena', 1]), storyTopic: topic });
      expect(a.id).not.toBe(b.id);
    }
  });

  it('is deterministic for one cast and varies across casts', () => {
    const one = { characters: cast(['Lena', 1]), storyTopic: 'going-outside', storyTheme: 'farm', language: 'de' };
    expect(pickPatternSeeds(one).map((s: any) => s.id)).toEqual(pickPatternSeeds(one).map((s: any) => s.id));
    const other = { ...one, characters: cast(['Emil', 2]) };
    expect(pickPatternSeeds(other)[0].id).not.toBe(pickPatternSeeds(one)[0].id);
  });

  it('the instruction names the pattern, the variation, the one that resists and the refrain', () => {
    const [a] = pickPatternSeeds({ characters: cast(['Lena', 1]), storyTopic: 'going-outside' });
    const line = patternSeedInstruction(a);
    expect(line).toContain(`This book's pattern: ${a.name} — ${a.pattern}`);
    expect(line).toContain(`What changes: ${a.variation}`);
    expect(line).toContain(`The one that resists: ${a.resists}`);
    expect(line).toContain(`Refrain shape: ${a.refrain}`);
  });

  it('is empty for a cast that is not on the pattern contract', () => {
    expect(patternSeedInstruction(null)).toBe('');
  });
});

describe('the world seed on the pattern contract', () => {
  const seeds = { centre: 'A crab who will not be put back', turn: 'x' };

  it('never tells a toddler book to build a want or an obstacle', () => {
    const line = worldSeedInstruction(seeds, { pages: 10, pattern: true });
    expect(line).toBe('Someone in this book: A crab who will not be put back. They are the one that answers, or the one that resists.');
    expect(line).not.toContain('Build the want');
    expect(line).not.toContain('strange thing');
  });

  it('is unchanged for every other cast', () => {
    expect(worldSeedInstruction(seeds, { pages: 10 }))
      .toBe('Someone in this idea: A crab who will not be put back. Build the want or the obstacle on them. This is the only strange thing in the idea.');
    expect(worldSeedInstruction(seeds, { pages: 16 }))
      .toBe('Someone in this idea: A crab who will not be put back. Build the want or the obstacle on them.');
  });
});

describe('the templates carry the pattern seed in the premise-shape slot', () => {
  it('both siblings hold the placeholder on the same line as the shape, exactly once', () => {
    const single = read('prompts/generate-story-idea-single.txt');
    expect(single.match(/\{PREMISE_SHAPE\}\{PATTERN_SEED\}/g)).toHaveLength(1);
    const pair = read('prompts/generate-story-ideas.txt');
    expect(pair.match(/\{PREMISE_SHAPE_1\}\{PATTERN_SEED_1\}/g)).toHaveLength(1);
    expect(pair.match(/\{PREMISE_SHAPE_2\}\{PATTERN_SEED_2\}/g)).toHaveLength(1);
  });

  it('neither sibling still carries the toddler worked example', () => {
    for (const p of ['prompts/generate-story-idea-single.txt', 'prompts/generate-story-ideas.txt']) {
      const t = read(p);
      expect(t).not.toContain('walks along the fence');
      expect(t).not.toContain('the pattern shape');
    }
  });

  it('the three premise examples are still there for ages three and up', () => {
    const single = read('prompts/generate-story-idea-single.txt');
    for (const n of [1, 2, 3]) expect(single).toContain(`Example ${n}:`);
    expect(single).not.toContain('Example 4');
  });
});

describe('buildIdeasPromptContext on the two contracts', () => {
  const { buildIdeasPromptContext } = require_('../../server/routes/storyIdeas');
  const base = {
    storyCategory: 'life-challenge', storyTopic: 'going-outside', storyTheme: 'farm',
    language: 'de', languageLevel: '1st-grade', relationships: [], pages: 10,
  };

  it('a main aged two or under gets no premise shape, the pattern wording and a pattern seed', async () => {
    const ctx = await buildIdeasPromptContext({ ...base, characters: cast(['Lena', 1]) });
    expect(ctx.isPattern).toBe(true);
    expect(ctx.premiseShapeLines).toEqual(['', '']);
    for (const line of ctx.worldSeedLines) {
      expect(line).toContain('They are the one that answers, or the one that resists.');
      expect(line).not.toContain('Build the want or the obstacle');
    }
    expect(ctx.patternSeedLines[0]).toContain("This book's pattern:");
    expect(ctx.patternSeedLines[1]).toContain("This book's pattern:");
    expect(ctx.patternSeeds[0].id).not.toBe(ctx.patternSeeds[1].id);
  }, 120000);

  it('a main aged three keeps the premise shape and gets no pattern seed', async () => {
    const ctx = await buildIdeasPromptContext({ ...base, characters: cast(['Mia', 3]) });
    expect(ctx.isPattern).toBe(false);
    for (const line of ctx.premiseShapeLines) expect(line).toContain('Keep the shape');
    expect(ctx.patternSeedLines).toEqual(['', '']);
    for (const line of ctx.worldSeedLines) expect(line).toContain('Build the want or the obstacle');
  }, 120000);
});

describe('round 24 — the seed is the mechanism, the topic is what the child does inside it', () => {
  const { loadPatternSeeds } = require(path.join(ROOT, 'server/lib/patternSeeds'));
  const { IDEA_CONTRACT_PATTERN } = require(path.join(ROOT, 'server/lib/ideaContract'));
  const { getIdeaGuide } = require(path.join(ROOT, 'server/lib/promptBuilders'));

  // shared/topic-age-windows.json — the complete 0-2 set. A new one here means
  // a new [[idea]] block with its own "inside the pattern" line.
  const BABY_TOPICS = ['bath-time', 'first-foods', 'first-steps', 'first-words', 'going-outside'];

  it('the contract ranks the seed against the topic', () => {
    expect(IDEA_CONTRACT_PATTERN).toContain(
      'The pattern seed sets the mechanism of the book; the topic sets what the child does inside it; keep both.');
  });

  it('every 0-2 topic guide carries an idea block that says so', () => {
    for (const topic of BABY_TOPICS) {
      const guide = getIdeaGuide('life-challenge', topic);
      expect(guide, topic).toContain('**Inside the pattern.**');
      expect(guide, topic).toContain("The book's pattern comes from the pattern seed");
      expect(guide, topic).toContain("The topic sets only what the child does inside it");
      expect(guide, topic).toContain("The child's part");
      // The block is the idea view, not the whole book brief.
      expect(guide, topic).not.toContain('**What happens.**');
      expect(guide, topic).not.toContain('**Ending.**');
    }
  });

  it('first-words and going-outside name their own line', () => {
    expect(getIdeaGuide('life-challenge', 'first-words')).toContain('the child gives the word');
    expect(getIdeaGuide('life-challenge', 'going-outside')).toContain('the child takes each step out');
  });

  it('no seed variation is an enumeration the model can translate', () => {
    for (const seed of loadPatternSeeds()) {
      // Round 23: an arm copied seed 3's own list (boots, sleeve, button) into
      // the idea. A variation names the KIND of change; a list has commas or
      // a colon introducing one.
      expect(seed.variation, `seed ${seed.id}`).not.toContain(':');
      expect((seed.variation.match(/,/g) || []).length, `seed ${seed.id} reads as a list`).toBeLessThanOrEqual(1);
      expect(seed.variation.split(' ').length, `seed ${seed.id}`).toBeLessThanOrEqual(16);
    }
  });
});

