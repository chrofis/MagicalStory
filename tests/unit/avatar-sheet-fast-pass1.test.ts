/**
 * Trial prewarm: the realistic pass-1 sheet draws the body row and the head row AT THE SAME TIME and
 * takes ONE try per row (docs/decisions.md 2026-10-08, "Trial avatar sheet: parallel rows, one try").
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

type Opts = { rowTries?: number; parallelRows?: boolean };

/** Both rows take `ms` to draw. `bodyScores` / `headScores` give the review score of try 1, 2, ... */
async function runPass1(opts: Opts, { bodyScores = [9], headScores = [9], ms = 30 } = {}) {
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
    buildHeadRowPrompt: (_c: any, _d: any, _r: any, o: any) => (o && o.bodyRef === false ? 'HEAD PROMPT NO BODY' : 'HEAD PROMPT'),
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
      const s = bodyScores[Math.min(Number(row.slice(4)) - 1, bodyScores.length - 1)];
      return { valid: s >= 6, score: s, bodies: { finalScore: s, outfit: { outfitScore: 9 }, fullBody: { fullBodyScore: 10 }, failureReasons: [] } };
    },
    reviewHeadRow: async (row: string) => {
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
  return { out, calls, log };
}

describe('pass 1 rows: parallel (trial prewarm)', () => {
  it('starts the body row and the head row before either finishes', async () => {
    const { calls, log } = await runPass1({ rowTries: 1, parallelRows: true });
    expect(calls.maxInFlight).toBe(2);
    expect(log.slice(0, 2).sort()).toEqual(['start body1', 'start head1']);
  });

  it('draws the head row from the phantom and the face photo only, with the no-body prompt', async () => {
    const { calls } = await runPass1({ rowTries: 1, parallelRows: true });
    expect(calls.headRefs[0]).toEqual(['PHANTOM', 'FACE']);
    expect(calls.headPrompts[0]).toBe('HEAD PROMPT NO BODY');
  });

  it('composites the one body row with the one head row', async () => {
    const { out } = await runPass1({ rowTries: 1, parallelRows: true });
    expect(out.imageData).toBe('SHEET(HEAD1|BODY1)');
  });

  it('two invalid rows still composite, and the verdict reports them invalid', async () => {
    const { out } = await runPass1({ rowTries: 1, parallelRows: true }, { bodyScores: [1], headScores: [3] });
    // the sheet still composites (pass 2 restyles it); the verdict reports it invalid, loudly
    expect(out.verdict.valid).toBe(false);
  });
});

describe('pass 1 rows: one try each (rowTries 1)', () => {
  it('an invalid body and an invalid head are NOT retried', async () => {
    const { out, calls } = await runPass1({ rowTries: 1, parallelRows: true }, { bodyScores: [4, 9], headScores: [4, 9] });
    expect(calls.body).toBe(1);
    expect(calls.head).toBe(1);
    expect(out.attemptHistory.map((a: any) => `${a.stage}${a.try}`).sort()).toEqual(['body1', 'head1']);
  });

  it('the sequential default still retries each row once', async () => {
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

  it('the no-body head prompt never mentions an Image 3 and states the hair and the costume itself', () => {
    const p = buildHeadRowPrompt({ name: 'A', age: 9 }, 'a blue robe', false, { bodyRef: false });
    expect(p).not.toMatch(/Image 3/);
    expect(p).toContain('a blue robe');
  });

  it('the default head prompt is unchanged and still binds the heads to Image 3', () => {
    const p = buildHeadRowPrompt({ name: 'A', age: 9 }, 'a blue robe', false);
    expect(p).toMatch(/Image 3 is the character's full-body reference sheet/);
    expect(p).toMatch(/Where the neckline shows, it is the one Image 3 wears/);
  });

  it('generateCharacter2x4Sheet maps fastPass1 to one try and parallel rows, nothing else does', () => {
    expect(SRC).toMatch(/fastPass1 \? \{ rowTries: 1, parallelRows: true \} : \{\}/);
    expect(SRC.match(/parallelRows: true/g)).toHaveLength(1);
  });

  it('styledAvatars threads fastPass1 down to the sheet builder, and only the trial prewarm sets it', () => {
    const styled = fs.readFileSync(path.join(ROOT, 'server/lib/styledAvatars.js'), 'utf8');
    expect(styled.match(/fastPass1/g)!.length).toBeGreaterThanOrEqual(8);
    const trial = fs.readFileSync(path.join(ROOT, 'server/routes/trial.js'), 'utf8');
    expect(trial.match(/fastPass1: true/g)).toHaveLength(1);
    // prepare-title hands it to the one styling helper (styleAndPersistTrialSheets -> prepareStyledAvatars); the standard
    // sheet endpoint does not set it: its head row has no costume text, so it must agree with the body row on the garment
    expect(trial).toContain('styleOptions: { seasonOutfit: seasonOutfitGuidance({ storyCategory }), fastPass1: true }');
    for (const f of ['server/lib/storyAvatars.js', 'storyJobPipeline.js', 'server/lib/testlab.js']) {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(t).not.toMatch(/fastPass1/);
    }
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
