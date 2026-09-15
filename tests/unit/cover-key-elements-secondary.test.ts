import { describe, it, expect } from 'vitest';

// A cover hint may name a SECONDARY CHARACTER (a creature the cast rides or
// stands beside). KEY STORY ELEMENTS used to read animals + artifacts only, so
// the name reached the model with no species.
//
// Evidence: staging job_1789078732136_622wecmhj front cover — hint objects
// [LOC001, ANI001, CHR001], every position "on Fenn's back"; CHR001 (a dragon,
// renders only on its state cells CHR001.1/.2) never entered the prompt, only
// the dog ANI001 was defined, and the four riders were painted on the dog.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildFullVisualBiblePrompt, hasElementReference } = require('../../server/lib/visualBible');
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

const keyBlock = (prompt: string) => prompt.slice(prompt.indexOf('**KEY STORY ELEMENTS:**'));

describe('KEY STORY ELEMENTS on covers includes hint-named secondary characters', () => {
  it('emits the CHR entry with its species, before the animal, and nothing the hint did not ask for', () => {
    const prompt = buildFullVisualBiblePrompt(vb, {
      skipMainCharacters: true,
      allowedElementIds: ['LOC001', 'ANI001', 'CHR001'],
    });
    const block = keyBlock(prompt);
    expect(block).toContain('**Fenn** (character): a dragon, broad-chested');
    expect(block).toContain('**Nia** (animal): dog');
    expect(block.indexOf('**Fenn**')).toBeLessThan(block.indexOf('**Nia**'));
    expect(block).not.toContain('Runo');
    expect(block).not.toContain('golden scale');
    expect(block).not.toContain('bicycle');
  });

  it('emits a hint-named vehicle with a generic English lead', () => {
    const block = keyBlock(buildFullVisualBiblePrompt(vb, { skipMainCharacters: true, allowedElementIds: ['VEH001'] }));
    expect(block).toContain('**Vehicle**: a red child bicycle');
  });

  it('hint-less legacy covers keep animals + artifacts only (no CHR/VEH dump)', () => {
    const block = keyBlock(buildFullVisualBiblePrompt(vb, { skipMainCharacters: true }));
    expect(block).toContain('**Nia** (animal)');
    expect(block).toContain('**Artifact**: a golden scale');
    expect(block).not.toContain('Fenn');
    expect(block).not.toContain('Runo');
    expect(block).not.toContain('bicycle');
  });

  it('secondary characters count first against the 3-element cap', () => {
    const block = keyBlock(buildFullVisualBiblePrompt(vb, {
      skipMainCharacters: true,
      allowedElementIds: ['CHR001', 'CHR002', 'ANI001', 'ART001', 'VEH001'],
    }));
    expect(block).toContain('**Fenn** (character)');
    expect(block).toContain('**Runo** (character)');
    expect(block).toContain('**Nia** (animal)');
    expect(block).not.toContain('golden scale');
    expect(block).not.toContain('bicycle');
  });
});

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
