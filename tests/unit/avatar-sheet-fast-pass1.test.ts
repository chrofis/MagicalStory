/**
 * Trial prewarm: the realistic pass-1 sheet takes ONE try per row (docs/decisions.md 2026-10-08), the head row
 * drawn after and against the body row (parallel rows were replaced 2026-10-10: head and body must wear the same clothes).
 *
 * Origin: the trial's costumed avatar took 133 s on staging, every step sequential: body try 1 (21 s),
 * body try 2 (12 s), head try 1 (31 s), head try 2 (20 s), then pass 2 twice. Full stories keep the
 * sequential, head-after-accepted-body, two-try chain (decisions 2026-08-09).
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

type Opts = { rowTries?: number; deferJudges?: boolean };

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

describe('pass 1 rows: one try each, head row after the body row (trial prewarm)', () => {
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

describe('the trial prewarm is the one caller that asks for it', () => {
  const sheet = require('../../server/lib/character2x4Sheet.js');
  const { buildHeadRowPrompt } = sheet;

  it('there is no parallel mode and no head prompt without a body reference', () => {
    expect(SRC).not.toMatch(/parallelRows/);
    expect(SRC).not.toMatch(/bodyRef: false/);
    const p = buildHeadRowPrompt({ name: 'A', age: 9 }, 'a blue robe', false);
    expect(p).toMatch(/Image 3 is the character's full-body reference sheet/);
  });

  it('generateCharacter2x4Sheet maps fastPass1 to one try per row, nothing else does', () => {
    expect(SRC).toMatch(/fastPass1 \? \{ rowTries: 1, deferJudges: true \} : \{\}/);
  });

  it('styledAvatars threads fastPass1 down to the sheet builder, and only the trial prewarm sets it', () => {
    const styled = fs.readFileSync(path.join(ROOT, 'server/lib/styledAvatars.js'), 'utf8');
    expect(styled.match(/fastPass1/g)!.length).toBeGreaterThanOrEqual(8);
    const trial = fs.readFileSync(path.join(ROOT, 'server/routes/trial.js'), 'utf8');
    expect(trial.match(/fastPass1: true/g)).toHaveLength(1);
    // prepare-title hands it to the one styling helper (styleAndPersistTrialSheets -> prepareStyledAvatars); the standard
    // sheet endpoint does not set it: its head row has no costume text, so it must agree with the body row on the garment
    expect(trial).toContain('styleOptions: { seasonOutfit: seasonOutfitGuidance({ storyCategory }), fastPass1: true }');
    for (const f of ['server/lib/storyAvatars.js', 'storyJobPipeline.js']) {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(t).not.toMatch(/fastPass1/);
    }
    // The Test Lab may replay the trial's mode in exactly one stage, avatar_sheet_variant (params.fastPass1, default on): it
    // measures the trial's own sheet. Every other Lab stage stays off it (docs/decisions.md 2026-10-10 "avatar sheet variants").
    const lab = fs.readFileSync(path.join(ROOT, 'server/lib/testlab.js'), 'utf8');
    const start = lab.indexOf('// The Grok tiers a sheet variant may name');
    const end = lab.indexOf('/** Pass 2: style transfer of an existing realistic sheet');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(lab.slice(0, start) + lab.slice(end)).not.toMatch(/fastPass1/);
  });
});

describe('pass 1 rows: a body row drawn ahead of the sheet (trial, at the photo)', () => {
  it('skips stage 1: no body call, the head row is drawn against the precomputed row, and the sheet composites it', async () => {
    const pre = { row: 'PREBODY', review: { valid: true, score: null, evaluated: false, bodies: null }, attemptHistory: [{ stage: 'body', try: 1 }] };
    const { out, calls } = await runPass1({ precomputedBody: pre });
    expect(calls.body).toBe(0);
    expect(calls.head).toBe(1);
    expect(calls.headRefs[0]).toEqual(['PHANTOM', 'FACE', 'PREBODY']);
    expect(out.imageData).toBe('SHEET(HEAD1|PREBODY)');
    expect(out.attemptHistory.map((a: any) => `${a.stage}${a.try}`)).toEqual(['body1', 'head1']);
  });
});

describe('deferred judges (trial prewarm, one try per row): the verdict never stands between two renders', () => {
  it('the body judge runs while the head row renders; the head judge is still running when the sheet is returned', async () => {
    const { out, events: log } = await runPass1({ rowTries: 1, deferJudges: true }, { ms: 60, judgeMs: 30 });
    // body judge starts the moment the body row exists, in parallel with the head render (not before it)
    expect(log.indexOf('start bodyJudge')).toBeGreaterThan(log.indexOf('end body1'));
    expect(log.indexOf('start bodyJudge')).toBeLessThan(log.indexOf('end head1'));
    expect(log.indexOf('end bodyJudge')).toBeGreaterThan(-1);
    expect(log.indexOf('end bodyJudge')).toBeLessThan(log.indexOf('end head1')); // the 30 ms judge finishes inside the 60 ms head render
    // the sheet is returned before the head judge has answered, and carries no verdict yet
    expect(log).not.toContain('end headJudge');
    expect(out.verdict).toBeUndefined();
    expect(out.imageData).toBe('SHEET(HEAD1|BODY1)');
    // the verdict arrives afterwards and is the one the sequential run gives
    const settled = await out.verdictPromise;
    expect(settled.verdict.valid).toBe(true);
    expect(settled.verdict.finalScore).toBe(9);
    expect(out.attemptHistory.map((a: any) => `${a.stage}${a.try}:${a.score}`).sort()).toEqual(['body1:9', 'head1:9']);
  });
  it('an invalid deferred verdict is still reported invalid, and nothing is retried', async () => {
    const { out, calls } = await runPass1({ rowTries: 1, deferJudges: true }, { bodyScores: [1], headScores: [3] });
    expect((await out.verdictPromise).verdict.valid).toBe(false);
    expect(calls.body).toBe(1);
    expect(calls.head).toBe(1);
  });
  it('two tries per row ignore the deferral: the judge decides whether to retry, so it is awaited in sequence', async () => {
    const { out, events: log } = await runPass1({ rowTries: 2, deferJudges: true }, { bodyScores: [4, 9], headScores: [9], judgeMs: 5 });
    expect(out.verdict).toBeDefined();
    expect(log.indexOf('end bodyJudge')).toBeLessThan(log.indexOf('start body2'));
  });
  it('without the deferral (the full story) the judges are awaited before the head row starts', async () => {
    const { events: log } = await runPass1({ rowTries: 1 }, { judgeMs: 10 });
    expect(log.indexOf('end bodyJudge')).toBeLessThan(log.indexOf('start head1'));
  });
});
