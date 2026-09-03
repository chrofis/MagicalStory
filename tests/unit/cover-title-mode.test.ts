import { describe, it, expect, afterAll, vi } from 'vitest';

// WHICH COVER-TITLE MODE a cover renders in — the ONE resolver shared by every
// cover path.
//
// `runtime('coverTitleMode')` has two values (decisions.md 2026-08-29):
//   'composited' (production) — art renders TEXTLESS and coverTypography stamps
//      the title from a real font. Two image calls; spelling safe by construction.
//   'baked' (staging) — ONE typography-aware call renders the artwork WITH the
//      title in it, on runtime('coverTitleBakedModel'), and the app-side
//      typography pass MUST NOT run.
//
// The flag used to be read ONLY inside iterateCover (post-generation repaints),
// so a FIRST-GENERATION cover never baked anything: staging shipped composited
// covers while the flag said baked. Wiring the first-gen paths meant three
// consumers had to agree — the prompt's TITLE block, the render model, and the
// typography skip — which is why the decision lives in one function instead of
// being re-derived per call site. Getting the third one wrong is how Lab exps
// 957/958 produced ten covers carrying TWO titles.
//
// Invariants under test:
//   staging + front       → baked, title text, baked model
//   staging + back/initial→ two-pass (no title exists on those covers)
//   production (default)  → two-pass everywhere, byte-identical to before
//   empty story title     → two-pass (nothing to paint; never `Paint ""`)
//   modeOverride          → wins over the environment (Test Lab arms)

const ORIGINAL_ENV = process.env.RAILWAY_ENVIRONMENT_NAME;

/** Load a fresh copy of the resolver as it behaves in `envName`. */
async function loadResolverFor(envName: string | undefined) {
  vi.resetModules();
  if (envName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
  else process.env.RAILWAY_ENVIRONMENT_NAME = envName;
  // @ts-expect-error - JS module without types
  const mod = await import('../../server/lib/coverTypography.js');
  return mod.resolveCoverTitleMode as (
    coverType: string,
    title: string | null | undefined,
    opts?: { modeOverride?: string | null }
  ) => { mode: string; isFront: boolean; baked: boolean; bakeTitle: string; bakedModel: string | null };
}

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
  else process.env.RAILWAY_ENVIRONMENT_NAME = ORIGINAL_ENV;
  vi.resetModules();
});

describe('resolveCoverTitleMode — staging (baked)', () => {
  it('bakes the front cover: title text, baked model, typography skipped', async () => {
    const resolve = await loadResolverFor('staging');
    const r = resolve('frontCover', 'Fiona und der Feigenbaum');
    expect(r.mode).toBe('baked');
    expect(r.baked).toBe(true);
    expect(r.bakeTitle).toBe('Fiona und der Feigenbaum');
    // The typography-aware tier — the standard model renders flat outline type.
    expect(r.bakedModel).toBe('grok-imagine-2');
  });

  it('accepts both cover-type spellings for the front cover', async () => {
    const resolve = await loadResolverFor('staging');
    // The pipeline speaks 'frontCover', iterateCover normalizes to 'front'.
    expect(resolve('front', 'A Title').baked).toBe(true);
    expect(resolve('frontCover', 'A Title').baked).toBe(true);
  });

  it('never bakes the back cover or the initial page', async () => {
    const resolve = await loadResolverFor('staging');
    for (const key of ['back', 'backCover', 'initialPage']) {
      const r = resolve(key, 'A Title');
      expect(r.isFront).toBe(false);
      expect(r.baked).toBe(false);
      expect(r.bakeTitle).toBe('');
      // No model override: these keep the routed cover model.
      expect(r.bakedModel).toBeNull();
    }
  });

  it('falls back to two-pass when the story has no title', async () => {
    const resolve = await loadResolverFor('staging');
    // `Paint ""` is the exact bug the retired {STORY_TITLE} placeholder caused:
    // the model is asked to paint an empty string and the cover ships titleless.
    for (const t of ['', '   ', null, undefined]) {
      const r = resolve('frontCover', t as any);
      expect(r.baked).toBe(false);
      expect(r.bakeTitle).toBe('');
      expect(r.bakedModel).toBeNull();
    }
  });
});

describe('resolveCoverTitleMode — production / local (composited)', () => {
  it('is two-pass for every cover, front included', async () => {
    for (const env of [undefined, 'production']) {
      const resolve = await loadResolverFor(env);
      for (const key of ['front', 'frontCover', 'backCover', 'initialPage']) {
        const r = resolve(key, 'Fiona und der Feigenbaum');
        expect(r.mode).toBe('composited');
        expect(r.baked).toBe(false);
        // Empty bakeTitle == buildCoverPrompt appends no TITLE block, and the
        // render keeps the routed cover model: the path is unchanged.
        expect(r.bakeTitle).toBe('');
        expect(r.bakedModel).toBeNull();
      }
    }
  });
});

describe('resolveCoverTitleMode — Test Lab overrides', () => {
  it('forces baked in a composited environment', async () => {
    const resolve = await loadResolverFor('production');
    const r = resolve('frontCover', 'A Title', { modeOverride: 'baked' });
    expect(r.baked).toBe(true);
    expect(r.bakedModel).toBe('grok-imagine-2');
  });

  it('forces composited in a baked environment', async () => {
    const resolve = await loadResolverFor('staging');
    const r = resolve('frontCover', 'A Title', { modeOverride: 'composited' });
    expect(r.baked).toBe(false);
    expect(r.bakeTitle).toBe('');
  });

  it('an absent override defers to the environment', async () => {
    const resolve = await loadResolverFor('staging');
    expect(resolve('frontCover', 'A Title', { modeOverride: null }).baked).toBe(true);
    expect(resolve('frontCover', 'A Title', {}).baked).toBe(true);
  });
});
