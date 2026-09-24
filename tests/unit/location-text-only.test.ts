import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED (owner, 2026-09-24): an invented location lives in the
// Visual Bible as TEXT. It never gets a reference cell, and no stored location
// cell (old stories) ever reaches a plate, a page grid or a cover grid. Real
// landmarks keep their photo path; vehicles and large artifacts keep cells.

const vb = () => require_('../../server/lib/visualBible.js');

function makeVb() {
  return {
    secondaryCharacters: [],
    animals: [],
    artifacts: [
      { id: 'ART001', name: 'stone well', scaleClass: 'building', description: 'a round stone well', appearsInPages: [1, 2], referenceImageUrl: 'https://r2/art001.jpg', referenceImageGenerated: true },
    ],
    vehicles: [
      { id: 'VEH001', name: 'red handcart', description: 'a two-wheeled red handcart', appearsInPages: [1, 2], referenceImageUrl: 'https://r2/veh001.jpg', referenceImageGenerated: true },
    ],
    locations: [
      // An OLD story: the invented kitchen still carries a stored cell.
      { id: 'LOC001', name: 'farmhouse kitchen', isRealLandmark: false, description: 'a low-beamed farmhouse kitchen with a tiled stove', appearsInPages: [1, 2, 3], referenceImageUrl: 'https://r2/loc001.jpg', referenceImageGenerated: true },
      // A NEW story: invented, on several pages, never rendered.
      { id: 'LOC002', name: 'orchard gate', isRealLandmark: false, description: 'a weathered wooden gate in a stone wall', appearsInPages: [1, 2, 4] },
      { id: 'LOC003', name: 'Old Town Tower', isRealLandmark: true, description: 'a medieval clock tower', appearsInPages: [1] },
    ],
    clothing: [],
  };
}

describe('no location is ever queued for a reference cell', () => {
  it('skips invented locations on any number of pages; keeps vehicles', () => {
    const v: any = makeVb();
    v.vehicles[0].referenceImageUrl = null;
    v.vehicles[0].referenceImageGenerated = false;
    const need = vb().getElementsNeedingReferenceImages(v);
    expect(need.map((e: any) => e.id)).toEqual(['VEH001']);
    expect(need.some((e: any) => e.type === 'location')).toBe(false);
  });
});

describe('a stored location cell (old story) is ignored everywhere', () => {
  it('the plate grid carries the vehicle and the large artifact, never the location', () => {
    const refs = vb().getEmptySceneElementReferences(makeVb(), 1, 9, null, null);
    const ids = refs.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['VEH001', 'ART001']));
    expect(ids).not.toContain('LOC001');
  });

  it('the page grid never carries it, plate or no plate', () => {
    const refs = vb().getElementReferenceImagesForPage(makeVb(), 1, 4, ['LOC001', 'VEH001'], null);
    expect(refs.map((r: any) => r.id)).not.toContain('LOC001');
    expect(refs.map((r: any) => r.id)).toContain('VEH001');
  });

  it('an explicit LOC id citation (covers, scene-hint ids) resolves to nothing', () => {
    const refs = vb().getElementReferenceImagesByIds(makeVb(), ['LOC001', 'VEH001'], 1);
    expect(refs.map((r: any) => r.id)).toEqual(['VEH001']);
  });

  it('a page whose only VB image was a location cell gets NO plate grid', async () => {
    const { buildEmptySceneVbGrid } = require_('../../server/lib/referenceSheets.js');
    const v: any = makeVb();
    v.vehicles = [];
    v.artifacts = [];
    expect(await buildEmptySceneVbGrid(v, 3, [], null, null)).toBeNull();
  });
});

describe('the plate REFERENCE line', () => {
  beforeAll(async () => {
    await require_('../../server/services/prompts.js').loadPromptTemplates();
  });
  const build = (referenceKind: any) => require_('../../server/services/prompts.js').buildEmptyScenePrompt({
    style: 'watercolour',
    description: '**SHOT:** wide\n\n**LOCATION:** a low-beamed farmhouse kitchen with a tiled stove',
    referenceKind,
  });

  it('with no image attached there is no REFERENCE line and the location text carries the plate', () => {
    const p = build(null);
    expect(p).not.toContain('**REFERENCE:**');
    expect(p).toContain('a low-beamed farmhouse kitchen with a tiled stove');
  });

  it('an element grid is named as a vessel or structure, never as the place', () => {
    const p = build('element');
    expect(p).toContain('**REFERENCE:** The vessel or structure in this scene is the one shown in the attached reference image');
    expect(p).not.toMatch(/The place[^.]*attached reference image/);
  });

  it('a landmark photo keeps the place wording', () => {
    expect(build('landmark')).toContain('**REFERENCE:** The place in this scene is the one shown in the attached reference image');
  });
});
