/**
 * A running Test Lab experiment can be aborted.
 *
 * Before 2026-10-07 there was no abort route and no abort read in the run loop,
 * so firing an N-target set committed the whole spend the moment it started
 * (exp 815, 2026-08-23: clearly losing by result 4 of 14, the remaining 9 ran).
 *
 * The flag is read BETWEEN units — the unit in flight completes, every unit
 * after it is skipped, the row closes as 'aborted' with the results it reached.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const reg = require_('../../server/lib/testlabAbort.js');
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('the abort registry', () => {
  beforeEach(() => { reg.markDone(815); reg.markDone(816); });

  it('refuses an experiment this process does not run', () => {
    expect(reg.requestAbort(815, 'owner')).toBe(false);
    expect(reg.abortRequested(815)).toBeNull();
  });

  it('flags a running experiment once, with who asked, and clears when it ends', () => {
    reg.markRunning(815);
    expect(reg.isRunningHere(815)).toBe(true);
    expect(reg.requestAbort(815, 'owner')).toBe(true);
    expect(reg.requestAbort(815, 'someone-else')).toBe(true);
    expect(reg.abortRequested(815).by).toBe('owner');
    expect(reg.abortRequested(816)).toBeNull();
    reg.markDone(815);
    expect(reg.isRunningHere(815)).toBe(false);
    expect(reg.abortRequested(815)).toBeNull();
  });

  it('names the count it reached', () => {
    const err = new reg.ExperimentAborted(815, { by: 'owner', done: 4, total: 14 });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('aborted by owner after 4 of 14 results');
  });
});

describe('the run loop and the route', () => {
  const src = read('server/routes/admin/testlab.js');

  it('reads the flag before every unit, never inside one', () => {
    // Once before the fresh-detection unit of a target, once before each variant unit.
    expect(src.match(/stopIfAborted\(\);/g)?.length).toBe(2);
    expect(src).toMatch(/for \(const variant of \(variants \|\| \[null\]\)\) \{\s*\n\s*stopIfAborted\(\);/);
  });

  it("closes an aborted row as 'aborted', anything else as 'failed', and always deregisters", () => {
    expect(src).toMatch(/err instanceof abortReg\.ExperimentAborted \? 'aborted' : 'failed'/);
    expect(src).toMatch(/finally \{\s*\n\s*clearInterval\(heartbeat\);\s*\n\s*abortReg\.markDone\(experimentId\);/);
  });

  it('exposes POST /experiments/:id/abort for a running row only', () => {
    expect(src).toMatch(/router\.post\('\/experiments\/:id\/abort'/);
    expect(src).toMatch(/status !== 'running'\) return res\.status\(409\)/);
  });

  it('the Test Lab page offers the button while an experiment runs', () => {
    const client = read('client/src/pages/TestLab.tsx');
    expect(client).toMatch(/detail\.status === 'running' && \([\s\S]{0,400}testlabService\.abort\(detail\.id\)/);
    expect(read('client/src/services/testlabService.ts')).toMatch(/experiments\/\$\{experimentId\}\/abort/);
  });
});
