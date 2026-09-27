/**
 * IMAGE INPUTS REACH THE MODEL, OR THE CALL FAILS (2026-09-27).
 *
 * callGeminiTextAPI dropped options.images with a warning and answered blind;
 * the char-fix face gate (repairFaceCheck = gemini-2.5-flash) judged "is the
 * face intact" on no image for twelve days (Lab #1569: "Facundo's face … is a
 * blank area"). xAI and the streaming entry points dropped images silently.
 *
 * Pinned at the fetch boundary: what the request body carries.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const TM = require('../../server/lib/textModels');

// Real magic bytes, so the MIME sniff has something to recognise.
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 1, 2, 3]);
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 9, 9]);
const PNG_URI = `data:image/png;base64,${PNG.toString('base64')}`;
const JPEG_B64 = JPEG.toString('base64');

const json = (o: any) => new Response(JSON.stringify(o), { status: 200 });
const geminiReply = (text: string) => json({ candidates: [{ content: { parts: text ? [{ text }] : [] }, finishReason: 'STOP' }], usageMetadata: {} });
const xaiReply = (text: string) => json({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: {} });

function stubFetch(handler: (url: string, body: any) => Response) {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    if (!init || !init.body) {
      // An image URL being fetched for inlining.
      calls.push({ url, kind: 'image-fetch' });
      return new Response(JPEG, { status: 200 });
    }
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return handler(url, body);
  }));
  return calls;
}

describe('text-model image inputs', () => {
  const env = { ...process.env };
  afterEach(() => { vi.unstubAllGlobals(); process.env = { ...env }; });

  it('Gemini: every image goes as inline_data ahead of the text, with its real MIME type', async () => {
    process.env.GEMINI_API_KEY = 'test';
    const calls = stubFetch(() => geminiReply('{"intact": true}'));
    const res = await TM.callGeminiTextAPI('compare A and B', 100, 'gemini-2.5-flash', { images: [PNG_URI, JPEG_B64] });
    expect(res.text).toBe('{"intact": true}');
    const parts = calls[0].body.contents[0].parts;
    expect(parts).toEqual([
      { inline_data: { mime_type: 'image/png', data: PNG.toString('base64') } },
      { inline_data: { mime_type: 'image/jpeg', data: JPEG_B64 } },
      { text: 'compare A and B' },
    ]);
  });

  it('Gemini: an http(s) image is fetched and inlined as bytes', async () => {
    process.env.GEMINI_API_KEY = 'test';
    const calls = stubFetch(() => geminiReply('ok'));
    await TM.callGeminiTextAPI('p', 100, 'gemini-2.5-flash', { images: ['https://example.test/page.jpg'] });
    expect(calls[0]).toEqual({ url: 'https://example.test/page.jpg', kind: 'image-fetch' });
    expect(calls[1].body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: JPEG_B64 } });
  });

  it('the face gate route (callTextModel → repairFaceCheck model) sends both images', async () => {
    process.env.GEMINI_API_KEY = 'test';
    const { MODEL_DEFAULTS, TEXT_MODELS } = require('../../server/config/models');
    expect(TEXT_MODELS[MODEL_DEFAULTS.repairFaceCheck].provider).toBe('google');
    const calls = stubFetch(() => geminiReply('{"intact": false, "reason": "smeared"}'));
    await TM.callTextModel('is the face intact', null, MODEL_DEFAULTS.repairFaceCheck, { images: [PNG_URI, JPEG_B64], usageLabel: 'repair_face_check' });
    const parts = calls[0].body.contents[0].parts;
    expect(parts.filter((p: any) => p.inline_data)).toHaveLength(2);
  });

  it('Gemini empty reply → the Grok fallback carries the images too', async () => {
    process.env.GEMINI_API_KEY = 'test';
    process.env.XAI_API_KEY = 'test';
    const calls = stubFetch((url) => url.includes('api.x.ai') ? xaiReply('seen') : geminiReply(''));
    const res = await TM.callGeminiTextAPI('p', 100, 'gemini-2.5-flash', { images: [PNG_URI] });
    expect(res.text).toBe('seen');
    const xai = calls.find(c => String(c.url).includes('api.x.ai'));
    expect(xai.body.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: PNG_URI } },
      { type: 'text', text: 'p' },
    ]);
  });

  it('xAI: images go as image_url parts', async () => {
    process.env.XAI_API_KEY = 'test';
    const calls = stubFetch(() => xaiReply('ok'));
    await TM.callXaiAPI('p', 100, 'grok-4.3', { images: [JPEG_B64] });
    expect(calls[0].body.messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` } });
  });

  it('Anthropic: images carry the sniffed MIME type, not a guessed jpeg', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const calls = stubFetch(() => json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }));
    await TM.callAnthropicAPI('p', 100, 'claude-haiku-4-5-20251001', { images: [PNG.toString('base64')] });
    expect(calls[0].body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
  });

  it('text-only calls are unchanged: one text part, no image fetch', async () => {
    process.env.GEMINI_API_KEY = 'test';
    const calls = stubFetch(() => geminiReply('ok'));
    await TM.callGeminiTextAPI('p', 100, 'gemini-2.5-flash', {});
    expect(calls).toHaveLength(1);
    expect(calls[0].body.contents[0].parts).toEqual([{ text: 'p' }]);
  });

  it('an unusable image input fails the call — it is never dropped', async () => {
    process.env.GEMINI_API_KEY = 'test';
    const calls = stubFetch(() => geminiReply('ok'));
    await expect(TM.callGeminiTextAPI('p', 100, 'gemini-2.5-flash', { images: ['magicalstory://curated/x'] })).rejects.toThrow(/unsupported image reference/);
    await expect(TM.callGeminiTextAPI('p', 100, 'gemini-2.5-flash', { images: [Buffer.from('not an image at all').toString('base64')] })).rejects.toThrow(/not a JPEG\/PNG\/GIF\/WebP/);
    await expect(TM.callGeminiTextAPI('p', 100, 'gemini-2.5-flash', { images: [null] })).rejects.toThrow(/image input is object/);
    expect(calls).toHaveLength(0);
  });

  it('entry points that cannot carry images refuse them loudly', async () => {
    process.env.GEMINI_API_KEY = 'test';
    process.env.XAI_API_KEY = 'test';
    process.env.ANTHROPIC_API_KEY = 'test';
    const calls = stubFetch(() => geminiReply('ok'));
    const opts = { images: [PNG_URI] };
    await expect(TM.callGeminiTextAPIStreaming('p', 100, 'gemini-2.5-flash', null, opts)).rejects.toThrow(/cannot send image inputs/);
    await expect(TM.callXaiAPIStreaming('p', 100, 'grok-4.3', null, opts)).rejects.toThrow(/cannot send image inputs/);
    await expect(TM.callAnthropicAPIStreaming('p', 100, 'claude-haiku-4-5-20251001', null, opts)).rejects.toThrow(/cannot send image inputs/);
    expect(calls).toHaveLength(0);
  });
});
