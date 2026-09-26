import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { resolveEvalImagePrompt } = require('../../server/lib/sceneMetadata.js');

// BEHAVIOUR PINNED: an image judge scores a render against THE STRING THE IMAGE
// MODEL ACTUALLY RECEIVED.
//
// Every evaluator prompt calls IMAGE_PROMPT "the expanded scene sent to the
// image model". A prompt over the model's character cap does not arrive as
// written: shrinkPromptForModel (images.js) LLM-compresses the HEAD, holding
// back only the REQUIRED OBJECTS / ART STYLE tail, the reference-card colour
// map and the static rendering rules. The scene prose is rewritten shorter and
// clauses go missing — so judging the PRE-shrink text files full-severity
// "X is missing" findings against instructions the generator never got.
//
// Measured on staging 2026-09-13, job_1789301291267_ueh8h145m: page 1 stores a
// 7,939-char prompt and page 4 v0 an 8,317-char one, both rendered by
// grok-imagine-image-2.0 (cap 7,900). Assert the RULE, not any prompt wording.

const CAP = 7900;
const SENT = 'A rainy quay. The girl kneels beside the overturned rowing boat.'; // post-shrink
const ORIGINAL = `${SENT} She reaches for the mooring rope coiled on the stones.`; // pre-shrink

describe('resolveEvalImagePrompt — judge prompt == generator prompt', () => {
  it('the judge gets the post-shrink string whenever the shrinker fired', () => {
    expect(resolveEvalImagePrompt({ promptSent: SENT, originalPrompt: ORIGINAL })).toBe(SENT);
  });

  it('an unshrunk prompt is unchanged — the two strings are the same object', () => {
    expect(resolveEvalImagePrompt({ promptSent: ORIGINAL, originalPrompt: ORIGINAL })).toBe(ORIGINAL);
  });

  it('a provider that returns no sent string falls back to the built prompt', () => {
    expect(resolveEvalImagePrompt({ promptSent: null, originalPrompt: ORIGINAL })).toBe(ORIGINAL);
    expect(resolveEvalImagePrompt({ promptSent: '   ', originalPrompt: ORIGINAL })).toBe(ORIGINAL);
  });

  it('nothing at all resolves to null rather than an empty string', () => {
    expect(resolveEvalImagePrompt({})).toBeNull();
    expect(resolveEvalImagePrompt()).toBeNull();
  });

  it('the resolved prompt never exceeds the cap the sent string was fitted to', () => {
    const sent = 'x'.repeat(CAP);
    const original = 'x'.repeat(CAP + 39); // the p1 shape: 7,939 against a 7,900 cap
    expect(resolveEvalImagePrompt({ promptSent: sent, originalPrompt: original }).length)
      .toBeLessThanOrEqual(CAP);
  });
});

describe('the generation paths record the prompt they SENT', () => {
  const images = fs.readFileSync(new URL('../../server/lib/images.js', import.meta.url), 'utf8');
  const cover = fs.readFileSync(new URL('../../server/lib/coverIterate.js', import.meta.url), 'utf8');

  it('every provider branch of generateImageOnly stamps raw.promptSent', () => {
    // grok-primary is the DEFAULT page path and was the one branch stamping the
    // pre-shrink `prompt` — which is why a 7,939-char string is stored against a
    // 7,900 cap. Its three siblings already did it right.
    const branch = images.slice(images.indexOf("if (raw.provider === 'grok-primary') {", images.indexOf('async function generateImageOnly')));
    expect(branch.slice(0, 900)).toContain('prompt: raw.promptSent');
    expect(branch.slice(0, 900)).not.toMatch(/\n\s+prompt,\n/);
  });

  it('the eval-path call sites resolve IMAGE_PROMPT through the shared accessor', () => {
    expect(images).toContain("require('./sceneMetadata')");
    // Three sites in images.js: the shared runEval, the Gemini fallback, iterate.
    expect((images.match(/resolveEvalImagePrompt\(\{/g) || []).length).toBeGreaterThanOrEqual(3);
    // The regressed expressions: the raw pre-shrink prompt handed straight in.
    expect(images).not.toMatch(/evaluateImageQuality\(\s*raw\.imageData,\s*prompt,/);
    expect(images).not.toMatch(/evaluateImageQuality\(compressedImageData,\s*prompt,/);
    expect(images).not.toMatch(/genResult\.imageData,\s*imagePrompt,/);
  });

  it('the direct cover render is judged against the prompt it sent', () => {
    expect(cover).toContain('resolveEvalImagePrompt({ promptSent: genResult.prompt');
    expect(cover).not.toMatch(/genResult\.imageData,\s*coverPrompt,/);
  });
});
