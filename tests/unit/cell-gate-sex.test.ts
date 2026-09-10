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

  it('keeps the original skin and art-style checks', () => {
    const p = cellGatePrompt(style, null, null);
    expect(p).toContain('(1) Colouring: a human figure has a plausible human skin color');
    expect(p).toContain('an animal or creature is judged on the colouring its description states instead');
    expect(p).toContain('(2) Is the cell actually rendered in the declared art style');
    expect(p).toContain('"natural": true or false');
  });
});
