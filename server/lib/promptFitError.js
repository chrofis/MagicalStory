'use strict';

/**
 * A PROMPT THAT DOES NOT FIT IS OUR BUG, NOT THE PROVIDER'S (owner, 2026-09-25).
 *
 * Thrown by the local prompt fitters (images.js `sectionAwareCut`,
 * `fitPlatePrompt`) when a built prompt cannot be brought under a model's cap
 * without cutting text that must stay. It is raised on this machine before any
 * request leaves it, so it says nothing about the provider: the provider
 * fallbacks in images.js (Grok→Gemini, Runware→Gemini) rethrow it instead of
 * treating it as a failed Grok call (`rethrowLocalFault`). Staging
 * job_1790277448294_5herh01j7: a landmark plate prompt overflowed the Grok cap
 * once the magenta-extension prefix was added, the refusal to cut was caught as
 * a "Grok failure", and the plate was painted by Gemini as a photograph.
 */
class PromptFitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromptFitError';
  }
}

/**
 * A prompt's size as the providers measure it: UTF-8 bytes, not JS string
 * length. xAI counts bytes — 8,500 'ü' (17,000 bytes) is refused by the
 * 16,000 cap of grok-imagine-image (measured 2026-10-04). Every
 * `maxPromptLength` comparison goes through this. See decisions.md 2026-10-04
 * "Grok prompt caps are 16,000 / 64,000 bytes".
 */
function promptBytes(text) {
  return Buffer.byteLength(text || '', 'utf8');
}

module.exports = { PromptFitError, promptBytes };
