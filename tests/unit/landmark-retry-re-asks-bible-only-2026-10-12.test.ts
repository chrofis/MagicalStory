/**
 * Landmark guideline, 2026-10-12 (docs/decisions.md "Landmark retry re-asks only the Visual Bible"):
 * a bible that stages fewer than two real landmarks re-asks the Visual Bible call ONCE with the
 * shortfall fed back. Arc, plan and wardrobe are not re-run (the old retry re-ran the whole
 * writer, ~31 min, on prod job_1791748539342_ikyl88w1h and still shipped one landmark).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const textModels = req('../../server/lib/textModels.js');
const bp = req('../../server/lib/beatsPipeline.js');
const PB = req('../../server/lib/promptBuilders.js');
const LG = req('../../server/lib/landmarkGuideline.js');
const { loadPromptTemplates } = req('../../server/services/prompts.js');

const STOP = new Error('STOP_AFTER_VB');
const landmark = (name: string, pages: number[]) => ({ id: `LOC_${name}`, name, isRealLandmark: true, landmarkQuery: name, appearsInPages: pages });
const bibleReply = (staged: string[]) => '---VISUAL BIBLE---\n```json\n' + JSON.stringify({
  era: 'present day', secondaryCharacters: [], animals: [], artifacts: [], vehicles: [], clothing: [],
  locations: staged.map((n, i) => landmark(n, [i + 1])),
}) + '\n```\n';

const OFFERED = [{ name: 'Alpha Bridge' }, { name: 'Beta Tower' }, { name: 'Gamma Abbey' }];
const input = (o: any = {}) => ({
  pages: 2, season: 'autumn', language: 'en', storyDetails: 'x', premiseNamedWorld: false, availableLandmarks: OFFERED,
  characters: [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }], mainCharacters: ['a'], ...o,
});

async function run(replies: string[][], inputOverrides: any = {}) {
  const prompts: string[] = [];
  const queue = replies.map(r => bibleReply(r));
  vi.spyOn(textModels, 'callTextModelStreaming').mockImplementation(async (prompt: string, _a: any, _b: any, _m: any, opts: any = {}) => {
    if (opts.usageLabel !== 'beats_visual_bible') throw STOP;   // everything after the bible is out of scope here
    prompts.push(prompt);
    return { text: queue.shift(), modelId: 'stub', usage: {} };
  });
  const meta: any = { timings: {} };
  const gl = { info() {}, warn() {}, error() {}, debug() {} };
  try {
    await bp.runArtDirector({
      inputData: input(inputOverrides), modelOverrides: {}, clothingRequirements: null, visualBible: null, bibleSections: null,
      sceneModel: 'stub', onChunk: null, gl, meta, stage: async () => {},
      beats: [{ pageNumber: 1, planLine: 'medium — Levin — walks — nothing' }, { pageNumber: 2, planLine: 'medium — Levin — rests — nothing' }],
      arcCentralFigure: null, approvedArc: '1. Levin walks.', wardrobeBibleReport: null, present: null,
      jevReport: { fallback: { step: 'test', reason: 'test' } },   // Jev down: no decision calls
    });
  } catch (e: any) { if (!String(e.message).includes('STOP_AFTER_VB')) throw e; }
  return { prompts, meta };
}

beforeAll(async () => { await loadPromptTemplates(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Visual Bible landmark re-ask', () => {
  it('a bible with one landmark re-asks that call once, with the shortfall and the offered list in the prompt', async () => {
    const { prompts, meta } = await run([['Alpha Bridge'], ['Alpha Bridge', 'Beta Tower']]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('A previous Visual Bible staged');
    expect(prompts[1]).toContain('A previous Visual Bible staged only 1 ("Alpha Bridge")');
    for (const o of OFFERED) expect(prompts[1]).toContain(o.name);
    expect(meta.landmarkRetry).toEqual({ before: 1, after: 2 });
  });

  it('two landmarks on the first answer: no re-ask', async () => {
    const { prompts, meta } = await run([['Alpha Bridge', 'Beta Tower']]);
    expect(prompts).toHaveLength(1);
    expect(meta.landmarkRetry).toBeUndefined();
  });

  it('one re-ask only: a second shortfall ships, it is never asked a third time', async () => {
    const { prompts, meta } = await run([[], ['Alpha Bridge'], ['Alpha Bridge', 'Beta Tower']]);
    expect(prompts).toHaveLength(2);
    expect(meta.landmarkRetry).toEqual({ before: 0, after: 1 });
  });

  it('a story whose premise names its own world (guideline off) is never re-asked', async () => {
    const { prompts } = await run([['Alpha Bridge']], { premiseNamedWorld: true });
    expect(prompts).toHaveLength(1);
  });

  it('no landmarks offered: nothing to re-ask for', async () => {
    const { prompts } = await run([[]], { availableLandmarks: [] });
    expect(prompts).toHaveLength(1);
  });
});

describe('landmarkGuideline helpers', () => {
  it('counts only real landmarks that appear on a page', () => {
    const vb = { locations: [landmark('A', [1]), landmark('B', []), { name: 'C', isRealLandmark: false, appearsInPages: [2] }] };
    expect(LG.stagedRealLandmarks(vb).map((l: any) => l.name)).toEqual(['A']);
    expect(LG.stagedRealLandmarks(null)).toEqual([]);
  });

  it('the guideline is active only for a binding location with offered landmarks', () => {
    expect(LG.landmarkGuidelineActive(input())).toBe(true);
    expect(LG.landmarkGuidelineActive(input({ premiseNamedWorld: true }))).toBe(false);
    expect(LG.landmarkGuidelineActive(input({ availableLandmarks: [] }))).toBe(false);
  });

  it('the retry note reaches only the Art Director landmark section', () => {
    const note = LG.landmarkRetryNote([]);
    expect(PB.buildAvailableLandmarksSection(OFFERED, note, { forArtDirector: true })).toContain(note);
    expect(PB.buildAvailableLandmarksSection(OFFERED, '', { forArtDirector: true })).not.toContain('previous Visual Bible');
  });
});

describe('the old whole-writer retry is gone', () => {
  it('beatsPipeline and storyJobPipeline no longer carry the onVisualBible abort seam or landmarkRetryNote on writer prompts', async () => {
    const fs = await import('node:fs');
    expect(fs.readFileSync('server/lib/beatsPipeline.js', 'utf8')).not.toContain('onVisualBible');
    const job = fs.readFileSync('storyJobPipeline.js', 'utf8');
    expect(job).not.toContain('LandmarkShortfallAbort');
    expect(job).not.toContain('runBeatsWriterWithLandmarkGuideline');
    expect(job).not.toContain('inputData.landmarkRetryNote');
  });
});
