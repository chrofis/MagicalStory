/**
 * THE LIGHT OF A SUBMERGED PLACE (owner, 2026-10-07). A location or vehicle in the Visual Bible carries
 * `submerged: true`, written once; code restricts Jev's light options to the lights beneath the surface on every
 * page at or aboard that place, and the clock is re-held. Pins behaviour, never prompt wording. Archetypal fixtures.
 * Evidence: staging job_1791315635053_t0t8qpebu p9-p11 (inside a sunken wreck) chose `evening`, and the indoor
 * evening line drew a lantern, a night sky and a dry room. see docs/decisions.md 2026-10-07
 *   "A submerged place has skyless light".
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const SL = req('../../server/lib/sceneLight');
const JD = req('../../server/lib/jevDecisions');
const JBF = req('../../server/lib/jevBriefFields');

const WATER = ['underwater', 'underwater_deep', 'underwater_night', 'underwater_dark'];

const lightRows = () => ([
  { pageNumber: 1, jevTime: 'afternoon', newDayP: 0.02, indoorP: 0.01, indoor: false },
  { pageNumber: 2, jevTime: 'evening', newDayP: 0.02, indoorP: 0.7, indoor: true },
  { pageNumber: 3, jevTime: 'evening', newDayP: 0.02, indoorP: 0.7, indoor: true },
  { pageNumber: 4, jevTime: 'evening', newDayP: 0.02, indoorP: 0.01, indoor: false },
]);

describe('the lights beneath the surface are one list from the light table', () => {
  it('SUBMERGED_LIGHTS and Jev\'s restricted options are the four water lights, never dark or an hour', () => {
    expect(SL.SUBMERGED_LIGHTS).toEqual(WATER);
    expect(Object.keys(SL.JEV_SUBMERGED_CRITERIA)).toEqual(WATER);
    for (const t of WATER) expect(SL.isSkylessLight(t)).toBe(true);
  });
});

describe('submergedPages', () => {
  const vb = {
    locations: [{ id: 'LOC001', submerged: true }, { id: 'LOC002' }, { id: 'LOC003', submerged: 'true' }],
    vehicles: [{ id: 'VEH001', submerged: true }, { id: 'VEH002' }],
  };
  it('names the pages at a submerged location (a vantage id counts by its base) or aboard a submerged vehicle', () => {
    const locOf = new Map([[1, 'LOC002'], [2, 'LOC001'], [3, 'LOC003.2'], [4, 'LOC002']]);
    const aboardOf = new Map<number, string | null>([[1, null], [2, null], [3, null], [4, 'VEH001']]);
    expect(JBF.submergedPages(vb, locOf, aboardOf)).toEqual([
      { pageNumber: 2, place: 'LOC001' }, { pageNumber: 3, place: 'LOC003' }, { pageNumber: 4, place: 'VEH001' },
    ]);
  });
  it('a bible without the fact restricts nothing', () => {
    expect(JBF.submergedPages({ locations: [{ id: 'LOC001' }], vehicles: [] }, new Map([[1, 'LOC001']]), new Map())).toEqual([]);
  });
});

describe('decideSubmergedLight', () => {
  it('asks only the named pages, offers only the water lights, and re-holds the clock', async () => {
    const stub = makeJevStub();
    const light: any = { pages: lightRows(), clockHeld: [] };
    JD.applyClock(light.pages);
    expect(light.pages.map((r: any) => r.timeOfDay)).toEqual(['afternoon', 'evening', 'evening', 'evening']);
    const pages = light.pages.map((r: any) => ({ pageNumber: r.pageNumber, planLine: `SHOT — Ana — step ${r.pageNumber} — y` }));
    const out = await JD.decideSubmergedLight({ arc: 'A', pages, light, pageNumbers: [2, 3] }, { callImpl: stub.impl });
    expect(stub.calls).toHaveLength(2);
    for (const c of stub.calls) expect(Object.keys(c.questions.TIME.criteria)).toEqual(WATER);
    expect(out.asked).toEqual([2, 3]);
    // the stub picks the first option: the answer is an underwater light, and the first answer is kept for the record
    expect(light.pages.map((r: any) => r.timeOfDay)).toEqual(['afternoon', 'underwater', 'underwater', 'evening']);
    expect(light.pages[1]).toMatchObject({ submerged: true, jevTimeFirst: 'evening', jevTime: 'underwater' });
    expect(light.pages[0].submerged).toBeUndefined();
    expect(out.changed.map((c: any) => c.pageNumber)).toEqual([2, 3]);
  });
  it('no submerged page, no call', async () => {
    const stub = makeJevStub();
    const light: any = { pages: lightRows(), clockHeld: [] };
    const out = await JD.decideSubmergedLight({ arc: 'A', pages: [], light, pageNumbers: [] }, { callImpl: stub.impl });
    expect(stub.calls).toHaveLength(0);
    expect(out.asked).toEqual([]);
  });
  it('an answer outside the water lights is a loud failure, never an hour', async () => {
    const impl = async () => ({ answers: { TIME: { choice: 'evening', probabilities: { evening: 1 } } }, cost: 0, model: 'stub', usage: {} });
    const light: any = { pages: lightRows(), clockHeld: [] };
    const pages = light.pages.map((r: any) => ({ pageNumber: r.pageNumber, planLine: 'SHOT — Ana — x — y' }));
    await expect(JD.decideSubmergedLight({ arc: 'A', pages, light, pageNumbers: [2] }, { callImpl: impl })).rejects.toThrow(/outside/);
  });
});

describe('decideBriefFields re-decides the light of a submerged page before anything reads it', () => {
  it('the page at a submerged location takes a water light, b.fixed follows, the INDOOR answer stays honest', async () => {
    const J = req('../../server/lib/jevAudit');
    const saved = J.callJev;
    const stub = makeJevStub({ noul: () => 0.1 });
    J.callJev = stub.impl;
    try {
      const vb = {
        mainCharacters: [], secondaryCharacters: [], animals: [], artifacts: [], clothing: [], vehicles: [],
        locations: [
          { id: 'LOC001', name: 'Shore', pages: [1], scaleClass: 'landmark', description: 'a shore' },
          { id: 'LOC002', name: 'Wreck', pages: [2], scaleClass: 'house-height', description: 'a sunken ship hull', submerged: true },
        ],
      };
      const light: any = { pages: [
        { pageNumber: 1, jevTime: 'afternoon', newDayP: 0.02, indoorP: 0.01, indoor: false },
        { pageNumber: 2, jevTime: 'evening', newDayP: 0.02, indoorP: 0.7, indoor: true },
      ], clockHeld: [] };
      JD.applyClock(light.pages);
      const beats: any[] = [
        { pageNumber: 1, planLine: 'wide — Ana — Ana walks the shore — she arrives', fixed: { timeOfDay: 'afternoon', indoor: false } },
        { pageNumber: 2, planLine: 'close-up — Ana — Ana enters the wreck — it is dark', fixed: { timeOfDay: 'evening', indoor: true } },
      ];
      const gl = { info: () => {}, warn: () => {}, error: () => {} };
      await JBF.decideBriefFields({ beats, visualBible: vb, bibleSections: null, approvedArc: '1. A thing.', inputData: { characters: [{ name: 'Ana' }] }, present: new Map([[1, ['Ana']], [2, ['Ana']]]), gl, light });
      expect(beats[0].jevFixed.timeOfDay).toBe('afternoon');
      expect(WATER).toContain(beats[1].fixed.timeOfDay);
      expect(beats[1].jevFixed.timeOfDay).toBe(beats[1].fixed.timeOfDay);
      expect(light.pages[1]).toMatchObject({ submerged: true, jevTimeFirst: 'evening' });
      expect(beats[1].jevFixed.indoor).toBe(true); // Jev's own INDOOR answer for that page (0.7), untouched
      expect(SL.isSkyHidden(beats[1].jevFixed)).toBe(true);
    } finally { J.callJev = saved; }
  });
});

describe('a skyless page is never "indoor" by its light alone', () => {
  it('isSkyHidden: a skyless light or an interior; the hour of an outdoor page is neither', () => {
    expect(SL.isSkyHidden({ timeOfDay: 'underwater', indoor: false })).toBe(true);
    expect(SL.isSkyHidden({ timeOfDay: 'evening', indoor: true })).toBe(true);
    expect(SL.isSkyHidden({ timeOfDay: 'evening', indoor: false })).toBe(false);
    expect(SL.isSkyHidden(null)).toBe(false);
  });
  it('a cover is lit by the outdoor pages: a skyless page is not in the pool, and its weather is none', () => {
    const beats: any[] = [
      { pageNumber: 1, fixed: { timeOfDay: 'afternoon', indoor: false, weatherAdvice: 'clear' }, jevFixed: { location: 'LOC001' } },
      { pageNumber: 2, fixed: { timeOfDay: 'underwater', indoor: false, weatherAdvice: 'clear' }, jevFixed: { location: 'LOC002' } },
      { pageNumber: 3, fixed: { timeOfDay: 'underwater', indoor: false, weatherAdvice: 'clear' }, jevFixed: { location: 'LOC002' } },
    ];
    expect(JBF.coverLight('frontCover', beats)).toMatchObject({ timeOfDay: 'afternoon', weather: 'clear' });
    expect(JBF.coverLight('backCover', beats)).toMatchObject({ timeOfDay: 'underwater', weather: 'none' });
  });
});
