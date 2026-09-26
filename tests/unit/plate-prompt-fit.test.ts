/**
 * A plate prompt is fitted by its own cut order against the full cap (a plate
 * carries no magenta prefix since 2026-09-26: its landmark photo is
 * centre-cropped), and a prompt that cannot fit is OUR bug: it fails loudly and
 * never falls back to Gemini (owner, 2026-09-25).
 *
 * Staging job_1790277448294_5herh01j7: the p1/p11 landmark plate prompts (7,552
 * and 7,463 chars) went over the Grok cap once editWithGrok prepended the
 * 612-char magenta prefix; sectionAwareCut read the whole plate prompt as its
 * protected tail (it opens with **ART STYLE:**) and refused to cut; the dispatcher
 * caught that as a Grok failure and Gemini painted a photographic plate.
 *
 * Only the network boundary is stubbed. No paid call is made.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

const grok = require_('../../server/lib/grok');
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let sentPrompts: string[] = [];
let editImpl: (p: string) => Promise<any>;
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [PX];
grok.generateWithGrok = async () => { throw new Error('generate not expected'); };
grok.editWithGrok = async (p: string) => editImpl(p);

const images = require_('../../server/lib/images');
const { PromptFitError } = require_('../../server/lib/promptFitError');
const { emptyScenePlateRouting } = require_('../../server/config/models');
const { loadPromptTemplates, buildEmptyScenePrompt } = require_('../../server/services/prompts');
const { GenerationLogger, setCurrentLogger, clearCurrentLogger } = require_('../../server/lib/generationLogger');

const CAP = 7900;
// The magenta-extension prefix a padded plate used to carry (616 chars).
const OLD_PREFIX = 616;
const realFetch = global.fetch;
let genLog: any;
let fetchCalls = 0;

const LANDMARK_BLOCK = `**LANDMARK IN THIS SCENE: The Old Bridge.** The attached reference photo shows this exact real-world landmark.

**IDENTITY (from the photo):** Preserve the silhouette.

**MEDIUM (never from the photo):** The photo supplies geometry and nothing else.

**CONDITIONS (from the scene):** Camera angle and light come from the scene.`;

const platePrompt = (descriptionChars: number, shot = 'wide') => buildEmptyScenePrompt({
  style: 'A soft watercolor painting with visible brushstrokes.',
  description: `**SHOT:** ${shot}\n\n${'A quiet stone bridge over a slow river. '.repeat(Math.ceil(descriptionChars / 40)).slice(0, descriptionChars)}`,
  landmarkFidelity: LANDMARK_BLOCK,
  referenceKind: 'landmark',
});

beforeAll(async () => { await loadPromptTemplates(); });

beforeEach(() => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  fetchCalls = 0;
  global.fetch = (async () => { fetchCalls++; return { ok: false, status: 500, text: async () => 'gemini must not be called' }; }) as any;
  sentPrompts = [];
  editImpl = async (p: string) => { sentPrompts.push(p); return { imageData: PX, modelId: 'grok-imagine-image', usage: {} }; };
  genLog = new GenerationLogger();
  setCurrentLogger(genLog);
});

afterEach(() => {
  clearCurrentLogger();
  global.fetch = realFetch;
  images.clearImageCache?.();
});

const renderPlate = (prompt: string) => images.generateImageOnly(prompt, [], {
  ...emptyScenePlateRouting(),
  landmarkPhotos: [{ name: 'The Old Bridge', photoData: PX }],
  pageNumber: 1, skipCache: true, stripBorder: false,
});

describe('fitPlatePrompt', () => {
  it('returns a prompt that fits untouched', () => {
    const p = platePrompt(1000);
    expect(images.fitPlatePrompt(p, CAP, 'T')).toBe(p);
  });

  it('drops only cut-order text: the landmark photo note, then the over-the-shoulder line', () => {
    const p = platePrompt(1000);
    const note = p.split(/\n{2,}/).find((x: string) => x.startsWith('**ABOUT THE LANDMARK REFERENCE PHOTO'))!;
    const out = images.fitPlatePrompt(p, p.length - 10, 'T');
    expect(out).not.toContain(note);
    expect(p.length - out.length).toBeLessThanOrEqual(note.length + 4);
    for (const keep of ['**ART STYLE:**', '**SHOT:** wide', '**IDENTITY (from the photo):**', '**MEDIUM (never from the photo):**', '**LANDMARK IN THIS SCENE:', '**REFERENCE:**']) {
      expect(out).toContain(keep);
    }
  });

  it('keeps the over-the-shoulder line on an over-the-shoulder plate', () => {
    const p = platePrompt(1000, 'over-the-shoulder');
    const out = images.fitPlatePrompt(p, p.length - 300, 'T');
    expect(out).not.toContain('**ABOUT THE LANDMARK REFERENCE PHOTO');
    expect(out).toContain('For `over-the-shoulder` framing');
  });

  it('keeps the landmark photo note when no named landmark block carries its rules', () => {
    const p = buildEmptyScenePrompt({ style: 'Watercolor.', description: `**SHOT:** wide\n\n${'x'.repeat(2000)}` });
    expect(() => images.fitPlatePrompt(p, p.length - 200, 'T')).toThrow(PromptFitError);
  });

  it('throws PromptFitError, never a blunt cut, when the must-keep text alone is over', () => {
    const p = platePrompt(9000);
    expect(() => images.fitPlatePrompt(p, CAP, 'T')).toThrow(PromptFitError);
  });
});

describe('the dispatcher fits a plate against the full cap', () => {
  it('a landmark plate between cap-616 and cap is sent untouched, with no prefix', async () => {
    let p = platePrompt(100);
    p = platePrompt(100 + (CAP - OLD_PREFIX + 50 - p.length));
    expect(p.length).toBeGreaterThan(CAP - OLD_PREFIX);
    expect(p.length).toBeLessThan(CAP);
    await renderPlate(p);
    expect(sentPrompts).toEqual([p]);
    expect(genLog.entries.some((e: any) => e.event === 'image_provider_fallback')).toBe(false);
  }, 30000);

  it('a landmark plate over the cap is fitted to <= cap by the plate cut order', async () => {
    let p = platePrompt(100);
    p = platePrompt(100 + (CAP + 50 - p.length));
    expect(p.length).toBeGreaterThan(CAP);
    await renderPlate(p);
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0].length).toBeLessThanOrEqual(CAP);
    expect(sentPrompts[0]).toContain('**ART STYLE:**');
    expect(sentPrompts[0]).not.toContain('**ABOUT THE LANDMARK REFERENCE PHOTO');
  }, 30000);
});

describe('a prompt that does not fit fails loudly and never reaches Gemini', () => {
  it('plate: PromptFitError, a prompt_fit_failed error, no provider fallback, no Gemini call', async () => {
    let thrown: any;
    try { await renderPlate(platePrompt(9000)); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(PromptFitError);
    expect(sentPrompts).toHaveLength(0);
    expect(fetchCalls).toBe(0);
    expect(genLog.entries.some((e: any) => e.event === 'image_provider_fallback')).toBe(false);
    expect(genLog.entries.find((e: any) => e.event === 'prompt_fit_failed')?.level).toBe('error');
  }, 30000);

  it('a PromptFitError raised inside the Grok call (the prefix refit) is rethrown, not sent to Gemini', async () => {
    editImpl = async () => { throw new PromptFitError('prompt-shrink [GROK EDIT]: refusing to cut them (test)'); };
    let thrown: any;
    try {
      await images.generateImageOnly('**THIS IMAGE DEPICTS:** An empty meadow at dawn.', [], {
        imageBackendOverride: 'grok', pageNumber: 3, skipCache: true, stripBorder: false,
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(PromptFitError);
    expect(fetchCalls).toBe(0);
    const events = genLog.entries.map((e: any) => e.event);
    expect(events).toContain('prompt_fit_failed');
    expect(events).not.toContain('image_provider_fallback');
    const fit = genLog.entries.find((e: any) => e.event === 'prompt_fit_failed');
    expect(fit.level).toBe('error');
  }, 30000);

  it('editImageWithPrompt rethrows a PromptFitError from its Grok edit', async () => {
    editImpl = async () => { throw new PromptFitError('refusing to cut them (test)'); };
    let thrown: any;
    try { await images.editImageWithPrompt(PX, 'make the sky orange', 'grok-imagine'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(PromptFitError);
    expect(fetchCalls).toBe(0);
  }, 30000);

  it('a real Grok error still falls back to Gemini (the fallback stays for provider errors)', async () => {
    editImpl = async () => { throw new Error('Grok edit failed (500): upstream (test)'); };
    try { await renderPlate(platePrompt(500)); } catch { /* Gemini stub fails */ }
    expect(genLog.entries.some((e: any) => e.event === 'image_provider_fallback')).toBe(true);
    expect(fetchCalls).toBeGreaterThan(0);
  }, 30000);
});

describe('the vantage plate states its Art Director prose once', () => {
  it('drops the vantage description when FRAMING carries the same text', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
    expect(src).toContain("vantageDescription && vantageDescription !== String(adEmptyPrompt || '').trim() ? vantageDescription : ''");
    expect(src).not.toMatch(/\*\*VANTAGE:\*\* \$\{v\.name \|\| ''\}`,\s*\n\s*v\.description \|\| '',/);
  });
});
