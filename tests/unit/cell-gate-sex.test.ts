import { describe, it, expect } from 'vitest';

const { cellGatePrompt } = require('../../server/lib/referenceSheets');

/**
 * The character-cell gate is the only point where a rendered reference is
 * judged against its own description. A sheet that drew a man for a character
 * the bible described as a woman passed the gate and was then agreed with by
 * every identity check on every page.
 */
describe('character cell gate asks about sex', () => {
  const style = 'traditional watercolor';

  it('quotes the bible build field verbatim and asks the figure to match its sex', () => {
    const p = cellGatePrompt(style, 58, 'a woman, wiry and angular, slightly below average height');
    expect(p).toContain('(3) Apparent age: does the figure look about 58?');
    expect(p).toContain('(4) Sex: the character is described as "a woman, wiry and angular, slightly below average height".');
    expect(p).toContain('A figure that reads as the other sex fails');
  });

  it('numbers the sex check (3) when there is no age', () => {
    const p = cellGatePrompt(style, null, 'a boy, slightly tall for his age');
    expect(p).toContain('(3) Sex: the character is described as "a boy, slightly tall for his age".');
    expect(p).not.toContain('Apparent age');
  });

  it('asks nothing about sex when the bible gave no build', () => {
    const p = cellGatePrompt(style, 40, null);
    expect(p).toContain('(3) Apparent age');
    expect(p).not.toContain('Sex:');
  });

  it('keeps the art-style check and the numbering of the later checks', () => {
    const p = cellGatePrompt(style, null, null);
    expect(p).toContain('(1) Colouring:');
    expect(p).toContain('(2) Is the cell actually rendered in the declared art style');
    expect(p).toContain('"natural": true or false');
  });
});

/**
 * The description IS the specification: the cell is judged against it and
 * nothing else. The gate used to assert human skin standalone — which failed a
 * correctly-rendered stone figure twice and burned a paid re-render per
 * character (job_1789147573901_m3uam0nxi) — only because it had no description
 * to judge against. A description stating a skin colour catches a
 * green-tinted figure without a human/non-human branch.
 */
describe('character cell gate judges colouring against the description alone', () => {
  const style = 'traditional watercolor';

  it('quotes the description and asks one rule about colouring and material', () => {
    const desc = 'a figure of human shape made entirely of pale grey layered stone';
    const p = cellGatePrompt(style, null, null, desc);
    expect(p).toContain(`The character is described as: \"${desc}\".`);
    expect(p).toContain("(1) Colouring: do the figure's colouring and material match what the description states?");
  });

  it('never classifies the character as human or non-human', () => {
    const p = cellGatePrompt(style, 8, 'a boy, slightly tall for his age', 'a boy with fair skin and brown hair');
    expect(p).not.toContain('human skin');
    expect(p).not.toContain('whether this character is human');
    expect(p).not.toContain('an animal or creature');
    expect(p).toContain("(1) Colouring: do the figure's colouring and material match what the description states?");
  });

  it('says so explicitly when the bible gave no description, and keeps the numbering', () => {
    const p = cellGatePrompt(style, 40, 'a woman, slight');
    expect(p).not.toContain('The character is described as:');
    expect(p).toContain('(1) Colouring: no description was given, so nothing is checked here.');
    expect(p).toContain('(3) Apparent age');
    expect(p).toContain('(4) Sex:');
  });
});
