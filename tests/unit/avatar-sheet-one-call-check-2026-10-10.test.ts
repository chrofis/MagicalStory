/**
 * EVERY avatar sheet (standard and costume, trial and full story) is ONE Grok 2 call, ONE sheet judge, ONE redo on a flag, the better sheet
 * ships, and the run is RECORDED (docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call"; replaces the two-call 2026-08-09 rule).
 *
 *  1. generateJudgedOneCallSheet: the call count, the redo, which sheet ships, the judge-error and redo-failure paths, the record;
 *  2. the judge vocabulary: only bald / held / layout / tail trigger a redo, each word has a fixed correction line, the comparison is stable;
 *  3. the prompt: references, redo lines, the tail rule;
 *  4. the wiring: one path in styledAvatars, nothing of the row chain left, slides are cut by sheetCut.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { generateJudgedOneCallSheet, redoLinesOf } = require('../../server/lib/oneCallSheet.js');
const judgeLib = require('../../server/lib/avatarSheetJudge.js');
const sheetLib = require('../../server/lib/character2x4Sheet.js');
const runMetrics = require('../../server/lib/runMetrics.js');
const { log } = require('../../server/utils/logger');
const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const cell = (n: number) => ({ cell: n, headgear: 'none', hairVisible: 'full', hairColour: 'brown', hairStyle: 'down', head: 'present', top: 'blue hoodie', extras: 'none', heldObject: 'none' });
function verdict(over: Record<string, { verdict: string; cells: number[] }> = {}) {
  return {
    cells: [1, 2, 3, 4, 5, 6, 7, 8].map(cell),
    ...Object.fromEntries(judgeLib.DEFECT_TYPES.map((t: string) => [t, { verdict: 'ok', cells: [] }])),
    ...over,
    evidence: 'x',
  };
}
const judged = (over?: any) => ({ parsed: judgeLib.parseAvatarSheetVerdict(verdict(over)), raw: {}, prompt: 'P' });
const character = { name: 'Kid', age: '7', gender: 'male', photos: { face: 'data:image/jpeg;base64,FACE' } };

function harness(opts: { judgeAnswers: Array<any>; genFail?: number }) {
  const gen = vi.fn(async (_c: any, g: any) => {
    if (opts.genFail && gen.mock.calls.length === opts.genFail) throw new Error('grok moderation');
    return { imageData: `SHEET${gen.mock.calls.length}`, usage: null, modelId: 'grok-imagine-image-2.0', prompt: `PROMPT${gen.mock.calls.length}:${(g.redoLines || []).join('|')}` };
  });
  const answers = [...opts.judgeAnswers];
  const judge = vi.fn(async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; });
  return { gen, judge, run: (kind: 'standard' | 'costume' = 'standard') => generateJudgedOneCallSheet(character, { artStyle: 'watercolor', kind, seasonOutfit: { outfit: 'x' } }, { generate: gen, judge }) };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('1. generateJudgedOneCallSheet', () => {
  it('a clean sheet is ONE Grok call and ONE judge call (sheet only, the sheet kind) and ships; the record says so', async () => {
    const h = harness({ judgeAnswers: [judged()] });
    const out = await h.run('costume');
    expect(h.gen).toHaveBeenCalledTimes(1);
    expect(h.judge).toHaveBeenCalledTimes(1);
    expect(h.judge.mock.calls[0][0]).toMatchObject({ sheet: 'SHEET1', kind: 'costume' });
    expect(h.judge.mock.calls[0][0].photo).toBeUndefined();
    expect(out.imageData).toBe('SHEET1');
    expect(out.sheetCheck).toMatchObject({ kind: 'costume', model: 'grok-imagine-image-2.0', judged: true, judgeError: null, firstFlags: [], redone: false, secondFlags: null, redoError: null, shipped: 'first' });
    expect(typeof out.sheetCheck.totalMs).toBe('number');
  });

  it('a costume sheet gets no season outfit; the everyday sheet does', async () => {
    const a = harness({ judgeAnswers: [judged()] }); await a.run('costume');
    expect(a.gen.mock.calls[0][1].seasonOutfit).toBeNull();
    const b = harness({ judgeAnswers: [judged()] }); await b.run('standard');
    expect(b.gen.mock.calls[0][1].seasonOutfit).toEqual({ outfit: 'x' });
  });

  it('a flag gives exactly ONE redo, with the defect type and cells fed back, judged again; the redo ships when it is cleaner', async () => {
    const h = harness({ judgeAnswers: [judged({ bald: { verdict: 'bald_cell', cells: [5] } }), judged()] });
    const out = await h.run();
    expect(h.gen).toHaveBeenCalledTimes(2);
    expect(h.judge).toHaveBeenCalledTimes(2);
    expect(h.gen.mock.calls[0][1].redoLines).toBeUndefined();
    expect(h.gen.mock.calls[1][1].redoLines.join(' ')).toMatch(/bald: Every cell shows a complete head.*cell 5/);
    expect(h.judge.mock.calls[1][0].sheet).toBe('SHEET2');
    expect(out.imageData).toBe('SHEET2');
    expect(out.sheetCheck).toMatchObject({ redone: true, shipped: 'second', secondFlags: [] });
    expect(out.sheetCheck.firstFlags).toEqual([{ type: 'bald', word: 'bald_cell', cells: [5] }]);
  });

  it('a tail costume standing without a fin is flagged and redone with the tail rule', async () => {
    const h = harness({ judgeAnswers: [judged({ tail: { verdict: 'standing_on_tail', cells: [5, 6] } }), judged()] });
    const out = await h.run('costume');
    expect(out.sheetCheck.firstFlags).toEqual([{ type: 'tail', word: 'standing_on_tail', cells: [5, 6] }]);
    expect(h.gen.mock.calls[1][1].redoLines.join(' ')).toMatch(/never stands on it/);
    expect(out.imageData).toBe('SHEET2');
  });

  it('never a second redo: a redo that is still flagged ships the better of the two (the first on a tie), and says so as an ERROR', async () => {
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const worse = harness({ judgeAnswers: [judged({ bald: { verdict: 'bald_cell', cells: [5] } }), judged({ bald: { verdict: 'bald_cell', cells: [5, 6] }, layout: { verdict: 'extra_figures', cells: [] } })] });
    expect((await worse.run()).imageData).toBe('SHEET1');
    expect(worse.gen).toHaveBeenCalledTimes(2);
    const tie = harness({ judgeAnswers: [judged({ layout: { verdict: 'lettering', cells: [3] } }), judged({ layout: { verdict: 'lettering', cells: [3] } })] });
    const out = await tie.run();
    expect(out.imageData).toBe('SHEET1');
    expect(out.sheetCheck).toMatchObject({ redone: true, shipped: 'first' });
    expect(err.mock.calls.some(c => /SHIPPED FLAGGED after the redo/.test(String(c[0])))).toBe(true);
  });

  it('every shipped sheet was judged: the judge saw SHEET1 and, after a redo, SHEET2', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const h = harness({ judgeAnswers: [judged({ layout: { verdict: 'lettering', cells: [1] } }), judged({ layout: { verdict: 'lettering', cells: [] } })] });
    const out = await h.run();
    expect(h.judge.mock.calls.map((c: any) => c[0].sheet)).toContain(out.imageData);
  });

  it('a judge ERROR is logged as an error and the first sheet ships (2026-09-11 precedent); no redo is started; the record says unjudged', async () => {
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    const h = harness({ judgeAnswers: [new Error('gemini 503')] });
    const out = await h.run();
    expect(out.imageData).toBe('SHEET1');
    expect(h.gen).toHaveBeenCalledTimes(1);
    expect(out.sheetCheck).toMatchObject({ judged: false, judgeError: 'gemini 503', firstFlags: null, redone: false });
    expect(err.mock.calls.some(c => /sheet judge FAILED \(gemini 503\)/.test(String(c[0])))).toBe(true);
  });

  it('a judge error on the redo, or a failed redo call, ships the FIRST sheet (the one the judge flagged) and records it', async () => {
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const bald = { bald: { verdict: 'bald_cell', cells: [5] } };
    const a = harness({ judgeAnswers: [judged(bald), new Error('judge down')] });
    const outA = await a.run();
    expect(outA.imageData).toBe('SHEET1');
    expect(outA.sheetCheck).toMatchObject({ redone: true, judgeError: 'judge down', shipped: 'first' });
    const b = harness({ judgeAnswers: [judged(bald)], genFail: 2 });
    const out = await b.run();
    expect(out.imageData).toBe('SHEET1');
    expect(b.judge).toHaveBeenCalledTimes(1);
    expect(out.sheetCheck).toMatchObject({ redone: true, redoError: 'grok moderation', shipped: 'first' });
    expect(err.mock.calls.some(c => /redo failed \(grok moderation\)/.test(String(c[0])))).toBe(true);
  });

  it('a failed FIRST call is not hidden: it throws', async () => {
    const h = harness({ judgeAnswers: [], genFail: 1 });
    await expect(h.run()).rejects.toThrow(/grok moderation/);
  });

  it('every run counts itself: ran, flagged (+ the type), redo, redo shipped, judge error', async () => {
    const counts: Record<string, number> = {};
    vi.spyOn(runMetrics, 'ambientJobId').mockReturnValue('job_x');
    vi.spyOn(runMetrics, 'forJob').mockReturnValue({ count: (n: string) => { counts[n] = (counts[n] || 0) + 1; } } as any);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    await harness({ judgeAnswers: [judged()] }).run();
    await harness({ judgeAnswers: [judged({ bald: { verdict: 'bald_cell', cells: [2] } }), judged()] }).run();
    vi.spyOn(log, 'error').mockImplementation(() => {});
    await harness({ judgeAnswers: [new Error('x')] }).run();
    expect(counts).toMatchObject({
      avatar_sheet_check_ran: 3, avatar_sheet_check_flagged: 1, avatar_sheet_check_flag_bald: 1,
      avatar_sheet_check_redo: 1, avatar_sheet_check_redo_shipped: 1, avatar_sheet_check_judge_error: 1,
    });
  });
});

describe('2. the judge vocabulary the redo is built from', () => {
  it('only bald / held / layout / tail trigger a redo; hat, hair, costume, identity and age words are ignored', () => {
    const p = judgeLib.parseAvatarSheetVerdict(verdict({ identity: { verdict: 'different_person', cells: [] }, age: { verdict: 'much_younger', cells: [] }, hat: { verdict: 'unexpected', cells: [1, 5] }, costume: { verdict: 'pieces_differ', cells: [] } }));
    expect(judgeLib.sheetDefects(p)).toEqual([]);
  });

  it('bald verdict, held from the per-cell enums, layout verdict, tail verdict', () => {
    const cells = [1, 2, 3, 4, 5, 6, 7, 8].map(n => (n === 5 ? { ...cell(n), heldObject: 'something' } : cell(n)));
    const parsed = { ...judgeLib.parseAvatarSheetVerdict(verdict({ bald: { verdict: 'bald_cell', cells: [5] }, layout: { verdict: 'extra_figures', cells: [] }, tail: { verdict: 'standing_on_tail', cells: [7] } })), cells };
    expect(judgeLib.sheetDefects(parsed)).toEqual([
      { type: 'bald', word: 'bald_cell', cells: [5] },
      { type: 'held', word: 'object_in_hand', cells: [5] },
      { type: 'tail', word: 'standing_on_tail', cells: [7] },
      { type: 'layout', word: 'extra_figures', cells: [] },
    ]);
  });

  it('every verdict word of a checked type has a fixed correction line, so no flag can reach a redo without one; the lines carry no story text', () => {
    for (const [type, mode] of Object.entries(judgeLib.SHEET_CHECK_SIGNALS)) {
      for (const word of judgeLib.VERDICTS[type].filter((w: string) => w !== 'ok')) {
        const lines = redoLinesOf([{ type, word: type === 'held' ? 'object_in_hand' : word, cells: [] }]);
        expect(lines, `${type}/${word}`).toHaveLength(1);
        expect(lines[0]).not.toMatch(/Omar|Lukas|Emma|wizard|pirate/i);
      }
      expect(mode).toBeTruthy();
    }
    expect(() => redoLinesOf([{ type: 'layout', word: 'invented', cells: [] }])).toThrow(/no correction line/);
  });

  it('the correction names the cells', () => {
    expect(redoLinesOf([{ type: 'bald', word: 'bald_cell', cells: [5, 6] }])[0]).toMatch(/cells 5, 6/);
  });

  it('betterSheet: fewer failed types, then fewer flagged cells, a tie keeps the first', () => {
    const d = (type: string, cells: number[]) => ({ type, word: 'x', cells });
    const a = (defects: any[]) => ({ defects, tag: Math.random() });
    const x = a([d('bald', [5]), d('held', [1])]); const y = a([d('bald', [5])]);
    expect(judgeLib.betterSheet(x, y)).toBe(y);
    expect(judgeLib.betterSheet(y, x)).toBe(y);
    const m = a([d('bald', [1, 2, 3])]); const n = a([d('bald', [1])]);
    expect(judgeLib.betterSheet(m, n)).toBe(n);
    const p = a([d('bald', [1])]); const q = a([d('held', [1])]);
    expect(judgeLib.betterSheet(p, q)).toBe(p);
  });

  it('the judge prompt asks the tail question and the parser takes only its two words', () => {
    const t = fs.readFileSync(path.join(root, 'prompts/avatar-sheet-defect-judge.txt'), 'utf8');
    expect(t).toMatch(/standing_on_tail/);
    expect(t).toMatch(/"tail":\s+\{"verdict"/);
    expect(() => judgeLib.parseAvatarSheetVerdict(verdict({ tail: { verdict: 'floating', cells: [] } }))).toThrow(/tail\.verdict/);
  });
});

describe('3. the sheet prompt', () => {
  const base = { costumeDescription: 'a red cape', styleLine: 'watercolour', kind: 'costume' };
  it('the redo block reaches the prompt, and a first call has none', () => {
    const first = sheetLib.buildOneCallSheetPrompt(character, base);
    const redo = sheetLib.buildOneCallSheetPrompt(character, { ...base, redoLines: ['bald: no bald cell.'] });
    expect(first).not.toMatch(/CORRECTIONS/);
    expect(redo.startsWith(first)).toBe(true);
    expect(redo).toMatch(/CORRECTIONS to the previous attempt[\s\S]*- bald: no bald cell\./);
  });

  it('the tail rule is in the generator as well as in the judge', () => {
    const p = sheetLib.buildOneCallSheetPrompt(character, base);
    expect(p).toContain(sheetLib.TAIL_POSE_RULE);
  });

  it('a body reference adds Image 3 only when the caller has one; the kind decides what it is used for', () => {
    expect(sheetLib.buildOneCallSheetPrompt(character, base)).not.toMatch(/Image 3/);
    expect(sheetLib.buildOneCallSheetPrompt(character, { ...base, hasReference: true, kind: 'standard' })).toMatch(/Image 3 is the person's body reference: take its CLOTHING and build only/);
    expect(sheetLib.buildOneCallSheetPrompt(character, { ...base, hasReference: true })).toMatch(/take its build only\. IGNORE its clothing/);
    expect(() => sheetLib.buildOneCallSheetPrompt(character, { ...base, kind: undefined })).toThrow(/kind must be/);
  });

  it('the model, the references and the age line are constants of MODEL_DEFAULTS and the age line is always on', () => {
    const { MODEL_DEFAULTS } = require('../../server/config/models.js');
    expect(MODEL_DEFAULTS.avatarSheetModel).toBe('grok-imagine-image-2.0');
    expect(MODEL_DEFAULTS.avatarSheetReferences).toBe('face+body');
    expect(sheetLib.buildOneCallSheetPrompt(character, base)).toContain("of the figure's standing height");
  });
});

describe('3b. the references of the one call', () => {
  const jpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';
  it('face+body without any body photo is an error before any paid call, not a silent face-only sheet', async () => {
    await expect(sheetLib.generateOneCallSheet({ name: 'K', age: 5, photos: { face: jpg } }, { artStyle: 'watercolor', kind: 'standard', references: 'face+body' })).rejects.toThrow(/no body photo/);
  });
  it('an unknown references value is refused, and so is a realistic art style', async () => {
    await expect(sheetLib.generateOneCallSheet({ name: 'K', photos: { face: jpg } }, { artStyle: 'watercolor', kind: 'standard', references: 'face+avatar' })).rejects.toThrow(/references must be/);
    await expect(sheetLib.generateOneCallSheet({ name: 'K', photos: { face: jpg } }, { artStyle: 'realistic', kind: 'standard' })).rejects.toThrow(/non-realistic art style/);
  });
  it('the body reference is the cut-out, else the body photo, nothing else', async () => {
    const r = sheetLib._internal.resolveBodyReference;
    expect(await r({ photos: { bodyNoBg: jpg, body: 'x' } })).toMatch(/^data:image\/jpeg;base64,/);
    expect(await r({ photos: { face: jpg } })).toBeNull();
  });
});

describe('4. the wiring', () => {
  it('convertAvatarToStyle sends every sheet through oneCallSheet, and a costume or redress sheet is kind costume', () => {
    const src = read('server/lib/styledAvatars.js');
    expect(src).toMatch(/require\('\.\/oneCallSheet'\)\.generateJudgedOneCallSheet\(/);
    expect(src).toMatch(/const kind = \(clothingCategory\.startsWith\('costumed'\) \|\| redress\) \? 'costume' : 'standard'/);
    expect(src).not.toMatch(/oneCall\b|fastPass1|precomputed|styledPass1Sheets|generateCharacter2x4Sheet/);
  });

  it('nothing of the row chain is left: no row prompts, no pass 2, no row judges, no early body row', () => {
    const sheetSrc = read('server/lib/character2x4Sheet.js');
    for (const gone of ['generateComposited2x4', 'buildBodyRowPrompt', 'buildHeadRowPrompt', 'runStyleTransferPass', 'evaluateSheetSplit', 'evaluateSheetRow', 'generateBodyRow', 'styleBodyRow', 'stackRowsInto2x4', 'generateCharacter2x4Sheet']) {
      expect(sheetSrc, gone).not.toContain(gone);
    }
    for (const p of ['sheet-row-heads-eval.txt', 'sheet-row-bodies-eval.txt', 'sheet-row-identity-eval.txt']) {
      expect(fs.existsSync(path.join(root, 'prompts', p)), p).toBe(false);
    }
    const trial = read('server/routes/trial.js');
    expect(trial).not.toMatch(/standardBodyRows|styleBodyRow|bodyRowCells|persistBodyRowSlides/);
  });

  it('a one-call sheet is cut into its slides by the figure cutter (sheetCut) and the slides are single cells', async () => {
    const avatarSlides = require('../../server/lib/avatarSlides.js');
    // a 1:1 sheet like the Grok call returns: 4 head figures on top, 4 full-body figures below, paper everywhere else
    const W = 1024;
    const figs: any[] = [];
    for (let c = 0; c < 4; c++) {
      figs.push({ input: { create: { width: 110, height: 150, channels: 3, background: { r: 60 + c * 30, g: 80, b: 140 } } }, left: c * 256 + 70, top: 40 });
      figs.push({ input: { create: { width: 90, height: 380, channels: 3, background: { r: 60 + c * 30, g: 120, b: 90 } } }, left: c * 256 + 80, top: 330 });
    }
    const sheet = await sharp({ create: { width: W, height: W, channels: 3, background: '#fff' } }).composite(figs).jpeg().toBuffer();
    const slides = await avatarSlides.slidesFromSheet(`data:image/jpeg;base64,${sheet.toString('base64')}`, 'standard');
    expect(slides).toHaveLength(6); // front / three-quarter / profile, head + body
    for (const s of slides) {
      const { width } = await sharp(Buffer.from(s.split(',')[1], 'base64')).metadata();
      expect(width).toBeLessThan(W * 0.35);
    }
    expect(read('server/lib/sceneComposite.js')).toMatch(/sheetCut/);
  });
});

describe('5. the 50-run record', () => {
  const { summarize } = require('../../server/../scripts/admin/avatar-sheet-check-report.js');
  const rec = (over: any = {}) => ({ judged: true, judgeError: null, firstFlags: [], redone: false, secondFlags: null, redoError: null, shipped: 'first', totalMs: 1000, ...over });

  it('summarize counts sheets, flags by type, redos, who shipped, flagged shipments and judge errors', () => {
    const s = summarize([
      rec(),
      rec({ firstFlags: [{ type: 'bald', word: 'bald_cell', cells: [5] }], redone: true, secondFlags: [], shipped: 'second', totalMs: 3000 }),
      rec({ firstFlags: [{ type: 'tail', word: 'standing_on_tail', cells: [7] }, { type: 'bald', word: 'bald_cell', cells: [5] }], redone: true, secondFlags: [{ type: 'tail', word: 'standing_on_tail', cells: [7] }], shipped: 'second' }),
      rec({ judged: false, judgeError: 'quota', firstFlags: null }),
      rec({ firstFlags: [{ type: 'layout', word: 'lettering', cells: [] }], redone: true, redoError: 'moderation' }),
    ]);
    expect(s).toMatchObject({ sheets: 5, judged: 4, judgeErrors: 1, flaggedFirst: 3, redone: 3, redoShippedBetter: 2, redoFailed: 1, shippedFlagged: 2 });
    expect(s.flagsByType).toEqual({ bald: 2, tail: 1, layout: 1 });
  });

  it('the log entry convertAvatarToStyle stores carries the sheetCheck record and its pass/fail', async () => {
    const styled = require('../../server/lib/styledAvatars.js');
    const oneCall = require('../../server/lib/oneCallSheet.js');
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const sheetCheck = { kind: 'costume', model: 'grok-imagine-image-2.0', judged: true, judgeError: null, judgeMs: 5, firstFlags: [{ type: 'bald', word: 'bald_cell', cells: [5] }], redone: true, secondFlags: [], redoError: null, shipped: 'second', totalMs: 40000 };
    vi.spyOn(oneCall, 'generateJudgedOneCallSheet').mockResolvedValue({ imageData: `data:image/jpeg;base64,${jpeg.toString('base64')}`, usage: null, prompt: 'P', refs: {}, sheetCheck });
    const face = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    let entries: any[] = [];
    await styled.runInCacheScope('sheet-check-record', async () => {
      await styled.convertAvatarToStyle(face, 'watercolor', 'Kid', face, 'a red cape', 'costumed:hero', null, { name: 'Kid', age: 6, photos: { bodyNoBg: face } });
      entries = styled.getStyledAvatarGenerationLog();
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].sheetCheck).toEqual(sheetCheck);
    expect(entries[0].success).toBe(true);     // the redo is clean
    expect(entries[0].evaluated).toBe(true);
    expect(oneCall.generateJudgedOneCallSheet.mock.calls[0][1]).toMatchObject({ kind: 'costume', costumeName: 'hero', artStyle: 'watercolor' });
  });

  it('a sheet shipped still flagged is a failed entry with the flags in its warning; an unjudged one says the judge could not answer', async () => {
    const styled = require('../../server/lib/styledAvatars.js');
    const oneCall = require('../../server/lib/oneCallSheet.js');
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const img = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    const base = { kind: 'standard', model: 'm', judgeMs: 1, redoError: null, totalMs: 1 };
    const run = async (sheetCheck: any) => {
      vi.spyOn(oneCall, 'generateJudgedOneCallSheet').mockResolvedValue({ imageData: img, usage: null, prompt: 'P', refs: {}, sheetCheck });
      let entries: any[] = [];
      await styled.runInCacheScope(`sheet-check-fail-${Math.random()}`, async () => {
        await styled.convertAvatarToStyle(img, 'watercolor', 'Kid', img, null, 'standard', null, { name: 'Kid', age: 6, photos: { bodyNoBg: img } });
        entries = styled.getStyledAvatarGenerationLog();
      });
      return entries[0];
    };
    const flagged = await run({ ...base, judged: true, judgeError: null, firstFlags: [{ type: 'held', word: 'object_in_hand', cells: [5] }], redone: true, secondFlags: [{ type: 'held', word: 'object_in_hand', cells: [5] }], shipped: 'first' });
    expect(flagged.success).toBe(false);
    expect(flagged.warning).toMatch(/held:object_in_hand/);
    const unjudged = await run({ ...base, judged: false, judgeError: 'quota', firstFlags: null, redone: false, secondFlags: null, shipped: 'first' });
    expect(unjudged.success).toBe(false);
    expect(unjudged.evaluated).toBe(false);
    expect(unjudged.warning).toMatch(/could not answer \(quota\)/);
  });
});
