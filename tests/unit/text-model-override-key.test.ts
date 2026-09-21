/**
 * A MODEL OVERRIDE IS A TEXT_MODELS KEY, AND AN UNKNOWN ONE IS A BUG (2026-09-21).
 *
 * `callTextModel(prompt, max, modelOverride)` takes a KEY ('claude-haiku'), not a
 * provider model id ('claude-haiku-4-5-20251001'). The lookup used to be
 * `if (modelOverride && TEXT_MODELS[modelOverride])`, so an id silently left the
 * call on the globally active model: storyJobPipeline's scene_translation passed
 * the Haiku id, ran on Sonnet, and cost $0.041 against the comment's "~$0.001".
 * No fallbacks — an unknown override throws.
 */
import { describe, it, expect } from 'vitest';

const { callTextModel, callTextModelStreaming } = require('../../server/lib/textModels');
const { TEXT_MODELS, MODEL_DEFAULTS } = require('../../server/config/models');

describe('text model override keys', () => {
  it('throws on a provider model id passed where a key belongs', async () => {
    await expect(callTextModel('hi', null, 'claude-haiku-4-5-20251001')).rejects.toThrow(/Unknown text model override/);
    await expect(callTextModelStreaming('hi', null, null, 'claude-haiku-4-5-20251001')).rejects.toThrow(/Unknown text model override/);
  });

  it('throws on any unknown key rather than silently keeping the active model', async () => {
    await expect(callTextModel('hi', null, 'no-such-model')).rejects.toThrow(/Unknown text model override/);
  });

  // The call sites. Every literal key handed to callTextModel/callTextModelStreaming
  // in the repo, plus every MODEL_DEFAULTS slot that names a text model.
  const literalCallSiteKeys = ['claude-haiku', 'claude-sonnet', 'gemini-2.5-flash-lite'];
  it.each(literalCallSiteKeys)('call-site key "%s" resolves', (key) => {
    expect(TEXT_MODELS[key], `${key} is not a TEXT_MODELS key`).toBeTruthy();
  });

  it('every MODEL_DEFAULTS slot naming a text model resolves', () => {
    // Image backends, aspect ratios and mode flags live in the same object and
    // are not model keys; the ones below are the text slots the pipeline passes
    // straight into callTextModel as an override.
    const textSlots = Object.entries(MODEL_DEFAULTS)
      .filter(([k, v]) => typeof v === 'string' && !/image|avatar|cover|aspect|backend/i.test(k)
        && /^(claude|gemini|grok-[34]|qwen|deepseek|glm|kimi|minimax|gpt)/.test(v));
    expect(textSlots.length).toBeGreaterThan(0);
    const unresolved = textSlots.filter(([, v]) => !TEXT_MODELS[v]);
    expect(unresolved, `unresolved MODEL_DEFAULTS text slots: ${JSON.stringify(unresolved)}`).toEqual([]);
  });
});
