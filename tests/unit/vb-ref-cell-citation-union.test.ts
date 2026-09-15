import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getElementReferenceImagesForPage } = require('../../server/lib/visualBible.js');

// A reference-cell claim resolves from the UNION of a page's objects[] and
// characters[] (2026-09-14). 41cde02d0 established that union for the REQUIRED
// OBJECTS text block only; the reference-cell grid still read the raw
// objects[], so a repair rewrite that reclassified an animal into characters[]
// silently dropped its cell and the page rendered it from imagination.
//
// Every entity below declares appearsInPages that does NOT cover the page under
// test — that is the residual population this fix rescues (the bible's own page
// list already covers the rest).
const ANI001 = {
  id: 'ANI001',
  name: 'Funkli',
  appearsInPages: [1, 2],
  description: 'A small copper-scaled dragon the size of a cat.',
  referenceImageUrl: 'https://example.invalid/ani001.jpg',
};
const ART003 = {
  id: 'ART003',
  name: 'Brass lantern',
  appearsInPages: [1, 2],
  description: 'A square brass lantern with four glass panes.',
  referenceImageUrl: 'https://example.invalid/art003.jpg',
};
// A garment that is part of a character's own outfit: the avatar reference
// already wears it, so it must never get a standalone cell (owner 2026-09-06).
const ART009 = {
  id: 'ART009',
  name: "Lily's red woollen hat",
  wornAs: 'Lily.headwear',
  appearsInPages: [1, 2],
  description: 'A chunky-knit red hat with a turned-back brim.',
  referenceImageUrl: 'https://example.invalid/art009.jpg',
};
const CHR002 = {
  id: 'CHR002',
  name: 'Levin',
  appearsInPages: [1, 2],
  description: 'A boy of eight in a blue coat.',
  referenceImageUrl: 'https://example.invalid/chr002.jpg',
};
const VB = {
  animals: [ANI001],
  artifacts: [ART003, ART009],
  secondaryCharacters: [CHR002],
  vehicles: [],
  locations: [],
};

const PAGE = 7; // covered by no entity's appearsInPages
const idsOf = (refs: any[]) => refs.map(r => r.id).sort();

describe('reference-cell grid — citation union of objects[] and characters[]', () => {
  it('an animal reclassified into characters[] keeps its reference-cell claim', () => {
    const meta = { characters: ['Funkli [ANI001]', { name: 'Levin' }], objects: [] };
    const refs = getElementReferenceImagesForPage(VB, PAGE, 4, meta.objects, meta);
    expect(idsOf(refs)).toEqual(['ANI001']);
  });

  it('NEGATIVE CONTROL: a human cast member in characters[] gains no cell', () => {
    const meta = { characters: ['Levin', 'Julian [CHR002]'], objects: [] };
    const refs = getElementReferenceImagesForPage(VB, PAGE, 4, meta.objects, meta);
    expect(refs).toEqual([]);
  });

  it('NEGATIVE CONTROL: a worn garment named in a character\'s clothing line gets NO standalone cell', () => {
    const meta = {
      characters: [{ name: 'Lily', clothing: 'standard' }, 'ART009'],
      objects: [],
      wornItems: [{ id: 'ART009', owner: 'Lily', state: 'worn' }],
    };
    const refs = getElementReferenceImagesForPage(VB, PAGE, 4, meta.objects, meta);
    expect(idsOf(refs)).not.toContain('ART009');
  });

  it('an entity cited in objects[] behaves exactly as before (no-op guarantee)', () => {
    const meta = { characters: ['Levin'], objects: ['ART003'] };
    const before = getElementReferenceImagesForPage(VB, PAGE, 4, ['ART003'], null);
    const after = getElementReferenceImagesForPage(VB, PAGE, 4, meta.objects, meta);
    expect(idsOf(before)).toEqual(['ART003']);
    expect(idsOf(after)).toEqual(['ART003']);
  });
});
