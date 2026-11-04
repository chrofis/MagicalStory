import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The Test Lab stage book_review_rerun (server/lib/bookReviewRerun.js): the real
 * runUnifiedRepairPipeline over a stored story, from version 0 of every picture.
 * The pipeline is replaced by a spy; nothing here touches a database or a paid call.
 */

const R = require('../../server/lib/bookReviewRerun.js');
const ledger = require('../../server/lib/costLedger.js');

const ORIG_1 = 'data:image/jpeg;base64,ORIGINAL1';
const ORIG_2 = 'data:image/jpeg;base64,ORIGINAL2';
const ORIG_FRONT = 'data:image/jpeg;base64,ORIGFRONT';
const SHIPPED_1 = 'data:image/jpeg;base64,SHIPPEDREPAIRED1';
const REPAIRED_1 = 'data:image/jpeg;base64,REPAIRED1';

function storedStory() {
  return {
    title: 'The Brave Fox',
    artStyle: 'watercolor',
    language: 'en',
    layout: { imageAspect: '1:1', textInImage: false },
    characters: [{ name: 'Fox' }],
    visualBible: { characters: [] },
    story: 'Page 1 text',
    writerText: 'draft',
    characterAvatars: {},
    coverHints: {},
    sceneDescriptions: [{ pageNumber: 1 }],
    coverImages: { frontCover: { prompt: 'cover prompt', description: 'cover scene', referencePhotos: [{ name: 'Fox' }], modelId: 'grok-imagine-2' } },
    sceneImages: [
      // The record root describes the SHIPPED version (imageData of a repaired pick); version 0 is the original.
      { pageNumber: 2, text: 'Two', imageData: 'data:image/jpeg;base64,SHIPPED2', sceneDescription: 'scene two', imageVersions: [{ source: 'original', prompt: 'p2', bboxDetection: { figures: [{ name: 'Fox' }] } }] },
      { pageNumber: 1, text: 'One', imageData: SHIPPED_1, sceneDescription: 'scene one (shipped)', sceneCharacterClothing: { Fox: 'standard' }, referencePhotos: [{ name: 'Fox' }],
        imageVersions: [{ source: 'original', description: 'scene one (original)', prompt: 'p1', modelId: 'grok-imagine-2', bboxDetection: { figures: [{ name: 'Fox', box: [1, 2, 3, 4] }] } }, { source: 'iterate-round-1' }] },
    ],
  };
}

const originals: Record<number, any> = {
  1: { imageData: ORIG_1 },
  2: { imageData: ORIG_2 },
  [-1]: { imageData: ORIG_FRONT, layer: 'art' },
};

describe('assertStaging', () => {
  it('lets staging through', () => {
    expect(() => R.assertStaging('staging')).not.toThrow();
  });
  it.each(['production', 'local', '', null, 'Staging'])('refuses %j loudly', (env) => {
    expect(() => R.assertStaging(env as any)).toThrow(/refuses to run in environment/);
  });
  it('reads this process\'s environment when none is given', () => {
    const saved = process.env.RAILWAY_ENVIRONMENT_NAME;
    try {
      process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
      expect(() => R.assertStaging(undefined)).toThrow(/"production"/);
      process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
      expect(() => R.assertStaging(undefined)).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = saved;
    }
  });
});

describe('buildRerunInputs: the pictures are version 0, never the shipped pick', () => {
  it('hands the pipeline the originals, in page order, with the covers after the pages', async () => {
    const asked: number[] = [];
    const loadOriginal = async (n: number) => { asked.push(n); return originals[n]; };
    const { rawImages, coverLayers, storyData } = await R.buildRerunInputs(storedStory(), loadOriginal);
    expect(rawImages.map((r: any) => r.pageNumber)).toEqual([1, 2, -1]);
    expect(rawImages.map((r: any) => r.imageData)).toEqual([ORIG_1, ORIG_2, ORIG_FRONT]);
    expect(rawImages.some((r: any) => String(r.imageData).includes('SHIPPED'))).toBe(false);
    expect(asked.sort((a, b) => a - b)).toEqual([-1, 1, 2]);
    expect(coverLayers).toEqual({ frontCover: 'art' });
    // the pipeline's storyData carries the same pages the pipeline gets
    expect(storyData.sceneImages.map((s: any) => s.imageData)).toEqual([ORIG_1, ORIG_2, ORIG_FRONT]);
  });

  it('takes version 0\'s own fields over the record root (which describes the shipped version)', async () => {
    const { rawImages } = await R.buildRerunInputs(storedStory(), async (n: number) => originals[n]);
    const p1 = rawImages.find((r: any) => r.pageNumber === 1);
    expect(p1.sceneDescription).toBe('scene one (original)');
    expect(p1.sharedBboxDetection.figures[0].box).toEqual([1, 2, 3, 4]);
    expect(p1.perCharClothing).toEqual({ Fox: 'standard' });
    expect(p1.characterPhotos).toEqual([{ name: 'Fox' }]);
  });

  it('fails loudly when an original is missing (no fallback to a later version)', async () => {
    await expect(R.buildRerunInputs(storedStory(), async (n: number) => (n === 2 ? { imageData: null } : originals[n]))).rejects.toThrow(/page 2 has no original/);
    await expect(R.buildRerunInputs({ ...storedStory(), sceneImages: [] }, async () => originals[1])).rejects.toThrow(/no stored pages/);
  });
});

function makeDeps(over: any = {}) {
  const saved: any[] = [];
  const pipelineCalls: any[] = [];
  const result = {
    results: [
      { pageNumber: 1, imageData: REPAIRED_1, bestSource: 'inpaint-round-1', imageVersions: [{ imageData: ORIG_1, source: 'original', finalScore: 60 }, { imageData: REPAIRED_1, source: 'inpaint-round-1', method: 'inpaint', finalScore: 90 }] },
      { pageNumber: 2, imageData: ORIG_2, bestSource: 'original', imageVersions: [{ imageData: ORIG_2, source: 'original' }] },
      { pageNumber: -1, imageData: ORIG_FRONT, bestSource: 'original', imageVersions: [{ imageData: ORIG_FRONT, source: 'original' }] },
    ],
    bookAuditRounds: [
      { round: 0, modelId: 'opus', imgFaults: [{ page: 1, severity: 'MAJOR', type: 'anatomy', route: 'touchup', line: '[IMG][MAJOR][anatomy][TOUCHUP] p1 - three legs' }], textFaults: [], pagesRead: [1, 2, -1] },
      { round: 1, modelId: 'opus', imgFaults: [], textFaults: [], pagesRead: [1, 2, -1], repairedPages: [1], betterVerdicts: { 1: 'NEW' }, finalRound: true },
    ],
    repairRounds: [{ round: 1, pages: [{ page: 1, method: 'inpaint', before: 60, after: 90, outcome: 'improved' }] }],
    shippedDefective: [],
    survivingCriticals: null,
    notEvaluated: null,
  };
  const deps = {
    environment: 'staging',
    loadStory: vi.fn(async () => storedStory()),
    loadOriginal: vi.fn(async (_id: string, n: number) => originals[n]),
    runPipeline: vi.fn(async (rawImages: any[], context: any, options: any) => {
      pipelineCalls.push({ rawImages, context, options });
      // a priced call through the tracker, as the real pipeline makes
      context.usageTracker('anthropic', { input_tokens: 1000, output_tokens: 100, direct_cost: 0.25 }, 'book_audit', 'claude-opus-5');
      return result;
    }),
    newTokenUsage: ledger.newTokenUsage,
    recordCall: ledger.recordCall,
    inferLegacyUsageArgs: ledger.inferLegacyUsageArgs,
    ledgerTotal: ledger.ledgerTotal,
    runWithUsageSink: (_sink: any, fn: any) => fn(),
    maxPasses: 3,
    bookReviewRepairRounds: 2,
    latestCoverArtVersion: vi.fn(async () => 0),
    saveVersion: vi.fn(async (...a: any[]) => { saved.push(['page', ...a]); return 3; }),
    saveCoverVersion: vi.fn(async (...a: any[]) => { saved.push(['cover', ...a]); return { versionIndex: 2 }; }),
    ...over,
  };
  return { deps, saved, pipelineCalls };
}

describe('runBookReviewRerun', () => {
  it('refuses outside staging before it reads or spends anything', async () => {
    const { deps, pipelineCalls } = makeDeps({ environment: 'production' });
    await expect(R.runBookReviewRerun({ storyId: 's1' }, {}, deps)).rejects.toThrow(/refuses to run/);
    expect(deps.loadStory).not.toHaveBeenCalled();
    expect(deps.loadOriginal).not.toHaveBeenCalled();
    expect(pipelineCalls).toHaveLength(0);
    expect(deps.saveVersion).not.toHaveBeenCalled();
  });

  it('drives the real pipeline from the originals with the production round budget and no database handle', async () => {
    const { deps, pipelineCalls } = makeDeps();
    await R.runBookReviewRerun({ storyId: 's1' }, { experimentId: 7 }, deps);
    const [{ rawImages, context, options }] = pipelineCalls;
    expect(rawImages.map((r: any) => r.imageData)).toEqual([ORIG_1, ORIG_2, ORIG_FRONT]);
    expect(context.dbPool).toBeNull();
    expect(context.jobId).toBe('s1');
    expect(options.maxRegenAttempts).toBe(3);
    expect(options.useIteratePage).toBe(true);
  });

  it('stores repair versions as new Lab versions (never version 0) and reports where', async () => {
    const { deps, saved } = makeDeps();
    const out = await R.runBookReviewRerun({ storyId: 's1' }, { experimentId: 7 }, deps);
    // only page 1 has a repair version; originals are not re-saved
    expect(saved).toEqual([['page', 's1', 1, REPAIRED_1, 7]]);
    const p1 = out.pages.find((p: any) => p.pageNumber === 1);
    expect(p1.finalPipelineIndex).toBe(1);
    expect(p1.finalLabVersionIndex).toBe(3);
    expect(p1.keptOriginal).toBe(false);
    expect(p1.repairs).toEqual([{ round: 1, method: 'inpaint', outcome: 'improved', error: null, before: 60, after: 90 }]);
    const p2 = out.pages.find((p: any) => p.pageNumber === 2);
    expect(p2.finalLabVersionIndex).toBe(0);
    expect(p2.keptOriginal).toBe(true);
    expect(out.pages.find((p: any) => p.pageNumber === -1).label).toBe('frontCover');
  });

  it('returns the rounds with route tags and BETTER verdicts, cost by function and the total', async () => {
    const { deps } = makeDeps();
    const out = await R.runBookReviewRerun({ storyId: 's1' }, {}, deps);
    expect(out.rounds[0].imgFaults[0]).toMatchObject({ page: 1, route: 'touchup', severity: 'MAJOR' });
    expect(out.rounds[1].betterVerdicts).toEqual({ 1: 'NEW' });
    expect(out.rounds[1].finalRound).toBe(true);
    expect(out.cost.total).toBeCloseTo(0.25, 6);
    expect(out.cost.byFunction.book_audit.calls).toBe(1);
    expect(out.shippedDefective).toEqual([]);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(out.bookReviewRepairRounds).toBe(2);
  });

  it('warns when a cover touch-up would start from a later art row than version 0', async () => {
    const { deps } = makeDeps({ latestCoverArtVersion: vi.fn(async () => 2) });
    const out = await R.runBookReviewRerun({ storyId: 's1' }, {}, deps);
    expect(out.warnings.join(' ')).toMatch(/frontCover: the copy's latest art row is version 2/);
  });

  it('keeps the ledger on the error when the pipeline throws', async () => {
    const { deps } = makeDeps({
      runPipeline: vi.fn(async (_r: any, ctx: any) => {
        ctx.usageTracker('anthropic', { input_tokens: 1, output_tokens: 1, direct_cost: 0.4 }, 'book_audit', 'claude-opus-5');
        throw new Error('title still wrong');
      }),
    });
    await expect(R.runBookReviewRerun({ storyId: 's1' }, {}, deps)).rejects.toMatchObject({ message: 'title still wrong', partialResult: { cost: { total: 0.4 } } });
  });

  it('sends no email: every send in email.js is spied and none is called', async () => {
    const email = require('../../email.js');
    const sends = Object.keys(email).filter((k) => /^send/.test(k) && typeof email[k] === 'function');
    expect(sends.length).toBeGreaterThan(5); // the spy list is real, not empty
    const originalsFns: Record<string, any> = {};
    const spies: Record<string, any> = {};
    for (const k of sends) { originalsFns[k] = email[k]; spies[k] = email[k] = vi.fn(async () => { throw new Error(`email ${k} must not be called`); }); }
    try {
      const { deps } = makeDeps();
      await R.runBookReviewRerun({ storyId: 's1' }, { experimentId: 7 }, deps);
      for (const k of sends) expect(spies[k], k).not.toHaveBeenCalled();
    } finally {
      for (const k of sends) email[k] = originalsFns[k];
    }
  });
});

describe('inferLegacyUsageArgs (moved out of storyJobPipeline.js unchanged)', () => {
  it('infers the provider of a (null, usage, null, model) call', () => {
    expect(ledger.inferLegacyUsageArgs(null, {}, null, 'claude-opus-5')).toEqual({ provider: 'anthropic', funcName: 'scene_expansion' });
    expect(ledger.inferLegacyUsageArgs(null, {}, null, 'gemini-2.5-flash')).toEqual({ provider: 'gemini_quality', funcName: 'consistency_check' });
    expect(ledger.inferLegacyUsageArgs(null, {}, 'x', 'gemini-2.5-flash')).toEqual({ provider: 'gemini_quality', funcName: 'x' });
  });
  it('leaves a named provider and a model-less call alone', () => {
    expect(ledger.inferLegacyUsageArgs('grok', {}, 'f', 'grok-imagine')).toEqual({ provider: 'grok', funcName: 'f' });
    expect(ledger.inferLegacyUsageArgs(null, {}, null, null)).toEqual({ provider: null, funcName: null });
  });
});

describe('the shared repair builders', () => {
  it('buildRepairStoryData carries the story into the pipeline shape', () => {
    const { buildRepairStoryData } = require('../../server/lib/repairStoryData.js');
    const raw = [{ pageNumber: 1, imageData: 'x', sceneDescription: 'd', sceneMetadata: { textPosition: 'top' } }];
    const sd = buildRepairStoryData({
      inputData: { characters: [{ name: 'A' }], layout: { imageAspect: '1:1' }, artStyle: 'pixar', language: 'en', season: 'summer', createdAt: 't', trialMode: false, dedication: 'for you' },
      characterAvatars: { A: 1 }, sceneDescriptions: [{ pageNumber: 1 }], fullStoryText: 'story', writerText: 'w', visualBible: { v: 1 },
      clothingRequirements: { c: 1 }, pageClothing: { p: 1 }, coverHints: { h: 1 }, rawImages: raw, textPositionOf: () => 'top', coverImages: {}, title: 'T',
    });
    expect(sd).toMatchObject({ story: 'story', storyText: 'story', title: 'T', dedication: 'for you', artStyle: 'pixar', season: 'summer', characterAvatars: { A: 1 }, pageClothing: { p: 1 } });
    expect(sd.sceneImages[0]).toMatchObject({ pageNumber: 1, imageData: 'x', description: 'd', textPosition: 'top', imageAspect: '1:1' });
  });
});
