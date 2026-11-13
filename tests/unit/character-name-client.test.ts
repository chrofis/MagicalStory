import { describe, it, expect } from 'vitest';
import { characterNameProblem, characterNameHint } from '../../client/src/utils/characterName';

describe('wizard name box validator', () => {
  it.each(['Luna', 'Anne-Sophie', 'Anne Sophie Müller', "D'Angelo", 'Zoë', 'Jean Luc Picard'])('accepts %s', (n) => {
    expect(characterNameProblem(n)).toBeNull();
  });
  it('refuses commas', () => {
    expect(characterNameProblem('Noah, Freund von Louis')).toBe('comma');
    expect(characterNameProblem('Noah,')).toBe('comma');
  });
  it('refuses the no-comma relationship form (4+ words)', () => {
    expect(characterNameProblem('Aurelia Schwester von Aria')).toBe('tooLong');
  });
  it('refuses more than 30 characters', () => {
    expect(characterNameProblem('A'.repeat(31))).toBe('tooLong');
    expect(characterNameProblem('A'.repeat(30))).toBeNull();
  });
  it('ignores surrounding spaces', () => {
    expect(characterNameProblem('  Luna  ')).toBeNull();
  });
  it('hint exists in de/en/fr/it and falls back to English', () => {
    for (const l of ['de', 'en', 'fr', 'it']) expect(characterNameHint(l).length).toBeGreaterThan(20);
    expect(characterNameHint('xx')).toBe(characterNameHint('en'));
    expect(characterNameHint('de')).not.toBe(characterNameHint('en'));
  });
});
