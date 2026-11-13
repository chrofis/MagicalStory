import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  findExistingCharacter, mergePhysicalAndTraitsOnSave, mergeCharacters,
} = require('../../server/lib/characterMerge');
const { mergeFreshAvatars } = require('../../server/lib/characterPhotos');

// Mirrors what the save route does for one character (see routes/characters.js POST).
function save(existing: any, sent: any) {
  const e = JSON.parse(JSON.stringify(existing));
  const merged = { ...sent };
  mergePhysicalAndTraitsOnSave(e, merged, sent);
  return merged;
}

describe('character save: id-only matching (character-save-merges-same-name)', () => {
  const db = [
    { id: 1, name: 'Luna', photos: { face: 'https://r2/luna.jpg' }, avatars: { standard: 'A' } },
    { id: 2, name: 'Luna', photos: { face: 'https://r2/luna2.jpg' } },
    { id: 3, name: '', photos: { face: 'https://r2/draft.jpg' } },
  ];
  it('matches by id, string vs number', () => {
    expect(findExistingCharacter(db, { id: '2', name: 'x' })?.photos.face).toBe('https://r2/luna2.jpg');
  });
  it('a new character with the same name as a DB one is NOT matched', () => {
    expect(findExistingCharacter(db, { id: 99, name: 'Luna' })).toBeUndefined();
  });
  it('a blank new character does not match a nameless draft', () => {
    expect(findExistingCharacter(db, { id: 100, name: '' })).toBeUndefined();
  });
  it('a character without an id matches nothing', () => {
    expect(findExistingCharacter(db, { name: 'Luna' })).toBeUndefined();
  });
  it('mergeCharacters (lib) is id-only too', () => {
    const { characters } = mergeCharacters([{ id: 100, name: 'Luna' }], [{ id: 1, name: 'Luna', photo_url: 'x' }]);
    expect(characters[0].photo_url).toBeUndefined();
  });
  it('mergeFreshAvatars does not hand a same-named character another one\'s avatars', () => {
    const out = mergeFreshAvatars([{ id: 5, name: 'Luna' }], [{ id: 1, name: 'Luna', avatars: { standard: 'A' } }], 'pixar');
    expect(out[0].avatars).toBeUndefined();
    const ok = mergeFreshAvatars([{ id: 1, name: 'Luna' }], [{ id: 1, name: 'Luna', avatars: { standard: 'A' } }], 'pixar');
    expect(ok[0].avatars).toEqual({ standard: 'A' });
  });
});

describe('character save: cleared fields stay cleared (character-save-cannot-clear-field)', () => {
  const existing = {
    id: 1, name: 'Luna',
    physical: { eyeColor: 'blue', other: 'freckles', hairColor: 'brown', userHairOverride: { lengthTop: 'long', styling: 'braids' } },
    traits: { strengths: ['brave'], flaws: ['shy'], challenges: ['dark'], specialDetails: 'loves frogs' },
  };
  it('an emptied flat physical field (eye_color: "") is cleared, not restored', () => {
    const out = save(existing, { id: 1, name: 'Luna', eye_color: '', hair_color: 'brown', other: '' });
    expect(out.physical.eyeColor).toBe('');
    expect(out.physical.other).toBe('');
    expect(out.physical.hairColor).toBe('brown');
  });
  it('a field ABSENT from the payload keeps the DB value', () => {
    const out = save(existing, { id: 1, name: 'Luna', hair_color: 'brown' });
    expect(out.physical.eyeColor).toBe('blue');
    expect(out.physical.other).toBe('freckles');
  });
  it('null counts as absent', () => {
    const out = save(existing, { id: 1, name: 'Luna', eye_color: null });
    expect(out.physical.eyeColor).toBe('blue');
  });
  it('clearing hair length also clears the stored override', () => {
    const out = save(existing, { id: 1, name: 'Luna', hair_length: '', hair_style: 'braids' });
    expect(out.physical.userHairOverride).toEqual({ styling: 'braids' });
  });
  it('empty strengths/flaws/challenges/specialDetails sent are cleared', () => {
    const out = save(existing, { id: 1, name: 'Luna', strengths: [], flaws: [], challenges: [], special_details: '' });
    expect(out.traits).toEqual({ strengths: [], flaws: [], challenges: [], specialDetails: '' });
  });
  it('canonical traits object with empty values is also a sent value', () => {
    const out = save(existing, { id: 1, name: 'Luna', traits: { strengths: [], specialDetails: '' } });
    expect(out.traits.strengths).toEqual([]);
    expect(out.traits.specialDetails).toBe('');
    expect(out.traits.flaws).toEqual(['shy']);
  });
  it('trait keys absent from the payload keep the DB value (partial save)', () => {
    const out = save(existing, { id: 1, name: 'Luna' });
    expect(out.traits).toEqual(existing.traits);
  });
  it('a non-empty sent value still wins', () => {
    const out = save(existing, { id: 1, name: 'Luna', eye_color: 'green', strengths: ['kind'] });
    expect(out.physical.eyeColor).toBe('green');
    expect(out.traits.strengths).toEqual(['kind']);
  });
});
