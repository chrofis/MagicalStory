/**
 * A worn garment's Visual Bible description names that garment only
 * (staging job_1790446348343_z3fw660ie p16).
 *
 * The outfit contract was a comma list with one semicolon tail ("…, boots, and
 * jewellery; scissors hang from the sash"). clothingCheck.outfitClauses split
 * on the semicolon alone whenever one was present, so the whole garment list
 * came back as ONE clause, the wardrobe-vs-bible `adopt` wrote it into the
 * coat's description, and the page's "is NOT wearing this" line quoted the
 * entire costume. Offline, no paid call.
 */
import { describe, it, expect } from 'vitest';

const { outfitClauses, applyWardrobeBibleCorrections, checkWardrobeAgainstBible } = require('../../server/lib/clothingCheck');
const { resolveWornItemsForPage, buildWornStateLines } = require('../../server/lib/wornItems');

const OUTFIT = 'A white cotton blouse with full sleeves gathered at the wrist, a weathered grey wool coat worn open with wide cuffs and brass buttons, a black knee-length skirt, a broad orange sash knotted at the left hip, black leather ankle boots, and a silver necklace; a small pouch hangs from the sash knot.';
const COAT = 'a weathered grey wool coat worn open with wide cuffs and brass buttons';

const reqs = () => ({ Heroine: { costumed: { used: true, costume: 'pirate', description: OUTFIT } } });
const bible = (description: string) => ({
  clothing: [{ id: 'CLO001', name: 'grey wool coat', label: 'grey coat', type: 'outer layer', wornAs: 'Heroine.outer layer', wornBy: 'Heroine', pages: [1, 2], description }],
});

describe('an outfit with a semicolon tail splits into one clause per garment', () => {
  it('every comma-listed garment is its own clause, and the tail is one more', () => {
    const c = outfitClauses(OUTFIT);
    expect(c).toContain(COAT);
    expect(c.some((x: string) => /blouse/.test(x) && /coat/.test(x))).toBe(false);
    expect(c[c.length - 1]).toBe('a small pouch hangs from the sash knot');
  });

  it('a dependent segment stays with its garment', () => {
    expect(outfitClauses('a red coat with brass buttons, worn open; a white shirt'))
      .toEqual(['a red coat with brass buttons, worn open', 'a white shirt']);
  });
});

describe('the adopt keeps a garment element to its own garment', () => {
  it('an element already carrying its clause is not rewritten to the whole outfit', () => {
    const v: any = bible(COAT);
    applyWardrobeBibleCorrections(reqs(), v, { log: { warn: () => {}, info: () => {}, error: () => {} } });
    expect(v.clothing[0].description).toBe(COAT);
    expect(checkWardrobeAgainstBible(reqs(), v)).toHaveLength(0);
  });

  it('an element worded differently adopts the garment clause only', () => {
    const v: any = bible('a grey wool coat with brass buttons');
    applyWardrobeBibleCorrections(reqs(), v, { log: { warn: () => {}, info: () => {}, error: () => {} } });
    expect(v.clothing[0].description).toBe(COAT.replace(/^a /, ''));
    expect(v.clothing[0].description).not.toMatch(/blouse|skirt|boots/);
  });

  it("the page's NOT-wearing line quotes the garment, never the outfit", () => {
    const v: any = bible(COAT);
    applyWardrobeBibleCorrections(reqs(), v, { log: { warn: () => {}, info: () => {}, error: () => {} } });
    const rows = resolveWornItemsForPage(v, [{ name: 'Heroine' }], {
      characters: [{ name: 'Heroine' }],
      wornItems: [{ id: 'CLO001', owner: 'Heroine', state: 'off', location: 'left behind on the ship' }],
    }, { pageNumber: 2 });
    const text = buildWornStateLines(rows).join('\n');
    expect(text).toMatch(/NOT wearing/);
    expect(text).toContain('grey wool coat');
    expect(text).not.toMatch(/blouse|skirt|boots/);
  });
});
