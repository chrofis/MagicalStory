import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
const { declaredAgeBlock, buildOneCallSheetPrompt } = require('../../server/lib/character2x4Sheet.js');

const P = (character: any, costumeDescription = 'a red hoodie') =>
  buildOneCallSheetPrompt(character, { costumeDescription, styleLine: 'watercolour', kind: 'costume' });

/**
 * THE DEFECT THIS PINS (prod job_1789227389389_z18dmvnt6, 2026-09-14).
 *
 * The identity-sheet prompt never received the declared age. A declared 5-year-old and a declared
 * 11-year-old produced a byte-identical prompt, and the only thing separating them was what the model
 * read off a photograph, against an adult yardstick. Liz (declared 5) came back reading 7-9, Ayan
 * (declared 8) reading 12-14, and every page then copied those sheets faithfully.
 *
 * Since 2026-10-10 the sheet is ONE call (oneCallSheet.js); its prompt (buildOneCallSheetPrompt) is the
 * only builder, so the age block is pinned there.
 */
describe('the identity sheet is anchored on the DECLARED age', () => {
  it('THE REGRESSION: a declared 5-year-old and a declared 11-year-old no longer share a prompt', () => {
    expect(P({ age: 5, name: 'A' })).not.toBe(P({ age: 11, name: 'A' }));
  });

  it('names the age and its head-height, not just an adult yardstick', () => {
    const block = declaredAgeBlock({ age: 5 });
    expect(block).toMatch(/5 years old/);
    expect(block).toMatch(/heads tall/);
  });

  it('the stated age outranks the photograph', () => {
    expect(declaredAgeBlock({ age: 8 })).toMatch(/outranks any impression of age taken from the photo/);
  });

  it('reaches the prompt, once', () => {
    expect((P({ age: 8, name: 'Ayan' }).match(/8 years old/g) || [])).toHaveLength(1);
  });

  it('head-heights rise with age across the child buckets', () => {
    const heads = (age: number) => {
      const m = declaredAgeBlock({ age }).match(/about ([\d.]+)(?:-[\d.]+)? heads tall/);
      return m ? parseFloat(m[1]) : null;
    };
    const five = heads(5)!, eight = heads(8)!, thirteen = heads(13)!;
    expect(five).toBeLessThan(eight);
    expect(eight).toBeLessThan(thirteen);
  });

  it('a character with no usable age adds nothing — the block is empty and the prompt names no age', () => {
    expect(declaredAgeBlock({})).toBe('');
    expect(declaredAgeBlock({ age: null })).toBe('');
    expect(declaredAgeBlock({ age: 'not a number' })).toBe('');
    expect(declaredAgeBlock({ age: -2 })).toBe('');
    expect(P({ name: 'A' })).not.toMatch(/years old/);
  });

  it('accepts the declaredAge field as well as age', () => {
    expect(declaredAgeBlock({ declaredAge: 6 })).toMatch(/6 years old/);
  });
});

/**
 * A9 (2026-09-21): the prompt asserted BOTH "natural proportions matching the person's apparent age in
 * Image 2" and the declared-age block's "that stated age outranks any impression of age taken from the
 * photo". Two contradictory age instructions let the model choose, and it chooses the photograph. Age
 * has one source per prompt.
 */
describe('the sheet prompt states the age ONCE', () => {
  it('a declared age removes the photo-age clauses entirely', () => {
    const p = P({ age: 3 });
    expect(p).toMatch(/3 years old/);
    expect(p).not.toMatch(/apparent age/);
  });

  it('with no declared age, the photo remains the yardstick', () => {
    const p = P({ name: 'A' });
    expect(p).toMatch(/apparent age in Image 2/);
    expect(p).toMatch(/7 to 8 heads tall/);
  });

  it('the declared block replaces the adult-yardstick sentence, not just appends to it', () => {
    expect(P({ age: 3 })).not.toMatch(/7 to 8 heads tall/);
  });
});
