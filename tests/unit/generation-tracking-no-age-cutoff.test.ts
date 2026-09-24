import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { jobStatusOutcome } from '../../client/src/context/jobStatusOutcome';

// The global generation tracker ends only on a terminal SERVER status. It used
// to drop any job still processing after 60 minutes; production stories run
// 52-83 minutes (tasks/bugs.json generation-tracking-dropped-after-60-min).
describe('generation tracker: the server decides when a job ends', () => {
  it('a processing or pending job keeps running, however old', () => {
    expect(jobStatusOutcome({ status: 'processing' })).toBe('running');
    expect(jobStatusOutcome({ status: 'pending' })).toBe('running');
  });

  it('completed with a result ends the job as completed', () => {
    expect(jobStatusOutcome({ status: 'completed', hasResult: true })).toBe('completed');
    expect(jobStatusOutcome({ status: 'completed', hasResult: false })).toBe('running');
  });

  it('a server-detected stall or abandonment still clears the job, silently', () => {
    expect(jobStatusOutcome({ status: 'failed', error: 'Job stopped responding (no progress for 11 minutes) - please try again' })).toBe('ended-silent');
    expect(jobStatusOutcome({ status: 'failed', error: 'Job abandoned' })).toBe('ended-silent');
    expect(jobStatusOutcome({ status: 'cancelled' })).toBe('ended-silent');
  });

  it('a real failure clears the job with an error', () => {
    expect(jobStatusOutcome({ status: 'failed', error: 'Job timed out after 181 minutes - please try again' })).toBe('ended-error');
    expect(jobStatusOutcome({ status: 'failed' })).toBe('ended-error');
  });

  it('the context has no age-based cutoff left', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../client/src/context/GenerationContext.tsx'), 'utf8');
    expect(src).not.toMatch(/ORPHANED_JOB_THRESHOLD_MS|MAX_RESTORE_AGE_MS|jobAge/);
    expect(src).toContain('jobStatusOutcome(');
  });
});
