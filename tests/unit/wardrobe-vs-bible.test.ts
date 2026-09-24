import { describe, it, expect } from 'vitest';

// @ts-ignore - CommonJS module
const { checkWardrobeAgainstBible, applyWardrobeBibleCorrections } = require('../../server/lib/clothingCheck');

// Real shapes from staging job_1789420511893_zly5rcdej: a pirate-themed story
// whose captain carries a navy captain's cap in the bible (ART002, the object
// the plot turns on) and a black tricorn in the wardrobe contract.
const SARAH = 'A long navy-blue wool captain’s coat with wide lapels, broad cuffs folded back, and a double-breasted front with brass buttons; a white linen high-collar blouse underneath; a wide black leather captain’s belt buckled at the waist; black wool straight trousers; black leather knee-high captain’s boots; a black tricorn hat with yellow braid trim.';
const EMMA = 'A black felt tricorn hat with a red cockade; a red long-sleeved cotton pirate shirt with a gathered neckline and full sleeves; black cotton breeches ending just below the knee and gathered at the hem; a white linen sash tied at the waist; white knee-length cotton stockings; black leather buckle shoes.';

const bible = () => ({
  artifacts: [
    {
      id: 'ART001', name: 'black tricorn hat', label: 'tricorn hat', type: 'headwear',
      pages: [1, 2, 3, 6],
      description: 'a black felt tricorn hat with three turned-up brim edges, featuring a bright red circular ribbon cockade pinned to the left side.',
    },
    {
      id: 'ART002', name: "navy-blue captain's cap", label: "captain's cap", type: 'headwear',
      pages: [5, 6, 7, 9, 10, 11, 13, 14, 15],
      description: "a navy-blue wool captain's cap with a stiff black visor, a flat crown, and a bright gold metal anchor emblem pinned securely to the front centre.",
    },
    { id: 'ART003', name: 'heavy mooring rope', label: 'stern line', type: 'nautical rope', pages: [12, 13, 14], description: 'a thick three-strand rope' },
  ],
});

const reqs = () => ({
  Emma: { costumed: { used: true, costume: 'pirate', description: EMMA }, standard: { used: false } },
  Sarah: { costumed: { used: true, costume: 'pirate', description: SARAH }, standard: { used: false } },
  Hans: { standard: { used: true, description: 'A brown wool flat cap; a green wool double-breasted overcoat with wide lapels; a white cotton button-up shirt with the collar open; dark grey wool trousers; brown leather lace-up shoes.' }, costumed: { used: false } },
});

describe('wardrobe contract vs Visual Bible', () => {
  it('catches the captain wearing a hat the bible contradicts in the same slot', () => {
    const f = checkWardrobeAgainstBible(reqs(), bible());
    expect(f).toHaveLength(1);
    expect(f[0].character).toBe('Sarah');
    expect(f[0].slot).toBe('headwear');
    expect(f[0].elementId).toBe('ART002');
    expect(f[0].wardrobeClause).toContain('tricorn');
    expect(f[0].versionOutfit).toContain('gold metal anchor');
    expect(f[0].versionOutfit).not.toContain('tricorn');
  });

  it('does not fault the character whose bible entry IS her wardrobe hat', () => {
    const f = checkWardrobeAgainstBible(reqs(), bible());
    expect(f.some((x: any) => x.character === 'Emma')).toBe(false);
  });

  it("does not attribute another character's wearable on a single shared token", () => {
    // Hans wears a flat cap; ART002 is a cap too but shares nothing else with him.
    const f = checkWardrobeAgainstBible(reqs(), bible());
    expect(f.some((x: any) => x.character === 'Hans')).toBe(false);
  });

  it('stays silent when the wardrobe names no item in that slot', () => {
    const r: any = reqs();
    r.Sarah.costumed.description = 'A long navy-blue wool captain’s coat; black wool straight trousers; black leather knee-high captain’s boots.';
    expect(checkWardrobeAgainstBible(r, bible())).toHaveLength(0);
  });

  it('a declared wornAs item takes the contract’s words; the contract is untouched', () => {
    // Same garment, different wording: the contract owns garment wording
    // (owner, 2026-09-23), so the bible entry is rewritten, never the outfit.
    const vb: any = bible();
    vb.artifacts[0].wornAs = 'Emma.headwear';
    const f = checkWardrobeAgainstBible(reqs(), vb).filter((x: any) => x.character === 'Emma');
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('adopt');
    const r: any = reqs();
    applyWardrobeBibleCorrections(r, vb, { log: { warn: () => {} } });
    expect(r.Emma.costumed.description).toBe(EMMA);
    expect(vb.artifacts[0].description).toBe('black felt tricorn hat with a red cockade');
  });

  it('honours an explicit wornAs link over token attribution', () => {
    // A linked DIFFERENT garment is a conflict, attributed by the link.
    const vb: any = bible();
    vb.artifacts[1].wornAs = 'Emma.headwear';
    const f = checkWardrobeAgainstBible(reqs(), vb);
    expect(f).toHaveLength(1);
    expect(f[0].character).toBe('Emma');
    expect(f[0].kind).toBe('conflict');
  });


  it('turns a different garment into an outfit version and logs loudly; the contract is untouched', () => {
    const r: any = reqs();
    const vb: any = bible();
    const lines: string[] = [];
    const { applied, versions } = applyWardrobeBibleCorrections(r, vb, { log: { warn: (m: string) => lines.push(m) } });
    expect(applied).toHaveLength(0);
    expect(versions).toHaveLength(1);
    expect(r.Sarah.costumed.description).toBe(SARAH);
    expect(r.Emma.costumed.description).toBe(EMMA);
    expect(vb.artifacts[1].outfitVersion.outfit).toContain("captain's cap");
    expect(vb.artifacts[1].outfitVersion.outfit).not.toContain('tricorn');
    expect(lines.join('\n')).toContain('Sarah/headwear');
    expect(lines.join('\n')).toContain('ART002');
  });

  it('is a no-op on an empty or bible-less story', () => {
    expect(checkWardrobeAgainstBible(null, bible())).toEqual([]);
    expect(checkWardrobeAgainstBible(reqs(), null)).toEqual([]);
    expect(checkWardrobeAgainstBible(reqs(), { artifacts: [] })).toEqual([]);
  });
});

/**
 * THE `corrected` FLAG WAS ALWAYS FALSE (fixed 2026-09-15). The corrector
 * re-derives the findings after every change, so the objects it returns are
 * never the objects in `findings` — identity comparison could not be true even
 * for a change that landed.
 */
describe('the applied set is identified by value, never by object identity', () => {
  it('a landed change is NOT the same object as its finding', () => {
    const r: any = reqs();
    const { findings, versions, unresolved } = applyWardrobeBibleCorrections(r, bible(), { log: { warn: () => {} } });
    expect(findings).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(unresolved).toHaveLength(0);
    expect(versions.includes(findings[0])).toBe(false);       // the bug
    const key = (f: any) => [f.character, f.category, f.slot, f.elementId || ''].join('|');
    expect(new Set(versions.map(key)).has(key(findings[0]))).toBe(true);   // the fix
  });

  it('beatsPipeline reports it by key', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'beatsPipeline.js'), 'utf8');
    expect(src).toContain('corrected: appliedKeys.has(correctionKey(f))');
    expect(src).not.toContain('corrected: applied.includes(f)');
  });
});

/**
 * NO AVATAR IS RE-RENDERED FOR A CONFLICT (owner, 2026-09-24). The 2026-09-15
 * hook re-rendered a character from photos after the contract was rewritten to
 * the bible's garment; the contract is no longer rewritten, the default sheet
 * stands, and the version gets its own redressed sheet
 * (tests/unit/outfit-version.test.ts).
 */
describe('a conflict never re-renders the default avatar', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const beats = fs.readFileSync(path.join(root, 'server', 'lib', 'beatsPipeline.js'), 'utf8');
  const pipeline = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');

  it('the kickoff still runs BEFORE the check', () => {
    expect(beats.indexOf('onClothingRequirements(clothingRequirements)'))
      .toBeLessThan(beats.indexOf('applyWardrobeBibleCorrections(clothingRequirements, visualBible)'));
  });

  it('the re-render hook and its wiring are deleted', () => {
    expect(beats).not.toContain('onWardrobeCorrected');
    expect(pipeline).not.toContain('onWardrobeCorrected');
    expect(pipeline).not.toContain('invalidateStyledAvatarForCategory(r.characterNames[0]');
  });
});
