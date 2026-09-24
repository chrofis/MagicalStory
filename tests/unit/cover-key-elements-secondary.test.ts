import { describe, it, expect } from 'vitest';

// A cover hint may name a SECONDARY CHARACTER (a creature the cast rides or
// stands beside). The cover NAME invariant must treat it as sendable when its
// renders live only on state cells. (The KEY STORY ELEMENTS block this file
// also pinned was deleted 2026-09-23: a cover element's look now comes from the
// Art Director's cover `Scene` prose, exactly as a page's does.)
//
// Evidence: staging job_1789078732136_622wecmhj front cover — hint objects
// [LOC001, ANI001, CHR001], every position "on Fenn's back"; CHR001 (a dragon,
// renders only on its state cells CHR001.1/.2) never entered the prompt, only
// the dog ANI001 was defined, and the four riders were painted on the dog.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { hasElementReference } = require('../../server/lib/visualBible');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { matchVbEntitiesInText, reconcileCoverSceneEntities } = require('../../server/lib/coverIterate');

const REF = { referenceImageUrl: 'https://r2.example/ref.png' };

const vb: any = {
  locations: [{ id: 'LOC001', name: 'Old Square', referencePhotoUrl: 'x' }],
  secondaryCharacters: [
    {
      id: 'CHR001', name: 'Fenn',
      description: 'a dragon, broad-chested and sturdy, tall enough to carry four small children on his back',
      // NO parent-level reference image — renders live on the state cells only.
      states: [
        { handle: 'CHR001.1', delta: 'resting', ...REF },
        { handle: 'CHR001.2', delta: 'standing', ...REF },
      ],
    },
    { id: 'CHR002', name: 'Runo', description: 'a raven, full-sized adult bird', ...REF },
  ],
  animals: [{ id: 'ANI001', name: 'Nia', description: 'dog, medium-sized mixed breed', ...REF }],
  artifacts: [{ id: 'ART001', name: 'the scale', description: 'a golden scale', ...REF }],
  vehicles: [{ id: 'VEH001', name: 'the bicycle', description: 'a red child bicycle', ...REF }],
};

describe('cover name invariant is state-aware', () => {
  it('a stated entity with only state-cell renders counts as referenced', () => {
    expect(hasElementReference(vb.secondaryCharacters[0])).toBe(true);
    const hit = matchVbEntitiesInText("Levin stands on Fenn's back.", vb).find((h: any) => h.id === 'CHR001');
    expect(hit?.hasReference).toBe(true);
  });

  it('is never stripped from a hint-less cover description; it is injected instead', () => {
    const desc = "Levin, a preschooler little boy, stands in the left, standing upright on Fenn's back, eyes on the viewer.";
    const out = reconcileCoverSceneEntities({ sceneDescription: desc, visualBible: vb, elementIds: null, label: 'TEST' });
    expect(out.sceneDescription).toContain("Fenn's back");
    expect(out.stripped).toHaveLength(0);
    expect(out.injected.map((i: any) => i.id)).toContain('CHR001');
    expect(out.elementIds).toContain('CHR001');
  });
});
