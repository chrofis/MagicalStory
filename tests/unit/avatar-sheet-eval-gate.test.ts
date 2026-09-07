/**
 * Avatar 2×4 sheet eval gate (server/lib/character2x4Sheet.js).
 *
 * Regression origin: staging story job_1788763045123_z8so79ngb. A styled sheet
 * whose cells were merged into one crowd — the character overlapping two adults
 * who are not the character — was stored at 10/10 on every axis. No judge ever
 * ran on it: the run passed skipQualityEval, and every skip path minted a
 * perfect 10 instead of recording "unknown". Two contracts are guarded here:
 *
 *   1. a skipped eval scores null (unknown), never 10 — the sheet still ships,
 *      but nothing may read its scores as a verified pass;
 *   2. the body-row gate's recompute includes the solo (one-figure-per-cell)
 *      axis, so a merged-crowd verdict is rejected instead of scored and
 *      silently dropped.
 *
 * The module can't be require()'d (native sharp + side effects), so the REAL
 * function source is sliced out and run in an isolated vm with the backend and
 * the evaluator stubbed — same technique as tests/manual/avatarStyleAnchorRetry.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SRC = fs.readFileSync(
  path.join(__dirname, '../../server/lib/character2x4Sheet.js'),
  'utf8'
);

function extractFunction(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`);
  if (start === -1) start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find function ${name}`);
  let p = src.indexOf('(', start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') pdepth++;
    else if (src[p] === ')') { pdepth--; if (pdepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ── the pose/Gemini merge gate for the body row ────────────────────────────
function loadPoseHeadGate() {
  const ctx: any = { module: { exports: {} }, log: noopLog };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFunction(SRC, 'applyPoseHeadGate')}\nmodule.exports = applyPoseHeadGate;`,
    ctx
  );
  return ctx.module.exports as (bodies: any, poseHeads: any) => any;
}

const POSE_ALL_HEADS = { cells: [1, 2, 3, 4].map(() => ({ head: true, clipped: false })) };

function bodiesVerdict(overrides: Record<string, any> = {}) {
  return {
    fullBody: { headScore: 10, feetScore: 10, fullBodyScore: 10 },
    angles: { score: 9 },
    outfit: { outfitScore: 9 },
    costumeReads: { costumeReadsScore: 10 },
    proportions: { score: 9 },
    solo: { soloScore: 10 },
    background: { backgroundScore: 10 },
    finalScore: 9,
    valid: true,
    ...overrides,
  };
}

// ── Pass 2 style transfer, with the backend + evaluator stubbed ────────────
async function runPass2({ skipQualityEval }: { skipQualityEval: boolean }) {
  const calls = { evals: 0 };
  const ctx: any = {
    module: { exports: {} },
    log: noopLog,
    MAX_SHEET_RETRIES: 1,
    MODEL_DEFAULTS: { avatarStyleTransferBackend: 'grok' },
    process: { env: { GEMINI_API_KEY: 'test-key' } },
    loadStyleAnchor: () => null,
    buildStyleTransferPrompt: () => 'STYLE PROMPT',
    styleTransferGenerate: async () => ({
      imageData: 'data:image/jpeg;base64,STYLED',
      provider: 'grok',
      modelId: 'grok-imagine-image',
      usage: null,
    }),
    // Judges the sheet as corrupt whenever it is allowed to run.
    evaluateAvatarSheet: async () => {
      calls.evals++;
      return { verdict: { finalScore: 2, valid: false, soloScore: 2, failureReasons: ['solo: extra figures'] } };
    },
    require: (id: string) => (id === '../config/models' ? { MODEL_PRICING: {} } : {}),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFunction(SRC, 'runStyleTransferPass')}\nmodule.exports = runStyleTransferPass;`,
    ctx
  );
  const fn = ctx.module.exports as (a: any) => Promise<any>;
  const out = await fn({
    pass1ImageData: 'data:image/jpeg;base64,PASS1',
    facePhoto: 'data:image/jpeg;base64,FACE',
    artStyle: 'watercolor',
    characterName: 'TestChar',
    usageTracker: null,
    skipQualityEval,
  });
  return { out, calls };
}

describe('avatar sheet gate — a skipped eval is unknown, not a pass', () => {
  it('Pass 2 with skipQualityEval records score null and evaluated:false', async () => {
    const { out, calls } = await runPass2({ skipQualityEval: true });
    expect(calls.evals).toBe(0);
    expect(out.finalScore).toBeNull();
    expect(out.attempts[0].score).toBeNull();
    expect(out.attempts[0].evaluated).toBe(false);
    expect(out.attempts[0].stage).toBe('no-eval-requested');
    // Fail-open: the sheet still ships, it is simply unjudged.
    expect(out.valid).toBe(true);
    expect(out.imageData).toContain('STYLED');
  });

  it('a skipped eval never reports a passing score', async () => {
    const { out } = await runPass2({ skipQualityEval: true });
    expect(out.finalScore).not.toBe(10);
    expect(typeof out.finalScore).not.toBe('number');
  });

  it('with the eval ON, a corrupt sheet is rejected, not shipped as valid', async () => {
    const { out, calls } = await runPass2({ skipQualityEval: false });
    expect(calls.evals).toBeGreaterThan(0);
    expect(out.finalScore).toBe(2);
    expect(out.valid).toBe(false);
  });
});

describe('avatar sheet gate — body-row solo axis is scored', () => {
  it('a merged-crowd row (soloScore 2) fails the recomputed gate', () => {
    const gate = loadPoseHeadGate();
    const bodies = gate(bodiesVerdict({ solo: { soloScore: 2, reason: 'two adults blended across the cells' } }), POSE_ALL_HEADS);
    expect(bodies.finalScore).toBe(2);
    expect(bodies.valid).toBe(false);
  });

  it('a clean row still passes', () => {
    const gate = loadPoseHeadGate();
    const bodies = gate(bodiesVerdict(), POSE_ALL_HEADS);
    expect(bodies.finalScore).toBe(9);
    expect(bodies.valid).toBe(true);
  });

  it('a missing solo axis does not crash the gate (older verdict shape)', () => {
    const gate = loadPoseHeadGate();
    const v = bodiesVerdict();
    delete (v as any).solo;
    const bodies = gate(v, POSE_ALL_HEADS);
    expect(bodies.finalScore).toBe(9);
  });
});
