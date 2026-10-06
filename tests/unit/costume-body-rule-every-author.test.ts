/**
 * A COSTUME'S BODY REACHES EVERY BRIEF AUTHOR (owner, 2026-10-06).
 *
 * The covering-top / one-tail / no-feet rule (722a0a15f) went to the wardrobe writer and reviewer,
 * the trial costume and the sheet judge, but not to the Art Director or the iterate rewriters, and
 * the p3 iterate rewrite of staging job_1791267520938_essbvehs8 wrote "her bare feet on wet sand"
 * into a mermaid's brief. ONE constant (promptBuilders.COSTUME_BODY_RULE) is filled into both Art
 * Director templates, both iterate templates and the provider-blocked rewrite. Offline and free;
 * pins that the constant reaches each built prompt, never its wording.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders');
const { loadPromptTemplates, PROMPT_TEMPLATES, fillTemplate } = require_('../../server/services/prompts');

const inputData: any = {
  title: 'Mermaid', characters: [{ id: 'c0', name: 'Emma', age: 5, gender: 'girl' }, { id: 'c1', name: 'Hans', age: 70, gender: 'man' }],
  mainCharacters: ['c0'], language: 'en', languageLevel: 'medium', pages: 4,
  storyCategory: 'adventure', storyType: 'adventure', storyDetails: 'x', artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
};
const BEATS = [{ pageNumber: 1, planLine: 'medium — Emma, Hans — x — y' }];
const VB: any = { artifacts: [], locations: [], vehicles: [], animals: [], secondaryCharacters: [], clothing: [] };

describe('one costume-body constant reaches every site that rewrites a page brief', () => {
  let built: Record<string, string>;
  beforeAll(async () => {
    await loadPromptTemplates();
    built = {
      'AD all-pages': String(PB.buildSceneBriefsAllPrompt(inputData, BEATS, { jevBackup: true })),
      'AD per-page': String(PB.buildSceneExpansionPrompt(1, 'page text', inputData.characters, 'en', VB, '', null, { jevBackup: true })),
      'iterate strict': String(PB.buildSceneDescriptionPrompt(1, 'page text', inputData.characters, '', 'en', VB, [], 'standard', '', '',
        { planLine: BEATS[0].planLine }, { fixIssues: ['x'] }, { freeIterate: false })),
      'iterate free': String(PB.buildSceneDescriptionPrompt(1, 'page text', inputData.characters, '', 'en', VB, [], 'standard', '', '',
        { planLine: BEATS[0].planLine }, { fixIssues: ['x'] }, { freeIterate: true })),
      'blocked-scene rewrite': fillTemplate(PROMPT_TEMPLATES.rewriteBlockedScene, { SCENE_DESCRIPTION: 'Emma swims.', COSTUME_BODY: PB.COSTUME_BODY_RULE }),
    };
  });

  it('every built prompt carries the rule and no unfilled placeholder', () => {
    expect(typeof PB.COSTUME_BODY_RULE).toBe('string');
    for (const [site, prompt] of Object.entries(built)) {
      expect(prompt.includes(PB.COSTUME_BODY_RULE), `${site} lacks the costume rule`).toBe(true);
      expect(prompt.includes('{COSTUME_BODY}'), `${site} ships the placeholder`).toBe(false);
    }
  });
});
