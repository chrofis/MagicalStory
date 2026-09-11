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
    expect(p).toContain('A human figure has a plausible human skin color');
    expect(p).toContain('(2) Is the cell actually rendered in the declared art style');
    expect(p).toContain('"natural": true or false');
  });
});

/**
 * A secondary character is not always human. A stone golem cell was failed by
 * the gate for "not a plausible human skin color", burning a re-render per
 * character before the original was shipped anyway
 * (job_1789147573901_m3uam0nxi). The classification belongs to the model: the
 * bible description is quoted and the model decides.
 */
describe('character cell gate judges a non-human character on its own material', () => {
  const style = 'traditional watercolor';

  it('quotes the description and routes classification to the model', () => {
    const desc = 'a figure of human shape made entirely of pale grey layered stone';
    const p = cellGatePrompt(style, null, null, desc);
    expect(p).toContain(`The character is described as: \"${desc}\".`);
    expect(p).toContain('first decide from the description whether this character is human');
    expect(p).toContain('is judged on the colouring and material its own description states, never on human skin');
  });

  it('still demands plausible human skin of a human figure', () => {
    const p = cellGatePrompt(style, 8, 'a boy, slightly tall for his age', 'a boy with brown hair and freckles');
    expect(p).toContain('A human figure has a plausible human skin color');
    expect(p).toContain('not green-, gray- or blue-tinted');
  });

  it('omits the description sentence when the bible gave none', () => {
    const p = cellGatePrompt(style, null, null);
    expect(p).not.toContain('The character is described as:');
    expect(p).toContain('(1) Colouring:');
  });
});
