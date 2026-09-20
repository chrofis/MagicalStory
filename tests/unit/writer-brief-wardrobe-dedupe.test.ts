import { describe, it, expect } from 'vitest';

// The page-text writer is handed every character's full appearance on every
// page they appear on, under a rule forbidding it to narrate what anyone wears.
// It is repeated only where the outfit CHANGED. These pin the two halves of
// that: what counts as a change, and what may be dropped when nothing changed.
const {
  characterLookSignature,
  dropAppearanceAppositive,
} = require('../../server/lib/promptBuilders');

describe('characterLookSignature', () => {
  it('is stable while the outfit and worn state are', () => {
    const meta = { characterClothing: { Hero: 'standard' }, wornItems: [] };
    expect(characterLookSignature(meta, 'Hero')).toBe(characterLookSignature(meta, 'Hero'));
  });

  it('changes when the clothing category changes', () => {
    const before = { characterClothing: { Hero: 'standard' }, wornItems: [] };
    const after = { characterClothing: { Hero: 'costumed:knight' }, wornItems: [] };
    expect(characterLookSignature(before, 'Hero')).not.toBe(characterLookSignature(after, 'Hero'));
  });

  it('changes when a garment comes off, category unchanged', () => {
    const on = {
      characterClothing: { Hero: 'standard' },
      wornItems: [{ id: 'ART003', owner: 'Hero', state: 'on' }],
    };
    const off = {
      characterClothing: { Hero: 'standard' },
      wornItems: [{ id: 'ART003', owner: 'Hero', state: 'off' }],
    };
    expect(characterLookSignature(on, 'Hero')).not.toBe(characterLookSignature(off, 'Hero'));
  });

  it('returns to the earlier value when the earlier outfit returns', () => {
    const normal = { characterClothing: { Hero: 'standard' }, wornItems: [] };
    const costumed = { characterClothing: { Hero: 'costumed:knight' }, wornItems: [] };
    // normal -> costumed -> normal: the third page matches the first, so the
    // walk that consumes this must have repeated the description in between.
    expect(characterLookSignature(normal, 'Hero')).not.toBe(characterLookSignature(costumed, 'Hero'));
    expect(characterLookSignature(normal, 'Hero')).toBe(characterLookSignature(normal, 'Hero'));
  });

  it('ignores another character\'s worn items', () => {
    const meta = {
      characterClothing: { Hero: 'standard', Friend: 'standard' },
      wornItems: [{ id: 'ART003', owner: 'Friend', state: 'off' }],
    };
    expect(characterLookSignature(meta, 'Hero')).toBe('standard|');
  });
});

describe('dropAppearanceAppositive', () => {
  const brief =
    'Hero — a preschooler of average build, about four heads tall with short wavy hair, '
    + 'green eyes, wearing a red zip-up fleece jacket and brown boots — kneels in the leaves.';

  it('drops an appearance appositive and keeps the sentence', () => {
    expect(dropAppearanceAppositive(brief, 'Hero')).toBe('Hero kneels in the leaves.');
  });

  it('keeps an aside that is story rather than staging', () => {
    const story = 'Hero — who has never once let go of the rope — pulls harder.';
    expect(dropAppearanceAppositive(story, 'Hero')).toBe(story);
  });

  it('leaves other characters untouched', () => {
    const two = brief + ' Friend — a toddler with blue eyes, wearing a yellow gilet — steps back.';
    const out = dropAppearanceAppositive(two, 'Hero');
    expect(out).toContain('Friend — a toddler with blue eyes, wearing a yellow gilet — steps back.');
    expect(out).toContain('Hero kneels in the leaves.');
  });

  it('handles a name with regex characters', () => {
    const odd = 'Dr. A. — a tall man with grey hair, wearing a long coat — waits.';
    expect(dropAppearanceAppositive(odd, 'Dr. A.')).toBe('Dr. A. waits.');
  });

  it('is a no-op for a character not in the prose', () => {
    expect(dropAppearanceAppositive(brief, 'Absent')).toBe(brief);
  });

  // The briefs use both spellings of the appositive. Dropping the unspaced one
  // without putting a space back welded the name to the verb ("Heroextends").
  it('keeps the words apart when the appositive is unspaced', () => {
    const unspaced =
      'Hero—a toddler with blue eyes, wearing a yellow gilet—extends both hands.';
    expect(dropAppearanceAppositive(unspaced, 'Hero')).toBe('Hero extends both hands.');
  });

  it('does not double the space when the appositive is spaced', () => {
    expect(dropAppearanceAppositive(brief, 'Hero')).not.toMatch(/ {2}/);
  });
});
