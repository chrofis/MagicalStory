import { describe, it, expect, afterAll, vi } from 'vitest';

// Which Grok tier renders a PAGE, a COVER, and an empty-scene PLATE — per
// environment.
//
// Staging renders pages and covers on Imagine 2.0 ($0.04); every other
// environment, production included, stays on Standard ($0.02). The split is
// declared once in server/config/runtime.js via perEnvironment(), and
// server/config/models.js reads it at load.
//
// The plate is the part that needs a test rather than a comment. Every
// empty-scene call site used to pass the page's already-resolved
// `pageImageModel` verbatim, so a plate inherited whatever tier the page used —
// there was no plate-specific key at all. A plate is a people-free background
// used as a style anchor, so neither reason to pay for 2.0 (typography, figure
// fidelity) applies to it, and docs/image-routing.md records the plate path as
// a shipped-and-correct verdict. It must resolve to Standard in BOTH
// environments.
//
// Two keys that must NOT follow the page tier, for different reasons:
//   - MODEL_DEFAULTS.pageImage is the EDIT/INPAINT tier (editImageWithPrompt,
//     imageInpainting). Moving it would double every live inpaint.
//   - MODEL_DEFAULTS.avatar, and the 2x4 sheet's hardcoded GROK_MODELS.STANDARD.

const ORIGINAL_ENV = process.env.RAILWAY_ENVIRONMENT_NAME;

/** Load a fresh copy of the model config as it resolves in `envName`. */
async function loadModelsFor(envName: string | undefined) {
  vi.resetModules();
  if (envName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
  else process.env.RAILWAY_ENVIRONMENT_NAME = envName;
  // @ts-expect-error - JS module without types
  return await import('../../server/config/models.js');
}

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
  else process.env.RAILWAY_ENVIRONMENT_NAME = ORIGINAL_ENV;
  vi.resetModules();
});

describe('page + cover render tier', () => {
  it('staging renders pages and covers on grok-imagine-image-2.0', async () => {
    const { MODEL_DEFAULTS, IMAGE_MODELS } = await loadModelsFor('staging');
    expect(MODEL_DEFAULTS.pageRenderImage).toBe('grok-imagine-2');
    expect(IMAGE_MODELS[MODEL_DEFAULTS.pageRenderImage].modelId).toBe('grok-imagine-image-2.0');
    expect(IMAGE_MODELS[MODEL_DEFAULTS.coverImage].modelId).toBe('grok-imagine-image-2.0');
    // The complexity-routing seam both live page renders read.
    expect(IMAGE_MODELS[MODEL_DEFAULTS.simplePageImage].modelId).toBe('grok-imagine-image-2.0');
    expect(IMAGE_MODELS[MODEL_DEFAULTS.complexPageImage].modelId).toBe('grok-imagine-image-2.0');
  });

  it('production and every other environment stay on grok-imagine-image', async () => {
    for (const env of ['production', undefined, 'local']) {
      const { MODEL_DEFAULTS, IMAGE_MODELS } = await loadModelsFor(env);
      const where = `env=${env ?? '(unset)'}`;
      expect(IMAGE_MODELS[MODEL_DEFAULTS.pageRenderImage].modelId, where).toBe('grok-imagine-image');
      expect(IMAGE_MODELS[MODEL_DEFAULTS.coverImage].modelId, where).toBe('grok-imagine-image');
      expect(IMAGE_MODELS[MODEL_DEFAULTS.simplePageImage].modelId, where).toBe('grok-imagine-image');
      expect(IMAGE_MODELS[MODEL_DEFAULTS.complexPageImage].modelId, where).toBe('grok-imagine-image');
    }
  });

  it('bills the staging tier at $0.04 and the production tier at $0.02', async () => {
    // A tier change that is not priced shows up as a halved cost report.
    const { MODEL_PRICING } = await loadModelsFor('staging');
    expect(MODEL_PRICING['grok-imagine-image-2.0'].perImage).toBe(0.04);
    expect(MODEL_PRICING['grok-imagine-image'].perImage).toBe(0.02);
  });
});

describe('empty-scene plate tier', () => {
  it('resolves to grok-imagine-image in BOTH environments', async () => {
    for (const env of ['staging', 'production', undefined]) {
      const { MODEL_DEFAULTS, IMAGE_MODELS, emptyScenePlateRouting } = await loadModelsFor(env);
      const where = `env=${env ?? '(unset)'}`;
      expect(MODEL_DEFAULTS.emptyScenePlateModel, where).toBe('grok-imagine');
      expect(IMAGE_MODELS[MODEL_DEFAULTS.emptyScenePlateModel].modelId, where).toBe('grok-imagine-image');
      expect(emptyScenePlateRouting().imageModelOverride, where).toBe('grok-imagine');
    }
  });

  it('derives the plate backend from the registry, never a second literal', async () => {
    const { IMAGE_MODELS, emptyScenePlateRouting } = await loadModelsFor('staging');
    const routing = emptyScenePlateRouting();
    expect(routing.imageBackendOverride).toBe(IMAGE_MODELS[routing.imageModelOverride].backend);
    expect(routing.imageBackendOverride).toBe('grok');
  });

  it('does not follow the page tier on staging', async () => {
    // The whole point of the key: on staging the page is 2.0 and the plate is
    // not. If these ever match on staging, the plate has re-inherited the page.
    const { MODEL_DEFAULTS } = await loadModelsFor('staging');
    expect(MODEL_DEFAULTS.emptyScenePlateModel).not.toBe(MODEL_DEFAULTS.pageRenderImage);
  });
});

describe('keys that must not follow the page tier', () => {
  it('leaves the edit/inpaint tier on Standard in every environment', async () => {
    for (const env of ['staging', 'production', undefined]) {
      const { MODEL_DEFAULTS, IMAGE_MODELS } = await loadModelsFor(env);
      expect(IMAGE_MODELS[MODEL_DEFAULTS.pageImage].modelId, `env=${env ?? '(unset)'}`)
        .toBe('grok-imagine-image');
    }
  });

  it('leaves avatars on Standard in every environment', async () => {
    for (const env of ['staging', 'production', undefined]) {
      const { MODEL_DEFAULTS, IMAGE_MODELS } = await loadModelsFor(env);
      expect(IMAGE_MODELS[MODEL_DEFAULTS.avatar].modelId, `env=${env ?? '(unset)'}`)
        .toBe('grok-imagine-image');
    }
  });

  it('the 2x4 identity sheet hardcodes the Standard tier and cannot follow', async () => {
    // Both avatar passes name GROK_MODELS.STANDARD directly rather than
    // reading a MODEL_DEFAULTS key, so no config change can move them. Verified
    // here so the guarantee is not just a comment in this file.
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../../server/lib/character2x4Sheet.js', import.meta.url), 'utf8',
    );
    expect(src).toMatch(/model: GROK_MODELS\.STANDARD/);
    expect(src).not.toMatch(/pageRenderImage/);
  });
});

describe('runtime declaration', () => {
  it('reports the resolved tiers in the config snapshot', async () => {
    vi.resetModules();
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    // @ts-expect-error - JS module without types
    const { runtimeSnapshot } = await import('../../server/config/runtime.js');
    const snap = runtimeSnapshot();
    expect(snap.environment).toBe('staging');
    expect(snap.pageRenderModel).toBe('grok-imagine-2');
    expect(snap.coverRenderModel).toBe('grok-imagine-2');
  });

  it('defaults both tiers to grok-imagine outside staging', async () => {
    vi.resetModules();
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    // @ts-expect-error - JS module without types
    const { runtimeSnapshot } = await import('../../server/config/runtime.js');
    const snap = runtimeSnapshot();
    expect(snap.pageRenderModel).toBe('grok-imagine');
    expect(snap.coverRenderModel).toBe('grok-imagine');
  });
});
