/**
 * Finding B4: an unevaluated run must report NOT MEASURED, never a clean score.
 *
 * Evidence: prod trial job_1789292742265_mgxmrkfpd (6 pages, zero eval records)
 * shipped `firstAttemptPassRate: 100, pagesWithIssues: 0, totalRetries: 0` —
 * read as "6 pages evaluated, all passed first try" — while four of its six
 * pages had real defects. See docs/decisions.md (2026-09-13).
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeQualityAnalytics } = require('../../server/lib/storyMetrics.js');

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
      page({ pageNumber: 1, qualityScore: 55, totalAttempts: 3, retryHistory: [{ blocked: true }, {}] }),
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
