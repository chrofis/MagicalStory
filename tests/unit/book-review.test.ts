import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * The staging BOOK REVIEW (docs/decisions.md 2026-10-29, tasks/opus-book-review-2026-10-29.md):
 * one Opus review of the whole book names the faults AND the fix route per fault; the route
 * replaces decideRepairMethod; D1 retries once and then ships unrepaired; scores are derived
 * from the reviewer's findings through the existing applyScore.
 */

const bookAudit = require('../../server/lib/bookAudit.js');
const review = require('../../server/lib/bookReview.js');
const scoring = require('../../server/lib/scoring.js');

describe('the fault line carries an optional FIX ROUTE (bookAudit.parseRoutes)', () => {
  const raw = [
    'FAULT[IMG][MAJOR][wrong_action][TOUCHUP]: p3 — Remove the second hat.',
    'FAULT[IMG][CRITICAL][clothing][CHAR:Anna Maria]: p4 — Redraw her in the red coat.',
    'FAULT[IMG][CATASTROPHIC][setting][NEW]: p5 — Draw the harbour, not the forest.',
    'FAULT[IMG][CRITICAL][required_text][NEW]: p-1 — The title is misspelled.',
    '  > FAULT[TEXT][MINOR]: p7 — The sentence repeats.',
  ].join('\n');
  const parsed = bookAudit.parseRoutes(raw);

  it('reads the three route forms into a structured value', () => {
    expect(parsed.IMG[0].route).toEqual({ kind: 'TOUCHUP' });
    expect(parsed.IMG[1].route).toEqual({ kind: 'CHAR', charName: 'Anna Maria' });
    expect(parsed.IMG[2].route).toEqual({ kind: 'NEW' });
    expect(parsed.IMG[0].type).toBe('wrong_action');
    expect(parsed.IMG[1].detail).toBe('Redraw her in the red coat.');
  });

  it('a cover fault parses with its negative page number and a TEXT line carries no route', () => {
    expect(parsed.IMG[3].page).toBe(-1);
    expect(parsed.TEXT[0].route).toBeNull();
    expect(parsed.TEXT[0].page).toBe(7);
  });

  it('an OLD stored line with no route bracket still parses, route null', () => {
    const old = bookAudit.parseRoutes('FAULT[IMG][MAJOR][scale]: p6 — The egg is too small.\nFAULT[IMG]: p2 — ancient line');
    expect(old.IMG).toHaveLength(2);
    expect(old.IMG[0]).toMatchObject({ page: 6, severity: 'MAJOR', type: 'scale', route: null });
    expect(old.IMG[1]).toMatchObject({ page: 2, severity: null, type: null, route: null });
  });

  it('a route written without a type is not mistaken for the type', () => {
    const r = bookAudit.parseRoutes('FAULT[IMG][MAJOR][NEW]: p5 — x\nFAULT[IMG][MINOR][touchup]: p6 — y');
    expect(r.IMG[0]).toMatchObject({ type: null, route: { kind: 'NEW' } });
    expect(r.IMG[1]).toMatchObject({ type: null, route: { kind: 'TOUCHUP' } });
  });

  it('reads the re-review verdicts, one per page', () => {
    const v = bookAudit.parseBetterVerdicts('BETTER: p3 — PREVIOUS\nBETTER: p4 — NEW\nBETTER: p9 - same');
    expect([...v.entries()]).toEqual([[3, 'PREVIOUS'], [4, 'NEW'], [9, 'SAME']]);
  });

  it('the consolidator never sees the route bracket, and production lines pass through unchanged', () => {
    const fc = fs.readFileSync(path.join(process.cwd(), 'server/lib/feedbackConsolidator.js'), 'utf8');
    const m = fc.match(/function readerLine\(f\) \{[\s\S]*?\n\}/)![0];
    const readerLine = new Function(`${m}; return readerLine;`)();
    expect(readerLine({ line: 'FAULT[IMG][MAJOR][scale][TOUCHUP]: p3 — shrink it' })).toBe('FAULT[IMG][MAJOR][scale]: p3 — shrink it');
    expect(readerLine({ line: 'FAULT[IMG][MAJOR][scale][CHAR:Anna Maria]: p3 — x' })).toBe('FAULT[IMG][MAJOR][scale]: p3 — x');
    expect(readerLine({ line: 'FAULT[IMG][MAJOR][scale]: p3 — shrink it' })).toBe('FAULT[IMG][MAJOR][scale]: p3 — shrink it');
  });
});

describe('the route tag picks the repair method (replaces decideRepairMethod in this mode)', () => {
  const f = (route: any, extra: any = {}) => ({ page: 3, severity: 'MAJOR', type: 'wrong_action', detail: 'Fix it.', line: 'L', route, ...extra });

  it('TOUCHUP -> inpaint, NEW -> iterate, CHAR -> char-fix', () => {
    expect(review.chooseMethod([f({ kind: 'TOUCHUP' })]).method).toBe('inpaint');
    expect(review.chooseMethod([f({ kind: 'NEW' })]).method).toBe('iterate');
    const c = review.chooseMethod([f({ kind: 'CHAR', charName: 'Anna' }, { type: 'face_drift' })]);
    expect(c).toMatchObject({ method: 'char-fix', charName: 'Anna', issueTypes: ['face_drift'] });
  });

  it('one method per page: NEW beats CHAR beats TOUCHUP, and a redraw is told every fault', () => {
    const faults = [f({ kind: 'TOUCHUP' }), f({ kind: 'CHAR', charName: 'Anna' }), f({ kind: 'NEW' })];
    const pick = review.chooseMethod(faults);
    expect(pick.method).toBe('iterate');
    expect(pick.faults).toHaveLength(3);
    expect(review.chooseMethod(faults.slice(0, 2)).method).toBe('char-fix');
  });

  it('with several named characters the worst-weighted one is repaired first', () => {
    const pick = review.chooseMethod([
      f({ kind: 'CHAR', charName: 'Ben' }, { severity: 'MINOR' }),
      f({ kind: 'CHAR', charName: 'Anna' }, { severity: 'CRITICAL' }),
    ]);
    expect(pick.charName).toBe('Anna');
    expect(pick.faults).toHaveLength(1);
  });

  it('a fault with no route is reported unroutable and NOT sent anywhere (no fallback router)', () => {
    const pick = review.chooseMethod([f(null)]);
    expect(pick.method).toBeNull();
    expect(pick.unroutable).toHaveLength(1);
  });

  it('the TOUCHUP plan: a sentence naming ONE figure becomes that figure\'s fix, the rest is the scene fix', () => {
    const nameMap = { names: ['Anna', 'Ben'], fallbackByName: new Map([['anna', 'the girl in the red coat'], ['ben', 'the boy']]) };
    const plan = review.buildTouchupPlan([
      f({ kind: 'TOUCHUP' }, { detail: 'Lower Anna\'s raised hand.' }),
      f({ kind: 'TOUCHUP' }, { detail: 'Remove the second lantern.', severity: 'MINOR' }),
      f({ kind: 'TOUCHUP' }, { detail: 'Move Anna next to Ben.' }),
    ], nameMap);
    expect(plan.per_character_fixes).toHaveLength(1);
    expect(plan.per_character_fixes[0]).toMatchObject({ characterName: 'Anna', visual_identifier: 'the girl in the red coat', fix_instruction: 'Lower Anna\'s raised hand.' });
    expect(plan.scene_fix.instruction).toBe('Remove the second lantern. Move Anna next to Ben.');
    expect(plan.deduped_issues).toHaveLength(3);
  });
});

describe('scores come from the reviewer\'s findings through applyScore', () => {
  const mk = () => ({ imageData: 'data:image/jpeg;base64,AAAA', source: 'original', pageNumber: 4 });
  const fault = (severity: string, type = 'wrong_action', route: any = { kind: 'NEW' }) => ({ page: 4, severity, type, detail: 'd', line: 'l', route });

  it('a clean page scores 100 with the bytes\' fingerprint, not a hollow null', () => {
    const v = mk();
    review.stampVersionFromReview(v, { faults: [], round: 0 });
    expect(v.finalScore).toBe(100);
    expect(v.scoreSource).toBe('consolidated');
    expect(v.evalImageFp).toBeTruthy();
  });

  it('severity maps to the shared SEVERITY_POINTS (MAJOR 15, CRITICAL 25)', () => {
    const a = mk(); review.stampVersionFromReview(a, { faults: [fault('MAJOR')], round: 0 });
    const b = mk(); review.stampVersionFromReview(b, { faults: [fault('CRITICAL', 'missing_character')], round: 0 });
    expect(a.finalScore).toBe(85);
    expect(b.finalScore).toBe(75);
  });

  it('pick-best follows the reviewer: the version it called worse is charged a MAJOR', () => {
    const prev = mk(); review.stampVersionFromReview(prev, { faults: [fault('MAJOR')], round: 0 });          // 85
    const next = { ...mk(), imageData: 'data:image/jpeg;base64,BBBB', source: 'inpaint-round-1' };
    review.stampVersionFromReview(next, { faults: [], round: 1, comparisonLoss: true });                         // 100 - 15 = 85 -> tie
    expect(next.finalScore).toBe(85);
    const versions = [prev, next];
    // a tie goes to the earlier version in the pipeline's own tie-break
    expect(scoring.pickBestVersionIndex(versions, { tieBreak: 'earliest' })).toBe(0);
    // and when the reviewer prefers the new one the OLD one is charged instead
    review.stampVersionFromReview(next, { faults: [], round: 1 });
    review.stampVersionFromReview(prev, { faults: prev.reviewFaults, round: 0, comparisonLoss: true });
    expect(scoring.pickBestVersionIndex(versions, { tieBreak: 'earliest' })).toBe(1);
  });

  it('the surviving criticals the pipeline reports are the reviewer\'s final findings', () => {
    const { collectCriticalFindings } = require('../../server/lib/repairLogic.js');
    const v = mk(); review.stampVersionFromReview(v, { faults: [fault('CRITICAL', 'missing_character'), fault('MINOR', 'scale')], round: 2 });
    const crit = collectCriticalFindings({ ...v.evaluation, consolidatedPlan: v.consolidatedPlan });
    expect(crit).toHaveLength(1);
    expect(crit[0]).toMatchObject({ type: 'missing_character', severity: 'critical' });
  });

  it('every disabled judge gets a notEvaluated row, and likeness is never recorded as clean', () => {
    const rows = review.notEvaluatedRows();
    const dims = rows.map((r: any) => r.dimension);
    for (const d of ['quality', 'inventory', 'semantic', 'absence', 'identity_arbiter', 'entity_consistency', 'eval_consolidation', 'parent_shared', 'style_check', 'likeness']) {
      expect(dims).toContain(d);
    }
    expect(review.notEvaluatedRows({ reviewFailed: true }).map((r: any) => r.dimension)).toContain('book_review');
    expect(review.notRunEntityReport()).toMatchObject({ notRun: true, overallConsistent: false, totalIssues: 0 });
  });
});

describe('flag gating: production keeps the per-page judges, staging runs the book review', () => {
  const runtimeMod = () => { delete require.cache[require.resolve('../../server/config/runtime.js')]; return require('../../server/config/runtime.js'); };
  const saved = process.env.RAILWAY_ENVIRONMENT_NAME;
  afterEach(() => { if (saved === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = saved; });

  it('production and local read per_page; staging reads book_review', () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    expect(runtimeMod().runtime('pageJudgeMode')).toBe('per_page');
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    expect(runtimeMod().runtime('pageJudgeMode')).toBe('per_page');
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    expect(runtimeMod().runtime('pageJudgeMode')).toBe('book_review');
  });

  it('the review model and the round budget are code constants', () => {
    expect(require('../../server/config/models.js').MODEL_DEFAULTS.bookReviewModel).toBe('anthropic/claude-opus-5.5');
    expect(runtimeMod().runtime('bookReviewRepairRounds')).toBe(2);
  });
});

describe('the audit books an OpenRouter model as openrouter, at the billed dollars', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/bookAudit.js'), 'utf8');
  it('routes by the model id', () => {
    expect(src).toMatch(/isOpenRouterId\(modelId\)\) \{\s*usageTracker\('openrouter'/);
    expect(src).toMatch(/direct_cost: usage\.cost_usd/);
  });
});

describe('D1: a failed review is retried once, then the book ships unrepaired', () => {
  const imgs = [
    { pageNumber: 1, imageData: 'data:image/jpeg;base64,AAAA', text: 't1' },
    { pageNumber: 2, imageData: 'data:image/jpeg;base64,BBBB', text: 't2' },
  ];
  const mkDeps = (reviewBook: any, extra: any = {}) => {
    const pageVersions = new Map(imgs.map(i => [i.pageNumber, [{ imageData: i.imageData, source: 'original', pageNumber: i.pageNumber }]]));
    const runRepairMethod = vi.fn(async ({ img }: any) => ({ pageNumber: img.pageNumber, imageData: 'data:image/jpeg;base64,CCCC', source: 'inpaint-round-1', modelId: 'grok' }));
    return {
      pageVersions, runRepairMethod,
      deps: {
        rawImages: imgs, pageVersions,
        selectBestVersion: (vs: any[]) => vs[0],
        maxRepairRounds: 2, reviewBook, runRepairMethod,
        buildRoundVersion: (r: any, p: any) => ({ imageData: r.imageData, source: r.source, method: r.method || null, ...p }),
        redetect: vi.fn(async () => ({ figures: [] })),
        nameMapFor: () => null,
        inheritSceneContract: () => {},
        auditRecord: (a: any, round: number) => ({ round, faults: a.faults }),
        ...extra,
      },
    };
  };
  const audit = (imgLines: string, extra: any = {}) => ({ faults: 1, byRoute: bookAudit.parseRoutes(imgLines), raw: imgLines, pagesRead: [1, 2], betterVerdicts: {}, ...extra });

  it('null twice: two attempts, NO repair, notEvaluated says so', async () => {
    const reviewBook = vi.fn(async () => null);
    const { deps, pageVersions, runRepairMethod } = mkDeps(reviewBook);
    const out = await review.runBookReviewRounds(deps);
    expect(reviewBook).toHaveBeenCalledTimes(2);
    expect(out.reviewFailed).toBe(true);
    expect(runRepairMethod).not.toHaveBeenCalled();
    const v = pageVersions.get(1)![0] as any;
    expect(v.evaluation.notEvaluated.map((r: any) => r.dimension)).toContain('book_review');
    expect(v.finalScore).toBeUndefined();
  });

  it('null once then a result: the retry is used', async () => {
    const reviewBook = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(audit(''));
    const { deps } = mkDeps(reviewBook, { maxRepairRounds: 0 });
    const out = await review.runBookReviewRounds(deps);
    expect(reviewBook).toHaveBeenCalledTimes(2);
    expect(out.reviewFailed).toBe(false);
  });

  it('repairs the routed page, re-reviews it with the previous picture, and keeps the version the reviewer prefers', async () => {
    const calls: any[] = [];
    const reviewBook = vi.fn(async (shown: Map<number, any>, previous: Map<number, any>) => {
      calls.push({ shown: new Map(shown), previous: new Map(previous) });
      if (calls.length === 1) return audit('FAULT[IMG][MAJOR][wrong_action][TOUCHUP]: p1 — Remove the hat.');
      // the repaired picture is worse: the reviewer names the PREVIOUS one better
      return audit('FAULT[IMG][MAJOR][wrong_action][TOUCHUP]: p1 — Remove the hat.', { betterVerdicts: { 1: 'PREVIOUS' } });
    });
    const { deps, pageVersions, runRepairMethod } = mkDeps(reviewBook);
    const out = await review.runBookReviewRounds(deps);
    expect(runRepairMethod).toHaveBeenCalledTimes(1);          // round 2 does not repeat a method that just lost
    expect(runRepairMethod.mock.calls[0][0]).toMatchObject({ method: 'inpaint', round: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1].previous.get(1).source).toBe('original');  // the re-review sees the previous picture too
    expect(calls[1].shown.get(1).source).toBe('inpaint-round-1');
    expect(calls[1].previous.has(2)).toBe(false);              // an untouched page is shown once
    const versions = pageVersions.get(1)! as any[];
    expect(versions[1].finalScore).toBe(70);                    // MAJOR + the comparison MAJOR
    expect(versions[0].finalScore).toBe(85);
    expect(scoring.pickBestVersionIndex(versions, { tieBreak: 'earliest' })).toBe(0);
    expect(out.auditRecords.map((r: any) => r.round)).toEqual([0, 1]);
    expect(out.auditRecords[1].finalRound).toBe(true);
  });

  it('a CHAR route reaches the char-fix path with the named character', async () => {
    const reviewBook = vi.fn()
      .mockResolvedValueOnce(audit('FAULT[IMG][CRITICAL][face_drift][CHAR:Anna]: p2 — Redraw Anna\'s face.'))
      .mockResolvedValue(audit(''));
    const { deps, runRepairMethod } = mkDeps(reviewBook, { maxRepairRounds: 1 });
    await review.runBookReviewRounds(deps);
    expect(runRepairMethod.mock.calls[0][0]).toMatchObject({ method: 'char-fix', decision: { charName: 'Anna', issueTypes: ['face_drift'] } });
  });

  it('a re-review that fails keeps the previous version: the unreviewed repair cannot win', async () => {
    const reviewBook = vi.fn()
      .mockResolvedValueOnce(audit('FAULT[IMG][MAJOR][wrong_action][NEW]: p1 — Draw it again.'))
      .mockResolvedValue(null);
    const { deps, pageVersions } = mkDeps(reviewBook, { maxRepairRounds: 2 });
    const out = await review.runBookReviewRounds(deps);
    expect(reviewBook).toHaveBeenCalledTimes(3);               // first + failed re-review + its one retry
    expect(out.reviewFailure).toMatch(/not reviewed/);
    const versions = pageVersions.get(1)! as any[];
    expect(versions[1].finalScore ?? null).toBeNull();
    expect(scoring.pickBestVersionIndex(versions, { tieBreak: 'earliest' })).toBe(0);
  });
});

describe('prompt wiring', () => {
  it('the audit template is the production one when no review is asked for (empty placeholders)', async () => {
    const prompts = require('../../server/services/prompts.js');
    await prompts.loadPromptTemplates();
    const t = prompts.PROMPT_TEMPLATES.bookAudit as string;
    expect(t).toContain('{ROUTE_TAG}');
    expect(t).toContain('{BOOK_REVIEW_RULES}');
    expect(prompts.PROMPT_TEMPLATES.bookReviewRules).toContain('{BOOK_TITLE}');
    expect(prompts.PROMPT_TEMPLATES.bookReviewRereview).toContain('BETTER: p<N>');
  });
});

describe('auditStoryBook builds the review request (fetch stubbed, nothing leaves the machine)', () => {
  const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  const story = (previous = false) => ({
    id: 'story_t', title: 'The Brave Fox', visualBible: {}, characters: [],
    sceneImages: [
      { pageNumber: -1, text: '', imageData: JPG },
      { pageNumber: 1, text: 'Page one text.', imageData: JPG, ...(previous ? { previousImageData: JPG } : {}) },
    ],
  });
  async function run(opts: any, s: any) {
    const prompts = require('../../server/services/prompts.js');
    await prompts.loadPromptTemplates();
    const sent: any[] = [];
    const before = (globalThis as any).fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';
    (globalThis as any).fetch = async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'FAULT[IMG][MAJOR][required_text][NEW]: p-1 — Fix the title.\nFAULTS: 1' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.0123 } }) };
    };
    const tracked: any[] = [];
    try {
      const out = await bookAudit.auditStoryBook(s, { imageLoader: async (sc: any) => sc.imageData, objectScale: false, usageTracker: (...a: any[]) => tracked.push(a), ...opts });
      return { out, sent, tracked };
    } finally { (globalThis as any).fetch = before; }
  }
  const textOf = (body: any) => body.messages[0].content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');

  it('the review asks for the route, gives the title, sends no reference pictures, and is booked as openrouter at the billed dollars', async () => {
    const { out, sent, tracked } = await run({ modelId: 'anthropic/claude-opus-5.5', bookReview: { title: 'The Brave Fox' } }, story());
    const text = textOf(sent[0]);
    expect(text).toContain('[<TYPE>][<ROUTE>]: p<N>');
    expect(text).toContain('TOUCHUP');
    expect(text).toContain('CHAR:<Name>');
    expect(text).toContain('The book\'s title is "The Brave Fox"');
    expect(text).toContain('No reference pictures of the characters are given to you');
    expect(text).not.toContain('PREVIOUS PICTURE');
    expect(text).not.toContain('BETTER: p<N>');
    expect(sent[0].model).toBe('anthropic/claude-opus-5.5');
    // pages + the cover: two images, nothing else
    expect(sent[0].messages[0].content.filter((p: any) => p.type === 'image_url')).toHaveLength(2);
    expect(out.byRoute.IMG[0]).toMatchObject({ page: -1, type: 'required_text', route: { kind: 'NEW' } });
    expect(tracked).toHaveLength(1);
    expect(tracked[0][0]).toBe('openrouter');
    expect(tracked[0][1].direct_cost).toBe(0.0123);
  });

  it('the re-review shows a repaired page\'s previous and new picture and asks for BETTER', async () => {
    const { sent } = await run({ modelId: 'anthropic/claude-opus-5.5', bookReview: { title: 'The Brave Fox' } }, story(true));
    const text = textOf(sent[0]);
    expect(text).toContain('PAGE 1 — PREVIOUS PICTURE');
    expect(text).toContain('PAGE 1 — NEW PICTURE');
    expect(text).toContain('BETTER: p<N>');
    expect(sent[0].messages[0].content.filter((p: any) => p.type === 'image_url')).toHaveLength(3);
  });

  it('the production audit (no bookReview) asks for no route and no title', async () => {
    const { sent } = await run({ modelId: 'anthropic/claude-opus-5.5' }, story());
    const text = textOf(sent[0]);
    expect(text).toContain('[<TYPE>]: p<N>');
    expect(text).not.toContain('[<ROUTE>]');
    expect(text).not.toContain('The book\'s title is');
    expect(text).toContain('A page whose picture shows no character is not a defect');
  });

  it('a review with no title cannot run (no title-less cover check)', async () => {
    const { out } = await run({ modelId: 'anthropic/claude-opus-5.5', bookReview: { title: '' } }, story());
    expect(out).toBeNull();
  });
});
