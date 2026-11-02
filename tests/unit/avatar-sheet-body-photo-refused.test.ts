/**
 * Grok refused an innocent uploaded body photo with "Input image rejected by content moderation (CONTENT_POLICY_VIOLATION)"
 * (prod trial 2026-11-02, both sheets of a 4-year-old, story lost). The face crop alone passed (prod Lab 70/71). The sheet now
 * retries ONCE with the face photo only, keeps that for the redo, records it, and a second refusal still fails loudly.
 * Owner 2026-11-02 "Fallback to face crop"; docs/decisions.md 2026-11-02.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateJudgedOneCallSheet } = require('../../server/lib/oneCallSheet.js');
const judgeLib = require('../../server/lib/avatarSheetJudge.js');
const grok = require('../../server/lib/grok.js');

const INPUT_REFUSAL = '{"code":"invalid-argument","error":"Input image rejected by content moderation. (CONTENT_POLICY_VIOLATION)"}';
const OUTPUT_REFUSAL = '{"code":"imagine:content-moderated","error":"Generated image rejected by content moderation."}';
const refusal = (body: string) => Object.assign(new Error(`Grok edit API error (400): ${body}`), {
  statusCode: 400, moderated: grok.isGrokModerationBody(body), inputRejected: grok.isGrokInputRejectionBody(body),
});
const judged = (over: Record<string, { verdict: string; cells: number[] }> = {}) => ({
  parsed: judgeLib.parseAvatarSheetVerdict({
    cells: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ cell: n, headgear: 'none', hairVisible: 'full', hairColour: 'blonde', hairStyle: 'down', head: 'present', top: 't-shirt', extras: 'none', heldObject: 'none', view: n % 4 === 0 ? 'rear' : 'front' })),
    ...Object.fromEntries(judgeLib.DEFECT_TYPES.map((t: string) => [t, { verdict: 'ok', cells: [] }])),
    ...over,
    evidence: 'x',
  }),
  raw: {}, prompt: 'P',
});
const clean = () => judged();
const character = { name: 'Kid', age: '4', gender: 'female', photos: { face: 'data:image/jpeg;base64,FACE', bodyNoBg: 'data:image/jpeg;base64,BODY' } };
const run = (gen: any, judge: any) => generateJudgedOneCallSheet(character, { artStyle: 'watercolor', kind: 'costume' }, { generate: gen, judge });

afterEach(() => vi.restoreAllMocks());

describe('Grok error codes', () => {
  it('an input refusal is flagged inputRejected, not moderated; an output refusal the other way round', () => {
    expect(grok.isGrokInputRejectionBody(INPUT_REFUSAL)).toBe(true);
    expect(grok.isGrokModerationBody(INPUT_REFUSAL)).toBe(false);
    expect(grok.isGrokInputRejectionBody(OUTPUT_REFUSAL)).toBe(false);
    expect(grok.isGrokModerationBody(OUTPUT_REFUSAL)).toBe(true);
  });
});

describe('a refused body photo', () => {
  it('is retried once with the face photo only, and the record says so', async () => {
    const gen = vi.fn(async (_c: any, g: any) => {
      if (gen.mock.calls.length === 1) throw refusal(INPUT_REFUSAL);
      return { imageData: `SHEET:${g.references}`, usage: null, modelId: 'grok-imagine-image-2.0', prompt: 'P' };
    });
    const judge = vi.fn(async () => clean());
    const out = await run(gen, judge);
    expect(gen).toHaveBeenCalledTimes(2);
    expect(gen.mock.calls[1][1].references).toBe('face');
    expect(out.imageData).toBe('SHEET:face');
    expect(out.sheetCheck.bodyPhotoRefused).toBe(true);
  });

  it('the redo after a flag also uses the face photo only', async () => {
    const gen = vi.fn(async (_c: any, g: any) => {
      if (gen.mock.calls.length === 1) throw refusal(INPUT_REFUSAL);
      return { imageData: `SHEET${gen.mock.calls.length}:${g.references}`, usage: null, modelId: 'grok-imagine-image-2.0', prompt: 'P' };
    });
    const answers = [judged({ bald: { verdict: 'bald_cell', cells: [5] } }), clean()];
    const judge = vi.fn(async () => answers.shift());
    const out = await run(gen, judge);
    expect(out.sheetCheck.redone).toBe(true);
    expect(gen).toHaveBeenCalledTimes(3);
    for (const call of gen.mock.calls.slice(1)) expect(call[1].references).toBe('face');
  });

  it('a refused face photo fails loudly (no third try)', async () => {
    const gen = vi.fn(async () => { throw refusal(INPUT_REFUSAL); });
    await expect(run(gen, vi.fn())).rejects.toThrow(/CONTENT_POLICY_VIOLATION/);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it('an OUTPUT refusal is not retried here (that refusal has its own handling)', async () => {
    const gen = vi.fn(async () => { throw refusal(OUTPUT_REFUSAL); });
    await expect(run(gen, vi.fn())).rejects.toThrow(/content-moderated/);
    expect(gen).toHaveBeenCalledTimes(1);
  });
});
