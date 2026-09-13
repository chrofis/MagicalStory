/**
 * The long-tail name-keyed lookups all read through ONE resolver.
 *
 * Each of these was its own ad-hoc rule (`Object.entries(map).find(([n]) =>
 * n.trim().toLowerCase() === want)`), and they disagreed: a diacritic, a
 * dropped title or a trailing parenthetical made one site find the entry and
 * the next site miss it. These pin the behaviour, not the wording.
 */
import { describe, it, expect } from 'vitest';

const { buildCastIndex, lookupByName, canonicalName } = require('../../server/lib/castResolver');
const { resolveCharacterReqs } = require('../../server/lib/clothingCategories');

const bible = {
  secondaryCharacters: [{ id: 'CHR001', name: 'Kapitänin Rossa' }],
  animals: [],
};
const story = { characters: [{ id: 1, name: 'Zoë Meier' }] };

describe('resolveCharacterReqs reads through the one resolver', () => {
  it('finds a character by the diacritic-stripped spelling', () => {
    const reqs = { 'Zoë Meier': { standard: { used: true } } };
    expect(resolveCharacterReqs(reqs, 'Zoe Meier')).toEqual(reqs['Zoë Meier']);
  });

  it('finds a character by the short form when a cast index is supplied', () => {
    const idx = buildCastIndex(story, bible);
    const reqs = { 'Kapitänin Rossa': { costumed: { used: true } } };
    expect(resolveCharacterReqs(reqs, 'Rossa', idx)).toEqual(reqs['Kapitänin Rossa']);
  });

  it('without an index the short form does not resolve (exact + canonical only)', () => {
    const reqs = { 'Kapitänin Rossa': { costumed: { used: true } } };
    expect(resolveCharacterReqs(reqs, 'Rossa')).toBeNull();
  });

  it('a null map is not a lookup failure to crash on', () => {
    expect(resolveCharacterReqs(null, 'Rossa')).toBeNull();
  });
});

describe('lookupByName', () => {
  const idx = buildCastIndex(story, bible);

  it('finds a map keyed by the full name from the short form the prose uses', () => {
    const map = { 'Kapitänin Rossa': 'costumed' };
    expect(lookupByName(map, 'Rossa', idx)).toEqual({ key: 'Kapitänin Rossa', value: 'costumed' });
  });

  it('the exact key still wins over any resolution', () => {
    const map = { Rossa: 'winter', 'Kapitänin Rossa': 'costumed' };
    expect(lookupByName(map, 'Rossa', idx)!.value).toBe('winter');
  });

  it('a trailing parenthetical does not break the key match', () => {
    const map = { 'Zoë Meier': 'summer' };
    expect(lookupByName(map, 'Zoe Meier (the girl)', null)!.value).toBe('summer');
  });

  it('a null map resolves to null, never a throw', () => {
    expect(lookupByName(null, 'Rossa', idx)).toBeNull();
  });

  it('a name nothing knows resolves to null', () => {
    expect(lookupByName({ 'Kapitänin Rossa': 'costumed' }, 'Gessler', idx)).toBeNull();
  });
});

describe('canonicalName is the one COMPARE normaliser', () => {
  it('folds case, diacritics, spacing and a trailing parenthetical', () => {
    expect(canonicalName('  Kapitänin   Rossa (the captain) ')).toBe('kapitanin rossa');
  });
});
