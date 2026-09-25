/**
 * OPUS 5.5 AT EFFORT MAX MUST LEAVE ROOM FOR TEXT (2026-09-25).
 *
 * Lab #1421: claude-opus-5-5 at effort `max` spent all 128,000 output tokens
 * on thinking and returned no arc. budget_tokens is rejected on that model and
 * 128K is its real ceiling, so the call carries the documented advisory
 * `output_config.task_budget` (beta task-budgets-2026-03-13) below max_tokens.
 * An empty reply is a failed call that names its stop_reason.
 *
 * Pins behaviour at the fetch boundary: what the request carries, and what an
 * empty reply does.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const TM = require('../../server/lib/textModels');
const { TEXT_MODELS } = require('../../server/config/models');

const sse = (events: any[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });

function stubAnthropic(text: string, stopReason: string, outputTokens: number) {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 100 } } },
      ...(text ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text } }] : []),
      { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
    ]);
  }));
  return calls;
}

describe('Opus 5.5 task budget at effort max', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  afterEach(() => { vi.unstubAllGlobals(); process.env.ANTHROPIC_API_KEY = prev; });

  it('the model entry keeps a budget between the API minimum and the output ceiling, at max only', () => {
    const m = TEXT_MODELS['claude-opus-5-5'];
    expect(m.maxOutputTokens).toBe(128000);
    expect(Object.keys(m.taskBudgetAtEffort)).toEqual(['max']);
    expect(TM.taskBudgetFor(m, { effort: 'max' })).toBe(m.taskBudgetAtEffort.max);
    expect(m.taskBudgetAtEffort.max).toBeGreaterThanOrEqual(20000);
    expect(m.taskBudgetAtEffort.max).toBeLessThan(m.maxOutputTokens);
    expect(TM.taskBudgetFor(m, { effort: 'xhigh' })).toBeNull();
    expect(TM.taskBudgetFor(TEXT_MODELS['claude-opus'], { effort: 'max' })).toBeNull();
    expect(() => TM.taskBudgetFor({ ...m, taskBudgetAtEffort: { max: 5000 } }, { effort: 'max' })).toThrow(/20000/);
  });

  it('a max call sends effort + task_budget with the beta header, and max_tokens at the ceiling', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const calls = stubAnthropic('STORY LOGIC: ...', 'end_turn', 40000);
    const res = await TM.callTextModelStreaming('prompt', null, null, 'claude-opus-5-5', { effort: 'max', usageLabel: 'test' });
    expect(res.text).toBe('STORY LOGIC: ...');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['anthropic-beta']).toBe('task-budgets-2026-03-13');
    expect(calls[0].body.max_tokens).toBe(128000);
    expect(calls[0].body.output_config).toEqual({ effort: 'max', task_budget: { type: 'tokens', total: TEXT_MODELS['claude-opus-5-5'].taskBudgetAtEffort.max } });
    expect(calls[0].body.thinking).toBeUndefined();
  });

  it('other efforts and other models send no budget and no beta header', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const calls = stubAnthropic('ok', 'end_turn', 10);
    await TM.callTextModelStreaming('prompt', null, null, 'claude-opus-5-5', { effort: 'xhigh', usageLabel: 'test' });
    await TM.callTextModelStreaming('prompt', null, null, 'claude-opus', { effort: 'max', usageLabel: 'test' });
    for (const c of calls) {
      expect(c.headers['anthropic-beta']).toBeUndefined();
      expect(c.body.output_config.task_budget).toBeUndefined();
    }
  });

  it('a reply with no text fails loudly with its stop_reason, once — never an empty answer', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const calls = stubAnthropic('', 'max_tokens', 128000);
    const err: any = await TM.callTextModelStreaming('prompt', null, null, 'claude-opus-5-5', { effort: 'max', usageLabel: 'test' }).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/returned no text: stop_reason=max_tokens, 128000 output tokens/);
    expect(err.stopReason).toBe('max_tokens');
    // Not retried inside the call: a retry would burn the same budget again.
    expect(calls).toHaveLength(1);
  });

  it('the non-streaming path reads the text blocks past a thinking block, and fails the same way on none', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const reply = (content: any[], stop: string) => vi.fn(async () => new Response(JSON.stringify({
      content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 128000 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', reply([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'ARC:' }], 'end_turn'));
    expect((await TM.callTextModel('p', null, 'claude-opus-5-5', { effort: 'max' })).text).toBe('ARC:');
    vi.stubGlobal('fetch', reply([{ type: 'thinking', thinking: '' }], 'max_tokens'));
    await expect(TM.callTextModel('p', null, 'claude-opus-5-5', { effort: 'max' })).rejects.toThrow(/stop_reason=max_tokens/);
  });
});
