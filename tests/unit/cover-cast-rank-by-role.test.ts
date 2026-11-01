/**
 * Cover cast: rank by role (owner, 2026-11-01).
 *
 * With more than MAX_COVER_CHARACTERS photo characters the opening page and
 * back cover keep the main characters plus the others by family tie, not by
 * creation order: parent/child of a main first (either direction in the matrix,
 * customers fill it backwards), then sibling or grandparent/grandchild, then
 * the rest, ties in creation order. Production job_1793561351885_kkg5gxkbj lost
 * the main child's mother (created 7th) to the cap.
 */
import { describe, it, expect } from 'vitest';

const { coverCasts } = require('../../server/lib/coverBeats');
const { relationshipKeyOf, inverseRelationshipKey, familyTierBetween, RELATIONSHIP_TYPES } = require('../../server/lib/relationships');
const { MAX_COVER_CHARACTERS } = require('../../server/lib/coverCastRoster');

const mk = (id: number, name: string, main = false) => ({ id, name, isMainCharacter: main });

describe('relationshipKeyOf', () => {
  it('maps de/fr/it/en labels of one type to the same key', () => {
    for (const label of ['Parent of', 'Elternteil von', 'Parent de', 'Genitore di']) {
      expect(relationshipKeyOf(label), label).toBe('parentOf');
    }
    for (const label of ['Child of', 'Kind von', 'Enfant de', 'Figlio/a di']) {
      expect(relationshipKeyOf(label), label).toBe('childOf');
    }
    expect(relationshipKeyOf('  Nonno/a di ')).toBe('grandparentOf');
  });
  it('unknown, legacy, sentinel and empty labels are null, never guessed', () => {
    for (const label of ['Brother of', 'Onkel von', 'Not Known to', 'Nicht festgelegt', 'Non si conoscono', '', null, undefined]) {
      expect(relationshipKeyOf(label as any), String(label)).toBeNull();
    }
  });
  it('every type has an existing inverse, and the inverse of the inverse is itself', () => {
    for (const t of RELATIONSHIP_TYPES) {
      const inv = inverseRelationshipKey(t.key);
      expect(inv, t.key).toBeTruthy();
      expect(inverseRelationshipKey(inv), t.key).toBe(t.key);
    }
  });
});

describe('familyTierBetween', () => {
  it('reads either cell of the pair', () => {
    expect(familyTierBetween({ '1-2': 'Genitore di' }, 1, 2)).toBe(1);
    expect(familyTierBetween({ '2-1': 'Genitore di' }, 1, 2)).toBe(1);
    expect(familyTierBetween({ '2-1': 'Fratello/Sorella minore di' }, 1, 2)).toBe(2);
    expect(familyTierBetween({ '1-2': 'Amici con' }, 1, 2)).toBe(3);
    expect(familyTierBetween(null, 1, 2)).toBe(3);
  });
  it('takes the closest tie when the two cells disagree', () => {
    expect(familyTierBetween({ '1-2': 'Nipote di', '2-1': 'Genitore di' }, 1, 2)).toBe(1);
  });
});

describe('coverCasts ranking', () => {
  // main child + 6 others created in this order
  const characters = [
    mk(1, 'Child', true), mk(2, 'Friend'), mk(3, 'Neighbour'), mk(4, 'Grandma'),
    mk(5, 'Cousin'), mk(6, 'Dad'), mk(7, 'Mum'),
  ];
  const inputData = (relationships: Record<string, string>) => ({ characters, mainCharacters: [1], relationships });

  it('the parents created last still make the cap (the production bug)', () => {
    const casts = coverCasts(inputData({
      '1-6': 'Figlio/a di', '1-7': 'Figlio/a di', '1-4': 'Nipote di', '1-2': 'Amici con',
    }));
    expect(casts.initialPage).toEqual(['Child', 'Dad', 'Mum', 'Grandma', 'Friend']);
    expect(casts.backCover).toEqual(casts.initialPage);
    expect(casts.frontCover).toEqual(['Child']);
  });

  it('with no relationships the old creation order stays', () => {
    expect(coverCasts(inputData({})).initialPage).toEqual(['Child', 'Friend', 'Neighbour', 'Grandma', 'Cousin']);
  });

  it('either direction of the matrix counts the same', () => {
    const casts = coverCasts(inputData({ '1-6': 'Genitore di', '7-1': 'Genitore di' }));
    expect(casts.initialPage.slice(1, 3)).toEqual(['Dad', 'Mum']);
  });

  it('de and fr labels rank like en', () => {
    const casts = coverCasts(inputData({ '6-1': 'Elternteil von', '1-7': 'Enfant de', '4-1': 'Grosselternteil von' }));
    expect(casts.initialPage).toEqual(['Child', 'Dad', 'Mum', 'Grandma', 'Friend']);
  });

  it('tier 1 beats tier 2 beats the rest; ties keep creation order', () => {
    const casts = coverCasts(inputData({ '1-5': 'Älteres Geschwister von', '1-4': 'Nonno/a di', '1-7': 'Genitore di' }));
    expect(casts.initialPage).toEqual(['Child', 'Mum', 'Grandma', 'Cousin', 'Friend']);
  });

  it('unknown labels and strangers do not rank', () => {
    const casts = coverCasts(inputData({ '1-7': 'Mother of', '1-6': 'Non si conoscono' }));
    expect(casts.initialPage).toEqual(['Child', 'Friend', 'Neighbour', 'Grandma', 'Cousin']);
  });

  it('keeps the cap', () => {
    const casts = coverCasts(inputData({ '1-6': 'Figlio/a di', '1-7': 'Figlio/a di' }));
    expect(casts.initialPage).toHaveLength(MAX_COVER_CHARACTERS);
  });

  it('a story within the cap shows the same people (order may change)', () => {
    const small = [mk(1, 'Child', true), mk(2, 'Friend'), mk(3, 'Dad')];
    const casts = coverCasts({ characters: small, mainCharacters: [1], relationships: { '1-3': 'Figlio/a di' } });
    expect(casts.initialPage).toEqual(['Child', 'Dad', 'Friend']);
  });

  it('works without a relationships field', () => {
    const casts = coverCasts({ characters, mainCharacters: [1] });
    expect(casts.initialPage).toHaveLength(MAX_COVER_CHARACTERS);
  });
});
