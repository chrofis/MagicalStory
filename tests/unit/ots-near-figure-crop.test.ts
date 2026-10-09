/**
 * THE OVER-THE-SHOULDER NEAR FIGURE IS A CROP, AND NEVER ON A CONTACT PAGE
 * (owner, 2026-09-23).
 *
 * Dragon run 6 p10 (staging job_1790100385959_1nitlympp) declared
 * `over-the-shoulder` and rendered a full figure seen from behind. Three
 * demands for the whole body reached the image model: the brief's `back view`
 * perspective and its directive ("both feet turned away"), the AGE &
 * PROPORTIONS height line, and the full outfit down to the shoes. On top, the
 * near figure pressed a palm on what the shot puts "small and deep in the
 * opposite corner".
 *
 * Pinned: BEHAVIOUR — what the built image prompt carries for a figure whose
 * structured perspective is over-the-shoulder, and that one constant reaches
 * the planner and all four brief-authoring templates. Never prompt wording.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const { log } = require_('../../server/utils/logger');
const {
  OTS_NEAR_FIGURE_CROP, OTS_NO_CONTACT_RULE, OTS_NEAR_FIGURE_RULE, OTS_NEAR_FIGURE_FACING, SHOTS, isOverTheShoulderPerspective,
} = require_('../../server/lib/shotVocabulary');

const CAST = [
  { id: 'c-near', name: 'Levin', age: 4, gender: 'boy', hairColor: 'light blonde' },
  { id: 'c-far', name: 'Mira', age: 8, gender: 'girl', hairColor: 'brown' },
];

const inputData: any = {
  title: 'The Wall',
  characters: CAST,
  mainCharacters: ['c-near'],
  language: 'en',
  pages: 12,
  storyCategory: 'adventure',
  storyType: 'adventure',
  artStyle: 'watercolor',
  relationships: {},
  relationshipTexts: {},
};

const VISUAL_BIBLE: any = { artifacts: [], locations: [], vehicles: [], characters: [], animals: [] };

const brief = (nearPerspective: string) =>
  `Seen past Levin's shoulder, Mira stands small on the far wall and waves.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'Mira waves from the far wall',
    characters: [
      { name: 'Levin', clothing: 'standard', position: 'left foreground', perspective: nearPerspective, depth: 'foreground', looksAt: 'Mira' },
      { name: 'Mira', clothing: 'standard', position: 'right background', depth: 'background', looksAt: 'Levin' },
    ],
    shot: 'over-the-shoulder',
    objects: [],
    textPosition: 'bottom-left',
  })}`;

const REFERENCE_PHOTOS = [
  { name: 'Levin', clothingDescription: 'top: red shirt; bottom: blue jeans; footwear: grey sneakers' },
  { name: 'Mira', clothingDescription: 'top: yellow jumper; bottom: green skirt; footwear: brown boots' },
];

const build = (perspective: string, photos: any = null) =>
  String(PB.buildImagePrompt(brief(perspective), inputData, CAST, VISUAL_BIBLE, 10, photos, {}));

const perspectiveLine = (prompt: string, name: string) =>
  (prompt.split('**Perspective:**')[1] || '').split('\n').find(l => l.startsWith(`- ${name}:`)) || '';

const ageBlock = (prompt: string) => (prompt.split('AGE & PROPORTIONS')[1] || '').split('\n\n')[0];

beforeAll(async () => { await loadPromptTemplates(); });

describe('the over-the-shoulder near figure is drawn as a crop', () => {
  it('reads the structured perspective, with or without a trailing qualifier', () => {
    expect(isOverTheShoulderPerspective('over-the-shoulder')).toBe(true);
    expect(isOverTheShoulderPerspective('Over the shoulder, looking up at the wall')).toBe(true);
    expect(isOverTheShoulderPerspective('back view, glancing over the shoulder toward right shoulder')).toBe(false);
  });

  it('the directive is the crop and never asks for feet, heels or shoes, nor names a back view', () => {
    const line = perspectiveLine(build('over-the-shoulder'), 'Levin');
    expect(line, 'no perspective directive for the near figure').not.toBe('');
    expect(line).toContain(OTS_NEAR_FIGURE_CROP);
    expect(line).not.toMatch(/\b(feet|foot|heels?|toes?|shoes?|sneakers?|boots?|hips?)\b/i);
    expect(line).not.toMatch(/back view/i);
  });

  it('the shot definition itself describes no lower body', () => {
    const def = SHOTS.find((s: any) => s.id === 'over-the-shoulder').definition;
    expect(def).toContain(OTS_NEAR_FIGURE_CROP);
    expect(def).not.toMatch(/\b(feet|foot|heels?|shoes?|back view)\b/i);
    // What they face stays small and deep — the owner kept it (2026-09-23).
    expect(def).toMatch(/small and deep/);
  });

  it('the near figure gets no height line; the far figure keeps hers', () => {
    const ots = ageBlock(build('over-the-shoulder'));
    expect(ots).not.toMatch(/Levin/);
    expect(ots).toMatch(/Mira/);
    // Control: the same page without the crop states both.
    const control = ageBlock(build('back view'));
    expect(control).toMatch(/Levin/);
  });

  it('the near figure drops out of the height order', () => {
    const ots = build('over-the-shoulder');
    const order = (ots.split('**HEIGHT ORDER')[1] || '').split('\n')[0];
    expect(order).not.toMatch(/Levin/);
    const control = (build('back view').split('**HEIGHT ORDER')[1] || '').split('\n')[0];
    expect(control).toMatch(/Levin/);
  });

  it('below-shoulder garments are not demanded of the near figure; the far figure still owes hers', async () => {
    // The outfit check is Jev's (decideOutfitsStated, decisions.md 2026-10-09): the crop shows the
    // upper garment only, so the near figure is asked for the upper garment; the far figure for
    // the whole outfit. Jev is stubbed with an answer that finds both unstated.
    const JD = require_('../../server/lib/jevDecisions');
    const calls: any[] = [];
    const orig = JD.decideOutfitsStated;
    JD.decideOutfitsStated = async (input: any) => { calls.push(input); return { missing: input.figures.map((f: any) => f.name), stated: {}, stats: {} }; };
    const errors: string[] = [];
    const origErr = log.error;
    log.error = (m: any) => { errors.push(String(m)); };
    try {
      build('over-the-shoulder', REFERENCE_PHOTOS);
      await new Promise(r => setTimeout(r, 0));
    } finally {
      log.error = origErr;
      JD.decideOutfitsStated = orig;
    }
    expect(calls).toHaveLength(1);
    const byName = Object.fromEntries(calls[0].figures.map((f: any) => [f.name, f]));
    expect(byName.Levin.upperOnly).toBe(true);
    expect(byName.Mira.upperOnly).toBeFalsy();
    expect(errors.some(e => /dress Levin/.test(e))).toBe(true);
    expect(errors.some(e => /dress Mira/.test(e))).toBe(true);
  });
});

describe('one rule reaches the planner and every brief-authoring template', () => {
  // The planner no longer picks a shot (2026-09-27): the rule rides in the Jev
  // over-the-shoulder question that chooses the shot, and leaves the planner.
  it('the Jev shot question carries the no-contact rule; the planner no longer does', () => {
    const qs = require('../../server/lib/jevDecisions').shotFitQuestions();
    const ots = Object.values(qs).find((q: any) => /over-the-shoulder shot, better/.test(q.instructions)) as any;
    expect(ots.instructions).toContain(OTS_NO_CONTACT_RULE);
    const beats = String(PB.buildBeatsPrompt(inputData, 12, { finalArc: 'An arc.' }));
    expect(beats).not.toContain(OTS_NO_CONTACT_RULE);
    expect(beats).not.toContain('{OTS_NO_CONTACT}');
  });

  it('the no-contact rule allows hands acting outward toward the far subject and bans acts the crop cannot show', () => {
    for (const outward of ['aiming', 'drawing', 'pointing', 'throwing', 'holding something up']) expect(OTS_NO_CONTACT_RULE).toContain(outward);
    for (const hidden of ['own body or clothing', 'hand-over', 'within reach']) expect(OTS_NO_CONTACT_RULE).toContain(hidden);
    expect(OTS_NO_CONTACT_RULE).not.toMatch(/^Over-the-shoulder never goes on a page where the near figure's hands act/);
  });

  it('both Art Director templates carry the near-figure rule, filled', () => {
    const all = String(PB.buildSceneBriefsAllPrompt(inputData, [{ pageNumber: 1, planLine: 'medium — Levin — he waves — he is seen' }], {}));
    const one = String(PB.buildSceneExpansionPrompt(1, 'He waved.', CAST, 'en', VISUAL_BIBLE, '', null, {}));
    for (const [label, p] of [['all-pages', all], ['per-page', one]] as [string, string][]) {
      expect(p, `${label} lost the rule`).toContain(OTS_NEAR_FIGURE_RULE);
      expect(p, `${label} left the slot unfilled`).not.toContain('{OTS_NEAR_FIGURE}');
    }
    expect(OTS_NEAR_FIGURE_RULE).toContain(OTS_NO_CONTACT_RULE);
  });

  it('both iterate templates carry the near-figure rule, filled', () => {
    for (const freeIterate of [false, true]) {
      const p = String(PB.buildSceneDescriptionPrompt(
        1, 'He waved.', CAST, 'draft', 'en', VISUAL_BIBLE, [], {}, '', '', null, null, { freeIterate }));
      expect(p, `iterate (free=${freeIterate}) lost the rule`).toContain(OTS_NEAR_FIGURE_RULE);
      expect(p).not.toContain('{OTS_NEAR_FIGURE}');
    }
  });
});

describe('the camera is BEHIND the near figure, not beside it (Lab 1419 rendered a profile)', () => {
  it('the crop says the face is turned away from the camera', () => {
    expect(OTS_NEAR_FIGURE_CROP).toMatch(/back of their head/);
    expect(OTS_NEAR_FIGURE_CROP).toMatch(/face is turned away/);
  });

  it('the near figure looks straight ahead, never up at the subject', () => {
    expect(OTS_NEAR_FIGURE_RULE).toMatch(/straight ahead/);
  });

  it('the subject is placed far off, not beside the near figure', () => {
    const ots = SHOTS.find((s: { id: string }) => s.id === 'over-the-shoulder');
    expect(ots.definition).toMatch(/far across the frame/);
  });
});

// OWNER 2026-09-28 (staging job_1790539784661_6mjcny1c7 p12): the brief made
// the figure turning AWAY from the other the near crop. One sentence says which
// figure stands nearest the camera, in the definition (illustrator + the Jev fit
// question), the Art Director / iterate rule and the built prompts.
describe('the near figure is the one looking toward the far figure', () => {
  it('one sentence rides in the shot definition, the Jev question and the Art Director rule', () => {
    const ots = SHOTS.find((s: { id: string }) => s.id === 'over-the-shoulder');
    expect(ots.definition).toContain(OTS_NEAR_FIGURE_FACING);
    expect(OTS_NEAR_FIGURE_RULE).toContain(OTS_NEAR_FIGURE_FACING);
    const qs = require('../../server/lib/jevDecisions').shotFitQuestions();
    const q = Object.values(qs).find((x: any) => /over-the-shoulder shot, better/.test(x.instructions)) as any;
    expect(q.instructions).toContain(OTS_NEAR_FIGURE_FACING);
    expect(OTS_NEAR_FIGURE_FACING).toMatch(/never a figure turning away/);
  });

  it('reaches both Art Director templates and both iterate templates, built', () => {
    const all = String(PB.buildSceneBriefsAllPrompt(inputData, [{ pageNumber: 1, planLine: 'medium — Levin — he waves — he is seen' }], {}));
    const one = String(PB.buildSceneExpansionPrompt(1, 'He waved.', CAST, 'en', VISUAL_BIBLE, '', null, {}));
    expect(all).toContain(OTS_NEAR_FIGURE_FACING);
    expect(one).toContain(OTS_NEAR_FIGURE_FACING);
    for (const freeIterate of [false, true]) {
      const p = String(PB.buildSceneDescriptionPrompt(
        1, 'He waved.', CAST, 'draft', 'en', VISUAL_BIBLE, [], {}, '', '', null, null, { freeIterate }));
      expect(p).toContain(OTS_NEAR_FIGURE_FACING);
    }
  });
});
