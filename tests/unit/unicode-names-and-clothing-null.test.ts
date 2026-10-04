/**
 * Review 2026-10-04 C3 / C8 / C9.
 *  C3: a brief with the word "clothing" but no value must give null (the callers'
 *      `|| primaryClothing` and no-default throws then run), never 'standard'.
 *  C8: the name scan in getCharactersInScene uses Unicode lookarounds, so
 *      "Zoé" / "Émile" match; "Ann" still never matches "Anna".
 *  C9: significantEntityTokens keeps ß â ô û ë ï œ inside a word.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS libs
const { parseClothingCategory } = require('../../server/lib/clothingResolve.js');
// @ts-ignore
const { getCharactersInScene } = require('../../server/lib/sceneMetadata.js');
// @ts-ignore
const { significantEntityTokens } = require('../../server/lib/visualBible.js');

describe('C3 parseClothingCategory', () => {
  it('returns null when the keyword has no value near it', () => {
    expect(parseClothingCategory('The child wears warm clothing of some kind, nothing more to say here.', false)).toBeNull();
  });
  it('still reads a real value', () => {
    expect(parseClothingCategory('**Clothing:** winter', false)).toBe('winter');
  });
});

describe('C8 getCharactersInScene (prose scan, step 2)', () => {
  const chars = [{ name: 'Zoé' }, { name: 'Émile' }, { name: 'Ann' }];
  it('matches names that start or end with a non-ASCII letter', () => {
    const found = getCharactersInScene('Zoé and Émile cross the bridge.', chars).map((c: any) => c.name);
    expect(found).toEqual(['Zoé', 'Émile']);
  });
  it('does not match a name inside a longer one', () => {
    expect(getCharactersInScene('Anna waves.', chars)).toEqual([]);
  });
});

describe('C9 significantEntityTokens', () => {
  it('does not split on ß â ô û ë ï œ', () => {
    const t = significantEntityTokens('bâton Straße côté noël œuvre');
    for (const w of ['bâton', 'straße', 'côté', 'noël', 'œuvre']) expect(t.has(w)).toBe(true);
    expect(t.has('ton')).toBe(false);
  });
});
