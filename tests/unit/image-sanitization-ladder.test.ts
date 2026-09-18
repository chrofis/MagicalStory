/**
 * The Gemini safety-block sanitization ladder in generateImageOnly.
 *
 * Three rungs: level 0 sends the prompt as built, level 1 strips the 78
 * PROBLEMATIC_WORDS locally, level 2 asks a text model to rewrite the scene.
 * Measured on stored data 2026-09-18 (staging testlab_experiments #815/#959/
 * #963/#964/#965 — 14 level-1 events, 1 success; production: none ever):
 *
 *   A. Levels 1 and 2 rebuilt from the raw `prompt` ARGUMENT while level 0 had
 *      sent `parts[0].text`, the post-shrink string. On the Grok→Gemini fallback
 *      the shrink ran against Grok's 7,900-char cap before the swap to
 *      gemini-2.5-flash-image, so a "sanitization retry" silently re-expanded
 *      the prompt by thousands of characters and retried something other than
 *      the request that had just been refused.
 *
 *   B. A level-1 pass over a prompt containing none of the 78 words removes
 *      nothing, yet sanitizePromptLevel1 always returns a NEW string (it
 *      collapses double spaces and triple newlines unconditionally). The ladder
 *      compared nothing, so it paid for an image call whose prompt differed from
 *      the refused one only in whitespace. 58.4% of stored production page
 *      prompts and 16.8% of staging ones contain no listed word.
 *
 *   C. The level-2 splice used `String.replace(scene, modelText)`, so a `$&`,
 *      `$'` or `$1` sequence in MODEL-authored text is a substitution pattern
 *      and would splice a copy of the matched scene back into the prompt.
 *
 * Nothing here asserts WHICH words the list holds — that is a prompt-side
 * decision, not a code one. These pin the ladder's mechanics.
 *
 * Only the network boundary is stubbed (Gemini's REST call, Grok's image calls,
 * the text model); the real generateImageOnly → _dispatchImageGeneration path
 * runs. No paid call is made.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// images.js destructures grok's exports at module load, so stubs must be in
// place BEFORE it is required.
const grok = require_('../../server/lib/grok');
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [];
let grokShouldFail = false;
grok.generateWithGrok = async (p: string) => {
  if (grokShouldFail) throw new Error('grok refused (test)');
  return { imageData: 'data:image/jpeg;base64,AAAA', modelId: 'grok-imagine-image', usage: {} };
};
grok.editWithGrok = grok.generateWithGrok;

const images = require_('../../server/lib/images');
const textModels = require_('../../server/lib/textModels');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require_('../../server/services/prompts');
const { IMAGE_MODELS } = require_('../../server/config/models');

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GROK_CAP: number = IMAGE_MODELS['grok-imagine']?.maxPromptLength || 7900;

/** Every prompt string handed to the Gemini REST endpoint, in order. */
let sentBodies: string[] = [];
const realFetch = global.fetch;
const realCallTextModel = textModels.callTextModel;

/** A Gemini response that refuses with IMAGE_OTHER — the reason every stored firing carries. */
const refusal = () => ({
  ok: true,
  json: async () => ({
    candidates: [{ finishReason: 'IMAGE_OTHER', content: { parts: [{ text: '' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
  }),
});

function stubFetch() {
  global.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sentBodies.push(body.contents[0].parts[0].text);
    return refusal();
  }) as any;
}

beforeAll(async () => { await loadPromptTemplates(); });

beforeEach(() => {
  sentBodies = [];
  grokShouldFail = false;
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  // A rewrite that echoes a marker, so the level-2 body is identifiable.
  textModels.callTextModel = async () => ({ text: 'REWRITTEN SCENE MARKER.', usage: {} });
  stubFetch();
});

afterEach(() => {
  global.fetch = realFetch;
  textModels.callTextModel = realCallTextModel;
  images.clearImageCache?.();
});

const scene = (body: string) => `**THIS IMAGE DEPICTS:** ${body}`;
const opts = (over: any = {}) => ({
  imageModelOverride: GEMINI_MODEL,
  skipCache: true,
  stripBorder: false,
  pageNumber: 3,
  ...over,
});

describe('B — a level-1 pass that strips nothing must not cost an image call', () => {
  it('escalates straight to the rewrite when the prompt holds none of the listed words', async () => {
    // Deliberately word-free, but WITH double spaces, so the old `!==` shortcut
    // would have seen a "changed" prompt.
    const prompt = scene('Two children  walk along the  quiet lakeshore at  dawn.');

    await expect(images.generateImageOnly(prompt, [], opts())).rejects.toThrow();

    // Level 0, then level 2. No level-1 call in between.
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]).toBe(prompt);
    expect(sentBodies[1]).toContain('REWRITTEN SCENE MARKER.');
  }, 30000);

  it('still runs level 1 when there IS a listed word to strip', async () => {
    const prompt = scene('The monster is gentle and shy, and waits by the door.');

    await expect(images.generateImageOnly(prompt, [], opts())).rejects.toThrow();

    expect(sentBodies).toHaveLength(3);
    expect(sentBodies[0]).toBe(prompt);
    // Level 1 removed the word — and, as the word list cannot tell a gentle
    // monster from a violent one, inverted the sentence it was describing.
    expect(sentBodies[1]).not.toMatch(/\bmonster\b/i);
    expect(sentBodies[1]).toContain('The is gentle and shy');
    expect(sentBodies[2]).toContain('REWRITTEN SCENE MARKER.');
  }, 30000);

  it('a no-op level 1 never stores a whitespace-mangled prompt as the page prompt', async () => {
    // The double spaces must survive to level 2 untouched: the only thing that
    // may rewrite the prompt is the rewrite.
    const prompt = scene('A quiet  room with  two  chairs.');
    await expect(images.generateImageOnly(prompt, [], opts())).rejects.toThrow();
    expect(sentBodies[0]).toContain('quiet  room');
  }, 30000);
});

describe('A — every rung retries the string level 0 actually sent', () => {
  it('builds the retry from the post-shrink prompt on the Grok→Gemini fallback', async () => {
    // Force the fallback: a Grok-backed model whose call throws, so the core
    // shrinks against GROK's cap and then swaps to Gemini for the ladder.
    grokShouldFail = true;
    // Unique sentences (nothing for the dedupe step to merge) well over the cap,
    // each carrying a listed word so level 1 has work to do.
    const filler = Array.from({ length: 400 },
      (_, i) => `Figure ${i} stands near the old stone wall ${i} holding lantern ${i} in the evening fire light.`).join(' ');
    const prompt = `${scene(filler)}\n\n**ART STYLE**\nwatercolour.`;
    expect(prompt.length).toBeGreaterThan(GROK_CAP);
    // The compressor must not invent a shorter prompt behind the test's back.
    textModels.callTextModel = async (p: string) =>
      (/rewrite|safe/i.test(String(p)) ? { text: 'REWRITTEN SCENE MARKER.', usage: {} }
        : { text: `${scene('Figures stand near the old stone wall holding lanterns. ')}`.repeat(1), usage: {} });

    await expect(images.generateImageOnly(prompt, [], opts({ imageModelOverride: 'grok-imagine' }))).rejects.toThrow();

    expect(sentBodies.length).toBeGreaterThanOrEqual(2);
    const level0 = sentBodies[0];
    const level1 = sentBodies[1];
    // Level 0 was shrunk to the Grok cap…
    expect(level0.length).toBeLessThanOrEqual(GROK_CAP);
    expect(level0.length).toBeLessThan(prompt.length);
    // …so the retry must be a sanitized version of THAT, never a re-expansion
    // back toward the 12k-char original. Stripping only ever shortens.
    expect(level1.length).toBeLessThanOrEqual(level0.length);
    expect(level1.length).toBeLessThan(prompt.length);
  }, 30000);
});

describe('C — model-authored rewrite text is spliced literally', () => {
  it('treats a $& in the rewrite as text, not as a substitution pattern', async () => {
    const prompt = scene('A knight polishes a sword by the window.');
    textModels.callTextModel = async () => ({ text: 'Cost $& and $1 and more.', usage: {} });

    await expect(images.generateImageOnly(prompt, [], opts())).rejects.toThrow();

    const level2 = sentBodies[sentBodies.length - 1];
    expect(level2).toContain('Cost $& and $1 and more.');
    // $& would have re-inserted the whole matched scene here.
    expect(level2).not.toMatch(/knight polishes a sword/);
  }, 30000);
});
