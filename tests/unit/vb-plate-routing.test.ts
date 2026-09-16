/**
 * LARGE ELEMENTS BELONG TO THE PLATE (phase 3 of tasks/vb-scale-class-plan-2026-09-15.md).
 *
 * A page reference cell has exactly one size — its own — and nothing in the
 * cell says whether it depicts a thumb or a three-master. The plate sizes a
 * structure against bollards, cobbles and quay height. On
 * job_1789420511893_zly5rcdej p12 a three-master rode as a page cell and
 * rendered as a small open rowboat although the plate prompt named it: the cell
 * won over the plate.
 *
 * Routing is by the AUTHORED `scaleClass`, not by VB collection, so a
 * building-scale ARTIFACT routes to the plate exactly like a vehicle.
 *
 * THE FALLBACK IS THE POINT, not an afterthought: the drop is conditional on a
 * plate actually being sent. A large element on a plateless page KEEPS its cell
 * rather than travelling on nothing — page 1 of job_1788295892348_l028ggiq7a
 * was a cast-0 ship exterior that attached zero references while a finished
 * plate of the ship existed and was discarded.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore - CommonJS
const {
  isLargeScaleClass, isPlateBorneElement,
  getEmptySceneElementReferences, getElementReferenceImagesForPage,
} = require('../../server/lib/visualBible');
// @ts-ignore - CommonJS
const { buildPageCompositeRefs } = require('../../server/lib/referenceSheets');
// @ts-ignore - CommonJS
const { buildImagePrompt } = require('../../server/lib/promptBuilders');

// A real 1x1 white JPEG as a data: URI, so the grid composer can actually
// run here (Node's fetch resolves data: URLs locally) — same fixture as
// cast0-plate-routing.test.ts.
const REF = { referenceImageGenerated: true, referenceImageUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==' };

const MONUMENT = {
  id: 'ART001', label: 'stone monument', name: 'stone monument', appearsInPages: [1],
  type: 'monument', scaleClass: 'building', description: 'a weathered stone column', ...REF,
};
const CHESTNUT = {
  id: 'ART002', label: 'roasted chestnut', name: 'roasted chestnut', appearsInPages: [1],
  type: 'food', scaleClass: 'hand', description: 'a split roasted chestnut', ...REF,
};
const SHIP = {
  id: 'VEH001', label: 'sailing ship', name: 'wooden sailing ship', appearsInPages: [1],
  scaleClass: 'building', description: 'a three-masted hull in tarred oak', ...REF,
};
const QUAY = {
  id: 'LOC001', label: 'the quay', name: 'the quay', appearsInPages: [1],
  isRealLandmark: false, scaleClass: 'landscape', description: 'a cobbled quay', ...REF,
};

const VB: any = {
  secondaryCharacters: [], animals: [],
  artifacts: [MONUMENT, CHESTNUT], vehicles: [SHIP], locations: [QUAY], clothing: [],
};

/** The same bible as a story stored before `scaleClass` existed. */
const LEGACY: any = JSON.parse(JSON.stringify(VB));
for (const key of ['artifacts', 'vehicles', 'locations']) {
  for (const e of LEGACY[key]) e.scaleClass = null;
}

describe('the predicate', () => {
  it('reads the three large bands and nothing else', () => {
    for (const c of ['vehicle', 'building', 'landscape', 'VEHICLE', ' building ']) {
      expect(isLargeScaleClass(c), c).toBe(true);
    }
    for (const c of ['hand', 'arm', 'person', null, undefined, '', 'huge']) {
      expect(isLargeScaleClass(c as any), String(c)).toBe(false);
    }
  });

  it('falls back to the type rule when the class is null — every stored bible', () => {
    expect(isPlateBorneElement({ type: 'vehicle', scaleClass: null })).toBe(true);
    expect(isPlateBorneElement({ type: 'location', scaleClass: null })).toBe(true);
    expect(isPlateBorneElement({ type: 'artifact', scaleClass: null })).toBe(false);
    // and the class overrides the collection: a building-scale ARTIFACT routes
    expect(isPlateBorneElement({ type: 'artifact', scaleClass: 'building' })).toBe(true);
  });
});

describe('the plate gains the large elements', () => {
  it('a building-scale ARTIFACT reaches the plate, a hand-scale one does not', () => {
    const refs = getEmptySceneElementReferences(VB, 1, 9, null, ['ART001', 'ART002', 'VEH001']);
    const ids = refs.map((r: any) => r.id);
    expect(ids).toContain('ART001');
    expect(ids).toContain('VEH001');
    expect(ids).not.toContain('ART002');
  });

  it('honours the Art Director as the authority on what is in frame', () => {
    const refs = getEmptySceneElementReferences(VB, 1, 9, null, ['ART002']);
    expect(refs.map((r: any) => r.id)).not.toContain('ART001');
  });

  it('still withholds the element the camera stands on', () => {
    const refs = getEmptySceneElementReferences(VB, 1, 9, 'VEH001', ['ART001', 'VEH001']);
    expect(refs.map((r: any) => r.id)).not.toContain('VEH001');
    expect(refs.map((r: any) => r.id)).toContain('ART001');
  });

  it('adds nothing new for a stored bible with no classes', () => {
    const refs = getEmptySceneElementReferences(LEGACY, 1, 9, null, ['ART001', 'VEH001']);
    // the location rides as it always did; nothing new is added
    expect(refs.map((r: any) => r.id)).toEqual(['VEH001', 'LOC001']);
  });
});

describe('the page loses them — but only when a plate is actually sent', () => {
  const sel = () => getElementReferenceImagesForPage(VB, 1, 4, ['ART001', 'ART002', 'VEH001']);

  it('selection itself still offers every element, class and all', () => {
    // Selection is not the routing step; the two filter sites are, because only
    // they know whether a plate was sent.
    const ids = sel().map((r: any) => r.id);
    expect(ids).toContain('ART001');
    expect(ids).toContain('ART002');
    expect(ids).toContain('VEH001');
    // and the class rides along so the filter sites can read it
    expect(sel().find((r: any) => r.id === 'ART001').scaleClass).toBe('building'); // raw, unparsed fixture: selection passes the authored token through
  });

  it('WITH a plate: every large element drops, the hand-scale prop stays', async () => {
    const { visualBibleGrid } = await buildPageCompositeRefs(VB, 1, [], {
      hasBackground: true, sceneObjectIds: ['ART001', 'ART002', 'VEH001'],
    });
    expect(visualBibleGrid).toBeTruthy();
    const ids = (visualBibleGrid as any).rawElements.map((e: any) => e.id);
    expect(ids).toEqual(['ART002']);
  });

  it('WITHOUT a plate: the large element KEEPS its cell rather than travelling on nothing', async () => {
    const { visualBibleGrid } = await buildPageCompositeRefs(VB, 1, [], {
      hasBackground: false, sceneObjectIds: ['ART001', 'ART002', 'VEH001'],
    });
    const ids = (visualBibleGrid as any).rawElements.map((e: any) => e.id).sort();
    expect(ids).toContain('ART001');
    expect(ids).toContain('VEH001');
  });

  /**
   * THE GATE ASYMMETRY (fixed 2026-09-15). The page-cell DROP filtered on
   * scaleClass/type alone while the plate INCLUSION additionally requires the AD
   * brief's objects[] to name the entry. A large element present via
   * `appearsInPages` but absent from objects[] was therefore dropped from the
   * page grid, never added to the plate and never named in STRUCTURES: rendered
   * with zero reference and zero description. The two gates must read the same
   * brief.
   */
  it('an element the AD brief does not name KEEPS its cell — it never reaches the plate', async () => {
    const objects = ['ART002'];   // the brief names only the hand-scale prop
    const plateIds = getEmptySceneElementReferences(VB, 1, 9, null, objects).map((r: any) => r.id);
    expect(plateIds).not.toContain('ART001');
    expect(plateIds).not.toContain('VEH001');

    const { visualBibleGrid } = await buildPageCompositeRefs(VB, 1, [], {
      hasBackground: true, sceneObjectIds: objects,
    });
    const ids = (visualBibleGrid as any).rawElements.map((e: any) => e.id).sort();
    // nothing may be dropped from the page that the plate refused
    expect(ids).toContain('ART001');
    expect(ids).toContain('VEH001');
    expect(ids).toContain('ART002');
  });

  it('the predicate itself refuses to drop what the brief does not name', () => {
    const ship = { id: 'VEH001', name: 'wooden sailing ship', type: 'vehicle', scaleClass: 'building' };
    expect(isPlateBorneElement(ship, ['VEH001'])).toBe(true);
    expect(isPlateBorneElement(ship, ['ART002'])).toBe(false);
    expect(isPlateBorneElement(ship, [])).toBe(false);
    // no brief supplied (covers, trial plates) → unchanged behaviour
    expect(isPlateBorneElement(ship)).toBe(true);
    expect(isPlateBorneElement(ship, null)).toBe(true);
    // a location is not AD-gated on either side
    expect(isPlateBorneElement({ id: 'LOC001', name: 'the quay', type: 'location' }, ['ART002'])).toBe(true);
  });

  it('a stored bible keeps exactly its pre-2026-09-15 behaviour', async () => {
    const withPlate = await buildPageCompositeRefs(LEGACY, 1, [], {
      hasBackground: true, sceneObjectIds: ['ART001', 'ART002', 'VEH001'],
    });
    // type-based rule only: the vehicle and the location go, both artifacts stay
    const ids = (withPlate.visualBibleGrid as any).rawElements.map((e: any) => e.id).sort();
    expect(ids).toEqual(['ART001', 'ART002']);
  });
});

/**
 * THE ORDERING BUG (storyJobPipeline.js, fixed 2026-09-15). `vbRefElementIds`
 * was computed from the UNFILTERED selection while the grid filter dropped
 * cells afterwards, so the prompt could tell the model "the attached reference
 * images include a rough image of <the ship>" when no such image was attached.
 * The contract pinned here is: the claim is built from the cells ACTUALLY SENT.
 */
describe('the prompt never claims a reference the call does not carry', () => {
  const brief = [
    'The main character stands on the quay beside the stone monument.',
    '',
    '---METADATA---',
    JSON.stringify({
      sceneIntent: 'the monument is seen', shot: 'wide',
      characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
      objects: ['ART001', 'ART002'], textPosition: 'bottom-left',
    }),
  ].join(String.fromCharCode(10));

  const inputData: any = {
    title: 'The Quay', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }],
    mainCharacters: ['c1'], language: 'en', languageLevel: 'medium', pages: 4,
    artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
  };
  const build = (ids: string[]) =>
    String(buildImagePrompt(brief, inputData, null, VB, 1, null, { vbRefElementIds: ids }));

  it('claims the monument when its cell rides along', () => {
    expect(build(['ART001', 'ART002'])).toContain('stone monument');
    expect(build(['ART001', 'ART002'])).toMatch(/rough image/i);
  });

  it('drops the claim for a cell the plate filter removed', () => {
    const selected = [MONUMENT, CHESTNUT].map(e => ({ id: e.id, type: 'artifact', scaleClass: e.scaleClass }));
    const kept = selected.filter(e => !isPlateBorneElement(e)).map(e => e.id);
    expect(kept).toEqual(['ART002']);
    const prompt = build(kept);
    // The monument is still NAMED (it is on the page) but no longer announced
    // as an attached reference image.
    const claim = prompt.split(/rough images? of/i)[1] || '';
    expect(claim).not.toContain('stone monument');
  });
});

/**
 * The pipeline half of the same contract. `storyJobPipeline`'s Phase 5a-pre-grid
 * is where the cells are actually chosen, and it is not reachable from a unit
 * test without loading the whole pipeline — so what is pinned here is the one
 * structural fact that caused the bug: the reference claim is rebuilt from the
 * KEPT set after the filter, never from the selection before it.
 */
describe('Phase 5a-pre-grid rebuilds the claim from the kept cells', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');

  it('routes large elements to the plate through the shared predicate', () => {
    expect(src).toContain('isPlateBorneElement');
    // conditional on a plate being sent — the no-plate fallback
    expect(src).toContain('? refs.filter(e => !isPlateBorneElement(e, pageSceneObjectsForDrop))');
  });

  it('recomputes the prompt from the kept set, not from the selection', () => {
    expect(src).toContain('pageData.makeImagePrompt(kept.map(e => e.id).filter(Boolean))');
    expect(src).not.toContain('vbRefElementIds: elementReferences.map(r => r.id).filter(Boolean)');
  });
});

/**
 * A FIGURE IS NEVER PLATE-BORNE (fixed 2026-09-15). secondaryCharacters and
 * animals were routed onto the empty-scene plate whenever the bible classed them
 * large — a plate whose prompt says verbatim "never draw a figure named anywhere
 * in this prompt" and whose STRUCTURES block calls its entries a "vessel,
 * vehicle or built structure". The creature lost its page cell, the plate was
 * forbidden to draw it and the plate text mislabelled it: no cell, no plate, no
 * consistency. A creature must end up with one or the other, and it is the cell.
 */
describe('a large creature keeps its cell and never rides the plate', () => {
  const DRAGON = {
    id: 'ANI001', label: 'house dragon', name: 'house dragon', appearsInPages: [1],
    scaleClass: 'building', description: 'a slate-scaled dragon the size of a barn', ...REF,
  };
  const GIANT = {
    id: 'CHR002', label: 'the giant', name: 'the giant', appearsInPages: [1],
    scaleClass: 'building', description: 'a moss-bearded giant', ...REF,
  };
  const VB2: any = { ...VB, animals: [DRAGON], secondaryCharacters: [GIANT] };

  it('the plate refuses both', () => {
    const ids = getEmptySceneElementReferences(VB2, 1, 9, null, ['ANI001', 'CHR002', 'VEH001']).map((r: any) => r.id);
    expect(ids).not.toContain('ANI001');
    expect(ids).not.toContain('CHR002');
    expect(ids).toContain('VEH001');
  });

  it('the predicate refuses to drop a figure at any scale', () => {
    expect(isPlateBorneElement({ id: 'ANI001', name: 'house dragon', type: 'animal', scaleClass: 'building' }, ['ANI001'])).toBe(false);
    expect(isPlateBorneElement({ id: 'CHR002', name: 'the giant', type: 'character', scaleClass: 'landscape' }, ['CHR002'])).toBe(false);
  });

  it('the plate PROSE never lists a figure under STRUCTURES', () => {
    const { buildEmptyScenePrompt } = require('../../server/services/prompts');
    const text = String(buildEmptyScenePrompt({
      template: '{EMPTY_SCENE_DESCRIPTION}',
      description: 'A barn yard at dusk.',
      visualBible: VB2, pageNumber: 1, sceneObjects: ['ANI001', 'CHR002', 'VEH001'],
    }) || '');
    expect(text).toContain('STRUCTURES');   // the vehicle still gets its line
    const structures = text.split('**STRUCTURES:**')[1] || '';
    expect(structures).not.toContain('house dragon');
    expect(structures).not.toContain('the giant');
  });
});
