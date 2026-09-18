import { describe, it, expect } from 'vitest';

const {
  WORN_SLOTS, SLOT_NOUNS, parseWornAs, indexOfElementAmong,
  removeWornItemFromOutfit, resolveWornItemsForPage, resolveOutfitForPage, splitClauses,
  resolveGeneratedOutfit, wornAsEntries,
} = require('../../server/lib/wornItems');
const { auditVisualBibleContract } = require('../../server/lib/outlineParser/shared');

/**
 * A `wornAs` slot the writer invented no longer silently disables the strip.
 *
 * THE DEFECT (staging job_1789681157795_wkt20ckod, Levin, nine pages / 14
 * stored (page, item) pairs). The writer linked mittens as `Levin.hands` and a
 * scarf as `Levin.neck`. Neither is in WORN_SLOTS — both garments are
 * `accessories`, the one slot the authoring prompt never listed — so
 * `removeWornItemFromOutfit` hit `SLOT_NOUNS[key] === undefined`, returned
 * `unknown-slot` before anything else was tried, and stripped nothing on any of
 * the nine pages. The generator kept drawing the scarf the brief had wrapped
 * around something else and every clothing judge kept demanding it back.
 *
 * TWO HALVES, both pinned below.
 *   1. The resolver: the element's own declared words are asked BEFORE the
 *      unknown slot is allowed to end the attempt. That route never needed a
 *      slot. On the five pages where the scarf is off it now answers.
 *   2. The writer: `parseWornAs` marks the slot instead of accepting it
 *      silently, and the fault is reported at authoring time by
 *      `auditVisualBibleContract` and per page by `stripOffItemsFromOutfit`.
 *
 * Every string below is copied from stories.data on staging.
 */

// stories.data.visualBible.artifacts[1] and [2], verbatim (reference-image
// fields cut).
const ART002 = {
  id: 'ART002',
  name: 'red knitted mittens',
  type: 'handwear',
  label: 'red mittens',
  pages: [2, 6, 9],
  wornAs: 'Levin.hands',
  scaleClass: 'palm-sized',
  description: 'a pair of thick, bright red knitted wool mittens with a simple ribbed cuff',
  appearsInPages: [2, 6, 9],
};
const ART003 = {
  id: 'ART003',
  name: 'rust-orange wool scarf',
  type: 'neckwear',
  label: 'rust scarf',
  pages: [14, 15],
  wornAs: 'Levin.neck',
  scaleClass: 'forearm-sized',
  description: 'a long, thick knitted rust-orange wool scarf with fringed ends',
  appearsInPages: [14, 15],
};
const BIBLE = { artifacts: [ART002, ART003] };

// stories.data.clothingRequirements.Levin.standard.description, verbatim.
const LEVIN = 'A forest-green knitted pullover with a round neck and ribbed cuffs, worn over a white long-sleeve shirt whose cuffs show at the wrists; mid-blue denim jeans with a straight leg; brown lace-up ankle boots; a long rust-orange wool scarf wound twice around the neck with both ends hanging down the front; red knitted mittens on both hands.';

// What p14-p18 must resolve to: the scarf clause gone, every other garment
// intact — the mittens included, which the page ALSO declares off and which the
// element's own words cannot single out (see the refusal test below).
const LEVIN_WITHOUT_SCARF = 'A forest-green knitted pullover with a round neck and ribbed cuffs; worn over a white long-sleeve shirt whose cuffs show at the wrists; mid-blue denim jeans with a straight leg; brown lace-up ankle boots; red knitted mittens on both hands.';

// The pages' own brief METADATA `wornItems[]` rows and `characters`, verbatim.
const BOTH_OFF_PAGES = [
  { pageNumber: 14, cast: ['Levin'], mittens: 'no longer carried', scarf: 'wrapped completely around the cracking egg' },
  { pageNumber: 15, cast: ['Julian', 'Levin'], mittens: 'given to Tobias', scarf: 'spread out on the crumbly earth' },
  { pageNumber: 16, cast: ['Julian', 'Levin'], mittens: 'with Tobias, out of frame', scarf: 'left on the ground out of frame' },
  { pageNumber: 17, cast: ['Levin', 'Max', 'Kiaan'], mittens: 'given to Tobias', scarf: 'left on the ground out of frame' },
  { pageNumber: 18, cast: ['Levin', 'Julian', 'Max', 'Kiaan'], mittens: 'not visible', scarf: 'not visible' },
];
const metaFor = (p: typeof BOTH_OFF_PAGES[number]) => ({
  characters: p.cast,
  pageNumber: p.pageNumber,
  wornItems: [
    { id: 'ART002', owner: 'Levin', state: 'off', location: p.mittens, wearer: null },
    { id: 'ART003', owner: 'Levin', state: 'off', location: p.scarf, wearer: null },
  ],
});

// p9, verbatim: the mittens alone come off, the scarf stays on.
const P9_META = {
  characters: ['Levin'],
  pageNumber: 9,
  wornItems: [
    { id: 'ART002', owner: 'Levin', state: 'off', location: "held out in Levin's bare hands", wearer: null },
    { id: 'ART003', owner: 'Levin', state: 'worn', location: null, wearer: null },
  ],
};

describe('an invented wornAs slot — job_1789681157795_wkt20ckod', () => {
  it('pins the shape of the fault: neither slot exists, and both garments are accessories', () => {
    expect(WORN_SLOTS).not.toContain('hands');
    expect(WORN_SLOTS).not.toContain('neck');
    // The vocabulary that should have been named:
    expect(WORN_SLOTS).toContain('accessories');
    expect(SLOT_NOUNS.accessories).toContain('mittens');
    expect(SLOT_NOUNS.accessories).toContain('scarf');
    // And no slot vocabulary exists for what the writer wrote, which is what
    // made `removeWornItemFromOutfit` bail before trying anything else.
    expect(SLOT_NOUNS.hands).toBeUndefined();
    expect(SLOT_NOUNS.neck).toBeUndefined();
  });

  for (const page of BOTH_OFF_PAGES) {
    it(`p${page.pageNumber} — the scarf clause is cut and every other garment survives`, () => {
      const resolved = resolveWornItemsForPage(BIBLE, page.cast, metaFor(page), { pageNumber: page.pageNumber });
      expect(resolved.map((r: any) => `${r.id}:${r.state}:${r.slot}`)).toEqual(['ART002:off:hands', 'ART003:off:neck']);

      const { text, removals } = resolveOutfitForPage(LEVIN, resolved, 'Levin');
      expect(removals).toEqual([
        { id: 'ART002', slot: 'hands', removed: false, reason: 'unknown-slot' },
        { id: 'ART003', slot: 'neck', removed: true, reason: 'slot-clause' },
      ]);
      expect(text).toBe(LEVIN_WITHOUT_SCARF);
      expect(text).not.toMatch(/scarf/i);
      // Nothing else was taken with it.
      expect(text).toContain('forest-green knitted pullover');
      expect(text).toContain('white long-sleeve shirt');
      expect(text).toContain('mid-blue denim jeans');
      expect(text).toContain('brown lace-up ankle boots');
      expect(text).toContain('red knitted mittens');
    });

    it(`p${page.pageNumber} — the eval-side recompute reaches the same string`, () => {
      expect(resolveGeneratedOutfit(LEVIN, 'Levin', {
        visualBible: BIBLE, sceneMetadata: metaFor(page), pageNumber: page.pageNumber,
      })).toBe(LEVIN_WITHOUT_SCARF);
    });
  }

  it('p9 — only the mittens are off, and the contract is left exactly as written', () => {
    const resolved = resolveWornItemsForPage(BIBLE, ['Levin'], P9_META, { pageNumber: 9 });
    const { text, removals, swaps } = resolveOutfitForPage(LEVIN, resolved, 'Levin');
    expect(removals).toEqual([{ id: 'ART002', slot: 'hands', removed: false, reason: 'unknown-slot' }]);
    expect(text).toBe(LEVIN);
    // The scarf is WORN on this page, so it goes to the swap branch — which an
    // unknown slot also ends, and which now records the skip instead of
    // vanishing on a bare `continue`.
    expect(swaps).toEqual([{ id: 'ART003', slot: 'neck', applied: false, reason: 'unknown-slot' }]);
  });

  it('the mittens are REFUSED, not guessed: the element\'s own words point two ways', () => {
    // "mittens" and "red" single out the last clause; "wool" singles out the
    // scarf's clause, because the mittens' own description says "knitted wool
    // mittens" and the contract's mitten clause does not repeat the material.
    // Two discriminating terms pointing at two clauses is a refusal by design —
    // a wrong cut deletes a garment, a refusal only leaves a redundant mention.
    // Asked of the WHOLE contract, exactly as the resolver asks it: a term is
    // only evidence against every other clause of the same outfit.
    const clauses = splitClauses(LEVIN);
    expect(clauses).toHaveLength(6);
    expect(indexOfElementAmong(clauses, ART002)).toBe(-1);
    expect(indexOfElementAmong(clauses, ART003)).toBe(4);
    expect(clauses[4]).toContain('rust-orange wool scarf');
  });

  it('SENTINEL — without the element the same call still answers unknown-slot', () => {
    // i.e. the fix is the element route reaching an unknown slot, and nothing
    // else. An unknown slot with no element to ask is exactly as inert as before.
    expect(removeWornItemFromOutfit(LEVIN, 'neck', 'rust-orange wool scarf'))
      .toEqual({ text: LEVIN, removed: false, reason: 'unknown-slot' });
    expect(removeWornItemFromOutfit(LEVIN, 'neck', 'rust-orange wool scarf', { name: 'rust-orange wool scarf' }).removed)
      .toBe(true);
  });

  it('an unknown slot on a single-clause outfit still reports unknown-slot', () => {
    // The reason order is unchanged: `unknown-slot` outranks
    // `single-clause-outfit` exactly as it did before, because the element
    // route cannot answer on one clause either.
    const single = 'A long rust-orange wool scarf wound twice around the neck.';
    expect(removeWornItemFromOutfit(single, 'neck', ART003.name, ART003))
      .toEqual({ text: single, removed: false, reason: 'unknown-slot' });
  });

  it('an unknown slot whose element cannot discriminate reports unknown-slot, never a crash', () => {
    // A one-word name carries too few identifying terms to answer at all
    // (MIN_DISCRIMINATING_TERMS), so Route B is reached with no vocabulary.
    const res = removeWornItemFromOutfit(LEVIN, 'neck', 'scarf', { name: 'scarf' });
    expect(res.removed).toBe(false);
    expect(res.reason).toBe('unknown-slot');
    expect(res.text).toBe(LEVIN);
  });

  it('a slot-LABELLED contract refuses an invented slot and keeps every labelled part', () => {
    // stories.data on staging, job_1786193650012_7baiaeftb, Sarah — verbatim.
    // 401 of the 4,757 stored (page, character) pairs use this shape, so the
    // labelled route is not hypothetical; it reports `slot-not-in-contract`
    // for an invented slot, which is why the loud log keys on the SLOT and not
    // on the returned reason.
    const LABELLED = 'Headwear: none; top: white short-sleeved cotton blouse with a Peter Pan collar and three small front buttons at the neckline; bottom: a knee-length A-line skirt in burgundy cotton with a single front pleat; footwear: tan leather ankle-strap sandals with a low block heel; belt/waist: thin plaited burgundy cord belt tied at the waist in a bow knot; outer layer: a lightweight teal linen short-sleeved overshirt worn unbuttoned, hem reaching the hip.';
    expect(removeWornItemFromOutfit(LABELLED, 'neck', ART003.name, ART003))
      .toEqual({ text: LABELLED, removed: false, reason: 'slot-not-in-contract' });
    // A slot that IS labelled still comes out, unchanged by this fix.
    expect(removeWornItemFromOutfit(LABELLED, 'belt/waist', 'cord belt').removed).toBe(true);
  });

  it('an unknown slot cannot take a garment out of a layered clause it cannot split', () => {
    // Route A picks the clause, the clause holds two garments and the remainder
    // is not cleanly one of them, so the strip is refused rather than guessed.
    const layered = 'A long rust-orange wool scarf with fringed ends tucked into a grey shirt; brown lace-up ankle boots.';
    const res = removeWornItemFromOutfit(layered, 'neck', ART003.name, ART003);
    expect(res.removed).toBe(false);
    expect(res.text).toBe(layered);
  });
});

describe('parseWornAs marks an unknown slot instead of dropping the link', () => {
  it('flags the two stored values and accepts every canonical slot', () => {
    expect(parseWornAs('Levin.hands')).toEqual({ owner: 'Levin', slot: 'hands', slotKnown: false });
    expect(parseWornAs('Levin.neck')).toEqual({ owner: 'Levin', slot: 'neck', slotKnown: false });
    for (const slot of WORN_SLOTS) {
      expect(parseWornAs(`Lily.${slot}`)).toEqual({ owner: 'Lily', slot, slotKnown: true });
    }
    // Case and spacing are normalised before the membership test.
    expect(parseWornAs('Lily. HEADWEAR ')).toEqual({ owner: 'Lily', slot: 'headwear', slotKnown: true });
  });

  it('a malformed value is still null, and an unknown slot is still a link', () => {
    for (const bad of ['', null, undefined, 'Levin', '.headwear', 'Levin.', 7]) {
      expect(parseWornAs(bad as any)).toBeNull();
    }
    // THE POINT OF THE FLAG. Dropping the link here would un-enumerate the
    // entry: no "is NOT wearing" prompt line, no reference drop, no strip
    // attempt at all — strictly worse than the silent no-op it replaces.
    const entries = wornAsEntries(BIBLE);
    expect(entries.map((e: any) => `${e.id}:${e.slot}:${e.slotKnown}`))
      .toEqual(['ART002:hands:false', 'ART003:neck:false']);
  });

  it('the resolved per-page row carries the flag through', () => {
    const resolved = resolveWornItemsForPage(BIBLE, ['Levin'], P9_META, { pageNumber: 9 });
    expect(resolved.map((r: any) => r.slotKnown)).toEqual([false, false]);
  });
});

describe('auditVisualBibleContract reports an invented slot at authoring time', () => {
  it('names the entry, the invented slot and the closed vocabulary', () => {
    const found = auditVisualBibleContract(BIBLE).filter((f: any) => f.code === 'worn-as-unknown-slot');
    expect(found.map((f: any) => f.id)).toEqual(['ART002', 'ART003']);
    expect(found[0].category).toBe('artifacts');
    expect(found[0].message).toContain('Levin.hands');
    expect(found[0].message).toContain('accessories');
  });

  it('says nothing about a slot that exists, an entry with no link, or a broken bible', () => {
    const clean = {
      artifacts: [{ id: 'ART001', name: 'a hat', wornAs: 'Lily.headwear', appearsInPages: [1] }],
      clothing: [{ id: 'CLO001', name: 'a coat', appearsInPages: [1] }],
    };
    expect(auditVisualBibleContract(clean).filter((f: any) => f.code === 'worn-as-unknown-slot')).toHaveLength(0);
    for (const junk of [null, undefined, {}, { artifacts: 'not an array' }, { artifacts: [null, 7, {}] }]) {
      expect(auditVisualBibleContract(junk as any).filter((f: any) => f.code === 'worn-as-unknown-slot')).toHaveLength(0);
    }
  });

  it('reports, never repairs — the entry keeps the slot the writer wrote', () => {
    auditVisualBibleContract(BIBLE);
    expect(ART002.wornAs).toBe('Levin.hands');
    expect(ART003.wornAs).toBe('Levin.neck');
  });
});
