/**
 * Finding B4: an unevaluated run must report NOT MEASURED, never a clean score.
 *
 * Evidence: prod trial job_1789292742265_mgxmrkfpd (6 pages, zero eval records)
 * shipped `firstAttemptPassRate: 100, pagesWithIssues: 0, totalRetries: 0` —
 * read as "6 pages evaluated, all passed first try" — while four of its six
 * pages had real defects. See docs/decisions.md (2026-09-13).
 */
import { describe, it, expect, afterEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeQualityAnalytics, pageAttemptCount, getBuildInfo } = require('../../server/lib/storyMetrics.js');

/** A page as the beats repair pipeline actually stores it: one retryHistory
 *  entry per persisted version, and NO totalAttempts (no generation path
 *  writes it) — staging job_1789348171785_9oxos7dwv. */
const beatsPage = (pageNumber: number, attempts: number, qualityScore: number) => ({
  pageNumber, imageData: 'x', qualityScore,
  retryHistory: Array.from({ length: attempts }, (_, i) => ({
    attempt: i + 1, type: 'unified_pipeline', source: i === 0 ? 'original' : `inpaint-round-${i}`,
  })),
});

const page = (over: Record<string, unknown> = {}) => ({
  pageNumber: 1, imageData: 'x', totalAttempts: 1, retryHistory: [], ...over,
});

describe('computeQualityAnalytics — measured zero vs not measured', () => {
  it('an evaluated run with zero issues still reports 0 / 100 truthfully', () => {
    const a = computeQualityAnalytics([
      page({ pageNumber: 1, qualityScore: 92 }),
      page({ pageNumber: 2, qualityScore: 88 }),
    ], { skipQualityEval: false });

    expect(a.qualityEvaluated).toBe(true);
    expect(a.qualityEvalSkipReason).toBeNull();
    expect(a.pagesWithIssues).toBe(0);          // measured zero, not null
    expect(a.firstAttemptPassRate).toBe(100);   // measured 100, not null
    expect(a.totalRetries).toBe(0);
    expect(a.contentBlocked).toBe(0);
    expect(a.avgQualityScore).toBe(90);
    expect(a.minQualityScore).toBe(88);
    expect(a.maxQualityScore).toBe(92);
  });

  it('an unevaluated run reports not-measured on every quality aggregate', () => {
    // Shape of the skipQualityEval mapping: no qualityScore, no totalAttempts,
    // no retryHistory on any page.
    const trialPages = [1, 2, 3, 4, 5, 6].map(n => ({ pageNumber: n, imageData: 'x' }));
    const a = computeQualityAnalytics(trialPages, { skipQualityEval: true });

    expect(a.qualityEvaluated).toBe(false);
    expect(a.qualityEvalSkipReason).toBe('skipQualityEval');
    expect(a.avgQualityScore).toBeNull();
    expect(a.minQualityScore).toBeNull();
    expect(a.maxQualityScore).toBeNull();
    expect(a.firstAttemptPassRate).toBeNull();
    expect(a.totalRetries).toBeNull();
    expect(a.pagesWithIssues).toBeNull();
    expect(a.contentBlocked).toBeNull();
    // The regression that shipped: these must NEVER read as a clean result.
    expect(a.firstAttemptPassRate).not.toBe(100);
    expect(a.pagesWithIssues).not.toBe(0);
  });

  it('an evaluated run reports real defects', () => {
    const a = computeQualityAnalytics([
      page({ pageNumber: 1, qualityScore: 55, totalAttempts: 3, retryHistory: [{ attempt: 1, blocked: true }, { attempt: 2 }, { attempt: 3 }] }),
      page({ pageNumber: 2, qualityScore: 81 }),
    ], { skipQualityEval: false });

    expect(a.pagesWithIssues).toBe(1);
    expect(a.totalRetries).toBe(2);
    expect(a.firstAttemptPassRate).toBe(50);
    expect(a.contentBlocked).toBe(1);
  });

  it('defaults to evaluated when no option is passed (full story runs)', () => {
    const a = computeQualityAnalytics([page({ qualityScore: 70 })]);
    expect(a.qualityEvaluated).toBe(true);
    expect(a.avgQualityScore).toBe(70);
  });
});

describe('the trial commission survives the pipeline it is handed to', () => {
  // Problem 2: the trial sets enableFullRepair:false, but the pipeline's
  // non-admin developer-field strip deleted it (trial users are not admins),
  // so every trial ran — and recorded — the default ON.
  const strip = (inputData: any, isAdmin: boolean) => {
    const d = { ...inputData };
    if (!isAdmin && d.serverAuthoredInput !== true) {
      delete d.modelOverrides; delete d.skipImages; delete d.skipCovers;
      delete d.layoutOverride; delete d.enableFullRepair;
      delete d.maxRepairPasses; delete d.pipelineMode;
    }
    return { ...d, enableFullRepair: d.enableFullRepair !== false };
  };

  it('keeps enableFullRepair:false for a server-authored trial on a non-admin account', () => {
    const trial = { enableFullRepair: false, skipQualityEval: true, trialMode: true, serverAuthoredInput: true };
    expect(strip(trial, false).enableFullRepair).toBe(false);
  });

  it('still strips client-supplied developer fields from a normal non-admin job', () => {
    const wizard = { enableFullRepair: false, skipImages: true, serverAuthoredInput: false };
    const out = strip(wizard, false);
    expect(out.enableFullRepair).toBe(true);   // falls back to default ON
    expect(out.skipImages).toBeUndefined();
  });

  it('the real writers and the real gate agree on the marker', () => {
    // The strip above is a model of storyJobPipeline's gate; these pin that the
    // production files actually set/read the marker it models, so the model
    // cannot quietly stop describing the code.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const read = (p: string) => fs.readFileSync(require('path').join(__dirname, '../..', p), 'utf8');
    expect(read('server/routes/trial.js')).toContain('serverAuthoredInput: true');
    expect(read('server/routes/jobs.js')).toContain('inputData.serverAuthoredInput = false');
    expect(read('storyJobPipeline.js')).toContain("inputData.serverAuthoredInput !== true");
  });

  it('a trial therefore produces a not-measured analytics row', () => {
    const trial = strip({ enableFullRepair: false, skipQualityEval: true, serverAuthoredInput: true }, false);
    const a = computeQualityAnalytics(
      [{ pageNumber: 1, imageData: 'x' }],
      { skipQualityEval: trial.skipQualityEval === true },
    );
    expect(trial.enableFullRepair).toBe(false);
    expect(a.qualityEvaluated).toBe(false);
    expect(a.firstAttemptPassRate).toBeNull();
  });
});


describe('an EVALUATED run must not read an absent counter as "passed first try"', () => {
  // Evidence: staging job_1789348171785_9oxos7dwv (18 pages, beats, evaluated)
  // stored firstAttemptPassRate 100 / totalRetries 0 while all 18 pages had
  // totalAttempts: undefined and retryHistory arrays 1-3 entries long.
  // Real shape: 9 pages 1 attempt, 4 pages 2, 5 pages 3 => 14 retries, 50%.
  const realRun = [
    [1, 1], [2, 3], [3, 1], [4, 1], [5, 2], [6, 1], [7, 3], [8, 3], [9, 1],
    [10, 2], [11, 3], [12, 1], [13, 1], [14, 1], [15, 3], [16, 2], [17, 2], [18, 1],
  ].map(([n, a]) => beatsPage(n, a, a === 1 ? 85 : 40));

  it('reports the real retry count and a pass rate below 100', () => {
    const a = computeQualityAnalytics(realRun, { skipQualityEval: false });
    expect(a.attemptsMeasured).toBe(true);
    expect(a.attemptSource).toBe('retryHistory');
    expect(a.totalRetries).toBe(14);
    expect(a.firstAttemptPassRate).toBe(50);
    expect(a.firstAttemptPassRate).not.toBe(100);   // the shipped lie
  });

  it('a run that genuinely passed every page first time still reports 100 / 0', () => {
    const a = computeQualityAnalytics(
      [1, 2, 3].map(n => beatsPage(n, 1, 90)), { skipQualityEval: false });
    expect(a.firstAttemptPassRate).toBe(100);
    expect(a.totalRetries).toBe(0);
    expect(a.attemptsMeasured).toBe(true);
  });

  it('an evaluated run whose pages carry NO counter reports not-measured, never 100/0', () => {
    const a = computeQualityAnalytics(
      [1, 2].map(n => ({ pageNumber: n, imageData: 'x', qualityScore: 80 })),
      { skipQualityEval: false });
    expect(a.qualityEvaluated).toBe(true);
    expect(a.attemptsMeasured).toBe(false);
    expect(a.attemptSource).toBeNull();
    expect(a.firstAttemptPassRate).toBeNull();
    expect(a.totalRetries).toBeNull();
    expect(a.pagesWithIssues).toBe(0);            // scores WERE measured
  });

  it('falls back to totalAttempts for pages that carry it and no history (regen paths)', () => {
    const a = computeQualityAnalytics([
      { pageNumber: 1, imageData: 'x', qualityScore: 80, totalAttempts: 2 },
      { pageNumber: 2, imageData: 'x', qualityScore: 80, totalAttempts: 1 },
    ], { skipQualityEval: false });
    expect(a.attemptSource).toBe('totalAttempts');
    expect(a.totalRetries).toBe(1);
    expect(a.firstAttemptPassRate).toBe(50);
  });

  it('pageAttemptCount: history wins, totalAttempts is the fallback, absent is null', () => {
    expect(pageAttemptCount({ retryHistory: [{ attempt: 1 }, { attempt: 2 }] })).toBe(2);
    expect(pageAttemptCount({ retryHistory: [], totalAttempts: 3 })).toBe(3);
    expect(pageAttemptCount({})).toBeNull();
    expect(pageAttemptCount(null)).toBeNull();
  });

  it('an unmeasured evaluated run averages only the pages that HAVE a counter', () => {
    const a = computeQualityAnalytics([
      beatsPage(1, 3, 40),
      { pageNumber: 2, imageData: 'x', qualityScore: 80 },   // no counter at all
    ], { skipQualityEval: false });
    expect(a.totalRetries).toBe(2);                 // only page 1 counted
    expect(a.firstAttemptPassRate).toBe(0);
  });
});

describe('every run is stamped with the build that produced it', () => {
  const ENV = process.env.RAILWAY_GIT_COMMIT_SHA;
  afterEach(() => {
    if (ENV === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = ENV;
    delete process.env.SOURCE_VERSION;
  });

  it('records the short SHA from the same env var /api/health reports', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = '8838687f8c405e0fbaacf6a9c9106efd0c09ef63';
    const b = getBuildInfo();
    expect(b.commit).toBe('8838687f');
    expect(b.commitFull).toBe('8838687f8c405e0fbaacf6a9c9106efd0c09ef63');
  });

  it('a local run with no SHA records null and does not throw', () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    delete process.env.SOURCE_VERSION;
    expect(() => getBuildInfo()).not.toThrow();
    expect(getBuildInfo().commit).toBeNull();
    expect(getBuildInfo().commitFull).toBeNull();
  });

  it('the pipeline actually stamps it into analytics', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../..', 'storyJobPipeline.js'), 'utf8');
    expect(src).toContain('build: getBuildInfo()');
    expect(src).toContain('attemptsMeasured,');
  });
});
