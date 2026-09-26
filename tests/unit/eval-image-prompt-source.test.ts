import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const sceneMetadata = require('../../server/lib/sceneMetadata.js');

// BEHAVIOUR PINNED (owner, 2026-09-26; supersedes the 2026-09-13 "judge the
// string the image model actually received"): an image judge scores a render
// against the prompt AS BUILT, before shrinkPromptForModel fits it into one
// image model's character cap. The standing rule is "every critic judges the
// source the generator was given, uncut" (docs/decisions.md). The post-shrink
// string stays the RECORD of what was sent (`prompt` on the result), never the
// contract. Assert the rule, not any prompt wording.

describe('the judges read the prompt as built, before the shrink', () => {
  const images = fs.readFileSync(new URL('../../server/lib/images.js', import.meta.url), 'utf8');
  const cover = fs.readFileSync(new URL('../../server/lib/coverIterate.js', import.meta.url), 'utf8');

  it('every provider branch of generateImageOnly still records what it SENT', () => {
    // The record of what reached the model is kept: grok-primary is the DEFAULT
    // page path and stamps the post-shrink string, as its siblings do.
    const branch = images.slice(images.indexOf("if (raw.provider === 'grok-primary') {", images.indexOf('async function generateImageOnly')));
    expect(branch.slice(0, 900)).toContain('prompt: raw.promptSent');
    expect(branch.slice(0, 900)).not.toMatch(/\n\s+prompt,\n/);
  });

  it('the post-shrink accessor is deleted, not demoted', () => {
    expect(sceneMetadata.resolveEvalImagePrompt).toBeUndefined();
    expect(images).not.toContain('resolveEvalImagePrompt');
    expect(cover).not.toContain('resolveEvalImagePrompt');
  });

  it('the eval-path call sites hand the judge the pre-shrink build', () => {
    // The shared runEval, the Gemini branch and iterate.
    expect(images).toMatch(/evaluateImageQuality\(\s*raw\.imageData,\s*prompt,/);
    expect(images).toMatch(/evaluateImageQuality\(compressedImageData,\s*prompt,/);
    expect(images).toMatch(/genResult\.imageData,\s*imagePrompt,/);
    // Never the sent string.
    expect(images).not.toMatch(/evaluateImageQuality\([^)]*promptSent/);
    expect(images).not.toMatch(/evaluateImageQuality\(compressedImageData,\s*parts\[0\]/);
  });

  it('the direct cover render is judged against the cover prompt as built', () => {
    expect(cover).toMatch(/genResult\.imageData,\s*coverPrompt,/);
  });
});
