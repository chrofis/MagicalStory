import { describe, it, expect } from 'vitest';

const { secondaryCastSeeds, unreferencedSecondaryCreatures } = require('../../server/lib/compositeCastBuilder');
const { needsScaleRepair } = require('../../server/lib/scaleRepair');

/**
 * A secondary character the brief stages as a CHR id (objects[] / interactions)
 * is a figure: the composite casts it and the trigger counts it. Until now a
 * schema-correct two-figure page read as one figure and the composite pasted
 * the main character into the other character's empty boat (Lab exp 1101).
 */
describe('secondary characters staged as CHR ids', () => {
  const vb = { secondaryCharacters: [{ id: 'CHR001', name: 'Malva Grimm', referenceImageUrl: 'https://x/CHR001.jpg', description: 'a wiry woman' }] };
  const fullData = {
    characters: [{ name: 'Fiona', depth: 'foreground', position: 'right foreground', looksAt: 'CHR001' }],
    objects: ['LOC004', 'ART001.1', 'CHR001', 'VEH002'],
    interactions: [
      { character: 'Fiona', object: 'ART001.1', action: 'pressing the chart against her coat', where: 'presses the chart flat against her coat' },
      { character: 'CHR001', object: 'ART001.1', action: 'watching', where: 'watching the chart from the rowing boat below, gaze directed upward' },
    ],
  };

  it('seeds a cast entry from the bible with the interaction\'s action and gaze', () => {
    const seeds = secondaryCastSeeds(fullData, vb);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ id: 'CHR001', name: 'Malva Grimm', depth: 'midground', looksAt: 'ART001.1' });
    expect(seeds[0].action).toMatch(/rowing boat below/);
    expect(seeds[0].entry.referenceImageUrl).toBe('https://x/CHR001.jpg');
  });

  it('does not duplicate a secondary already in the cast, and ignores unknown ids', () => {
    expect(secondaryCastSeeds(fullData, vb, new Set(['malva grimm']))).toHaveLength(0);
    expect(secondaryCastSeeds({ objects: ['CHR999'], interactions: [] }, vb)).toHaveLength(0);
    expect(secondaryCastSeeds(fullData, null)).toHaveLength(0);
  });

  it('the trigger does NOT count a CHR-id secondary: the production composite cannot cast it (job_1789083667794, the dragon vanished from four plates)', () => {
    expect(needsScaleRepair({ fullData: { ...fullData, setting: 'outdoor' } })).toBe(false);
    // one figure only -> no composite
    expect(needsScaleRepair({ fullData: { characters: fullData.characters, objects: ['LOC004'], interactions: [fullData.interactions[0]], setting: 'outdoor' } })).toBe(false);
  });

  it('a figure in a boat no longer excludes the page', () => {
    const md = { fullData: { setting: 'outdoor', objects: [], interactions: [], characters: [
      { name: 'A', depth: 'foreground', position: 'left foreground' },
      { name: 'B', depth: 'background', position: 'in the boat, far out' },
    ] } };
    expect(needsScaleRepair(md)).toBe(true);
  });

  it('indoor pages still skip the composite', () => {
    expect(needsScaleRepair({ fullData: { ...fullData, setting: 'indoor' } })).toBe(false);
  });
});

/**
 * A staged secondary character with no bible reference image cannot be cast;
 * it is offered to the plate as a creature painted from its description
 * (job_1789083667794: CHR001 the dragon, referenceImageUrl null, absent from
 * every composited plate).
 */
describe('unreferencedSecondaryCreatures', () => {
  const vb = { secondaryCharacters: [
    { id: 'CHR001', name: 'Karu', description: 'a young dragon, about 2 metres tall at the shoulder' },
    { id: 'CHR002', name: 'Rico', referenceImageUrl: 'https://x/CHR002.jpg', description: 'a boy' },
  ] };

  it('returns only the staged secondaries that have no reference image, in plate-creature shape', () => {
    const out = unreferencedSecondaryCreatures({ objects: ['CHR001.1', 'CHR002', 'LOC003'] }, vb);
    expect(out).toEqual([{ id: 'CHR001', name: 'Karu', description: 'a young dragon, about 2 metres tall at the shoulder' }]);
  });

  it('is empty when the page stages nobody without a reference', () => {
    expect(unreferencedSecondaryCreatures({ objects: ['CHR002'] }, vb)).toEqual([]);
    expect(unreferencedSecondaryCreatures({ objects: [] }, vb)).toEqual([]);
    expect(unreferencedSecondaryCreatures({ objects: ['CHR001.2'] }, null)).toEqual([]);
  });
});

/**
 * From 2026-09-13 the scene reviewer promotes a Visual Bible secondary INTO
 * `characters[]` (scene-review rules 5/5a reconcile the cast against the page
 * plan line, which names the secondary — job_1789304198359 pages 9/10/14/15).
 * A `characters[]` row is therefore no longer proof the composite has a figure
 * to cast, so the trigger intersects against the story's photo-backed cast.
 */
describe('the trigger counts only photo-backed characters', () => {
  const outdoor = (characters: any[]) => ({ fullData: { setting: 'outdoor', objects: [], interactions: [], characters } });
  const fg = { name: 'Fiona', depth: 'foreground', position: 'right foreground' };
  const promotedSecondary = { name: 'Ondine', depth: 'background', position: 'far out on the water' };
  const realSecond = { name: 'Rico', depth: 'background', position: 'far up the path' };
  const photoBacked = [{ name: 'Fiona' }, { name: 'Rico' }];

  it('does NOT trip when the second characters[] row is not photo-backed', () => {
    expect(needsScaleRepair(outdoor([fg, promotedSecondary]), photoBacked)).toBe(false);
  });

  it('still trips for two genuinely photo-backed characters at foreground + background', () => {
    expect(needsScaleRepair(outdoor([fg, realSecond]), photoBacked)).toBe(true);
  });

  it('a promoted secondary does not top up a page that is otherwise one castable figure', () => {
    expect(needsScaleRepair(outdoor([fg, promotedSecondary, realSecond]), [{ name: 'Fiona' }])).toBe(false);
    expect(needsScaleRepair(outdoor([fg, promotedSecondary, realSecond]), photoBacked)).toBe(true);
  });

  it('matches names case- and whitespace-insensitively, and accepts plain names or a Set', () => {
    expect(needsScaleRepair(outdoor([fg, realSecond]), ['  fiona ', 'RICO'])).toBe(true);
    expect(needsScaleRepair(outdoor([fg, realSecond]), new Set(['fiona', 'rico']))).toBe(true);
  });

  it('an omitted cast list keeps the old behaviour — callers that cannot supply one are unchanged', () => {
    expect(needsScaleRepair(outdoor([fg, promotedSecondary]))).toBe(true);
    expect(needsScaleRepair(outdoor([fg, promotedSecondary]), null)).toBe(true);
  });

  it('an empty cast list casts nobody', () => {
    expect(needsScaleRepair(outdoor([fg, realSecond]), [])).toBe(false);
  });
});
