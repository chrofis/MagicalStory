/**
 * The two provider-refusal sanitizers in server/lib/images.js.
 *
 * They are siblings: a provider refuses an image request → the code mutates the
 * prompt locally → retries the same provider → else falls back to the other one.
 *
 *   1. generateImageOnly's GEMINI safety ladder. TWO rungs since 2026-09-18:
 *      level 0 sends the prompt as built, level 1 asks a text model to rewrite
 *      the scene. The former local word strip (PROBLEMATIC_WORDS +
 *      sanitizePromptLevel1, 78 words deleted whole-word from the WHOLE prompt)
 *      is DELETED — owner approved after it was measured: the list matched our
 *      own instructions, not violence (`bleeding` lives in image-generation.txt's
 *      "bleeding off all four edges", present in 81.8% of stored staging page
 *      prompts; `weapon` in the text-zone rule). It fired 14 times on staging and
 *      never in production, and rescued 1 of those 14 — that render going out
 *      without the full-bleed instruction. The rewrite rung rescued 2.
 *
 *   2. editImageWithPrompt's GROK moderation substitution table.
 *
 * Also pinned here, from the mechanics fixes of d32aa9303:
 *   A. Every rung rebuilds from the string level 0 actually SENT (`parts[0].text`,
 *      post-shrink), not from the raw `prompt` argument — on the Grok→Gemini
 *      fallback the shrink ran against Grok's 7,900-char cap BEFORE the swap, so
 *      a "retry" built from `prompt` silently re-expanded by thousands of chars.
 *   C. Model-authored rewrite text is spliced with a replacer FUNCTION, so a `$&`
 *      / `$'` / `$1` in it stays literal instead of acting as a substitution
 *      pattern.
 *
 * Nothing here asserts prompt WORDING — these pin mechanics.
 *
 * Only the network boundary is stubbed (Gemini's REST call, Grok's image calls,
 * the text model); the real code path runs. No paid call is made.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// images.js destructures grok's exports at module load, so the stubs must be
// installed BEFORE it is required. They delegate to mutable implementations so
// each test can decide how Grok behaves.
const grok = require_('../../server/lib/grok');
let grokGenerateImpl: (p: string, ...rest: any[]) => Promise<any>;
let grokEditImpl: (p: string, ...rest: any[]) => Promise<any>;
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [];
grok.generateWithGrok = (...a: any[]) => grokGenerateImpl(a[0], ...a.slice(1));
grok.editWithGrok = (...a: any[]) => grokEditImpl(a[0], ...a.slice(1));

const images = require_('../../server/lib/images');
const textModels = require_('../../server/lib/textModels');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const { IMAGE_MODELS } = require_('../../server/config/models');

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GROK_CAP: number = IMAGE_MODELS['grok-imagine']?.maxPromptLength || 7900;
const OK_IMAGE = { imageData: 'data:image/jpeg;base64,AAAA', modelId: 'grok-imagine-image', usage: {} };

/** Every prompt string handed to the Gemini REST endpoint, in order. */
let sentBodies: string[] = [];
/** Every prompt string handed to Grok's edit endpoint, in order. */
let grokEditPrompts: string[] = [];
let grokShouldFail = false;

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
  grokEditPrompts = [];
  grokShouldFail = false;
  grokGenerateImpl = async () => {
    if (grokShouldFail) throw new Error('grok refused (test)');
    return OK_IMAGE;
  };
  grokEditImpl = async (p: string) => {
    grokEditPrompts.push(p);
    if (grokShouldFail) throw new Error('grok refused (test)');
    return OK_IMAGE;
  };
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  // A rewrite that echoes a marker, so the rewrite rung's body is identifiable.
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

describe('the Gemini ladder has exactly two rungs: as-sent, then the scene rewrite', () => {
  it('a refusal escalates straight to the rewrite — no word-strip rung in between', async () => {
    const prompt = scene('Two children walk along the quiet lakeshore at dawn.');

    await expect(images.generateImageOnly(prompt, [], opts())).rejects.toThrow();

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]).toBe(prompt);
    expect(sentBodies[1]).toContain('REWRITTEN SCENE MARKER.');
  }, 30000);

  it('does not delete our own instructions from the retry', async () => {
    // Every one of these words was on the deleted 78-word list, and every one of
    // them is OUR phrasing, not a violent depiction: "bleeding off all four
    // edges" is the full-bleed rule in image-generation.txt, "weapon edges" is in
    // the text-zone rule, and the rest is ordinary English and German prose. The
    // deleted rung removed them whole-word from the WHOLE prompt.
    const keep = [
      'filling the canvas, bleeding off all four edges',
      'no high-contrast detail (hats, embroidery, patterns, weapon edges) in the calm zone',
      'the rope is wound twice around the post',
      'der Kiel ist hell',
      'the dead end of the path',
    ];
    const prompt = `${scene('A monster waits, gentle and shy, by the door.')}\n\n**RULES**\n${keep.join('\n')}`;

    await expect(images.generateImageOnly(prompt, [], opts())).rejects.toThrow();

    expect(sentBodies).toHaveLength(2);
    for (const line of keep) {
      expect(sentBodies[0]).toContain(line);
      expect(sentBodies[1]).toContain(line);   // the rewrite swaps the SCENE, nothing else
    }
    // …and the scene noun is not silently deleted either: the old rung turned
    // "A monster waits, gentle and shy" into "A waits, gentle and shy".
    expect(sentBodies[1]).not.toMatch(/\bA\s+waits\b/);
  }, 30000);

  it('never sends a third request — the rewrite is the last rung', async () => {
    const prompt = scene('A knight polishes a sword by the window.');
    await expect(images.generateImageOnly(prompt, [], opts())).rejects.toThrow(/blocked|no image|no candidates/i);
    expect(sentBodies).toHaveLength(2);
  }, 30000);
});

describe('A — the retry is built from the string level 0 actually sent', () => {
  it('rebuilds from the post-shrink prompt on the Grok→Gemini fallback', async () => {
    // Force the fallback: a Grok-backed model whose call throws, so the core
    // shrinks against GROK's cap and then swaps to Gemini for the ladder.
    grokShouldFail = true;
    const filler = Array.from({ length: 400 },
      (_, i) => `Figure ${i} stands near the old stone wall ${i} holding lantern ${i} in the evening light.`).join(' ');
    const prompt = `${scene(filler)}\n\n**ART STYLE**\nwatercolour.`;
    expect(prompt.length).toBeGreaterThan(GROK_CAP);
    // The compressor must not invent a shorter prompt behind the test's back.
    textModels.callTextModel = async (p: string) =>
      (/rewrite|safe/i.test(String(p))
        ? { text: 'REWRITTEN SCENE MARKER.', usage: {} }
        : { text: scene('Figures stand near the old stone wall holding lanterns. '), usage: {} });

    await expect(images.generateImageOnly(prompt, [], opts({ imageModelOverride: 'grok-imagine' }))).rejects.toThrow();

    expect(sentBodies.length).toBeGreaterThanOrEqual(2);
    const level0 = sentBodies[0];
    const level1 = sentBodies[1];
    // Level 0 was shrunk to the Grok cap…
    expect(level0.length).toBeLessThanOrEqual(GROK_CAP);
    expect(level0.length).toBeLessThan(prompt.length);
    // …so the rewrite must be a rewrite of THAT, never a re-expansion back
    // toward the ~36k-char original. The rewrite only swaps the scene block,
    // so it can never be longer than what level 0 sent.
    expect(level1.length).toBeLessThanOrEqual(level0.length);
    expect(level1).toContain('REWRITTEN SCENE MARKER.');
  }, 30000);
});

describe('C — model-authored rewrite text is spliced literally', () => {
  it('treats a $& in the rewrite as text, not as a substitution pattern', async () => {
    const prompt = scene('A knight polishes a sword by the window.');
    textModels.callTextModel = async () => ({ text: 'Cost $& and $1 and more.', usage: {} });

    await expect(images.generateImageOnly(prompt, [], opts())).rejects.toThrow();

    const last = sentBodies[sentBodies.length - 1];
    expect(last).toContain('Cost $& and $1 and more.');
    // $& would have re-inserted the whole matched scene here.
    expect(last).not.toMatch(/knight polishes a sword/);
  }, 30000);
});

/**
 * The sibling sanitizer: editImageWithPrompt's Grok moderation table.
 *
 * Measured 2026-09-18 over the 529 stored inpaint instructions that reach this
 * function (219 production, 310 staging): it has never actually fired in either
 * environment — no stored log line, and every stored Grok content-moderation
 * block belongs to another call path (avatar style transfer, char repair, scene
 * composite, generateImageOnly's own fallback). What the corpus does show is
 * what it WOULD do: 4 of 310 staging instructions would be rewritten and all 4
 * wrongly ("into the chest interior" → "near the chest interior" on a treasure
 * chest; "buzz-cut" → "buzz-touch" twice). 19 production and 36 staging
 * instructions carry a `chin` substring, every one inside a word like
 * "crouching", "reaching" or "chin-length".
 */
describe('the Grok moderation table (editImageWithPrompt)', () => {
  const MODERATION_400 = 'Grok edit API error (400): {"code":"imagine:content-moderated","error":"Generated image rejected by content moderation."}';
  /** Block the first Grok edit only, so the retry prompt is observable. */
  function blockFirstGrokEdit() {
    let n = 0;
    grokEditImpl = async (p: string) => {
      grokEditPrompts.push(p);
      if (++n === 1) throw new Error(MODERATION_400);
      return OK_IMAGE;
    };
  }
  const editWithGrok = (instruction: string) =>
    images.editImageWithPrompt('data:image/jpeg;base64,AAAA', instruction, 'grok-imagine', []);

  it('does not eat the text between an injected "touch" and a later ordinary word', async () => {
    // "hit" becomes "touch"; "crouching" and "reaching" both contain the letters
    // c-h-i-n. Under the old greedy `/touch.*chin/` this whole clause collapsed
    // into "be positioned near the face".
    blockFirstGrokEdit();
    const instruction = 'The ball that hit the wall is missing, and the crouching boy is reaching for it.';
    await editWithGrok(instruction);

    expect(grokEditPrompts).toHaveLength(2);
    const retry = grokEditPrompts[1];
    expect(retry).not.toContain('be positioned near the face');
    expect(retry).toContain('the crouching boy is reaching for it');
    expect(retry).toContain('The ball that touch the wall is missing');
  }, 30000);

  it('leaves a "chin-length" haircut alone', async () => {
    // A hyphenated chin-length HAIRCUT is not a chin. "cut" is what triggers the
    // retry here — it is the commonest of the listed words in the real corpus,
    // and it arrives inside "buzz-cut", "cut flowers", "close-cropped".
    blockFirstGrokEdit();
    await editWithGrok('Have the woman touch the girl with chin-length blonde hair, and remove the cut flowers.');

    expect(grokEditPrompts).toHaveLength(2);
    const retry = grokEditPrompts[1];
    expect(retry).not.toContain('be positioned near the face');
    expect(retry).toContain('chin-length blonde hair');
  }, 30000);

  it('still rewrites an author-written "touch … chin"', async () => {
    blockFirstGrokEdit();
    await editWithGrok("Make the man's hand touch the child's chin.");

    const retry = grokEditPrompts[1];
    expect(retry).toContain('be positioned near the face');
    expect(retry).not.toMatch(/touch the child's chin/);
  }, 30000);

  it('does not retry at all when the table changes nothing', async () => {
    // The `sanitized !== editPrompt` guard the Gemini ladder lacked until
    // 2026-09-18: a retry identical to the refused request cannot change the
    // verdict, and Grok bills for the refusal.
    blockFirstGrokEdit();
    await editWithGrok('Move the lantern to the table.').catch(() => { /* falls through to Gemini */ });

    expect(grokEditPrompts).toHaveLength(1);
  }, 30000);
});
