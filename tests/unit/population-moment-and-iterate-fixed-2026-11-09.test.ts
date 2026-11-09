/**
 * Two owner bugs, 2026-11-09 (tasks/bugs.json):
 *  - population-ignores-night-and-redraw-restores-onlookers: the place's `ambient` was copied to every page there,
 *    also a night page with an attack; a per-page moment question now lowers it (jevDecisions.decidePopulationMoment).
 *  - iterate-rewrite-not-told-fixed-fields: the iterate rewrite gets the page's whole FIXED block, not only its light.
 * Archetypal fixtures only. see docs/decisions.md 2026-11-09 "Population follows the page's moment".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const JD = req('../../server/lib/jevDecisions');
const SBC = req('../../server/lib/sceneBriefCheck');
const PB = req('../../server/lib/promptBuilders');
const { loadPromptTemplates } = req('../../server/services/prompts');

beforeAll(async () => { await loadPromptTemplates(); });

const pages = [
  { pageNumber: 1, planLine: 'SHOT — Ana — Ana crosses the square at noon — she reaches the bridge' },
  { pageNumber: 2, planLine: 'SHOT — Ana — Ana is cornered on the bridge by a pack of beasts — the bridge is blocked' },
  { pageNumber: 3, planLine: 'SHOT — Ana — Ana sleeps in her room — it is quiet' },
];
const byLocation = { LOC001: { population: 'ambient' }, LOC002: { population: 'cast_only' }, LOC003: { population: 'crowd' } };
const locOf = new Map([[1, 'LOC001'], [2, 'LOC001'], [3, 'LOC002']]);
const lightOf = new Map([[1, { timeOfDay: 'midday', indoor: false }], [2, { timeOfDay: 'night', indoor: false }], [3, { timeOfDay: 'night', indoor: true }]]);

describe('population per page moment', () => {
  it('lowers an ambient page whose moment clears the place, keeps one that does not, never asks a cast_only place', async () => {
    const stub = makeJevStub({ noul: (_q, s) => (/PAGE TO JUDGE: Page 2/.test(s) ? 0.1 : 0.9) });
    const d = await JD.decidePopulationMoment({ arc: 'A', pages, byLocation, locOf, lightOf }, { callImpl: stub.impl });
    expect(d.byPage.get(1)).toMatchObject({ population: 'ambient', placePopulation: 'ambient' });
    expect(d.byPage.get(2)).toMatchObject({ population: 'cast_only', placePopulation: 'ambient' });
    expect(d.byPage.get(3)).toMatchObject({ population: 'cast_only', momentP: null });
    expect(stub.calls).toHaveLength(2);                                  // pages 1 and 2 only
  });
  it('gives Jev the page\'s decided hour', async () => {
    const stub = makeJevStub();
    await JD.decidePopulationMoment({ arc: 'A', pages, byLocation, locOf, lightOf }, { callImpl: stub.impl });
    expect(stub.calls.find((c: any) => /Page 2/.test(c.state.split('PAGE TO JUDGE')[1] || '')).state).toMatch(/THE HOUR OF THIS PAGE \(decided\): night/);
  });
  it('a crowd place can be lowered too, and the answer never rises above the place', async () => {
    const stub = makeJevStub({ noul: () => 0.1 });
    const d = await JD.decidePopulationMoment({ arc: 'A', pages, byLocation, locOf: new Map([[1, 'LOC003'], [3, 'LOC002']]), lightOf }, { callImpl: stub.impl });
    expect(d.byPage.get(1).population).toBe('cast_only');
    const hi = await JD.decidePopulationMoment({ arc: 'A', pages, byLocation, locOf, lightOf }, { callImpl: makeJevStub({ noul: () => 1 }).impl });
    expect(hi.byPage.get(3).population).toBe('cast_only');
  });
  it('the pipeline writes the per-page answer into jevFixed (the place answer is only the ceiling)', () => {
    const src = fs.readFileSync(new URL('../../server/lib/jevBriefFields.js', import.meta.url), 'utf8');
    expect(src).toContain('popMoment.byPage.get(n).population');
    expect(src).not.toContain('pop.byLocation[loc.base].population }');
  });
});

describe('the iterate rewrite gets the whole FIXED block', () => {
  const jevFixed = { shot: 'wide', cites: ['ART001'], aboard: null, indoor: false, timeOfDay: 'night', location: 'LOC001', population: 'cast_only', looksAt: { Ana: 'ART001' }, emotions: { Ana: 'afraid' }, labels: { ART001: 'sword', LOC001: 'bridge' } };
  it('fixedBlock(rewrite) lists population and objects without telling the rewrite to omit the fields', () => {
    const b = JD.fixedBlock({ jevFixed }, { rewrite: true });
    expect(b).toContain('- population: cast_only');
    expect(b).toContain('- objects: LOC001 (bridge); ART001 (sword)');
    expect(b).toContain('- shot: wide');
    expect(b).not.toContain('write none of them');
    expect(JD.fixedBlock({ jevFixed })).toContain('write none of them');       // the Art Director's header is unchanged
  });
  it('is built in iteratePageCore from the same function, shot withheld for a free iterate', () => {
    const src = fs.readFileSync(new URL('../../server/lib/images.js', import.meta.url), 'utf8');
    expect(src).toContain("require('./jevDecisions').fixedBlock(");
    expect(src).toContain('freeIterate ? { ...savedScene.jevFixed, shot: undefined }');
  });
  it('the rewrite prompt carries the block, and the outdoor clause only for an outdoor sky', () => {
    const mk = (jf: any) => PB.buildSceneDescriptionPrompt(6, 'Text.', [], 'a bridge', 'en', null, [], null, '', [],
      { planLine: 'wide — Ana — she waits', fixedBlock: JD.fixedBlock({ jevFixed: jf }, { rewrite: true }), fixedOutdoors: JD.isOutdoorSky(jf) }, null, {});
    const out = mk(jevFixed);
    expect(out).toContain('- population: cast_only');
    expect(out).toContain('outdoors, `weather` is an outdoor value, never `none`');
    expect(mk({ ...jevFixed, indoor: true })).not.toContain('never `none`');
  });
  it('a pinned cast_only page whose rewrite keeps unnamed onlookers is reported; the pinned wording asks only for the prose to change', () => {
    const brief = 'Ana stands on the bridge. Two distant village onlookers watch from the far end.\n\n---METADATA---\n{"characters":[{"name":"Ana"}]}';
    const f = SBC.checkPopulationContradiction({ pageNumber: 6, brief }, { population: 'cast_only', fullData: {} }, ['Ana'], { pinned: true });
    expect(f?.type).toBe('population_contradicted');
    expect(f?.detail).toContain('take the unnamed figures out of the prose');
    expect(f?.detail).not.toContain('Set `population`');
    const src = fs.readFileSync(new URL('../../server/lib/images.js', import.meta.url), 'utf8');
    expect(src).toContain('checkPopulationContradiction({ pageNumber, brief: text }');
  });
});
