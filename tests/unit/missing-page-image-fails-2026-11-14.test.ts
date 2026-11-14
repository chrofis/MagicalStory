/**
 * Owner 2026-11-14 (pipeline review finding 6): a page still without a picture after the Phase 5a
 * retry fails the job and refunds it, instead of shipping an incomplete book with a stored flag.
 * skipImages runs (no pictures by design) are exempt. Pinned on the source because the check sits
 * deep in processUnifiedStoryJob; the refund itself is the catch that settleJobWithRefund pins
 * (tests/unit/job-credits.test.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '../../storyJobPipeline.js'), 'utf8');

describe('a missing page picture fails the job', () => {
  const at = src.indexOf('const missingImages = (allImages || [])');
  const block = src.slice(at, src.indexOf('if (missingCovers.length > 0)', at));

  it('throws when a page has no image, unless the run skips images by design', () => {
    expect(at).toBeGreaterThan(-1);
    expect(block).toMatch(/if \(missingImages\.length > 0 && !skipImages\) \{/);
    expect(block).toMatch(/throw new Error\(`No image on page\(s\)/);
  });

  it('the throw comes before the save gate, so no story row with a hole is written', () => {
    expect(at).toBeLessThan(src.indexOf('await markJobSavingOrThrow(dbPool, jobId);'));
  });

  it('the function catch that receives it fails and refunds the job', () => {
    const c = src.indexOf("if (error.name === 'JobNoLongerLiveError')", at);
    expect(c).toBeGreaterThan(at);
    expect(src.slice(c, c + 2000)).toMatch(/settleJobWithRefund\(dbPool, jobId, \{\s*status: 'failed'/);
  });

  it('covers are unchanged: still logged and shipped', () => {
    const covers = src.slice(src.indexOf('if (missingCovers.length > 0)', at), src.indexOf('if (missingCovers.length > 0)', at) + 300);
    expect(covers).not.toMatch(/throw/);
  });
});
