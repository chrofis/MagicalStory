import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * A COUNTER WIRED TO A MISSING JOB ID USED TO VANISH.
 *
 * Measured on staging run job_1789304198359_y3n0euk3z: stories.data.runMetrics
 * held 12 counters and NO `presence_*` key, though the presence derivation ran
 * on all 23 page-version evaluations and authored 3 findings. The counters key
 * off evalOptions.storyMeta.storyId, which comes from evaluateImageBatch's
 * `storyId = null` default — and not one of the five repairPipeline call sites
 * passed it, so runMetrics.forJob(null) returned the silent NOOP recorder.
 * `eval_matches_missing` and `eval_refs_attach_failed` died the same way.
 *
 * These pin: the recorder lands, the unscoped case is loud, and the call sites
 * thread the id.
 */
const runMetrics = require('../../server/lib/runMetrics');
const { presenceCounterName } = require('../../server/lib/evalPipeline');

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const STYLED = require.resolve('../../server/lib/styledAvatars');

/** Install a fake styledAvatars in the require cache carrying a real ALS. */
function withAmbientScope(jobId: string, fn: () => void) {
  const als = new AsyncLocalStorage<string>();
  const prev = require.cache[STYLED];
  require.cache[STYLED] = { exports: { _cacheContext: als } } as any;
  try { als.run(jobId, fn); } finally {
    if (prev) require.cache[STYLED] = prev; else delete require.cache[STYLED];
  }
}

beforeEach(() => { runMetrics._resetWarned(); });
afterEach(() => { delete process.env.RUN_METRICS_STRICT; });

describe('the presence counter name comes from the derivation, not the call site', () => {
  it('names a decided outcome, with and without a reason', () => {
    expect(presenceCounterName({ outcome: 'missing_character', reason: null }, true))
      .toBe('presence_missing_character');
    expect(presenceCounterName({ outcome: 'extra_character', reason: 'roster_short' }, true))
      .toBe('presence_extra_character_roster_short');
  });

  it('names a DECLINED derivation by its reason — the 17%-of-pages case', () => {
    expect(presenceCounterName({ reason: 'witnesses_disagree' }, false))
      .toBe('presence_declined_witnesses_disagree');
  });

  it('never emits an `undefined` suffix when a reason is absent', () => {
    expect(presenceCounterName({}, false)).toBe('presence_declined');
  });
});

describe('a counter recorded with a story id actually lands in that story bag', () => {
  it('shows up in the snapshot the persist path reads', () => {
    const id = 'job_test_lands_1';
    runMetrics.forJob(id).count(presenceCounterName({ reason: 'witnesses_disagree' }, false));
    runMetrics.forJob(id).count(presenceCounterName({ reason: 'witnesses_disagree' }, false));
    runMetrics.forJob(id).count('eval_matches_missing');
    expect(runMetrics.getSnapshot(id)).toEqual({
      presence_declined_witnesses_disagree: 2,
      eval_matches_missing: 1,
    });
    runMetrics.release(id);
    expect(runMetrics.getSnapshot(id)).toEqual({});
  });
});

describe('a missing job id no longer fails silently', () => {
  it('rescues the counter from the ambient run scope and WARNs once per name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = 'job_test_ambient_1';
    withAmbientScope(id, () => {
      for (let i = 0; i < 5; i++) runMetrics.forJob(null).count('presence_declined_witnesses_disagree');
      runMetrics.forJob(undefined).count('eval_matches_missing');
    });
    // The counts are NOT lost.
    expect(runMetrics.getSnapshot(id)).toEqual({
      presence_declined_witnesses_disagree: 5,
      eval_matches_missing: 1,
    });
    // One line per counter NAME, not per increment.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('presence_declined_witnesses_disagree');
    expect(warn.mock.calls[0][0]).toContain('WITHOUT a job id');
    runMetrics.release(id);
    warn.mockRestore();
  });

  it('stays silent and harmless outside a run — admin tools have no id by design', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => runMetrics.forJob(null).count('whatever')).not.toThrow();
    expect(() => runMetrics.forJob(null).add('whatever', 3)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws under RUN_METRICS_STRICT so a drop is assertable', () => {
    process.env.RUN_METRICS_STRICT = '1';
    expect(() => runMetrics.forJob(null).count('presence_declined'))
      .toThrow(/presence_declined/);
  });

  it('does not require the heavy styledAvatars graph to answer "am I in a run?"', () => {
    // Reading the require cache, not require()-ing: styledAvatars top-level
    // requires ./images and pulls every provider.
    expect(read('server/lib/runMetrics.js')).toMatch(/require\.cache\[require\.resolve\('\.\/styledAvatars'\)\]/);
    expect(read('server/lib/runMetrics.js')).not.toMatch(/require\('\.\/styledAvatars'\)/);
  });
});

describe('the eval call sites thread the story id', () => {
  it('evaluateImageBatch puts its storyId option into storyMeta', () => {
    expect(read('server/lib/images.js')).toMatch(/storyMeta: \{\s*\n?\s*storyId,/);
  });

  it('every evaluateImageBatch call in the repair pipeline carries it', () => {
    const src = read('server/lib/repairPipeline.js');
    const calls = src.match(/evaluateImageBatch\(/g) || [];
    expect(calls.length).toBe(5);
    expect((src.match(/\.\.\.evalStoryMeta/g) || []).length).toBe(5);
    expect(src).toMatch(/const evalStoryMeta = \{\s*\n\s*storyId: storyData\?\.id \|\| jobId \|\| null,/);
  });

  it('both cover-iterate evals carry it too — covers run inside the story job', () => {
    const src = read('server/lib/coverIterate.js');
    expect((src.match(/storyMeta: \{ storyId: storyData\?\.id \|\| null \}/g) || []).length).toBe(2);
  });

  it('the eval records unconditionally — no `if (sid)` gate to hide the drop', () => {
    const src = read('server/lib/evalPipeline.js');
    expect(src).not.toMatch(/if \(sid\) require\('\.\/runMetrics'\)/);
    expect((src.match(/forJob\(evalOptions\?\.storyMeta\?\.storyId\)/g) || []).length).toBe(3);
  });
});
