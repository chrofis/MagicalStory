/**
 * THE COVERS' PLACES (owner, 2026-10-04): Jev ranks the cover places, code
 * makes them distinct. Each cover gets a `wide` / `ultra-wide` vantage of a
 * location story pages stand on; covers differ by vantage while the candidates
 * last, and share one rather than any cover taking a close vantage. The place
 * is the cover beat's location-only FIXED field, pinned like a story page's
 * location; COVER_OWN_PLACE and `cover_location_repeated` stay for the Jev
 * backup only.
 * Pins behaviour, never question or prompt wording. Archetypal fixtures only.
 * see docs/decisions.md 2026-10-04 "The covers' places are decided"
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const JBF = req('../../server/lib/jevBriefFields');
const JD = req('../../server/lib/jevDecisions');
const CB = req('../../server/lib/coverBeats');
const SBC = req('../../server/lib/sceneBriefCheck');
const PB = req('../../server/lib/promptBuilders');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata');
const textModels = req('../../server/lib/textModels');
const jevAudit = req('../../server/lib/jevAudit');
const { runArtDirector } = req('../../server/lib/beatsPipeline');
const { loadPromptTemplates } = req('../../server/services/prompts');

const VB = () => ({
  locations: [
    { id: 'LOC001', name: 'the town square', appearsInPages: [1, 2, 3, 4, -1, -2, -3], vantages: [
      { id: 'LOC001.1', name: 'square wide', shot: 'wide', pages: [1, -1, -2, -3] },
      { id: 'LOC001.2', name: 'fountain close', shot: 'close-up', pages: [2] },
      { id: 'LOC001.3', name: 'steps', shot: 'ultra-wide', pages: [3] },
      { id: 'LOC001.4', name: 'under the tree', shot: 'wide', pages: [4] },
    ] },
    // A place seen only in the distance: no story page stands on it.
    { id: 'LOC002', name: 'the far tower', appearsInPages: [-2], vantages: [{ id: 'LOC002.1', name: 'tower', shot: 'wide', pages: [] }] },
  ],
});
const pages = [1, 2, 3, 4].map(n => ({ pageNumber: n, planLine: `wide — Child1 — the child does thing ${n} — change ${n}` }));
const brief = (objects: string[]) => `The prose.\n\n---METADATA---\n${JSON.stringify({ characters: [{ name: 'Child1', looksAt: 'viewer' }], objects }, null, 2)}`;
const objectsOf = (b: string) => { const m = extractSceneMetadata(b) || {}; return (m.fullData || m).objects; };

describe('candidates: wide vantages of the places story pages stand on', () => {
  it('never a close vantage, never a place no story page stands on', () => {
    expect(JBF.coverPlaceCandidates(VB(), [1, 2, 3, 4]).map((c: any) => c.id)).toEqual(['LOC001.1', 'LOC001.3', 'LOC001.4']);
  });
});

describe('assignment: the front picks first; the covers must be distinct', () => {
  const keys = ['frontCover', 'initialPage', 'backCover'];
  const pickOf = (probs: number[][], o: any = {}) => JBF.assignCoverPlaces(keys, probs, o).pick;
  it('the front cover always takes its top-rated vantage; the others never push it off', () => {
    expect(pickOf([[0.53, 0.47, 0], [0.8, 0.2, 0], [0.38, 0.62, 0]])).toEqual([0, 2, 1]);
    expect(JBF.assignCoverPlaces(['initialPage', 'backCover'], [[0.8, 0.2], [0.7, 0.3]]).pick).toEqual([0, 1]);
  });
  // Two landmarks: A (vantages 0, 1) and B (vantage 2).
  const cands = [{ id: 'A.1', base: 'A' }, { id: 'A.2', base: 'A' }, { id: 'B.1', base: 'B' }];
  const front = ['K1', 'K2', 'Creature'];
  const group = ['K1', 'K2'];
  it('same landmark is distinct only with a different viewpoint AND a different cast', () => {
    // front on A.1 (top); the title page and back share the cast, so one of them moves to landmark B.
    const r = JBF.assignCoverPlaces(keys, [[0.6, 0.3, 0.1], [0.5, 0.3, 0.2], [0.3, 0.5, 0.2]], { cands, casts: [front, group, group] });
    expect(r.unmet).toEqual([]);
    const bases = r.pick.map((j: number) => cands[j].base);
    expect(bases[1] === bases[2]).toBe(false);
  });
  it('a near-zero leftover is never a pick when a distinct option above the floor exists', () => {
    const r = JBF.assignCoverPlaces(keys, [[0.6, 0.3, 0.1], [0.5, 0.45, 0.05], [0.3, 0.6, 0.1]], { cands, casts: [front, ['K1'], group] });
    expect(r.unmet).toEqual([]);
    expect(r.pick).toEqual([0, 0, 1].map((_, i) => r.pick[i]));
    for (const i of [1, 2]) expect([[0.5, 0.45, 0.05], [0.3, 0.6, 0.1]][i - 1][r.pick[i]]).toBeGreaterThanOrEqual(JBF.COVER_PLACE_FLOOR);
  });
  it('no assignment meets the rule: the best one, with what failed', () => {
    const r = JBF.assignCoverPlaces(keys, [[0.6, 0.39, 0.01], [0.6, 0.39, 0.01], [0.6, 0.39, 0.01]], { cands, casts: [group, group, group] });
    expect(r.unmet.length).toBeGreaterThan(0);
  });
});

describe('decideCoverPlaces: one Jev choice per cover, code assigns', () => {
  it('asks once per cover over the candidates and returns distinct vantages', async () => {
    const calls: any[] = [];
    const stub = { calls, impl: async ({ state, questions }: any) => { calls.push({ state, questions }); return { answers: { PLACE: { choice: 'v0', probabilities: { v0: 0.4, v1: 0.35, v2: 0.25 } } }, cost: 0, model: 'stub', usage: {} }; } };
    const casts = { frontCover: ['Child1', 'Creature'], initialPage: ['Child1'], backCover: ['Child1', 'Child2'] };
    const d = await JBF.decideCoverPlaces({ arc: 'an arc', pages, visualBible: VB(), coverKeys: ['frontCover', 'initialPage', 'backCover'], casts }, { callImpl: stub.impl });
    expect(d.unmet).toEqual([]);
    expect(stub.calls).toHaveLength(3);
    for (const c of stub.calls) expect(Object.keys(c.questions.PLACE.criteria)).toHaveLength(3);
    expect(new Set(d.covers.map((c: any) => c.cite)).size).toBe(3);
    expect(d.covers.every((c: any) => ['LOC001.1', 'LOC001.3', 'LOC001.4'].includes(c.cite))).toBe(true);
  });
  it('no candidate: no covers and a reason, no Jev call', async () => {
    const stub = makeJevStub();
    const vb = { locations: [{ id: 'LOC001', name: 'a room', appearsInPages: [1], vantages: [{ id: 'LOC001.1', name: 'close', shot: 'close-up', pages: [1] }] }] };
    const d = await JBF.decideCoverPlaces({ arc: 'a', pages: [pages[0]], visualBible: vb, coverKeys: ['frontCover'] }, { callImpl: stub.impl });
    expect(d.covers).toEqual([]);
    expect(d.reason).toBeTruthy();
    expect(stub.calls).toHaveLength(0);
  });
});

describe('the FIXED field and its pin', () => {
  const fixed = { coverPlace: true, location: 'LOC001.3', labels: { 'LOC001.3': 'the town square, steps' } };
  it('a cover\'s FIXED block names its location alone — no objects or aboard line', () => {
    const block = JD.fixedBlock({ jevFixed: fixed });
    expect(block).toContain('LOC001.3');
    expect(block).not.toMatch(/- objects:|- aboard:/);
    expect(PB.planBlocks([{ pageNumber: -1, planLine: 'wide — Child1 — x — y', jevFixed: fixed }])).toContain('LOC001.3');
  });
  it('the pin puts the decided vantage first and keeps every other cite', () => {
    const pinned = JD.pinBrief(brief(['LOC001.1', 'ANI001', 'ART001']), fixed);
    expect(objectsOf(pinned.brief)).toEqual(['LOC001.3', 'ANI001', 'ART001']);
  });
  it('the bible tables follow the decision', () => {
    const vb = VB();
    JBF.applyCoverPlacePages(vb, new Map([[-1, 'LOC001.3'], [-2, 'LOC001.1'], [-3, 'LOC001.4']]));
    const v = (id: string) => vb.locations[0].vantages.find((x: any) => x.id === id).pages;
    expect(v('LOC001.1')).toEqual([1, -2]);
    expect(v('LOC001.3')).toEqual([3, -1]);
    expect(v('LOC001.4')).toEqual([4, -3]);
    expect(vb.locations[1].appearsInPages).toEqual([]);
  });
});

describe('the own-place rule and its check stay for the backup only', () => {
  const input = { characters: [{ id: 1, name: 'Child1' }], mainCharacters: [1] };
  it('a decided place carries no own-place rule; the backup does', () => {
    for (const b of CB.buildCoverBeats(input, { placeDecided: true })) expect(b.planLine).not.toContain(CB.COVER_OWN_PLACE);
    for (const b of CB.buildCoverBeats(input, { placeDecided: false })) expect(b.planLine).toContain(CB.COVER_OWN_PLACE);
  });
  it('cover_location_repeated never compares a decided cover', () => {
    const vb = VB();
    const covers = (decided: boolean) => [-1, -2, -3].map(n => ({ pageNumber: n, brief: brief(['LOC001.1']), placeDecided: decided }));
    expect(SBC.checkCoverLocations(covers(false), vb).map((f: any) => f.type)).toEqual(['cover_location_repeated', 'cover_location_repeated']);
    expect(SBC.checkCoverLocations(covers(true), vb)).toEqual([]);
  });
});


// Offered landmarks (archetypal): two with a good exterior photo, one interior-only, one weak.
const photo = (n: number, kind: string, framing: string, score: number, d: string) => ({ variantNumber: n, kind, framing, photoScore: score, url: `https://example.invalid/${n}.jpg`, description: `[whole, green, day] ${d}` });
const OFFERED = [
  { name: 'The Old Cathedral', type: 'Church', isIndexed: true, landmarkIndexId: 11, photoVariants: [photo(1, 'exterior', 'medium', 60, 'A tall stone cathedral front.'), photo(2, 'exterior', 'wide', 85, 'The cathedral above a broad square.'), photo(3, 'interior', 'interior', 90, 'A nave.')] },
  { name: 'The River Bridge', type: 'Bridge', isIndexed: true, landmarkIndexId: 12, photoVariants: [photo(1, 'exterior', 'medium', 70, 'A stone bridge over a river.')] },
  { name: 'The Museum Hall', type: 'Museum', photoVariants: [photo(1, 'interior', 'interior', 90, 'A hall.')] },
  { name: 'The Weak Tower', type: 'Tower', photoVariants: [photo(1, 'exterior', 'medium', 30, 'A blurry tower.')] },
  { name: 'the town square', type: 'Square', photoVariants: [photo(1, 'exterior', 'wide', 80, 'A square.')] },
];

describe('offered landmarks: candidates, their own question, and their place in the bible', () => {
  it('an offered landmark no page stands on, with an exterior wide/medium photo >= 40, is a candidate on its best such photo', () => {
    const c = JBF.coverPlaceCandidates(VB(), [1, 2, 3, 4], OFFERED);
    const off = c.filter((x: any) => x.offered);
    expect(off.map((x: any) => [x.name, x.offered.photo.variantNumber])).toEqual([['The Old Cathedral', 2], ['The River Bridge', 1]]);
  });
  it('is rated by its own yes/no per cover, never inside the visited choice', async () => {
    const stub = makeJevStub();
    const casts = { frontCover: ['Child1'], initialPage: ['Child1'], backCover: ['Child1'] };
    const d = await JBF.decideCoverPlaces({ arc: 'a', pages, visualBible: VB(), coverKeys: ['frontCover', 'initialPage', 'backCover'], casts, availableLandmarks: OFFERED, town: 'the town' }, { callImpl: stub.impl });
    const choices = stub.calls.filter((c: any) => c.questions.PLACE);
    const nouls = stub.calls.filter((c: any) => !c.questions.PLACE);
    expect(choices).toHaveLength(3);
    expect(nouls).toHaveLength(3);
    for (const c of choices) expect(Object.values(c.questions.PLACE.criteria).join(' ')).not.toContain('Cathedral');
    for (const c of nouls) expect(Object.values(c.questions).every((q: any) => q.type === 'noul')).toBe(true);
    // One landmark visited with one cast: the other covers go to distinct offered landmarks.
    expect(d.unmet).toEqual([]);
    expect(d.covers.filter((c: any) => c.offered).map((c: any) => c.label).sort()).toEqual(['The Old Cathedral', 'The River Bridge']);
  });
  it('a picked offered landmark becomes a linked bible place with a wide vantage citing its photo', () => {
    const vb: any = VB();
    const lm = OFFERED[0];
    const cites = JBF.materializeCoverPlaces(vb, [{ coverKey: 'initialPage', offered: { landmark: lm, photo: lm.photoVariants[1], locId: null } }, { coverKey: 'backCover', cite: 'LOC001.4' }]);
    expect(cites).toEqual({ initialPage: 'LOC003.1', backCover: 'LOC001.4' });
    const loc = vb.locations.find((l: any) => l.id === 'LOC003');
    expect(loc).toMatchObject({ name: 'The Old Cathedral', isRealLandmark: true, landmarkQuery: 'The Old Cathedral', label: 'church' });
    expect(loc.photoVariants).toHaveLength(3);
    expect(loc.vantages[0]).toMatchObject({ id: 'LOC003.1', shot: 'wide', landmarkPhoto: '2' });
    expect(loc.vantages[0].emptyScenePrompt).toContain('The cathedral above a broad square.');
  });
  it('an offered landmark already in the bible (seen, never stood on) gets a new vantage, not a second place', () => {
    const vb: any = VB();
    vb.locations[1] = { id: 'LOC002', name: 'The Old Cathedral', isRealLandmark: true, landmarkQuery: 'The Old Cathedral', appearsInPages: [] };
    const c = JBF.coverPlaceCandidates(vb, [1, 2, 3, 4], OFFERED).find((x: any) => x.name === 'The Old Cathedral');
    expect(c.offered.locId).toBe('LOC002');
    const cites = JBF.materializeCoverPlaces(vb, [{ coverKey: 'backCover', offered: c.offered }]);
    expect(cites.backCover).toBe('LOC002.1');
    expect(vb.locations.filter((l: any) => l.name === 'The Old Cathedral')).toHaveLength(1);
  });
});

// ── runArtDirector end to end (scripted model replies, Jev stubbed) ─────────
const BIBLE = ['---VISUAL BIBLE---', '```json', JSON.stringify({ era: 'medieval', ...VB() }, null, 2), '```', ''].join('\n');
const wholeBrief = (n: number) => [`## Page ${n}`, 'The child stands in the square.', '', '---METADATA---',
  JSON.stringify({ shot: 'wide', characters: [{ name: 'Mila', looksAt: 'viewer', depth: 'foreground', expression: 'brows up, eyes wide, mouth open', emotion: 'happy' }], objects: ['LOC001.1'], interactions: [] }, null, 2), ''].join('\n');
const savedText = textModels.callTextModelStreaming;
const savedJev = jevAudit.callJev;
const savedWait = JD.JEV_OUTAGE.waitMs;
beforeAll(async () => { await loadPromptTemplates(); });
afterEach(() => { textModels.callTextModelStreaming = savedText; jevAudit.callJev = savedJev; JD.JEV_OUTAGE.waitMs = savedWait; });
afterAll(() => { textModels.callTextModelStreaming = savedText; jevAudit.callJev = savedJev; });

async function run(jevImpl: any, extra: any = {}) {
  jevAudit.callJev = jevImpl;
  const prompts: Record<string, string> = {};
  textModels.callTextModelStreaming = async (prompt: string, _s: any, _c: any, model: string, opts: any) => {
    prompts[opts?.usageLabel] = prompt;
    if (opts?.usageLabel === 'beats_visual_bible') return { text: BIBLE, modelId: model, usage: {} };
    return { text: [1, 2, 3, 4, -1, -2, -3].map(wholeBrief).join('\n'), modelId: model, usage: {} };
  };
  const jevReport: any = {};
  const gl = { info() {}, warn() {}, error() {}, debug() {} };
  const out = await runArtDirector({
    inputData: { language: 'en', characters: [{ id: 1, name: 'Mila', age: 6, gender: 'female', isMainCharacter: true }], artStyle: 'watercolor', title: 'T', ...extra },
    modelOverrides: {}, clothingRequirements: null, visualBible: null, bibleSections: null, sceneModel: 'claude-sonnet',
    onChunk: null, gl, meta: { timings: {} }, stage: async () => {},
    beats: pages.map(p => ({ ...p, planLine: p.planLine.replace('Child1', 'Mila') })),
    arcCentralFigure: null, approvedArc: 'an arc', present: new Map(pages.map(p => [p.pageNumber, ['Mila']])), jevReport,
  });
  return { out, prompts, jevReport };
}

describe('runArtDirector: the covers\' places between the two calls', () => {
  it('Jev path: each cover carries a wide vantage as FIXED, pinned and in the bible; one landmark + one cast is flagged not distinct', async () => {
    const { out, prompts, jevReport } = await run(makeJevStub().impl);
    const covers = out.coverBeats;
    const cites = covers.map((c: any) => c.jevFixed && c.jevFixed.location);
    expect(cites.every(Boolean)).toBe(true);
    // Every cover shows the same one character on the one landmark: no assignment is distinct.
    expect(jevReport.coverPlaces.unmet.some((u: string) => u.startsWith('distinct:'))).toBe(true);
    for (const c of covers) expect(c.planLine).not.toContain(CB.COVER_OWN_PLACE);
    for (const cite of cites) expect(prompts.beats_scene_expansion).toContain(cite);
    for (const c of covers) {
      const x = out.expansions.find((e: any) => e.pageNumber === c.pageNumber);
      expect(objectsOf(x.brief)[0]).toBe(c.jevFixed.location);
    }
    const tables = out.visualBible.locations[0].vantages.flatMap((v: any) => (v.pages || []).filter((n: number) => n < 0).map((n: number) => [n, v.id]));
    expect(new Map(tables)).toEqual(new Map(covers.map((c: any) => [c.pageNumber, c.jevFixed.location])));
    expect(jevReport.coverPlaces.covers).toHaveLength(3);
    expect(jevReport.fallback).toBeFalsy();
  });
  it('every cover shot, gaze, light and era are code-owned: in the FIXED block before call 2 and pinned into the brief', async () => {
    const { out, prompts } = await run(makeJevStub().impl);
    for (const c of out.coverBeats) {
      expect(c.jevFixed).toMatchObject({ coverPlace: true, shot: 'wide', looksAtAll: 'viewer', era: 'medieval' });
      expect(c.jevFixed.timeOfDay).toBeTruthy();
      const x = out.expansions.find((e: any) => e.pageNumber === c.pageNumber);
      const m: any = extractSceneMetadata(x.brief);
      expect((m.fullData || m).shot).toBe('wide');
      expect((m.fullData || m).timeOfDay).toBe(c.jevFixed.timeOfDay);
      expect(m.era).toBe('medieval');
      expect((m.fullData || m).characters.every((ch: any) => ch.looksAt === 'viewer')).toBe(true);
    }
    expect(prompts.beats_scene_expansion).toContain('era: medieval');
  });
  it('Jev path with offered landmarks: three distinct covers, the offered places in the bible and in the call-2 prompt', async () => {
    const { out, prompts, jevReport } = await run(makeJevStub().impl, { availableLandmarks: OFFERED, userLocation: { city: 'the town' } });
    expect(jevReport.coverPlaces.unmet).toEqual([]);
    const cites = out.coverBeats.map((c: any) => c.jevFixed.location);
    expect(new Set(cites.map((x: string) => x.split('.')[0])).size).toBe(3);
    for (const cite of cites) {
      expect(prompts.beats_scene_expansion).toContain(cite);
      const base = cite.split('.')[0];
      const loc = out.visualBible.locations.find((l: any) => l.id === base);
      expect(loc.vantages.find((v: any) => v.id === cite)).toBeTruthy();
    }
    for (const c of out.coverBeats) {
      const x = out.expansions.find((e: any) => e.pageNumber === c.pageNumber);
      expect(objectsOf(x.brief)[0]).toBe(c.jevFixed.location);
    }
  });
  it('a Jev failure on the cover step: the backup path, the own-place rule back, nothing decided', async () => {
    JD.JEV_OUTAGE.waitMs = 0;
    const ok = makeJevStub().impl;
    const { out, prompts, jevReport } = await run(async (rq: any) => {
      if (rq.questions && rq.questions.PLACE) throw new Error('HTTP 503');
      return ok(rq);
    });
    expect(jevReport.fallback.step).toBe('cover_places');
    for (const c of out.coverBeats) {
      // No place was decided, but the shot, the gaze and the era are code's with or without Jev.
      expect(c.jevFixed.location).toBeUndefined();
      expect(c.jevFixed).toMatchObject({ coverPlace: true, shot: 'wide', looksAtAll: 'viewer' });
      expect(c.planLine).toContain(CB.COVER_OWN_PLACE);
    }
    expect(prompts.beats_scene_expansion).toContain(CB.COVER_OWN_PLACE);
  });
});
