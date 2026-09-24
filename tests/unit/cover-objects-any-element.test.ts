import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// ANY Visual Bible animal, artifact or vehicle may ride on ANY cover (owner,
// 2026-09-23). These pin the downstream half: an ANI/VEH the cover lists must
// reach the cover the same way an ART does — named in the cover scene (which is
// also the brief the cover judges score against), defined in KEY STORY
// ELEMENTS, and handed a reference cell — and never be painted into the
// people-free plate.

const require_ = createRequire(import.meta.url);
const { buildCoverSceneFromHint, buildPlateDescription } = require_('../../server/lib/coverIterate');
const {
  buildFullVisualBiblePrompt, getElementReferenceImagesByIds, vehicleDescription, COVER_KEY_ELEMENT_CAP,
} = require_('../../server/lib/visualBible');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const PB = require_('../../server/lib/promptBuilders');

// Archetypal fixture, not from any story.
const bible = () => ({
  mainCharacters: [], secondaryCharacters: [],
  locations: [{ id: 'LOC001', name: 'harbour', description: 'a stone harbour wall' }],
  animals: [{ id: 'ANI001', name: 'Pip', description: 'a small grey harbour seal', referenceImageUrl: 'https://r2/ani.jpg' }],
  vehicles: [{ id: 'VEH001', name: 'fishing boat', colorAndDetails: 'a red wooden fishing boat', signatureElement: 'a white wheelhouse',
    description: 'a red wooden fishing boat. Signature: a white wheelhouse', referenceImageUrl: 'https://r2/veh.jpg' }],
  artifacts: [{ id: 'ART001', name: 'brass lantern', description: 'a small brass lantern with a glass chimney', referenceImageUrl: 'https://r2/art.jpg' }],
});
const hint = (objects: string[], holds = 'nothing') => ({
  objects,
  characterDetails: { Ada: { name: 'Ada', position: 'center', holds, priority: 'essential' } },
});

describe('buildCoverSceneFromHint — the hint\'s own elements are in the scene', () => {
  it('names every unheld ANI / VEH / ART the hint lists', () => {
    const prose = buildCoverSceneFromHint(hint(['LOC001', 'ANI001', 'VEH001', 'ART001']), bible(), [], { language: 'en' });
    expect(prose).toContain('Pip');
    expect(prose).toMatch(/fishing boat/);
    expect(prose).toMatch(/lantern/);
  });
  it('a held element is named once, in its holder\'s sentence', () => {
    const prose = buildCoverSceneFromHint(hint(['LOC001', 'ART001'], 'ART001'), bible(), [], { language: 'en' });
    expect(prose.match(/lantern/g)!.length).toBe(1);
  });
  it('a one-person cover forbids other PEOPLE, not the listed animal', () => {
    const prose = buildCoverSceneFromHint(hint(['LOC001', 'ANI001']), bible(), [], { language: 'en' });
    expect(prose).not.toMatch(/no other figures/);
    expect(prose).toMatch(/no other people/);
  });
  it('no element listed — no extra sentence', () => {
    const prose = buildCoverSceneFromHint(hint(['LOC001']), bible(), [], { language: 'en' });
    expect(prose).not.toMatch(/Also in the scene/);
  });
});

describe('the cover plate stays free of the listed elements', () => {
  it('buildPlateDescription drops the hint-elements sentence', () => {
    const prose = buildCoverSceneFromHint(hint(['LOC001', 'ANI001']), bible(), [], { language: 'en' });
    const plate = buildPlateDescription(prose, ['Ada'], bible(), -1);
    expect(plate).not.toContain('Pip');
  });
});

describe('KEY STORY ELEMENTS and reference cells carry ANI and VEH like ART', () => {
  it('defines each listed element, a vehicle included, with a real description', () => {
    const text = buildFullVisualBiblePrompt(bible(), { skipMainCharacters: true, allowedElementIds: ['ANI001', 'VEH001', 'ART001'] });
    expect(text).toContain('harbour seal');
    expect(text).toContain('red wooden fishing boat');
    expect(text).toContain('brass lantern');
    expect(text).not.toContain('undefined');
  });
  it('hands a reference cell to each', () => {
    const ids = getElementReferenceImagesByIds(bible(), ['ANI001', 'VEH001', 'ART001'], -1).map((r: any) => r.id).sort();
    expect(ids).toEqual(['ANI001', 'ART001', 'VEH001']);
  });
});

describe('vehicleDescription — the authored shape has no description field', () => {
  it('derives it from colorAndDetails + signatureElement; an authored one stands', () => {
    expect(vehicleDescription({ colorAndDetails: 'a blue tram', signatureElement: 'wide windows' })).toBe('a blue tram. Signature: wide windows');
    expect(vehicleDescription({ description: 'as written', colorAndDetails: 'x' })).toBe('as written');
    expect(vehicleDescription({})).toBeNull();
  });
  it('the live unified parse gives an AD-shaped vehicle its description', () => {
    const { UnifiedStoryParser } = require_('../../server/lib/outlineParser/unified');
    const vb = { vehicles: [{ id: 'VEH001', name: 'city tram', pages: [1], colorAndDetails: 'a blue and white tram', signatureElement: 'wide glass windows' }] };
    const raw = `---VISUAL BIBLE---\n\`\`\`json\n${JSON.stringify(vb)}\n\`\`\`\n`;
    const parsed = new UnifiedStoryParser(raw).extractVisualBible();
    expect(parsed.vehicles[0].description).toBe('a blue and white tram. Signature: wide glass windows');
  });
});

describe('the cover element cap reaches both writers', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const input = { language: 'en', characters: [{ id: 1, name: 'Ada', isMainCharacter: true }], mainCharacters: [1], pages: 4 };
  it('trial writer and Art Director are filled with COVER_KEY_ELEMENT_CAP', () => {
    const trial = String(PB.buildTrialStoryPrompt(input, 4));
    const ad = String(PB.buildSceneExpansionAllPrompt(input, [{ pageNumber: 1, planLine: 'medium — Ada — x — y' }], {}));
    for (const p of [trial, ad]) {
      expect(p).not.toContain('{COVER_ELEMENT_CAP}');
      expect(p).toContain(`${COVER_KEY_ELEMENT_CAP}`);
    }
  });
});
