import { describe, it, expect } from 'vitest';

// Which Grok tier an image-model override actually renders on.
//
// The Grok primary branch in `_dispatchImageGeneration` picked its tier twice,
// in two different wrong ways: the eval path with a two-way
// `=== 'grok-imagine-pro' ? PRO : STANDARD` ternary, and `generateImageOnly`
// with a hardcoded `GROK_MODELS.STANDARD` plus the comment "only used for page
// regeneration, so always STANDARD". Both collapsed `grok-imagine-2` to
// `grok-imagine-image`, so:
//   - a Test Lab image-stage arm asking for Imagine 2.0 silently A/B'd
//     Standard against Standard, and
//   - the typography-aware cover title bake (runtime `coverTitleBakedModel`,
//     'grok-imagine-2', passed as imageModelOverride by coverIterate) never
//     ran on 2.0 at all.
// Both sites now derive from IMAGE_MODELS via `resolveGrokImageModel`.

// @ts-expect-error - JS module without types
import { IMAGE_MODELS, resolveGrokImageModel } from '../../server/config/models.js';
// @ts-expect-error - JS module without types
import { GROK_MODELS } from '../../server/lib/grok.js';

describe('resolveGrokImageModel', () => {
  it('defaults to grok-imagine-image when there is no override', () => {
    // Production page/cover generation passes no override — this is the
    // behaviour that must not change.
    expect(resolveGrokImageModel(null).modelId).toBe('grok-imagine-image');
    expect(resolveGrokImageModel(undefined).modelId).toBe('grok-imagine-image');
  });

  it('selects the tier an explicit grok override names', () => {
    expect(resolveGrokImageModel('grok-imagine').modelId).toBe('grok-imagine-image');
    expect(resolveGrokImageModel('grok-imagine-2').modelId).toBe('grok-imagine-image-2.0');
    expect(resolveGrokImageModel('grok-imagine-pro').modelId).toBe('grok-imagine-image-pro');
  });

  it('marks an explicit grok override so the caller need not re-check', () => {
    expect(resolveGrokImageModel('grok-imagine-2').isExplicit).toBe(true);
    expect(resolveGrokImageModel(null).isExplicit).toBe(false);
  });

  it('does not claim a non-grok model — a gemini key stays on the gemini backend', () => {
    // The dispatcher routes on IMAGE_MODELS[...].backend; a gemini key must
    // never reach the Grok branch. If it somehow does (explicit
    // imageBackendOverride='grok'), the fallback is Standard AND visible:
    // isExplicit=false is what makes the dispatcher log the downgrade.
    expect(IMAGE_MODELS['gemini-2.5-flash-image'].backend).toBe('gemini');
    expect(IMAGE_MODELS['flux-dev'].backend).toBe('runware');
    for (const key of ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'flux-dev']) {
      const r = resolveGrokImageModel(key);
      expect(r.isExplicit, `${key} must not resolve as a grok tier`).toBe(false);
      expect(r.modelId).toBe('grok-imagine-image');
    }
  });

  it('falls back visibly for an unknown key instead of inventing a model id', () => {
    const r = resolveGrokImageModel('no-such-model');
    expect(r.isExplicit).toBe(false);
    expect(r.modelId).toBe('grok-imagine-image');
  });

  it('returns a key whose registry row carries the Grok prompt budget', () => {
    // The dispatcher looks up maxPromptLength by the returned key; a key that
    // is not in the registry would silently fall back to a 7500 default.
    for (const override of [null, 'grok-imagine-2', 'grok-imagine-pro', 'bogus']) {
      expect(IMAGE_MODELS[resolveGrokImageModel(override).key].maxPromptLength).toBe(7900);
    }
  });

  it('stays in sync with grok.js GROK_MODELS — one set of tier ids', () => {
    expect(resolveGrokImageModel('grok-imagine').modelId).toBe(GROK_MODELS.STANDARD);
    expect(resolveGrokImageModel('grok-imagine-2').modelId).toBe(GROK_MODELS.IMAGE_2);
    expect(resolveGrokImageModel('grok-imagine-pro').modelId).toBe(GROK_MODELS.PRO);
  });
});
