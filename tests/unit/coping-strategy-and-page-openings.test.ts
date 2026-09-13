/**
 * Two prompt rules the owner restored on 2026-09-14 (docs/decisions.md).
 *
 * 1. The coping-strategy clause. Of the six CATEGORY_GUIDELINES clauses the
 *    beats chain lost, "include practical tips or coping strategies woven into
 *    the narrative" was carried by no other stage. It now lives in
 *    `buildTellingRulesSection`, so it reaches BOTH arc prompts — the arc is
 *    where the story's content is decided, and {TELLING_RULES} is declared in
 *    arc-create.txt and arc-retell.txt alike. It is scoped OFF for the simple
 *    bands, whose life-skill guidelines say "no tips, no strategies, no moral",
 *    and off for every category but life-challenge.
 *
 * 2. The page-opening variety rule, ported from story-text-from-beats.txt to
 *    BOTH unified variants (the default is imageFirst).
 *
 * These pin behaviour, not wording: presence/absence per age band and category,
 * and no unfilled placeholder in any prompt built here.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

// Matched on a fragment, so the clause can be reworded without breaking the test.
const CLAUSE = 'to handle the topic works';
const OPENING = 'Vary how each page begins';

const base = (age: number, extra: any) => ({
  characters: [{ id: 'c1', name: 'Mira', age, gender: 'girl', personality: 'curious' }],
  mainCharacters: ['c1'],
  language: 'en',
  languageLevel: 'medium',
  pages: 8,
  ...extra,
});
const LIFE = { storyCategory: 'life-challenge', storyTopic: 'bath-time' };

const arcPrompts = (input: any) => [
  String(pb.buildArcCreatePrompt(input, 8)),
  String(pb.buildArcRetellPrompt(input, 8, 'ARC 1: something happens.', 'none')),
];
const unfilled = (s: string) => [...new Set(String(s).match(/\{[A-Z_]{3,}\}/g) || [])];

beforeAll(async () => {
  await loadPromptTemplates();
});

describe('coping-strategy clause in the arc rules', () => {
  it('reaches both arc prompts for a life-skill story past the simple bands', () => {
    for (const age of [5, 9]) {
      for (const prompt of arcPrompts(base(age, LIFE))) {
        expect(prompt, `age ${age}`).toContain(CLAUSE);
        expect(unfilled(prompt), `age ${age} unfilled`).toEqual([]);
      }
    }
  });

  it('does not fire for the simple bands, which forbid tips outright', () => {
    for (const age of [0, 1, 2, 3]) {
      expect(pb.resolveAgeBand(base(age, LIFE))).not.toBe('standard');
      for (const prompt of arcPrompts(base(age, LIFE))) {
        expect(prompt, `age ${age}`).not.toContain(CLAUSE);
        expect(unfilled(prompt), `age ${age} unfilled`).toEqual([]);
      }
    }
  });

  it('does not reach adventure or historical stories', () => {
    const others = [
      { storyCategory: 'adventure', storyTheme: 'pirate' },
      { storyCategory: 'historical', storyTopic: 'moon-landing' },
      { storyCategory: 'educational', storyTopic: 'alphabet' },
    ];
    for (const extra of others) {
      for (const prompt of arcPrompts(base(9, extra))) {
        expect(prompt, extra.storyCategory).not.toContain(CLAUSE);
      }
    }
  });
});

describe('page-opening variety rule', () => {
  it('reaches both unified variants, the default one included', () => {
    for (const storyPromptVariant of ['imageFirst', 'textFirst']) {
      const prompt = String(
        pb.buildUnifiedStoryPrompt(
          base(9, { storyCategory: 'adventure', storyTheme: 'pirate', storyPromptVariant }),
          8
        )
      );
      expect(prompt, storyPromptVariant).toContain(OPENING);
      expect(unfilled(prompt), `${storyPromptVariant} unfilled`).toEqual([]);
    }
  });
});
