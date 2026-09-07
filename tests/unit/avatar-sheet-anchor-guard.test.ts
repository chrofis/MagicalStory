/**
 * Avatar 2×4 Pass-2 anchor contamination guard (server/lib/character2x4Sheet.js).
 *
 * Origin: staging story job_1788763045123_z8so79ngb. Pass 1 produced a clean
 * 8-cell realistic sheet; Pass 2 came back as ONE merged crowd carrying the
 * three figures painted in server/assets/style-anchor-watercolor.jpg (a boy, a
 * woman and an elderly man). Every page then received a geometric slice of that
 * crowd as the child's identity reference — four pages a headless torso.
 *
 * The anchor blend has been a known Grok failure mode since 2026-08-20. Both
 * defences written for it then — reject-and-fall-back-to-Pass-1, and a retry
 * that drops the anchor — hang off the Gemini verdict, and a trial passes
 * skipQualityEval, so neither could ever fire. Two contracts are guarded here:
 *
 *   1. the anchor is not attached at all when nothing can judge or retry the
 *      result (skipQualityEval, or no GEMINI_API_KEY);
 *   2. a styled sheet that fails the deterministic gutter check is LOUD
 *      (log.error) and carries layoutValid:false into the audit record — but
 *      never decides the outcome: docs/image-routing.md measured painterly
 *      false-positives and forbids wiring quickLayoutCheck as a Pass-2 gate.
 *
 * The module can't be require()'d (native sharp + side effects), so the REAL
 * function source is sliced out and run in an isolated vm with the backend, the
 * evaluator and the layout check stubbed.
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

interface Opts {
  skipQualityEval?: boolean;
  geminiKey?: boolean;
  layoutValid?: boolean | boolean[] | 'throw';
  evalValid?: boolean;
}

async function runPass2(opts: Opts = {}) {
  const {
    skipQualityEval = false,
    geminiKey = true,
    layoutValid = true,
    evalValid = true,
  } = opts;
  const calls = { evals: 0, layoutChecks: 0, errors: [] as string[], refs: [] as boolean[] };
  const layoutSeq = Array.isArray(layoutValid) ? layoutValid.slice() : null;
  const ctx: any = {
    module: { exports: {} },
    log: {
      info() {}, warn() {}, debug() {},
      error(m: string) { calls.errors.push(m); },
    },
    MAX_SHEET_RETRIES: 1,
    MODEL_DEFAULTS: { avatarStyleTransferBackend: 'grok' },
    process: { env: geminiKey ? { GEMINI_API_KEY: 'test-key' } : {} },
    loadStyleAnchor: () => 'data:image/jpeg;base64,ANCHOR',
    buildStyleTransferPrompt: (_s: string, o: any) => (o?.hasAnchor ? 'PROMPT WITH ANCHOR' : 'PROMPT NO ANCHOR'),
    styleTransferGenerate: async (_p: string, _sheet: string, _b: any, anchor: any) => {
      calls.refs.push(!!anchor);
      return {
        imageData: 'data:image/jpeg;base64,STYLED',
        provider: 'grok',
        modelId: 'grok-imagine-image',
        usage: null,
      };
    },
    quickLayoutCheck: async () => {
      calls.layoutChecks++;
      if (layoutValid === 'throw') throw new Error('sharp failed');
      const ok = layoutSeq ? (layoutSeq.shift() ?? true) : (layoutValid as boolean);
      return ok ? { valid: true } : { valid: false, reason: 'mid-row gutter only 15.8% uniform' };
    },
    evaluateAvatarSheet: async () => {
      calls.evals++;
      return { verdict: { finalScore: evalValid ? 9 : 2, valid: evalValid, failureReasons: evalValid ? [] : ['identity'] } };
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

describe('Pass 2 style anchor — never attached when nothing can judge the result', () => {
  it('a trial run (skipQualityEval) sends the sheet WITHOUT the anchor', async () => {
    const { out, calls } = await runPass2({ skipQualityEval: true });
    expect(calls.refs).toEqual([false]);
    expect(out.attempts[0].usedAnchor).toBe(false);
    expect(calls.evals).toBe(0);
  });

  it('a run with no GEMINI_API_KEY also sends it without the anchor', async () => {
    const { calls } = await runPass2({ geminiKey: false });
    expect(calls.refs).toEqual([false]);
  });

  it('a judged run keeps the anchor on attempt 1 and drops it on the retry', async () => {
    const { calls } = await runPass2({ evalValid: false });
    expect(calls.refs).toEqual([true, false]);
  });
});

describe('Pass 2 structural check — loud, and only loud', () => {
  it('a failed gutter check log.errors and is recorded on the attempt', async () => {
    const { out, calls } = await runPass2({ skipQualityEval: true, layoutValid: false });
    expect(calls.errors.join(' ')).toContain('FAILED the structural check');
    expect(out.attempts[0].layoutValid).toBe(false);
  });

  it('it does NOT gate the sheet — a judged pass still ships (no painterly false-positive rejection)', async () => {
    const { out } = await runPass2({ layoutValid: false, evalValid: true });
    expect(out.valid).toBe(true);
    expect(out.finalScore).toBe(9);
    expect(out.imageData).toContain('STYLED');
  });

  it('the Gemini verdict still decides: a rejected sheet is rejected', async () => {
    const { out } = await runPass2({ layoutValid: true, evalValid: false });
    expect(out.valid).toBe(false);
  });

  it('a check that throws leaves layout unknown, never a pass or a rejection', async () => {
    const { out } = await runPass2({ skipQualityEval: true, layoutValid: 'throw' as any });
    expect(out.attempts[0].layoutValid).toBeNull();
    expect(out.valid).toBe(true);
  });

  it('a clean sheet is unaffected — it ships as before', async () => {
    const { out, calls } = await runPass2({ skipQualityEval: true });
    expect(out.valid).toBe(true);
    expect(out.imageData).toContain('STYLED');
    expect(calls.layoutChecks).toBe(1);
  });
});
