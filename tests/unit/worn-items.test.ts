import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const worn = require('../../server/lib/wornItems.js');
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata.js');
const { checkScenes } = require('../../server/lib/clothingCheck.js');
const { getElementReferenceImagesForPage } = require('../../server/lib/visualBible.js');

// ── Real fixture: staging job_1788641639919_mpjwlzkf1 ────────────────────────
// ART001 "Lily's red woollen hat", wornAs Lily.headwear, worn p1-5 + p14,
// off p6-13 (on the ground p8, held by another child p12-13).
const ART001 = {
  id: 'ART001',
  name: "Lily's red woollen hat",
  wornAs: 'Lily.headwear',
  appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14],
  description: 'A small hat knitted from chunky red wool, dome-shaped at the crown with a wide turned-back brim of two finger-widths.',
  referenceImageUrl: 'https://example.invalid/art001.jpg',
};
const ART007 = {
  id: 'ART007',
  name: 'Log pile',
  appearsInPages: [7, 8, 12, 13],
  description: 'A stack of split logs roughly a metre and a half tall.',
  referenceImageUrl: 'https://example.invalid/art007.jpg',
};
const VB = { artifacts: [ART001, ART007], secondaryCharacters: [], animals: [], vehicles: [], locations: [] };

// Lily's REAL per-story clothingRequirements.standard.description.
const LILY_OUTFIT = 'A red chunky-knit woollen hat with a turned-back brim, a yellow long-sleeved top under a green quilted gilet with a zip front, dark blue corduroy trousers with a slightly tapered leg, and orange rubber-soled ankle boots with a rounded toe.';

const brief = (prose: string, meta: Record<string, unknown>) =>
  `${prose}\n---METADATA---\n${JSON.stringify(meta)}`;

const P3_META = {
  sceneIntent: 'Lily stands at the edge of the square.',
  characters: [{ name: 'Lily', clothing: 'standard', position: 'left foreground', depth: 'foreground' }],
  objects: ['ART001'],
  wornItems: [{ id: 'ART001', owner: 'Lily', state: 'worn' }],
};
const P8_META = {
  sceneIntent: 'Lily crouches by the log pile.',
  characters: [{ name: 'Lily', clothing: 'standard', position: 'centre', depth: 'foreground' }],
  objects: ['ART001', 'ART007'],
  wornItems: [{ id: 'ART001', owner: 'Lily', state: 'off', location: 'lies on the cobbles beside the log pile' }],
};

describe('wornItems — METADATA parser', () => {
  it('parses a wornItems block out of a prose+METADATA brief', () => {
    const m = extractSceneMetadata(brief('Lily stands in the square.', P8_META));
    expect(m.wornItems).toEqual([
      { id: 'ART001', owner: 'Lily', state: 'off', location: 'lies on the cobbles beside the log pile' },
    ]);
    expect(m.fullData.wornItems).toEqual(m.wornItems);
  });

  it('drops rows with no usable id and blanks an unrecognised state', () => {
    const rows = worn.parseWornItems([
      { id: 'ART001', owner: 'Lily', state: 'WORN' },
      { id: 'not-an-id', owner: 'Lily', state: 'off' },
      { id: 'ART002', owner: 'Lily', state: 'maybe' },
      { id: 'ART001', owner: 'Lily', state: 'off' },   // duplicate id, ignored
      'nonsense',
    ]);
    expect(rows).toEqual([
      { id: 'ART001', owner: 'Lily', state: 'worn', location: null },
      { id: 'ART002', owner: 'Lily', state: null, location: null },
    ]);
  });

  it('parses the wornAs link and ignores a malformed one', () => {
    expect(worn.parseWornAs('Lily.headwear')).toEqual({ owner: 'Lily', slot: 'headwear' });
    expect(worn.parseWornAs('Lily')).toBeNull();
    expect(worn.parseWornAs('.headwear')).toBeNull();
  });

  it('a page whose cast excludes the owner resolves no worn items', () => {
    const r = worn.resolveWornItemsForPage(VB, ['Ethan'], { wornItems: [] });
    expect(r).toEqual([]);
  });

  it('defaults an undeclared item to worn and marks it missing', () => {
    const [r] = worn.resolveWornItemsForPage(VB, ['Lily'], { wornItems: [] });
    expect(r.state).toBe('worn');
    expect(r.defaulted).toBe(true);
    expect(r.missing).toBe(true);
  });
});

describe('clothingCheck — removal_unstated is a missing-field fault', () => {
  const pageFrom = (meta: Record<string, unknown>, prose = 'Lily stands in the square.') => {
    const m = extractSceneMetadata(brief(prose, meta));
    return {
      pageNumber: 8,
      prose,
      cast: (m.characters || []).map((c: unknown) => (typeof c === 'string' ? c : (c as { name: string }).name)),
      perCharClothing: m.characterClothing || {},
      wornItems: m.wornItems || [],
    };
  };
  const reqs = { Lily: { standard: { used: true, description: LILY_OUTFIT } } };

  it('fires when the owner is on the page and no wornItems row exists', () => {
    const meta = { ...P8_META, wornItems: [] };
    const res = checkScenes([pageFrom(meta)], reqs, { visualBible: VB });
    const f = res.findings.filter((x: { type: string }) => x.type === 'removal_unstated');
    expect(f).toHaveLength(1);
    expect(f[0].artifactId).toBe('ART001');
    expect(f[0].character).toBe('Lily');
    expect(f[0].detail).toContain('"id": "ART001"');
  });

  it('fires when the row says off but names no location', () => {
    const meta = { ...P8_META, wornItems: [{ id: 'ART001', owner: 'Lily', state: 'off' }] };
    const res = checkScenes([pageFrom(meta)], reqs, { visualBible: VB });
    expect(res.findings.filter((x: { type: string }) => x.type === 'removal_unstated')).toHaveLength(1);
  });

  it('does NOT fire on a complete worn row', () => {
    const res = checkScenes([pageFrom(P3_META)], reqs, { visualBible: VB });
    expect(res.findings.filter((x: { type: string }) => x.type === 'removal_unstated')).toHaveLength(0);
  });

  it('does NOT fire on a complete off row with a location', () => {
    const res = checkScenes([pageFrom(P8_META)], reqs, { visualBible: VB });
    expect(res.findings.filter((x: { type: string }) => x.type === 'removal_unstated')).toHaveLength(0);
  });

  it('does NOT fire when the owner is not on the page', () => {
    const meta = {
      ...P8_META,
      characters: [{ name: 'Ethan', clothing: 'standard', position: 'centre' }],
      wornItems: [],
    };
    const res = checkScenes([pageFrom(meta)], reqs, { visualBible: VB });
    expect(res.findings.filter((x: { type: string }) => x.type === 'removal_unstated')).toHaveLength(0);
  });
});

describe('reference-cell dedupe', () => {
  it('SKIPS the worn item cell — the avatar reference already carries it', () => {
    const m = extractSceneMetadata(brief('Lily stands in the square.', P3_META));
    const refs = getElementReferenceImagesForPage(VB, 3, 4, m.objects, m);
    expect(refs.map((r: { id: string }) => r.id)).not.toContain('ART001');
  });

  it('KEEPS the item cell when the page declares it off', () => {
    const m = extractSceneMetadata(brief('Lily crouches by the logs.', P8_META));
    const refs = getElementReferenceImagesForPage(VB, 8, 4, m.objects, m);
    expect(refs.map((r: { id: string }) => r.id)).toContain('ART001');
  });

  it('keeps every non-worn element either way', () => {
    const m = extractSceneMetadata(brief('Lily crouches by the logs.', P8_META));
    const refs = getElementReferenceImagesForPage(VB, 8, 4, m.objects, m);
    expect(refs.map((r: { id: string }) => r.id)).toContain('ART007');
  });

  it('a caller passing no metadata keeps the previous behaviour (no dedupe)', () => {
    const refs = getElementReferenceImagesForPage(VB, 3, 4, ['ART001']);
    expect(refs.map((r: { id: string }) => r.id)).toContain('ART001');
  });
});

describe('prompt lines — both directions, explicit', () => {
  it('worn: draw it even if the reference lacks it', () => {
    const r = worn.resolveWornItemsForPage(VB, ['Lily'], P3_META);
    const [line] = worn.buildWornStateLines(r);
    expect(line).toBe(
      "- Lily IS wearing this on this page: Lily's red woollen hat. Draw it on Lily even if the attached reference shows Lily without it.",
    );
  });

  it('off: leave it off even if the reference wears it, plus where it lies', () => {
    const r = worn.resolveWornItemsForPage(VB, ['Lily'], P8_META);
    const [line] = worn.buildWornStateLines(r);
    expect(line).toBe(
      "- Lily is NOT wearing this on this page: Lily's red woollen hat. Leave it off Lily even if the attached reference shows it worn — lies on the cobbles beside the log pile.",
    );
  });

  it('the block is empty when the page has no worn items', () => {
    expect(worn.buildWornStateBlock([])).toBe('');
  });
});

describe('outfit text loses exactly the off item and nothing else', () => {
  it('drops the headwear clause of the real fixture outfit', () => {
    const res = worn.removeWornItemFromOutfit(LILY_OUTFIT, 'headwear');
    expect(res.removed).toBe(true);
    expect(res.text).toBe(
      'A yellow long-sleeved top under a green quilted gilet with a zip front, dark blue corduroy trousers with a slightly tapered leg, and orange rubber-soled ankle boots with a rounded toe.',
    );
    // Every other garment survives verbatim.
    for (const kept of ['long-sleeved top', 'quilted gilet', 'corduroy trousers', 'ankle boots']) {
      expect(res.text).toContain(kept);
    }
    expect(res.text).not.toMatch(/\bhat\b/);
  });

  it('drops a labelled slot when the contract is slot-labelled', () => {
    const labelled = 'headwear: a red woollen hat; top: a yellow jumper; footwear: orange boots';
    const res = worn.removeWornItemFromOutfit(labelled, 'headwear');
    expect(res.removed).toBe(true);
    expect(res.text).toBe('top: a yellow jumper; footwear: orange boots');
  });

  it('removes NOTHING when the slot cannot be located unambiguously', () => {
    const two = 'a red woollen hat, a blue knitted cap, orange boots';
    const res = worn.removeWornItemFromOutfit(two, 'headwear');
    expect(res.removed).toBe(false);
    expect(res.reason).toBe('slot-clause-ambiguous');
    expect(res.text).toBe(two);
  });

  it('removes NOTHING when no clause owns the slot', () => {
    const res = worn.removeWornItemFromOutfit('a yellow jumper, orange boots', 'headwear');
    expect(res.removed).toBe(false);
    expect(res.text).toBe('a yellow jumper, orange boots');
  });

  it('stripOffItemsFromOutfit only touches the OWNER of the off item', () => {
    const r = worn.resolveWornItemsForPage(VB, ['Lily'], P8_META);
    expect(worn.stripOffItemsFromOutfit(LILY_OUTFIT, r, 'Ethan').text).toBe(LILY_OUTFIT);
    expect(worn.stripOffItemsFromOutfit(LILY_OUTFIT, r, 'Lily').text).not.toMatch(/\bhat\b/);
  });

  it('a WORN item leaves the outfit untouched', () => {
    const r = worn.resolveWornItemsForPage(VB, ['Lily'], P3_META);
    expect(worn.stripOffItemsFromOutfit(LILY_OUTFIT, r, 'Lily').text).toBe(LILY_OUTFIT);
  });
});

describe('non-English story path', () => {
  // story-unified.txt mandates ENGLISH names + descriptions for artifacts, so a
  // German story carries the same English `wornAs` link and the same slot
  // vocabulary. Only the character name and the prose are localised.
  const deVB = {
    artifacts: [{ ...ART001, name: 'Mira\'s red woollen hat', wornAs: 'Mira.headwear' }],
    secondaryCharacters: [], animals: [], vehicles: [], locations: [],
  };
  const deMeta = {
    sceneIntent: 'Mira steht auf dem Platz.',
    characters: [{ name: 'Mira', clothing: 'standard', position: 'links' }],
    objects: ['ART001'],
    wornItems: [{ id: 'ART001', owner: 'Mira', state: 'off', location: 'liegt auf dem Pflaster' }],
  };

  it('resolves and renders the off state for a German-language story', () => {
    const m = extractSceneMetadata(brief('Mira steht auf dem Platz.', deMeta));
    const r = worn.resolveWornItemsForPage(deVB, ['Mira'], m);
    expect(r).toHaveLength(1);
    expect(r[0].state).toBe('off');
    expect(worn.buildWornStateLines(r)[0]).toContain('Mira is NOT wearing this on this page');
    expect(worn.buildWornStateLines(r)[0]).toContain('liegt auf dem Pflaster');
  });

  it('dedupe still skips the cell when the German page declares it worn', () => {
    const m = extractSceneMetadata(brief('Mira steht auf dem Platz.', {
      ...deMeta, wornItems: [{ id: 'ART001', owner: 'Mira', state: 'worn' }],
    }));
    const refs = getElementReferenceImagesForPage(deVB, 3, 4, m.objects, m);
    expect(refs.map((x: { id: string }) => x.id)).not.toContain('ART001');
  });
});
