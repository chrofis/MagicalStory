/**
 * The [OPENROUTER STREAM] line says why the model stopped and who served it.
 *
 * An empty or cut reply was undiagnosable after the fact: the line carried the
 * upstream but neither `finish_reason` nor `native_finish_reason`, and the
 * empty-reply error named no reason at all (assessTextReply checks emptiness
 * before the stop reason). Both now carry all three, on the streaming path and
 * on callOpenRouterAPI, which delegates to it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const textModels = nodeRequire('../../server/lib/textModels.js');
const { log } = nodeRequire('../../server/utils/logger.js');

function sseResponse(events: any[]) {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('OpenRouter stream log line and reply carry the stop reasons', () => {
  const env = { ...process.env };
  let infos: string[];
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test';
    process.env.OPENROUTER_PROVIDER_SORT = 'off';
    infos = [];
    vi.spyOn(log, 'info').mockImplementation((...a: any[]) => { infos.push(a.join(' ')); });
  });
  afterEach(() => { process.env = { ...env }; vi.restoreAllMocks(); });

  it('an empty reply: the line names finish_reason, native_finish_reason and the upstream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([
      { provider: 'DeepInfra', choices: [{ delta: { content: '' } }] },
      { provider: 'DeepInfra', choices: [{ delta: {}, finish_reason: 'stop', native_finish_reason: 'end_turn' }] },
      { provider: 'DeepInfra', choices: [], usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 } },
    ]));
    const res = await textModels.callOpenRouterAPI('hello', 1000, 'deepseek/deepseek-v4-pro', {});
    const line = infos.find(l => l.includes('[OPENROUTER STREAM]'));
    expect(line).toMatch(/via DeepInfra/);
    expect(line).toMatch(/finish_reason=stop, native_finish_reason=end_turn/);
    expect(res).toMatchObject({ stop_reason: 'stop', native_finish_reason: 'end_turn', provider: 'DeepInfra' });
    const verdict = textModels.assessTextReply(res, { capInForce: 1000 });
    expect(textModels.describeTruncation(verdict))
      .toBe('returned an EMPTY response (0 output tokens) [finish_reason=stop, native_finish_reason=end_turn, provider=DeepInfra]');
  });

  it('no reason reported: the line says none rather than omitting it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([
      { provider: 'Novita', choices: [{ delta: { content: 'partial' } }] },
    ]));
    await textModels.callOpenRouterAPI('hello', 1000, 'deepseek/deepseek-v4-pro', {});
    expect(infos.find(l => l.includes('[OPENROUTER STREAM]'))).toMatch(/finish_reason=none, native_finish_reason=none/);
  });
});
