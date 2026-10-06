/**
 * WIDER JEV OPTIONS, round 2 (owner, 2026-10-06: Jev's lists should have too many options rather than
 * too few, each wired end to end): weather, aboard creatures, population levels, the new-day clock.
 * (Cover places are in cover-places.test.ts.) Pins behaviour, never prompt wording; archetypal fixtures only.
 * see docs/decisions.md 2026-10-06 "Wider Jev options: weather, aboard, population, clock"
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const SL = req('../../server/lib/sceneLight');
const JD = req('../../server/lib/jevDecisions');
const SM = req('../../server/lib/sceneMetadata');
const PB = req('../../server/lib/promptBuilders');
const EP = req('../../server/lib/evalPipeline');
const SC = req('../../server/lib/styleConsistency');
const SBC = req('../../server/lib/sceneBriefCheck');
const VBM = req('../../server/lib/visualBible');
const PRC = req('../../server/lib/pageRenderCall');
const SR = req('../../server/lib/scaleRepair');
const SV = req('../../server/lib/shotVocabulary');

const SKY = /\b(sun|moon|blue sky)\b/i;
const NEW_WEATHERS = ['windy', 'drizzle', 'snow-lying', 'rainbow', 'hail', 'heat', 'thunder'];

describe('weather: one table, seven new values', () => {
  it('the enum, Jev\'s criteria and the phrases come from WEATHER_TABLE', () => {
    expect(SL.WEATHERS).toEqual(SL.WEATHER_TABLE.map((w: any) => w.id));
    for (const w of NEW_WEATHERS) expect(SL.WEATHERS).toContain(w);
    expect(Object.keys(JD.lightQuestions().WEATHER.criteria)).toEqual(SL.WEATHERS);
    expect(SL.WEATHER_ENUM).toContain('snow-lying');
    for (const w of SL.WEATHERS) for (const t of [...SL.CLOCK_HOURS, null]) expect(SL.lightPhrase({ timeOfDay: t, weather: w }), `${t}/${w}`).not.toBe(null);
    for (const w of NEW_WEATHERS) expect(SL.normaliseWeather(w.toUpperCase())).toBe(w);
  });
  it('drizzle, hail and thunder own the sky (no sun, moon or blue sky at any hour); wind, heat, rainbow and lying snow leave it to the hour', () => {
    for (const w of ['drizzle', 'hail', 'thunder']) {
      expect(SL.weatherOwnsSky(w)).toBe(true);
      for (const t of SL.CLOCK_HOURS) {
        const p = SL.lightPhrase({ timeOfDay: t, weather: w });
        expect(p, `${t}/${w}`).toContain(SL.COVERED_SKY_CLAUSE);
        expect(p.split(SL.COVERED_SKY_CLAUSE).join(''), `${t}/${w}`).not.toMatch(SKY);
      }
    }
    for (const w of ['windy', 'heat', 'rainbow', 'snow-lying']) {
      expect(SL.weatherOwnsSky(w)).toBe(false);
      expect(SL.lightPhrase({ timeOfDay: 'afternoon', weather: w })).toContain('warm daylight from a sun');
    }
  });
  it('windy is dry: things blow, nothing falls', () => {
    const p = SL.lightPhrase({ timeOfDay: 'midday', weather: 'windy' });
    expect(p).toMatch(/blowing/);
    expect(p).not.toMatch(/rain|snow/);
  });
  it('every line built from a new weather carries it: page, plate, repair, relight, derive, judge', () => {
    for (const w of NEW_WEATHERS) {
      const light = { timeOfDay: 'afternoon', weather: w };
      const phrase = SL.lightPhrase(light);
      for (const line of [SL.buildLightLine(light), SL.buildLightLine(light, { plate: true }), SL.buildRepairLightLine(light), SL.buildPlateRelightInstruction(light), SL.relightClause(light), SL.keepLightClause(light)]) expect(line, w).toContain(phrase);
      expect(SL.describeLightForJudge(light), w).toContain(w);
    }
  });
  it('an indoor page keeps weather none and no new weather leaks in', () => {
    expect(SL.lightPhrase({ timeOfDay: 'afternoon', weather: 'none' })).not.toMatch(/sun|moon|sky|blowing|rain/i);
  });
});

describe('weather: neighbouring weathers do not contradict (visual-flow judge)', () => {
  it('a drizzle beside a rain, lying snow beside falling snow, wind beside a clear sky: no contradiction', () => {
    expect(SL.weatherContradicts('drizzle', 'rain')).toBe(false);
    expect(SL.weatherContradicts('rain', 'drizzle')).toBe(false);
    expect(SL.weatherContradicts('snow-lying', 'snow')).toBe(false);
    expect(SL.weatherContradicts('windy', 'clear')).toBe(false);
    expect(SL.weatherContradicts('thunder', 'storm')).toBe(false);
    expect(SL.weatherContradicts('hail', 'rain')).toBe(false);
  });
  it('real contradictions still count; interiors and equal values never do', () => {
    expect(SL.weatherContradicts('rain', 'clear')).toBe(true);
    expect(SL.weatherContradicts('snow-lying', 'heat')).toBe(true);
    expect(SL.weatherContradicts('heat', 'snow')).toBe(true);
    expect(SL.weatherContradicts('fog', 'storm')).toBe(true);
    expect(SL.weatherContradicts('none', 'rain')).toBe(false);
    expect(SL.weatherContradicts('rain', 'indoor')).toBe(false);
    expect(SL.weatherContradicts('rain', 'rain')).toBe(false);
    expect(SL.weatherContradicts('rain', null)).toBe(false);
  });
  it('the neighbour relation is symmetric in effect (either row naming the other is enough) and every near id is a weather', () => {
    for (const w of SL.WEATHER_TABLE) for (const n of w.near) {
      expect(SL.WEATHERS, `${w.id} near ${n}`).toContain(n);
      expect(SL.weatherContradicts(n, w.id), `${n} vs ${w.id}`).toBe(false);
      expect(SL.weatherContradicts(w.id, n), `${w.id} vs ${n}`).toBe(false);
    }
  });
  it('the visual-flow judge buckets include the new weathers', () => {
    const src = require('node:fs').readFileSync(require.resolve('../../server/lib/styleConsistency'), 'utf8');
    expect(src).toContain('weatherContradicts(declared?.weather, renderedWeather)');
    expect(SC).toBeTruthy();
  });
});

describe('weather: plate QC', () => {
  it('lying snow gets its own ground check, fog its distance check, drizzle the covered-sky check', () => {
    expect(SL.weatherQcCheck('snow-lying')).toBe('LIGHT_SNOW_LYING');
    expect(SL.weatherQcCheck('fog')).toBe('LIGHT_FOG');
    expect(SL.weatherQcCheck('rain')).toBe(null);
    const text = require('node:fs').readFileSync(require.resolve('../../prompts/empty-scene-qc.txt'), 'utf8');
    for (const w of SL.WEATHER_TABLE) if (w.qc) expect(text, w.qc).toContain(`### ${w.qc}`);
  });
});

describe('clock: a new day lets an earlier hour follow (afternoon, then next morning)', () => {
  it('without a new-day flag the clock never runs backwards; with it afternoon to morning is allowed', () => {
    expect(JD.forwardClock(['afternoon', 'morning']).times).toEqual(['afternoon', 'afternoon']);
    expect(JD.forwardClock(['afternoon', 'morning'], [false, true]).times).toEqual(['afternoon', 'morning']);
    expect(JD.forwardClock(['afternoon', 'morning'], [false, true]).held).toEqual([]);
  });
  it('the flag moves nothing else: a later hour, a skyless page, an unflagged backwards step', () => {
    expect(JD.forwardClock(['morning', 'dusk', 'underwater', 'dawn'], [false, false, false, true]).times).toEqual(['morning', 'dusk', 'underwater', 'dawn']);
    expect(JD.forwardClock(['dusk', 'afternoon'], [false, false]).times).toEqual(['dusk', 'dusk']);
  });
  it('decideLight asks NEWDAY and honours it', async () => {
    const pages = [1, 2].map(n => ({ pageNumber: n, planLine: `wide — Ana — x${n} — y` }));
    const stub = makeJevStub({ noul: (q) => (/LATER DAY/.test(q) ? 0.9 : 0.1) });
    // the stub's choice always picks the first option: patch it so page 2 reads earlier than page 1
    let call = 0;
    const impl = async (rq: any) => {
      const r = await stub.impl(rq);
      call++;
      const t = r.answers.TIME;
      if (t) { const hours = ['morning', 'afternoon']; const pick = hours[call === 1 ? 1 : 0]; r.answers.TIME = { choice: pick, probabilities: Object.fromEntries(Object.keys(rq.questions.TIME.criteria).map(k => [k, k === pick ? 0.9 : 0.01])) }; }
      return r;
    };
    const d = await JD.decideLight({ arc: 'A', pages }, { callImpl: impl });
    expect(d.pages.map((p: any) => p.timeOfDay)).toEqual(['afternoon', 'morning']);
    expect(d.pages[1].newDayP).toBeGreaterThanOrEqual(0.5);
  });
});

describe('aboard: a ridden or entered creature', () => {
  const VB = {
    animals: [{ id: 'ANI001', name: 'Shelly', species: 'turtle', description: 'a giant sea turtle' }],
    vehicles: [{ id: 'VEH001', name: 'boat', description: 'a boat' }],
  };
  const pages = [1, 2].map(n => ({ pageNumber: n, planLine: `wide — Ana — x${n} — y` }));
  it('Jev is asked per creature whether the camera is carried by it, and the page\'s aboard is the highest of vessels and creatures', async () => {
    const stub = makeJevStub({ noul: (q) => (/ride on Shelly/.test(q) ? 0.8 : /camera .* stands on or inside/.test(q) ? 0.6 : 0.1) });
    const d = await JD.decideVbAndAboard({ arc: 'A', pages, visualBible: VB }, { callImpl: stub.impl });
    expect(d.pages[0].aboard).toBe('ANI001');
    expect(d.pages[0].aboardScores).toMatchObject({ ANI001: 0.8, VEH001: 0.6 });
  });
  it('a vessel still wins when it is the higher, and a creature below the threshold is not aboard', async () => {
    const hi = makeJevStub({ noul: (q) => (/ride on Shelly/.test(q) ? 0.4 : /camera .* stands on or inside/.test(q) ? 0.7 : 0.1) });
    expect((await JD.decideVbAndAboard({ arc: 'A', pages, visualBible: VB }, { callImpl: hi.impl })).pages[0].aboard).toBe('VEH001');
    const none = makeJevStub({ noul: () => 0.1 });
    expect((await JD.decideVbAndAboard({ arc: 'A', pages, visualBible: VB }, { callImpl: none.impl })).pages[0].aboard).toBe(null);
  });
  it('pinBrief writes a creature aboard and clears a stale one when Jev says none', () => {
    const brief = (m: any) => `Prose.\n\n---METADATA---\n${JSON.stringify(m)}`;
    const on = JD.pinBrief(brief({ characters: [] }), { aboard: 'ANI001', aboardIds: ['VEH001', 'ANI001'] });
    expect(on.brief).toContain('"aboard": "ANI001"');
    const off = JD.pinBrief(brief({ characters: [], aboard: 'ANI001' }), { aboard: null, aboardIds: ['VEH001', 'ANI001'] });
    expect(off.brief).not.toContain('"aboard"');
  });
  it('the page grid keeps a ridden creature\'s cell and still withholds a vessel the camera stands on', () => {
    const refs = [{ id: 'ANI001', type: 'animal' }, { id: 'VEH001', type: 'vehicle' }, { id: 'ART001', type: 'artifact' }];
    const ids = (aboard: string | null) => PRC.keepPageGridElements(refs, { hasPlate: false, sceneMetadata: { aboard } }).map((e: any) => e.id);
    expect(ids('ANI001')).toEqual(['ANI001', 'VEH001', 'ART001']);
    expect(ids('VEH001')).toEqual(['ANI001', 'ART001']);
    expect(VBM.aboardWithheldId('ANI001')).toBe(null);
    expect(VBM.aboardWithheldId('VEH001')).toBe('VEH001');
    expect(VBM.isCreatureAboard('ani002')).toBe(true);
  });
  it('the plate builders accept a creature aboard id: the creature never reaches a plate', () => {
    const { buildPlateStructuresText } = req('../../server/services/prompts');
    const vb = { ...VB, vehicles: [{ id: 'VEH001', name: 'boat', description: 'a wooden boat', appearsInPages: [1] }], artifacts: [] };
    const text = buildPlateStructuresText({ visualBible: vb, pageNumber: 1, aboardId: 'ANI001', sceneObjects: ['VEH001'] });
    expect(text).not.toMatch(/Shelly|turtle/);
    expect(VBM.getEmptySceneElementReferences({ ...vb, animals: [{ ...VB.animals[0], appearsInPages: [1] }] }, 1, 9, 'ANI001', ['ANI001']).map((r: any) => r.id)).not.toContain('ANI001');
  });
  it('scale repair never relocates figures riding a creature', () => {
    const meta = (aboard: any) => ({ aboard, characters: [{ name: 'A', depth: 'foreground' }, { name: 'B', depth: 'background' }], setting: 'outdoor' });
    expect(SR.needsScaleRepair(meta('ANI001'))).toBe(false);
    expect(SR.needsScaleRepair(meta(null))).toBe(true);
  });
  it('both Art Director templates carry the creature aboard rule', () => {
    const fs = require('node:fs');
    for (const f of ['scene-expansion', 'scene-briefs-all']) {
      const t = fs.readFileSync(require.resolve(`../../prompts/${f}.txt`), 'utf8');
      expect(t, f).toMatch(/creature the cast rides/);
    }
  });
});

describe('population: wildlife, sparse, creature_crowd', () => {
  const NEW = ['sparse', 'wildlife', 'creature_crowd'];
  it('one table: the levels, the judges\' lines and the illustrator\'s tails list the same values', () => {
    expect(SM.POPULATION_LEVELS).toEqual(SM.POPULATION_TABLE.map((p: any) => p.id));
    for (const n of NEW) expect(SM.POPULATION_LEVELS).toContain(n);
    for (const l of SM.POPULATION_LEVELS) {
      expect(PB.buildRequiredCastRule(l), l).toContain('REQUIRED CAST');
      expect(SM.normalisePopulation(l)).toBe(l);
    }
    expect(SM.normalisePopulation('Creature-Crowd')).toBe('creature_crowd');
    expect(PB.buildRequiredCastRule('wildlife')).not.toBe(PB.buildRequiredCastRule('cast_only'));
    expect(PB.buildRequiredCastRule('wildlife')).toMatch(/animals/);
    expect(PB.buildRequiredCastRule('wildlife')).toMatch(/No unnamed people/);
    expect(PB.buildRequiredCastRule('sparse')).toMatch(/one or two/);
  });
  it('the judge is told the level: SETTING POPULATION line per value', () => {
    const block = (population: string) => EP.buildExpectedCastBlock({ sceneCharacters: [{ name: 'Ana' }], sceneMetadata: { population, fullData: { population } }, visualBible: {} } as any);
    for (const l of SM.POPULATION_LEVELS) {
      const b = block(l);
      const text = typeof b === 'string' ? b : b.block;
      expect(text, l).toContain(`SETTING POPULATION: ${SM.POPULATION_TABLE.find((p: any) => p.id === l).line}`);
    }
  });
  it('wildlife is drawn in the page, never on the plate: the plate rule says so', () => {
    expect(SV.PLATE_NO_PEOPLE_RULE).toMatch(/wildlife/);
  });
  it('population_contradicted covers the wildlife levels (animals, never people) and spares sparse', () => {
    const meta = (population: string) => ({ population, fullData: { population } });
    const page = { pageNumber: 3, brief: 'Ana floats above the reef. Unnamed passers-by stand far in the background.' };
    expect(SBC.checkPopulationContradiction(page, meta('wildlife'), ['Ana'])).toMatchObject({ type: 'population_contradicted' });
    expect(SBC.checkPopulationContradiction(page, meta('creature_crowd'), ['Ana'])).toMatchObject({ type: 'population_contradicted' });
    expect(SBC.checkPopulationContradiction(page, meta('sparse'), ['Ana'])).toBe(null);
    expect(SBC.checkPopulationContradiction({ pageNumber: 3, brief: 'Ana floats above the reef. A shoal of fish drifts in the background.' }, meta('wildlife'), ['Ana'])).toBe(null);
  });
  it('Jev reads the new questions only for a place the two old ones left cast_only', async () => {
    const vb = { locations: [{ id: 'LOC001', name: 'the reef', description: 'a reef' }, { id: 'LOC002', name: 'the square', description: 'a square' }, { id: 'LOC003', name: 'the shoal', description: 'open water' }] };
    const pages = [1, 2, 3].map(n => ({ pageNumber: n, planLine: `wide — Ana — x${n} — y` }));
    const pick = (q: string, s: string) => {
      if (/A PLACE.*the square/.test(s)) return /public can walk into|crowd: a market/.test(q) ? (/public can walk/.test(q) ? 0.9 : 0.1) : 0.9; // wildlife also 0.9: must NOT move a public place
      if (/A PLACE.*the shoal/.test(s)) return /crowd of unnamed creatures/.test(q) ? 0.9 : 0.1;
      return /Unnamed animals belong/.test(q) ? 0.8 : 0.1;
    };
    const stub = makeJevStub({ noul: pick });
    const d = await JD.decidePopulation({ arc: 'A', pages, visualBible: vb, locOf: new Map([[1, 'LOC001'], [2, 'LOC002'], [3, 'LOC003']]) }, { callImpl: stub.impl });
    expect(d.byLocation.LOC001.population).toBe('wildlife');
    expect(d.byLocation.LOC002.population).toBe('ambient');
    expect(d.byLocation.LOC003.population).toBe('creature_crowd');
    const sparse = await JD.decidePopulation({ arc: 'A', pages, visualBible: vb, locOf: new Map([[1, 'LOC001']]) }, { callImpl: makeJevStub({ noul: (q) => (/far off in this place/.test(q) ? 0.7 : 0.1) }).impl });
    expect(sparse.byLocation.LOC001.population).toBe('sparse');
    const none = await JD.decidePopulation({ arc: 'A', pages, visualBible: vb, locOf: new Map([[1, 'LOC001']]) }, { callImpl: makeJevStub({ noul: () => 0.1 }).impl });
    expect(none.byLocation.LOC001.population).toBe('cast_only');
  });
  it('both Art Director templates list the new values', () => {
    const fs = require('node:fs');
    for (const f of ['scene-expansion', 'scene-briefs-all']) {
      const t = fs.readFileSync(require.resolve(`../../prompts/${f}.txt`), 'utf8');
      for (const n of NEW) expect(t, `${f} ${n}`).toContain(`"${n}"`);
    }
  });
});
