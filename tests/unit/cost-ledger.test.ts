/**
 * The per-job cost ledger (server/lib/costLedger.js) and its one pricer
 * (priceUsage, config/models.js). docs/decisions.md 2026-10-08 "Cost accounting:
 * one pricer". Pins what the 2026-10-05 accounting review found wrong: a bucket
 * that mixes models was priced at its FIRST model, three pricers disagreed, cache
 * tokens and cut streams were dropped, and a price table lived outside models.js.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const require_ = createRequire(import.meta.url);
const { priceUsage, pricingKnown, MODEL_PRICING } = require_('../../server/config/models');
const { newTokenUsage, recordCall, ledgerTotal } = require_('../../server/lib/costLedger');
const { anthropicUsage, geminiUsage, sumUsage } = require_('../../server/lib/providerUsage');

const M = 1_000_000;

describe('priceUsage', () => {
  it('bills tokens at the model rates, thinking at its own rate', () => {
    const p = MODEL_PRICING['gemini-2.5-flash'];
    const got = priceUsage('gemini-2.5-flash', { input_tokens: M, output_tokens: M, thinking_tokens: M });
    expect(got).toBeCloseTo(p.input + p.output + p.thinking, 9);
  });

  it('a provider-reported charge wins over the token estimate', () => {
    expect(priceUsage('claude-sonnet-5-5', { input_tokens: M, output_tokens: M, direct_cost: 0.123 })).toBe(0.123);
  });

  it('Anthropic cache reads and writes are subsets of input, billed at their own rates', () => {
    const p = MODEL_PRICING['claude-sonnet-5-5'];
    const usage = anthropicUsage({ input_tokens: 100_000, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 100_000, output_tokens: 50_000 });
    expect(usage.input_tokens).toBe(1_000_000);
    expect(usage.cached_input_tokens).toBe(800_000);
    expect(usage.cache_write_tokens).toBe(100_000);
    const expected = (100_000 * p.input + 800_000 * p.cacheRead + 100_000 * p.cacheWrite + 50_000 * p.output) / M;
    expect(priceUsage('claude-sonnet-5-5', usage)).toBeCloseTo(expected, 9);
    expect(priceUsage('claude-sonnet-5-5', usage)).toBeLessThan(priceUsage('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 50_000 }));
  });

  it('Gemini cachedContentTokenCount is carried and billed at the cache rate', () => {
    const p = MODEL_PRICING['gemini-2.5-flash'];
    const usage = geminiUsage({ promptTokenCount: 1000, candidatesTokenCount: 10, cachedContentTokenCount: 600 });
    expect(usage.cached_input_tokens).toBe(600);
    expect(priceUsage('gemini-2.5-flash', usage)).toBeCloseTo((400 * p.input + 600 * p.cacheRead + 10 * p.output) / M, 12);
  });

  it('a model with no listed cache rate bills cached tokens at the plain input rate', () => {
    const p = MODEL_PRICING['x-ai/grok-4.6'];
    expect(priceUsage('x-ai/grok-4.6', { input_tokens: 1000, cached_input_tokens: 900 })).toBeCloseTo(1000 * p.input / M, 12);
  });

  it('an image model costs its per-image price (plus listed prompt tokens), never a token guess', () => {
    expect(priceUsage('grok-imagine-image', { input_tokens: 5000 })).toBe(MODEL_PRICING['grok-imagine-image'].perImage);
    const g = MODEL_PRICING['gemini-3-pro-image-preview'];
    expect(priceUsage('gemini-3-pro-image-preview', { input_tokens: 1000 })).toBeCloseTo(g.perImage + 1000 * g.promptPerM / M, 12);
  });

  it('knows which models it cannot price', () => {
    expect(pricingKnown('claude-sonnet-5-5')).toBe(true);
    expect(pricingKnown('definitely-not-a-model')).toBe(false);
  });
});

describe('Anthropic thinking', () => {
  it('stays inside output_tokens: priced once, flagged so "thinking 0" is not read as none', () => {
    const usage = anthropicUsage({ input_tokens: 10, output_tokens: 30_674 });
    expect(usage.thinking_tokens).toBe(0);
    expect(usage.thinking_in_output).toBe(true);
    expect(priceUsage('claude-sonnet-5-5', usage)).toBeCloseTo((10 * 2 + 30_674 * 10) / M, 9);
  });
});

describe('cost ledger', () => {
  it('prices a bucket that mixes models per call, not at its first model', () => {
    const t = newTokenUsage();
    recordCall(t, 'gemini_quality', { input_tokens: M, output_tokens: 0, thinking_tokens: 0 }, 'page_quality', 'gemini-2.5-flash');
    recordCall(t, 'gemini_quality', { input_tokens: M, output_tokens: 0, thinking_tokens: 0 }, 'page_quality', 'qwen/qwen-plus');
    const expected = MODEL_PRICING['gemini-2.5-flash'].input + MODEL_PRICING['qwen/qwen-plus'].input;
    expect(t.byFunction.page_quality.cost).toBeCloseTo(expected, 9);
    expect(t.byFunction.page_quality.models.size).toBe(2);
    // the old first-model pricing would have said 2 x gemini
    expect(t.byFunction.page_quality.cost).not.toBeCloseTo(2 * MODEL_PRICING['gemini-2.5-flash'].input, 6);
  });

  it('the headline total equals the sum of the calls, including calls with no function label', () => {
    const t = newTokenUsage();
    let running = 0;
    running += recordCall(t, 'anthropic', anthropicUsage({ input_tokens: 5000, cache_read_input_tokens: 20_000, output_tokens: 8000 }), 'arc_create', 'claude-sonnet-5-5').cost;
    running += recordCall(t, 'grok', { direct_cost: 0.04 }, 'page_images', 'grok-imagine-image-2.0').cost;
    running += recordCall(t, 'gemini_text', { input_tokens: 1000, output_tokens: 100 }, null, 'gemini-2.5-flash').cost;
    expect(ledgerTotal(t)).toBeCloseTo(running, 12);
    expect(t.byFunction.unlabelled.calls).toBe(1);
  });

  it('counts the same usage object once', () => {
    const t = newTokenUsage();
    const usage = { input_tokens: 1000, output_tokens: 1000 };
    recordCall(t, 'anthropic', usage, 'a', 'claude-sonnet-5-5');
    recordCall(t, 'anthropic', usage, 'a', 'claude-sonnet-5-5');
    expect(t.byFunction.a.calls).toBe(1);
  });

  it('a cut stream is booked with what it reported and flagged', () => {
    const t = newTokenUsage();
    const r = recordCall(t, 'openrouter', { input_tokens: 20_000, output_tokens: 0, cut: true, direct_cost: 0.07 }, 'beats_brief', 'google/gemini-3.1-pro-preview');
    expect(r.cost).toBe(0.07);
    expect(t.byFunction.beats_brief.cut_calls).toBe(1);
    expect(t.openrouter.cost).toBeCloseTo(0.07, 12);
  });

  it('an unpriced call books $0 loudly and is counted', () => {
    const t = newTokenUsage();
    const r = recordCall(t, 'anthropic', { input_tokens: 10, output_tokens: 10 }, 'x', 'no-such-model');
    expect(r.unpriced).toBe(true);
    expect(t.byFunction.x.unpriced_calls).toBe(1);
    expect(ledgerTotal(t)).toBe(0);
  });

  it('cache-heavy Anthropic usage trips the spend cap at its real cost, and the cap equals the headline', () => {
    // The cap is the running sum of recordCall costs, so it equals the headline.
    const t = newTokenUsage();
    let spent = 0;
    for (let i = 0; i < 4; i++) {
      spent += recordCall(t, 'anthropic', anthropicUsage({ input_tokens: 1000, cache_creation_input_tokens: 600_000, output_tokens: 500_000 }), 'arc', 'claude-opus-5').cost;
    }
    expect(spent).toBeGreaterThan(15);
    expect(spent).toBeCloseTo(ledgerTotal(t), 9);
  });

  it('sumUsage keeps the cache subsets', () => {
    const s = sumUsage([{ input_tokens: 1, output_tokens: 1, cached_input_tokens: 5 }, { input_tokens: 1, output_tokens: 1, cache_write_tokens: 7 }]);
    expect(s.cached_input_tokens).toBe(5);
    expect(s.cache_write_tokens).toBe(7);
  });
});

describe('cut streams', () => {
  it('streamCutError books the usage the stream had reported, flagged cut, instead of dropping the call', () => {
    const { streamCutError } = require_('../../server/lib/textModels');
    const { runWithUsageSink } = require_('../../server/lib/usageContext');
    const t = newTokenUsage();
    runWithUsageSink((provider: string, usage: any, label: string, model: string) => recordCall(t, provider, usage, label, model), () => {
      const err = streamCutError({
        provider: 'anthropic', modelId: 'claude-sonnet-5-5', chars: 100, startTime: Date.now(), why: 'test',
        usage: anthropicUsage({ input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 0 }), label: 'beats_plan',
      });
      expect(err.streamCut).toBe(true);
    });
    expect(t.byFunction.beats_plan.calls).toBe(1);
    expect(t.byFunction.beats_plan.cut_calls).toBe(1);
    expect(t.byFunction.beats_plan.cost).toBeGreaterThan(0);
  });
});

describe('one price table', () => {
  const serverRoot = join(__dirname, '..', '..', 'server');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });

  it('no per-image price table or hardcoded dollar literal outside config/models.js', () => {
    const offenders: string[] = [];
    for (const file of walk(serverRoot)) {
      const rel = relative(serverRoot, file).replace(/\\/g, '/');
      if (rel === 'config/models.js') continue;
      const src = readFileSync(file, 'utf8');
      if (/GROK_IMAGE_PRICE|PROVIDER_PRICING/.test(src)) offenders.push(`${rel}: price table`);
      if (/direct_cost:\s*0\.0[1-9]\d*\b/.test(src)) offenders.push(`${rel}: hardcoded direct_cost literal`);
    }
    expect(offenders).toEqual([]);
  });

  it('storyJobPipeline has no pricer of its own', () => {
    const src = readFileSync(join(serverRoot, '..', 'storyJobPipeline.js'), 'utf8');
    expect(src).not.toMatch(/const calculateCost\s*=/);
    expect(src).not.toMatch(/PROVIDER_PRICING/);
    expect(src).not.toMatch(/MODEL_PRICING\[/);
  });

  it('grok image prices come from MODEL_PRICING', () => {
    expect(priceUsage('grok-imagine-image-pro', {})).toBe(MODEL_PRICING['grok-imagine-image-pro'].perImage);
  });
});

// The real Anthropic call paths against a stubbed fetch: what the chokepoint books.
describe('Anthropic call paths book through the ledger', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const book = (t: any) => (provider: string, usage: any, label: string, model: string) => recordCall(t, provider, usage, label, model);
  const sse = (events: any[]) => new ReadableStream({
    start(c) { const enc = new TextEncoder(); for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}

`)); c.close(); },
  });

  it('non-streaming: cache reads/writes are priced at the cache rates, thinking stays in output', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 9_000, output_tokens: 20_000 },
      }),
    })));
    const { callTextModel } = require_('../../server/lib/textModels');
    const { runWithUsageSink } = require_('../../server/lib/usageContext');
    const t = newTokenUsage();
    await runWithUsageSink(book(t), () => callTextModel('p', 1000, 'claude-sonnet', { usageLabel: 'arc_create' }));
    const b = t.byFunction.arc_create;
    const p = MODEL_PRICING['claude-sonnet-5-5'];
    expect(b.input_tokens).toBe(100_000);
    expect(b.cached_input_tokens).toBe(90_000);
    expect(b.cache_write_tokens).toBe(9_000);
    expect(b.thinking_in_output).toBe(true);
    expect(b.cost).toBeCloseTo((1000 * p.input + 90_000 * p.cacheRead + 9_000 * p.cacheWrite + 20_000 * p.output) / M, 9);
  });

  it('streaming: message_start usage (incl. cache) is kept, and a stream cut before message_stop is still booked', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: sse([
        { type: 'message_start', message: { usage: { input_tokens: 500, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 } } },
        { type: 'content_block_delta', delta: { text: 'partial' } },
      ]),
    })));
    const { callTextModelStreaming } = require_('../../server/lib/textModels');
    const { runWithUsageSink } = require_('../../server/lib/usageContext');
    const t = newTokenUsage();
    await expect(runWithUsageSink(book(t), () => callTextModelStreaming('p', 1000, () => {}, 'claude-sonnet', { usageLabel: 'beats_plan' }))).rejects.toThrow(/stream cut/);
    const b = t.byFunction.beats_plan;
    expect(b.cut_calls).toBeGreaterThanOrEqual(1);
    expect(b.cut_calls).toBe(b.calls);
    expect(b.input_tokens).toBe(b.calls * 40_500);
    expect(b.cost).toBeGreaterThan(0);
  }, 30000);
});
