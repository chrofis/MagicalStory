import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { collectTextSideReports, saveTextOnlyStoryData } = require('../../server/lib/textSideReports.js');
const { startEarlyAvatarStyling } = require('../../server/lib/earlyAvatarStyling.js');

// Regression (2026-11-07, job_1794067759328_ud0gsxvn3r): the admin text-only rerun
// (skipImages) stored only pages+title, so the arc report, the panel findings and the
// beats review of a plot rerun were lost; and it started paid avatar styling.

const beatsResult = {
  arcReviewReport: { finalArc: 'ARC', logic: 'STORY LOGIC', rounds: [{ retellPrompt: 'p' }] },
  beatsReviewReport: { arc: 'ARC', pagePlan: [] },
  jevDecisions: { pages: [] },
  briefCheckReport: { findings: [] },
  sceneExpansionReport: { timings: { ms: 5 } },
  meta: { storyTextCall: { startPage: 1, endPage: 8, prompt: 'P', rawResponse: 'R', analysis: 'A', modelId: 'm', usage: {} } },
};

describe('collectTextSideReports', () => {
  it('carries the arc, beats and brief reports under the names stories.data uses', () => {
    const r = collectTextSideReports(beatsResult, { scenePromptTable: ['AD prompt'] });
    expect(r.arcReviewReport.finalArc).toBe('ARC');
    expect(r.arcReviewReport.logic).toBe('STORY LOGIC');
    expect(r.beatsReviewReport).toEqual(beatsResult.beatsReviewReport);
    expect(r.jevDecisions).toEqual(beatsResult.jevDecisions);
    expect(r.briefCheckReport).toEqual(beatsResult.briefCheckReport);
    expect(r.sceneExpansionReport).toEqual({ timings: { ms: 5 }, prompts: ['AD prompt'] });
    expect(r.storyTextPrompts).toHaveLength(1);
    expect(r.storyTextPrompts[0].analysis).toBe('A');
  });

  it('is all-null / empty on the trial writer (no beats result)', () => {
    const r = collectTextSideReports(null);
    expect(r.arcReviewReport).toBeNull();
    expect(r.storyTextPrompts).toEqual([]);
  });
});

describe('saveTextOnlyStoryData', () => {
  it('merges into stories.data only, never touching metadata', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    await saveTextOnlyStoryData(pool, 'job_1', { arcReviewReport: { a: 1 } });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE stories SET data = .*\|\| \$2::jsonb/);
    expect(sql).not.toMatch(/metadata/);
    expect(JSON.parse(params[1]).arcReviewReport).toEqual({ a: 1 });
  });

  it('fails loudly when the stories row is missing', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    await expect(saveTextOnlyStoryData(pool, 'job_x', {})).rejects.toThrow(/no stories row/);
  });
});

describe('the text-only branch of the pipeline', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
  it('saves the reports before it marks the job completed', () => {
    const branch = src.slice(src.indexOf('Skipping image generation (text-only mode)'));
    const save = branch.indexOf('saveTextOnlyStoryData(dbPool, jobId');
    const done = branch.indexOf("['completed', 100,");
    expect(save).toBeGreaterThan(0);
    expect(save).toBeLessThan(done);
    expect(branch.slice(0, done)).toContain('collectTextSideReports(beatsResult');
  });
});

describe('early avatar styling under skipImages', () => {
  it('never calls the paid styling when skipImages is set', () => {
    const prepare = vi.fn().mockResolvedValue(undefined);
    expect(startEarlyAvatarStyling({ trialMode: false, skipImages: true, run: prepare })).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
  it('still styles on a normal full run', async () => {
    const prepare = vi.fn().mockResolvedValue(undefined);
    await startEarlyAvatarStyling({ trialMode: false, skipImages: false, run: prepare });
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('leaves a trial to its own styling path', () => {
    const prepare = vi.fn();
    expect(startEarlyAvatarStyling({ trialMode: true, skipImages: false, run: prepare })).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
});
