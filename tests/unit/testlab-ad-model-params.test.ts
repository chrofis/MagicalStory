/**
 * Lab-only Art Director parameters (AD cheaper-model experiment, 2026-10-05):
 * `sceneReasoningEffort` and `visualBibleModel`. Absent = the production call.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { makeJevStub } from '../helpers/jev-stub';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const textModels = require_('../../server/lib/textModels');
const { runArtDirector } = require_('../../server/lib/beatsPipeline');
const { sceneCallOptions } = require_('../../server/lib/testlab');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const jevAudit = require_('../../server/lib/jevAudit');

const brief = (n: number) => [`## Page ${n}`, 'The main character waits.', '', '---METADATA---',
  JSON.stringify({ sceneIntent: `p${n}`, characters: ['the main character'], objects: ['LOC001'], interactions: [], textPosition: 'bottom' }), ''].join('\n');
const BIBLE = ['---VISUAL BIBLE---', '```json', JSON.stringify({ locations: [{ id: 'LOC001', name: 'square', label: 'square', description: 'a square', appearsInPages: [1] }] }), '```', ''].join('\n');

const saved = textModels.callTextModelStreaming;
const savedJev = jevAudit.callJev;
afterEach(() => { textModels.callTextModelStreaming = saved; });
beforeAll(async () => { await loadPromptTemplates(); jevAudit.callJev = makeJevStub().impl; });
afterAll(() => { jevAudit.callJev = savedJev; });

async function run(extra: any) {
  const seen: Record<string, { model: string; opts: any }> = {};
  textModels.callTextModelStreaming = async (_p: string, _s: any, _c: any, model: string, opts: any) => {
    seen[opts?.usageLabel] = { model, opts };
    return { text: opts?.usageLabel === 'beats_visual_bible' ? BIBLE : BIBLE + brief(1) + brief(-1), modelId: model, usage: {} };
  };
  await runArtDirector({
    inputData: { language: 'en', characters: [{ id: 1, name: 'Mila', age: 6, gender: 'female', isMainCharacter: true }], coverTypes: ['frontCover'], artStyle: 'watercolor', title: 'T' },
    modelOverrides: {}, clothingRequirements: null, visualBible: null, bibleSections: null, sceneModel: 'claude-sonnet',
    onChunk: null, gl: { info() {}, warn() {}, error() {}, debug() {} }, meta: { timings: {} }, stage: async () => {},
    beats: [{ pageNumber: 1, planLine: 'page 1' }], arcCentralFigure: null, approvedArc: 'an arc', present: new Map([[1, ['Mila']]]),
    ...extra,
  });
  return seen;
}

describe('sceneCallOptions', () => {
  it('absent params give the production call (no options)', () => {
    expect(sceneCallOptions({})).toEqual({});
  });
  it('sceneReasoningEffort asks for that effort', () => {
    expect(sceneCallOptions({ sceneReasoningEffort: 'medium' })).toEqual({ reasoning: { effort: 'medium' } });
  });
  it('sceneNoReasoning still switches reasoning off', () => {
    expect(sceneCallOptions({ sceneNoReasoning: true })).toEqual({ reasoning: { enabled: false } });
  });
  it('an unknown effort fails loudly', () => {
    expect(() => sceneCallOptions({ sceneReasoningEffort: 'ultra' })).toThrow(/sceneReasoningEffort/);
  });
});

describe('runArtDirector visualBibleModel', () => {
  it('absent: the bible call uses the scene model', async () => {
    const seen = await run({});
    expect(seen.beats_visual_bible.model).toBe('claude-sonnet');
    expect(seen.beats_scene_expansion.model).toBe('claude-sonnet');
  });
  it('set: only the bible call changes model', async () => {
    const seen = await run({ visualBibleModel: 'gemini-3.1-pro' });
    expect(seen.beats_visual_bible.model).toBe('gemini-3.1-pro');
    expect(seen.beats_scene_expansion.model).toBe('claude-sonnet');
  });
  it('labCallOptions reasoning reaches the AD calls', async () => {
    const seen = await run({ labCallOptions: sceneCallOptions({ sceneReasoningEffort: 'medium' }) });
    expect(seen.beats_visual_bible.opts.reasoning).toEqual({ effort: 'medium' });
    expect(seen.beats_scene_expansion.opts.reasoning).toEqual({ effort: 'medium' });
  });
});

describe('runArtDirector labAdoptBibleFrom (reuseStoredBible)', () => {
  it('absent: the bible call runs', async () => {
    const seen = await run({});
    expect(seen.beats_visual_bible).toBeDefined();
  });
  it('set: no bible call is paid, the briefs call still runs and cites the adopted bible', async () => {
    const seen = await run({ labAdoptBibleFrom: BIBLE });
    expect(seen.beats_visual_bible).toBeUndefined();
    expect(seen.beats_scene_expansion).toBeDefined();
  });
  it('set to a transcript with no bible fails loudly', async () => {
    await expect(run({ labAdoptBibleFrom: 'no bible here' })).rejects.toThrow(/labAdoptBibleFrom/);
  });
});
