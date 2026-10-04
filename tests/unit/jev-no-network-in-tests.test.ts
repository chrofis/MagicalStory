import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Regression (2026-09-27): with OPENROUTER_API_KEY set in the shell, a unit
 * test that runs the text chain WITHOUT a Jev stub must not reach the Jev API.
 * tests/setup/block-jev-network.ts wraps fetch for the whole run; this pins it.
 */
// @ts-ignore CommonJS
const textModels = require('../../server/lib/textModels');
// @ts-ignore CommonJS
const { refineStoryText } = require('../../server/lib/textRefine.js');
// @ts-ignore CommonJS
const { runJevTextSource, callJev } = require('../../server/lib/jevAudit');

const PAGES = [{ pageNumber: 1, text: 'Mia ging in den Garten.', sceneIntent: 'garden', sceneBrief: 'garden', planLine: '' }];
const STORY = { language: 'de-ch', languageLevel: 'standard', pages: 1, characters: [{ id: 'c1', name: 'Mia', age: 6 }], mainCharacters: ['c1'] };

describe('no real Jev call from a unit test, key set or not', () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  const original = textModels.callTextModelStreaming;
  beforeAll(() => {
    process.env.OPENROUTER_API_KEY = 'sk-or-looks-real';
    textModels.callTextModelStreaming = async (_p: string, _m: number, _i: unknown, model: string, opts: any = {}) => ({
      text: String(opts.usageLabel || '') === 'text_refine' ? '---ANALYSIS---\nnone\n---STORY TEXT---\nNONE' : 'FAULTS: 0',
      modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1, direct_cost: 0 },
    });
  });
  afterAll(() => {
    textModels.callTextModelStreaming = original;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
  });

  it('the default client is blocked before any network I/O', async () => {
    const before = (globalThis as any).__jevBlockedCalls;
    await expect(callJev({ state: 'x', questions: { A: { type: 'noul', instructions: 'y' } } })).rejects.toThrow(/blocked in unit tests/);
    expect((globalThis as any).__jevBlockedCalls).toBe(before + 1);
  });

  it('the text chain without a stub: the Jev source fails as an outage, no request left the process', async () => {
    const before = (globalThis as any).__jevBlockedCalls;
    const res = await refineStoryText(STORY, PAGES, {});
    const jev = res.audits.find((a: any) => a.source === 'jev');
    expect(jev.ok).toBe(false);
    expect(jev.error).toMatch(/blocked in unit tests/);
    expect((globalThis as any).__jevBlockedCalls).toBeGreaterThan(before);
  });

  it('runJevTextSource directly: same', async () => {
    const r = await runJevTextSource({ language: 'de-ch' }, PAGES);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/blocked in unit tests/);
  });
});
