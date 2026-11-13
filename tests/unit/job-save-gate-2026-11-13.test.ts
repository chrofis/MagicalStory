/**
 * Pipeline review 2026-11-13, finding 1: the status-poll watchdog (server/routes/jobs.js)
 * fails AND refunds a job it thinks is stuck, but the worker kept running and saved the
 * full story, because the save path only stopped on 'cancelled'. The user got the refund
 * and the story. The save gate now stops on ANY non-processing status.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore - CJS module
import { markJobSavingOrThrow, JobNoLongerLiveError } from '../../server/lib/jobSaveGate.js';
// @ts-ignore - CJS module
import { JOB_SAVING_PROGRESS } from '../../server/lib/jobCredits.js';

const ROOT = path.resolve(__dirname, '../..');

/** A fake story_jobs table with one row; the UPDATE honours the status='processing' guard. */
function fakeJobs(status: string | null) {
  const calls: { sql: string; params: any[] }[] = [];
  let row = status === null ? null : { status, progress: 80 };
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/^\s*UPDATE story_jobs/.test(sql)) {
        if (row && row.status === 'processing') { row.progress = params[1]; return { rowCount: 1, rows: [{ id: params[0] }] }; }
        return { rowCount: 0, rows: [] };
      }
      if (/^\s*SELECT status FROM story_jobs/.test(sql)) return { rows: row ? [{ status: row.status }] : [] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  return { pool, calls, row: () => row };
}

describe('markJobSavingOrThrow', () => {
  it('a live job is marked saving and the save may go ahead', async () => {
    const jobs = fakeJobs('processing');
    await expect(markJobSavingOrThrow(jobs.pool, 'job_1')).resolves.toBeUndefined();
    expect(jobs.row()?.progress).toBe(JOB_SAVING_PROGRESS);
  });

  it('a job the watchdog failed and refunded is NOT saved', async () => {
    const jobs = fakeJobs('failed');
    const err = await markJobSavingOrThrow(jobs.pool, 'job_1').catch((e: any) => e);
    expect(err).toBeInstanceOf(JobNoLongerLiveError);
    expect(err.name).toBe('JobNoLongerLiveError');
    expect(err.status).toBe('failed');
  });

  it('a job the user cancelled is NOT saved', async () => {
    const err = await markJobSavingOrThrow(fakeJobs('cancelled').pool, 'job_1').catch((e: any) => e);
    expect(err.name).toBe('JobNoLongerLiveError');
    expect(err.status).toBe('cancelled');
  });

  it('a deleted job row is NOT saved', async () => {
    const err = await markJobSavingOrThrow(fakeJobs(null).pool, 'job_1').catch((e: any) => e);
    expect(err.name).toBe('JobNoLongerLiveError');
    expect(err.status).toBeNull();
  });
});

describe('the pipeline uses the gate before the story row is written', () => {
  const src = fs.readFileSync(path.join(ROOT, 'storyJobPipeline.js'), 'utf8');

  it('the full-story upsert comes right after markJobSavingOrThrow', () => {
    const gate = src.indexOf('await markJobSavingOrThrow(dbPool, jobId);');
    expect(gate).toBeGreaterThan(-1);
    const nextUpsert = src.indexOf('await upsertStory(storyId', gate);
    expect(nextUpsert).toBeGreaterThan(gate);
    // nothing else may sit between the gate and the save that could swallow the throw
    expect(src.slice(gate, nextUpsert)).not.toMatch(/catch\s*\(/);
  });

  it('the old save path that only stopped on cancelled is gone', () => {
    expect(src).not.toMatch(/savingMark\.rowCount === 0\) await checkCancellation/);
  });

  it('the pipeline catch stops without settling again when the gate threw', () => {
    const i = src.indexOf("error.name === 'JobNoLongerLiveError'");
    expect(i).toBeGreaterThan(-1);
    const settle = src.indexOf('settleJobWithRefund(dbPool, jobId', i);
    const ret = src.indexOf('return null;', i);
    expect(ret).toBeGreaterThan(i);
    expect(ret).toBeLessThan(settle);
  });
});
