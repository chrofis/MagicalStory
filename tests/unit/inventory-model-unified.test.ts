import { describe, it, expect, afterAll, vi } from 'vitest';

// Which vision model answers eval STAGE 1 — the blind visual inventory that
// every page's compliance judging, figure pairing and animal-completeness
// check is built on.
//
// From 2026-09-07 to 2026-09-19 this was a deliberate staged rollout:
// `perEnvironment({ default: 'gemini-2.5-flash', staging: 'qwen3-vl', local:
// 'qwen3-vl' })`. That split meant every staging measurement of stage 1
// described a model production did not run — 995 production stage-1 calls, all
// Gemini — so a staging audit of inventory quality was silently about the
// wrong model. The owner promoted Qwen to the default on 2026-09-19
// (docs/decisions.md).
//
// These tests pin the BEHAVIOUR that promotion bought — every environment
// resolves to the SAME stage-1 model — rather than the literal id, which is a
// routing choice that may change again. One test does name the id, because the
// promotion evidence (Lab exps 1038-1054, 1053/1054, 1060-1063) is about
// qwen3-vl specifically and a silent revert should be visible.

const ORIGINAL_ENV = process.env.RAILWAY_ENVIRONMENT_NAME;

/** Load a fresh copy of the model config as it resolves in `envName`. */
async function loadModelsFor(envName: string | undefined) {
  vi.resetModules();
  if (envName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
  else process.env.RAILWAY_ENVIRONMENT_NAME = envName;
  // @ts-expect-error - JS module without types
  return await import('../../server/config/models.js');
}

/** Load a fresh copy of the runtime config as it resolves in `envName`. */
async function loadRuntimeFor(envName: string | undefined) {
  vi.resetModules();
  if (envName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
  else process.env.RAILWAY_ENVIRONMENT_NAME = envName;
  // @ts-expect-error - JS module without types
  return await import('../../server/config/runtime.js');
}

const ENVIRONMENTS: (string | undefined)[] = ['production', 'staging', 'local', undefined];

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
  else process.env.RAILWAY_ENVIRONMENT_NAME = ORIGINAL_ENV;
  vi.resetModules();
});

describe('stage-1 inventory model', () => {
  it('resolves to the SAME model in every environment', async () => {
    const resolved: Record<string, string> = {};
    for (const env of ENVIRONMENTS) {
      const { runtime } = await loadRuntimeFor(env);
      resolved[env ?? '(unset)'] = runtime('inventoryModel');
    }
    const distinct = new Set(Object.values(resolved));
    expect(distinct.size, `stage-1 model differs per environment: ${JSON.stringify(resolved)}`).toBe(1);
  });

  it('is qwen3-vl everywhere since the 2026-09-19 promotion', async () => {
    for (const env of ENVIRONMENTS) {
      const { runtime } = await loadRuntimeFor(env);
      expect(runtime('inventoryModel'), `env=${env ?? '(unset)'}`).toBe('qwen3-vl');
    }
  });

  it('is what models.js hands the eval pipeline', async () => {
    // MODEL_DEFAULTS.inventoryModel is the value runVisualInventory reads; a
    // config change that does not reach it changes nothing.
    for (const env of ENVIRONMENTS) {
      const { MODEL_DEFAULTS } = await loadModelsFor(env);
      expect(MODEL_DEFAULTS.inventoryModel, `env=${env ?? '(unset)'}`).toBe('qwen3-vl');
    }
  });

  it('is reported in the /api/health/config snapshot', async () => {
    for (const env of ['production', 'staging']) {
      const { runtimeSnapshot } = await loadRuntimeFor(env);
      const snap = runtimeSnapshot();
      expect(snap.environment, `env=${env}`).toBe(env);
      expect(snap.inventoryModel, `env=${env}`).toBe('qwen3-vl');
    }
  });

  it('keeps the Gemini fallback on an OpenRouter failure', async () => {
    // The fallback is a PROVIDER-FAILURE path, not a second implementation:
    // qwen3-vl has one upstream, measured to stall 3 of 20 Lab pages once, and
    // the fallback fires at 2 of 814 production-shaped calls. Unifying the
    // default must not have removed it.
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../../server/lib/evalPipeline.js', import.meta.url), 'utf8',
    );
    expect(src).toMatch(/gemini-2\.5-flash/);
    expect(src).toMatch(/fallback/i);
  });
});

describe('remaining per-environment differences', () => {
  it('repairMaxPasses is the only one left', async () => {
    // runtime.js:118 claims this in a comment. Pin it, so the comment cannot
    // quietly become false the way the inventory split made it false.
    const perEnvKeys: string[] = [];
    const { SETTINGS } = await loadRuntimeFor('staging');
    for (const [name, value] of Object.entries(SETTINGS as Record<string, unknown>)) {
      if (value && typeof value === 'object' && (value as { __perEnv?: boolean }).__perEnv) {
        perEnvKeys.push(name);
      }
    }
    expect(perEnvKeys).toEqual(['repairMaxPasses']);
  });
});
