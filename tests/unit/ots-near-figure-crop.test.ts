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
  OTS_NEAR_FIGURE_CROP, OTS_NO_CONTACT_RULE, OTS_NEAR_FIGURE_RULE, SHOTS, isOverTheShoulderPerspective,
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

  it('below-shoulder garments are not demanded of the near figure; the far figure still owes hers', () => {
    const errors: string[] = [];
    const orig = log.error;
    log.error = (m: any) => { errors.push(String(m)); };
    try {
      build('over-the-shoulder', REFERENCE_PHOTOS);
    } finally {
      log.error = orig;
    }
    const levin = errors.filter(e => /dress Levin/.test(e)).join(' ');
    // The prose names no red shirt either, so `top` is still owed — the crop
    // shows the upper garment. Trousers and shoes are not.
    expect(levin).toMatch(/\btop\b/);
    expect(levin).not.toMatch(/\bbottom\b|\bfootwear\b/);
    const mira = errors.filter(e => /dress Mira/.test(e)).join(' ');
    expect(mira).toMatch(/footwear/);
  });
});

describe('one rule reaches the planner and every brief-authoring template', () => {
  it('story-beats carries the no-contact rule, filled', () => {
    const beats = String(PB.buildBeatsPrompt(inputData, 12, { finalArc: 'An arc.' }));
    expect(beats).toContain(OTS_NO_CONTACT_RULE);
    expect(beats).not.toContain('{OTS_NO_CONTACT}');
  });

  it('both Art Director templates carry the near-figure rule, filled', () => {
    const all = String(PB.buildSceneExpansionAllPrompt(inputData, [{ pageNumber: 1, planLine: 'medium — Levin — he waves — he is seen' }], {}));
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
