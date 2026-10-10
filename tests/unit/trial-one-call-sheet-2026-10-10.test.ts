/**
 * The trial's avatar sheets are ONE Grok call each, judged as a whole with the photo, ONE redo with the judge's defects fed back,
 * the better sheet ships (docs/decisions.md 2026-10-10 "one-call sheets in the trial").
 *
 *  1. generateJudgedOneCallSheet: one call per sheet; clean -> ships, no redo; a defect -> exactly one redo with the feedback in the
 *     prompt -> judged again -> the better of the two ships; never an unjudged sheet unless the judge itself errors (logged, first sheet);
 *  2. the judge vocabulary: only the labelled types trigger a redo, each verdict word has a fixed instruction, the comparison is stable;
 *  3. the wiring: the trial (and only the trial) asks for oneCall; the full-story sheet keeps the row chain; slides are cut by sheetCut.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { generateJudgedOneCallSheet } = require('../../server/lib/oneCallSheet.js');
const judgeLib = require('../../server/lib/avatarSheetJudge.js');
const sheetLib = require('../../server/lib/character2x4Sheet.js');
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
const facePhoto = 'data:image/jpeg;base64,FACE';

// resolveFacePhoto reads the character's photo; the unit stands in with an inline one.
const character = { name: 'Kid', age: '7', gender: 'male', photos: { face: facePhoto } };
function harness(opts: { judgeAnswers: Array<any>; genFail?: number }) {
  const gen = vi.fn(async (_c: any, g: any) => {
    if (opts.genFail && gen.mock.calls.length === opts.genFail) throw new Error('grok moderation');
    return { imageData: `SHEET${gen.mock.calls.length}`, usage: null, modelId: 'grok', prompt: `PROMPT${gen.mock.calls.length}:${g.redoFeedback || ''}` };
  });
  const answers = [...opts.judgeAnswers];
  const judge = vi.fn(async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; });
  return { gen, judge, run: (kind: 'standard' | 'costume' = 'standard') => generateJudgedOneCallSheet(character, { artStyle: 'watercolor', kind, seasonOutfit: { outfit: 'x' } }, { generate: gen, judge }) };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('1. generateJudgedOneCallSheet', () => {
  it('a clean sheet is ONE Grok call and ONE judge call, with the photo and the sheet kind, and ships', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(facePhoto);
    const h = harness({ judgeAnswers: [judged()] });
    const out = await h.run('costume');
    expect(h.gen).toHaveBeenCalledTimes(1);
    expect(h.judge).toHaveBeenCalledTimes(1);
    expect(h.judge.mock.calls[0][0]).toMatchObject({ sheet: 'SHEET1', photo: facePhoto, kind: 'costume' });
    expect(out.imageData).toBe('SHEET1');
    expect(out.sheetJudge).toMatchObject({ judged: true, redone: false, shipped: 'first', firstDefects: [] });
    expect(out.realisticImageData).toBeNull(); // no photoreal pass exists on this path
  });

  it('a costume sheet gets no season outfit; the everyday sheet does', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(facePhoto);
    const a = harness({ judgeAnswers: [judged()] }); await a.run('costume');
    expect(a.gen.mock.calls[0][1].seasonOutfit).toBeNull();
    const b = harness({ judgeAnswers: [judged()] }); await b.run('standard');
    expect(b.gen.mock.calls[0][1].seasonOutfit).toEqual({ outfit: 'x' });
  });

  it('a defect gives exactly ONE redo, with the defect type and cells in the prompt, judged again; the redo ships when it is cleaner', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(facePhoto);
    const h = harness({ judgeAnswers: [judged({ bald: { verdict: 'bald_cell', cells: [5] } }), judged()] });
    const out = await h.run();
    expect(h.gen).toHaveBeenCalledTimes(2);
    expect(h.judge).toHaveBeenCalledTimes(2);
    expect(h.gen.mock.calls[0][1].redoFeedback).toBeUndefined();
    expect(h.gen.mock.calls[1][1].redoFeedback).toMatch(/full head of hair/);
    expect(h.gen.mock.calls[1][1].redoFeedback).toMatch(/cell 5/);
    expect(h.judge.mock.calls[1][0].sheet).toBe('SHEET2');
    expect(out.imageData).toBe('SHEET2');
    expect(out.sheetJudge).toMatchObject({ redone: true, shipped: 'second', secondDefects: [] });
  });

  it('never a second redo: a redo that is still flagged ships the better of the two, the first on a tie', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(facePhoto);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const worse = harness({ judgeAnswers: [judged({ bald: { verdict: 'bald_cell', cells: [5] } }), judged({ bald: { verdict: 'bald_cell', cells: [5, 6] }, hat: { verdict: 'missing_in_some_cells', cells: [7] } })] });
    expect((await worse.run()).imageData).toBe('SHEET1');
    expect(worse.gen).toHaveBeenCalledTimes(2);
    const tie = harness({ judgeAnswers: [judged({ held: { verdict: 'object_in_hand', cells: [3] } }), judged({ held: { verdict: 'object_in_hand', cells: [3] } })] });
    const out = await tie.run();
    expect(out.imageData).toBe('SHEET1');
    expect(out.sheetJudge.shipped).toBe('first');
    expect(warn.mock.calls.some(c => /shipped the first sheet with defects still flagged/.test(String(c[0])))).toBe(true);
  });

  it('every shipped sheet was judged: the judge sees SHEET1 and, after a redo, SHEET2', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(facePhoto);
    const h = harness({ judgeAnswers: [judged({ layout: { verdict: 'lettering', cells: [1] } }), judged({ layout: { verdict: 'lettering', cells: [] } })] });
    const out = await h.run();
    const seen = h.judge.mock.calls.map((c: any) => c[0].sheet);
    expect(seen).toContain(out.imageData);
  });

  it('a judge ERROR is logged as an error and the first sheet ships (fail-open, the 2026-09-11 gate precedent); no redo is started', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(facePhoto);
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    const h = harness({ judgeAnswers: [new Error('gemini 503')] });
    const out = await h.run();
    expect(out.imageData).toBe('SHEET1');
    expect(h.gen).toHaveBeenCalledTimes(1);
    expect(out.sheetJudge).toMatchObject({ judged: false, judgeError: 'gemini 503' });
    expect(err.mock.calls.some(c => /sheet judge FAILED \(gemini 503\)/.test(String(c[0])))).toBe(true);
  });

  it('a judge error on the redo, or a failed redo call, ships the FIRST sheet (the one the judge flagged) and says so', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(facePhoto);
    const err = vi.spyOn(log, 'error').mockImplementation(() => {});
    const bald = { bald: { verdict: 'bald_cell', cells: [5] } };
    const a = harness({ judgeAnswers: [judged(bald), new Error('judge down')] });
    expect((await a.run()).imageData).toBe('SHEET1');
    const b = harness({ judgeAnswers: [judged(bald)], genFail: 2 });
    const out = await b.run();
    expect(out.imageData).toBe('SHEET1');
    expect(b.judge).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.some(c => /redo failed \(grok moderation\)/.test(String(c[0])))).toBe(true);
  });

  it('a failed FIRST call is not hidden: it throws', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(facePhoto);
    const h = harness({ judgeAnswers: [], genFail: 1 });
    await expect(h.run()).rejects.toThrow(/grok moderation/);
  });

  it('no face photo is an error, not a guess', async () => {
    vi.spyOn(sheetLib, 'resolveFacePhoto').mockResolvedValue(null);
    await expect(harness({ judgeAnswers: [] }).run()).rejects.toThrow(/No face photo/);
  });
});

describe('2. the judge vocabulary the redo is built from', () => {
  it('only the labelled types trigger a redo; identity and age are reported, never counted', () => {
    const p = judgeLib.parseAvatarSheetVerdict(verdict({ identity: { verdict: 'different_person', cells: [] }, age: { verdict: 'much_younger', cells: [] } }));
    expect(judgeLib.sheetDefects(p)).toEqual([]);
    const q = judgeLib.parseAvatarSheetVerdict(verdict({ hat: { verdict: 'unexpected', cells: [1, 5] } }));
    expect(judgeLib.sheetDefects(q)).toEqual([{ type: 'hat', verdict: 'unexpected', cells: [1, 5] }]);
  });

  it('every verdict word of a redo type has a fixed instruction, so no defect can reach a redo without one', () => {
    for (const t of judgeLib.REDO_TYPES) {
      for (const word of judgeLib.VERDICTS[t].filter((w: string) => w !== 'ok' && w !== 'not_assessable')) {
        expect(judgeLib.REDO_INSTRUCTIONS[t][word], `${t}/${word}`).toBeTruthy();
      }
    }
    expect(() => judgeLib.redoFeedback([{ type: 'hat', verdict: 'invented', cells: [] }])).toThrow(/no redo instruction/);
  });

  it('the feedback names the cells and carries no story-specific or free text', () => {
    const f = judgeLib.redoFeedback([{ type: 'bald', verdict: 'bald_cell', cells: [5, 6] }, { type: 'held', verdict: 'object_in_hand', cells: [] }]);
    expect(f).toContain('cells 5, 6');
    expect(f.split('\n')).toHaveLength(2);
  });

  it('betterSheet: fewer failed types, then fewer flagged cells, a tie keeps the first', () => {
    const d = (type: string, cells: number[]) => ({ type, verdict: 'x', cells });
    expect(judgeLib.betterSheet([d('hat', [1]), d('bald', [5])], [d('hat', [1])])).toBe('second');
    expect(judgeLib.betterSheet([d('hat', [1])], [d('hat', [1]), d('bald', [5])])).toBe('first');
    expect(judgeLib.betterSheet([d('hat', [1, 2, 3])], [d('hat', [1])])).toBe('second');
    expect(judgeLib.betterSheet([d('hat', [1])], [d('bald', [1])])).toBe('first');
  });

  it('the redo block reaches the Grok prompt, and a first call has none', () => {
    const base = { costumeDescription: 'a red cape', styleLine: 'watercolour' };
    const first = sheetLib.buildOneCallSheetPrompt(character, base);
    const redo = sheetLib.buildOneCallSheetPrompt(character, { ...base, redoFeedback: 'No bald cell.' });
    expect(first).not.toMatch(/previous attempt/);
    expect(redo.startsWith(first)).toBe(true);
    expect(redo).toMatch(/previous attempt at this sheet had faults[\s\S]*No bald cell\./);
  });
});

describe('3. the wiring', () => {
  it('convertAvatarToStyle sends a oneCall sheet through oneCallSheet and never through the row chain', () => {
    const src = read('server/lib/styledAvatars.js');
    expect(src).toMatch(/oneCall \? await require\('\.\/oneCallSheet'\)\.generateJudgedOneCallSheet\(/);
    expect(src).toMatch(/kind: clothingCategory\.startsWith\('costumed'\) \? 'costume' : 'standard'/);
  });

  it('the trial sets oneCall on every sheet it makes; the full-story paths do not', () => {
    const trial = read('server/routes/trial.js');
    expect(trial.match(/oneCall: true/g)).toHaveLength(2); // the standard sheet, the costumed sheet
    const job = read('storyJobPipeline.js');
    expect(job).toContain('seasonOutfit: trialSeasonOutfit(inputData), oneCall: true }),'); // runTrialEarlyStyling style()
    const flagged = job.match(/oneCall: !!inputData\.trialMode/g) || [];
    expect(flagged.length).toBe(2); // pre-cover top-up and the main prepare, trial only
    expect(job).not.toMatch(/oneCall: (true|false)\b.*\n.*basicRequirements/);
  });

  it('prepareStyledAvatars threads oneCall to every sheet it asks for (costumed, standard, fallback)', () => {
    const src = read('server/lib/styledAvatars.js');
    expect(src.match(/oneCall/g)!.length).toBeGreaterThanOrEqual(9);
    expect(src).not.toMatch(/fastPass1|precomputed/);
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
