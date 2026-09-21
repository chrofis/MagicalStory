import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
const { declaredAgeBlock, buildPrompt, buildBodyRowPrompt, buildHeadRowPrompt } = require('../../server/lib/character2x4Sheet.js');

/**
 * THE DEFECT THIS PINS (prod job_1789227389389_z18dmvnt6, 2026-09-14).
 *
 * The 2x4 identity-sheet prompt never received the declared age. Its only age
 * instructions were "match the person's apparent age in Image 3" and a coarse
 * four-row table whose child rows read "a young child about 5 to 6 [heads], a
 * toddler about 4". A grep of the stored 4,511-character prompt found zero
 * occurrences of "preschool", "school-age", "years old", "apparentAge" — or the
 * word "child". So a declared 5-year-old and a declared 11-year-old produced a
 * byte-identical prompt, and the only thing separating them was what the model
 * read off a photograph, against an adult yardstick.
 *
 * Measured result: Liz (declared 5) came back reading 7-9, Ayan (declared 8)
 * reading 12-14, and every page then copied those sheets faithfully — which is
 * why the page-level evaluator could never win the argument.
 */
describe('the identity sheet is anchored on the DECLARED age', () => {
  it('THE REGRESSION: a declared 5-year-old and a declared 11-year-old no longer share a prompt', () => {
    const five = buildPrompt('anime', 'a yellow coat', { age: 5, name: 'A' });
    const eleven = buildPrompt('anime', 'a yellow coat', { age: 11, name: 'A' });
    expect(five).not.toBe(eleven);
  });

  it('names the age and its head-height, not just an adult yardstick', () => {
    const block = declaredAgeBlock({ age: 5 });
    expect(block).toMatch(/5 years old/);
    expect(block).toMatch(/heads tall/);
  });

  it('the stated age outranks the photograph', () => {
    expect(declaredAgeBlock({ age: 8 })).toMatch(/outranks any impression of age taken from the photo/);
  });

  it('reaches BOTH the head row and the full-body row of the prompt', () => {
    const p = buildPrompt('anime', 'a red hoodie', { age: 8, name: 'Ayan' });
    expect((p.match(/8 years old/g) || [])).toHaveLength(2);
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

  it('a character with no usable age adds nothing — the prompt is unchanged', () => {
    expect(declaredAgeBlock({})).toBe('');
    expect(declaredAgeBlock({ age: null })).toBe('');
    expect(declaredAgeBlock({ age: 'not a number' })).toBe('');
    expect(declaredAgeBlock({ age: -2 })).toBe('');
    const withAge = buildPrompt('anime', 'x', { age: 5 });
    const without = buildPrompt('anime', 'x', {});
    expect(without.length).toBeLessThan(withAge.length);
  });

  it('accepts the declaredAge field as well as age', () => {
    expect(declaredAgeBlock({ declaredAge: 6 })).toMatch(/6 years old/);
  });
});

/**
 * THE SECOND DEFECT, caught before it shipped (2026-09-14): the block was first
 * injected into `buildPrompt`, which is the pre-2026-08 SINGLE-CALL sheet
 * builder and is dead on the live path. `generateComposited2x4` builds its
 * prompts with `buildBodyRowPrompt` + `buildHeadRowPrompt`, so the live prompt
 * was byte-identical with and without the change — an A/B run against it would
 * have measured nothing but generation noise. These tests pin the LIVE builders.
 */
describe('the age block reaches the builders generateComposited2x4 actually calls', () => {
  it('the body row carries it — that is where proportions are decided', () => {
    expect(buildBodyRowPrompt('a red hoodie', { age: 8 })).toMatch(/8 years old/);
  });

  it('the head row carries it too — facial maturity is what reads as age in a head shot', () => {
    expect(buildHeadRowPrompt({ age: 8 }, 'a red hoodie')).toMatch(/8 years old/);
  });

  it('a declared 5-year-old and a declared 11-year-old differ in the LIVE prompts', () => {
    expect(buildBodyRowPrompt('x', { age: 5 })).not.toBe(buildBodyRowPrompt('x', { age: 11 }));
    expect(buildHeadRowPrompt({ age: 5 }, 'x')).not.toBe(buildHeadRowPrompt({ age: 11 }, 'x'));
  });

  it('no age leaves the live prompts exactly as they were', () => {
    expect(buildBodyRowPrompt('x', { name: 'A' })).not.toMatch(/years old/);
    expect(buildHeadRowPrompt({ name: 'A' }, 'x')).not.toMatch(/years old/);
  });
});

/**
 * A9 (2026-09-21): the body-row prompt asserted BOTH "natural proportions
 * matching the person's apparent age in Image 3" and the declared-age block's
 * "that stated age outranks any impression of age taken from the photo". Two
 * contradictory age instructions in one prompt let the model choose, and it
 * chooses the photograph. Age now has one source per prompt.
 */
describe('the body row states the age ONCE', () => {
  it('a declared age removes the photo-age clauses entirely', () => {
    const p = buildBodyRowPrompt('a red hoodie', { age: 3 });
    expect(p).toMatch(/3 years old/);
    expect(p).not.toMatch(/apparent age/);
  });

  it('with no declared age, the photo remains the yardstick', () => {
    const p = buildBodyRowPrompt('a red hoodie', { name: 'A' });
    expect(p).toMatch(/apparent age in Image 3/);
    expect(p).toMatch(/7 to 8 heads tall/);
  });

  it('the declared block replaces the adult-yardstick sentence, not just appends to it', () => {
    expect(buildBodyRowPrompt('x', { age: 3 })).not.toMatch(/7 to 8 heads tall/);
  });
});
