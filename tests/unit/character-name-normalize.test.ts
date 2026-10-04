import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normalizeCharacterName } = require('../../server/lib/characterName');

describe('normalizeCharacterName', () => {
  it.each([
    ['LUNA', 'Luna'],
    ['luna', 'Luna'],
    ['ANNE-SOPHIE', 'Anne-Sophie'],
    ['anne-sophie', 'Anne-Sophie'],
    ['JEAN LUC', 'Jean Luc'],
    ["O'BRIEN", "O'Brien"],
    ['ÉLODIE', 'Élodie'],
    ['zoë', 'Zoë'],
    ['ÇAĞLA', 'Çağla'],
  ])('title-cases %s -> %s', (input, expected) => {
    expect(normalizeCharacterName(input)).toBe(expected);
  });

  it.each(['Luna', 'McKenzie', 'DeShawn', 'Anne-Sophie', 'Jean-Luc', 'Lea', 'LéA', 'Élodie', 'JJ', 'AJ', 'J', 'ed', '', 'A.J.'])(
    'leaves %j untouched', (input) => {
      expect(normalizeCharacterName(input)).toBe(input);
    });

  it('passes non-strings through', () => {
    expect(normalizeCharacterName(undefined)).toBeUndefined();
    expect(normalizeCharacterName(null)).toBeNull();
  });
});
