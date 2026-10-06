/**
 * #29 — the push gate and the Test Lab must not disagree about what is running.
 *
 * Measured 2026-09-11: experiments 1160 and 1163 sat at `status='running'` after
 * a deploy killed them, while `GET /api/health/busy` returned
 * `{"busy":false,"reasons":[]}`. A push passed the gate on that answer.
 *
 * Cause: reaping lived INLINE in `GET /experiments`, so an orphaned row was only
 * reconciled when a human opened the Test Lab. The busy probe meanwhile counts
 * only rows with a FRESH heartbeat (5 minutes), so it stopped seeing the row
 * minutes after the death. Two readers, two answers, nothing reconciling them.
 *
 * The 5-minute window is deliberately NOT widened — the old blanket 2h rule held
 * every push, staging and production, for an hour (exp747, 2026-08-19).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('one reconciler, three callers', () => {
  it('the reaper module exports the reconciler, the counter and the window', () => {
    const m = require('../../server/lib/testlabReaper.js');
    expect(typeof m.reapOrphanedExperiments).toBe('function');
    expect(typeof m.countStaleRunning).toBe('function');
    expect(m.HEARTBEAT_STALE).toBe('5 minutes');
  });

  it('boot reconciles, so a restart cannot leave an orphan waiting for a page view', () => {
    const src = read('server.js');
    expect(src).toMatch(/require\('\.\/server\/lib\/testlabReaper'\)\s*\n?\s*\.reapOrphanedExperiments\(/);
  });

  it('the busy probe reconciles BEFORE it reports idle', () => {
    const src = read('server/lib/idleShutdown.js');
    expect(src).toMatch(/reapOrphanedExperiments, countStaleRunning \} = require\('\.\/testlabReaper'\)/);
    // And a row it could not reconcile is reported BUSY, never silently idle.
    expect(src).toMatch(/stuck at 'running' that could not be reconciled — treating as busy/);
  });

  it('the experiments route uses the shared reconciler, not its own copy', () => {
    const src = read('server/routes/admin/testlab.js');
    expect(src).toMatch(/require\('\.\.\/\.\.\/lib\/testlabReaper'\)\.reapOrphanedExperiments\(\)/);
    // The inline UPDATE is gone — two copies of the rule could drift apart.
    expect(src).not.toMatch(/SET status = 'failed', error = 'server restarted mid-run'/);
  });

  it('the staleness window has ONE definition', () => {
    const route = read('server/routes/admin/testlab.js');
    expect(route).not.toMatch(/const HEARTBEAT_STALE = '5 minutes'/);
    expect(route).toMatch(/\{ HEARTBEAT_STALE \} = require\('\.\.\/\.\.\/lib\/testlabReaper'\)/);
  });

  it('the probe still reports a LIVE run as busy, unchanged', () => {
    const src = read('server/lib/idleShutdown.js');
    expect(src).toMatch(/return `\$\{n\} experiment\(s\) running`/);
    // The freshness window itself is untouched: widening it back to 2h is what
    // blocked every push for an hour (exp747). The predicate is the reaper's own
    // (liveRunningSql), so the probe and the reconciler cannot disagree.
    expect(src).toContain('liveRunningSql()');
    expect(require('../../server/lib/testlabReaper.js').liveRunningSql()).toContain("heartbeat_at > NOW() - INTERVAL '5 minutes'");
  });
});

/**
 * REGRESSION (2026-10-06): Test Lab experiment #1664 died before its first heartbeat, and the busy
 * probe counted a 'running' row with a NULL heartbeat as busy for up to 2 hours, so it blocked every
 * staging push for ~40 minutes. A live run beats the moment it starts, so a NULL heartbeat gets a
 * short grace from created_at (10 minutes), defined once and shared by the probe, the reaper and the
 * stale counter.
 */
describe('a row with no heartbeat is dead after a short grace, never 2 hours', () => {
  const R = require('../../server/lib/testlabReaper.js');

  it('the grace is ten minutes and far under the old 2h rule', () => {
    expect(R.NULL_HEARTBEAT_GRACE).toBe('10 minutes');
    expect(R.liveRunningSql()).not.toContain('2 hours');
    expect(R.staleRunningSql()).not.toContain('2 hours');
  });

  it('live and stale are one window, mirrored: same two intervals, opposite comparison', () => {
    const live = R.liveRunningSql();
    const stale = R.staleRunningSql();
    for (const sql of [live, stale]) {
      expect(sql).toContain(`INTERVAL '${R.HEARTBEAT_STALE}'`);
      expect(sql).toContain(`created_at ${sql === live ? '>' : '<'} NOW() - INTERVAL '${R.NULL_HEARTBEAT_GRACE}'`);
    }
  });

  it('the probe, the reaper UPDATE and the stale counter all read the shared predicates, none its own copy', () => {
    const probe = read('server/lib/idleShutdown.js');
    const reaper = read('server/lib/testlabReaper.js');
    expect(probe).not.toMatch(/heartbeat_at IS NULL/);
    expect(reaper.match(/staleRunningSql\(\)\}/g)?.length).toBe(2);
    expect(reaper.match(/heartbeat_at IS NULL/g)?.length).toBe(2); // the two predicate definitions, once each
  });
});
