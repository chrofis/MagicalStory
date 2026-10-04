import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * THE TITLE THROUGH THE LECTOR (2026-10-04). Staging
 * job_1791040103540_atbttop6w shipped "Vier Freunde und ein Drachonei" on its
 * front cover: the page text had a lector, the title had none. Pinned here:
 *   - the candidates go through the page lector's prompt, model and options;
 *   - a corrected title replaces the writer's in title, candidates and judge;
 *   - every change is logged, a failure is logged at error;
 *   - the cover render options carry the corrected title.
 */

// @ts-ignore — CommonJS lib
const textModels = require('../../server/lib/textModels');
// @ts-ignore — CommonJS lib
const { proofreadTitleCandidates, LECTOR_OPTS } = require('../../server/lib/textRefine.js');
// @ts-ignore — CommonJS lib
const { applyTitleProofread } = require('../../server/lib/beatsPipeline.js');
// @ts-ignore — CommonJS lib
const { coverRenderOptions } = require('../../server/lib/coverRender.js');
// @ts-ignore — CommonJS lib
const { COVER_PAGE_NUMBERS } = require('../../server/lib/coverKeys.js');
// @ts-ignore — CommonJS lib
const { MODEL_DEFAULTS } = require('../../server/config/models');

const STORED = ['Das Ei im Laub', 'Rubinas Ei', 'Vier Freunde und ein Drachonei'];
const STORY = { language: 'de-ch', languageLevel: '1st-grade' };
// The real reply gemini-3.1-pro gave on the stored candidates (2026-10-04).
const REPLY = "PAGE 3: 'Vier Freunde und ein Drachonei' → 'Vier Freunde und ein Drachenei'";

function makeGl() {
  const events: { level: string; type: string; message: string; data: any }[] = [];
  const at = (level: string) => (type: string, message: string, _x: unknown, data: any) => events.push({ level, type, message, data });
  return { events, info: at('info'), warn: at('warn'), error: at('error') };
}

describe('proofreadTitleCandidates — the page lector, on the title', () => {
  const original = textModels.callTextModelStreaming;
  const calls: { prompt: string; model: string; opts: any }[] = [];
  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _max: unknown, _cb: unknown, model: string, opts: any = {}) => {
      calls.push({ prompt: String(prompt), model, opts });
      return { text: REPLY, modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('sends every candidate through the lector prompt, model and options, and applies the correction', async () => {
    const r = await proofreadTitleCandidates(STORY, STORED);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.model).toBe(MODEL_DEFAULTS.textProofreadModel);
    expect(c.opts).toMatchObject({ temperature: LECTOR_OPTS.temperature, reasoning: LECTOR_OPTS.reasoning, usageLabel: 'title_lector' });
    // The lector template: proofreader instruction, the reply contract, every candidate as a page.
    expect(c.prompt).toContain('final proofreader');
    expect(c.prompt).toContain("PAGE <n>: '<the faulty words");
    STORED.forEach((t, i) => expect(c.prompt).toContain(`--- Page ${i + 1} ---\n${t}`));
    expect(r.candidates).toEqual(['Das Ei im Laub', 'Rubinas Ei', 'Vier Freunde und ein Drachenei']);
    expect(r.applied).toHaveLength(1);
  });
});

describe('applyTitleProofread — what the beats pipeline ships', () => {
  const parsed = { title: STORED[2], titleCandidates: STORED, titleJudge: { pick: 2, reason: 'r', candidates: STORED } };
  const fixed = ['Das Ei im Laub', 'Rubinas Ei', 'Vier Freunde und ein Drachenei'];
  const proofread = async () => ({ candidates: fixed, applied: [{}], dropped: [], unparsed: [], rawResponse: REPLY, modelId: 'm', elapsedMs: 5 });

  it('replaces the title, the candidates and the judge candidates, and keeps the pick', async () => {
    const gl = makeGl();
    const out = await applyTitleProofread(STORY, parsed, gl, { proofread });
    expect(out.title).toBe('Vier Freunde und ein Drachenei');
    expect(out.titleCandidates).toEqual(fixed);
    expect(out.titleJudge).toMatchObject({ pick: 2, candidates: fixed });
    // storyJobPipeline ships titleJudge.candidates[pick] — the corrected string.
    expect(out.titleJudge.candidates[out.titleJudge.pick]).toBe(out.title);
  });

  it('logs every changed candidate with before and after', async () => {
    const gl = makeGl();
    await applyTitleProofread(STORY, parsed, gl, { proofread });
    const ev = gl.events.filter(e => e.type === 'title_proofread_corrected');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ index: 2, before: 'Vier Freunde und ein Drachonei', after: 'Vier Freunde und ein Drachenei', picked: true });
  });

  it('keeps a hash-picked title by index, not by re-hashing the corrected strings', async () => {
    const gl = makeGl();
    const out = await applyTitleProofread(STORY, { ...parsed, title: STORED[1], titleJudge: null }, gl, {
      proofread: async () => ({ candidates: ['Das Ei im Laub', 'Rubinas Ei!', 'X'], dropped: [], unparsed: [], modelId: 'm', elapsedMs: 1 }),
    });
    expect(out.title).toBe('Rubinas Ei!');
    expect(out.titleJudge).toBeNull();
  });

  it('proofreads a lone TITLE line when the writer gave no candidate list', async () => {
    const gl = makeGl();
    const out = await applyTitleProofread(STORY, { title: 'Ein Drachonei', titleCandidates: [], titleJudge: null }, gl, {
      proofread: async (_s: unknown, list: string[]) => ({ candidates: list.map(t => t.replace('Drachonei', 'Drachenei')), dropped: [], unparsed: [], modelId: 'm', elapsedMs: 1 }),
    });
    expect(out.title).toBe('Ein Drachenei');
    expect(out.titleCandidates).toEqual([]);
  });

  it('a failed call is logged at error and the writer title ships unchanged', async () => {
    const gl = makeGl();
    const out = await applyTitleProofread(STORY, parsed, gl, { proofread: async () => { throw new Error('boom'); } });
    expect(out.title).toBe(STORED[2]);
    const err = gl.events.filter(e => e.level === 'error' && e.type === 'title_proofread_failed');
    expect(err).toHaveLength(1);
    expect(err[0].message).toContain('boom');
  });

  it('the front cover renders the corrected title', async () => {
    const out = await applyTitleProofread(STORY, parsed, makeGl(), { proofread });
    const opts = coverRenderOptions(COVER_PAGE_NUMBERS.frontCover, { title: out.title, coverTitleMode: 'baked' });
    expect(opts.bakeTitle).toContain('Drachenei');
    expect(opts.bakeTitle).not.toContain('Drachonei');
  });
});
