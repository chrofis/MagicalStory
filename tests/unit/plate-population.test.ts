import { describe, it, expect } from 'vitest';

/**
 * THE PLATE IS EVIDENCE; THE ART DIRECTOR'S DECLARATION IS AN OPINION
 * (owner, 2026-09-19).
 *
 * `population` used to be whatever the Art Director SAID the setting held, and
 * that is the input that got it wrong — the brief asserted "No other people or
 * animals are present" about the Lindenhof, a public plaza whose own
 * empty-scene plate holds eight people.
 *
 * Every plate below was pulled from staging `story_images` (image_type
 * 'empty_scene') and LOOKED AT; the figure counts are what is in the picture.
 * The boxes are representative geometry at the measured scale, not a detector
 * transcript, because the plate pass normalises DINO's pixel boxes itself.
 */
const {
  platePopulationFromFigures,
  PLATE_CROWD_MIN,
  MICRO_AREA_FLOOR,
  derivePresenceFinding,
} = {
  ...require('../../server/lib/bboxDetection'),
  ...require('../../server/lib/evalPipeline'),
};
const { resolvePopulation, normalisePopulation } = require('../../server/lib/sceneMetadata');

/** A normalised person box of the given side length, centred on (cx, cy). */
const box = (area: number, cx = 0.5, cy = 0.5) => {
  const s = Math.sqrt(area);
  return { box: [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2] };
};

// The vantage canvas that serves job_1789759147125_p08djwhbl p1-p6 (and the
// near-identical one behind job_1789506283204_3kxqshifx p1/p2/p3/p8/p11/p13):
// a Lindenhof plaza with chess players, two people on a bench, a walker and a
// pair by the wall — eight figures, none of them cast, because the cast has
// not been composited yet.
const LINDENHOF_PLATE = [
  box(0.030, 0.63, 0.62), box(0.022, 0.04, 0.52), box(0.018, 0.16, 0.55),
  box(0.016, 0.58, 0.51), box(0.014, 0.87, 0.51), box(0.013, 0.90, 0.52),
  box(0.012, 0.19, 0.52), box(0.011, 0.05, 0.53),
];

// job_1789420511893_zly5rcdej p3/p4 — the quay plate. Nothing but specks at the
// far waterline, all under the micro floor.
const QUAY_PLATE = [box(0.004, 0.02, 0.51), box(0.003, 0.05, 0.51), box(0.002, 0.21, 0.51)];

// job_1789759147125_p08djwhbl p7 and p8 — a terrace and a fountain square,
// genuinely empty of people. The plate agrees with the brief here.
const EMPTY_PLATE: any[] = [];

describe('plate population — what the plate itself shows', () => {
  it('reads the populated Lindenhof plate as ambient, not cast_only', () => {
    expect(platePopulationFromFigures(LINDENHOF_PLATE)).toBe('ambient');
  });

  it('makes NO claim about a plate with nobody in it — silence, not emptiness', () => {
    // A plate can simply fail to render the passers-by a page is written
    // around. Reading "no boxes" as "cast_only" would let it DEMOTE a brief.
    expect(platePopulationFromFigures(EMPTY_PLATE)).toBeNull();
  });

  it('makes no claim when the detector did not answer at all', () => {
    expect(platePopulationFromFigures(null)).toBeNull();
    expect(platePopulationFromFigures(undefined)).toBeNull();
  });

  it('ignores sub-floor specks — the quay plate is not a populated setting', () => {
    for (const f of QUAY_PLATE) {
      const [x1, y1, x2, y2] = f.box;
      expect(Math.abs(x2 - x1) * Math.abs(y2 - y1)).toBeLessThan(MICRO_AREA_FLOOR);
    }
    expect(platePopulationFromFigures(QUAY_PLATE)).toBeNull();
  });

  it('does not lose the crowd case — a dense plate reaches crowd', () => {
    const dense = Array.from({ length: PLATE_CROWD_MIN }, (_, i) => box(0.02, 0.05 + i * 0.06, 0.5));
    expect(platePopulationFromFigures(dense)).toBe('crowd');
    // One short of the bar is still a populated place, not a crowd.
    expect(platePopulationFromFigures(dense.slice(0, PLATE_CROWD_MIN - 1))).toBe('ambient');
  });

  it('a box in pixel space is never counted — failing closed, as every area rule here does', () => {
    expect(platePopulationFromFigures([{ box: [100, 200, 300, 500] }])).toBeNull();
  });
});

describe('resolvePopulation — the plate wins where they disagree, and may only raise', () => {
  it('raises the Lindenhof pages from the brief cast_only to the plate ambient', () => {
    const r = resolvePopulation('cast_only', 'ambient');
    expect(r).toEqual({ population: 'ambient', source: 'plate', disagreed: true });
  });

  it('never demotes a declared crowd, whatever the plate shows', () => {
    expect(resolvePopulation('crowd', 'ambient').population).toBe('crowd');
    expect(resolvePopulation('crowd', null).population).toBe('crowd');
  });

  it('leaves the declaration alone when the plate makes no claim', () => {
    const r = resolvePopulation('cast_only', null);
    expect(r).toEqual({ population: 'cast_only', source: 'declared', disagreed: false });
  });

  it('agreement is not a disagreement', () => {
    expect(resolvePopulation('ambient', 'ambient'))
      .toEqual({ population: 'ambient', source: 'declared', disagreed: false });
  });

  it('a missing declaration still normalises before the comparison', () => {
    expect(resolvePopulation(null, null).population).toBe(normalisePopulation(null, false));
    expect(resolvePopulation(null, 'crowd')).toEqual({ population: 'crowd', source: 'plate', disagreed: true });
  });

  it('ignores a plate value that is not a population state', () => {
    expect(resolvePopulation('cast_only', 'busy' as any).population).toBe('cast_only');
  });
});

describe('the real defect must still fire', () => {
  // job_1789420511893_zly5rcdej p16 — Emma, Noah and Daniel on the ship plus an
  // uncommissioned fourth child at 5.45% of frame. That page has NO stored
  // plate at all, so the plate says nothing and the brief's cast_only stands.
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

  it('p16 has no plate, so the declaration stands and extra_character still fires', () => {
    const population = resolvePopulation('cast_only', null).population;
    expect(population).toBe('cast_only');
    const out = derivePresenceFinding({
      ...reply,
      cast: {
        declared: true, names: ['Emma', 'Noah', 'Daniel'], count: 3,
        population, crowdExpected: false, nonHumanNames: [],
      },
      detectedFigureCount: 4,
      detectorFigures: QUAY_P16,
      referenceNames: ['Emma', 'Noah', 'Daniel'],
    });
    expect(out.outcome).toBe('extra_character');
    expect(out.finding?.type).toBe('extra_character');
  });

  it('and it still fires even if that page HAD shown an ambient plate — the extra is cast-scale', () => {
    const population = resolvePopulation('cast_only', 'ambient').population;
    expect(population).toBe('ambient');
    const out = derivePresenceFinding({
      ...reply,
      cast: {
        declared: true, names: ['Emma', 'Noah', 'Daniel'], count: 3,
        population, crowdExpected: false, nonHumanNames: [],
      },
      detectedFigureCount: 4,
      detectorFigures: QUAY_P16,
      referenceNames: ['Emma', 'Noah', 'Daniel'],
    });
    expect(out.outcome).toBe('extra_character');
  });
});
