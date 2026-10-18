/**
 * A PLACE WITH NO DAYLIT SKY OUTSIDE (owner, 2026-10-18). The Visual Bible marks a location or vehicle
 * `noDaylight: true` once; code pins it on each page there, and an interior page then names no daylit window and
 * no season through a window. Earth interiors are unchanged. Structured field only, never prose.
 * Evidence: prod space-station story job_1792312615714_wpz3fzwyy — pump-room windows showed autumn Earth at sunset
 * (indoor evening line "the daylight at the windows fading to gold", indoor season line "what a window shows ...
 * is autumn's"). Archetypal fixtures. see docs/decisions.md 2026-10-18 "A place with no daylit sky".
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const SL = req('../../server/lib/sceneLight');
const JBF = req('../../server/lib/jevBriefFields');
const JD = req('../../server/lib/jevDecisions');
const { buildSeasonNote } = req('../../server/lib/season');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata');

const HOURS = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'dusk', 'night'];

describe('the indoor light of a place with no daylit sky', () => {
  it('names no daylit window at any hour; the same interior on Earth keeps its window phrase', () => {
    for (const timeOfDay of HOURS) {
      const world = SL.buildLightLine({ timeOfDay, weather: 'none', noDaylight: true });
      const earth = SL.buildLightLine({ timeOfDay, weather: 'none' });
      expect(world).toContain(SL.NO_DAYLIGHT_PHRASE);
      expect(world).not.toMatch(/daylight at the windows|light at the windows|fresh daylight/);
      expect(earth).not.toContain(SL.NO_DAYLIGHT_PHRASE);
      expect(earth).toMatch(/window/);
    }
  });
  it('does not touch an outdoor page or a skyless light', () => {
    for (const l of [{ timeOfDay: 'evening', weather: 'clear' }, { timeOfDay: 'underwater', weather: 'none' }]) {
      expect(SL.buildLightLine({ ...l, noDaylight: true })).toBe(SL.buildLightLine(l));
    }
  });
  it('is read from the brief metadata field, not from prose', () => {
    const brief = (extra: string) => `A room.\n\n---METADATA---\n${JSON.stringify({ characters: [], objects: [], timeOfDay: 'evening', weather: 'none', ...JSON.parse(extra) })}`;
    expect(SL.declaredLightOfBrief(brief('{"noDaylight": true}')).noDaylight).toBe(true);
    expect(SL.declaredLightOfBrief(brief('{}')).noDaylight).toBeUndefined();
    expect(extractSceneMetadata(brief('{"noDaylight": true}')).noDaylight).toBe(true);
  });
});

describe('the season line of an interior with no daylit sky', () => {
  it('is empty there; an Earth interior and an Earth outdoor page keep theirs', () => {
    const input = { season: 'autumn' };
    expect(buildSeasonNote(input, { indoor: true, noDaylight: true })).toBe('');
    expect(buildSeasonNote(input, { indoor: true })).toMatch(/window or door/);
    expect(buildSeasonNote(input, {})).toMatch(/Foliage/);
  });
});

describe('which pages carry the fact', () => {
  const vb = { locations: [{ id: 'LOC001', noDaylight: true }, { id: 'LOC002' }], vehicles: [{ id: 'VEH001', noDaylight: 'true' }, { id: 'VEH002' }] };
  it('pages at the place (a vantage id counts by its base) or aboard the vehicle', () => {
    const locOf = new Map([[1, 'LOC002'], [2, 'LOC001.2'], [3, 'LOC002']]);
    const aboardOf = new Map<number, string | null>([[1, null], [2, null], [3, 'VEH001']]);
    expect(JBF.noDaylightPages(vb, locOf, aboardOf)).toEqual([{ pageNumber: 2, place: 'LOC001' }, { pageNumber: 3, place: 'VEH001' }]);
    expect(JBF.noDaylightPages({ locations: [{ id: 'LOC001' }] }, locOf, aboardOf)).toEqual([]);
  });
  it('the FIXED block states it and the brief pin writes it (true pins, false clears a stale one)', () => {
    expect(JD.fixedBlock({ jevFixed: { timeOfDay: 'evening', indoor: true, noDaylight: true, cites: [], aboard: null } })).toMatch(/noDaylight: true/);
    expect(JD.fixedBlock({ jevFixed: { timeOfDay: 'evening', indoor: true, noDaylight: false, cites: [], aboard: null } })).not.toMatch(/noDaylight/);
    const brief = 'Prose.\n\n---METADATA---\n' + JSON.stringify({ characters: [], objects: [], weather: 'none' });
    const pinned = JD.pinBrief(brief, { timeOfDay: 'evening', indoor: true, noDaylight: true });
    expect(extractSceneMetadata(pinned.brief).noDaylight).toBe(true);
    const cleared = JD.pinBrief(pinned.brief, { timeOfDay: 'evening', indoor: true, noDaylight: false });
    expect(extractSceneMetadata(cleared.brief).noDaylight).toBeUndefined();
  });
});

describe('decideBriefFields pins the fact on each page at the place', () => {
  it('the interior page at a noDaylight place carries it, an Earth page and an underwater page do not', async () => {
    const J = req('../../server/lib/jevAudit');
    const saved = J.callJev;
    J.callJev = makeJevStub({ noul: () => 0.1 }).impl;
    try {
      const vb = {
        mainCharacters: [], secondaryCharacters: [], animals: [], artifacts: [], clothing: [], vehicles: [],
        locations: [
          { id: 'LOC001', name: 'Meadow', pages: [1], scaleClass: 'landmark', description: 'a meadow' },
          { id: 'LOC002', name: 'Pump room', pages: [2], scaleClass: 'house-height', description: 'a pump room', noDaylight: true },
        ],
      };
      const light: any = { pages: [
        { pageNumber: 1, jevTime: 'afternoon', newDayP: 0.02, indoorP: 0.01, indoor: false },
        { pageNumber: 2, jevTime: 'evening', newDayP: 0.02, indoorP: 0.7, indoor: true },
      ], clockHeld: [] };
      JD.applyClock(light.pages);
      const beats: any[] = [
        { pageNumber: 1, planLine: 'wide — Ana — Ana walks the meadow — she arrives', fixed: { timeOfDay: 'afternoon', indoor: false } },
        { pageNumber: 2, planLine: 'close-up — Ana — Ana enters the pump room — it hums', fixed: { timeOfDay: 'evening', indoor: true } },
      ];
      const gl = { info: () => {}, warn: () => {}, error: () => {} };
      await JBF.decideBriefFields({ beats, visualBible: vb, bibleSections: null, approvedArc: '1. A thing.', inputData: { characters: [{ name: 'Ana' }] }, present: new Map([[1, ['Ana']], [2, ['Ana']]]), gl, light });
      expect(beats[0].jevFixed.noDaylight).toBe(false);
      expect(beats[1].jevFixed.noDaylight).toBe(true);
    } finally { J.callJev = saved; }
  });
});
