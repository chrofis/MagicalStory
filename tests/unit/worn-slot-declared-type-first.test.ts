/**
 * `deriveSlotFromName` — what it decides, and who is allowed to overrule it.
 *
 * Audit of 2026-09-18 ("does code do the job that belongs to the prompt?").
 * `deriveSlotFromName` regex-matches garment nouns out of a Visual Bible
 * element's NAME to pick an outfit slot. Two things were measured over every
 * stored staging + production story (937 + 777 elements in the
 * artifacts/clothing/vehicles pools):
 *
 *   1. It IS wrong in principle. It derives a slot for 64 staging elements and
 *      4 of those are props, not garments — job_1788551692337_bc479p945 ART004
 *      "bottle cap" and job_1785513128428_fw26s7r7y ART003 "Gessler's hat pole"
 *      land in headwear, job_1789207854566_l43qgl34w ART007 "Knotted sash line"
 *      in belt/waist.
 *   2. NONE of the four reached a consumer, so the shipped damage is zero: the
 *      page resolver only ever asks about an id the Art Director declared in
 *      `wornItems[]`, and the two sweeping call sites apply a second gate.
 *
 * The fix committed with this file is the narrow one the evidence supports: the
 * page resolver's source-2 path (a declared row pointing at an element the
 * writer never linked — the path that strips and swaps a rendered outfit line)
 * now reads the element's DECLARED `type` first and falls back to the name
 * regex, which is what its sibling `unlinkedWornCandidates` has always done.
 * Over all stored data the two sources never disagreed, so no shipped outfit
 * changes; what goes away is the fork where one file slotted one element two
 * ways.
 *
 * Retiring the regex outright is a prompt-vs-code decision and is NOT made
 * here. The measurement that decides it is pinned below: declared `type` alone
 * would answer only 11 of 37 stored source-2 resolutions on staging and 0 of 2
 * on production, so a straight deletion makes the removable-worn-item path
 * inert again.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore - CommonJS module
const {
  deriveSlotFromName, slotFromType, SLOT_NOUNS, WORN_SLOTS,
  resolveWornItemsForPage, unlinkedWornCandidates, stripOffItemsFromOutfit,
} = require('../../server/lib/wornItems');

describe('the closed vocabulary is self-consistent', () => {
  it('maps every garment noun back to its own slot', () => {
    const wrong: string[] = [];
    for (const slot of WORN_SLOTS) {
      for (const noun of (SLOT_NOUNS[slot] || [])) {
        if (deriveSlotFromName(noun) !== slot) wrong.push(`${noun} -> ${deriveSlotFromName(noun)} (declared ${slot})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('answers null when a name lands in two slots at once', () => {
    expect(deriveSlotFromName('a leather belt and a wool hat')).toBeNull();
    expect(deriveSlotFromName('')).toBeNull();
    expect(deriveSlotFromName('a heavy mooring rope')).toBeNull();
  });
});

describe('the matcher mis-slots props — the measured limitation, on the record', () => {
  // These are real stored staging names. The assertion is deliberately the
  // WRONG answer: it is what the function does today, and it is the regression
  // net for whichever prompt-side or code-side fix the owner rules on. If a
  // later change makes any of these null, this test is the place to record it.
  it.each([
    ['bottle cap', 'headwear', 'job_1788551692337_bc479p945 ART004'],
    ["Gessler's hat pole", 'headwear', 'job_1785513128428_fw26s7r7y ART003'],
    ['Knotted sash line', 'belt/waist', 'job_1789207854566_l43qgl34w ART007'],
  ])('"%s" derives %s (%s)', (name, slot) => {
    expect(deriveSlotFromName(name as string)).toBe(slot);
  });

  it('but a prop never becomes an unlinked worn candidate on the name alone', () => {
    // No declared slot type, and no character outfit names a "bottle cap" —
    // the second gate is what kept every one of the four out of the pipeline.
    const vb = { artifacts: [{ id: 'ART004', name: 'bottle cap', type: 'screw-on bottle cap' }] };
    expect(unlinkedWornCandidates(vb, new Map(Object.entries({
      Levin: 'A red T-shirt, blue denim shorts and white canvas sneakers.',
    })))).toHaveLength(0);
  });

  it('and is never resolved for a page the Art Director did not declare it on', () => {
    const vb = { artifacts: [{ id: 'ART004', name: 'bottle cap', type: 'screw-on bottle cap', wornBy: 'Levin' }] };
    expect(resolveWornItemsForPage(vb, ['Levin'], { wornItems: [] })).toHaveLength(0);
  });
});

describe('source 2 — a declared row on an element the writer never linked', () => {
  const page = (rows: any[]) => ({ pageNumber: 8, wornItems: rows });

  it('takes the slot from the declared type, not from the name', () => {
    // The name says "top" (hoodie); the Art Director typed it "outer layer".
    // The declaration wins — it is the AD's own word for what the element is.
    const vb = { artifacts: [{ id: 'ART004', name: 'red hoodie jacket shell', type: 'outer layer', wornBy: 'Levin' }] };
    const r = resolveWornItemsForPage(vb, ['Levin'], page([{ id: 'ART004', owner: 'Levin', state: 'off', location: 'on the bench' }]));
    expect(r).toHaveLength(1);
    expect(r[0].slot).toBe('outer layer');
    expect(r[0].wornAsLinked).toBe(false);
  });

  it('falls back to the name when the type is free prose', () => {
    // Real staging shape: job_1789163494908_kc2joi4ax ART004, type "garment".
    const vb = { artifacts: [{ id: 'ART004', name: "Kiaan's Anorak", type: 'garment', wornBy: 'Kiaan' }] };
    const r = resolveWornItemsForPage(vb, ['Kiaan'], page([{ id: 'ART004', owner: 'Kiaan', state: 'off', location: 'tied round his waist' }]));
    expect(r).toHaveLength(1);
    expect(r[0].slot).toBe('outer layer');
  });

  it('agrees with unlinkedWornCandidates on the same element — one answer per file', () => {
    const entry = { id: 'ART004', name: 'red hoodie jacket shell', type: 'outer layer', wornBy: 'Levin' };
    const vb = { artifacts: [entry] };
    const resolved = resolveWornItemsForPage(vb, ['Levin'], page([{ id: 'ART004', owner: 'Levin', state: 'worn' }]));
    const [candidate] = unlinkedWornCandidates(vb, new Map());
    expect(candidate.slot).toBe(resolved[0].slot);
  });

  it('still strips the right clause once the slot is declared', () => {
    const vb = { artifacts: [{ id: 'ART004', name: 'red hoodie jacket shell', type: 'outer layer', wornBy: 'Levin' }] };
    const r = resolveWornItemsForPage(vb, ['Levin'], page([{ id: 'ART004', owner: 'Levin', state: 'off', location: 'on the bench' }]));
    const outfit = 'A red hooded jacket shell; a white long-sleeve pullover; dark grey trousers; brown ankle boots.';
    const { text } = stripOffItemsFromOutfit(outfit, r, 'Levin');
    expect(text).not.toMatch(/jacket/i);
    expect(text).toMatch(/pullover/i);
    expect(text).toMatch(/trousers/i);
    expect(text).toMatch(/boots/i);
  });

  it('leaves an element unmappable when neither type nor name is a slot', () => {
    // Real staging shape: job_1789301291267_ueh8h145m ART002 "Brass telescope"
    // was declared `worn`. Nothing is stripped, and nothing is guessed.
    const vb = { artifacts: [{ id: 'ART002', name: 'Brass telescope', type: 'tool', wornBy: 'Emma' }] };
    expect(resolveWornItemsForPage(vb, ['Emma'], page([{ id: 'ART002', owner: 'Emma', state: 'worn' }]))).toHaveLength(0);
  });
});

describe('declared type cannot replace the name regex — the number the deletion question turns on', () => {
  // The five stored staging elements that actually drove a source-2 outfit
  // change and whose `type` answers nothing. Deleting deriveSlotFromName and
  // keeping slotFromType would silently take all five out of the pipeline.
  it.each([
    ["Levin's backpack", "child's canvas backpack", 'accessories'],
    ["Max's green pullover bundle", 'garment used as wrapping', 'top'],
    ["Kiaan's Anorak", 'garment', 'outer layer'],
    ["Sarah's Scarf", 'oversized knitted scarf', 'accessories'],
    ['red zip-up hoodie', '', 'top'],
  ])('"%s" (type "%s") is slotted only by its name', (name, type, slot) => {
    expect(slotFromType(type as string)).toBeNull();
    expect(deriveSlotFromName(name as string)).toBe(slot);
  });
});
