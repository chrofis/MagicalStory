import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// NO PROMPT OVER THE CAP LEAVES THIS MACHINE (2026-09-30).
//
// The page, cover and plate paths fit their prompts before calling Grok, but
// ~20 other callers (face/character repair, inpaint, avatars, style edit, the
// composite blend) sent whatever they built. Grok answered 400 above its cap (8,000
// chars then; 16,000 / 64,000 bytes since 2026-10-04) and the caller read it as a provider failure — editImageWithPrompt
// retried it as "content moderation" and fell back to Gemini. The send points
// themselves now refuse an over-cap prompt with a PromptFitError, before any
// request is made.

let sharp: any;
let grok: any;
let IMAGE_MODELS: any;

async function jpeg(): Promise<string> {
  const buf = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 90, b: 160 } },
  }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function mockGrok() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ b64_json: (await jpeg()).split(',')[1] }] }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(async () => {
  // Read at module load — must be set before the import.
  process.env.XAI_API_KEY = 'test-key-not-a-real-credential';
  sharp = (await import('sharp')).default;
  // @ts-expect-error - JS module without types
  grok = await import('../../server/lib/grok.js');
  // @ts-expect-error - JS module without types
  ({ IMAGE_MODELS } = await import('../../server/config/models.js'));
});

afterEach(() => { vi.unstubAllGlobals(); });

const capOf = (modelId: string) =>
  (Object.values(IMAGE_MODELS).find((m: any) => m.backend === 'grok' && m.modelId === modelId) as any)
    .maxPromptLength;

describe('Grok send points refuse an over-cap prompt', () => {
  it('generateWithGrok: one char over the cap throws PromptFitError and sends nothing', async () => {
    const fetchMock = mockGrok();
    const model = grok.GROK_MODELS.STANDARD;
    await expect(grok.generateWithGrok('x'.repeat(capOf(model) + 1), { model }))
      .rejects.toMatchObject({ name: 'PromptFitError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('editWithGrok: one char over the cap throws PromptFitError and sends nothing', async () => {
    const fetchMock = mockGrok();
    const model = grok.GROK_MODELS.STANDARD;
    await expect(grok.editWithGrok('x'.repeat(capOf(model) + 1), [await jpeg()], { model }))
      .rejects.toMatchObject({ name: 'PromptFitError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('coverComposite.callGrokEdit: one char over the cap throws PromptFitError and sends nothing', async () => {
    const fetchMock = mockGrok();
    // @ts-expect-error - JS module without types
    const { callGrokEdit } = await import('../../server/lib/coverComposite.js');
    const model = grok.GROK_MODELS.STANDARD;
    const img = Buffer.from((await jpeg()).split(',')[1], 'base64');
    await expect(callGrokEdit('x'.repeat(capOf(model) + 1), img, { model }))
      .rejects.toMatchObject({ name: 'PromptFitError' });
    expect(fetchMock).not.toHaveBeenCalled();
    await callGrokEdit('x'.repeat(capOf(model)), img, { model });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a prompt exactly at the cap is sent, for every Grok tier', async () => {
    for (const model of [grok.GROK_MODELS.STANDARD, grok.GROK_MODELS.IMAGE_2, grok.GROK_MODELS.PRO]) {
      const fetchMock = mockGrok();
      await grok.generateWithGrok('x'.repeat(capOf(model)), { model });
      expect(fetchMock, model).toHaveBeenCalledTimes(1);
      const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body).prompt;
      expect(sent.length, model).toBeLessThanOrEqual(capOf(model));
    }
  });

  // xAI's real max_prompt_length per model, UTF-8 bytes (verified live
  // 2026-10-04; it was 8,000 for all of them until mid-2026).
  const XAI_LIMITS: Record<string, number> = {
    'grok-imagine-image': 16000,
    'grok-imagine-image-pro': 16000,
    'grok-imagine-image-2.0': 64000,
  };

  it("the cap is under xAI's real API limit for every tier", () => {
    const grokTiers = (Object.values(IMAGE_MODELS) as any[]).filter(m => m.backend === 'grok');
    expect(grokTiers.length).toBeGreaterThan(0);
    for (const m of grokTiers) {
      expect(XAI_LIMITS[m.modelId], `${m.modelId} has a known xAI limit`).toBeTypeOf('number');
      expect(m.maxPromptLength, m.modelId).toBeLessThanOrEqual(XAI_LIMITS[m.modelId]);
    }
  });

  it('the cap counts UTF-8 bytes: under the cap in chars but over in bytes throws PromptFitError and sends nothing', async () => {
    const fetchMock = mockGrok();
    const model = grok.GROK_MODELS.STANDARD;
    const prompt = 'ü'.repeat(Math.floor(capOf(model) / 2) + 1); // 2 bytes each: over in bytes, under in chars
    expect(prompt.length).toBeLessThanOrEqual(capOf(model));
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(capOf(model));
    await expect(grok.generateWithGrok(prompt, { model }))
      .rejects.toMatchObject({ name: 'PromptFitError' });
    expect(fetchMock).not.toHaveBeenCalled();
    // Exactly at the cap in bytes is sent.
    await grok.generateWithGrok('ü'.repeat(Math.floor(capOf(model) / 2)), { model });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
