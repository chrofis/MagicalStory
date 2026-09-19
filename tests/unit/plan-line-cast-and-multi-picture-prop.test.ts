/**
 * The plan line is the cast authority, and a prop that shows two pictures needs
 * two face states.
 *
 * Staging job_1789506283204_3kxqshifx surfaced two escapes of the same shape —
 * a rule stated for one channel while the fault arrived through another:
 *
 *   - p3: a tracked animal reached the frame six pages before any plan line
 *     named it. Art Director rule 3 governed "characters"; the animal entered
 *     through its Visual Bible entry's `pages`, then `objects[]` and the prose.
 *     The reviewer's 5a, reading `characters[]` only, reported nothing.
 *   - p5: the object carried a single face-to-camera state whose `delta` was
 *     the picture a LATER plan line calls for. The page cited that state, and
 *     what the page showed overrode its own plan line.
 *
 * The fix is two JS constants reaching the two Art Director templates AND the
 * scene review through one placeholder each — generator and critic given the
 * same contract. What is pinned here is ARRIVAL and SAMENESS (all three built
 * prompts carry the identical string, no placeholder survives), never the
 * prompt's wording: reword the rules freely, they may not stop arriving.
 *
 * Offline and free: nothing here calls a paid API.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const CHARACTERS = [
  { id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'stubborn', hairColor: 'brown' },
  { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', personality: 'shy', hairColor: 'black' },
];

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: CHARACTERS,
  mainCharacters: ['c1'],
  language: 'en',
  languageLevel: 'medium',
  pages: 4,
  storyCategory: 'adventure',
  storyType: 'adventure',
  storyDetails: 'A night at the salt-bleached timber pier.',
  artStyle: 'watercolor',
  relationships: { 'c1-c2': 'Sister of' },
  relationshipTexts: {},
};

const BEATS = [
  { pageNumber: 1, planLine: 'wide — the main character on the pier — she lifts the lantern — the lamp is lit' },
  { pageNumber: 2, planLine: 'close — the main character — she cups the flame — the flame holds' },
];

const SCENES = [
  { pageNumber: 1, brief: 'The main character stands on the pier, lifting a brass lantern.' },
  { pageNumber: 2, brief: 'The main character kneels beside the lamp housing.' },
];

const VISUAL_BIBLE: any = {
  artifacts: [{ id: 'ART001', name: 'brass lantern', description: 'a dented brass lantern with a cracked green pane', pages: [1, 2] }],
  locations: [],
  vehicles: [],
  characters: [],
};

const unfilled = (p: string) => [...new Set(String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

describe('the plan-line cast rule and the multi-picture prop rule each reach every site from ONE constant', () => {
  let built: Record<string, string>;

  beforeAll(async () => {
    await loadPromptTemplates();
    built = {
      'all-pages Art Director': PB.buildSceneExpansionAllPrompt(inputData, BEATS, {}),
      'per-page Art Director': PB.buildSceneExpansionPrompt(
        1, 'The lamp guttered twice and then went out.', CHARACTERS, 'en', VISUAL_BIBLE, '', null, {}),
      'scene review': PB.buildSceneReviewPrompt(inputData, SCENES, { beats: BEATS, visualBible: VISUAL_BIBLE }),
    };
  });

  it('exports both constants as non-empty strings', () => {
    expect(typeof PB.PLAN_LINE_CAST_RULE, 'PLAN_LINE_CAST_RULE is not exported').toBe('string');
    expect(typeof PB.MULTI_PICTURE_PROP_RULE, 'MULTI_PICTURE_PROP_RULE is not exported').toBe('string');
    expect(PB.PLAN_LINE_CAST_RULE.length).toBeGreaterThan(40);
    expect(PB.MULTI_PICTURE_PROP_RULE.length).toBeGreaterThan(40);
  });

  it('both Art Director prompts and the scene review carry the cast rule, from that one constant', () => {
    for (const [site, prompt] of Object.entries(built)) {
      expect(prompt.includes(PB.PLAN_LINE_CAST_RULE), `${site} lost the plan-line cast rule`).toBe(true);
    }
  });

  it('both Art Director prompts and the scene review carry the multi-picture prop rule, from that one constant', () => {
    for (const [site, prompt] of Object.entries(built)) {
      expect(prompt.includes(PB.MULTI_PICTURE_PROP_RULE), `${site} lost the multi-picture prop rule`).toBe(true);
    }
  });

  it('no placeholder token survives in any of the three built prompts', () => {
    for (const [site, prompt] of Object.entries(built)) {
      expect(unfilled(prompt), `${site} shipped an unfilled placeholder`).toEqual([]);
      expect(prompt).not.toContain('{PLAN_LINE_CAST}');
      expect(prompt).not.toContain('{MULTI_PICTURE_PROP}');
    }
  });

  it('the all-pages Art Director ties a tracked entry\u2019s pages to the plan line', () => {
    const all = built['all-pages Art Director'];
    const earned = String(all).split('\n').find((l) => l.includes('`pages` is earned')) || '';
    expect(earned, 'the pages-is-earned rule is gone').not.toBe('');
    expect(earned, 'the pages-is-earned rule no longer names the plan line as the authority for a tracked entry')
      .toMatch(/plan line names it/i);
  });
});
