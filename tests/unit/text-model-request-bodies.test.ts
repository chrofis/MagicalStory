/**
 * EVERY PROVIDER PATH CARRIES temperature AND cachePrefix (review 2026-10-04 C1/C2/C6).
 *
 * The 2026-08-07 temperature-0 pin landed only on the xAI streaming body, so the
 * default qwen compliance judge and consolidator (OpenRouter) ran at the provider
 * default (~1.0). cachePrefix (the consolidator's whole rules template) was
 * dropped on Gemini and xAI. A Gemini empty/blocked reply used to swap silently
 * to Grok / flash-lite and book the answer under the wrong model.
 *
 * Pinned at the fetch boundary.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const TM = require('../../server/lib/textModels');

const sse = (text: string) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: {} })}\n\ndata: [DONE]\n\n`,
  { status: 200 });
const geminiSse = (text: string) => new Response(
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: {} })}\n\n`,
  { status: 200 });
const json = (o: any) => new Response(JSON.stringify(o), { status: 200 });
const xaiReply = () => json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} });
const geminiReply = (text: string) => json({ candidates: [{ content: { parts: text ? [{ text }] : [] }, finishReason: 'STOP' }], usageMetadata: {} });
const anthropicSse = () => new Response(
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`, { status: 200 });

function stubFetch(handler: (url: string, body: any) => Response) {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return handler(String(url), body);
  }));
  return calls;
}

describe('text-model request bodies', () => {
  const env = { ...process.env };
  afterEach(() => { vi.unstubAllGlobals(); process.env = { ...env }; });

  it('OpenRouter: temperature 0 is sent (a falsy 0 must not be dropped); absent → not sent', async () => {
    process.env.OPENROUTER_API_KEY = 'test';
    process.env.OPENROUTER_PROVIDER_SORT = 'off';
    const calls = stubFetch(() => sse('ok'));
    await TM.callOpenRouterAPI('p', 100, 'qwen/qwen-plus', { temperature: 0 });
    await TM.callOpenRouterAPI('p', 100, 'qwen/qwen-plus', {});
    expect(calls[0].body.temperature).toBe(0);
    expect('temperature' in calls[1].body).toBe(false);
  });

  it('xAI non-streaming: temperature 0 is sent', async () => {
    process.env.XAI_API_KEY = 'test';
    const calls = stubFetch(() => xaiReply());
    await TM.callXaiAPI('p', 100, 'grok-4.3', { temperature: 0 });
    expect(calls[0].body.temperature).toBe(0);
  });

  it('xAI streaming: temperature 0 is sent', async () => {
    process.env.XAI_API_KEY = 'test';
    const calls = stubFetch(() => sse('ok'));
    await TM.callXaiAPIStreaming('p', 100, 'grok-4.3', null, { temperature: 0 });
    expect(calls[0].body.temperature).toBe(0);
  });

  it('Gemini (both entry points): temperature 0 is sent', async () => {
    process.env.GEMINI_API_KEY = 'test';
    const calls = stubFetch((url) => url.includes('streamGenerateContent') ? geminiSse('ok') : geminiReply('ok'));
    await TM.callGeminiTextAPI('p', 100, 'gemini-2.5-flash', { temperature: 0 });
    await TM.callGeminiTextAPIStreaming('p', 100, 'gemini-2.5-flash', null, { temperature: 0 });
    expect(calls[0].body.generationConfig.temperature).toBe(0);
    expect(calls[1].body.generationConfig.temperature).toBe(0);
  });

  it('cachePrefix reaches the model on every non-Anthropic path, ahead of the prompt', async () => {
    process.env.GEMINI_API_KEY = 'test';
    process.env.XAI_API_KEY = 'test';
    process.env.OPENROUTER_API_KEY = 'test';
    process.env.OPENROUTER_PROVIDER_SORT = 'off';
    const opts = { cachePrefix: 'RULES|' };
    const calls = stubFetch((url) => url.includes('streamGenerateContent') ? geminiSse('ok')
      : url.includes('generativelanguage') ? geminiReply('ok')
      : url.includes('openrouter') ? sse('ok')
      : (url.includes('api.x.ai') ? xaiReply() : sse('ok')));
    await TM.callGeminiTextAPI('INPUT', 100, 'gemini-2.5-flash', opts);
    await TM.callGeminiTextAPIStreaming('INPUT', 100, 'gemini-2.5-flash', null, opts);
    await TM.callXaiAPI('INPUT', 100, 'grok-4.3', opts);
    await TM.callXaiAPIStreaming('INPUT', 100, 'grok-4.3', null, opts);
    await TM.callOpenRouterAPI('INPUT', 100, 'qwen/qwen-plus', opts);
    const texts = [
      calls[0].body.contents[0].parts.at(-1).text,
      calls[1].body.contents[0].parts[0].text,
      calls[2].body.messages[0].content,
      calls[3].body.messages[0].content,
      calls[4].body.messages[0].content,
    ];
    for (const t of texts) expect(t).toBe('RULES|INPUT');
  });

  it('Anthropic streaming: cachePrefix rides as its own cache_control block', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const calls = stubFetch(() => anthropicSse());
    await TM.callAnthropicAPIStreaming('INPUT', 100, 'claude-haiku-4-5-20251001', null, { cachePrefix: 'RULES|' }).catch(() => {});
    expect(calls[0].body.messages[0].content).toEqual([
      { type: 'text', text: 'RULES|', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'INPUT' },
    ]);
  });

  it('Gemini empty reply throws and never swaps to another model', async () => {
    process.env.GEMINI_API_KEY = 'test';
    process.env.XAI_API_KEY = 'test';
    const calls = stubFetch(() => geminiReply(''));
    await expect(TM.callGeminiTextAPI('p', 100, 'gemini-2.5-flash', {})).rejects.toThrow(/No text in Gemini response/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('gemini-2.5-flash:');
  });
});
