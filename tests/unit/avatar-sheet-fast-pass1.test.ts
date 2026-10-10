/**
 * The full-story sheet's pass 1 (generateComposited2x4): body row, then the head row drawn after and against the accepted body
 * (parallel rows were replaced 2026-10-10: head and body must wear the same clothes), two tries per row by default.
 * The trial used to run it with ONE try per row (fastPass1, decisions 2026-10-08) and deferred judges; it now draws its sheet in
 * one call (oneCallSheet.js, tests/unit/trial-one-call-sheet-2026-10-10.test.ts), and that mode was deleted.
 *
 * The real generateComposited2x4 source is sliced out and run in an isolated vm with the backend and
 * the row judges stubbed (the module itself pulls native sharp).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.join(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'server/lib/character2x4Sheet.js'), 'utf8');

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

type Opts = { rowTries?: number };

/** Both rows take `ms` to draw. `bodyScores` / `headScores` give the review score of try 1, 2, ... */
async function runPass1(opts: Opts, { bodyScores = [9], headScores = [9], ms = 30, judgeMs = 0 } = {}) {
  const log: string[] = [];
  const calls = { body: 0, head: 0, inFlight: 0, maxInFlight: 0, headRefs: [] as string[][], headPrompts: [] as string[] };
  const ctx: any = {
    module: { exports: {} },
    log: { info() {}, debug() {}, error() {}, warn() {} },
    GROK_MODELS: { STANDARD: 'grok' },
    MODEL_DEFAULTS: { sheetEvalModel: 'gemini' },
    PASS1_ROW_TRIES: 2,
    resolveFacePhoto: async () => 'FACE',
    resolveStandardAvatar: async () => null,
    splitSheetRows: async () => ({ topHeads: 'HEADS' }),
    declaredGlasses: () => null,
    hairRequest: () => '',
    cropHeadRowToShoulders: async (imageData: string) => ({ imageData, crop: { applied: false } }),
    loadPhantomVariant: () => 'phantom',
    phantomRow: async () => 'PHANTOM',
    buildBodyRowPrompt: () => 'BODY PROMPT',
    buildHeadRowPrompt: () => 'HEAD PROMPT',
    editWithGrok: async (prompt: string, refs: string[]) => {
      const row = prompt === 'BODY PROMPT' ? 'body' : 'head';
      const t = row === 'body' ? ++calls.body : ++calls.head;
      if (row === 'head') { calls.headRefs.push(refs); calls.headPrompts.push(prompt); }
      calls.inFlight++; calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      log.push(`start ${row}${t}`);
      await new Promise(r => setTimeout(r, ms));
      calls.inFlight--;
      log.push(`end ${row}${t}`);
      return { imageData: `${row.toUpperCase()}${t}`, usage: null, modelId: 'grok' };
    },
    reviewBodyRow: async (row: string) => {
      log.push('start bodyJudge'); await new Promise(r => setTimeout(r, judgeMs)); log.push('end bodyJudge');
      const s = bodyScores[Math.min(Number(row.slice(4)) - 1, bodyScores.length - 1)];
      return { valid: s >= 6, score: s, bodies: { finalScore: s, outfit: { outfitScore: 9 }, fullBody: { fullBodyScore: 10 }, failureReasons: [] } };
    },
    reviewHeadRow: async (row: string) => {
      log.push('start headJudge'); await new Promise(r => setTimeout(r, judgeMs)); log.push('end headJudge');
      const s = headScores[Math.min(Number(row.slice(4)) - 1, headScores.length - 1)];
      return { valid: s >= 6, score: s, heads: { finalScore: s, cleanRender: { cleanScore: 9 }, failureReasons: [] }, identity: { identityScore: s, reason: 'x' } };
    },
    stackRowsInto2x4: async (head: string, body: string) => ({ imageData: `SHEET(${head}|${body})`, splitY: 1 }),
    require: () => ({}),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(SRC, 'runBodyRowStage')}
${extractFunction(SRC, 'generateComposited2x4')}\nmodule.exports = generateComposited2x4;`, ctx);
  const fn = ctx.module.exports as (c: any, o: any) => Promise<any>;
  const out = await fn({ name: 'T', age: 9 }, { costumeDescription: 'a robe', ...opts });
  // `log` is the order of the renders; `events` also holds the judges.
  return { out, calls, log: log.filter(e => /^(start|end) (body|head)\d/.test(e)), events: log };
}

describe('pass 1 rows: rowTries 1 = one try each, head row after the body row', () => {
  it('never starts the head row before the body row has finished (head and body wear the same clothes, decisions 2026-10-10)', async () => {
    const { calls, log } = await runPass1({ rowTries: 1 });
    expect(calls.maxInFlight).toBe(1);
    expect(log).toEqual(['start body1', 'end body1', 'start head1', 'end head1']);
  });

  it('draws the head row against the body row as Image 3, never without it', async () => {
    const { calls } = await runPass1({ rowTries: 1 });
    expect(calls.headRefs[0]).toEqual(['PHANTOM', 'FACE', 'BODY1']);
  });

  it('composites the one body row with the one head row', async () => {
    const { out } = await runPass1({ rowTries: 1 });
    expect(out.imageData).toBe('SHEET(HEAD1|BODY1)');
  });

  it('two invalid rows still composite, and the verdict reports them invalid', async () => {
    const { out } = await runPass1({ rowTries: 1 }, { bodyScores: [1], headScores: [3] });
    expect(out.verdict.valid).toBe(false);
  });

  it('an invalid body and an invalid head are NOT retried', async () => {
    const { out, calls } = await runPass1({ rowTries: 1 }, { bodyScores: [4, 9], headScores: [4, 9] });
    expect(calls.body).toBe(1);
    expect(calls.head).toBe(1);
    expect(out.attemptHistory.map((a: any) => `${a.stage}${a.try}`).sort()).toEqual(['body1', 'head1']);
  });

  it('the default still retries each row once', async () => {
    const { calls } = await runPass1({}, { bodyScores: [4, 9], headScores: [4, 9] });
    expect(calls.body).toBe(2);
    expect(calls.head).toBe(2);
  });
});

describe('pass 1 rows: sequential default is unchanged (full stories)', () => {
  it('draws the head row only after the body row, with the accepted body as Image 3', async () => {
    const { calls, log } = await runPass1({});
    expect(calls.maxInFlight).toBe(1);
    expect(log).toEqual(['start body1', 'end body1', 'start head1', 'end head1']);
    expect(calls.headRefs[0]).toEqual(['PHANTOM', 'FACE', 'BODY1']);
    expect(calls.headPrompts[0]).toBe('HEAD PROMPT');
  });
});

describe('the trial no longer uses the row chain (docs/decisions.md 2026-10-10 "one-call sheets in the trial")', () => {
  const { buildHeadRowPrompt } = require('../../server/lib/character2x4Sheet.js');

  it('there is no parallel mode and no head prompt without a body reference', () => {
    expect(SRC).not.toMatch(/parallelRows/);
    expect(SRC).not.toMatch(/bodyRef: false/);
    const p = buildHeadRowPrompt({ name: 'A', age: 9 }, 'a blue robe', false);
    expect(p).toMatch(/Image 3 is the character's full-body reference sheet/);
  });

  it('the trial-only chain is deleted: no fastPass1, deferred judges, precomputed body row, early body row or row styling', () => {
    for (const f of ['server/lib/character2x4Sheet.js', 'server/lib/styledAvatars.js', 'server/lib/trialSheets.js', 'server/lib/avatarSlides.js', 'server/routes/trial.js', 'server/lib/testlab.js', 'storyJobPipeline.js']) {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(t, f).not.toMatch(/fastPass1|deferJudges|precomputedBod|verdictPromise|generateBodyRow|generateStandardBodyRow|styleBodyRow|bodyRowCells|slidesOfBodyRowCells|persistBodyRowSlides|standardBodyRows/);
    }
  });
});
