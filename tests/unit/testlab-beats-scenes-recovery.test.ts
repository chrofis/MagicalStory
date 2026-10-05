/**
 * The all-pages Art Director must not report a truncated reply as a whole
 * set of briefs — in the story run AND in the Lab's `beats_scenes` stage.
 *
 * Pinned failure: Test Lab experiment 1275 (`beats_scenes`, story
 * `job_1789420511893_zly5rcdej`, 16 pages). The Art Director's all-pages reply
 * was cut mid-JSON inside page 9 — the stored brief ends literally on
 * `"objects": ["LOC001", "ART002"], "interactions":` — and pages 10-16 never
 * arrived. The stage accepted every `## Page N` chunk verbatim, so it returned
 * sixteen expansions of which seven were empty and one was half a spec.
 *
 * The run's recovery (a brief that fails the scene-brief contract is not
 * merged, the batch is retried once, whatever is still missing is re-expanded
 * page by page) now lives in ONE place, beatsPipeline.runArtDirector, which the
 * run and the Lab stage both call since 2026-09-27 — the Lab's copy of it
 * (collectAllPagesBriefs) is deleted. These tests drive that function with the
 * model stubbed. They pin BEHAVIOUR (which briefs count, what is retried),
 * never prompt wording.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { makeJevStub } from '../helpers/jev-stub';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const textModels = require_('../../server/lib/textModels');
const { runArtDirector } = require_('../../server/lib/beatsPipeline');
const { summarizeSceneExpansions } = require_('../../server/lib/testlab');
const { loadPromptTemplates } = require_('../../server/services/prompts');

/** A brief that meets the contract: prose, metadata block, sceneIntent. */
function wholeBrief(pageNumber: number) {
  return [
    `## Page ${pageNumber}`,
    `The main character stands at the edge of the square while the crowd thins out.`,
    '',
    '---METADATA---',
    JSON.stringify({ sceneIntent: `page ${pageNumber}: the main character waits`, characters: ['the main character'], objects: ['LOC001'], interactions: [], textPosition: 'bottom' }, null, 2),
    '',
  ].join('\n');
}
/** The REAL page-9 tail from experiment 1275 — the reply stops mid-object. */
const cutBrief = (pageNumber: number) => [
  `## Page ${pageNumber}`,
  'The main character crosses the courtyard as the light drops behind the roofline.',
  '',
  '---METADATA---',
  '{',
  '  "sceneIntent": "the main character crosses the courtyard",',
  '  "characters": ["the main character"],',
  '  "objects": ["LOC001", "ART002"], "interactions":',
].join('\n');
const BIBLE = ['---VISUAL BIBLE---', '```json', JSON.stringify({
  locations: [{ id: 'LOC001', name: 'the market square', label: 'market square', description: 'a cobbled square', appearsInPages: [1, 2] }],
}, null, 2), '```', ''].join('\n');

const saved = textModels.callTextModelStreaming;
// The Jev decision layer runs inside runArtDirector (light before, fields after).
const jevAudit = require_('../../server/lib/jevAudit');
const savedJev = jevAudit.callJev;
afterEach(() => { textModels.callTextModelStreaming = saved; });
beforeAll(async () => { await loadPromptTemplates(); jevAudit.callJev = makeJevStub().impl; });
afterAll(() => { jevAudit.callJev = savedJev; });

/** Run the Art Director on pages 1-2 plus the front cover with scripted replies. */
async function run(batchReplies: (string | Error)[], bibleReplies: (string | Error)[] = [BIBLE]) {
  const batchCalls: number[] = [];
  const bibleCalls: number[] = [];
  const fallbackCalls: string[] = [];
  textModels.callTextModelStreaming = async (prompt: string, _s: any, _c: any, model: string, opts: any) => {
    // Call 1 (2026-09-28): the Visual Bible alone.
    if (opts?.usageLabel === 'beats_visual_bible') {
      bibleCalls.push(bibleCalls.length + 1);
      const reply = bibleReplies[Math.min(bibleCalls.length, bibleReplies.length) - 1];
      if (reply instanceof Error) throw reply;
      return { text: reply, modelId: model, usage: {} };
    }
    if (opts?.usageLabel === 'beats_scene_expansion') {
      batchCalls.push(batchCalls.length + 1);
      const reply = batchReplies[Math.min(batchCalls.length, batchReplies.length) - 1];
      if (reply instanceof Error) throw reply;
      return { text: reply, modelId: model, usage: {} };
    }
    // per-page fallback: which page did it ask for?
    const m = prompt.match(/PLAN:\s*(page \d+|front cover[^\n]*)/i);
    fallbackCalls.push(m ? m[1] : '?');
    return { text: wholeBrief(0).replace('## Page 0\n', ''), modelId: model, usage: {} };
  };
  const gl = { info() {}, warn() {}, error() {}, debug() {} };
  const out = await runArtDirector({
    inputData: { language: 'en', characters: [{ id: 1, name: 'Mila', age: 6, gender: 'female', isMainCharacter: true }], coverTypes: ['frontCover'], artStyle: 'watercolor', title: 'T' },
    modelOverrides: {}, clothingRequirements: null, visualBible: null, bibleSections: null, sceneModel: 'claude-sonnet',
    onChunk: null, gl, meta: { timings: {} }, stage: async () => {},
    beats: [{ pageNumber: 1, planLine: 'page 1' }, { pageNumber: 2, planLine: 'page 2' }],
    arcCentralFigure: null, approvedArc: 'an arc',
    present: new Map([[1, ['Mila']], [2, ['Mila']]]),
  });
  return { out, batchCalls, bibleCalls, fallbackCalls };
}

describe('runArtDirector — the run\'s truncation recovery', () => {
  it('does not accept the cut page, retries the batch, and falls back per-page', async () => {
    const reply = BIBLE + wholeBrief(1) + wholeBrief(-1) + cutBrief(2);
    const { out, batchCalls, fallbackCalls } = await run([reply, reply]);
    expect(batchCalls).toEqual([1, 2]);
    expect(fallbackCalls).toHaveLength(1);
    expect(out.sceneExpansionReport.fallbackPages).toEqual([2]);
    expect(out.expansions.map((x: any) => x.pageNumber).sort()).toEqual([-1, 1, 2]);
  });

  it('a retry that fills the gap stops there — no per-page call', async () => {
    const { out, batchCalls, fallbackCalls } = await run([
      BIBLE + wholeBrief(1) + wholeBrief(-1) + cutBrief(2),
      BIBLE + wholeBrief(1) + wholeBrief(2) + wholeBrief(-1),
    ]);
    expect(batchCalls).toEqual([1, 2]);
    expect(fallbackCalls).toEqual([]);
    expect(out.sceneExpansionReport.fallbackPages).toEqual([]);
  });

  it("the first attempt's pages win — a retry can only fill gaps", async () => {
    const first = BIBLE + wholeBrief(1) + wholeBrief(-1);
    const second = BIBLE + wholeBrief(1).replace('stands at the edge', 'RETRY TEXT') + wholeBrief(2) + wholeBrief(-1);
    const { out } = await run([first, second]);
    expect(out.expansions.find((x: any) => x.pageNumber === 1).brief).not.toContain('RETRY TEXT');
  });

  it('a whole batch nobody can parse is taken as written rather than re-expanded page by page', async () => {
    // Not one page carries the metadata block the contract asks for.
    const proseOnly = (n: number) => `## Page ${n}\nThe main character waits at the edge of the square.\n\n`;
    const reply = BIBLE + proseOnly(1) + proseOnly(2) + proseOnly(-1);
    const { out, fallbackCalls } = await run([reply, reply]);
    expect(fallbackCalls).toEqual([]);
    expect(out.expansions).toHaveLength(3);
  });

  it('a thrown batch call goes straight to the per-page fallback', async () => {
    const { out, batchCalls, fallbackCalls } = await run([new Error('provider 503')]);
    expect(batchCalls).toEqual([1]);
    expect(fallbackCalls).toHaveLength(3);
    expect(out.sceneExpansionReport.fallbackPages.sort()).toEqual([-1, 1, 2]);
  });
});

describe('summarizeSceneExpansions — a partial run announces itself', () => {
  it('is null when every page has a brief', () => {
    expect(summarizeSceneExpansions([{ pageNumber: 1, ok: true }, { pageNumber: 2, ok: true }])).toBeNull();
  });

  it('a still-missing page makes the stage report incomplete, naming the page', () => {
    const marker = summarizeSceneExpansions([
      { pageNumber: 1, ok: true },
      { pageNumber: 2, ok: false, error: 'per-page fallback failed' },
      { pageNumber: 3, ok: true },
    ]);
    expect(marker).not.toBeNull();
    expect(marker.measured).toBe(2);
    expect(marker.expected).toBe(3);
    expect(marker.missingPages).toEqual([2]);
    expect(marker.message).toContain('2 of 3 pages measured');
    expect(marker.message).toContain('page(s) 2');
  });

  it('handles a stage that expanded nothing at all', () => {
    expect(summarizeSceneExpansions(null)).toBeNull();
    expect(summarizeSceneExpansions([])).toBeNull();
  });
});

describe('runArtDirector — the Visual Bible call (2026-09-28, call 1 of 2)', () => {
  it('a bible reply cut mid-JSON is not adopted: the call is retried once, and the second whole reply is the bible', async () => {
    const cut = BIBLE.slice(0, BIBLE.indexOf('"appearsInPages"'));
    const reply = wholeBrief(1) + wholeBrief(2) + wholeBrief(-1);
    const { out, bibleCalls } = await run([reply], [cut, BIBLE]);
    expect(bibleCalls).toEqual([1, 2]);
    expect(out.visualBible.locations.map((l: any) => l.id)).toEqual(['LOC001']);
    expect(out.sceneExpansionReport.visualBibleReplies).toHaveLength(2);
  });

  it('the page-brief call receives the adopted bible and each story page\'s decided location', async () => {
    const reply = wholeBrief(1) + wholeBrief(2) + wholeBrief(-1);
    let briefsPrompt = '';
    const { out } = await run([reply]);
    briefsPrompt = out.briefsPrompt;
    expect(briefsPrompt).toContain('"market square"');
    expect(briefsPrompt).toContain('- objects: LOC001');
    // the cover page's FIXED block holds its code-owned shot and gaze, never an objects line
    const coverBlock = briefsPrompt.split('## Page -1')[1].split(String.fromCharCode(10, 10))[0];
    expect(coverBlock).toContain('shot: wide');
    expect(coverBlock).not.toContain('- objects:');
  });

  it('no bible at all: the story still gets its briefs, loudly, from an empty bible', async () => {
    const reply = wholeBrief(1) + wholeBrief(2) + wholeBrief(-1);
    const { out, bibleCalls } = await run([reply], [new Error('provider 503')]);
    expect(bibleCalls).toEqual([1, 2]);
    expect(out.visualBible).toBeNull();
    expect(out.expansions.map((x: any) => x.pageNumber).sort()).toEqual([-1, 1, 2]);
  });
});
