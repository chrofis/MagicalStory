/**
 * Pass 2 of the avatar 2×4 sheet is a STYLE TRANSFER, and its judge must not
 * score the outfit.
 *
 * The restyler prompt (buildStyleTransferPrompt) carries no costume argument —
 * the model is never told which garments to produce, only "keep Image 1's
 * content, change the medium". The Pass-2 judge nevertheless scored the
 * garments against the character's clothing description, and `finalScore` is a
 * MIN over the axes, so an outfit imperfection that Pass 1 already accepted at
 * its >= 6 gate sank the restyle by construction. A rejected Pass 2 ships the
 * PHOTOREAL Pass-1 sheet into a styled story.
 *
 * Owner ruling: remove the outfit axis from Pass 2. Garments stay Pass 1's
 * responsibility, where they are scored against a spec the generator was given.
 *
 * These pin BEHAVIOUR, not wording: the judged axis set, and what a verdict
 * built from that axis set does to the ship/reject decision.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = path.join(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const TEMPLATE = read('prompts/sheet-2x4-style-eval.txt');
const SRC = read('server/lib/character2x4Sheet.js');

/** The axes the template tells the judge to take finalScore as the MIN over. */
function declaredAxes(): string[] {
  const m = TEMPLATE.match(/`finalScore` MUST equal the LOWEST of ([^\n.]+)\./);
  if (!m) throw new Error('template no longer states how finalScore is computed');
  return m[1].split(',').map(s => s.trim().replace(/^and /, ''));
}

/** What the judge would return for a set of per-axis scores. */
function judgeVerdict(scores: Record<string, number>) {
  const axes = declaredAxes();
  const finalScore = Math.min(...axes.map(a => scores[a] ?? 10));
  return { ...scores, finalScore, valid: finalScore >= 6, failureReasons: [] };
}

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

/** Run the real Pass-2 loop with the backend stubbed and the judge returning
 *  a verdict computed from the real template's axis list. */
async function runPass2(scores: Record<string, number>) {
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
    evaluateAvatarSheet: async () => ({ verdict: judgeVerdict(scores) }),
    require: (id: string) => (id === '../config/models' ? { MODEL_PRICING: {} } : {}),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFunction(SRC, 'runStyleTransferPass')}\nmodule.exports = runStyleTransferPass;`,
    ctx
  );
  const fn = ctx.module.exports as (a: any) => Promise<any>;
  return fn({
    pass1ImageData: 'data:image/jpeg;base64,PASS1',
    facePhoto: 'data:image/jpeg;base64,FACE',
    artStyle: 'watercolor',
    characterName: 'TestChar',
    usageTracker: null,
    skipQualityEval: false,
  });
}

describe('Pass-2 style eval — the outfit axis is gone', () => {
  it('the template declares no outfit axis and asks for no clothing spec', () => {
    expect(declaredAxes()).not.toContain('outfitScore');
    expect(TEMPLATE).not.toMatch(/outfitScore/);
    expect(TEMPLATE).not.toMatch(/CLOTHING_DESCRIPTION/);
    expect(TEMPLATE).not.toMatch(/COSTUME PRESERVED/);
  });

  it('the axes it does judge are still the style-transfer ones', () => {
    expect(declaredAxes().sort()).toEqual([
      'ageScore', 'backgroundScore', 'bodyFaceScore', 'cleanScore', 'identityScore',
      'layoutScore', 'soloScore', 'styleScore',
    ]);
  });

  it('the evaluator no longer takes or injects a costume description', () => {
    const fn = extractFunction(SRC, 'evaluateStyledSheetWithGemini');
    expect(fn).not.toMatch(/costumeDescription/);
    expect(fn).not.toMatch(/CLOTHING_DESCRIPTION/);
    // …and nothing forwards one into the pass-2 branch of the single-source evaluator.
    expect(extractFunction(SRC, 'evaluateAvatarSheet')).toMatch(
      /evaluateStyledSheetWithGemini\([^)]*\{ model: model \|\| undefined, promptOverride: promptOverrides\?\.style \|\| null \}/s
    );
  });

  it('a styled sheet whose only weakness is the outfit SHIPS', async () => {
    const out = await runPass2({
      layoutScore: 9, identityScore: 9, styleScore: 9, cleanScore: 9,
      bodyFaceScore: 9, ageScore: 9, soloScore: 9,
      // The judge may still notice the garment; it is not an axis any more.
      outfitScore: 2,
    });
    expect(out.finalScore).toBe(9);
    expect(out.valid).toBe(true);
    expect(out.imageData).toContain('STYLED');
  });

  it('a genuine STYLE failure is still rejected', async () => {
    const out = await runPass2({
      layoutScore: 9, identityScore: 9, styleScore: 2, cleanScore: 9,
      bodyFaceScore: 9, ageScore: 9, soloScore: 9,
    });
    expect(out.finalScore).toBe(2);
    expect(out.valid).toBe(false);
  });

  it('the other axes still sink a bad restyle (identity, solo)', async () => {
    for (const axis of ['identityScore', 'soloScore', 'layoutScore', 'cleanScore', 'bodyFaceScore', 'ageScore']) {
      const scores: Record<string, number> = {
        layoutScore: 9, identityScore: 9, styleScore: 9, cleanScore: 9,
        bodyFaceScore: 9, ageScore: 9, soloScore: 9,
      };
      scores[axis] = 2;
      const out = await runPass2(scores);
      expect(out.valid, `${axis} must still be able to reject`).toBe(false);
    }
  });

  it('the echoed-judge guard reads the reasons the verdict carries, not a fixed axis list', () => {
    // One guard for all four sheet judges (tests/unit/sheet-judge-echo-guard.test.ts):
    // it collects every `.reason`, so a removed axis cannot linger in it.
    const fn = extractFunction(SRC, 'judgeReasons');
    expect(fn).not.toMatch(/'outfit'/);
  });
});
