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

describe('assignment: distinct vantages first, then the highest summed probability', () => {
  const keys = ['frontCover', 'initialPage', 'backCover'];
  it('two covers that rank the same vantage top do not both get it', () => {
    // front and back both prefer candidate 0; the best distinct split wins.
    expect(JBF.assignCoverPlaces(keys, [[0.7, 0.2, 0.1], [0.6, 0.1, 0.3], [0.7, 0.25, 0.05]])).toEqual([0, 2, 1]);
  });
  it('a vantage is shared only when the candidates run out — each used once first', () => {
    const pick = JBF.assignCoverPlaces(keys, [[0.9, 0.1], [0.8, 0.2], [0.9, 0.1]]);
    expect(new Set(pick).size).toBe(2);
    expect(JBF.assignCoverPlaces(keys, [[1], [1], [1]])).toEqual([0, 0, 0]);
  });
});

describe('decideCoverPlaces: one Jev choice per cover, code assigns', () => {
  it('asks once per cover over the candidates and returns distinct vantages', async () => {
    const stub = makeJevStub(); // every choice peaks on its first option
    const d = await JBF.decideCoverPlaces({ arc: 'an arc', pages, visualBible: VB(), coverKeys: ['frontCover', 'initialPage', 'backCover'] }, { callImpl: stub.impl });
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

// ── runArtDirector end to end (scripted model replies, Jev stubbed) ─────────
const BIBLE = ['---VISUAL BIBLE---', '```json', JSON.stringify(VB(), null, 2), '```', ''].join('\n');
const wholeBrief = (n: number) => [`## Page ${n}`, 'The child stands in the square.', '', '---METADATA---',
  JSON.stringify({ shot: 'wide', characters: [{ name: 'Mila', looksAt: 'viewer', depth: 'foreground', expression: 'brows up, eyes wide, mouth open', emotion: 'happy' }], objects: ['LOC001.1'], interactions: [] }, null, 2), ''].join('\n');
const savedText = textModels.callTextModelStreaming;
const savedJev = jevAudit.callJev;
const savedWait = JD.JEV_OUTAGE.waitMs;
beforeAll(async () => { await loadPromptTemplates(); });
afterEach(() => { textModels.callTextModelStreaming = savedText; jevAudit.callJev = savedJev; JD.JEV_OUTAGE.waitMs = savedWait; });
afterAll(() => { textModels.callTextModelStreaming = savedText; jevAudit.callJev = savedJev; });

async function run(jevImpl: any) {
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
    inputData: { language: 'en', characters: [{ id: 1, name: 'Mila', age: 6, gender: 'female', isMainCharacter: true }], artStyle: 'watercolor', title: 'T' },
    modelOverrides: {}, clothingRequirements: null, visualBible: null, bibleSections: null, sceneModel: 'claude-sonnet',
    onChunk: null, gl, meta: { timings: {} }, stage: async () => {},
    beats: pages.map(p => ({ ...p, planLine: p.planLine.replace('Child1', 'Mila') })),
    arcCentralFigure: null, approvedArc: 'an arc', present: new Map(pages.map(p => [p.pageNumber, ['Mila']])), jevReport,
  });
  return { out, prompts, jevReport };
}

describe('runArtDirector: the covers\' places between the two calls', () => {
  it('Jev path: each cover carries a distinct wide vantage as FIXED, pinned and in the bible', async () => {
    const { out, prompts, jevReport } = await run(makeJevStub().impl);
    const covers = out.coverBeats;
    const cites = covers.map((c: any) => c.jevFixed && c.jevFixed.location);
    expect(new Set(cites).size).toBe(3);
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
  it('a Jev failure on the cover step: the backup path, the own-place rule back, nothing decided', async () => {
    JD.JEV_OUTAGE.waitMs = 0;
    const ok = makeJevStub().impl;
    const { out, prompts, jevReport } = await run(async (rq: any) => {
      if (rq.questions && rq.questions.PLACE) throw new Error('HTTP 503');
      return ok(rq);
    });
    expect(jevReport.fallback.step).toBe('cover_places');
    for (const c of out.coverBeats) {
      expect(c.jevFixed).toBeUndefined();
      expect(c.planLine).toContain(CB.COVER_OWN_PLACE);
    }
    expect(prompts.beats_scene_expansion).toContain(CB.COVER_OWN_PLACE);
  });
});
