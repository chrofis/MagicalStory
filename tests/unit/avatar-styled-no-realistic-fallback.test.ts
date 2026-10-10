/**
 * Styled 2×4 sheet: no realistic fallback (server/lib/character2x4Sheet.js).
 *
 * Owner, 2026-09-24: when the Pass-2 styled sheet fails its style judge on both
 * attempts, ship the BETTER styled attempt (by the judge's final score) with a
 * warning — never the realistic Pass-1 sheet, which makes that child look
 * unlike the art style of the rest of the book. Two exceptions, both loud:
 *   - an attempt the judge failed on IDENTITY (identity or solo axis: a
 *     different person, or extra people painted in) never ships;
 *   - if no attempt produced pixels, or every one failed identity, the sheet
 *     generation throws. There is no Pass-1 substitute.
 *
 * The module can't be require()'d (native sharp + side effects), so the REAL
 * function sources are sliced out and run in an isolated vm with the
 * generator, the judge and Pass 1 stubbed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/character2x4Sheet.js'), 'utf8');

function extractFunction(src: string, name: string): string {
  const start = [`async function ${name}(`, `function ${name}(`].map(n => src.indexOf(n)).find(i => i !== -1) ?? -1;
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

// The real module constants, not copies.
const CONSTS = [/const SHEET_VALID_MIN = [^;]+;/, /const STYLED_BLOCK_BELOW = [^;]+;/]
  .map(re => { const m = SRC.match(re); if (!m) throw new Error(`constant not found: ${re}`); return m[0]; })
  .join('\n');

type Attempt = 'throw' | Record<string, number> | 'eval-throw';

function verdictOf(scores: Record<string, number>) {
  const finalScore = Math.min(...Object.values(scores));
  const failureReasons = Object.entries(scores).filter(([, v]) => v < 6).map(([k]) => `${k.replace('Score', '')}: low`);
  return { ...scores, finalScore, valid: finalScore >= 6, failureReasons };
}

const GOOD = { layoutScore: 9, identityScore: 9, styleScore: 9, cleanScore: 9, bodyFaceScore: 9, ageScore: 9, soloScore: 9, backgroundScore: 9 };

function makeCtx(attempts: Attempt[]) {
  const calls = { gens: 0, warns: [] as string[] };
  const ctx: any = {
    module: { exports: {} },
    log: { info() {}, debug() {}, error() {}, warn(m: string) { calls.warns.push(m); } },
    MAX_SHEET_RETRIES: attempts.length - 1, SHEET_HARD_FAIL_MAX: 3, hardFailFeedback: () => [], buildFedBackPrompt: (p: string) => p,
    MODEL_DEFAULTS: { avatarStyleTransferBackend: 'grok' },
    process: { env: { GEMINI_API_KEY: 'k' } },
    hairRequest: () => '',
    loadStyleAnchor: () => null,
    buildStyleTransferPrompt: () => 'P',
    quickLayoutCheck: async () => ({ valid: true }),
    styleTransferGenerate: async () => {
      calls.gens++;
      if (attempts[calls.gens - 1] === 'throw') throw new Error('backend down');
      return { imageData: `STYLED_${calls.gens}`, provider: 'grok', modelId: 'm', usage: null };
    },
    evaluateAvatarSheet: async () => {
      const a = attempts[calls.gens - 1];
      if (a === 'eval-throw') throw new Error('judge down');
      return { verdict: verdictOf(a as Record<string, number>), promptUsed: 'J' };
    },
    require: (id: string) => (id === '../config/models' ? { MODEL_PRICING: {} } : {}),
  };
  ctx.globalThis = ctx;
  return { ctx, calls };
}

async function runPass2(attempts: Attempt[]) {
  const { ctx, calls } = makeCtx(attempts);
  vm.createContext(ctx);
  vm.runInContext(`${CONSTS}\n${extractFunction(SRC, 'blockingAxesOf')}
${extractFunction(SRC, 'runStyleTransferPass')}\nmodule.exports = runStyleTransferPass;`, ctx);
  const out = await ctx.module.exports({
    pass1ImageData: 'PASS1', facePhoto: 'FACE', artStyle: 'watercolor', characterName: 'Kid', usageTracker: null,
  });
  return { out, calls };
}

// generateCharacter2x4Sheet with Pass 1 stubbed and Pass 2 = the real
// runStyleTransferPass over the given attempts.
async function runSheet(attempts: Attempt[], artStyle = 'watercolor') {
  const { ctx, calls } = makeCtx(attempts);
  Object.assign(ctx, {
    resolveFacePhoto: async () => 'FACE',
    resolveStandardAvatar: async () => 'STD',
    generateComposited2x4: async () => ({
      imageData: 'PASS1_REALISTIC',
      verdictPromise: Promise.resolve({ verdict: { finalScore: 9, valid: true, layout: {}, identity: {}, outfit: {} }, judgePrompts: null }),
      attemptHistory: [], prompt: 'P1', usage: null, refs: {},
    }),
  });
  vm.createContext(ctx);
  vm.runInContext(
    `${CONSTS}\n${extractFunction(SRC, 'blockingAxesOf')}
${extractFunction(SRC, 'runStyleTransferPass')}\n${extractFunction(SRC, 'generateCharacter2x4Sheet')}\nmodule.exports = generateCharacter2x4Sheet;`,
    ctx
  );
  const out = await ctx.module.exports({ name: 'Kid', age: 6 }, { artStyle });
  return { out, calls };
}

describe('runStyleTransferPass — which styled attempt ships', () => {
  it('both attempts fail only NON-blocking axes → the higher-scoring one ships, flagged invalid', async () => {
    const { out } = await runPass2([{ ...GOOD, styleScore: 4 }, { ...GOOD, cleanScore: 5 }]);
    expect(out.shippable).toBe(true);
    expect(out.valid).toBe(false);
    expect(out.imageData).toBe('STYLED_2');
    expect(out.finalScore).toBe(5);
  });

  // docs/decisions.md 2026-10-10: background, extra people and a photographic look BLOCK like identity.
  it('Julian regression: solo 9 / background 3 outranks nothing - the unblocked attempt 2 ships', async () => {
    // attempt 1 scores higher overall on solo but its ground is painted; attempt 2 is clean but lower overall
    const { out } = await runPass2([{ ...GOOD, backgroundScore: 3 }, { ...GOOD, styleScore: 4 }]);
    expect(out.shippable).toBe(true);
    expect(out.imageData).toBe('STYLED_2');
    expect(out.attempts[0].identityRejected).toBe(true);
    expect(out.attempts[1].identityRejected).toBe(false);
  });

  it('a photographic sheet (style 1-3) is blocked and never beats an unblocked one', async () => {
    const { out } = await runPass2([{ ...GOOD, styleScore: 2 }, { ...GOOD, cleanScore: 4 }]);
    expect(out.imageData).toBe('STYLED_2');
    expect(out.attempts[0].identityRejected).toBe(true);
  });

  it.each([['background', 5], ['style', 3], ['solo', 5]])('every attempt blocked on %s → not shippable', async (axis, v) => {
    const { out } = await runPass2([{ ...GOOD, [`${axis}Score`]: v }, { ...GOOD, [`${axis}Score`]: v }]);
    expect(out.shippable).toBe(false);
    expect(out.identityFailing).toEqual([axis]);
  });

  it('an identity-failed attempt never ships, even when it outscores the other', async () => {
    const { out } = await runPass2([{ ...GOOD, identityScore: 5 }, { ...GOOD, styleScore: 4 }]);
    expect(out.shippable).toBe(true);
    expect(out.imageData).toBe('STYLED_2');
    expect(out.attempts[0].identityRejected).toBe(true);
  });

  it('extra people painted in (solo) counts as an identity failure', async () => {
    const { out } = await runPass2([{ ...GOOD, soloScore: 1 }, { ...GOOD, soloScore: 2, styleScore: 4 }]);
    expect(out.shippable).toBe(false);
    expect(out.identityFailing).toEqual(['solo']);
    // the rejected sheet is still returned for the dev panel / Test Lab
    expect(out.imageData).toBe('STYLED_2');
  });

  it('an unscored attempt (judge threw) ranks below a judged, identity-verified one', async () => {
    const { out } = await runPass2(['eval-throw', { ...GOOD, styleScore: 4 }]);
    expect(out.imageData).toBe('STYLED_2');
    expect(out.finalScore).toBe(4);
    expect(out.attempts[0].score).toBeNull();
  });

  it('a passing attempt stops the loop and ships valid', async () => {
    const { out, calls } = await runPass2([GOOD, GOOD]);
    expect(calls.gens).toBe(1);
    expect(out.valid).toBe(true);
    expect(out.shippable).toBe(true);
  });
});

describe('generateCharacter2x4Sheet — never ships the realistic sheet in a styled story', () => {
  it('rejected on a non-blocking axis on both attempts → ships the best STYLED attempt with a warning', async () => {
    const { out, calls } = await runSheet([{ ...GOOD, styleScore: 4 }, { ...GOOD, cleanScore: 5 }]);
    expect(out.imageData).toBe('STYLED_2');
    expect(out.imageData).not.toBe('PASS1_REALISTIC');
    expect(out.styleJudgeRejected).toBe(true);
    expect(out.styleJudgeReasons.length).toBeGreaterThan(0);
    expect(out.finalScore).toBe(5);
    expect(out.realisticImageData).toBe('PASS1_REALISTIC');
    expect(calls.warns.some(w => /shipping the best styled attempt/.test(w))).toBe(true);
  });

  it('a passing styled sheet ships without the flag', async () => {
    const { out } = await runSheet([GOOD]);
    expect(out.imageData).toBe('STYLED_1');
    expect(out.styleJudgeRejected).toBe(false);
  });

  it('every attempt fails IDENTITY → throws; Pass 1 is not a substitute', async () => {
    await expect(runSheet([{ ...GOOD, identityScore: 2 }, { ...GOOD, identityScore: 3 }]))
      .rejects.toThrow(/was BLOCKED \(identity/);
  });

  it('no attempt produced an image → throws; Pass 1 is not a substitute', async () => {
    await expect(runSheet(['throw', 'throw'])).rejects.toThrow(/produced no image/);
  });

  it('realistic art style still ships the Pass-1 sheet (no style transfer wanted)', async () => {
    const { out, calls } = await runSheet([GOOD], 'realistic');
    expect(calls.gens).toBe(0);
    expect(out.imageData).toBe('PASS1_REALISTIC');
    expect(out.styleJudgeRejected).toBe(false);
  });
});
