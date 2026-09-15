import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildImagePrompt } = require_('../../server/lib/promptBuilders.js');
const { getElementReferenceImagesForPage } = require_('../../server/lib/visualBible.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');

/**
 * A worn item nothing links to the wearer's wardrobe must keep its reference
 * plate AND its REQUIRED OBJECTS line — worded "worn on <character>".
 *
 * Real shapes from staging job_1789420511893_zly5rcdej p13: ART002, a navy
 * captain's cap the child FINDS, declared `{id, owner: Emma, state: "worn"}`
 * on nine pages with no `wornAs` link anywhere in the bible, while Emma's own
 * outfit text and her attached cell still carried her black tricorn. The plate
 * was dropped on all nine pages and the item omitted from REQUIRED OBJECTS, so
 * the call held one text line naming a cap and one picture of a tricorn —
 * p13/p14 rendered a navy TRICORN.
 */
const EMMA_OUTFIT = 'A black felt tricorn hat with a red cockade, a white linen shirt, brown breeches, black buckle shoes';

const CAP = {
  id: 'ART002',
  name: "navy-blue captain's cap",
  type: 'headwear',
  description: "a navy-blue wool captain's cap with a stiff black visor, a flat crown, and a bright gold metal anchor emblem pinned to the front centre.",
  appearsInPages: [5, 6, 7, 9, 10, 11, 13, 14, 15],
  referenceImageGenerated: true,
  referenceImageUrl: 'https://images-staging.example/vb/ART002.jpg',
};

const metadata = {
  characters: [
    { name: 'Noah', position: 'left', clothing: 'costumed', depth: 'midground', expression: 'eager' },
    { name: 'Emma', position: 'right', clothing: 'costumed', depth: 'foreground', expression: 'determined' },
  ],
  objects: ['LOC001', 'ART002'],
  wornItems: [{ id: 'ART002', owner: 'Emma', state: 'worn', location: null }],
  emptyScenePrompt: 'A stone quay at dusk.',
};
const sceneDescription = 'Two children haul on a mooring rope at the quay.\n---METADATA---\n' + JSON.stringify(metadata);

const visualBible = { artifacts: [CAP], clothing: [], locations: [], vehicles: [], animals: [], secondaryCharacters: [] };
const inputData = { language: 'en', artStyle: 'watercolor', characters: [{ id: 1, name: 'Emma', age: 7 }, { id: 2, name: 'Noah', age: 8 }] };
const sceneCharacters = metadata.characters;
const referencePhotos = [
  { name: 'Emma', photoUrl: 'data:image/jpeg;base64,AAAA', clothingCategory: 'costumed', clothingDescription: EMMA_OUTFIT },
  { name: 'Noah', photoUrl: 'data:image/jpeg;base64,AAAA', clothingCategory: 'costumed', clothingDescription: 'A striped jersey, grey trousers, leather shoes' },
];

describe('an unlinked worn item keeps its reference and its object line', () => {
  it('the plate is NOT dropped from the page element references', () => {
    const refs = getElementReferenceImagesForPage(visualBible, 13, 4, metadata.objects, metadata);
    expect(refs.map((r: any) => r.id)).toContain('ART002');
  });

  it('the built prompt lists it WORN ON the wearer, not as a loose prop', async () => {
    await loadPromptTemplates();
    const prompt = buildImagePrompt(sceneDescription, inputData, sceneCharacters, visualBible, 13, referencePhotos, {});
    expect(prompt).toMatch(/worn on Emma, not a separate free-standing copy/);
    // The two-direction worn line still says who wears it.
    expect(prompt).toMatch(/Emma IS wearing this on this page/);
  });
});

describe('the linked-item drop is unchanged (job_1788641639919 p3 precedent)', () => {
  const linkedBible = {
    ...visualBible,
    artifacts: [{ ...CAP, id: 'ART001', name: 'red woollen hat', wornAs: 'Emma.headwear' }],
  };
  const linkedMeta = {
    ...metadata,
    objects: ['LOC001', 'ART001'],
    wornItems: [{ id: 'ART001', owner: 'Emma', state: 'worn', location: null }],
  };
  const linkedScene = 'Two children haul on a mooring rope at the quay.\n---METADATA---\n' + JSON.stringify(linkedMeta);

  it('the owner wears it and her avatar reference carries it — no plate, no object line', async () => {
    const refs = getElementReferenceImagesForPage(linkedBible, 13, 4, linkedMeta.objects, linkedMeta);
    expect(refs.map((r: any) => r.id)).not.toContain('ART001');
    await loadPromptTemplates();
    const prompt = buildImagePrompt(linkedScene, inputData, sceneCharacters, linkedBible, 13, referencePhotos, {});
    expect(prompt).not.toMatch(/worn on Emma, not a separate free-standing copy/);
  });
});
