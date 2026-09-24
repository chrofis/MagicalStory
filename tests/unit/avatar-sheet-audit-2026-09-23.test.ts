/**
 * Styled-avatar audit fixes (docs/audits/prompt-audit-2026-09-23/06-avatars.md),
 * measured on staging job_1790100385959_1nitlympp:
 *
 *  S2-3  the head row came back waist/hip/knee-length and the heads judge was
 *        told a bit of torso "is fine" — generator and judge now both ask for a
 *        head-and-shoulders crop, and the judge scores it (cropScore).
 *  S2-4  invented polo collars: the "no collar the costume does not name" line
 *        lived only in the dead single-call builder — now in both live rows.
 *  S2-5  pass 2 painted washes behind the figures and dropped the dividers on
 *        6/6 sheets with no prompt or judge covering it — one SHEET_GROUND_RULE
 *        is stated to the restyler and scored by the style judge.
 *  S3-2  pass-2 hair shift / cheek blotches were judged against the photo —
 *        now against the approved pass-1 sheet (consistency, not accuracy).
 *  S3-3  heads/identity/style finals were the model's own number; bodies was
 *        recomputed in code — all four are computed from sub-scores now.
 *  S2-2  the watercolour anchor carries pencil outlines the style text forbids —
 *        the anchor line says the style text wins.
 *  S4    the Lab override for avatar_eval replaced two judge templates at once
 *        and prefilled a whole-sheet judge production never ran.
 *
 * Behaviour is pinned (built prompts, computed verdicts, what a judge is sent),
 * not template wording.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = path.join(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const { loadPromptTemplates } = require('../../server/services/prompts');
const sheetMod = require('../../server/lib/character2x4Sheet');
const sheet = { ...sheetMod, ...sheetMod._internal };

const ROW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';

describe('generator: the live rows carry the crop and the no-invented-trim rule', () => {
  const c = { name: 'A', age: 5, physical: {} };

  it('the head row asks for a head-and-shoulders crop that ends at the upper chest', () => {
    const p = sheet.buildHeadRowPrompt(c, 'a red long-sleeve shirt', true);
    expect(p).toMatch(/cut off at the upper chest/);
    expect(p).not.toMatch(/a little of the shoulders and collar showing is good/);
  });

  it('both rows forbid a collar the costume does not name (redress: the costume is the whole outfit)', () => {
    const rule = sheet.buildUnnamedTrimRule(true);
    expect(sheet.buildBodyRowPrompt('a red long-sleeve shirt', c, true, null)).toContain(rule);
    expect(sheet.buildHeadRowPrompt(c, 'a red long-sleeve shirt', true)).toContain(rule);
  });

  it('without a redress the body reference is part of the outfit, so what it shows is not invented', () => {
    const plain = sheet.buildUnnamedTrimRule(false);
    expect(plain).not.toBe(sheet.buildUnnamedTrimRule(true));
    expect(plain).toMatch(/body reference/);
    expect(sheet.buildBodyRowPrompt('standard outfit', c, false, null)).toContain(plain);
  });

  it('pass 2 states the ground rule, keeps hair and skin as Image 1, and lets the style text beat the swatch', () => {
    const withAnchor = sheet.buildStyleTransferPrompt('watercolor', { hasAnchor: true });
    const noAnchor = sheet.buildStyleTransferPrompt('watercolor', { hasAnchor: false });
    for (const p of [withAnchor, noAnchor]) {
      expect(p).toContain(sheet.SHEET_GROUND_RULE);
      expect(p).toMatch(/Hair colour and skin tone stay as Image 1 shows them/);
    }
    expect(withAnchor).toMatch(/Where Image 2 and the style text above disagree, the style text wins/);
    expect(noAnchor).not.toMatch(/Image 2/);
  });
});

describe('critic: the judges are sent what the generator was told', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
  beforeAll(async () => { await loadPromptTemplates(); });

  const capture = (verdict: object) => {
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      sent.push(body.contents[0].parts.map((p: any) => p.text || '').join('\n'));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] }, finishReason: 'STOP' }], usageMetadata: {} }), text: async () => '' };
    }) as any;
    return sent;
  };

  it('the heads judge no longer waives torso and scores the crop', async () => {
    const sent = capture({ angles: { score: 9, reason: 'cell1: front' }, cleanRender: { cleanScore: 9, reason: 'none' }, coverage: { coverageScore: 9, reason: 'red crew neck' }, solo: { soloScore: 9, reason: 'one each' }, crop: { cropScore: 9, reason: 'upper chest in all' } });
    await sheet.evaluateSheetRow(ROW, 'heads', { costumeDescription: 'a red shirt' });
    expect(sent[0]).not.toMatch(/torso in a cell is fine/);
    expect(sent[0]).toMatch(/cropScore/);
  });

  it('the style judge is sent the same ground rule the restyler got, and scores it', async () => {
    const sent = capture({ layoutScore: 9, identityScore: 9, styleScore: 9, cleanScore: 9, bodyFaceScore: 9, ageScore: 9, soloScore: 9, backgroundScore: 9, layout: { score: 9, reason: 'cell1: front, head' } });
    const { report, promptUsed } = await sheet.evaluateStyledSheetWithGemini(ROW, ROW, ROW, 'watercolor', 'k', null, 5);
    expect(promptUsed).toContain(sheet.SHEET_GROUND_RULE);
    expect(sent[0]).toContain(sheet.SHEET_GROUND_RULE);
    expect(sent[0]).toMatch(/backgroundScore/);
    expect(report.finalScore).toBe(9);
  });

  it('the style judge compares hair and skin to the approved pass-1 sheet, not the photo', async () => {
    const sent = capture({ layoutScore: 9, identityScore: 9, styleScore: 9, cleanScore: 9, bodyFaceScore: 9, ageScore: 9, soloScore: 9, backgroundScore: 9 });
    await sheet.evaluateStyledSheetWithGemini(ROW, ROW, ROW, 'watercolor', 'k', null, 5);
    expect(sent[0]).toMatch(/Hair colour, hair length and skin tone match Image 2/);
    expect(sent[0]).toMatch(/against the same cell of Image 2/);
    expect(sent[0]).not.toMatch(/natural colouring in Image 1/);
  });
});

describe('every sheet judge\'s final is computed from its sub-scores', () => {
  it('heads: a failing crop sinks a verdict the model scored 9', () => {
    const r = sheet.scoreHeadsReport({
      angles: { score: 9, reason: 'a' }, cleanRender: { cleanScore: 9, reason: 'b' },
      coverage: { coverageScore: 9, reason: 'c' }, solo: { soloScore: 10, reason: 'd' },
      crop: { cropScore: 2, reason: 'cell1: hips; cell2: hips; cell3: knees; cell4: waist' },
      finalScore: 9, valid: true, failureReasons: [],
    });
    expect(r.finalScore).toBe(2);
    expect(r.valid).toBe(false);
    expect(r.failureReasons.join(' ')).toMatch(/^crop: cell1: hips/);
  });

  it('heads: a model final LOWER than its sub-scores is corrected upward too', () => {
    const r = sheet.scoreHeadsReport({ angles: { score: 9 }, cleanRender: { cleanScore: 9 }, coverage: { coverageScore: 8 }, solo: { soloScore: 9 }, crop: { cropScore: 9 }, finalScore: 3, valid: false });
    expect(r.finalScore).toBe(8);
    expect(r.valid).toBe(true);
  });

  it('a verdict with no sub-score at all is no verdict — it throws (callers record it unjudged)', () => {
    expect(() => sheet.scoreHeadsReport({ finalScore: 10, valid: true })).toThrow(/no sub-scores/);
    expect(() => sheet.scoreStyleReport({ finalScore: 10 })).toThrow(/no sub-scores/);
  });

  it('style: the background axis counts, and the nested {score} shape is read when the flat field is missing', () => {
    const r = sheet.scoreStyleReport({
      layoutScore: 9, identityScore: 9, styleScore: 9, cleanScore: 9, bodyFaceScore: 9, ageScore: 9, soloScore: 9,
      background: { score: 4, reason: 'blue wash behind every figure, dividers gone' },
      finalScore: 9, valid: true, failureReasons: [],
    });
    expect(r.backgroundScore).toBe(4);
    expect(r.finalScore).toBe(4);
    expect(r.valid).toBe(false);
    expect(r.failureReasons.join(' ')).toMatch(/background: blue wash/);
  });

  it('identity: the score is the lowest cell', () => {
    expect(sheet.scoreIdentityReport({ perCell: { cell1: 9, cell2: 9, cell3: 5, cell4: 9 }, identityScore: 9 }).identityScore).toBe(5);
  });
});

describe('Test Lab mirrors production', () => {
  it('an override names ONE judge; a judge the pass does not run is refused', async () => {
    await expect(sheet.evaluateAvatarSheet(ROW, { pass: 1, promptOverrides: { style: 'x' } })).rejects.toThrow(/pass 1 has no style judge/);
    await expect(sheet.evaluateAvatarSheet(ROW, { pass: 2, promptOverrides: { heads: 'x' } })).rejects.toThrow(/pass 2 has no heads judge/);
  });

  it('the prefills load only templates production runs', () => {
    const route = read('server/routes/admin/testlab.js');
    expect(route).not.toMatch(/'sheet2x4Evaluation'|'styledCostumedAvatar'/);
    for (const key of ['sheetRowHeadsEval', 'sheetRowBodiesEval', 'sheetRowIdentityEval', 'sheet2x4StyleEval']) {
      expect(route).toContain(`'${key}'`);
    }
    expect(fs.existsSync(path.join(root, 'prompts/sheet-2x4-evaluation.txt'))).toBe(false);
    expect(sheetMod.buildPrompt).toBeUndefined();
    expect(sheetMod._internal.evaluateSheetWithGemini).toBeUndefined();
  });
});

describe('the pass-2 judge prompt is stored with the pass', () => {
  const SRC = read('server/lib/character2x4Sheet.js');
  function extractFunction(src: string, name: string): string {
    const start = src.indexOf(`async function ${name}(`);
    let p = src.indexOf('(', start); let pd = 0;
    for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')') { pd--; if (pd === 0) { p++; break; } } }
    let i = src.indexOf('{', p); let d = 0;
    for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
    return src.slice(start, i);
  }

  it('runStyleTransferPass returns the prompt its judge was sent', async () => {
    const noop = { info() {}, warn() {}, error() {}, debug() {} };
    const ctx: any = {
      module: { exports: {} }, log: noop, MAX_SHEET_RETRIES: 1, SHEET_VALID_MIN: 6, STYLED_IDENTITY_AXES: ['identity', 'solo'],
      MODEL_DEFAULTS: { avatarStyleTransferBackend: 'grok' },
      process: { env: { GEMINI_API_KEY: 'k' } },
      loadStyleAnchor: () => null,
      buildStyleTransferPrompt: () => 'STYLE PROMPT',
      quickLayoutCheck: async () => ({ valid: true }),
      styleTransferGenerate: async () => ({ imageData: 'data:image/jpeg;base64,S', provider: 'grok', modelId: 'm', usage: null }),
      evaluateAvatarSheet: async () => ({ verdict: { finalScore: 9, valid: true, failureReasons: [] }, promptUsed: 'THE JUDGE PROMPT' }),
      require: () => ({ MODEL_PRICING: {} }),
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(`${extractFunction(SRC, 'runStyleTransferPass')}\nmodule.exports = runStyleTransferPass;`, ctx);
    const out = await ctx.module.exports({ pass1ImageData: 'data:image/jpeg;base64,P', facePhoto: 'data:image/jpeg;base64,F', artStyle: 'watercolor', characterName: 'T', usageTracker: null });
    expect(out.judgePrompt).toBe('THE JUDGE PROMPT');
  });
});
