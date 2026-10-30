import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * runUnifiedRepairPipeline end to end (every paid call replaced by a spy):
 *  - production (pageJudgeMode 'per_page') still runs the per-page judges,
 *  - staging ('book_review') runs NONE of them, reviews the whole book once with
 *    the review model, repairs by the route the review names, re-reviews with the
 *    old and the new picture, and ships a result whose scores are the reviewer's.
 * docs/decisions.md 2026-10-29.
 */

const IMG_A = 'data:image/jpeg;base64,AAAAAAAAAAAA';
const IMG_B = 'data:image/jpeg;base64,BBBBBBBBBBBB';
const IMG_NEW = 'data:image/jpeg;base64,NNNNNNNNNNNN';

const mod = (p: string) => require(p);

function makeRaw() {
  return [1, 2].map((n, i) => ({
    pageNumber: n,
    imageData: i === 0 ? IMG_A : IMG_B,
    text: `Text of page ${n}.`,
    sceneDescription: `Scene ${n}`,
    sceneCharacters: [],
    sceneMetadata: {},
    prompt: 'p',
    modelId: 'grok-imagine-2',
    sharedBboxDetection: { figures: [], objects: [], sourceImageFp: null },
  }));
}

function makeContext() {
  const usage: any[] = [];
  return {
    usage,
    context: {
      characters: [],
      usageTracker: (...a: any[]) => usage.push(a),
      visualBible: { characters: [] },
      artStyle: 'watercolor',
      jobId: 'job_test',
      dbPool: null,
      storyData: {
        id: 'job_test', title: 'The Brave Fox', characters: [], visualBible: { characters: [] }, artStyle: 'watercolor',
        layout: { imageAspect: '1:1', textInImage: false }, clothingRequirements: {}, sceneImages: [], sceneDescriptions: [],
      },
    },
  };
}

describe('runUnifiedRepairPipeline by pageJudgeMode', () => {
  const saved = process.env.RAILWAY_ENVIRONMENT_NAME;
  const spies: Array<() => void> = [];
  const patch = (obj: any, key: string, value: any) => {
    const old = obj[key];
    obj[key] = value;
    spies.push(() => { obj[key] = old; });
    return value;
  };

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    while (spies.length) spies.pop()!();
    if (saved === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = saved;
  });

  function installSpies() {
    const images = mod('../../server/lib/images.js');
    const entity = mod('../../server/lib/entityConsistency.js');
    const consolidator = mod('../../server/lib/feedbackConsolidator.js');
    const style = mod('../../server/lib/styleConsistency.js');
    const bookAudit = mod('../../server/lib/bookAudit.js');
    const calls = {
      eval: patch(images, 'evaluateImageBatch', vi.fn(async (inputs: any[]) => inputs.map(i => ({
        pageNumber: i.pageNumber, evaluated: true, score: 95, qualityScore: 95, fixableIssues: [], reasoning: 'fine',
        evalImageFp: images.hashImageData(i.imageData),
      })))),
      entity: patch(entity, 'runEntityConsistencyChecks', vi.fn(async () => ({ characters: {}, grids: [], totalIssues: 0, overallConsistent: true }))),
      consolidate: patch(consolidator, 'consolidateEvaluation', vi.fn(async () => ({ plan: { deduped_issues: [], per_character_fixes: [], scene_fix: null }, error: null }))),
      style: patch(style, 'checkStoryStyleConsistency', vi.fn(async () => ({ verdict: 'consistent', outliers: [], dominantCluster: [] }))),
      detect: patch(images, 'detectAllBoundingBoxes', vi.fn(async () => ({ figures: [], objects: [] }))),
      inpaint: patch(images, 'inpaintPage', vi.fn(async () => ({ repaired: true, imageData: IMG_NEW, instruction: 'Remove the hat.', usage: { model: 'grok-text-edit' } }))),
      audit: patch(bookAudit, 'auditStoryBook', vi.fn()),
    };
    return calls;
  }

  const auditResult = (lines: string, extra: any = {}) => {
    const bookAudit = mod('../../server/lib/bookAudit.js');
    const byRoute = bookAudit.parseRoutes(lines);
    return { faults: byRoute.IMG.length, byRoute, raw: lines, usage: {}, modelId: 'x', pagesRead: [1, 2], pagesSkipped: [], objectScale: null, betterVerdicts: {}, ...extra };
  };

  it('PRODUCTION: the per-page judges run and the book-review model is never used', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    const calls = installSpies();
    calls.audit.mockResolvedValue(auditResult(''));
    const { runUnifiedRepairPipeline } = mod('../../server/lib/repairPipeline.js');
    const { context } = makeContext();
    const out = await runUnifiedRepairPipeline(makeRaw(), context, { maxRegenAttempts: 1, useIteratePage: true });
    expect(calls.eval).toHaveBeenCalled();
    expect(calls.entity).toHaveBeenCalled();
    for (const c of calls.audit.mock.calls) expect(c[1].bookReview ?? null).toBeNull();
    expect(out.results).toHaveLength(2);
  });

  it('STAGING: no per-page judge runs; the review reads the book, TOUCHUP goes to inpaint, the re-review compares both pictures', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    const calls = installSpies();
    calls.audit
      .mockResolvedValueOnce(auditResult('FAULT[IMG][MAJOR][object_presence][TOUCHUP]: p1 — Remove the hat.'))
      .mockResolvedValue(auditResult('', { betterVerdicts: { 1: 'NEW' } }));
    const { runUnifiedRepairPipeline } = mod('../../server/lib/repairPipeline.js');
    const { context, usage } = makeContext();
    const out = await runUnifiedRepairPipeline(makeRaw(), context, { maxRegenAttempts: 1, useIteratePage: true });

    // none of the switched-off judges ran
    expect(calls.eval).not.toHaveBeenCalled();
    expect(calls.entity).not.toHaveBeenCalled();
    expect(calls.consolidate).not.toHaveBeenCalled();
    expect(calls.style).not.toHaveBeenCalled();

    // one review of the book with the review model + title, then a re-review of the repaired page
    expect(calls.audit.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [story0, opts0] = calls.audit.mock.calls[0];
    expect(opts0.modelId).toBe('anthropic/claude-opus-5.5');
    expect(opts0.bookReview).toEqual({ title: 'The Brave Fox' });
    expect(story0.sceneImages.map((s: any) => s.pageNumber)).toEqual([1, 2]);
    const [story1] = calls.audit.mock.calls[1];
    const p1 = story1.sceneImages.find((s: any) => s.pageNumber === 1);
    expect(p1.imageData).toBe(IMG_NEW);
    expect(p1.previousImageData).toBe(IMG_A);
    expect(story1.sceneImages.find((s: any) => s.pageNumber === 2).previousImageData).toBeUndefined();

    // the touch-up ran through the existing inpaint path, with a plan built from the reviewer's sentence
    expect(calls.inpaint).toHaveBeenCalledTimes(1);
    const [, inpaintEval] = calls.inpaint.mock.calls[0];
    expect(inpaintEval.consolidatedPlan.scene_fix.instruction).toBe('Remove the hat.');

    // the result: the repaired picture won on the reviewer's verdict, scores are the reviewer's
    const p1res = out.results.find((r: any) => r.pageNumber === 1);
    expect(p1res.bestSource).toBe('inpaint-round-1');
    expect(p1res.imageVersions).toHaveLength(2);
    expect(p1res.imageVersions[0].finalScore).toBe(70);   // MAJOR + charged as the worse version
    expect(p1res.imageVersions[1].finalScore).toBe(100);
    expect(out.results.find((r: any) => r.pageNumber === 2).finalScore).toBe(100);
    expect(out.shippedDefective).toEqual([]);

    // the disabled judges are recorded as not evaluated, never as clean
    expect(out.notEvaluated.dimensions).toEqual(expect.arrayContaining(['quality', 'semantic', 'entity_consistency', 'likeness']));
    expect(out.results[0].entityReport.notRun).toBe(true);
    expect(out.bookAuditRounds.map((r: any) => r.round)).toEqual([0, 1]);
    expect(out.repairRounds).toHaveLength(1);
  });

  it('STAGING: a review that fails twice ships the book unrepaired and says so', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    const calls = installSpies();
    calls.audit.mockResolvedValue(null);
    const { runUnifiedRepairPipeline } = mod('../../server/lib/repairPipeline.js');
    const { context } = makeContext();
    const out = await runUnifiedRepairPipeline(makeRaw(), context, { maxRegenAttempts: 1, useIteratePage: true });
    expect(calls.audit).toHaveBeenCalledTimes(2);
    expect(calls.inpaint).not.toHaveBeenCalled();
    expect(calls.eval).not.toHaveBeenCalled();
    expect(out.results[0].imageVersions).toHaveLength(1);
    expect(out.notEvaluated.dimensions).toContain('book_review');
  });
});
