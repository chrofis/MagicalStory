/**
 * The Grok→Gemini image fallback stays (owner, 2026-09-24), but the Grok error
 * is a generationLog event, not only a console line — and a Gemini fallback
 * that then fails throws an error carrying BOTH errors, Grok's first.
 *
 * Why: staging job_1790277448294_5herh01j7 lost its front cover and initial
 * page. Grok failed on the plates, Gemini refused with IMAGE_OTHER, and only
 * the refusal was stored — the real cause was invisible.
 *
 * Only the network boundary is stubbed (Grok's image calls, Gemini's REST call,
 * the scene-rewrite text model). No paid call is made.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// images.js destructures grok's exports at load — stub BEFORE requiring it.
const grok = require_('../../server/lib/grok');
const GROK_ERROR = 'Grok edit failed (500): upstream exploded (test)';
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [];
grok.generateWithGrok = async () => { throw new Error(GROK_ERROR); };
grok.editWithGrok = async () => { throw new Error(GROK_ERROR); };

const images = require_('../../server/lib/images');
const textModels = require_('../../server/lib/textModels');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const { GenerationLogger, setCurrentLogger, clearCurrentLogger } = require_('../../server/lib/generationLogger');

const realFetch = global.fetch;
const realCallTextModel = textModels.callTextModel;
let genLog: any;

const refusal = () => ({
  ok: true,
  json: async () => ({
    candidates: [{ finishReason: 'IMAGE_OTHER', content: { parts: [{ text: '' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
  }),
});

const fallbackEvents = () => genLog.entries.filter((e: any) => e.event === 'image_provider_fallback');

beforeAll(async () => { await loadPromptTemplates(); });

beforeEach(() => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  global.fetch = (async () => refusal()) as any;
  textModels.callTextModel = async () => ({ text: 'REWRITTEN SCENE.', usage: {} });
  genLog = new GenerationLogger();
  setCurrentLogger(genLog);
});

afterEach(() => {
  clearCurrentLogger();
  global.fetch = realFetch;
  textModels.callTextModel = realCallTextModel;
  images.clearImageCache?.();
});

describe('Grok→Gemini fallback records the Grok error', () => {
  it('generateImageOnly (plate / page path): warn event with Grok error, page and model; thrown error carries both', async () => {
    let thrown: any;
    try {
      await images.generateImageOnly('**THIS IMAGE DEPICTS:** An empty meadow at dawn.', [], {
        imageBackendOverride: 'grok', pageNumber: 3, skipCache: true, stripBorder: false,
      });
    } catch (e) { thrown = e; }

    // The default page model is itself a Grok tier, so the ladder tries Grok
    // twice (primary, then model-routed) before Gemini — both are recorded.
    const events = fallbackEvents();
    expect(events.map((e: any) => e.details.route)).toEqual(['primary', 'model-routed']);
    expect(events[0].level).toBe('warn');
    expect(events[0].message).toContain(GROK_ERROR);
    expect(events[0].message).toContain('page 3');
    expect(events[0].details.provider).toBe('grok');
    expect(events[0].details.model).toMatch(/grok/);
    expect(events[0].message).toContain(events[0].details.model);

    expect(thrown).toBeTruthy();
    const grokAt = thrown.message.indexOf(GROK_ERROR);
    const geminiAt = thrown.message.indexOf('IMAGE_OTHER');
    expect(grokAt).toBeGreaterThanOrEqual(0);
    expect(geminiAt).toBeGreaterThan(grokAt);
  }, 30000);

  it('callGeminiAPIForImage (eval path): same event and combined error', async () => {
    let thrown: any;
    try {
      await images.callGeminiAPIForImage('**THIS IMAGE DEPICTS:** A quiet harbour.', [], null, 'scene', null, null, null, 'PAGE 5', 'grok');
    } catch (e) { thrown = e; }

    const events = fallbackEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].message).toContain(GROK_ERROR);
    expect(events[0].message).toContain('page 5');
    expect(thrown?.message).toContain(GROK_ERROR);
    expect(thrown?.message).toMatch(/Gemini fallback failed/);
  }, 30000);

  it('editImageWithPrompt: Grok edit failure is logged and prefixed onto the Gemini error', async () => {
    global.fetch = (async () => ({ ok: false, status: 503, text: async () => 'unavailable' })) as any;
    const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let thrown: any;
    try { await images.editImageWithPrompt(img, 'make the sky orange', 'grok-imagine'); } catch (e) { thrown = e; }

    const events = fallbackEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain(GROK_ERROR);
    expect(thrown?.message).toContain(GROK_ERROR);
    expect(thrown?.message).toContain('Gemini API error: 503');
  }, 30000);

  it('no Grok failure → no fallback event, Gemini error unchanged', async () => {
    let thrown: any;
    try {
      await images.generateImageOnly('**THIS IMAGE DEPICTS:** A lake.', [], {
        imageBackendOverride: 'gemini', imageModelOverride: 'gemini-2.5-flash-image', pageNumber: 1, skipCache: true, stripBorder: false,
      });
    } catch (e) { thrown = e; }
    expect(fallbackEvents()).toHaveLength(0);
    expect(thrown?.message).not.toMatch(/Gemini fallback failed/);
  }, 30000);
});
