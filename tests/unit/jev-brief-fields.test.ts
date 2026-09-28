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
    expect(p1.elements.find((e: any) => e.id === 'ART001').cite).toBe('ART001.1');   // Jev's pick (the stub takes the first look)
    expect(p2.elements.find((e: any) => e.id === 'ART001').cite).toBe('ART001.1');
    expect(p1.elements.some((e: any) => e.id === 'ART002')).toBe(false);          // 0.6, not cited on p1
    expect(p2.scores.ART002).toBe(0.6);
    expect(p1.aboard).toBe('VEH001');                                             // aboard noul 0.6 ≥ 0.5
    expect(p1.elements.some((e: any) => e.id === 'CHR001')).toBe(false);          // 0.45 < 0.5
  });
});

describe('the look a page shows is Jev\'s, never inferred from the Art Director\'s state pages (2026-09-28)', () => {
  // Staging job_1790539784661_6mjcny1c7 p3: the plan line turns the creature
  // grey, the page sat in no state's list, and "the latest state begun before
  // it" cited the red look. This stub answers a look choice the way the plan
  // line of the page to judge reads: the look whose label shares a word with it.
  const lookStub = () => {
    const calls: any[] = [];
    const impl = async ({ state, questions }: any) => {
      calls.push({ state, questions });
      const page = String(state).split('PAGE TO JUDGE:')[1] || '';
      const answers: any = {};
      for (const [id, q] of Object.entries<any>(questions)) {
        if (q.type === 'noul') { answers[id] = { noul: 0.9 }; continue; }
        const keys = Object.keys(q.criteria || {});
        const hit = keys.find(k => String(q.criteria[k]).split(/[^a-z]+/i).some(w => w.length > 3 && page.includes(w))) || keys[0];
        answers[id] = { choice: hit, probabilities: Object.fromEntries(keys.map(k => [k, k === hit ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])) };
      }
      return { answers, cost: 0, model: 'stub', usage: {} };
    };
    return { impl, calls };
  };
  const VB = {
    animals: [{ id: 'ANI001', name: 'Drako', species: 'dragon', description: 'a dragon',
      states: [{ id: 'ANI001.1', name: 'unaltered', delta: 'vibrant scales', pages: [1] }, { id: 'ANI001.2', name: 'cold', delta: 'dull grey scales', pages: [4] }] }],
    artifacts: [{ id: 'ART001', name: 'lamp', description: 'a lamp', states: [{ name: 'only', delta: 'unlit', pages: [1] }] },
      { id: 'ART002', name: 'rope', description: 'a rope' }],
  };
  const P = [
    { pageNumber: 1, planLine: 'wide — Ana — Ana greets Drako by the wall — they are friends' },
    { pageNumber: 2, planLine: 'wide — Ana — the lamp, the rope and Drako by the wall — Drako is grey instead of red' },
  ];
  it('cites the look Jev picks for the page, on a page no state lists', async () => {
    const stub = lookStub();
    const d = await JD.decideVbAndAboard({ arc: 'A', pages: P, visualBible: VB }, { callImpl: stub.impl });
    const cite = (n: number, id: string) => d.pages.find((r: any) => r.pageNumber === n).elements.find((e: any) => e.id === id).cite;
    expect(cite(1, 'ANI001')).toBe('ANI001.1');
    expect(cite(2, 'ANI001')).toBe('ANI001.2');                 // page 2 is in neither state's pages; the plan line decides
    expect(cite(2, 'ART001')).toBe('ART001.1');                 // one look: cited by it, never asked
    expect(cite(2, 'ART002')).toBe('ART002');                   // no states: the base id
    const stateCalls = stub.calls.filter(c => Object.keys(c.questions).some(k => k.startsWith('STATE')));
    expect(stateCalls).toHaveLength(2 * JD.JEV_DECISIONS.state.reps);   // one call per page, averaged over the reps
    expect(Object.keys(stateCalls[0].questions)).toEqual(['STATE0']);   // only the element with more than one look
    expect(Object.values<any>(stateCalls[0].questions)[0].criteria).toEqual({ s0: 'unaltered: vibrant scales', s1: 'cold: dull grey scales' });
  });
  it('the bible\'s state pages are rebuilt from those cites', async () => {
    const vb: any = JSON.parse(JSON.stringify(VB));
    const d = await JD.decideVbAndAboard({ arc: 'A', pages: P, visualBible: vb }, { callImpl: lookStub().impl });
    const cites = new Map(d.pages.map((r: any) => [r.pageNumber, r.elements.map((e: any) => e.cite)]));
    JD.applyVbPages(vb, cites, ['ANI001', 'ART001', 'ART002']);
    expect(vb.animals[0].states.map((s: any) => s.pages)).toEqual([[1], [2]]);
  });
  it('a cite that changes only its look reads as the same element in another look, not as a removal', () => {
    const p = JD.pinBrief(brief({ characters: [], objects: ['LOC001', 'ANI001.1'] }), { cites: ['ANI001.2'], decidedIds: ['ANI001'] });
    expect(metaOf(p.brief).objects).toEqual(['LOC001', 'ANI001.2']);
    const f = JD.fixedFieldFinding(3, p.changes, (id: string) => id);
    expect(f.detail).toMatch(/cites ANI001\.2 .* in place of ANI001\.1/);
    expect(f.detail).not.toMatch(/no longer cites/);
  });
  it('after the scene review, a moved state page table is rebuilt from the decided cites', () => {
    const { repinJevStatePages } = req('../../server/lib/beatsPipeline');
    const vb: any = { animals: [{ id: 'ANI001', appearsInPages: [1, 2], states: [{ id: 'ANI001.1', pages: [1, 2] }, { id: 'ANI001.2', pages: [] }] }] };
    const beats = [{ pageNumber: 1, jevFixed: { cites: ['ANI001.1'], decidedIds: ['ANI001'] } }, { pageNumber: 2, jevFixed: { cites: ['ANI001.2'], decidedIds: ['ANI001'] } }];
    const gl = { info() {}, warn() {}, error() {}, debug() {} };
    repinJevStatePages(vb, null, beats, gl);
    expect(vb.animals[0].states.map((s: any) => s.pages)).toEqual([[1], [2]]);
    const untouched: any = JSON.parse(JSON.stringify(vb));
    repinJevStatePages(untouched, null, [{ pageNumber: 1 }], gl);            // off the Jev path: nothing moves
    expect(untouched).toEqual(vb);
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
  it('the bible\'s page table (appearsInPages, as parsed) agrees with the citations, state by state; a cover page stays', () => {
    const vb: any = { animals: [{ id: 'ANI001', appearsInPages: [2, -1] }], artifacts: [{ id: 'ART001', appearsInPages: [1, 3, 4], states: [{ pages: [1] }, { pages: [3] }, { pages: [4] }] }] };
    JD.applyVbPages(vb, new Map([[1, ['ANI001']], [2, ['ART001.1']], [3, ['ART001.2']], [4, []]]), ['ANI001', 'ART001']);
    expect(vb.animals[0].appearsInPages).toEqual([-1, 1]);
    expect(vb.artifacts[0].appearsInPages).toEqual([2, 3]);
    expect(vb.artifacts[0].states.map((s: any) => s.pages)).toEqual([[2], [3], []]);
  });
  it('a figure is never offered itself as a gaze target, by name or by id', () => {
    const c = JD.gazeCandidates({ roster: ['Noah', 'CHR001'], elements: [{ id: 'CHR001', kind: 'figure', name: 'the captain', desc: 'a captain' }], named: [] }, 'CHR001').map((k: any) => k.target);
    expect(c).toEqual(['Noah', 'away']);
  });
});

// OWNER 2026-09-28 (staging job_1790539784661_6mjcny1c7 p15): Jev assigned
// over-the-shoulder, the Art Director wrote `medium`, and only a console line
// recorded it. The shot is a pinned Jev field like the others.
describe('the shot is a pinned Jev field', () => {
  const adBrief = brief({ shot: 'medium', characters: [{ name: 'Ana', looksAt: 'Ben' }, { name: 'Ben', looksAt: 'Ana' }], objects: ['LOC001'] });
  it('pinBrief restores the assigned shot and the review is told', () => {
    const p = JD.pinBrief(adBrief, { shot: 'over-the-shoulder' });
    expect(metaOf(p.brief).shot).toBe('over-the-shoulder');
    expect(p.changes).toContainEqual({ field: 'shot', from: 'medium', to: 'over-the-shoulder' });
    expect(JD.fixedFieldFinding(15, p.changes).detail).toMatch(/shot is over-the-shoulder/);
    expect(JD.pinBrief(p.brief, { shot: 'over-the-shoulder' }).brief).toBe(p.brief);
  });
  it('the fixed-fields rule names the shot as fixed, and no other rule may change it', () => {
    expect(JD.JEV_FIXED_FIELDS_RULE).toMatch(/FIXED block holds the fields decided before you write: its `shot`/);
    expect(JD.JEV_FIXED_FIELDS_RULE).toMatch(/No other rule changes a fixed field/);
  });
  it('the page-brief step pins every decided field and logs what it restored (the shot among them)', () => {
    const { pinDecidedFields } = req('../../server/lib/jevBriefFields');
    const events: any[] = [];
    const gl = { info: () => {}, warn: (k: string, _m: string, _x: any, d: any) => events.push([k, d]), error: (k: string) => events.push([k]) };
    const briefBeats = [
      { pageNumber: 15, planLine: 'over-the-shoulder — Ana and Ben — Ana watches Ben run off — Ben is gone', jevFixed: { shot: 'over-the-shoulder' } },
      { pageNumber: 16, planLine: 'SHOT — Ana — she waits — she is alone' },
    ];
    const expansions = [{ pageNumber: 15, brief: adBrief }, { pageNumber: 16, brief: brief({ shot: 'wide', characters: [{ name: 'Ana', looksAt: 'away' }], objects: ['LOC001'] }) }];
    const restored = pinDecidedFields(expansions, briefBeats, gl);
    expect(metaOf(expansions[0].brief).shot).toBe('over-the-shoulder');
    expect(metaOf(expansions[1].brief).shot).toBe('wide');                 // no decided field, nothing pinned
    expect(restored.map((r: any) => [r.pageNumber, r.fields])).toEqual([[15, ['shot']]]);
    const w = events.find(e => e[0] === 'beats_jev_field_disobeyed');
    expect(w && w[1]).toMatchObject({ pageNumber: 15, fields: ['shot'], pass: 'page briefs' });
  });
});

describe('the fixed-fields rule reaches the brief authors and the critic from one constant', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('both Art Director templates and the scene review carry it, filled', () => {
    const all = String(PB.buildSceneBriefsAllPrompt({ characters: [], language: 'en' }, [{ pageNumber: 1, planLine: 'wide — Ana — x — y' }], {}));
    const one = String(PB.buildSceneExpansionPrompt(1, 'PLAN: x', [], 'en', null, '', null, {}));
    const review = String(PB.buildSceneReviewPrompt({ characters: [], language: 'en' }, [{ pageNumber: 1, brief: brief({}) }], {}));
    for (const [site, p] of [['all', all], ['one', one], ['review', review]] as [string, string][]) {
      expect(p, site).toContain(JD.JEV_FIXED_FIELDS_RULE);
      expect(p, site).not.toContain('{JEV_FIXED_FIELDS}');
    }
  });
});

// OWNER 2026-09-28, "Jev first, then remove the scene review": every decided
// field reaches the page-brief call as the page's FIXED block, before any brief
// is written; the location is read off the Visual Bible's own page tables.
describe('Jev first: the decided fields exist before the page briefs', () => {
  const vb: any = {
    locations: [
      { id: 'LOC001', name: 'harbour', appearsInPages: [1, 2], vantages: [{ id: 'LOC001.1', name: 'quay steps', pages: [1] }, { id: 'LOC001.2', name: 'harbour wall', pages: [2] }] },
      { id: 'LOC002', name: 'cabin', appearsInPages: [3] },
    ],
    animals: [{ id: 'ANI001', name: 'Drako', species: 'dragon', appearsInPages: [2, 3], states: [{ name: 'red', delta: 'red scales', pages: [2] }, { name: 'grey', delta: 'dull grey scales', pages: [3] }] }],
    artifacts: [{ id: 'ART001', name: 'lamp', label: 'brass lamp', appearsInPages: [1] }],
  };
  it('pageLocations: the vantage whose pages hold the page, else the bare location; an unplaced page is reported', () => {
    const { pageLocations } = req('../../server/lib/jevBriefFields');
    const r = pageLocations(vb, [1, 2, 3, 4]);
    expect([...r.byPage].map(([n, x]: any) => [n, x.cite])).toEqual([[1, 'LOC001.1'], [2, 'LOC001.2'], [3, 'LOC002']]);
    expect(r.unplaced).toEqual([4]);
  });
  it('decideBriefFields sets every page\'s fixed fields from the bible and the head count, and the bible pages follow', async () => {
    const J = req('../../server/lib/jevAudit');
    const saved = J.callJev;
    const stub = makeJevStub({ noul: (q, st) => (/Drako/.test(q) ? 0.9 : /lamp/.test(q) ? (/PAGE TO JUDGE: Page 1 /.test(st) ? 0.8 : 0.1) : /public can walk/.test(q) ? 0.7 : 0.1) });
    J.callJev = stub.impl;
    try {
      const { decideBriefFields } = req('../../server/lib/jevBriefFields');
      const events: any[] = [];
      const gl = { info: (k: string) => events.push(['info', k]), warn: (k: string) => events.push(['warn', k]), error: (k: string) => events.push(['error', k]) };
      const beats: any[] = [
        { pageNumber: 1, planLine: 'wide — Ana — Ana lifts the lamp — it glows', fixed: { timeOfDay: 'dusk', indoor: false } },
        { pageNumber: 2, planLine: 'medium — Ana and Ben — Drako lands — they gasp', fixed: { timeOfDay: 'dusk', indoor: false } },
        { pageNumber: 3, planLine: 'SHOT — Ben — Drako sleeps — quiet', fixed: { timeOfDay: 'night', indoor: true } },
      ];
      const bible = JSON.parse(JSON.stringify(vb));
      const present = new Map([[1, ['Ana']], [2, ['Ana', 'Ben', 'Drako']], [3, ['Ben', 'Drako']]]);
      const out = await decideBriefFields({ beats, visualBible: bible, bibleSections: null, approvedArc: '1. A thing.', inputData: { characters: [{ name: 'Ana' }, { name: 'Ben' }] }, present, gl });
      const f = (n: number) => beats.find(b => b.pageNumber === n).jevFixed;
      expect(f(1)).toMatchObject({ shot: 'wide', timeOfDay: 'dusk', indoor: false, location: 'LOC001.1', population: 'ambient' });
      expect(f(1).cites).toContain('ART001');
      expect(f(2).cites.some((c: string) => c.startsWith('ANI001.'))).toBe(true);
      expect(f(3)).toMatchObject({ location: 'LOC002', indoor: true });
      expect(f(3).shot).toBeUndefined();                                    // a placeholder plan fixes no shot
      expect(Object.keys(f(2).looksAt).sort()).toEqual(['Ana', 'Ben']);      // the head count's commissioned characters
      expect(f(1).labels['LOC001.1']).toMatch(/harbour/);
      expect(out.report.locations).toEqual({ 1: 'LOC001.1', 2: 'LOC001.2', 3: 'LOC002' });
      // the bible's element pages follow the cites before call 2 reads it
      expect(bible.artifacts[0].appearsInPages).toEqual([1]);
    } finally { J.callJev = saved; }
  });
  it('decideBriefFields refuses to guess a roster: no head count, no decision', async () => {
    const { decideBriefFields } = req('../../server/lib/jevBriefFields');
    const gl = { info: () => {}, warn: () => {}, error: () => {} };
    await expect(decideBriefFields({ beats: [{ pageNumber: 1, planLine: 'wide — Ana — x — y' }], visualBible: vb, bibleSections: null, approvedArc: '1.', inputData: { characters: [{ name: 'Ana' }] }, present: null, gl }))
      .rejects.toThrow(/no head count/);
  });
  it('the FIXED block carries every decided field, labelled, under the plan line; a cover carries none', () => {
    const b = PB.planBlocks([
      { pageNumber: 2, planLine: 'medium — Ana — x — y', jevFixed: { shot: 'medium', timeOfDay: 'dusk', indoor: false, location: 'LOC001.2', cites: ['ANI001.1'], aboard: null, population: 'cast_only', looksAt: { Ana: 'ANI001' }, labels: { 'LOC001.2': 'harbour, harbour wall', 'ANI001.1': 'Drako, red: red scales', ANI001: 'Drako' } } },
      { pageNumber: -1, planLine: 'cover' },
    ]);
    const page2 = b.split('## Page -1')[0];
    for (const line of ['- shot: medium', '- timeOfDay: dusk; outdoors', '- objects: LOC001.2 (harbour, harbour wall); ANI001.1 (Drako, red: red scales)', '- aboard: none', '- population: cast_only', '- looksAt: Ana → ANI001 (Drako)']) {
      expect(page2).toContain(line);
    }
    expect(b.split('## Page -1')[1]).not.toContain('FIXED');
  });
  it('pinBrief writes the location: the decided LOC stands first, any other LOC leaves objects[]', () => {
    const p = JD.pinBrief(brief({ sceneIntent: 'Ana waits.', characters: [{ name: 'Ana' }], objects: ['LOC002', 'ART001'] }), { location: 'LOC001.1' });
    expect(metaOf(p.brief).objects).toEqual(['LOC001.1', 'ART001']);
    expect(p.changes).toContainEqual({ field: 'location', from: ['LOC002'], to: 'LOC001.1', removed: ['LOC002'] });
  });
});
