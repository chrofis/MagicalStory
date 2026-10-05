/**
 * A text stream that ends without its provider's completion signal is a failed
 * call that the transport retries, never a short reply (staging
 * job_1791145238223_50osg2osm: two cut page-brief streams were accepted as
 * successes; docs/decisions.md 2026-10-05).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const textModels = nodeRequire('../../server/lib/textModels.js');
const { log } = nodeRequire('../../server/utils/logger.js');

const sse = (events: any[], done = false) =>
  new Response(new ReadableStream({
    start(c) {
      const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

interface Provider {
  name: string;
  call: () => Promise<any>;
  cut: () => Response;          // some text, then the body just ends
  errorEvent: () => Response;   // some text, then an SSE error event
  normal: () => Response;       // text + the provider's own completion signal
}

const oai = (tag: string) => ({
  cut: () => sse([{ choices: [{ delta: { content: 'half a repl' } }] }]),
  errorEvent: () => sse([{ choices: [{ delta: { content: 'half' } }] }, { error: { code: 502, message: 'upstream died' }, choices: [{ finish_reason: 'error', delta: { content: '' } }] }]),
  normal: () => sse([
    { provider: tag, choices: [{ delta: { content: 'whole reply' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ], true),
});

const providers: Provider[] = [
  { name: 'openrouter', call: () => textModels.callOpenRouterAPI('p', 100, 'google/gemini-3.1-pro-preview', {}), ...oai('Google') },
  { name: 'xai', call: () => textModels.callXaiAPIStreaming('p', 100, 'grok-4', null, {}), ...oai('xAI') },
  {
    name: 'gemini',
    call: () => textModels.callGeminiTextAPIStreaming('p', 100, 'gemini-3.1-pro', null, {}),
    cut: () => sse([{ candidates: [{ content: { parts: [{ text: 'half a repl' }] } }], usageMetadata: { promptTokenCount: 3 } }]),
    errorEvent: () => sse([{ candidates: [{ content: { parts: [{ text: 'half' }] } }] }, { error: { code: 503, message: 'overloaded' } }]),
    normal: () => sse([
      { candidates: [{ content: { parts: [{ text: 'whole reply' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } },
    ]),
  },
  {
    name: 'anthropic',
    call: () => textModels.callAnthropicAPIStreaming('p', 100, 'claude-sonnet-4-5', null, {}),
    cut: () => sse([{ type: 'message_start', message: { usage: { input_tokens: 3 } } }, { type: 'content_block_delta', delta: { text: 'half a repl' } }]),
    errorEvent: () => sse([{ type: 'content_block_delta', delta: { text: 'half' } }, { type: 'error', error: { type: 'overloaded_error' } }]),
    normal: () => sse([
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_delta', delta: { text: 'whole reply' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]),
  },
];

describe.each(providers)('$name stream completion', (p: Provider) => {
  const env = { ...process.env };
  let errors: string[];
  beforeEach(() => {
    Object.assign(process.env, { OPENROUTER_API_KEY: 't', XAI_API_KEY: 't', GEMINI_API_KEY: 't', ANTHROPIC_API_KEY: 't', OPENROUTER_PROVIDER_SORT: 'off' });
    errors = [];
    vi.spyOn(log, 'error').mockImplementation((...a: any[]) => { errors.push(a.join(' ')); });
    // withRetry's backoff (<= ~33 s) runs at once; inactivity (120 s) and max timers stay real.
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...a: any[]) =>
      real(fn, ms !== undefined && ms < 60000 ? 0 : ms, ...a)) as any);
  });
  afterEach(() => { process.env = { ...env }; vi.restoreAllMocks(); });

  it('a body that ends without the completion signal is retried, and throws once retries are spent', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => p.cut());
    await expect(p.call()).rejects.toMatchObject({ streamCut: true });
    expect(f).toHaveBeenCalledTimes(3);
    expect(errors.join('\n')).toMatch(/CUT: .*provider=.* model=.* chars=11 elapsedMs=\d+/);
  });

  it('a cut first attempt is re-sent and the second, complete reply is returned', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => p.cut()).mockImplementation(async () => p.normal());
    const res = await p.call();
    expect(f).toHaveBeenCalledTimes(2);
    expect(res.text).toBe('whole reply');
  });

  it('an SSE error event throws instead of returning the text so far', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => p.errorEvent());
    await expect(p.call()).rejects.toThrow();
  });

  it('a normal stream is unchanged', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => p.normal());
    const res = await p.call();
    expect(f).toHaveBeenCalledTimes(1);
    expect(res.text).toBe('whole reply');
    expect(errors).toEqual([]);
  });
});
