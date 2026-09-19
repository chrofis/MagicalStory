import { describe, it, expect } from 'vitest';

/**
 * AMBIENT BACKGROUND LIFE IS NOT CAST (2026-09-19).
 *
 * Every figure fixture below is VERBATIM from `stories.data.sceneImages[].
 * bboxDetection.figures` on staging — not an invented shape. Boxes are
 * normalised [x1,y1,x2,y2].
 *
 * The defect: `crowdExpected` was BINARY, so a public square — which holds
 * distant people who are neither cast nor a crowd — was judged `false` and the
 * presence arithmetic billed a CRITICAL `extra_character` on correct pictures.
 * Measured: 4 such CRITICALs on job_1789759147125_p08djwhbl,
 * 4 on job_1789506283204_3kxqshifx, 9 on job_1789420511893_zly5rcdej.
 */
const { isMicroFigure, countRealFigures, countAmbientFigures, ambientAreaCeiling, figureFrameArea, hasAmbientGeometry } =
  require('../../server/lib/bboxDetection');
const { normalisePopulation } = require('../../server/lib/sceneMetadata');
const { derivePresenceFinding, buildExpectedCastBlock } = require('../../server/lib/evalPipeline');

// job_1789759147125_p08djwhbl p2 — Lindenhof, a public square. Levin + Julian
// in the foreground, six distant park-goers on the wall and the far paving.
// The picture is correct; the page scored -17.
const LINDENHOF_P2 = [
  { name: 'Julian', confidence: 'high', faceBox: [0.28369140625, 0.46943359375, 0.53369140625, 0.68193359375], facePoint: [602, 452], samPoints: [{ at: [602, 452], role: 'face' }], gdinoBox: [0.3017578125, 0.2705078125, 0.7705078125, 0.70703125] },
  { name: 'Levin', confidence: 'high', faceBox: [0.06103515625, 0.22822265625, 0.31103515625, 0.44072265625], facePoint: [332, 189], samPoints: [{ at: [332, 189], role: 'face' }], gdinoBox: [0.0625, 0.158203125, 0.744140625, 0.4423828125] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.3662109375, 0.703125, 0.478515625, 0.7421875] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.29046875, 0.864671875, 0.42046875, 0.975171875], facePoint: null, samPoints: [], gdinoBox: [0.40234375, 0.861328125, 0.4775390625, 0.908203125] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.31787109375, 0, 0.56787109375, 0.17607421875], facePoint: [26, 377], samPoints: [{ at: [26, 377], role: 'face' }], gdinoBox: [0.3525390625, 0, 0.48828125, 0.0478515625] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.40625, 0.8935546875, 0.4755859375, 0.9267578125] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.2080078125, 0.0021484375, 0.4580078125, 0.2146484375], facePoint: [111, 341], samPoints: [{ at: [111, 341], role: 'face' }], gdinoBox: [0.3134765625, 0.0732421875, 0.494140625, 0.146484375] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.255859375, 0, 0.505859375, 0.1970703125], facePoint: [93, 390], samPoints: [{ at: [93, 390], role: 'face' }], gdinoBox: [0.3544921875, 0.0419921875, 0.54296875, 0.14453125] },
];

// job_1789506283204_3kxqshifx p8 — the same square, Levin alone, five distant
// adults by the chess board and the wall.
const LINDENHOF_P8 = [
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.3466796875, 0.5646484375, 0.5966796875, 0.7771484375], facePoint: [594, 354], samPoints: [{ at: [594, 354], role: 'face' }], gdinoBox: [0.3330078125, 0.5615234375, 0.46484375, 0.6083984375] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.212890625, 0, 0.462890625, 0.159265625], facePoint: [52, 346], samPoints: [{ at: [52, 346], role: 'face' }], gdinoBox: [0.322265625, 0.017578125, 0.4892578125, 0.0888671875] },
  { name: 'Levin', confidence: 'high', faceBox: [0.3349609375, 0.5732421875, 0.5986328125, 0.8095703125], facePoint: [708, 478], samPoints: [{ at: [708, 478], role: 'face' }], gdinoBox: [0.3251953125, 0.5703125, 0.83203125, 0.947265625] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.212890625, 0.0626953125, 0.462890625, 0.2751953125], facePoint: [173, 346], samPoints: [{ at: [173, 346], role: 'face' }], gdinoBox: [0.3212890625, 0.1337890625, 0.4755859375, 0.208984375] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.265625, 0.05, 0.515625, 0.2625], facePoint: [160, 400], samPoints: [{ at: [160, 400], role: 'face' }], gdinoBox: [0.3671875, 0.1162109375, 0.498046875, 0.197265625] },
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.28314453125, 0.84855859375, 0.41314453125, 0.95905859375], facePoint: [895, 381], samPoints: [{ at: [895, 381], role: 'face' }], gdinoBox: [0.36328125, 0.853515625, 0.43359375, 0.900390625] },
];

// job_1789420511893_zly5rcdej p16 — THE CASE THAT MUST KEEP FIRING. Emma, Noah
// and Daniel on the ship; a fourth child stands on the quay in the foreground,
// uncommissioned. He is 5.45% of frame against a cast whose smallest member is
// 3.10% — 1.8x the smallest cast figure, and nothing like background life.
const QUAY_P16 = [
  { name: 'UNKNOWN', confidence: 'low', faceBox: [0.4951171875, 0.3087890625, 0.7451171875, 0.5212890625], facePoint: [425, 635], samPoints: [{ at: [425, 635], role: 'face' }], gdinoBox: [0.5810546875, 0.3369140625, 0.92578125, 0.4951171875] },
  { name: 'Daniel', confidence: 'high', faceBox: [0.06982421875, 0.22041015625, 0.31982421875, 0.43291015625], facePoint: [328, 198], samPoints: [{ at: [328, 198], role: 'face' }], gdinoBox: [0.150390625, 0.2138671875, 0.5693359375, 0.3837890625] },
  { name: 'Noah', confidence: 'high', faceBox: [0.0771484375, 0.3419921875, 0.3271484375, 0.5544921875], facePoint: [539, 290], samPoints: [{ at: [539, 290], role: 'face' }], gdinoBox: [0.23828125, 0.455078125, 0.5244140625, 0.5634765625] },
  { name: 'Emma', confidence: 'high', faceBox: [0.1923828125, 0.212109375, 0.4423828125, 0.424609375], facePoint: [447, 322], samPoints: [{ at: [447, 322], role: 'face' }], gdinoBox: [0.2724609375, 0.361328125, 0.5478515625, 0.4765625] },
];

/** The evaluator's side of the contract: one match per figure, same order. */
const evaluatorReply = (figures: any[], named: string[]) => ({
  figures: figures.map((_, i) => ({ figure: i + 1 })),
  matches: figures.map((_, i) => ({ figure: i + 1, reference: named[i] || 'unmatched', confidence: named[i] ? 0.9 : 0 })),
});

const roster = (names: string[], population: string) => ({
  names, count: names.length, declared: true, population,
  crowdExpected: population === 'crowd', nonHumanNames: [],
});

describe('population is three states, not a boolean', () => {
  it('normalises the enum and keeps the legacy boolean working in both directions', () => {
    expect(normalisePopulation('ambient', false)).toBe('ambient');
    expect(normalisePopulation('crowd', false)).toBe('crowd');
    expect(normalisePopulation('cast_only', true)).toBe('cast_only');
    expect(normalisePopulation('Cast Only', false)).toBe('cast_only');
    // Every stored row and every brief written before the field exists.
    expect(normalisePopulation(null, true)).toBe('crowd');
    expect(normalisePopulation(undefined, undefined)).toBe('cast_only');
    // An unknown value is never trusted into permissiveness.
    expect(normalisePopulation('busy', false)).toBe('cast_only');
  });
});

describe('ambient figures are separated from cast by scale alone', () => {
  it('drops every distant park-goer on the Lindenhof pages and no cast member', () => {
    // Two of the eight are micro-figures and were already pruned; the other
    // four background people are what this change adds.
    expect(countAmbientFigures(LINDENHOF_P2)).toBe(4);
    expect(countRealFigures(LINDENHOF_P2) - countAmbientFigures(LINDENHOF_P2)).toBe(2);
    expect(countAmbientFigures(LINDENHOF_P8)).toBe(5);
    expect(countRealFigures(LINDENHOF_P8) - countAmbientFigures(LINDENHOF_P8)).toBe(1);
  });

  it('does NOT drop the uncommissioned cast-scale child on the quay', () => {
    expect(countAmbientFigures(QUAY_P16)).toBe(0);
    // The relative cap is what does it: this cast is small, so the ceiling is.
    expect(ambientAreaCeiling(QUAY_P16)).toBeLessThan(0.01);
    expect(figureFrameArea(QUAY_P16[0])).toBeGreaterThan(ambientAreaCeiling(QUAY_P16));
  });

  it('never calls a figure ambient when it has no usable normalised box', () => {
    expect(figureFrameArea({ confidence: 'low' })).toBeNull();
    expect(figureFrameArea({ gdinoBox: [10, 20, 300, 400] })).toBeNull(); // pixel space
    expect(countAmbientFigures([{ confidence: 'low' }, { gdinoBox: [10, 20, 300, 400] }])).toBe(0);
  });

  it('leaves the micro-figure filter alone — it still prunes what it always did', () => {
    expect(isMicroFigure(LINDENHOF_P2[2])).toBe(true);
    expect(isMicroFigure(LINDENHOF_P2[0])).toBe(false);
  });
});

describe('derivePresenceFinding: ambient pages', () => {
  // `detectedFigureCount` reaching the derivation is ALREADY micro-filtered in
  // production (evalPipeline reads countRealFigures), and the evaluator's own
  // figure list has to agree with it or the two-witness rule declines first.
  const P2_REAL = LINDENHOF_P2.filter((f: any) => !isMicroFigure(f));
  const p2 = evaluatorReply(P2_REAL, ['Julian', 'Levin']);
  const p16 = evaluatorReply(QUAY_P16, ['', 'Daniel', 'Noah', 'Emma']);

  it('emits no finding on the Lindenhof page once the setting is declared ambient', () => {
    const out = derivePresenceFinding({
      ...p2, cast: roster(['Levin', 'Julian'], 'ambient'),
      detectedFigureCount: P2_REAL.length, detectorFigures: LINDENHOF_P2,
      referenceNames: ['Levin', 'Julian'],
    });
    expect(out.outcome).toBe('declined');
    expect(out.reason).toBe('ambient_background');
    expect(out.finding).toBeNull();
  });

  it('still emits the CRITICAL on the same page when the brief says cast-only', () => {
    const out = derivePresenceFinding({
      ...p2, cast: roster(['Levin', 'Julian'], 'cast_only'),
      detectedFigureCount: P2_REAL.length, detectorFigures: LINDENHOF_P2,
      referenceNames: ['Levin', 'Julian'],
    });
    expect(out.outcome).toBe('extra_character');
    expect(out.finding.severity).toBe('CRITICAL');
  });

  it('still catches the uncommissioned cast-scale figure on an AMBIENT quay', () => {
    const out = derivePresenceFinding({
      ...p16, cast: roster(['Emma', 'Noah', 'Daniel'], 'ambient'),
      detectedFigureCount: QUAY_P16.length, detectorFigures: QUAY_P16,
      referenceNames: ['Emma', 'Noah', 'Daniel'],
    });
    expect(out.outcome).toBe('extra_character');
    expect(out.finding.severity).toBe('CRITICAL');
    expect(out.finding.description).toContain('1 more figure(s)');
  });

  it('declines on an ambient page whose figures carry labels but no boxes', () => {
    // The detector's VLM fallback shape — job_1789420511893_zly5rcdej p3/p4.
    const boxless = [
      { name: 'Emma', confidence: 'high', faceBox: null, facePoint: null, samPoints: [] },
      { name: 'UNKNOWN', confidence: 'high', faceBox: null, facePoint: null, samPoints: [] },
      { name: 'UNKNOWN', confidence: 'high', faceBox: null, facePoint: null, samPoints: [] },
    ];
    expect(hasAmbientGeometry(boxless)).toBe(false);
    const out = derivePresenceFinding({
      ...evaluatorReply(boxless, ['Emma']),
      cast: roster(['Emma'], 'ambient'),
      detectedFigureCount: 3, detectorFigures: boxless, referenceNames: ['Emma'],
    });
    expect(out.outcome).toBe('declined');
    expect(out.reason).toBe('ambient_without_geometry');
  });

  it('declines rather than guessing when an ambient page has no detector geometry', () => {
    const out = derivePresenceFinding({
      ...p2, cast: roster(['Levin', 'Julian'], 'ambient'),
      detectedFigureCount: P2_REAL.length, detectorFigures: null,
      referenceNames: ['Levin', 'Julian'],
    });
    expect(out.outcome).toBe('declined');
    expect(out.reason).toBe('ambient_without_geometry');
  });

  it('keeps the crowd page declining exactly as the boolean did', () => {
    const crowdRosters = [
      roster(['Levin', 'Julian'], 'crowd'),
      { ...roster(['Levin', 'Julian'], 'cast_only'), crowdExpected: true },
    ];
    for (const cast of crowdRosters) {
      const out = derivePresenceFinding({
        ...p2, cast, detectedFigureCount: P2_REAL.length,
        detectorFigures: LINDENHOF_P2, referenceNames: ['Levin', 'Julian'],
      });
      expect(out.outcome).toBe('declined');
      expect(out.reason).toBe('crowd_expected');
    }
  });

  it('never suppresses a SHORTFALL — a missing cast member is unaffected', () => {
    const figs = [QUAY_P16[1], QUAY_P16[2]];
    const out = derivePresenceFinding({
      ...evaluatorReply(figs, ['Daniel', 'Noah']),
      cast: roster(['Emma', 'Noah', 'Daniel'], 'ambient'),
      detectedFigureCount: 2, detectorFigures: figs, referenceNames: ['Emma', 'Noah', 'Daniel'],
    });
    expect(out.outcome).toBe('missing_character');
    expect(out.finding.character).toBe('Emma');
  });
});

describe('the BUILT prompt tells the judge what the Art Director declared', () => {
  const build = (sceneMetadata: any) => buildExpectedCastBlock({
    sceneCharacters: [{ name: 'Levin' }, { name: 'Julian' }],
    sceneMetadata, evaluationType: 'scene',
  });

  it('states the population on every page, in all three states', () => {
    expect(build({ population: 'ambient' }).block).toContain('SETTING POPULATION: ambient');
    expect(build({ population: 'crowd' }).block).toContain('SETTING POPULATION: crowd');
    expect(build({}).block).toContain('SETTING POPULATION: cast-only');
    // The legacy boolean still reaches the judge as the crowd line.
    expect(build({ crowdExpected: true }).block).toContain('SETTING POPULATION: crowd');
  });

  it('carries the population onto the roster the arithmetic reads', () => {
    expect(build({ population: 'ambient' }).population).toBe('ambient');
    expect(build({ population: 'ambient' }).crowdExpected).toBe(false);
    expect(build({ population: 'crowd' }).crowdExpected).toBe(true);
  });
});
