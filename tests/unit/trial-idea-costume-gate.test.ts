import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  TRIAL_COSTUMES,
  getTrialCostume,
  resolveTrialCostumeLookup,
  getTrialCostumeForStory,
} = require('../../server/config/trialCostumes.js');
const { buildTrialIdeaCostumeInstructions, buildTrialStoryPrompt } = require('../../server/lib/promptBuilders.js');
const { PROMPT_TEMPLATES, fillTemplate, loadPromptTemplates } = require('../../server/services/prompts.js');

// Evidence: prod job_1788698812047_q5b1vuds7 — a trial on theme "mothers-day"
// whose accepted premise had the child put a straw costume ON, while
// TRIAL_COSTUMES.adventure has no mothers-day entry, so no costumed avatar
// sheet was ever generated and the garment could only be painted as scenery.

describe('trial costume lookup — one resolver for every consumer', () => {
  it('adventure reads the theme, historical reads the topic, life-challenge reads the theme', () => {
    expect(resolveTrialCostumeLookup({ storyCategory: 'adventure', storyTheme: 'pirate', storyTopic: '' }))
      .toEqual({ topic: 'pirate', category: 'adventure' });
    expect(resolveTrialCostumeLookup({ storyCategory: 'life-challenge', storyTheme: 'pirate', storyTopic: 'cleaning-up' }))
      .toEqual({ topic: 'pirate', category: 'adventure' });
    expect(resolveTrialCostumeLookup({ storyCategory: 'historical', storyTheme: '', storyTopic: 'moon-landing' }))
      .toEqual({ topic: 'moon-landing', category: 'historical' });
  });

  it('falls back to the topic when no theme is set, and tolerates missing inputs', () => {
    expect(resolveTrialCostumeLookup({ storyCategory: 'adventure', storyTopic: 'pirate' }).topic).toBe('pirate');
    expect(resolveTrialCostumeLookup()).toEqual({ topic: '', category: 'adventure' });
  });

  it('agrees with the raw getTrialCostume table lookup', () => {
    const inputs = { storyCategory: 'adventure', storyTheme: 'pirate', storyTopic: '', gender: 'female' };
    expect(getTrialCostumeForStory(inputs)).toEqual(getTrialCostume('pirate', 'adventure', 'female'));
    expect(getTrialCostumeForStory({ storyCategory: 'historical', storyTopic: 'moon-landing', gender: 'male' }))
      .toEqual(getTrialCostume('moon-landing', 'historical', 'male'));
  });

  it('returns null for the themes the costume table has no entry for', () => {
    for (const theme of ['mothers-day', 'fathers-day', 'custom']) {
      expect(getTrialCostumeForStory({ storyCategory: 'adventure', storyTheme: theme, gender: 'male' })).toBeNull();
      expect(TRIAL_COSTUMES.adventure[theme]).toBeUndefined();
    }
  });
});

describe('buildTrialIdeaCostumeInstructions', () => {
  const withCostume = buildTrialIdeaCostumeInstructions({ costumeType: 'pirate', description: 'x' });
  const without = buildTrialIdeaCostumeInstructions(null);

  it('leaves the costume-available branch at its pre-gate wording', () => {
    expect(withCostume.costumeRule).toBe('');
    expect(withCostume.themeShows).toBe('A costume or theme shows in what they wear and how they play');
    expect(withCostume.fantasyOpening).toBe('dressing up, or starting to play');
  });

  it('forbids a worn costume and keeps a costume as scenery when there is none', () => {
    expect(without.costumeRule).toMatch(/puts on, changes into or wears a costume/);
    expect(without.costumeRule).toMatch(/appear as an object in the scene/);
    expect(without.themeShows).not.toMatch(/wear/);
    expect(without.fantasyOpening).not.toMatch(/dressing up/);
  });

  it('stays generic — no story-specific names, places or plot', () => {
    const text = Object.values(without).join(' ') + Object.values(withCostume).join(' ');
    expect(text).not.toMatch(/Amian|Stroh|straw|museum|Mama/i);
    expect(text).not.toMatch(/CRITICAL|MUST NOT|LOCKED/);
  });
});

describe('trial-idea template', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('carries the costume placeholder', () => {
    expect(PROMPT_TEMPLATES.trialIdea).toContain('{COSTUME_RULE}');
  });

  it('renders byte-identically to the pre-gate template when a costume exists', () => {
    const fills: Record<string, string> = {
      CHARACTER: 'the main character, 5 years old',
      CATEGORY_CONTEXT: 'context',
      TITLE: 'title',
      LANDMARKS: '',
      LANG_INSTRUCTION: 'lang',
      AGE_MODE: 'age',
    };
    const gated = fillTemplate(PROMPT_TEMPLATES.trialIdea, {
      ...fills,
      COSTUME_RULE: buildTrialIdeaCostumeInstructions({ costumeType: 'pirate', description: 'x' }).costumeRule,
    });
    const legacy = fillTemplate(PROMPT_TEMPLATES.trialIdea.replace('{COSTUME_RULE}', ''), fills);
    expect(gated).toBe(legacy);
  });

  it('appends the rule inline, adding no blank line, when there is no costume', () => {
    const rendered = fillTemplate(PROMPT_TEMPLATES.trialIdea, {
      CHARACTER: 'c', CATEGORY_CONTEXT: 'c', TITLE: 't', LANDMARKS: '',
      LANG_INSTRUCTION: 'l', AGE_MODE: 'a',
      COSTUME_RULE: buildTrialIdeaCostumeInstructions(null).costumeRule,
    });
    const line = rendered.split('\n').find(l => l.includes('puts on, changes into or wears'));
    expect(line).toBeTruthy();
    expect(line).toContain('Center the idea on the main character');
  });
});

describe('buildTrialStoryPrompt resolves the costume the same way', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const inputs = (extra: Record<string, unknown>) => ({
    characters: [{ name: 'Main', age: 5, gender: 'male' }],
    pageCount: 6,
    language: 'de-ch',
    ...extra,
  });

  it('keeps the costume branch on a life-challenge trial, where the theme carries the costume', () => {
    const prompt = buildTrialStoryPrompt(inputs({
      storyCategory: 'life-challenge', storyTopic: 'understanding-rules', storyTheme: 'cowboy',
    }));
    expect(prompt).toContain('[standard | costumed]');
  });

  it('drops it on an adventure theme with no costume entry', () => {
    const prompt = buildTrialStoryPrompt(inputs({
      storyCategory: 'adventure', storyTopic: '', storyTheme: 'mothers-day',
    }));
    expect(prompt).not.toContain('[standard | costumed]');
  });
});
