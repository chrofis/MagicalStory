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
    expect(f[0].after).toContain('gold metal anchor');
    expect(f[0].after).not.toContain('tricorn');
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

  it('a declared wornAs item restates the slot in the bible’s words', () => {
    // Same garment, different wording: the writer said this prop IS her hat, so
    // the bible's description becomes the contract's text for that slot.
    const vb: any = bible();
    vb.artifacts[0].wornAs = 'Emma.headwear';
    const f = checkWardrobeAgainstBible(reqs(), vb).filter((x: any) => x.character === 'Emma');
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('reconcile');
    expect(f[0].after).toContain('three turned-up brim edges');
  });

  it('honours an explicit wornAs link over token attribution', () => {
    const vb: any = bible();
    vb.artifacts[1].wornAs = 'Emma.headwear';
    const f = checkWardrobeAgainstBible(reqs(), vb);
    expect(f).toHaveLength(1);
    expect(f[0].character).toBe('Emma');
    expect(f[0].kind).toBe('reconcile');
  });

  it('corrects the contract in place and logs loudly', () => {
    const r: any = reqs();
    const lines: string[] = [];
    const { applied } = applyWardrobeBibleCorrections(r, bible(), { log: { warn: (m: string) => lines.push(m) } });
    expect(applied).toHaveLength(1);
    expect(r.Sarah.costumed.description).toContain("captain's cap");
    expect(r.Sarah.costumed.description).not.toContain('tricorn');
    expect(r.Emma.costumed.description).toBe(EMMA);
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
 * re-derives the findings after every rewrite, so the objects in `applied` are
 * never the objects in `findings` — `applied.includes(f)`, the identity test
 * beatsPipeline used to build wardrobeBibleReport, could not be true even for a
 * correction that landed. Every successful correction was reported as
 * uncorrected and `unresolved` was dropped on the floor.
 */
describe('the applied set is identified by value, never by object identity', () => {
  it('a landed correction is NOT the same object as its finding', () => {
    const r: any = reqs();
    const { findings, applied, unresolved } = applyWardrobeBibleCorrections(r, bible(), { log: { warn: () => {} } });
    expect(findings).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(unresolved).toHaveLength(0);
    expect(applied.includes(findings[0])).toBe(false);       // the bug
    const key = (f: any) => [f.character, f.category, f.slot, f.elementId || ''].join('|');
    expect(new Set(applied.map(key)).has(key(findings[0]))).toBe(true);   // the fix
  });

  it('beatsPipeline reports it by key and carries the applied names to the caller', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'beatsPipeline.js'), 'utf8');
    expect(src).toContain('corrected: appliedKeys.has(correctionKey(f))');
    expect(src).not.toContain('corrected: applied.includes(f)');
    expect(src).toContain('onWardrobeCorrected(names, clothingRequirements)');
  });
});

/**
 * THE AVATAR IS RENDERED BEFORE THE CORRECTION EXISTS (fixed 2026-09-15).
 * The styled-avatar kickoff fires at the story-bible stage — deliberately, it is
 * the long pole in front of every image — while this correction can only run
 * once the Visual Bible exists, several stages later. Page prompts then carried
 * the corrected garment while the avatar reference cell still wore the old one.
 * The kickoff is NOT moved; the affected characters are re-rendered.
 */
describe('a corrected outfit re-renders its avatar', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const beats = fs.readFileSync(path.join(root, 'server', 'lib', 'beatsPipeline.js'), 'utf8');
  const pipeline = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');

  it('the kickoff still runs BEFORE the correction — the ordering is the constraint, not the bug', () => {
    expect(beats.indexOf('onClothingRequirements(clothingRequirements)'))
      .toBeLessThan(beats.indexOf('applyWardrobeBibleCorrections(clothingRequirements, visualBible)'));
  });

  it('the correction fires the re-render hook only for characters actually corrected', () => {
    expect(beats).toContain("if (applied.length > 0 && typeof onWardrobeCorrected === 'function')");
    expect(beats).toContain('applied.map(f => f.character)');
  });

  it('the caller wires it, invalidates those avatars and re-renders only them', () => {
    expect(pipeline).toContain('onWardrobeCorrected: onWardrobeCorrectedReady');
    expect(pipeline).toContain('invalidateStyledAvatarForCategory(r.characterNames[0], r.clothingCategory');
    expect(pipeline).toContain('await prepareStyledAvatars(affected, artStyle, reqs, requirements');
    expect(pipeline).toContain('streamingAvatarStylingPromise = (async () => {');
  });

  it('both call sites derive the avatar buckets from ONE helper', () => {
    expect(pipeline).toContain('const avatarRequirementsFor = (chars, requirements) =>');
    expect((pipeline.match(/avatarRequirementsFor\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
