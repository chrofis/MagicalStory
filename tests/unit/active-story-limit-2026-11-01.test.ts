/**
 * Up to 3 stories in the making per account (owner 2026-11-01, docs/decisions.md).
 *
 * The old rule was ONE active job per account; on production a paying customer was
 * forced to cancel two running stories (the 409 "cancel the running one?" prompt) to
 * start new ones. These tests pin the new rule: 0/1/2 live jobs may start another, 3
 * may not; stale jobs are failed+refunded and do not count; the in-transaction
 * re-check counts rows; the wizard never offers to cancel a running story.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore - CJS module
import * as lib from '../../server/lib/activeStoryJobs.js';
// @ts-ignore - CJS module
import { runtime } from '../../server/config/runtime.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();
const row = (id: string, createdMin: number, updatedMin: number, status = 'processing') =>
  ({ id, status, created_at: minsAgo(createdMin), updated_at: minsAgo(updatedMin), progress: 10 });

const poolWith = (rows: any[]) => ({ query: vi.fn(async () => ({ rows })) });
const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('cap setting', () => {
  it('is 3 and lives in runtime.js', () => {
    expect(runtime('maxActiveStoryJobsPerUser')).toBe(3);
  });
  it('is the only place the number 3 is decided: jobs.js reads the setting', () => {
    const jobs = read('server/routes/jobs.js');
    expect(jobs).toContain("runtime('maxActiveStoryJobsPerUser')");
    expect(jobs).not.toMatch(/ACTIVE_JOB_RACE'\);[\s\S]{0,40}LIMIT 1/);
  });
});

describe('resolveLiveActiveJobs + isAtActiveStoryLimit', () => {
  it.each([0, 1, 2])('%i live jobs: another story is allowed', async (n) => {
    const rows = Array.from({ length: n }, (_, i) => row(`job_${i}`, 20, 1));
    const { live } = await lib.resolveLiveActiveJobs(poolWith(rows), 'u1', { now: NOW });
    expect(live).toHaveLength(n);
    expect(lib.isAtActiveStoryLimit(live.length)).toBe(false);
  });

  it('3 live jobs: refused', async () => {
    const rows = [row('a', 20, 1), row('b', 15, 1), row('c', 5, 0, 'pending')];
    const { live } = await lib.resolveLiveActiveJobs(poolWith(rows), 'u1', { now: NOW });
    expect(live.map((j: any) => j.id)).toEqual(['a', 'b', 'c']);
    expect(lib.isAtActiveStoryLimit(live.length)).toBe(true);
  });

  it('stale jobs (heartbeat > 10 min, or age > 180 min) are failed+refunded and not counted', async () => {
    const rows = [row('live1', 20, 1), row('silent', 40, 11), row('ancient', 200, 1), row('live2', 5, 0)];
    const settle = vi.fn(async () => ({ refunded: 25 }));
    const { live, staleSettled } = await lib.resolveLiveActiveJobs(poolWith(rows), 'u1', { now: NOW, settle });
    expect(live.map((j: any) => j.id)).toEqual(['live1', 'live2']);
    expect(staleSettled).toEqual(['silent', 'ancient']);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls.map((c: any[]) => c[1])).toEqual(['silent', 'ancient']);
    expect(settle.mock.calls[0][2]).toMatchObject({ status: 'failed', statusIn: ['pending', 'processing'] });
    expect(lib.isAtActiveStoryLimit(live.length)).toBe(false);
  });

  it('3 live + 1 stale: the stale one is cleaned up, the cap still holds', async () => {
    const rows = [row('a', 20, 1), row('b', 20, 1), row('c', 20, 1), row('dead', 60, 30)];
    const settle = vi.fn(async () => ({ refunded: 0 }));
    const { live } = await lib.resolveLiveActiveJobs(poolWith(rows), 'u1', { now: NOW, settle });
    expect(live).toHaveLength(3);
    expect(lib.isAtActiveStoryLimit(live.length)).toBe(true);
  });

  it('a stale job whose refund throws is not counted as live and does not abort the check', async () => {
    const rows = [row('silent', 40, 11)];
    const settle = vi.fn(async () => { throw new Error('db down'); });
    const { live } = await lib.resolveLiveActiveJobs(poolWith(rows), 'u1', { now: NOW, settle, log: { info() {}, error() {} } });
    expect(live).toHaveLength(0);
  });
});

describe('409 body', () => {
  it('has the machine-readable code, cap, ids and a plain message', () => {
    const body = lib.activeStoryLimitBody(['a', 'b', 'c'], 3);
    expect(body).toMatchObject({
      error: 'Too many stories in progress',
      code: 'ACTIVE_STORY_LIMIT',
      maxActive: 3,
      activeJobIds: ['a', 'b', 'c'],
    });
    expect(body.message).toBe('You already have 3 stories being made. Please wait until one finishes before starting another.');
    // the old single-job fields are gone
    expect(body).not.toHaveProperty('activeJobId');
    expect(body).not.toHaveProperty('jobAgeMinutes');
  });
});

describe('in-transaction re-check (per-user advisory lock + COUNT)', () => {
  const tx = (rows: any[]) => {
    const calls: string[] = [];
    return { calls, client: { query: vi.fn(async (sql: string) => { calls.push(sql); return { rows: sql.includes('advisory') ? [] : rows }; }) } };
  };

  it('takes the lock first, then allows when under the cap', async () => {
    const { client, calls } = tx([{ id: 'a', status: 'processing' }, { id: 'b', status: 'pending' }]);
    const r = await lib.checkActiveCapInTransaction(client, 'u1');
    expect(calls[0]).toContain('pg_advisory_xact_lock');
    expect(r.atLimit).toBe(false);
  });

  it('two concurrent requests cannot exceed the cap: with 3 committed rows the re-check refuses', async () => {
    const { client } = tx([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const r = await lib.checkActiveCapInTransaction(client, 'u1');
    expect(r.atLimit).toBe(true);
    expect(r.activeJobIds).toEqual(['a', 'b', 'c']);
  });

  it('a single active row no longer refuses (regression: old code refused at 1)', async () => {
    const { client } = tx([{ id: 'a' }]);
    expect((await lib.checkActiveCapInTransaction(client, 'u1')).atLimit).toBe(false);
  });
});

describe('client never offers to cancel a running story on a 409', () => {
  it('StoryWizard handles ACTIVE_STORY_LIMIT without cancelJob or confirm', () => {
    const wiz = read('client/src/pages/StoryWizard.tsx');
    expect(wiz).toContain("'ACTIVE_STORY_LIMIT'");
    // (cancelJob remains for the user's own explicit cancel button; it must not be in the 409 handler)
    expect(wiz).not.toContain('|ACTIVE_JOB:');
    const block = wiz.slice(wiz.indexOf("'ACTIVE_STORY_LIMIT'"), wiz.indexOf("'ACTIVE_STORY_LIMIT'") + 1500);
    expect(block).not.toContain('window.confirm');
    expect(block).not.toContain('cancelJob');
    expect(block).toContain('Du hast bereits'); // Swiss spelling, no eszett
    expect(block).not.toContain('ß');
  });

  it('api.ts no longer appends |ACTIVE_JOB: and carries maxActive', () => {
    const api = read('client/src/services/api.ts');
    expect(api).not.toContain('ACTIVE_JOB');
    expect(api).toContain('maxActive');
  });
});
