/**
 * WIDER JEV OPTIONS, light and gaze (owner, 2026-10-06: Jev's choice lists should have too many options
 * rather than too few, each wired through every consumer). Pins behaviour, never prompt wording.
 * Archetypal fixtures only. see docs/decisions.md 2026-10-06 "Wider Jev options: light and gaze"
 *
 * LIGHT: one table (sceneLight.LIGHTS) feeds the enum, the phrases, Jev's criteria and the judge's notes;
 *   underwater_deep / underwater_night / underwater_dark join underwater and dark; an INDOOR page (weather
 *   none) is told window light, never a sky or a moon (bug); a dark page names the lit element it is lit by;
 *   a cover is lit by its own place's pages.
 * GAZE: Jev may pick down / up / ahead / distance / away / outside / held (never `closed`: closed eyes read as asleep, EYES_OPEN_RULE stands; decisions.md 2026-10-06); the place itself is no
 *   target; an out-of-frame character is never named in a prompt.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const SL = req('../../server/lib/sceneLight');
const JD = req('../../server/lib/jevDecisions');
const JBF = req('../../server/lib/jevBriefFields');
const G = req('../../server/lib/gazeTargets');
const PB = req('../../server/lib/promptBuilders');
const { gazeTarget, formatInteractionsBlock } = req('../../server/lib/vbIdGuard');
const { checkDeclaredGaze } = req('../../server/lib/gazeCheck');
const { resolveLooksAt } = req('../../server/lib/compositeCastBuilder');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata');

const SKY = /\b(sun|moon|sky|skies|horizon|daylight)\b/i;
const brief = (m: any) => `Prose.\n\n---METADATA---\n${JSON.stringify(m, null, 2)}`;
const metaOf = (b: string) => { const m = extractSceneMetadata(b) || {}; return m.fullData || m; };

describe('the light table is the one source (parity)', () => {
  it('the enum, the phrases, Jev\'s criteria and the judge notes list the same values', () => {
    expect(SL.TIMES_OF_DAY).toEqual(SL.LIGHTS.map((l: any) => l.id));
    expect(Object.keys(SL.JEV_TIME_CRITERIA)).toEqual(SL.TIMES_OF_DAY);
    expect(Object.keys(JD.lightQuestions().TIME.criteria)).toEqual(SL.TIMES_OF_DAY);
    expect(Object.keys(JD.lightQuestions().WEATHER.criteria)).toEqual(SL.WEATHERS);
    for (const t of SL.TIMES_OF_DAY) {
      for (const w of ['clear', 'fog', 'none']) expect(SL.lightPhrase({ timeOfDay: t, weather: w }), `${t}/${w}`).not.toBe('');
    }
    for (const t of SL.SKYLESS_LIGHTS) expect(SL.JUDGE_SKYLESS_NOTES).toContain(t);
    expect(SL.CLOCK_HOURS.length + SL.SKYLESS_LIGHTS.length).toBe(SL.TIMES_OF_DAY.length);
  });
  it('the water lights exist beside underwater and dark', () => {
    expect(SL.SKYLESS_LIGHTS).toEqual(['underwater', 'underwater_deep', 'underwater_night', 'underwater_dark', 'dark']);
    expect(SL.SKYLESS_LIGHT_RULE).toContain('underwater_dark');
    expect(SL.normaliseTimeOfDay('Underwater_Dark')).toBe('underwater_dark');
  });
});

describe('every skyless light, in every consumer, names no sun, moon or sky', () => {
  for (const t of SL.SKYLESS_LIGHTS) {
    it(`${t}: page, plate, repair, relight, derive, judge`, () => {
      const light = { timeOfDay: t, weather: 'none' };
      const lines = [SL.buildLightLine(light), SL.buildLightLine(light, { plate: true }), SL.buildRepairLightLine(light),
        SL.buildPlateRelightInstruction(light), SL.relightClause(light), SL.keepLightClause(light), SL.describeLightForJudge(light)];
      for (const l of lines) { expect(l, l).not.toBe(''); expect(l, l).not.toMatch(SKY); }
    });
  }
  it('the dark water lights are contradicted by a daylight read only; the clock goes on around them', () => {
    for (const t of SL.SKYLESS_LIGHTS) {
      expect(SL.timeContradicts(t, 'afternoon')).toBe(true);
      expect(SL.timeContradicts(t, 'night')).toBe(false);
    }
    const times = ['evening', 'underwater_dark', 'underwater_deep', 'dusk', 'underwater_night', 'morning'];
    expect(JD.forwardClock(times).times).toEqual(times);
  });
  it('a skyless answer hides the sky for everything downstream (weather none), underwater_dark included, without calling the page indoor', async () => {
    const stub = makeJevStub({ noul: () => 0.0 });
    const impl = async (args: any) => { const r = await stub.impl(args); r.answers.TIME = { choice: 'underwater_dark', probabilities: { underwater_dark: 1 } }; return r; };
    const d = await JD.decideLight({ arc: 'A', pages: [{ pageNumber: 1, planLine: 'SHOT — Ana — swims into a cloud — y' }] }, { callImpl: impl });
    expect(d.pages[0]).toMatchObject({ timeOfDay: 'underwater_dark', indoor: false });
    expect(JD.fixedLine({ timeOfDay: 'underwater_dark', indoor: true })).toContain('no sky (weather none)');
  });
});

// BUG 2026-10-06: lightParts used the open-sky hour phrase for weather `none`, so an indoor page was told
// "a deep blue fading sky" and "lit by the moon" (essbvehs8 p8 the ship's hold, 6mjcny1c7 p6 a tram).
describe('REGRESSION: an indoor page gets window light, never a sky or a moon', () => {
  for (const hour of SL.CLOCK_HOURS) {
    it(`${hour} indoors`, () => {
      const phrase = SL.lightPhrase({ timeOfDay: hour, weather: 'none' });
      expect(phrase).not.toMatch(/\b(sun|moon|sky|skies|horizon)\b/i);
      expect(SL.buildLightLine({ timeOfDay: hour, weather: 'none' })).not.toMatch(/\b(sun|moon|sky|skies)\b/i);
      expect(SL.buildRepairLightLine({ timeOfDay: hour, weather: 'none' })).not.toMatch(/\b(sun|moon|sky|skies)\b/i);
    });
  }
  it('an outdoor hour still names its sky, and an undeclared weather keeps the open phrase', () => {
    expect(SL.lightPhrase({ timeOfDay: 'night', weather: 'clear' })).toMatch(/moon/);
    expect(SL.lightPhrase({ timeOfDay: 'dusk', weather: 'clear' })).toMatch(/sky/);
  });
});

describe('a dark page names what lights it', () => {
  const light = { timeOfDay: 'underwater_dark', weather: 'none', sources: ['glow-fish', 'lantern'] };
  it('the page and repair lines carry the lit elements; a plate and a derive never do', () => {
    expect(SL.buildLightLine(light)).toContain('glow-fish and lantern');
    expect(SL.buildRepairLightLine(light)).toContain('glow-fish and lantern');
    expect(SL.buildLightLine(light, { plate: true })).not.toContain('glow-fish');
    expect(SL.relightClause(light)).not.toContain('glow-fish');
    expect(SL.keepLightClause(light)).not.toContain('glow-fish');
    expect(SL.describeLightForJudge(light)).not.toContain('glow-fish');
  });
  it('reads from the brief metadata, in the flat keys and fullData', () => {
    const m = extractSceneMetadata(brief({ timeOfDay: 'night', weather: 'none', lightSources: ['lantern', ' '], characters: [], objects: [] }));
    expect(SL.declaredLight(m).sources).toEqual(['lantern']);
    expect(SL.declaredLight({ timeOfDay: 'night', weather: 'none' })).toEqual({ timeOfDay: 'night', weather: 'none' });
  });
  it('code pins the sources, idempotently, and an empty list clears a stale one', () => {
    const before = brief({ timeOfDay: 'night', weather: 'none', characters: [], objects: ['LOC001'] });
    const once = JD.pinBrief(before, { lightSources: ['lantern'] }).brief;
    expect(metaOf(once).lightSources).toEqual(['lantern']);
    expect(JD.pinBrief(once, { lightSources: ['lantern'] }).brief).toBe(once);
    expect(metaOf(JD.pinBrief(once, { lightSources: [] }).brief).lightSources).toEqual([]);
  });
  it('the FIXED block tells the Art Director', () => {
    expect(JD.fixedBlock({ jevFixed: { timeOfDay: 'night', indoor: true, cites: [], lightSources: ['lantern'] } })).toContain('lightSources: lantern');
  });
  it('Jev is asked per cited element on a dim page only; P >= 0.5 is a source', async () => {
    const stub = makeJevStub({ noul: (q) => (/lantern/.test(q) ? 0.9 : 0.1) });
    const pages = [1, 2].map(n => ({ pageNumber: n, planLine: `SHOT — Ana — x${n} — y` }));
    const d = await JD.decideLightSources({ arc: 'A', pages, perPage: [
      { pageNumber: 1, elements: [{ id: 'ART001.2', name: 'lantern', desc: 'a lamp', look: 'lit' }, { id: 'ART002', name: 'rock', desc: 'a rock', look: '' }] },
      { pageNumber: 2, elements: [] },
    ] }, { callImpl: stub.impl });
    expect(stub.calls).toHaveLength(1);                       // the page with no cited element asks nothing
    expect(d.byPage.get(1).map((x: any) => x.name)).toEqual(['lantern']);
  });
});

describe('a cover is lit by its own place', () => {
  const pg = (n: number, t: string, loc: string, indoor = false, weather = 'clear') => ({ pageNumber: n, fixed: { timeOfDay: t, indoor, weatherAdvice: weather }, jevFixed: { location: loc } });
  const story = [pg(1, 'morning', 'LOC001'), pg(2, 'afternoon', 'LOC001.2'), pg(3, 'underwater_dark', 'LOC002', true, 'none'), pg(4, 'underwater_dark', 'LOC002', true, 'none'), pg(5, 'afternoon', 'LOC001')];
  it('the front cover on the cave place reads the cave pages, not the book', () => {
    expect(JBF.coverLight('frontCover', story, 'LOC002.1')).toMatchObject({ timeOfDay: 'underwater_dark', indoor: true, weather: 'none' });
    expect(JBF.coverLight('frontCover', story, 'LOC001')).toMatchObject({ timeOfDay: 'afternoon', sourcePage: 2 });
  });
  it('back cover and title page take the last / first page AT that place', () => {
    expect(JBF.coverLight('backCover', story, 'LOC001')).toMatchObject({ sourcePage: 5 });
    expect(JBF.coverLight('initialPage', story, 'LOC002')).toMatchObject({ sourcePage: 3 });
  });
  it('a place no story page stands on has no light of its own: the book\'s pages are the evidence', () => {
    expect(JBF.coverLight('frontCover', story, 'LOC009')).toEqual(JBF.coverLight('frontCover', story));
    expect(JBF.coverFacts({ coverKey: 'backCover', storyBeats: story, location: 'LOC002' }).timeOfDay).toBe('underwater_dark');
  });
});

describe('gaze words: one table, wired to every consumer', () => {
  it('Jev is offered the direction words, never the place, and `outside` only when someone is off-frame', () => {
    const base = { roster: ['Ana', 'Ben'], elements: [{ id: 'LOC001', kind: 'place', name: 'the square', desc: 'a square' }], named: [] };
    const without = JD.gazeCandidates(base, 'Ana').map((k: any) => k.target);
    expect(without).toEqual(['Ben', ...G.GAZE_TOKEN_IDS.filter((t: string) => t !== 'outside')]);
    expect(without).not.toContain('LOC001');
    const withOff = JD.gazeCandidates({ ...base, offFrame: ['Cleo'] }, 'Ana');
    expect(withOff.map((k: any) => k.target)).toContain('outside');
    expect(withOff.find((k: any) => k.target === 'outside').label).toContain('Cleo');   // Jev's label only
  });
  it('an uncited thing the plan line names is a target', () => {
    const idx = JD.gazeIndex({ artifacts: [{ id: 'ART005', name: 'kite', description: 'a red kite' }] });
    const mat = JD.gazePageMaterial({ objects: [], interactions: [], planLine: 'SHOT — Ana — Ana watches the kite — x', index: idx });
    expect(JD.gazeCandidates({ roster: ['Ana'], ...mat }, 'Ana').map((k: any) => k.target)).toContain('ART005');
  });
  it('Jev\'s direction pick is written as looksAt and survives the pin and the guard (was blanked as "the place itself")', async () => {
    const stub = makeJevStub();
    const impl = async (args: any) => {
      const r = await stub.impl(args);
      for (const [id, q] of Object.entries<any>(args.questions)) {
        const keys = Object.keys(q.criteria); const down = keys.find(k => /^down/.test(q.criteria[k]));
        r.answers[id] = { choice: down, probabilities: Object.fromEntries(keys.map(k => [k, k === down ? 0.9 : 0.01])) };
      }
      return r;
    };
    const d = await JD.decideGaze({ arc: 'A', pages: [{ pageNumber: 1, planLine: 'SHOT — Ana — Ana kneels — y' }], perPage: [{ pageNumber: 1, roster: ['Ana'], elements: [{ id: 'LOC001', kind: 'place', name: 'the square', desc: 'x' }], named: [] }] }, { callImpl: impl });
    expect(d.pages[0].characters[0].looksAt).toBe('down');
    const pinned = JD.pinBrief(brief({ characters: [{ name: 'Ana', looksAt: 'LOC001' }], objects: ['LOC001'] }), { looksAt: { Ana: 'down' } });
    expect(metaOf(pinned.brief).characters[0].looksAt).toBe('down');
    expect(gazeTarget('down', ['LOC001'])).toBe('down');
    expect(gazeTarget('LOC001', ['LOC001'])).toBe('');          // an Art Director's place gaze (backup path) is still no eyes target
    expect(JD.fixedBlock({ jevFixed: { cites: [], looksAt: { Ana: 'down' } } })).toContain('Ana → down (eyes cast down)');
  });
  it('the picture prompt: every word has its own eyes line; outside never names anyone', () => {
    const phrases = G.GAZE_TOKEN_IDS.map((t: string) => PB.looksAtPhrase(t));
    expect(new Set(phrases).size).toBe(G.GAZE_TOKEN_IDS.length);
    expect(PB.looksAtPhrase('away')).toBe('eyes turned away from everyone in the frame');   // unchanged: stored `away` renders as before
    expect(PB.looksAtPhrase('distance')).not.toBe(PB.looksAtPhrase('away'));
    expect(PB.looksAtPhrase('outside')).toBe('eyes on someone just outside the picture');
    const poses = PB.buildExactPosesBlock([], [{ name: 'Ana', depth: 'foreground', looksAt: 'ahead' }, { name: 'Ben', depth: 'foreground', looksAt: 'down' }]);
    expect(poses).toContain('- Ana: eyes straight ahead along the way forward, face turned the same way, never to the viewer');
    expect(poses).toContain('- Ben: eyes cast down, face turned the same way, never to the viewer');
    const out = PB.buildExactPosesBlock([], [{ name: 'Ana', depth: 'foreground', looksAt: 'outside' }]);
    expect(out).not.toMatch(/Cleo/);
  });
  it('the judges read a declared gaze word as a phrase, never "looks at down"', () => {
    const block = formatInteractionsBlock([], null, [{ name: 'Ana', looksAt: 'down' }, { name: 'Ben', looksAt: 'outside' }, { name: 'Cy', looksAt: 'Ana' }]);
    expect(block).toContain('- Ana looks down');
    expect(block).toContain('- Ben looks at someone just outside the picture');
    expect(block).toContain('- Cy looks at Ana');
    expect(block).not.toMatch(/looks at down/);
  });
  it('the gaze check skips every word the blind describer cannot confirm; `away` still only meets eyes on the reader', () => {
    const inventory = { figures: [{ label: 'a girl', gaze: 'at the viewer', facing: 'camera' }] };
    const matches = [{ reference: 'Ana', body_bbox: [0, 0, 10, 10], figure_label: 'a girl' }];
    for (const t of ['down', 'up', 'ahead', 'distance', 'outside', 'held']) {
      expect(checkDeclaredGaze({ declared: [{ name: 'Ana', looksAt: t }], inventory, matches }), t).toEqual([]);
    }
  });
  it('the composite cast keeps a gaze word as it is, and the blend clause is a phrase', () => {
    expect(resolveLooksAt('down', null)).toBe('down');
    expect(G.gazeLookingClause('down')).toBe('looking down');
    expect(G.gazeLookingClause('Ana')).toBe('looking at Ana');
  });
  it('the Art Director\'s field rule lists the words', () => {
    for (const t of G.GAZE_TOKEN_IDS) expect(PB.LOOKS_AT_FIELD_RULE).toContain(`\`${t}\``);
  });
  it('`closed` is not a gaze word: closed eyes read as asleep, so no Jev option, no picture line, no field-rule word (owner verdict kept 2026-10-06)', () => {
    expect(G.GAZE_TOKEN_IDS).not.toContain('closed');
    expect(G.gazeToken('closed')).toBeNull();
    expect(PB.LOOKS_AT_FIELD_RULE).not.toMatch(/closed/);
    expect(PB.LOOKS_AT_FIELD_FIXED_RULE).not.toMatch(/closed/);
    expect(PB.EYES_OPEN_RULE).toContain('No closed eyes');
  });
});
