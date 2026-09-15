/**
 * The beats chain inherits the category guidance the unified writer had.
 *
 * `buildUnifiedStoryPrompt` fills a `{CATEGORY_GUIDELINES}` block with six
 * per-category branches. Beats never consumed that prompt, and of its fill keys
 * `CATEGORY_GUIDELINES` was the only one with no other route into the beats
 * chain. Two branches were lost outright (docs/decisions.md, 2026-09-13):
 *
 *   - `swiss-stories` had no `getTeachingGuide` branch at all, so a Swiss local
 *     story reached the arc author with an EMPTY `{STORY_GUIDE_SECTION}` — no
 *     city research, no story idea.
 *   - `historical` kept its guide body but lost the two rules attached to it:
 *     that the facts in the guide are binding, and that the cast wears the
 *     `costumed` variant rather than `standard`.
 *
 * These pin behaviour, not wording: that swiss-stories yields non-empty
 * guidance from the real research source, that both rules reach the stage that
 * needs them (facts → the arc author, clothing → the wardrobe contract), and
 * that the other categories are untouched.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const {
  buildStoryContextFields,
  buildArcCreatePrompt,
  buildStoryBibleFromBeatsPrompt,
  getTeachingGuide,
} = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');
const { getSwissStoriesResponse } = require('../../server/lib/swissStories');

const base = {
  characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'curious' }],
  mainCharacters: ['c1'],
  language: 'en',
  languageLevel: 'medium',
  pages: 8,
};

// A real city id from docs/story-ideas/*.md — never a hand-written one.
const swissCity = getSwissStoriesResponse().cities.find((c: any) => (c.ideas || []).length > 0);
const swissTopic = `${swissCity.id}-1`;

const beats = [{ page: 1, beat: 'the child finds the door' }, { page: 2, beat: 'the door opens' }];

const CASES: Record<string, any> = {
  'life-challenge': { storyCategory: 'life-challenge', storyTopic: 'bath-time' },
  educational: { storyCategory: 'educational', storyTopic: 'alphabet' },
  historical: { storyCategory: 'historical', storyTopic: 'moon-landing' },
  adventure: { storyCategory: 'adventure', storyTheme: 'pirate' },
  'swiss-stories': { storyCategory: 'swiss-stories', storyTopic: swissTopic },
};

const guideFor = (key: string) =>
  String(buildStoryContextFields({ ...base, ...CASES[key] }).STORY_GUIDE_SECTION || '');

beforeAll(async () => {
  await loadPromptTemplates();
});

describe('swiss-stories reaches the beats chain', () => {
  it('yields non-empty guidance', () => {
    expect(guideFor('swiss-stories').length).toBeGreaterThan(0);
  });

  it('carries the real city research, not invented text', () => {
    const { getSwissStoryResearch } = require('../../server/lib/swissStories');
    const research = getSwissStoryResearch(swissCity.id).research;
    expect(research.length).toBeGreaterThan(0);
    // A distinctive slice of the source file must appear verbatim.
    expect(guideFor('swiss-stories')).toContain(research.slice(0, 120));
  });

  it('names the city and the chosen story idea', () => {
    const section = guideFor('swiss-stories');
    const cityName = swissCity.name?.en || swissCity.name || swissCity.id;
    expect(section).toContain(cityName);
    const idea = swissCity.ideas[0];
    const title = typeof idea.title === 'object' ? idea.title.en : idea.title;
    expect(section).toContain(title);
  });

  it('returns null for a city that has no research rather than inventing one', () => {
    expect(getTeachingGuide('swiss-stories', 'not-a-real-city-1')).toBeNull();
  });

  it('reaches the built arc-create prompt', () => {
    const prompt = buildArcCreatePrompt({ ...base, ...CASES['swiss-stories'] }, 8);
    expect(prompt).toBeTruthy();
    expect(prompt).toContain(swissCity.name?.en || swissCity.id);
  });
});

describe('the historical rules reach the beats stage that needs them', () => {
  it('the fact mandate is in the built arc-create prompt', () => {
    const prompt = buildArcCreatePrompt({ ...base, ...CASES.historical }, 8);
    expect(prompt).toMatch(/comes from this guide/i);
    expect(prompt).toMatch(/invent none/i);
  });

  it('the fact mandate sits with the topic guide, ahead of the guide body', () => {
    const section = guideFor('historical');
    expect(section.indexOf('Invent none')).toBeLessThan(section.indexOf('EVENT:'));
  });

  it('the costumed rule is in the built wardrobe contract', () => {
    const prompt = buildStoryBibleFromBeatsPrompt({ ...base, ...CASES.historical }, beats);
    expect(prompt).toBeTruthy();
    expect(prompt).toMatch(/`costumed` variant/);
    expect(prompt).toMatch(/`standard` is not an option/);
  });

  it('swiss-stories gets the same two rules — it is a real place and period too', () => {
    const arc = buildArcCreatePrompt({ ...base, ...CASES['swiss-stories'] }, 8);
    const bible = buildStoryBibleFromBeatsPrompt({ ...base, ...CASES['swiss-stories'] }, beats);
    expect(arc).toMatch(/invent none/i);
    expect(bible).toMatch(/`standard` is not an option/);
  });
});

describe('the other categories are unchanged', () => {
  it.each(['life-challenge', 'educational', 'adventure'])(
    '%s still has a non-empty guide with no era rules attached',
    (key) => {
      const section = guideFor(key);
      expect(section.length).toBeGreaterThan(0);
      expect(section).not.toMatch(/invent none/i);
    },
  );

  it.each(['life-challenge', 'educational', 'adventure'])(
    '%s wardrobe contract carries no era clothing rule',
    (key) => {
      const prompt = buildStoryBibleFromBeatsPrompt({ ...base, ...CASES[key] }, beats);
      expect(prompt).toBeTruthy();
      expect(prompt).not.toMatch(/`standard` is not an option/);
    },
  );

  it('no unfilled placeholder is left in the wardrobe contract', () => {
    for (const key of Object.keys(CASES)) {
      const prompt = buildStoryBibleFromBeatsPrompt({ ...base, ...CASES[key] }, beats);
      expect(prompt).not.toContain('ERA_CLOTHING_RULE');
    }
  });
});
