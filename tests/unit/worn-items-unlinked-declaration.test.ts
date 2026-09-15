import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveGeneratedOutfit, resolveWornItemsForPage, stripOffItemsFromOutfit, removeWornItemFromOutfit,
} = require('../../server/lib/wornItems.js');
const { log } = require('../../server/utils/logger.js');

// BEHAVIOUR PINNED: a page that declares a worn item `off` must strip that
// garment from BOTH sides — the outfit the generator sends the image model and
// the outfit every clothing judge scores against — driven by a Visual Bible of
// the shape the pipeline ACTUALLY PRODUCES.
//
// e403345b1 shipped the eval-side strip and was inert in practice. Measured on
// staging job_1789348171785_9oxos7dwv ("Vier Buben und ein Drachenei", 18
// pages): CLO001 is declared `off` on six pages, and three of them still carry
// MAJOR clothing findings — p14's reads "should wear a red zip-up hoodie over
// it per Clothing Contract" and came from four evaluator sources.
//
// The cause is the SHAPE of the stored bible. The resolver keyed everything on
// a `wornAs` link, which the story writer emits only for one narrow documented
// exception (a prop the plot turns into costume): 9 of 482 clothing/artifact/
// vehicle entries over 59 staging stories, and 0 of 6 `clothing`-pool entries —
// that pool carries `wornBy` + `howWorn` and has no slot field at all. The Art
// Director meanwhile declares a `wornItems` row for anything it sees worn: 32
// of 51 declared rows pointed at an unlinked id, 12 of them `off`, each
// silently stripping nothing.
//
// THE POINT OF THIS FILE: the previous test passed because its fixture supplied
// the `wornAs` link the pipeline does not produce. Every bible below is copied
// from the stored shape — no `wornAs` anywhere.

// CLO001 as stored, verbatim in shape: a clothing-pool entry naming its wearer
// in `wornBy`, with no `wornAs` and no slot.
const STORED_BIBLE = {
  clothing: [{
    id: 'CLO001',
    name: 'red zip-up hoodie',
    label: 'red hoodie',
    pages: [8, 10],
    wornBy: 'Levin',
    howWorn: 'tied loosely by the sleeves into a knot',
    description: 'A red zip-up hoodie sweatshirt with long sleeves and a soft hood, made of thick cotton.',
    appearsInPages: [8, 10],
  }],
  artifacts: [],
};

// The story-level outfit, the shape referencePhotos[].clothingDescription carries.
// Verbatim from the stored p9/p13/p14 referencePhotos[].clothingDescription.
// The declared garment is LAYERED over another in the SAME comma clause, which
// is the second half of this bug: dropping the whole clause takes the pullover
// with it and leaves the character with no top at all.
const LEVIN_OUTFIT = 'A red zip-up hoodie sweatshirt worn over a white long-sleeve pullover, dark grey cotton straight-leg trousers, and brown leather lace-up ankle boots.';

const pageMeta = (state: string, location: string | null = null) => ({
  pageNumber: 14,
  characters: ['Levin', 'Nico'],
  wornItems: [{ id: 'CLO001', owner: 'Levin', state, location: location ?? '' }],
});

afterEach(() => { vi.restoreAllMocks(); });

describe('a wornItems row with no writer `wornAs` link still strips the garment', () => {
  it('the eval clothing contract does not demand a garment the page declares off', () => {
    const contract = resolveGeneratedOutfit(LEVIN_OUTFIT, 'Levin', {
      visualBible: STORED_BIBLE,
      sceneMetadata: pageMeta('off', 'lies off camera'),
    });
    expect(contract).not.toMatch(/hoodie/i);
    // Only the declared garment goes. The garment it was layered OVER stays —
    // it shares the clause and was never declared off.
    expect(contract).toMatch(/white long-sleeve pullover/i);
    expect(contract).toMatch(/dark grey cotton straight-leg trousers/i);
    expect(contract).toMatch(/brown leather lace-up ankle boots/i);
  });

  it('the generator sends the image model the same stripped outfit', () => {
    // The two calls buildImagePrompt makes for `effectiveReferencePhotos`
    // (promptBuilders.js) — the generator and the judges share this resolver,
    // which is why one upstream fix moves both sides.
    const meta = pageMeta('off', 'lies off camera');
    const resolved = resolveWornItemsForPage(STORED_BIBLE, meta.characters, meta, { pageNumber: 14 });
    const off = resolved.filter((r: any) => r.state === 'off');
    expect(off).toHaveLength(1);
    expect(off[0].owner).toBe('Levin');
    expect(off[0].slot).toBe('top');

    const { text } = stripOffItemsFromOutfit(LEVIN_OUTFIT, resolved, 'Levin');
    expect(text).not.toMatch(/hoodie/i);
    expect(text).toMatch(/white long-sleeve pullover/i);
  });

  it('never takes an undeclared garment with it when the clause cannot be split', () => {
    // Two garments in one clause with no layering connective: no part of it can
    // go without removing something the page never declared off, so nothing
    // goes. The explicit "is NOT wearing" prompt line still carries the rule.
    const joined = 'A red zip-up hoodie and a white long-sleeve pullover, dark grey trousers.';
    const res = removeWornItemFromOutfit(joined, 'top', 'red zip-up hoodie');
    expect(res.removed).toBe(false);
    expect(res.reason).toBe('slot-clause-carries-another-garment');
    expect(res.text).toBe(joined);
  });

  it('drops the whole clause when the clause is only about the declared item', () => {
    const plain = 'A red zip-up hoodie, dark grey trousers, brown boots.';
    const res = removeWornItemFromOutfit(plain, 'top', 'red zip-up hoodie');
    expect(res.removed).toBe(true);
    expect(res.reason).toBe('slot-clause');
    expect(res.text).toBe('Dark grey trousers, brown boots.');
  });

  it('picks the right garment when two clauses share the slot', () => {
    // "hoodie" and "t-shirt" are both `top`; only the element NAME separates them.
    const two = 'A red zip-up hoodie, a navy t-shirt, dark grey trousers.';
    expect(removeWornItemFromOutfit(two, 'top', 'red zip-up hoodie').text)
      .toBe('A navy t-shirt, dark grey trousers.');
    expect(removeWornItemFromOutfit(two, 'top', 'navy t-shirt').text)
      .toBe('A red zip-up hoodie, dark grey trousers.');
    // Without a name the slot alone is ambiguous and nothing is removed.
    expect(removeWornItemFromOutfit(two, 'top').removed).toBe(false);
  });

  it('a page that declares the same item WORN keeps it in both contracts', () => {
    const meta = pageMeta('worn');
    expect(resolveGeneratedOutfit(LEVIN_OUTFIT, 'Levin', {
      visualBible: STORED_BIBLE, sceneMetadata: meta,
    })).toMatch(/hoodie/i);
    const resolved = resolveWornItemsForPage(STORED_BIBLE, meta.characters, meta, { pageNumber: 14 });
    expect(resolved.map((r: any) => r.state)).toEqual(['worn']);
  });

  it('a page that declares nothing leaves an unlinked entry alone', () => {
    // No declared row, no writer link: the item is not enumerated at all, so
    // the `removal_unstated` check's scope is unchanged by this fix.
    const meta = { pageNumber: 3, characters: ['Levin'], wornItems: [] };
    expect(resolveWornItemsForPage(STORED_BIBLE, meta.characters, meta, { pageNumber: 3 })).toEqual([]);
    expect(resolveGeneratedOutfit(LEVIN_OUTFIT, 'Levin', {
      visualBible: STORED_BIBLE, sceneMetadata: meta,
    })).toBe(LEVIN_OUTFIT);
  });

  it('only the declared owner\'s outfit is touched', () => {
    const other = 'Green anorak, black jeans, brown boots.';
    expect(resolveGeneratedOutfit(other, 'Nico', {
      visualBible: STORED_BIBLE, sceneMetadata: pageMeta('off', 'lies off camera'),
    })).toBe(other);
  });
});

describe('an unmappable `off` declaration fails loudly', () => {
  it('logs an error naming the page and the item id when the id is not in the bible', () => {
    const spy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const meta = { pageNumber: 7, characters: ['Levin'], wornItems: [{ id: 'CLO009', owner: 'Levin', state: 'off', location: 'on the bench' }] };
    resolveWornItemsForPage(STORED_BIBLE, meta.characters, meta, { pageNumber: 7 });
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain('Page 7');
    expect(msg).toContain('CLO009');
  });

  it('logs an error when no single outfit slot can be derived from the element name', () => {
    const spy = vi.spyOn(log, 'error').mockImplementation(() => {});
    // Shape of the stored artifact rows the Art Director declares off with no
    // writer link (a held prop, not a garment) — nothing can be stripped, and
    // that must be on the record rather than a silent no-op.
    const bible = { artifacts: [{ id: 'ART002', name: 'brass telescope', description: 'A brass telescope.' }] };
    const meta = { pageNumber: 11, characters: ['Levin'], wornItems: [{ id: 'ART002', owner: 'Levin', state: 'off', location: 'in his pack' }] };
    const resolved = resolveWornItemsForPage(bible, meta.characters, meta, { pageNumber: 11 });
    expect(resolved).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('ART002');
  });

  it('stays silent for a WORN declaration it cannot map — nothing was going to be stripped', () => {
    const spy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const meta = { pageNumber: 9, characters: ['Levin'], wornItems: [{ id: 'CLO009', owner: 'Levin', state: 'worn' }] };
    resolveWornItemsForPage(STORED_BIBLE, meta.characters, meta, { pageNumber: 9 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a linked entry still resolves through the writer\'s wornAs link', () => {
    // The prop-becomes-costume exception the writer does emit — unchanged.
    const bible = { artifacts: [{ id: 'ART008', name: 'red fabric sash', wornAs: 'Sarah.belt/waist' }] };
    const meta = { pageNumber: 12, characters: ['Sarah'], wornItems: [{ id: 'ART008', owner: 'Sarah', state: 'off', location: 'lost in the shaft' }] };
    const resolved = resolveWornItemsForPage(bible, meta.characters, meta, { pageNumber: 12 });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].slot).toBe('belt/waist');
  });
});
