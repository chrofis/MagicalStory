/**
 * A worn Visual Bible element's outfit slot is the typed `slot` field its
 * author wrote (docs/decisions.md, 2026-10-09). `deriveSlotFromName` - a noun
 * regex over the element NAME that slotted props ("bottle cap", a pole that
 * carries a hat, a knotted line) as clothing - is deleted. Replaces
 * worn-slot-declared-type-first.test.ts, which pinned that function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// @ts-ignore - CommonJS module
const W = require('../../server/lib/wornItems');
const {
  elementSlot, slotFromType, slotOfOutfitText, SLOT_NOUNS, WORN_SLOTS,
  resolveWornItemsForPage, unlinkedWornCandidates, stripOffItemsFromOutfit, trackedWornGarments,
} = W;

describe('the name guess is gone', () => {
  it('wornItems no longer exports deriveSlotFromName', () => {
    expect(W.deriveSlotFromName).toBeUndefined();
  });
  it('no server file calls it', () => {
    for (const f of ['wornItems', 'clothingCheck', 'coverIterate']) {
      const src = readFileSync(join(__dirname, `../../server/lib/${f}.js`), 'utf8');
      expect(src.replace(/`deriveSlotFromName`/g, ''), f).not.toMatch(/deriveSlotFromName\(/);
    }
  });
});

describe('elementSlot - declared fields only', () => {
  it('prefers the wornAs slot, then the typed slot, then a slot-named type', () => {
    expect(elementSlot({ wornAs: 'Max.footwear', slot: 'top', type: 'hat' })).toBe('footwear');
    expect(elementSlot({ slot: 'headwear', type: 'coat' })).toBe('headwear');
    expect(elementSlot({ type: 'coat' })).toBe('outer layer');
  });
  it('is null for a prop, whatever its name says', () => {
    for (const name of ['bottle cap', 'pole that carries a hat', 'knotted sash line', 'coat-rope']) {
      expect(elementSlot({ name, label: name, type: 'object' }), name).toBeNull();
    }
  });
  it('ignores a slot that is not in the closed list', () => {
    expect(elementSlot({ name: 'wool scarf', slot: 'neck' })).toBeNull();
  });
});

describe('slotOfOutfitText - outfit text only, closed garment nouns', () => {
  it('maps every garment noun back to its own slot', () => {
    const wrong: string[] = [];
    for (const slot of WORN_SLOTS) {
      for (const noun of (SLOT_NOUNS[slot] || [])) {
        if (slotOfOutfitText(noun) !== slot) wrong.push(`${noun} -> ${slotOfOutfitText(noun)} (declared ${slot})`);
      }
    }
    expect(wrong).toEqual([]);
  });
  it('answers null when the text lands in two slots or none', () => {
    expect(slotOfOutfitText('a leather belt and a wool hat')).toBeNull();
    expect(slotOfOutfitText('')).toBeNull();
    expect(slotOfOutfitText('a heavy mooring rope')).toBeNull();
  });
});

describe('unlinkedWornCandidates - a candidate declares its slot', () => {
  it('a prop with a slot-sounding name is not a candidate (the three measured stored names)', () => {
    const vb = { artifacts: [
      { id: 'ART001', name: 'bottle cap', type: 'screw-on bottle cap' },
      { id: 'ART002', name: 'pole that carries a hat', type: 'pole' },
      { id: 'ART003', name: 'knotted sash line', type: 'rope' },
    ] };
    expect(unlinkedWornCandidates(vb, new Map(Object.entries({ Levin: 'A red T-shirt, a cap, a sash.' })))).toHaveLength(0);
  });
  it('a typed element is a candidate, and an outfit noun of its slot finds the owner', () => {
    const vb = { artifacts: [{ id: 'ART005', name: 'red wool cap', slot: 'headwear' }] };
    const [c] = unlinkedWornCandidates(vb, new Map(Object.entries({ Levin: 'A red wool cap, blue trousers.', Max: 'A green coat.' })));
    expect(c).toMatchObject({ id: 'ART005', slot: 'headwear', owner: 'Levin', reason: 'outfit' });
  });
  it('the same element without the slot field (a bible stored before it existed) is skipped', () => {
    const vb = { artifacts: [{ id: 'ART005', name: 'red wool cap' }] };
    expect(unlinkedWornCandidates(vb, new Map(Object.entries({ Levin: 'A red wool cap.' })))).toHaveLength(0);
  });
});

describe('source 2 - a declared row on an element the writer never linked', () => {
  const page = (rows: any[]) => ({ pageNumber: 8, wornItems: rows });
  const offRow = (id: string, owner: string) => ({ id, owner, state: 'off', location: 'on the bench' });

  it('takes the slot from the typed field, not from the name', () => {
    const vb = { artifacts: [{ id: 'ART004', name: 'red hoodie jacket shell', slot: 'outer layer', wornBy: 'Levin' }] };
    const r = resolveWornItemsForPage(vb, ['Levin'], page([offRow('ART004', 'Levin')]));
    expect(r).toHaveLength(1);
    expect(r[0].slot).toBe('outer layer');
    expect(r[0].wornAsLinked).toBe(false);
  });
  it('agrees with unlinkedWornCandidates and trackedWornGarments on the same element', () => {
    const vb = { artifacts: [{ id: 'ART004', name: 'red hoodie jacket shell', slot: 'outer layer', wornBy: 'Levin' }] };
    const resolved = resolveWornItemsForPage(vb, ['Levin'], page([{ id: 'ART004', owner: 'Levin', state: 'worn' }]));
    const [cand] = unlinkedWornCandidates(vb, new Map());
    const tracked = trackedWornGarments(vb, [[{ id: 'ART004', owner: 'Levin', state: 'worn' }]]);
    expect(cand.slot).toBe(resolved[0].slot);
    expect(tracked.get('ART004').slot).toBe(resolved[0].slot);
  });
  it('still strips the right clause', () => {
    const vb = { artifacts: [{ id: 'ART004', name: 'red hoodie jacket shell', slot: 'outer layer', wornBy: 'Levin' }] };
    const r = resolveWornItemsForPage(vb, ['Levin'], page([offRow('ART004', 'Levin')]));
    const { text } = stripOffItemsFromOutfit('A red hooded jacket shell; a white long-sleeve pullover; dark grey trousers; brown ankle boots.', r, 'Levin');
    expect(text).not.toMatch(/jacket/i);
    expect(text).toMatch(/pullover/i);
    expect(text).toMatch(/boots/i);
  });
  it.each([
    ["Levin's backpack", 'accessories'], ["Max's green pullover bundle", 'top'],
    ["Kiaan's Anorak", 'outer layer'], ['red zip-up hoodie', 'top'],
  ])('"%s" was slotted only by its name; without the typed field it is unmappable, with it it maps', (name, slot) => {
    const bare = { artifacts: [{ id: 'ART004', name, wornBy: 'Levin' }] };
    expect(resolveWornItemsForPage(bare, ['Levin'], page([offRow('ART004', 'Levin')]))).toHaveLength(0);
    const typed = { artifacts: [{ id: 'ART004', name, slot, wornBy: 'Levin' }] };
    expect(resolveWornItemsForPage(typed, ['Levin'], page([offRow('ART004', 'Levin')]))[0].slot).toBe(slot);
  });
  it('an element with no slot stays unmappable', () => {
    const vb = { artifacts: [{ id: 'ART002', name: 'Brass telescope', type: 'tool', wornBy: 'Emma' }] };
    expect(resolveWornItemsForPage(vb, ['Emma'], page([{ id: 'ART002', owner: 'Emma', state: 'worn' }]))).toHaveLength(0);
  });
});

describe('the authoring prompts carry the slot rule from one constant', () => {
  it('visual-bible.txt and story-trial.txt both take {WORN_SLOT}, filled from WORN_SLOT_FIELD_RULE', () => {
    for (const f of ['visual-bible', 'story-trial']) {
      expect(readFileSync(join(__dirname, `../../prompts/${f}.txt`), 'utf8'), f).toContain('{WORN_SLOT}');
    }
    for (const s of WORN_SLOTS) expect(W.WORN_SLOT_FIELD_RULE).toContain('`' + s + '`');
  });
  it('slotFromType still maps a slot-named type', () => {
    expect(slotFromType('boots')).toBe('footwear');
  });
});
