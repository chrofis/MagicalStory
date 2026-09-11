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
    // blocked every push for an hour (exp747).
    expect(src).toMatch(/heartbeat_at > NOW\(\) - INTERVAL '5 minutes'/);
  });
});
