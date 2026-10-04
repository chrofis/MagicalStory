/**
 * A PLATE HOLDS NO PEOPLE; THE PAGE DRAWS THE SETTING'S PEOPLE (owner, 2026-09-26).
 *
 * A vantage plate is shared by every page on it, so a passer-by painted on the
 * plate repeats on each of those pages (staging job_1789506283204_3kxqshifx: the
 * same six people on 17 pages). The plate author, the derive edit and the plate
 * QC read one constant; the page render draws background people from the brief's
 * `population`, the same field the judges read.
 *
 * And the per-page band note must never name a character or a count: "1
 * character in the foreground (1 on the left) and 1 character in the midground
 * (1 on the right) will be composited into this scene later" got exactly those
 * two figures painted onto the plate (job_1789348171785_9oxos7dwv p16).
 *
 * These pin BEHAVIOUR of the real builders, not the wording of any template.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const SV = require_('../../server/lib/shotVocabulary');
const { loadPromptTemplates, buildEmptyScenePrompt, buildPlateDerivePrompt } = require_('../../server/services/prompts');
const { buildEmptySceneQcPrompt, buildExpectedCastBlock, derivePresenceFinding } = require_('../../server/lib/evalPipeline');
const PB = require_('../../server/lib/promptBuilders');

beforeAll(async () => { await loadPromptTemplates(); });

// The stored characters of job_1789348171785_9oxos7dwv p16 (depth + position).
const P16_CHARACTERS = [
  { name: 'A', depth: 'foreground', position: 'left foreground' },
  { name: 'B', depth: 'midground', position: 'right midground' },
];

describe('the plate band note names surfaces, never figures', () => {
  it('the per-page note carries no character, no figure and no count', () => {
    const note = SV.buildPlateSurfaceNote(P16_CHARACTERS, 'wide');
    expect(note).toMatch(/foreground/);
    expect(note).toMatch(/midground/);
    expect(note).not.toMatch(/\bcharacters?\b|\bfigures?\b|\bpeople\b|\bperson\b|composited/i);
    expect(note).not.toMatch(/\d/);
  });

  it('a band with figures on both sides is told to stay open on both sides', () => {
    const note = SV.buildPlateSurfaceNote([
      { depth: 'foreground', position: 'left foreground' },
      { depth: 'foreground', position: 'right foreground' },
    ], 'wide');
    expect(note).toMatch(/far left and far right of the foreground/);
  });

  it('a page with no characters gets no note; a vantage gets the all-bands note, figure-free', () => {
    expect(SV.buildPlateSurfaceNote([], 'wide')).toBe('');
    const vantage = SV.buildPlateSurfaceNote(null);
    expect(vantage).toMatch(/foreground, midground and background/);
    expect(vantage).not.toMatch(/\bcharacters?\b|\bfigures?\b|composited/i);
  });
});

describe('every plate prompt states the one no-people rule', () => {
  it('the plate author gets it, even over a description that mentions people', () => {
    const p = buildEmptyScenePrompt({
      style: 'watercolor',
      description: 'A city square; a few distant passers-by cross the far side.',
      characterSpace: SV.buildPlateSurfaceNote(P16_CHARACTERS, 'medium'),
    });
    expect(p).toContain(SV.PLATE_NO_PEOPLE_RULE);
    expect(p).not.toContain('{PLATE_NO_PEOPLE}');
    expect(p).not.toMatch(/\d character/);
  });

  it('the derive / relight edit gets it', () => {
    const p = buildPlateDerivePrompt('Move the camera.', 'watercolor');
    expect(p).toContain(SV.PLATE_NO_PEOPLE_RULE);
    expect(p).not.toContain('{PLATE_NO_PEOPLE}');
  });

  it('the plate QC fails any person, even one the expected scene names', () => {
    const qc = buildEmptySceneQcPrompt({ sceneDescription: 'A market square full of passers-by.' });
    expect(qc).toContain(SV.PLATE_PEOPLE);
    expect(qc).not.toContain('{PLATE_PEOPLE}');
    expect(qc).not.toMatch(/passers-by the scene names is fine/i);
  });
});

describe('the page render draws the setting\'s people from `population`', () => {
  const inputData: any = {
    title: 'T', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }], mainCharacters: ['c1'],
    language: 'en', pages: 4, storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor',
    relationships: {}, relationshipTexts: {},
  };
  const VB: any = { artifacts: [], locations: [], vehicles: [], characters: [] };
  const build = (meta: any) => PB.buildImagePrompt(
    `Mira crosses the square.\n\n---METADATA---\n${JSON.stringify({
      sceneIntent: 'she crosses', characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
      shot: 'wide', objects: [], textPosition: 'bottom-left', ...meta,
    })}`, inputData, null, VB, 1, null, {});
  const castLine = (p: string) => p.split('\n').find(l => l.startsWith('**REQUIRED CAST:**')) || '';

  it('ambient: a few distant passers-by, never a cast look-alike', () => {
    const line = castLine(build({ population: 'ambient' }));
    expect(line).toBe(PB.buildRequiredCastRule('ambient'));
    expect(line).toMatch(/passers-by/);
    expect(line).not.toBe(PB.buildRequiredCastRule('cast_only'));
  });

  it('crowd: the people the brief places; the legacy boolean still reads as crowd', () => {
    expect(castLine(build({ population: 'crowd' }))).toBe(PB.buildRequiredCastRule('crowd'));
    expect(castLine(build({ crowdExpected: true }))).toBe(PB.buildRequiredCastRule('crowd'));
  });

  it('cast_only, or no field at all: nobody is added', () => {
    expect(castLine(build({ population: 'cast_only' }))).toBe(PB.buildRequiredCastRule('cast_only'));
    expect(castLine(build({}))).toBe(PB.buildRequiredCastRule('cast_only'));
    expect(PB.buildRequiredCastRule('cast_only')).not.toMatch(/passers-by/);
  });

  it('the three lines differ, so the illustrator is told what the judge will excuse', () => {
    const lines = new Set(['cast_only', 'ambient', 'crowd'].map(PB.buildRequiredCastRule));
    expect(lines.size).toBe(3);
  });
});

describe('population is the brief\'s declared field — no plate reading', () => {
  const build = (sceneMetadata: any) => buildExpectedCastBlock({
    sceneCharacters: [{ name: 'Levin' }, { name: 'Julian' }], sceneMetadata, evaluationType: 'scene',
  });

  it('a stored platePopulation no longer raises a cast_only brief', () => {
    const cast = build({ population: 'cast_only', platePopulation: 'ambient' });
    expect(cast.population).toBe('cast_only');
    expect(cast.block).toContain('SETTING POPULATION: cast-only');
  });

  it('a declared ambient page still reaches the judge and the arithmetic as ambient', () => {
    const cast = build({ population: 'ambient' });
    expect(cast.population).toBe('ambient');
    expect(cast.block).toContain('SETTING POPULATION: ambient');
  });

  // job_1789420511893_zly5rcdej p16: an uncommissioned cast-scale child on a
  // cast_only page (verbatim stored figures). The real defect still fires.
  const QUAY_P16 = [
    { name: 'UNKNOWN', confidence: 'low', faceBox: [0.4951171875, 0.3087890625, 0.7451171875, 0.5212890625], facePoint: [425, 635], samPoints: [{ at: [425, 635], role: 'face' }], gdinoBox: [0.5810546875, 0.3369140625, 0.92578125, 0.4951171875] },
    { name: 'Daniel', confidence: 'high', faceBox: [0.06982421875, 0.22041015625, 0.31982421875, 0.43291015625], facePoint: [328, 198], samPoints: [{ at: [328, 198], role: 'face' }], gdinoBox: [0.150390625, 0.2138671875, 0.5693359375, 0.3837890625] },
    { name: 'Noah', confidence: 'high', faceBox: [0.0771484375, 0.3419921875, 0.3271484375, 0.5544921875], facePoint: [539, 290], samPoints: [{ at: [539, 290], role: 'face' }], gdinoBox: [0.23828125, 0.455078125, 0.5244140625, 0.5634765625] },
    { name: 'Emma', confidence: 'high', faceBox: [0.1923828125, 0.212109375, 0.4423828125, 0.424609375], facePoint: [447, 322], samPoints: [{ at: [447, 322], role: 'face' }], gdinoBox: [0.2724609375, 0.361328125, 0.5478515625, 0.4765625] },
  ];
  const named = ['', 'Daniel', 'Noah', 'Emma'];
  const reply = {
    figures: QUAY_P16.map((_, i) => ({ figure: i + 1 })),
    matches: QUAY_P16.map((_, i) => ({ figure: i + 1, reference: named[i] || 'unmatched', confidence: named[i] ? 0.9 : 0 })),
  };
  const presence = (population: string) => derivePresenceFinding({
    ...reply,
    cast: { declared: true, names: ['Emma', 'Noah', 'Daniel'], count: 3, population, crowdExpected: false, nonHumanNames: [] },
    detectedFigureCount: 4, detectorFigures: QUAY_P16, referenceNames: ['Emma', 'Noah', 'Daniel'],
  });

  it('a cast-scale surplus still fires extra_character on a cast_only page, and on an ambient one', () => {
    expect(presence('cast_only').outcome).toBe('extra_character');
    expect(presence('ambient').outcome).toBe('extra_character');
  });
});
