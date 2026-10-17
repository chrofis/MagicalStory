/**
 * THE VESSEL THE CAMERA STANDS ON IS NOT AN OBJECT TO DRAW (staging
 * job_1792226018737_lb65hzkqs: 74 versions on 50 pages in 7 stories set aboard
 * the story's ship showed a SECOND whole ship behind the cast).
 *
 * A: the page prompt listed the boarded vehicle under REQUIRED OBJECTS with a
 *    size ("several adults high"); it now carries the plate's on-board sentence
 *    instead (one constant), and the expected-objects lists drop it.
 * B: a customer regenerate did not carry `aboard` (and the other page context a
 *    rewrite does not re-decide) forward the way iterate does; one shared
 *    function now does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const VB = cjs('../../server/lib/visualBible.js');
const PB = cjs('../../server/lib/promptBuilders.js');
const SM = cjs('../../server/lib/sceneMetadata.js');
const { parseVisualBibleObjects } = cjs('../../server/lib/bboxDetection.js');
const { loadPromptTemplates, buildPlateStructuresText } = cjs('../../server/services/prompts.js');

const bible = () => ({
  vehicles: [{ id: 'VEH001', name: 'pirate ship', description: 'a three-masted pirate ship with a red hull', scaleClass: 'house-sized', pages: [3] }],
  animals: [{ id: 'ANI001', name: 'Rubina', description: 'a dragon', scaleClass: 'twice-adult-height', appearsInPages: [3] }],
  artifacts: [], locations: [], clothing: [],
});
const input = { characters: [{ name: 'Eliah', age: '6', gender: 'male' }], artStyle: 'pixar', language: 'en' };
const brief = (extra: Record<string, unknown>) => {
  const meta = { characters: [{ name: 'Eliah', position: 'center' }], objects: ['VEH001'], ...extra };
  return `Eliah stands at the rail.\n\n---METADATA---\n${JSON.stringify(meta)}`;
};
const build = (extra: Record<string, unknown>) =>
  String(PB.buildImagePrompt(brief(extra), input, input.characters, bible(), 3, null, {}));

beforeAll(async () => { await loadPromptTemplates(); });

describe('A — the page prompt for a page set aboard', () => {
  it('does not list the boarded vehicle as a required object, and says the camera stands on it', () => {
    const p = build({ aboard: 'VEH001' });
    expect(parseVisualBibleObjects(p)).toEqual([]);
    expect(p).not.toMatch(/\*\s+\*\*pirate ship\*\*/);
    expect(p).toContain(`pirate ship: ${VB.ABOARD_CAMERA_RULE}`);
  });

  it('negative: the same vehicle seen from outside (not aboard) is still a required object', () => {
    const p = build({ aboard: null });
    expect(parseVisualBibleObjects(p)).toContain('pirate ship');
    expect(p).not.toContain(VB.ABOARD_CAMERA_RULE);
  });

  it('negative: a ridden creature (ANI) stays listed, it is drawn in the page', () => {
    const meta = { objects: ['ANI001'], aboard: 'ANI001' };
    const p = String(PB.buildImagePrompt(brief(meta), input, input.characters, bible(), 3, null, {}));
    expect(parseVisualBibleObjects(p)).toContain('Rubina');
  });

  it('keeps the other required objects of the page', () => {
    const p = build({ aboard: 'VEH001', objects: ['VEH001', 'ANI001'] });
    expect(parseVisualBibleObjects(p)).toEqual(['Rubina']);
    expect(p).toContain(VB.ABOARD_CAMERA_RULE);
  });

  it('the plate prompt and the page prompt carry the same sentence', () => {
    const plate = buildPlateStructuresText({ visualBible: bible(), pageNumber: 3, aboardId: 'VEH001', sceneObjects: ['VEH001'] });
    expect(plate).toContain(VB.ABOARD_CAMERA_RULE);
  });
});

describe('A — the critic side reads the same list', () => {
  it('expectedObjectIds drops the aboard vehicle (and handles a facet), nothing else', () => {
    expect(VB.expectedObjectIds({ objects: ['VEH001', 'ART001.2', 'ANI001'], aboard: 'VEH001' })).toEqual(['ART001.2', 'ANI001']);
    expect(VB.expectedObjectIds({ objects: ['VEH001.1', 'ART001'], aboard: 'VEH001' })).toEqual(['ART001']);
  });
  it('no aboard, or a creature aboard, drops nothing', () => {
    expect(VB.expectedObjectIds({ objects: ['VEH001'], aboard: null })).toEqual(['VEH001']);
    expect(VB.expectedObjectIds({ objects: ['ANI001'], aboard: 'ANI001' })).toEqual(['ANI001']);
    expect(VB.expectedObjectIds(null)).toEqual([]);
  });
});

describe('B — page context a rewrite does not re-decide is carried forward', () => {
  const saved = { aboard: 'VEH001', era: 'medieval', textZoneDescription: 'calm sky', population: 'ambient', shot: 'wide', wornItems: [] };
  it('a silent rewrite keeps aboard, era, text zone, population and shot', () => {
    const merged = SM.carryForwardPageContext({ objects: ['VEH001'] }, saved);
    expect(merged).toMatchObject({ aboard: 'VEH001', era: 'medieval', textZoneDescription: 'calm sky', population: 'ambient', shot: 'wide' });
  });
  it('negative: a rewrite that states a value wins', () => {
    const merged = SM.carryForwardPageContext({ aboard: 'VEH002', era: 'modern' }, saved);
    expect(merged.aboard).toBe('VEH002');
    expect(merged.era).toBe('modern');
  });
  it('the stored-brief variant writes the carried fields into the METADATA block', () => {
    const rewritten = 'New prose.\n\n---METADATA---\n' + JSON.stringify({ characters: [{ name: 'Eliah' }], objects: ['VEH001'], era: 'modern' });
    const carry = SM.carryForwardPageContextInBrief(rewritten, saved);
    expect(carry.carried).toEqual(['aboard', 'textZoneDescription', 'population', 'shot']);
    const meta = SM.extractSceneMetadata(carry.brief);
    expect(meta.aboard).toBe('VEH001');
    expect(meta.era).toBe('modern');
  });
  it('negative: nothing missing, nothing carried', () => {
    const full = 'P.\n\n---METADATA---\n' + JSON.stringify({ characters: [{ name: 'Eliah' }], aboard: 'VEH001', era: 'x', textZoneDescription: 'y', population: 'sparse', shot: 'wide' });
    expect(SM.carryForwardPageContextInBrief(full, saved)).toBeNull();
  });
});
