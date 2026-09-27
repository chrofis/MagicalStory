/**
 * THE JEV DECISION LAYER, Parts 3-5 (owner, 2026-09-27): VB citations per page,
 * light + place fields, gaze. Jev decides, code verifies and writes the brief's
 * metadata; the review is told what code set and may not change it.
 * Pins behaviour, never question wording.
 * see docs/decisions.md 2026-09-27 "Jev decision layer wired, Parts 3-5"
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const JD = req('../../server/lib/jevDecisions');
const PB = req('../../server/lib/promptBuilders');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata');
const { VB_ELEMENT_BUDGET } = req('../../server/lib/vbElementBudget');
const { loadPromptTemplates } = req('../../server/services/prompts');

const brief = (m: any) => `The prose of the page.\n\n---METADATA---\n${JSON.stringify(m, null, 2)}`;
const metaOf = (b: string) => { const m = extractSceneMetadata(b) || {}; return m.fullData || m; };
const pages = [1, 2, 3].map(n => ({ pageNumber: n, planLine: `SHOT — Ana — she does thing ${n} — change ${n}` }));

describe('light: the time of day is Jev\'s, the clock never runs backwards', () => {
  it('holds an earlier hour within a day, and lets a new day start after the evening', () => {
    expect(JD.forwardClock(['afternoon', 'morning', 'dusk']).times).toEqual(['afternoon', 'afternoon', 'dusk']);
    expect(JD.forwardClock(['evening', 'night', 'morning']).times).toEqual(['evening', 'night', 'morning']);
    expect(JD.forwardClock(['night', 'dusk']).held).toEqual([{ index: 1, jev: 'dusk', held: 'night' }]);
  });
  it('one call per page; enums enforced; indoor from the noul', async () => {
    const stub = makeJevStub({ noul: (q) => (/set indoors/.test(q) ? 0.8 : 0.5) });
    const d = await JD.decideLight({ arc: 'A', pages }, { callImpl: stub.impl });
    expect(stub.calls).toHaveLength(3);
    expect(d.pages.map((p: any) => [p.timeOfDay, p.indoor])).toEqual([['dawn', true], ['dawn', true], ['dawn', true]]);
  });
  it('the FIXED line reaches the Art Director under the plan line', () => {
    const b = PB.planBlocks([{ pageNumber: 4, planLine: 'wide — Ana — x — y', fixed: { timeOfDay: 'dusk', indoor: false } }, { pageNumber: -1, planLine: 'cover' }]);
    expect(b).toContain('PLAN: wide — Ana — x — y\nFIXED: timeOfDay dusk; outdoors');
    expect(b.split('## Page -1')[1]).not.toContain('FIXED');
  });
});

describe('VB citations: Jev per element, code holds ids, states and the budget', () => {
  const VB = {
    animals: [{ id: 'ANI001', name: 'Drako', species: 'dragon', description: 'a grey dragon' }],
    secondaryCharacters: [{ id: 'CHR001', name: 'Guard', description: 'a guard' }],
    artifacts: [
      { id: 'ART001', name: 'lamp', description: 'a lamp', states: [{ pages: [1] }, { pages: [3] }] },
      { id: 'ART002', name: 'rope', description: 'a rope' },
      { id: 'ART003', name: 'map', description: 'a map' },
      { id: 'ART004', name: 'key', description: 'a key' },
      { id: 'ART005', name: 'bell', description: 'a bell' },
    ],
    vehicles: [{ id: 'VEH001', name: 'boat', description: 'a boat' }],
  };
  const score = (q: string) => (/^Drako/.test(q) ? 0.72 : /^Guard/.test(q) ? 0.45 : /the lamp/.test(q) ? 0.9 : /the rope/.test(q) ? 0.6
    : /the map/.test(q) ? 0.8 : /the key/.test(q) ? 0.75 : /the bell/.test(q) ? 0.71 : /the boat/.test(q) ? 0.55 : /camera .* stands on or inside/.test(q) ? 0.6 : 0.1);
  it('creatures at 0.7, secondaries 0.5, objects 0.7 (0.5-0.7 only where the brief cited it), vehicles 0.5; top-P within the budget', async () => {
    const d = await JD.decideVbAndAboard({ arc: 'A', pages, visualBible: VB, adCited: new Map([[2, new Set(['ART002'])]]) }, { callImpl: makeJevStub({ noul: score }).impl });
    const p1 = d.pages.find((r: any) => r.pageNumber === 1);
    const p2 = d.pages.find((r: any) => r.pageNumber === 2);
    expect(p1.elements.length).toBe(VB_ELEMENT_BUDGET);                        // lamp .9, map .8, key .75, Drako .72 — bell .71 over budget
    expect(p1.elements.map((e: any) => e.id)).toEqual(['ART001', 'ART003', 'ART004', 'ANI001']);
    expect(p1.overBudget).toEqual(expect.arrayContaining(['ART005', 'VEH001']));
    expect(p1.elements.find((e: any) => e.id === 'ART001').cite).toBe('ART001.1');   // the state for page 1
    expect(p2.elements.find((e: any) => e.id === 'ART001').cite).toBe('ART001.1');   // page 2: the state begun before it
    expect(p1.elements.some((e: any) => e.id === 'ART002')).toBe(false);          // 0.6, not cited on p1
    expect(p2.scores.ART002).toBe(0.6);
    expect(p1.aboard).toBe('VEH001');                                             // aboard noul 0.6 ≥ 0.5
    expect(p1.elements.some((e: any) => e.id === 'CHR001')).toBe(false);          // 0.45 < 0.5
  });
});

describe('population per LOCATION', () => {
  it('crowd ≥ 0.5 → crowd, else public ≥ 0.5 → ambient, else cast_only', async () => {
    const vb = { locations: [{ id: 'LOC001', name: 'square' }, { id: 'LOC002', name: 'cave' }] };
    const stub = makeJevStub({ noul: (q, s) => (/public can walk into/.test(q) ? (/square/.test(s) ? 0.9 : 0.1) : 0.1) });
    const d = await JD.decidePopulation({ arc: 'A', pages, visualBible: vb, locOf: new Map([[1, 'LOC001'], [2, 'LOC002'], [3, 'LOC001']]) }, { callImpl: stub.impl });
    expect(d.byLocation.LOC001.population).toBe('ambient');
    expect(d.byLocation.LOC002.population).toBe('cast_only');
    expect(d.byLocation.LOC001.pages).toEqual([1, 3]);
    expect(stub.calls).toHaveLength(2);                                            // one call per location
  });
});

describe('gaze: a choice over code-listed targets, 3 calls averaged', () => {
  it('lists the others, the cited elements, the named creatures and away — never the viewer on a story page', () => {
    const idx = JD.gazeIndex({ animals: [{ id: 'ANI001', name: 'Drako', description: 'a dragon' }], artifacts: [{ id: 'ART001', name: 'lamp', description: 'a lamp' }], locations: [{ id: 'LOC001', name: 'square' }] });
    const mat = JD.gazePageMaterial({ objects: ['ART001', 'LOC001'], interactions: [{ object: 'CLO001' }], planLine: 'SHOT — Ana, Ben — Ana looks at Drako — x', index: idx });
    const c = JD.gazeCandidates({ roster: ['Ana', 'Ben'], ...mat }, 'Ana').map((k: any) => k.target);
    expect(c).toEqual(['Ben', 'ART001', 'LOC001', 'ANI001', 'away']);
    expect(c).not.toContain('viewer');
  });
  it('code writes the averaged top candidate', async () => {
    const stub = makeJevStub();
    const d = await JD.decideGaze({ arc: 'A', pages, perPage: [{ pageNumber: 1, roster: ['Ana', 'Ben'], elements: [], named: [] }] }, { callImpl: stub.impl });
    expect(stub.calls).toHaveLength(3);
    expect(d.pages[0].characters.map((c: any) => [c.name, c.looksAt])).toEqual([['Ana', 'Ben'], ['Ben', 'Ana']]);
  });
});

describe('pinBrief: code writes the decided fields; the review is told what changed', () => {
  const before = brief({ characters: [{ name: 'Ana', looksAt: 'away' }], objects: ['LOC001', 'ART009', 'CLO001'], timeOfDay: 'morning', weather: 'rain', population: 'cast_only', aboard: 'VEH001' });
  const fixed = { timeOfDay: 'dusk', indoor: true, cites: ['ANI001'], decidedIds: ['ANI001', 'ART009', 'VEH001'], population: 'ambient', aboard: null, aboardIds: ['VEH001'], looksAt: { Ana: 'ANI001' } };
  it('writes every field, keeps locations and undecided ids', () => {
    const p = JD.pinBrief(before, fixed);
    const m = metaOf(p.brief);
    expect(m.timeOfDay).toBe('dusk');
    expect(m.weather).toBe('none');
    expect(m.objects).toEqual(['LOC001', 'CLO001', 'ANI001']);
    expect(m.population).toBe('ambient');
    expect(m.aboard).toBeUndefined();
    expect(m.characters[0].looksAt).toBe('ANI001');
    expect(p.brief.split('---METADATA---')[0]).toBe(before.split('---METADATA---')[0]);   // the prose is never touched
  });
  it('is idempotent — a pinned brief pins to itself', () => {
    const once = JD.pinBrief(before, fixed).brief;
    expect(JD.pinBrief(once, fixed).brief).toBe(once);
  });
  it('an outdoor page whose weather is none is reported, never guessed', () => {
    const p = JD.pinBrief(brief({ characters: [{ name: 'Ana' }], objects: ['LOC001'], weather: 'none' }), { timeOfDay: 'midday', indoor: false });
    expect(metaOf(p.brief).weather).toBe('none');
    expect(metaOf(p.brief).timeOfDay).toBe('midday');
    expect(p.changes.find((c: any) => c.field === 'weather').problem).toBe('outdoors');
  });
  it('the finding names what code set, for the prose to follow', () => {
    const p = JD.pinBrief(before, fixed);
    const f = JD.fixedFieldFinding(3, p.changes, (id: string) => ({ ANI001: 'Drako', ART009: 'the lamp' } as any)[id] || id);
    expect(f.type).toBe('jev_fixed_field');
    expect(f.detail).toMatch(/now cites ANI001 \(Drako\)/);
    expect(f.detail).toMatch(/no longer cites ART009 \(the lamp\)/);
    expect(f.detail).toMatch(/Ana looks at ANI001/);
    expect(req('../../server/lib/sceneBriefCheck').REVIEWABLE.has('jev_fixed_field')).toBe(true);
  });
  it('the bible\'s pages agree with the citations; a cover page stays', () => {
    const vb: any = { animals: [{ id: 'ANI001', pages: [2, -1] }], artifacts: [{ id: 'ART001', pages: [1], states: [{ pages: [1] }, { pages: [3] }] }] };
    JD.applyVbPages(vb, new Map([[1, ['ANI001']], [2, ['ART001.1']]]), ['ANI001', 'ART001']);
    expect(vb.animals[0].pages).toEqual([-1, 1]);
    expect(vb.artifacts[0].pages).toEqual([2]);
    expect(vb.artifacts[0].states[0].pages).toEqual([1, 2]);
  });
});

describe('the fixed-fields rule reaches the brief authors and the critic from one constant', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('both Art Director templates and the scene review carry it, filled', () => {
    const all = String(PB.buildSceneExpansionAllPrompt({ characters: [], language: 'en' }, [{ pageNumber: 1, planLine: 'wide — Ana — x — y' }], {}));
    const one = String(PB.buildSceneExpansionPrompt(1, 'PLAN: x', [], 'en', null, '', null, {}));
    const review = String(PB.buildSceneReviewPrompt({ characters: [], language: 'en' }, [{ pageNumber: 1, brief: brief({}) }], {}));
    for (const [site, p] of [['all', all], ['one', one], ['review', review]] as [string, string][]) {
      expect(p, site).toContain(JD.JEV_FIXED_FIELDS_RULE);
      expect(p, site).not.toContain('{JEV_FIXED_FIELDS}');
    }
  });
});
