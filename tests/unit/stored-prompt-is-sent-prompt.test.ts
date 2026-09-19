/**
 * What we STORE for a page must be what we SENT to the image model.
 *
 * Two bugs shipped together because nothing asserted that equality:
 *   A. the unified page record stored `pageData.prompt` — the PRE-shrink build —
 *      while generateImageOnly returned the post-shrink string on
 *      `genResult.prompt`. Staging job_1789348171785_9oxos7dwv p7 therefore
 *      stored 8,002 chars against grok-imagine-image-2.0's 7,900-char cap.
 *   B. `compressedScene` was null on 18/18 pages of that run. Not a plumbing
 *      loss: shrinkPromptForModel stamped it ONLY on the LLM-compression
 *      branch, and p7 (the one over-cap page) was brought under the cap by the
 *      deterministic dedupe step alone — 8,002 → 7,242 — so the stamp never ran
 *      and nothing recorded that the sent prose differed from the built prose.
 *
 * Yesterday's fix shipped with a test that mocked the storage layer, so it
 * passed while both bugs stood. This one stubs ONLY the network boundary
 * (xAI's image calls, and the compressor's text call) and drives the real
 * generateImageOnly → _dispatchImageGeneration → shrinkPromptForModel path,
 * comparing the returned/persisted value against the string the provider was
 * literally handed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);

// images.js destructures grok's exports at module load, so the stubs must be in
// place BEFORE it is required. Same registry, real modules, swapped functions.
const grok = require_('../../server/lib/grok');
const realGrok = { ...grok };
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [];
let sentToProvider: string | null = null;
grok.generateWithGrok = async (prompt: string) => {
  sentToProvider = prompt;
  return { imageData: 'data:image/jpeg;base64,AAAA', modelId: 'grok-imagine-image-2.0', usage: {} };
};
grok.editWithGrok = grok.generateWithGrok;

const images = require_('../../server/lib/images');
const textModels = require_('../../server/lib/textModels');
const { IMAGE_MODELS, resolveGrokImageModel } = require_('../../server/config/models');

const grokKey = resolveGrokImageModel(null).key;
const CAP: number = IMAGE_MODELS[grokKey]?.maxPromptLength || 7500;

// A prompt with a protected tail, unique bullets (nothing for the dedupe step
// to merge) and a head far enough over the cap that the compressor must run.
const buildPrompt = (headChars: number) => {
  const sentences: string[] = [];
  for (let i = 0; sentences.join(' ').length < headChars; i++) {
    sentences.push(`Figure ${i} stands near landmark ${i} wearing garment number ${i} in colour ${i}.`);
  }
  return `${sentences.join(' ')}\n\n**REQUIRED OBJECTS**\n- a lantern\n\n**ART STYLE**\nwatercolour.`;
};

const realCallTextModel = textModels.callTextModel;
afterEach(() => {
  textModels.callTextModel = realCallTextModel;
  images.clearImageCache?.();
});
beforeEach(() => { sentToProvider = null; });

const genOpts = {
  imageBackendOverride: 'grok',
  skipCache: true,
  stripBorder: false,
  pageNumber: 7,
};

describe('the stored page prompt is the prompt the model received', () => {
  it('returns the post-shrink string the provider was handed, under the model cap', async () => {
    // >500 chars: shorter rewrites are rejected as a collapsed stub and the
    // shrinker falls through to its section-aware cut.
    const compressedHead = 'Figures stand near the landmarks in their named garments. '.repeat(12).trim();
    textModels.callTextModel = async () => ({ text: compressedHead, usage: {} });

    const built = buildPrompt(CAP + 4000);
    expect(built.length).toBeGreaterThan(CAP);

    const res = await images.generateImageOnly(built, [], genOpts);

    // The equality nothing asserted before: stored value === sent value.
    expect(sentToProvider).not.toBeNull();
    expect(res.prompt).toBe(sentToProvider);
    // …and the sent value really is within the model's cap.
    expect(res.prompt.length).toBeLessThanOrEqual(CAP);
    expect(res.prompt.length).toBeLessThan(built.length);
    // Bug B: the scene block the model actually received is recorded.
    expect(res.compressedScene).toBe(compressedHead);
  }, 30000);

  it('records the sent scene block even when dedupe alone brings the prompt under the cap', async () => {
    // The exact shape of staging p7: over the cap, but the deterministic step
    // fixes it, so the LLM compressor never runs. Any text call here would mean
    // the compression branch fired and the reproduction is wrong.
    textModels.callTextModel = async () => { throw new Error('compressor must not run'); };

    const body = `wearing the same verbatim proportion boilerplate ${'x'.repeat(200)}`;
    const dupes = Array.from({ length: 40 }, (_, i) => `- Name${i}: ${body}`).join('\n');
    const built = `${'Scene prose. '.repeat(400)}\n${dupes}\n\n**REQUIRED OBJECTS**\n- a lantern\n\n**ART STYLE**\nwatercolour.`;
    expect(built.length).toBeGreaterThan(CAP);

    const res = await images.generateImageOnly(built, [], genOpts);

    expect(res.prompt).toBe(sentToProvider);
    expect(res.prompt.length).toBeLessThanOrEqual(CAP);
    expect(typeof res.compressedScene).toBe('string');
    expect(res.compressedScene.length).toBeGreaterThan(0);
    // It is the SCENE BLOCK alone — not a second copy of the whole prompt.
    expect(res.compressedScene).not.toContain('**ART STYLE');
  }, 30000);

  it('leaves an under-cap prompt untouched and stamps no compressedScene', async () => {
    textModels.callTextModel = async () => { throw new Error('nothing to compress'); };
    const built = buildPrompt(1000);
    expect(built.length).toBeLessThan(CAP);

    const res = await images.generateImageOnly(built, [], genOpts);

    expect(sentToProvider).toBe(built);
    expect(res.prompt).toBe(built);
    expect(res.compressedScene).toBeUndefined();
  }, 30000);
});

describe('the pipeline page records take their prompt from the generation result', () => {
  // The caller is inline inside a 6k-line pipeline function and cannot be
  // imported, so the pin is structural: every record that stores a prompt for a
  // render it just performed must derive it from that render's result. Against
  // the old code each of these read `pageData.prompt` / `imagePrompt` /
  // `coverPrompt` alone.
  const src = fs.readFileSync(path.join(process.cwd(), 'storyJobPipeline.js'), 'utf8');
  const lines = src.split('\n');

  it('has no post-render record storing a build-only prompt', () => {
    // A record that stamps a generation result's OWN fields (imageData /
    // modelId / usage from genResult|result|coverResult) is a post-render
    // record, and its prompt must come from that result too. A build-only
    // `prompt:` elsewhere — the pre-generation pageData, or the failure record
    // in the catch, where no result exists — is legitimate and not flagged.
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/prompt:\s*(pageData\.prompt|imagePrompt|coverPrompt)\s*,/.test(line)) return;
      const near = lines.slice(Math.max(0, i - 10), i + 11).join('\n');
      if (/\b(genResult|coverResult|retryResult|result)\.(imageData|modelId|usage)\b/.test(near)) {
        offenders.push(`line ${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('stamps the sent prompt on the unified page, trial page and trial cover records', () => {
    expect(src).toContain('prompt: genResult.prompt || pageData.prompt,');
    expect(src).toContain('prompt: genResult.prompt || imagePrompt,');
    expect(src).toContain('prompt: result.prompt || coverPrompt,');
  });

  it('carries the sent prompt onto a page recovered by the retry', () => {
    expect(src).toMatch(/raw\.prompt = retryResult\.prompt \|\| raw\.prompt;/);
  });
});

