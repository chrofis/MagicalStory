import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
const { buildCreatureToneSection, youngestMainAge } = require('../../server/lib/promptBuilders.js');

/**
 * THE DEFECT THIS PINS (prod job_1789227389389_z18dmvnt6, 2026-09-13).
 *
 * `creatureToneLevel` read `pickMainCharacters().focus.age`, and `focus` is
 * `mains[0]` after a DESCENDING age sort — the OLDEST main. The story's mains
 * were Liz 5 and Ayan 8, so the whole book was briefed `formidable` ("claws and
 * teeth visible rather than hidden … it may loom") on account of the older
 * sibling, and its p10 crayfish was drawn gripping a wet, dead-looking mouse.
 *
 * The band now comes from the YOUNGEST main. Tested through the built prompt —
 * the band words that actually reach the Art Director — rather than by reaching
 * for the private picker.
 */

const story = (chars: Array<{ id: number; name: string; age: number }>, mainIds?: number[]) => ({
  characters: chars,
  mainCharacters: mainIds ?? chars.map(c => c.id),
  pages: 4,
  language: 'en',
  artStyle: 'watercolor',
});

const band = (prompt: string) => {
  const formidable = /claws and teeth visible rather than hidden/.test(prompt);
  const notMenacing = /a neutral or gentle mouth that shows no teeth/.test(prompt);
  const cute = /drawn cute: rounded forms throughout/.test(prompt);
  if (formidable) return 'formidable';
  if (notMenacing) return 'not-menacing';
  if (cute) return 'cute';
  return 'none';
};

const build = (input: any) => String(buildCreatureToneSection(input) || '');

describe('creature tone band comes from the youngest main character', () => {
  it('THE REGRESSION: a 5-year-old and an 8-year-old get the gentler band, not formidable', () => {
    const p = build(story([
      { id: 1, name: 'Liz', age: 5 },
      { id: 2, name: 'Ayan', age: 8 },
    ]));
    expect(band(p)).toBe('not-menacing');
    expect(p).not.toMatch(/claws and teeth visible rather than hidden/);
  });

  it('an 8-year-old alone still gets formidable — the band is right for that book', () => {
    const p = build(story([{ id: 2, name: 'Ayan', age: 8 }]));
    expect(band(p)).toBe('formidable');
  });

  it('a 5-year-old alone gets the same band as the mixed 5+8 cast', () => {
    const alone = band(build(story([{ id: 1, name: 'Liz', age: 5 }])));
    const mixed = band(build(story([
      { id: 1, name: 'Liz', age: 5 },
      { id: 2, name: 'Ayan', age: 8 },
    ])));
    expect(alone).toBe(mixed);
  });

  it('a 3-year-old with an 8-year-old sibling gets cute', () => {
    const p = build(story([
      { id: 1, name: 'Mia', age: 3 },
      { id: 2, name: 'Ayan', age: 8 },
    ]));
    expect(band(p)).toBe('cute');
  });

  it('a non-main younger sibling does NOT lower the band', () => {
    // mains are explicit: only the 8-year-old. The toddler is in the cast but
    // is not who the book is for.
    const p = build(story([
      { id: 1, name: 'Mia', age: 3 },
      { id: 2, name: 'Ayan', age: 8 },
    ], [2]));
    expect(band(p)).toBe('formidable');
  });

  it('an age-0 cast gets the cute band - zero is an age, not a missing one', () => {
    expect(band(build(story([{ id: 1, name: 'Baby', age: 0 }])))).toBe('cute');
    expect(youngestMainAge(story([{ id: 1, name: 'Baby', age: 0 }]), 5)).toBe(0);
  });

  it('an age-0 main lowers the band for a mixed cast', () => {
    expect(band(build(story([
      { id: 1, name: 'Baby', age: 0 },
      { id: 2, name: 'Ayan', age: 8 },
    ])))).toBe('cute');
  });
  it('a cast with no readable age emits no tone section at all', () => {
    const p = build(story([{ id: 1, name: 'Nobody', age: NaN as any }]));
    expect(band(p)).toBe('none');
  });

  it('youngestMainAge honours the explicit mains list', () => {
    const s = story([
      { id: 1, name: 'Mia', age: 3 },
      { id: 2, name: 'Ayan', age: 8 },
    ], [2]);
    expect(youngestMainAge(s, NaN)).toBe(8);
    expect(youngestMainAge(story([
      { id: 1, name: 'Mia', age: 3 },
      { id: 2, name: 'Ayan', age: 8 },
    ]), NaN)).toBe(3);
  });
});
