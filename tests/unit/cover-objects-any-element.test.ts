import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// A COVER IS BRIEFED THE WAY A PAGE IS (owner, 2026-09-23).
//   - an element's LOOK comes from the Art Director's prose — the cover hint's
//     `Scene` field, parsed like the rest of the hint;
//   - its PRESENCE comes from REQUIRED OBJECTS, built by the page builder from
//     the brief's `---METADATA---` block (coverBriefWithObjects);
//   - there is no separate cover block (KEY STORY ELEMENTS is deleted).
// Stored stories whose hint has no `Scene` get no substitute look text.

const require_ = createRequire(import.meta.url);
const CI = require_('../../server/lib/coverIterate');
const VB = require_('../../server/lib/visualBible');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const PB = require_('../../server/lib/promptBuilders');
const { VB_ELEMENT_BUDGET } = require_('../../server/lib/vbElementBudget');

// Archetypal fixture, not from any story.
const bible = () => ({
  mainCharacters: [], secondaryCharacters: [], clothing: [],
  locations: [{ id: 'LOC001', name: 'harbour', description: 'a stone harbour wall' }],
  animals: [{ id: 'ANI001', name: 'Pip', description: 'a small grey harbour seal', scaleClass: 'knee-high', referenceImageUrl: 'https://r2/ani.jpg' }],
  vehicles: [{ id: 'VEH001', name: 'fishing boat', label: 'fishing boat', colorAndDetails: 'a red wooden fishing boat', signatureElement: 'a white wheelhouse',
    description: 'a red wooden fishing boat. Signature: a white wheelhouse', referenceImageUrl: 'https://r2/veh.jpg' }],
  artifacts: [{ id: 'ART001', name: 'brass lantern', label: 'brass lantern', description: 'a small brass lantern with a glass chimney', referenceImageUrl: 'https://r2/art.jpg' }],
});
const SCENE = 'A small grey seal with a speckled back rests on the wall beside a red wooden fishing boat with a white wheelhouse.';
const hint = (objects: string[], scene = SCENE, holds = 'nothing') => ({
  objects, scene,
  characterDetails: { Ada: { name: 'Ada', position: 'center', holds, priority: 'essential' } },
});
const requiredObjects = (prompt: string) => {
  const m = prompt.match(/\*\*REQUIRED OBJECTS[^*]*\*\*:?\s*([\s\S]*?)(?=\n\n|$)/i);
  return m ? m[1] : '';
};

describe('the cover hint carries the Art Director\'s Scene prose', () => {
  it('the live parser reads a Scene line per cover; a hint without one has none', () => {
    const { UnifiedStoryParser } = require_('../../server/lib/outlineParser/unified');
    const raw = [
      '---COVER SCENE HINTS---',
      '**Title Page**', 'Mood: calm morning', 'Objects: LOC001, ANI001', `Scene: ${SCENE}`,
      'Characters:', '- Ada (center): standard, holds: nothing, priority: essential',
      '', '**Initial Page**', 'Mood: quiet', 'Objects: LOC001',
      'Characters:', '- Ada (center): standard, holds: nothing, priority: essential',
    ].join('\n');
    const hints = new UnifiedStoryParser(raw).extractCoverHints();
    expect(hints.frontCover.scene).toBe(SCENE);
    expect(hints.initialPage.scene).toBe('');
  });

  it('buildCoverSceneFromHint makes it the cover\'s scene prose', () => {
    const prose = CI.buildCoverSceneFromHint(hint(['LOC001', 'ANI001', 'VEH001']), bible(), [], { language: 'en' });
    expect(prose).toContain(SCENE);
  });

  it('a stored hint with no Scene gets no substitute look text', () => {
    const prose = CI.buildCoverSceneFromHint(hint(['LOC001', 'ANI001'], ''), bible(), [], { language: 'en' });
    expect(prose).not.toContain('seal');
    expect(prose).not.toContain('Also in the scene');
  });

  it('a one-person cover forbids other PEOPLE, not the listed animal', () => {
    const prose = CI.buildCoverSceneFromHint(hint(['LOC001', 'ANI001']), bible(), [], { language: 'en' });
    expect(prose).not.toMatch(/no other figures/);
    expect(prose).toMatch(/no other people/);
  });
});

describe('REQUIRED OBJECTS on a full-path cover, through the page builder', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const build = (objects: string[], exclude: string[] = []) => {
    const prose = CI.buildCoverSceneFromHint(hint(objects), bible(), [], { language: 'en' });
    const brief = CI.coverBriefWithObjects(prose, objects, exclude);
    return String(PB.buildCoverPrompt('back', {
      sceneDescription: brief, inputData: { language: 'en', artStyle: 'watercolor' }, characters: [], visualBible: bible(),
      referencePhotos: [], options: { characterReferenceListOverride: '' },
    }));
  };
  it('lists every ANI / VEH / ART, name-only with scale, and no KEY STORY ELEMENTS block', () => {
    const prompt = build(['LOC001', 'ANI001', 'VEH001', 'ART001']);
    const block = requiredObjects(prompt);
    expect(block).toContain('**Pip** (animal)');
    expect(block).toMatch(/fishing boat\*\* \(vehicle\)/);
    expect(block).toMatch(/brass lantern\*\* \(object\)/);
    expect(block).not.toContain('harbour'); // a location is never listed
    expect(prompt).not.toContain('KEY STORY ELEMENTS');
    // the look is in the scene prose, not in the checklist (2026-09-02 name-only rule)
    expect(block).not.toContain('speckled');
    expect(prompt).toContain('speckled back');
    // the metadata block itself never reaches the image model
    expect(prompt).not.toContain('---METADATA---');
  });
  it('a worn-wins item is not listed as a loose object', () => {
    expect(requiredObjects(build(['LOC001', 'ART001'], ['ART001']))).not.toMatch(/lantern/);
  });
  it('the plate drops the Scene prose and the metadata', () => {
    const prose = CI.buildCoverSceneFromHint(hint(['LOC001', 'ANI001']), bible(), [], { language: 'en' });
    const brief = CI.coverBriefWithObjects(prose, ['LOC001', 'ANI001']);
    const plate = CI.buildPlateDescription(require_('../../server/lib/sceneMetadata').splitBrief(brief).prose, ['Ada'], bible(), -3, { excludeText: [SCENE] });
    expect(plate).not.toContain('seal');
    expect(plate).not.toContain('METADATA');
  });
});

describe('a trial cover keeps its JSON brief; an injected entity joins its objects', () => {
  it('withTrialCoverObjects adds a missing id once and leaves prose briefs alone', () => {
    const json = '```json\n' + JSON.stringify({ scene: { imageSummary: 'x', objects: [{ id: 'LOC001' }] } }) + '\n```';
    const out = CI.withTrialCoverObjects(json, ['ANI001', 'LOC001']);
    const parsed = JSON.parse(out.replace(/^```json\n/, '').replace(/\n```$/, ''));
    expect(parsed.scene.objects.map((o: any) => o.id)).toEqual(['LOC001', 'ANI001']);
    expect(CI.withTrialCoverObjects('plain prose', ['ANI001'])).toBe('plain prose');
  });
});

describe('KEY STORY ELEMENTS is gone', () => {
  it('the builder no longer exists', () => {
    expect(VB.buildFullVisualBiblePrompt).toBeUndefined();
    expect(VB.COVER_KEY_ELEMENT_CAP).toBeUndefined();
  });
});

describe('vehicleDescription — the authored shape has no description field', () => {
  it('derives it from colorAndDetails + signatureElement; an authored one stands', () => {
    expect(VB.vehicleDescription({ colorAndDetails: 'a blue tram', signatureElement: 'wide windows' })).toBe('a blue tram. Signature: wide windows');
    expect(VB.vehicleDescription({ description: 'as written', colorAndDetails: 'x' })).toBe('as written');
    expect(VB.vehicleDescription({})).toBeNull();
  });
  it('the live unified parse gives an AD-shaped vehicle its description', () => {
    const { UnifiedStoryParser } = require_('../../server/lib/outlineParser/unified');
    const vb = { vehicles: [{ id: 'VEH001', name: 'city tram', pages: [1], colorAndDetails: 'a blue and white tram', signatureElement: 'wide glass windows' }] };
    const raw = `---VISUAL BIBLE---\n\`\`\`json\n${JSON.stringify(vb)}\n\`\`\`\n`;
    const parsed = new UnifiedStoryParser(raw).extractVisualBible();
    expect(parsed.vehicles[0].description).toBe('a blue and white tram. Signature: wide glass windows');
  });
});

describe('the cover element cap is the page element budget, in both writers', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const input = { language: 'en', characters: [{ id: 1, name: 'Ada', isMainCharacter: true }], mainCharacters: [1], pages: 4 };
  it('trial writer and Art Director are filled with VB_ELEMENT_BUDGET', () => {
    const trial = String(PB.buildTrialStoryPrompt(input, 4));
    const ad = String(PB.buildSceneExpansionAllPrompt(input, [{ pageNumber: 1, planLine: 'medium — Ada — x — y' }], {}));
    for (const p of [trial, ad]) expect(p).not.toContain('{COVER_ELEMENT_CAP}');
    expect(trial).toContain(`up to ${VB_ELEMENT_BUDGET} Visual Bible animals`);
    expect(ad).toContain(`at most ${VB_ELEMENT_BUDGET}, on any of the three covers`);
    expect(ad).toContain('Scene: [English prose');
  });
});
