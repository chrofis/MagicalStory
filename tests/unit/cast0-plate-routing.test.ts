import { describe, it, expect } from 'vitest';

// Cast-0 pages used to render as pure text-to-image while a finished background
// plate of the same scene was built and thrown away. Three rules, locked here:
//
//   1. A page with no named cast gets NO empty-scene plate. The plate exists to
//      anchor character placement; with nobody to place, the render IS the
//      scene. Expressed as `emptyScene: 'skip'` on the route descriptor.
//   2. applyReferenceMode('off') drops the CHARACTER photos and nothing else.
//      The VB grid, the empty-scene plate and the landmark photos all stay:
//      'off' turns off PERSONAL identity references, and neither a plate nor a
//      landmark photo is one. It used to null both the plate and the landmark,
//      so the cast-0 page — the one page type that has no character refs at
//      all — went to the model with prose only.
//   3. The element the camera stands on/inside (`aboard`) never enters the page
//      VB grid. Its render is an exterior three-quarter view, and rule 1 now
//      routes deck-level cast-0 pages down the no-plate branch where the grid
//      is NOT filtered — without this the exterior would ride along and paint a
//      second copy of the vessel (decisions.md 2026-09-02).
//
// Evidence: staging story job_1788295892348_l028ggiq7a page 1 (cast 0, harbour
// wide shot of the ship) attached zero reference images; its VB cells VEH001 +
// LOC001 were dropped because a plate existed, and the plate was then dropped
// by refMode 'off'.

// @ts-expect-error - JS module without types
import { decidePageRoute, pageCastSize } from '../../server/lib/imageRouter.js';
// @ts-expect-error - JS module without types
import { applyReferenceMode } from '../../server/lib/clothingResolve.js';
// @ts-expect-error - JS module without types
import { buildPageCompositeRefs } from '../../server/lib/referenceSheets.js';

const page = (names: string[]) => ({
  pageNumber: 1,
  sceneMetadata: { fullData: { characters: names.map(name => ({ name })) } },
});

describe('pageCastSize', () => {
  it('counts named characters from any of the three shapes', () => {
    expect(pageCastSize(page([]))).toBe(0);
    expect(pageCastSize(page(['A', 'B']))).toBe(2);
    expect(pageCastSize({ sceneMetadata: { characters: ['A'] } })).toBe(1);
    expect(pageCastSize({ sceneCharacters: [{ name: 'A' }, { name: 'B' }] })).toBe(2);
    expect(pageCastSize({})).toBe(0);
  });
});

describe('decidePageRoute — empty-scene plate', () => {
  it('skips the plate on a cast-0 page', () => {
    const r = decidePageRoute(page([]), {}, {});
    expect(r.cast).toBe(0);
    expect(r.emptyScene).toBe('skip');
    expect(r.refMode).toBe('off');
  });

  it('keeps the plate as soon as one named character has to be placed', () => {
    for (const cast of [1, 2, 3, 4, 6]) {
      const names = Array.from({ length: cast }, (_, i) => `C${i}`);
      expect(decidePageRoute(page(names), {}, {}).emptyScene).toBe('reuse');
    }
  });

  it('still skips the plate when the composite router is disabled (production)', () => {
    // enableSceneComposite=false rewrites path/reason but must not resurrect
    // the plate for a page with nobody on it.
    const r = decidePageRoute(page([]), {}, { enableSceneComposite: false });
    expect(r.path).toBe('direct');
    expect(r.emptyScene).toBe('skip');
    expect(r.refMode).toBe('off');
  });
});

describe("applyReferenceMode 'off'", () => {
  const args = {
    mode: 'off',
    characterPhotos: [{ name: 'A', photoUrl: 'data:image/jpeg;base64,AA' }],
    visualBibleGrid: { rawElements: [{ id: 'VEH001', type: 'vehicle' }] },
    landmarkPhotos: [{ name: 'Castle' }],
    sceneBackground: 'data:image/jpeg;base64,PLATE',
    sceneMetadata: null,
  };

  it('drops the character photos — and only those', () => {
    const out = applyReferenceMode(args);
    expect(out.characterPhotos).toEqual([]);
  });

  it('keeps the VB grid and the scene plate', () => {
    const out = applyReferenceMode(args);
    expect(out.visualBibleGrid).toBe(args.visualBibleGrid);
    expect(out.sceneBackground).toBe(args.sceneBackground);
  });

  it('keeps the landmark photos — a place\'s identity is not a person\'s', () => {
    // Owner, 2026-09-02: "of course they must get a landmark". A cast-0
    // establishing shot of a landmark is the page that most needs the curated
    // photo, and it was the one page that never received it.
    expect(applyReferenceMode(args).landmarkPhotos).toBe(args.landmarkPhotos);
  });

  it('passes a missing plate through as null (nothing invented)', () => {
    expect(applyReferenceMode({ ...args, sceneBackground: null }).sceneBackground).toBeNull();
  });
});

describe('buildPageCompositeRefs — aboard element', () => {
  const vb = (extra: any[] = []) => ({
    vehicles: [{
      id: 'VEH001', name: 'Ship', appearsInPages: [1],
      // 1×1 white JPEG as a data: URI — real bytes, loaded without network so
      // the grid composer can actually run here (the VB loader fetches
      // referenceImageUrl, and Node's fetch resolves data: URLs locally).
      referenceImageUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    }],
    animals: [], artifacts: [], secondaryCharacters: [], locations: extra,
  });

  it('withholds the aboard element from the grid', async () => {
    const refs = await buildPageCompositeRefs(vb(), 1, [], { aboardId: 'VEH001' });
    expect(refs.visualBibleGrid).toBeNull();
  });

  it('keeps it when the camera is not aboard it', async () => {
    const refs = await buildPageCompositeRefs(vb(), 1, [], {});
    expect(refs.visualBibleGrid).not.toBeNull();
  });

  it('keeps other elements when one is the aboard element', async () => {
    const refs = await buildPageCompositeRefs(vb(), 1, [], { aboardId: 'VEH999' });
    expect(refs.visualBibleGrid).not.toBeNull();
  });
});
