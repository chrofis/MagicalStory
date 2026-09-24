/**
 * IMAGE PROMPTS SAY EACH THING ONCE, AND THE CUT ORDER IS ONE LIST (owner, 2026-09-24).
 *
 * Staging job_1790100385959_1nitlympp: every four-character render sat at or
 * over the ~10,010-char line above which the 7,900-char Grok cap cost REQUIRED
 * CAST, and the front cover crossed it (10,129 built). Most of the overshoot was
 * repetition: two ground rules, a bare name list, the age three times per child,
 * "eyes on the viewer" per figure, a "2 hands" bullet beside the HANDS anchor,
 * and two rules built on covers that cannot apply there (facing, COUNTS).
 *
 * These pin the behaviour: the repetition is not built, each rule a judge
 * checks is still built once, and the shrinker cuts in PROMPT_CUT_ORDER and
 * says so in its log.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PB = require('../../server/lib/promptBuilders.js');
const CI = require('../../server/lib/coverIterate.js');
const GL = require('../../server/lib/generationLogger.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
// @ts-expect-error - JS module without types
import { shrinkPromptForModel, PROMPT_CUT_ORDER, PROMPT_NEVER_CUT } from '../../server/lib/images.js';

const chars: any[] = [
  { id: 'c1', name: 'Mira', age: 5, gender: 'female', apparentAge: 'preschooler', height: 110, physical: { build: 'average', hairColor: 'brown' } },
  { id: 'c2', name: 'Theo', age: 8, gender: 'male', apparentAge: 'school-age', height: 128, physical: { build: 'stocky', hairColor: 'red' } },
];
const inputData: any = {
  title: 'The Lamp on the Pier', characters: chars, mainCharacters: ['c1', 'c2'],
  language: 'en', pages: 4, storyCategory: 'adventure', artStyle: 'watercolor',
};
const photos = chars.map(c => ({ name: c.name, clothingDescription: 'a blue raincoat and yellow boots' }));
const bible: any = { artifacts: [], locations: [], vehicles: [], characters: [], animals: [], clothing: [] };
const hint: any = {
  mood: 'bright harbour morning',
  objects: [],
  characterDetails: {
    Mira: { name: 'Mira', position: 'center left', holds: 'nothing', priority: 'essential' },
    Theo: { name: 'Theo', position: 'center right', holds: 'nothing', priority: 'essential' },
  },
};

const coverPrompt = (key: 'front' | 'back') => String(PB.buildCoverPrompt(key, {
  sceneDescription: CI.buildCoverSceneFromHint(hint, bible, chars, { language: 'en' }),
  inputData, characters: chars, visualBible: bible, referencePhotos: photos,
  options: {
    characterReferenceListOverride: PB.buildCharacterReferenceList(photos, chars, { includeClothing: true }),
    bakeTitle: key === 'front' ? inputData.title : '',
  },
}));
const brief = `The main character kneels on the pier.\n\n---METADATA---\n${JSON.stringify({
  sceneIntent: 'the lamp is lit', characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
  shot: 'wide', objects: [], textPosition: 'bottom-left',
})}`;
const pagePrompt = () => String(PB.buildImagePrompt(brief, inputData, [chars[0]], bible, 1, [photos[0]], {}));

beforeAll(async () => { await loadPromptTemplates(); });

describe('a cover does not build what cannot apply to it', () => {
  it('no facing bullet and no COUNTS on any cover; the ground and size bullets stay', () => {
    for (const key of ['front', 'back'] as const) {
      const p = coverPrompt(key);
      expect(p, key).not.toContain(PB.COMPOSITION_FACING_BULLET);
      expect(p, key).not.toContain('**COUNTS:**');
      expect(p, key).toContain(PB.COMPOSITION_GROUND_BULLET);
      expect(p, key).toContain(PB.COMPOSITION_SIZE_BULLET);
    }
  });

  it('a page keeps all three Composition bullets and COUNTS', () => {
    const p = pagePrompt();
    expect(p).toContain(PB.buildCompositionBlock());
    expect(p).toContain(PB.COUNTS_RULE);
  });
});

describe('each rule is said once', () => {
  it('one ground rule on a cover — the shared bullet, no cover copy', () => {
    const p = coverPrompt('front');
    expect(p).not.toMatch(/stand on the one ground they share/);
    expect(p.split('drawn complete down to both feet').length - 1).toBe(1);
  });

  it('no "2 hands" cover bullet beside the HANDS anchor, no ALL MAIN CHARACTERS bullet beside REQUIRED CAST', () => {
    for (const key of ['front', 'back'] as const) {
      const p = coverPrompt(key);
      expect(p, key).not.toMatch(/has 2 hands/);
      expect(p, key).not.toMatch(/ALL MAIN CHARACTERS/);
      expect(p, key).toContain(PB.HANDS_HOLD_ONLY_NAMED_RULE);
      expect(p, key).toContain('**REQUIRED CAST:** Every named character');
    }
  });

  it('no bare [Name] list; every name is in the character lines', () => {
    const list = PB.buildCharacterReferenceList(photos, chars, { includeClothing: true });
    expect(list).not.toContain('CHARACTER REFERENCE PHOTOS');
    expect(list).not.toMatch(/\[Mira\]/);
    expect(list).toMatch(/^- Mira is a /m);
    expect(list).toMatch(/^- Theo is a /m);
  });

  it('a character line states the age once, no centimetres, no midpoint build', () => {
    const mira = PB.buildCharacterPhysicalDescription(chars[0]);
    const theo = PB.buildCharacterPhysicalDescription(chars[1]);
    expect(mira).not.toMatch(/Looks:/);
    expect(mira).not.toMatch(/cm tall/);
    expect(mira).not.toMatch(/average build/);
    expect(theo, 'a non-midpoint build is a real trait and stays').toMatch(/stocky build/);
  });

  it('cover prose: no age noun per figure, the gaze stated once', () => {
    const prose = CI.buildCoverSceneFromHint(hint, bible, chars, { language: 'en' });
    expect(prose).toContain('Mira stands in the center left.');
    expect(prose).not.toMatch(/Mira, a /);
    expect(prose).not.toMatch(/eyes on the viewer/);
    expect(prose.split('looks at the viewer').length - 1).toBe(1);
    const solo = CI.buildCoverSceneFromHint({ ...hint, characterDetails: { Mira: hint.characterDetails.Mira } }, bible, chars, {});
    expect(solo).toContain('Mira looks at the viewer.');
  });

  it('the empty cover plate never carries the group gaze sentence', () => {
    const prose = CI.buildCoverSceneFromHint(hint, bible, chars, { language: 'en' });
    const plate = CI.buildPlateDescription(prose, ['Mira', 'Theo'], bible, -1);
    expect(plate).not.toMatch(/looks at the viewer/);
    expect(plate).not.toMatch(/Mira|Theo/);
  });

  it('the settled baked title block is unchanged', () => {
    expect(coverPrompt('front')).toMatch(/\*\*REQUIRED TEXT:\*\*\nPaint "The Lamp on the Pier" in the upper third/);
  });
});

describe('the cut order is ONE list, and the log names each step it cut', () => {
  it('PROMPT_CUT_ORDER is the order the shrinker spends', () => {
    expect(PROMPT_CUT_ORDER.map((s: any) => s.label)).toEqual([
      'COUNTS', 'Composition: size', 'Composition: facing', 'DEPTH AND SIZE', 'Composition: ground',
      'REQUIRED CAST', 'HEIGHT ORDER', 'AGE & PROPORTIONS', 'reference-photo rule', 'single-illustration rule',
    ]);
    for (const s of PROMPT_CUT_ORDER) {
      expect(s.what && s.why && s.approxChars > 0, s.label).toBeTruthy();
    }
  });

  it('each exact-text step states its size within 10%', () => {
    const exact: Record<string, number> = {
      COUNTS: PB.COUNTS_RULE.length,
      'Composition: size': PB.COMPOSITION_SIZE_BULLET.length,
      'Composition: facing': PB.COMPOSITION_FACING_BULLET.length,
      'Composition: ground': PB.COMPOSITION_GROUND_BULLET.length,
    };
    for (const s of PROMPT_CUT_ORDER) {
      if (!(s.label in exact)) continue;
      expect(Math.abs(s.approxChars - exact[s.label]) / exact[s.label], s.label).toBeLessThan(0.1);
    }
  });

  it('the never-cut list names the parity anchors and the title', () => {
    const labels = PROMPT_NEVER_CUT.map((k: any) => k.label);
    for (const l of ['NO MARKS', 'HANDS', 'REQUIRED TEXT']) expect(labels).toContain(l);
  });

  it('the shrink log names every cut block in order, with its step and size', async () => {
    const events: any[] = [];
    const fake = { warn: (_e: string, msg: string, _x: any, d: any) => events.push({ msg, d }), info: () => {} };
    GL.setCurrentLogger(fake);
    try {
      const p = `${'The main character stands on the pier. '.repeat(60)}\n\n${PB.buildCompositionBlock()}\n\n**ART STYLE:** painterly.\n\n${PB.COUNTS_RULE}\n\n${PB.NO_CHARACTER_MARKING_RULE}\n\n${PB.HANDS_HOLD_ONLY_NAMED_RULE}`;
      const out = String(await shrinkPromptForModel(p, p.length - 700, 'TEST log', null));
      expect(out).toContain(PB.NO_CHARACTER_MARKING_RULE);
      expect(out).toContain(PB.HANDS_HOLD_ONLY_NAMED_RULE);
      const ev = events.find(e => e.d && e.d.branch === 'cut');
      expect(ev.d.droppedSteps.map((s: any) => s.step)).toEqual([1, 2, 3]);
      expect(ev.msg).toMatch(/cut in order: #1 COUNTS \(-\d+\) > #2 Composition: size \(-\d+\) > #3 Composition: facing \(-\d+\)/);
    } finally {
      GL.clearCurrentLogger();
    }
  });
});
