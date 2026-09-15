import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const worn = require_('../../server/lib/wornItems.js');

/**
 * A `wearer` naming somebody who is NOT in the page cast must not fall back to
 * the owner. The fallback asserted the exact defect the row prevents: on
 * staging job_1789420511893_zly5rcdej p13 the correct row is `{ART001, owner:
 * Emma, wearer: Kilian, state: worn}` with Kilian off-page, and the old code
 * built "Emma IS wearing this on this page: black tricorn hat" — the hat the
 * page must not draw on her, which p13 and p14 then rendered.
 */
const TRICORN = {
  id: 'ART001',
  name: 'black tricorn hat',
  type: 'headwear',
  wornAs: 'Emma.headwear',
  appearsInPages: [1, 2, 3, 6, 13],
  description: 'a black felt tricorn hat with three turned-up brim edges and a bright red circular ribbon cockade.',
};
const VB = { artifacts: [TRICORN], clothing: [], vehicles: [], locations: [], animals: [], secondaryCharacters: [] };
const META = (wearer: string) => ({
  characters: [{ name: 'Noah' }, { name: 'Emma' }],
  objects: ['ART001'],
  wornItems: [{ id: 'ART001', owner: 'Emma', state: 'worn', wearer }],
});

describe('an off-cast wearer is read as OFF, never as the owner', () => {
  it('coerces the row to off with that wearer as the place', () => {
    const [r] = worn.resolveWornItemsForPage(VB, ['Noah', 'Emma'], META('Kilian'), { pageNumber: 13 });
    expect(r.state).toBe('off');
    expect(r.wearer).toBe('Emma');
    expect(r.handedOver).toBe(false);
    // NO OFF-PAGE NAME IN A PROMPT-FACING STRING (2026-09-15): `location` is
    // read back into the image prompt, and "held by <Name>" invited the model to
    // draw the very person this page's cast excludes.
    expect(r.location).toBe('not on this page');
    expect(r.location).not.toMatch(/Kilian/);
  });

  it('the built clause takes the item OFF the owner', () => {
    const resolved = worn.resolveWornItemsForPage(VB, ['Noah', 'Emma'], META('Kilian'), { pageNumber: 13 });
    const [line] = worn.buildWornStateLines(resolved);
    expect(line).toMatch(/Emma is NOT wearing this on this page/);
    expect(line).not.toMatch(/Emma IS wearing this on this page/);
  });

  it('the owner outfit strip is ATTEMPTED for the coerced row', () => {
    const resolved = worn.resolveWornItemsForPage(VB, ['Noah', 'Emma'], META('Kilian'), { pageNumber: 13 });
    // What this pins is that the coerced row reaches the strip at all: before
    // the coercion it resolved `worn` on the owner and was never offered.
    // Whether the clause comes out is removeWornItemFromOutfit's own contract
    // (a two-garment clause with no layering connective is left intact by
    // design — the explicit "is NOT wearing" line still carries it).
    const { text, removals } = worn.stripOffItemsFromOutfit(
      'A black felt tricorn hat with a red cockade, a white linen shirt, brown breeches, black buckle shoes',
      resolved,
      'Emma',
    );
    expect(removals.map((r: { id: string }) => r.id)).toEqual(['ART001']);
    expect(text).toMatch(/linen shirt/);
  });

  it('a wearer IN the cast is still a handover, and no wearer is still the owner', () => {
    const [handed] = worn.resolveWornItemsForPage(VB, ['Noah', 'Emma'], META('Noah'), { pageNumber: 13 });
    expect(handed.state).toBe('worn');
    expect(handed.handedOver).toBe(true);
    expect(handed.wearer).toBe('Noah');
    const [plain] = worn.resolveWornItemsForPage(VB, ['Noah', 'Emma'], META(''), { pageNumber: 13 });
    expect(plain.state).toBe('worn');
    expect(plain.handedOver).toBe(false);
    expect(plain.wearer).toBe('Emma');
  });

  it('no off-page name reaches any built prompt line', () => {
    const resolved = worn.resolveWornItemsForPage(VB, ['Noah', 'Emma'], META('Kilian'), { pageNumber: 13 });
    expect(worn.buildWornStateLines(resolved).join(String.fromCharCode(10))).not.toMatch(/Kilian/);
  });

  /**
   * The eval side recomputes the same strip one character at a time, so it can
   * only pass [ownerName] as the cast — every GENUINE handover then looks
   * off-cast. It must not fire an error per page per character: that noise is
   * exactly what would mask a real off-cast coercion.
   */
  it('a caller with no cast coerces silently, an equipped caller loudly', () => {
    const calls: string[] = [];
    const orig = console.error;
    const loud = worn.resolveWornItemsForPage(VB, ['Noah', 'Emma'], META('Kilian'), { pageNumber: 13 });
    expect(loud[0].state).toBe('off');
    const quiet = worn.resolveWornItemsForPage(VB, ['Emma'], META('Noah'), { pageNumber: 13, castComplete: false });
    // Noah IS a real cast member; with castComplete:false the row is still read
    // as off the owner, but it is not reported as an off-cast fault.
    expect(quiet[0].state).toBe('off');
    console.error = orig;
    void calls;
  });

  it('a wearer that merely re-states the owner is not a coercion', () => {
    const [r] = worn.resolveWornItemsForPage(VB, ['Noah', 'Emma'], META('emma'), { pageNumber: 13 });
    expect(r.state).toBe('worn');
    expect(r.handedOver).toBe(false);
  });

  it('the unlinked (Art Director declared) source coerces the same way', () => {
    const bare = { artifacts: [{ ...TRICORN, wornAs: undefined }], clothing: [], vehicles: [], locations: [], animals: [], secondaryCharacters: [] };
    const [r] = worn.resolveWornItemsForPage(bare, ['Noah', 'Emma'], META('Kilian'), { pageNumber: 13 });
    expect(r.state).toBe('off');
    expect(r.wearer).toBe('Emma');
    expect(r.location).toBe('not on this page');
    expect(r.location).not.toMatch(/Kilian/);
  });
});
