/**
 * ONE PLACE and INSIDE/OUTSIDE (owner, 2026-09-24; docs/decisions.md).
 *
 * Prod job_1790107559778_fcmlfa8kn: the arc sent a child OUTSIDE to try keys on
 * a door the story placed inside, three panelists passed it, and the Art
 * Director folded that interior door and the building's front door into one
 * outdoor location.
 *
 * Pins BEHAVIOUR: which shared constant reaches which BUILT prompt, and that
 * the generator and its critic read the same string. Never the wording.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const CHARACTERS = [
  { id: 'a', name: 'Anna', age: 7, gender: 'female' },
  { id: 'b', name: 'Ben', age: 5, gender: 'male' },
];
const input: any = {
  language: 'en', languageLevel: '1st-grade', storyCategory: 'adventure', storyTheme: 'dragon',
  storyDetails: 'Two children look for a lost key.', characters: CHARACTERS, mainCharacters: ['a'],
  pages: 4, season: 'autumn', artStyle: 'watercolor',
};
const VB: any = {
  secondaryCharacters: [], animals: [], artifacts: [], vehicles: [], clothing: [],
  locations: [{ id: 'LOC001', label: 'stone house', name: 'stone house', pages: [1], setting: 'indoor, hall', isRealLandmark: false, landmarkQuery: null }],
};
const BEATS = [
  { pageNumber: 1, planLine: 'medium — Anna — she knocks at the front door — nobody answers' },
  { pageNumber: 2, planLine: 'close-up — Anna, Ben — they kneel on the floor by a room door — it is locked' },
];
const unfilled = (p: string) => String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [];

describe('arc: inside/outside is a creator rule the panel and the Lab review check', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the creator, the re-teller, the panel and the arc review read the same string', () => {
    const rule = PB.ARC_PLACE_RULE;
    expect(typeof rule).toBe('string');
    const built = {
      create: PB.buildArcCreatePrompt(input, 12),
      retell: PB.buildArcRetellPrompt(input, 12, 'ARC: a committed arc', 'SOLUTION: one'),
      panel: PB.buildArcPanelPrompt(input, 'ARC: a committed arc'),
      review: PB.buildArcReviewPrompt(input, '1. A story.'),
    };
    for (const [name, p] of Object.entries(built)) {
      expect(String(p), name).toContain(rule);
      expect(unfilled(String(p)), name).toEqual([]);
    }
  });
});

describe('Art Director: what counts as one location', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the all-pages Art Director, the only location author, gets both halves', () => {
    const ad = String(PB.buildSceneExpansionAllPrompt(input, BEATS, {}));
    expect(ad).toContain(PB.PLACE_SEPARATE_RULE);
    expect(ad).toContain(PB.PLACE_INSIDE_OUTSIDE_RULE);
    expect(unfilled(ad)).not.toContain('{PLACE_SEPARATE}');
    expect(unfilled(ad)).not.toContain('{PLACE_INSIDE_OUTSIDE}');
  });

  it('the per-page fallback, which only cites a location, gets the inside/outside half', () => {
    const one = String(PB.buildSceneExpansionPrompt(1, `PLAN: ${BEATS[1].planLine}`, CHARACTERS, 'en', VB, '', null, { story: input }));
    expect(one).toContain(PB.PLACE_INSIDE_OUTSIDE_RULE);
    expect(one).not.toContain(PB.PLACE_SEPARATE_RULE);
    expect(unfilled(one)).not.toContain('{PLACE_INSIDE_OUTSIDE}');
  });
});
