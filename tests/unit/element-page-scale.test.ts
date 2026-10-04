/**
 * ONE PAGE-PROMPT PEOPLE YARDSTICK FOR EVERY BAND (owner, 2026-09-26).
 *
 * 7e767c9d9 measured only a large CREATURE against the people in frame; every
 * other element kept a band phrase naming "a standing adult" or "a human head"
 * that a page of children does not hold. elementPageScaleNote now gives
 * creatures, objects and vehicles a yardstick against the figures in frame:
 *   knee-/waist-/chest-high   a body landmark of each named figure;
 *   adult / twice / house     a multiple of each figure's height;
 *   melon-sized and smaller   a body part of the figure touching it, else of
 *                             the first figure listed in frame;
 *   landmark, forearm/arm, no figure in frame   the band phrase alone.
 * Page side only: the REQUIRED OBJECTS line, the judges' ELEMENT SIZES input
 * and the repaint clause — one builder. Never a VB cell, arc, plan or text.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const VB = cjs('../../server/lib/visualBible.js');
const PB = cjs('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = cjs('../../server/services/prompts.js');

const NL = String.fromCharCode(10);
const P = VB.SCALE_PHRASES;
const LEVIN = { name: 'Levin', age: '5', gender: 'male', height: '110' };
const JULIAN = { name: 'Julian', age: '3', gender: 'male', height: '95' };
const DAD = { name: 'Dad', age: '38', gender: 'male' };

const egg = { id: 'ART003', name: 'dragon egg', label: 'dragon egg', scaleClass: 'melon-sized', pages: [9] };
const cart = { id: 'VEH001', name: 'hay cart', label: 'hay cart', scaleClass: 'adult-height', pages: [9] };
const pup = { id: 'ANI001', name: 'Nia', scaleClass: 'waist-high', species: 'dog', pages: [9] };

describe('the one fraction table', () => {
  it('defines the three body bands, the two stated multiples and house-height — nothing else', () => {
    expect(Object.keys(VB.SCALE_ADULT_HEIGHT_FRACTION).sort()).toEqual(
      ['adult-height', 'chest-high', 'house-height', 'knee-high', 'twice-adult-height', 'waist-high'].sort());
    const f = VB.SCALE_ADULT_HEIGHT_FRACTION;
    expect(f['knee-high']).toBeLessThan(f['waist-high']);
    expect(f['waist-high']).toBeLessThan(f['chest-high']);
    expect(f['chest-high']).toBeLessThan(f['adult-height']);
    expect(f['adult-height']).toBe(1);
    expect(f['twice-adult-height']).toBe(2);
    for (const b of ['fingertip-sized', 'palm-sized', 'hand-sized', 'melon-sized', 'forearm-sized', 'arm-sized', 'landmark']) {
      expect(VB.scaleAdultHeightFraction(b)).toBeNull();
    }
    expect(VB.scaleAdultHeightFraction('hip'), 'legacy alias of waist-high').toBe(f['waist-high']);
  });
});

describe('height bands: a body landmark below the figure, a multiple above it', () => {
  it('a waist-high creature beside a five-year-old reaches his shoulder', () => {
    expect(PB.elementPageScaleNote(pup, [LEVIN])).toBe(`${P['waist-high']} — about as tall as Levin's shoulder`);
  });

  it('a knee-high element reaches a child\'s hip, a chest-high one an adult\'s chest', () => {
    expect(PB.elementPageScaleNote({ scaleClass: 'knee-high' }, [LEVIN])).toBe(`${P['knee-high']} — about as tall as Levin's hip`);
    expect(PB.elementPageScaleNote({ scaleClass: 'chest-high' }, [DAD])).toBe(`${P['chest-high']} — about as tall as Dad's chest`);
  });

  it('figures that read alike are grouped; others each get their own yardstick', () => {
    const twoShoulders = PB.elementPageScaleNote(pup, [LEVIN, { ...LEVIN, name: 'Kiaan' }]);
    expect(twoShoulders).toBe(`${P['waist-high']} — about as tall as Levin's and Kiaan's shoulders`);
    expect(PB.elementPageScaleNote(pup, [LEVIN, JULIAN]))
      .toBe(`${P['waist-high']} — about as tall as Levin's shoulder and about as tall as Julian`);
  });

  it('adult-, twice- and house-height are a multiple of each figure', () => {
    expect(PB.elementPageScaleNote(cart, [LEVIN])).toBe(`${P['adult-height']} — about one and a half times the height of Levin`);
    expect(PB.elementPageScaleNote({ scaleClass: 'house-height' }, [LEVIN])).toBe(`${P['house-height']} — about five times the height of Levin`);
  });

  it('the unnamed (repaint) form names no one', () => {
    const one = PB.elementPageScaleNote(pup, [LEVIN], { unnamed: true });
    expect(one).toBe(`${P['waist-high']} — about as tall as the shoulder of the person beside it`);
    const mixed = PB.elementPageScaleNote(pup, [LEVIN, JULIAN], { unnamed: true });
    expect(mixed).not.toMatch(/Levin|Julian/);
    expect(mixed).toContain('the tallest person beside it');
  });
});

describe('size bands: a body part of the figure touching it', () => {
  it('the holder named by an interaction row, else the first figure in frame', () => {
    expect(PB.elementPageScaleNote(egg, [LEVIN, JULIAN], { contacts: ['Julian'] }))
      .toBe(`${P['melon-sized']} — about the size of Julian's head`);
    expect(PB.elementPageScaleNote(egg, [LEVIN, JULIAN])).toBe(`${P['melon-sized']} — about the size of Levin's head`);
    expect(PB.elementPageScaleNote({ scaleClass: 'palm-sized' }, [JULIAN])).toBe(`${P['palm-sized']} — fits in Julian's hand`);
  });

  it('unnamed: the holder, else the nearest person', () => {
    expect(PB.elementPageScaleNote(egg, [LEVIN], { contacts: ['Levin'], unnamed: true })).toContain("the holder's head");
    expect(PB.elementPageScaleNote(egg, [LEVIN], { unnamed: true })).toContain("the nearest person's head");
  });

  it('contact rows are read on the base id, and a multi-actor row names each actor', () => {
    const rows = [{ character: 'Levin + Julian', object: 'ART003.1', where: 'carry the egg' }, { character: 'Max', object: 'VEH001', where: 'pushes the cart' }];
    expect(PB.elementContactNames(rows, 'ART003')).toEqual(['Levin', 'Julian']);
    expect(PB.elementContactNames(rows, 'ANI009')).toEqual([]);
  });
});

describe('no yardstick', () => {
  it('landmark, forearm/arm-sized and a page with no figure keep the band phrase alone', () => {
    expect(PB.elementPageScaleNote({ scaleClass: 'landmark' }, [LEVIN])).toBe(P.landmark);
    expect(PB.elementPageScaleNote({ scaleClass: 'forearm-sized' }, [LEVIN])).toBe(P['forearm-sized']);
    expect(PB.elementPageScaleNote(egg, [])).toBe(P['melon-sized']);
  });

  it('the Lab scope narrows the yardstick to the named types and bands', () => {
    const scope = { types: ['animal'], bands: ['adult-height', 'twice-adult-height'] };
    expect(PB.elementPageScaleNote(egg, [LEVIN], { scope, type: 'object' })).toBe(P['melon-sized']);
    expect(PB.elementPageScaleNote(pup, [LEVIN], { scope, type: 'animal' })).toBe(P['waist-high']);
    expect(PB.elementPageScaleNote({ scaleClass: 'twice-adult-height' }, [LEVIN], { scope, type: 'animal' })).toContain('the height of Levin');
  });

  it('an over-the-shoulder crop is not a figure to measure against', () => {
    const whole = PB.wholeFiguresInFrame([LEVIN, JULIAN], { characterPerspectives: { Julian: { perspective: 'over-the-shoulder' } } });
    expect(whole.map((f: any) => f.name)).toEqual(['Levin']);
  });
});

describe('one sentence, three readers', () => {
  const bible = () => ({ animals: [pup], artifacts: [egg], vehicles: [cart] });
  const rows = [{ character: 'Julian', object: 'ART003', where: 'holds the egg against his chest', hands: true }];

  beforeAll(async () => { await loadPromptTemplates(); });

  it('the REQUIRED OBJECTS line carries it, with the precedence line; a page without a figure gets neither', () => {
    const brief = (chars: any[]) => ['Julian holds the egg beside the cart.', '', '---METADATA---', JSON.stringify({
      sceneIntent: 'the egg', characters: chars.map(c => ({ name: c.name, position: 'left', depth: 'midground' })),
      shot: 'medium', objects: ['ART003', 'VEH001', 'ANI001'], interactions: rows, textPosition: 'bottom-left',
    })].join(NL);
    const input: any = { characters: [LEVIN, JULIAN], mainCharacters: [], language: 'en', languageLevel: 'standard', pages: 4, artStyle: 'watercolor' };
    const prompt = String(PB.buildImagePrompt(brief([LEVIN, JULIAN]), input, [LEVIN, JULIAN], bible(), 9, null, {}));
    expect(prompt).toContain(`(object) — ${P['melon-sized']} — about the size of Julian's head`);
    expect(prompt).toContain(`(vehicle) — ${P['adult-height']} — about one and a half times the height of Levin`);
    expect(prompt).toContain(PB.ELEMENT_SIZE_PRECEDENCE_LINE);

    const scoped = String(PB.buildImagePrompt(brief([LEVIN, JULIAN]), input, [LEVIN, JULIAN], bible(), 9, null,
      { pageScaleScope: { types: ['animal'], bands: ['adult-height', 'twice-adult-height'] } }));
    expect(scoped).toContain(`(object) — ${P['melon-sized']}`);
    expect(scoped).not.toContain("Julian's head");
    expect(scoped).not.toContain(PB.ELEMENT_SIZE_PRECEDENCE_LINE);
  });

  it('the judge block and the repaint clause carry the same notes', () => {
    const block = PB.buildElementSizesBlock(bible(), ['ART003.1', 'VEH001', 'ANI001'], [LEVIN, JULIAN], rows);
    expect(block).toContain(`- dragon egg (object): ${PB.elementPageScaleNote(egg, [LEVIN, JULIAN], { contacts: ['Julian'] })}`);
    expect(block).toContain(`- hay cart (vehicle): ${PB.elementPageScaleNote(cart, [LEVIN, JULIAN])}`);
    expect(block).toContain(`- Nia (animal): ${PB.elementPageScaleNote(pup, [LEVIN, JULIAN])}`);
    const clause = PB.buildElementSizeRepairClause(bible(), ['ART003.1'], [LEVIN, JULIAN], rows);
    expect(clause).toContain(`dragon egg: ${P['melon-sized']} — about the size of the holder's head`);
  });
});

describe('the creature tone lines leave a large creature its size', () => {
  it('not-menacing keeps the camera, not the creature, at the child\'s eye level', () => {
    const t = PB.buildCreatureToneSection({ characters: [{ name: 'A', age: '5', isMain: true }] });
    expect(t).toMatch(/kind eyes/);
    expect(t).not.toContain("frame it at the child's eye level");
    expect(t).toContain('full size');
  });
});
