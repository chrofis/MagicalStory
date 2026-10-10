// The trial's STANDARD sheet runs the whole-sheet defect judge (bald / held / layout) and gets ONE redo; the better sheet ships;
// a judge that cannot answer ships the sheet and logs an error. docs/decisions.md 2026-10-10 "Trial standard sheet".
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/character2x4Sheet.js'), 'utf8');
const judge = require('../../server/lib/avatarSheetJudge.js');

function extractFunction(src: string, name: string): string {
  const start = [`async function ${name}(`, `function ${name}(`].map(n => src.indexOf(n)).find(i => i !== -1) ?? -1;
  if (start === -1) throw new Error(`could not find function ${name}`);
  let p = src.indexOf('(', start); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')') { pd--; if (pd === 0) { p++; break; } } }
  let i = src.indexOf('{', p); let d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
  return src.slice(start, i);
}
const HELPERS = (() => {
  const m = SRC.match(/const TRIAL_REDO_LINES = \{[\s\S]*?\n\};/);
  if (!m) throw new Error('TRIAL_REDO_LINES not found');
  return `${m[0]}\n${extractFunction(SRC, 'trialRedoLines')}`;
})();

type Judged = { defects: any[] } | { error: string };
const D = (type: string, word: string, cells: number[] = []) => ({ type, word, cells });

async function run(answers: Judged[], opts: any = {}) {
  const calls = { gens: 0, judged: 0, prompts: [] as string[], anchors: [] as any[], errors: [] as string[] };
  const ctx: any = {
    module: { exports: {} },
    log: { info() {}, debug() {}, warn() {}, error(m: string) { calls.errors.push(m); } },
    MAX_SHEET_RETRIES: 1, SHEET_HARD_FAIL_MAX: 3, hardFailFeedback: () => [],
    buildFedBackPrompt: (p: string, lines: string[] | null) => { calls.prompts.push(lines ? `${p}|${lines.join('|')}` : p); return p; },
    MODEL_DEFAULTS: { avatarStyleTransferBackend: 'grok' },
    process: { env: { GEMINI_API_KEY: 'k' } },
    SHEET_EMPTY_HANDS_RULE: 'EMPTY HANDS', SHEET_NO_LETTERING_RULE: 'NO LETTERS',
    STYLE_AXIS_FEEDBACK: { layout: () => 'GRID', solo: () => 'SOLO', style: () => 'PAINTED' },
    hairRequest: () => '',
    loadStyleAnchor: () => 'ANCHOR',
    buildStyleTransferPrompt: () => 'P',
    quickLayoutCheck: async () => ({ valid: true }),
    styleTransferGenerate: async (_p: string, _i: string, _b: any, anchor: any) => { calls.gens++; calls.anchors.push(anchor); return { imageData: `STYLED_${calls.gens}`, provider: 'grok', modelId: 'm', usage: null }; },
    judgeTrialSheet: async () => { const a = answers[calls.judged++]; if (!a) throw new Error('unexpected judge call'); return a; },
    require: (id: string) => (id === './avatarSheetJudge' ? judge : id === '../config/models' ? { MODEL_PRICING: {} } : {}),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${HELPERS}\n${extractFunction(SRC, 'runStyleTransferPass')}\nmodule.exports = runStyleTransferPass;`, ctx);
  const out = await ctx.module.exports({ pass1ImageData: 'PASS1', facePhoto: 'FACE', artStyle: 'watercolor', characterName: 'Kid', usageTracker: null, skipQualityEval: true, trialSheetKind: 'standard', ...opts });
  return { out, calls };
}

describe('trial standard sheet: judge + one redo', () => {
  it('clean first sheet: one generation, one judge call, ships', async () => {
    const { out, calls } = await run([{ defects: [] }]);
    expect(calls.gens).toBe(1); expect(calls.judged).toBe(1);
    expect(out.imageData).toBe('STYLED_1');
  });

  it('flagged first sheet: exactly ONE redo, without the anchor, with the defect named; a clean redo ships', async () => {
    const { out, calls } = await run([{ defects: [D('bald', 'bald_cell', [5])] }, { defects: [] }]);
    expect(calls.gens).toBe(2); expect(calls.judged).toBe(2);
    expect(calls.anchors).toEqual([null, null]);
    expect(calls.prompts[1]).toMatch(/bald: Every cell shows a complete head.*cell 5/);
    expect(out.imageData).toBe('STYLED_2');
  });

  it('never a third generation: a redo that is still flagged ships the better sheet, loudly', async () => {
    const { out, calls } = await run([{ defects: [D('held', 'object_in_hand', [5, 6]), D('bald', 'bald_cell', [1])] }, { defects: [D('held', 'object_in_hand', [5])] }]);
    expect(calls.gens).toBe(2);
    expect(out.imageData).toBe('STYLED_2'); // fewer defect types
    expect(calls.errors.some(e => /SHIPPED FLAGGED/.test(e))).toBe(true);
  });

  it('a worse redo loses: the first sheet ships; a tie keeps the first', async () => {
    const worse = await run([{ defects: [D('held', 'object_in_hand', [5])] }, { defects: [D('held', 'object_in_hand', [5]), D('layout', 'extra_figures')] }]);
    expect(worse.out.imageData).toBe('STYLED_1');
    const tie = await run([{ defects: [D('held', 'object_in_hand', [5])] }, { defects: [D('held', 'object_in_hand', [6])] }]);
    expect(tie.out.imageData).toBe('STYLED_1');
  });

  it('judge API failure on the first sheet: ships it, logs an error, no redo', async () => {
    const { out, calls } = await run([{ error: 'quota' }]);
    expect(calls.gens).toBe(1);
    expect(out.imageData).toBe('STYLED_1');
    expect(calls.errors.some(e => /judge FAILED/.test(e))).toBe(true);
  });

  it('judge failure on the redo: the first (flagged) sheet ships, with an error logged', async () => {
    const { out, calls } = await run([{ defects: [D('layout', 'extra_figures')] }, { error: 'quota' }]);
    expect(out.imageData).toBe('STYLED_1');
    expect(calls.errors.some(e => /first, flagged sheet/.test(e))).toBe(true);
  });

  it('a costumed trial sheet (no trialSheetKind) is not judged', async () => {
    const { calls } = await run([], { trialSheetKind: null });
    expect(calls.judged).toBe(0); expect(calls.gens).toBe(1);
  });

  it('a one-attempt run still gets its one redo', async () => {
    const { calls } = await run([{ defects: [D('held', 'object_in_hand', [1])] }, { defects: [] }], { maxAttempts: 1 });
    expect(calls.gens).toBe(2);
  });
});

describe('trialSheetDefects / betterSheet', () => {
  const cell = (n: number, over: any = {}) => ({ cell: n, top: '', extras: '', headgear: 'none', hairVisible: 'full', hairColour: 'brown', hairStyle: 'down', head: 'present', heldObject: 'none', ...over });
  const verdicts = (over: any = {}) => Object.fromEntries(judge.DEFECT_TYPES.map((t: string) => [t, { verdict: 'ok', cells: [], ...(over[t] || {}) }]));
  it('only bald / held / layout can trigger a redo; hat and costume words are ignored', () => {
    const parsed = { verdicts: verdicts({ hat: { verdict: 'missing_in_some_cells', cells: [6] }, costume: { verdict: 'pieces_differ' }, hair: { verdict: 'colour_differs' } }), cells: Array.from({ length: 8 }, (_, i) => cell(i + 1)), evidence: '' };
    expect(judge.trialSheetDefects(parsed)).toEqual([]);
  });
  it('bald verdict, held from the per-cell enums, layout verdict', () => {
    const cells = Array.from({ length: 8 }, (_, i) => cell(i + 1, i === 4 ? { heldObject: 'something' } : {}));
    const parsed = { verdicts: verdicts({ bald: { verdict: 'bald_cell', cells: [5] }, layout: { verdict: 'extra_figures' } }), cells, evidence: '' };
    expect(judge.trialSheetDefects(parsed)).toEqual([D('bald', 'bald_cell', [5]), D('held', 'object_in_hand', [5]), D('layout', 'extra_figures', [])]);
  });
});
