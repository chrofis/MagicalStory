import { describe, it, expect } from 'vitest';

/**
 * WARDROBE-STATE AVATAR VARIANTS — the behaviour, not the wording.
 *
 * Measured on staging job_1789759147125_p08djwhbl (18 pages): three garments
 * flip across the story, `data.characterAvatars` held ONE sheet per character,
 * and on all nine jacket-off pages the only reference the model saw showed the
 * jacket ON. The render agreed with the picture, not with the brief.
 *
 * These pin: what the derivation asks for, which sheet a page resolves to,
 * the refusal that stops a sheet inventing a base layer, the slot budget being
 * untouched, and the carry-forward on a rewritten page.
 */
const {
  buildOffCategory, parseOffCategory, buildOffSlotKey, offIdsForCharacter,
  baseLayerHolds, deriveWardrobeVariantRequirements,
} = require('../../server/lib/wardrobeVariants');
const { projectStoryCharacterAvatars, resolveSheetForRef } = require('../../server/lib/storyAvatars');
const { carryForwardWornItems, resolveWornItemsForPage } = require('../../server/lib/wornItems');

// One character, one cap (headwear), one fleece (outer layer) over a named shirt.
const VB = {
  clothing: [
    { id: 'CLO001', name: 'red wool cap', wornBy: 'Levin', description: 'a chunky-knit red wool cap' },
    { id: 'CLO002', name: 'green fleece jacket', wornBy: 'Levin', description: 'a forest-green zip-up fleece jacket' },
    { id: 'CLO009', name: 'blue wool cap', wornBy: 'Julian', description: 'a blue cap' },
  ],
};
const CONTRACT =
  'A chunky-knit red wool cap; a forest-green zip-up fleece jacket; a long-sleeved white cotton shirt; '
  + 'dark navy corduroy trousers; brown leather ankle boots.';
const REQS = {
  Levin: { standard: { used: true, description: CONTRACT }, costumed: { used: false } },
  Julian: { standard: { used: true, description: 'A blue cap; a grey sweater; black jeans; red shoes.' }, costumed: { used: false } },
};
const CAST = [{ name: 'Levin' }, { name: 'Julian' }];

const page = (pageNumber: number, characters: string[], wornItems: any[]) =>
  ({ pageNumber, sceneMetadata: { characters, wornItems } });
const off = (id: string, owner: string, location = 'on the ground') =>
  ({ id, owner, state: 'off', wearer: null, location });
const worn = (id: string, owner: string) => ({ id, owner, state: 'worn', wearer: null, location: null });

describe('the key algebra is order-independent and reversible', () => {
  it('ids are sorted and upper-cased so page order cannot change the key', () => {
    expect(buildOffCategory('standard', ['clo002', 'CLO001'])).toBe('standard--off:CLO001+CLO002');
    expect(buildOffCategory('standard', ['CLO001', 'CLO002'])).toBe(buildOffCategory('standard', ['CLO002', 'CLO001']));
  });
  it('an empty off-set is just the base category', () => {
    expect(buildOffCategory('standard', [])).toBe('standard');
    expect(parseOffCategory('standard')).toBeNull();
  });
  it('parses back to the base and the set', () => {
    expect(parseOffCategory('styled-winter--off:CLO001+CLO002'))
      .toEqual({ baseCategory: 'styled-winter', offIds: ['CLO001', 'CLO002'] });
  });
});

describe('derivation — one row per OBSERVED distinct off-set', () => {
  const scenes = [
    page(1, ['Levin', 'Julian'], [worn('CLO001', 'Levin'), worn('CLO002', 'Levin')]),
    page(6, ['Levin'], [worn('CLO001', 'Levin'), off('CLO002', 'Levin')]),
    page(7, ['Levin'], [worn('CLO001', 'Levin'), off('CLO002', 'Levin')]),
    page(15, ['Levin'], [off('CLO001', 'Levin'), off('CLO002', 'Levin')]),
    page(18, ['Levin'], [off('CLO001', 'Levin'), worn('CLO002', 'Levin')]),
  ];
  const { requirements } = deriveWardrobeVariantRequirements({
    visualBible: VB, scenes, clothingRequirements: REQS, characters: CAST,
  });

  it('asks for exactly the distinct off-sets, never the power set', () => {
    expect(requirements.map(r => r.clothingCategory).sort()).toEqual([
      'standard--off:CLO001',
      'standard--off:CLO001+CLO002',
      'standard--off:CLO002',
    ]);
  });

  it('two pages with the same off-set share one variant', () => {
    const row = requirements.find(r => r.clothingCategory === 'standard--off:CLO002');
    expect(row.pages).toEqual([6, 7]);
  });

  it('the variant belongs to the character whose garment flipped, and to no other', () => {
    expect([...new Set(requirements.map(r => r.characterNames[0]))]).toEqual(['Levin']);
  });

  it("a garment flipping for one character produces no variant for another's identical slot", () => {
    const { requirements: julianOnly } = deriveWardrobeVariantRequirements({
      visualBible: VB,
      scenes: [page(3, ['Levin', 'Julian'], [off('CLO009', 'Julian')])],
      clothingRequirements: REQS, characters: CAST,
    });
    expect(julianOnly.map(r => `${r.characterNames[0]}:${r.clothingCategory}`))
      .toEqual(['Julian:standard--off:CLO009']);
  });

  it("the variant's outfit is the contract with the clause deleted — nothing invented", () => {
    const row = requirements.find(r => r.clothingCategory === 'standard--off:CLO002');
    expect(row.clothingDescription).not.toMatch(/fleece/i);
    // The layer underneath is still NAMED, and every untouched clause survives.
    expect(row.clothingDescription).toMatch(/white cotton shirt/i);
    expect(row.clothingDescription).toMatch(/red wool cap/i);
    expect(row.clothingDescription).toMatch(/ankle boots/i);
  });

  it('a story where nothing comes off asks for no variants at all', () => {
    const { requirements: none } = deriveWardrobeVariantRequirements({
      visualBible: VB,
      scenes: [page(1, ['Levin'], [worn('CLO001', 'Levin'), worn('CLO002', 'Levin')])],
      clothingRequirements: REQS, characters: CAST,
    });
    expect(none).toEqual([]);
  });
});

describe('no invented layer — the refusal', () => {
  it('removing an outer layer with no top named underneath yields NO requirement row', () => {
    const bare = {
      Levin: { standard: { used: true, description: 'A forest-green zip-up fleece jacket; dark navy corduroy trousers; brown leather ankle boots.' }, costumed: { used: false } },
    };
    const { requirements, refusals } = deriveWardrobeVariantRequirements({
      visualBible: VB,
      scenes: [page(11, ['Levin'], [off('CLO002', 'Levin')])],
      clothingRequirements: bare, characters: [{ name: 'Levin' }],
    });
    expect(requirements).toEqual([]);
    expect(refusals[0].reason).toBe('unnamed-base-layer');
  });

  it('a hat needs nothing underneath — a bare head is not an invented garment', () => {
    expect(baseLayerHolds('a grey sweater; black jeans.', ['headwear']).ok).toBe(true);
    expect(baseLayerHolds('a grey sweater; black jeans.', ['accessories']).ok).toBe(true);
  });

  it('a removed torso layer needs a top, a removed bottom needs a bottom', () => {
    expect(baseLayerHolds('black jeans; red shoes.', ['outer layer']).ok).toBe(false);
    expect(baseLayerHolds('a grey sweater; red shoes.', ['bottom']).ok).toBe(false);
    expect(baseLayerHolds('a grey sweater; black jeans.', ['outer layer']).ok).toBe(true);
  });
});

describe('sheet resolution — the variant, or the base sheet said out loud', () => {
  const sheets = (extra: Record<string, string> = {}) => projectStoryCharacterAvatars([{
    name: 'Levin',
    avatars: { styledAvatars: { pixar: { standard: 'data:image/png;base64,BASE', ...extra } } },
  }], 'pixar').Levin;

  const wornRows = (items: any[]) =>
    resolveWornItemsForPage(VB, ['Levin'], { characters: ['Levin'], wornItems: items }, { pageNumber: 6 });

  it('projects the variant under the same styled- rule as the base categories', () => {
    const s = sheets({ 'standard--off:CLO002': 'data:image/png;base64,OFF' });
    expect(s['styled-standard--off:CLO002']).toBe('data:image/png;base64,OFF');
    expect(s['styled-standard']).toBe('data:image/png;base64,BASE');
  });

  it('serves the --off: sheet when the page declares that garment off', () => {
    const ref: any = { name: 'Levin', clothingCategory: 'standard' };
    const r = resolveSheetForRef(sheets({ 'standard--off:CLO002': 'data:image/png;base64,OFF' }), ref,
      { wornResolved: wornRows([off('CLO002', 'Levin')]) });
    expect(r.slotKey).toBe('styled-standard--off:CLO002');
    expect(r.uri).toBe('data:image/png;base64,OFF');
  });

  it('a page that takes nothing off still gets the base sheet', () => {
    const ref: any = { name: 'Levin', clothingCategory: 'standard' };
    const r = resolveSheetForRef(sheets({ 'standard--off:CLO002': 'data:image/png;base64,OFF' }), ref,
      { wornResolved: wornRows([worn('CLO002', 'Levin')]) });
    expect(r.slotKey).toBe('styled-standard');
  });

  it('falls back to the base sheet when no variant exists — and SAYS SO on the ref', () => {
    const ref: any = { name: 'Levin', clothingCategory: 'standard' };
    const r = resolveSheetForRef(sheets(), ref, { wornResolved: wornRows([off('CLO002', 'Levin')]) });
    expect(r.slotKey).toBe('styled-standard');
    // Same honesty contract as the costumed fallback: the reference reports what
    // it actually carries, so nothing downstream can believe the garment is off.
    expect(ref.wornStateFallback).toEqual({ offIds: ['CLO002'], wanted: 'styled-standard--off:CLO002' });
  });

  it('the served ref reports the state it actually carries', () => {
    const ref: any = { name: 'Levin', clothingCategory: 'standard' };
    resolveSheetForRef(sheets({ 'standard--off:CLO002': 'data:image/png;base64,OFF' }), ref,
      { wornResolved: wornRows([off('CLO002', 'Levin')]) });
    expect(ref.clothingCategory).toBe('standard--off:CLO002');
    expect(ref.wornOffIds).toEqual(['CLO002']);
  });

  it('a costumed page is untouched by wardrobe state', () => {
    const story = { costumed: 'data:image/png;base64,COS', 'styled-standard': 'data:image/png;base64,BASE' };
    const ref: any = { name: 'Levin', clothingCategory: 'costumed:pirate' };
    const r = resolveSheetForRef(story, ref, { wornResolved: wornRows([off('CLO002', 'Levin')]) });
    expect(r.slotKey).toBe('costumed');
  });
});

describe('slot budget — a variant is a SUBSTITUTION, never an extra reference', () => {
  it('a 4-character page resolves the same number of sheets with and without a variant', () => {
    const names = ['Levin', 'Julian', 'Max', 'Kiaan'];
    const build = (withVariant: boolean) => Object.fromEntries(names.map(n => [n, {
      'styled-standard': `data:image/png;base64,${n}`,
      ...(withVariant && n === 'Levin' ? { 'styled-standard--off:CLO002': 'data:image/png;base64,OFF' } : {}),
    }]));
    const resolveAll = (withVariant: boolean) => names.map(n => resolveSheetForRef(
      build(withVariant)[n],
      { name: n, clothingCategory: 'standard' },
      { wornResolved: n === 'Levin'
        ? resolveWornItemsForPage(VB, ['Levin'], { characters: ['Levin'], wornItems: [off('CLO002', 'Levin')] }, { pageNumber: 6 })
        : [] },
    )).filter(Boolean);

    const without = resolveAll(false);
    const withIt = resolveAll(true);
    expect(withIt.length).toBe(without.length);
    expect(withIt.length).toBe(4);
    // Exactly one sheet differs: the substituted cell. Nothing was added.
    expect(withIt.filter((r, i) => r.uri !== without[i].uri).length).toBe(1);
  });
});

describe('carry-through on a rewritten page', () => {
  it('an iterate rewrite that emits no wornItems still resolves to the same variant', () => {
    const saved = { wornItems: [off('CLO002', 'Levin')] };
    const rewritten = { characters: ['Levin'], wornItems: [] };   // scene-iteration.txt emits none
    const carried = carryForwardWornItems(rewritten, saved);
    const resolved = resolveWornItemsForPage(VB, ['Levin'], { ...rewritten, wornItems: carried }, { pageNumber: 6 });
    expect(offIdsForCharacter('Levin', resolved)).toEqual(['CLO002']);

    const story = {
      'styled-standard': 'data:image/png;base64,BASE',
      'styled-standard--off:CLO002': 'data:image/png;base64,OFF',
    };
    const r = resolveSheetForRef(story, { name: 'Levin', clothingCategory: 'standard' }, { wornResolved: resolved });
    expect(r.slotKey).toBe('styled-standard--off:CLO002');
  });

  it('without the carry-forward the rewrite would fall back to the WORN sheet', () => {
    const rewritten = { characters: ['Levin'], wornItems: [] };
    const resolved = resolveWornItemsForPage(VB, ['Levin'], rewritten, { pageNumber: 6 });
    expect(offIdsForCharacter('Levin', resolved)).toEqual([]);
  });
});

describe('held artifacts stay out of scope', () => {
  it('an element that maps to no outfit slot contributes no off-set', () => {
    const vb = { artifacts: [{ id: 'ART001', name: 'speckled egg', wornBy: 'Levin', description: 'a speckled egg' }] };
    const resolved = resolveWornItemsForPage(vb, ['Levin'],
      { characters: ['Levin'], wornItems: [off('ART001', 'Levin')] }, { pageNumber: 9 });
    expect(offIdsForCharacter('Levin', resolved)).toEqual([]);
  });
});

describe('the slot key and the clothing category share one algebra', () => {
  it('buildOffSlotKey is buildOffCategory applied to a slot key', () => {
    expect(buildOffSlotKey('styled-standard', ['CLO002'])).toBe('styled-standard--off:CLO002');
  });
});
