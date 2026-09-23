import { describe, it, expect, vi } from 'vitest';

// @ts-ignore - CommonJS module
const { applyCoverWornHeldDedupe } = require('../../server/lib/coverIterate');

const SARAH_CLOTHING = "A long navy-blue wool captain’s coat with brass buttons; a white linen high-collar blouse; black wool straight trousers; black leather knee-high captain’s boots; a black tricorn hat with yellow braid trim";

const photos = (clothing = SARAH_CLOTHING) => [{ name: 'Sarah', clothingDescription: clothing }];

const cap = {
  id: 'ART002', name: "navy-blue captain's cap", label: "captain's cap", type: 'headwear',
  description: "a navy-blue wool captain's cap with a stiff black visor and a gold anchor emblem.",
};

describe('cover worn/held dedupe — duplicate vs slot conflict', () => {
  it('no longer suppresses a different-slot near-miss as a duplicate', () => {
    // "captain's cap" token-matches the "captain’s coat" segment by construction
    // (shared name token). It is headwear, the segment is an outer layer:
    // neither is the other, so the cap keeps its reference cell and the outfit
    // text is left alone.
    const out = applyCoverWornHeldDedupe(photos(), { characterDetails: {} }, { artifacts: [cap] });
    expect(out.excludeElementIds).not.toContain('ART002');
    expect(out.photos[0].clothingDescription).toBe(SARAH_CLOTHING);
  });

  it('prefers the Visual Bible when the two are DIFFERENT items in the SAME slot', () => {
    const belt = {
      id: 'ART007', name: "brass-buckled captain's belt", label: "captain's belt", type: 'belt/waist',
      description: 'a wide black leather belt with a heavy brass buckle.',
    };
    const out = applyCoverWornHeldDedupe(
      photos('a white linen high-collar blouse; a wide black leather captain’s sash knotted at the waist'),
      { characterDetails: {} }, { artifacts: [belt] });
    expect(out.excludeElementIds).not.toContain('ART007');           // the belt keeps its reference cell
    expect(out.photos[0].clothingDescription).not.toContain('sash'); // the contradicting segment goes
    expect(out.photos[0].clothingDescription).toContain('blouse');
  });

  it('still suppresses a GENUINE duplicate — the artifact IS the worn garment', () => {
    const coat = {
      id: 'ART009', name: 'navy-blue captain’s coat', label: "captain's coat", type: 'outer layer',
      description: 'a long navy-blue wool coat with brass buttons.',
    };
    const out = applyCoverWornHeldDedupe(photos(), { characterDetails: {} }, { artifacts: [coat] });
    expect(out.excludeElementIds).toContain('ART009');
    expect(out.photos[0].clothingDescription).toContain('coat');
  });

  /**
   * THE HELD BRANCH IS THE SIBLING PATH (fixed 2026-09-15). Slot-identity
   * classification was added to the NOT-held branch only; the held branch still
   * dropped on the loose token match, so a held cap wiped the coat, the trousers
   * and the boots off a cover character and the model dressed them freely —
   * exactly the bug the classification was introduced to fix, surviving one
   * branch over.
   */
  it('a held item drops only the segment that IS that item', () => {
    const hint = { characterDetails: { a: { name: 'Sarah', holds: 'ART009' } } };
    const coat = {
      id: 'ART009', name: 'navy-blue captain’s coat', label: "captain's coat", type: 'outer layer',
      description: 'a long navy-blue wool coat with brass buttons.',
    };
    const out = applyCoverWornHeldDedupe(photos(), hint, { artifacts: [coat] });
    expect(out.excludeElementIds).not.toContain('ART009');
    expect(out.photos[0].clothingDescription).not.toContain('coat');
    // and nothing else is touched
    expect(out.photos[0].clothingDescription).toContain('trousers');
    expect(out.photos[0].clothingDescription).toContain('boots');
    expect(out.photos[0].clothingDescription).toContain('blouse');
  });

  it('a HELD cap never deletes the coat, the trousers or the boots', () => {
    const hint = { characterDetails: { a: { name: 'Sarah', holds: 'ART002' } } };
    const out = applyCoverWornHeldDedupe(photos(), hint, { artifacts: [cap] });
    expect(out.excludeElementIds).not.toContain('ART002');
    for (const word of ['coat', 'trousers', 'boots', 'blouse']) {
      expect(out.photos[0].clothingDescription, word).toContain(word);
    }
  });

  it('a wornAs link on the same owner+slot is a duplicate, not a conflict', () => {
    const linked = { ...cap, name: 'black tricorn hat', label: 'tricorn hat', wornAs: 'Sarah.headwear' };
    const out = applyCoverWornHeldDedupe(photos(), { characterDetails: {} }, { artifacts: [linked] });
    expect(out.excludeElementIds).toContain('ART002');
    expect(out.photos[0].clothingDescription).toContain('tricorn');
  });

  it("a wornAs link on ANOTHER character's body is never that character's duplicate", () => {
    const linked = { ...cap, wornAs: 'Emma.headwear' };
    const out = applyCoverWornHeldDedupe(photos(), { characterDetails: {} }, { artifacts: [linked] });
    expect(out.excludeElementIds).not.toContain('ART002');
  });

  it('an artifact with no worn slot is never a worn garment — both sides stay', () => {
    const rope = { id: 'ART003', name: 'heavy mooring rope', label: 'stern line', type: 'nautical rope', description: 'a thick navy-blue three-strand rope, wool-wrapped' };
    const out = applyCoverWornHeldDedupe(photos('a navy-blue rope belt'), { characterDetails: {} }, { artifacts: [rope] });
    expect(out.photos[0].clothingDescription).toBe('a navy-blue rope belt');
    expect(out.excludeElementIds).not.toContain('ART003');
  });

  // Staging job_1790100385959_1nitlympp title page (2026-09-23 audit, C5): the
  // held bag shared the colour word "brown" with the boots, and the boots were
  // dropped from the holder's outfit line as a "duplicate" of a paper bag.
  it('a held slotless prop does not delete a garment that shares a colour word', () => {
    const bag = { id: 'ART001', name: 'brown paper bag of chestnuts', label: 'paper bag', type: 'artifact', description: 'a small rectangular brown paper bag' };
    const hint = { characterDetails: { a: { name: 'Sarah', holds: 'ART001' } } };
    const outfit = 'a yellow long-sleeve shirt, olive green corduroy trousers, brown ankle boots';
    const out = applyCoverWornHeldDedupe(photos(outfit), hint, { artifacts: [bag] });
    expect(out.photos[0].clothingDescription).toBe(outfit);
  });
});
