/**
 * Job liveness heartbeat — behaviour pins.
 *
 * Regression: job_1789506283204_3kxqshifx. The liveness heartbeat was armed
 * only for Phase 5a image generation and cleared the moment the page-image
 * Promise.all resolved, so the whole post-generation tail (missing-page retry,
 * text regions, shared bbox detection, quality/semantic/entity evals, repair
 * rounds) wrote `updated_at` nowhere and the 10-minute watchdog in
 * server/routes/jobs.js killed an 18-page run at 64% with every page rendered.
 *
 * These pin BEHAVIOUR, not log wording: the heartbeat keeps writing for as
 * long as the job runs, writes only while the row is `processing`, stops
 * exactly once on a terminal state, and leaks no timer on the error path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startJobHeartbeat } from '../../server/lib/jobHeartbeat.js';

function fakePool() {
  const calls: any[][] = [];
  return {
    calls,
    query: vi.fn((sql: string, params: any[]) => {
      calls.push([sql, params]);
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('startJobHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps writing for the whole life of the job, not just one phase', () => {
    const pool = fakePool();
    const hb = startJobHeartbeat('job_x', pool as any, 1000);

    // A phase runs and ends...
    vi.advanceTimersByTime(3000);
    expect(pool.query).toHaveBeenCalledTimes(3);

    // ...and the long post-generation tail keeps being covered.
    vi.advanceTimersByTime(30000);
    expect(pool.query).toHaveBeenCalledTimes(33);

    hb.stop();
  });

  it('only touches a row that is still processing', () => {
    const pool = fakePool();
    const hb = startJobHeartbeat('job_x', pool as any, 1000);
    vi.advanceTimersByTime(1000);

    const [sql, params] = pool.calls[0];
    expect(sql).toMatch(/UPDATE story_jobs/i);
    expect(sql).toMatch(/updated_at\s*=\s*CURRENT_TIMESTAMP/i);
    expect(sql).toMatch(/status\s*=\s*'processing'/i);
    expect(params).toEqual(['job_x']);

    hb.stop();
  });

  it('stops exactly once on a terminal state and never writes again', () => {
    const pool = fakePool();
    const hb = startJobHeartbeat('job_x', pool as any, 1000);
    vi.advanceTimersByTime(2000);
    const before = pool.query.mock.calls.length;

    hb.stop();
    hb.stop(); // idempotent — a double-disarm must not throw
    vi.advanceTimersByTime(60000);

    expect(pool.query.mock.calls.length).toBe(before);
  });

  it('leaks no timer when the job throws (finally-disarm pattern)', async () => {
    const pool = fakePool();
    const hb = startJobHeartbeat('job_x', pool as any, 1000);
    await expect(
      (async () => {
        try {
          throw new Error('pipeline blew up');
        } finally {
          hb.stop();
        }
      })()
    ).rejects.toThrow('pipeline blew up');

    vi.advanceTimersByTime(60000);
    expect(pool.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives a failing database write and keeps beating', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('db gone')),
    };
    const hb = startJobHeartbeat('job_x', pool as any, 1000);
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(pool.query).toHaveBeenCalledTimes(3);
    hb.stop();
  });

  it('is a no-op (not a crash) without a jobId or pool', () => {
    expect(() => startJobHeartbeat('', null as any).stop()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the worker arms the heartbeat once, at the single entry point', () => {
  // Structural pin: the fix is "one mechanism, one source of truth". If a
  // future change re-introduces a phase-local liveness interval, or moves the
  // arm/disarm out of the outermost try/finally, this fails.
  const fs = require('fs');
  const src: string = fs.readFileSync(
    require('path').join(__dirname, '../../storyJobPipeline.js'),
    'utf8'
  );

  it('arms startJobHeartbeat exactly once', () => {
    const armed = src.match(/startJobHeartbeat\(/g) || [];
    expect(armed.length).toBe(1);
  });

  it('disarms it exactly once, in the same outermost finally as the analyzer session', () => {
    const stops = src.match(/jobHeartbeat\.stop\(\)/g) || [];
    expect(stops.length).toBe(1);
    // arm ... try ... finally { stop; sessionEnd } — the terminal boundary that
    // already covers completion, failure and cancellation alike.
    expect(src).toMatch(
      /const jobHeartbeat = startJobHeartbeat\([^)]*\);\s*try \{[\s\S]{0,200}?\} finally \{\s*jobHeartbeat\.stop\(\);/
    );
  });

  it('has no phase-local liveness-only setInterval left in the image phase', () => {
    // The old shape: a bare interval whose only statement is an updated_at
    // touch. Progress-bearing timers (which also move `progress`) are fine.
    const bare = src.match(
      /setInterval\(\(\) => \{\s*dbPool\.query\('UPDATE story_jobs SET updated_at = CURRENT_TIMESTAMP/g
    ) || [];
    expect(bare.length).toBe(0);
  });
});
