/**
 * verify-run --write: what a judged run writes back into tasks/verify.json.
 *
 * WHY — owner, 2026-09-27: after every verification run the checker's verdicts
 * go back into the registry. CONFIRMED / FAILED become evidence and set the
 * status; HUMAN / NOT COVERED leave the entry pending with a pointer to the run
 * they were checked against; every run is logged once so the pre-push warning
 * can tell which staging runs were never recorded.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../../scripts/admin/verify-core.js');

const entry = (id: string, status = 'pending'): any => ({ id, title: id, claim: 'c', commits: [], runShape: ['any'], check: { kind: 'human', what: 'w' }, status, evidence: [] });
const run = { storyId: 'job_1', env: 'staging', build: 'f'.repeat(40), runDate: '2026-09-27 10:00:00 CH' };
const opts = { checkedAt: '2026-09-27 11:00:00 CH', via: 'write' };

describe('applyVerdicts', () => {
  it('CONFIRMED appends evidence and confirms; FAILED appends evidence and fails', () => {
    const reg: any = { entries: [entry('a'), entry('b')] };
    const { flipped } = core.applyVerdicts(reg, run, [
      { e: reg.entries[0], v: { id: 'a', result: 'CONFIRMED', detail: 'ok' } },
      { e: reg.entries[1], v: { id: 'b', result: 'FAILED', detail: 'p12 touches' } },
    ], opts);
    expect(reg.entries[0].status).toBe('confirmed');
    expect(reg.entries[0].evidence).toEqual([{ ...run, checkedAt: opts.checkedAt, result: 'CONFIRMED', note: 'ok' }]);
    expect(reg.entries[1].status).toBe('failed');
    expect(reg.entries[1].evidence[0].result).toBe('FAILED');
    expect(flipped.map((f: any) => `${f.id}:${f.to}`)).toEqual(['a:confirmed', 'b:failed']);
  });

  it('HUMAN and NOT COVERED stay pending, add no evidence, and point at the run', () => {
    const reg: any = { entries: [entry('h'), entry('n')] };
    core.applyVerdicts(reg, run, [
      { e: reg.entries[0], v: { id: 'h', result: 'HUMAN', detail: 'look', human: 'view p3' } },
      { e: reg.entries[1], v: { id: 'n', result: 'NOT COVERED', why: 'no ots page' } },
    ], opts);
    for (const e of reg.entries) {
      expect(e.status).toBe('pending');
      expect(e.evidence).toEqual([]);
      expect(e.lastChecked.storyId).toBe('job_1');
    }
    expect(reg.entries[0].lastChecked.note).toMatch(/LOOK: view p3/);
    expect(reg.entries[1].lastChecked.result).toBe('NOT COVERED');
  });

  it('logs the run once, and never appends the same story+result twice', () => {
    const reg: any = { entries: [entry('a')] };
    const v = [{ e: reg.entries[0], v: { id: 'a', result: 'CONFIRMED', detail: 'ok' } }];
    core.applyVerdicts(reg, run, v, opts);
    core.applyVerdicts(reg, run, v, opts);
    expect(reg.entries[0].evidence).toHaveLength(1);
    expect(reg.runs).toHaveLength(1);
    expect(reg.runs[0]).toMatchObject({ storyId: 'job_1', env: 'staging', via: 'write', counts: { CONFIRMED: 1, FAILED: 0 } });
  });

  it('recordedStoryIds sees runs, evidence and lastChecked', () => {
    const reg: any = { entries: [entry('a'), entry('b')], runs: [{ storyId: 's1', env: 'staging' }] };
    reg.entries[0].evidence.push({ storyId: 's2', env: 'prod' });
    reg.entries[1].lastChecked = { storyId: 's3', env: 'staging' };
    expect([...core.recordedStoryIds(reg)].sort()).toEqual(['prod:s2', 'staging:s1', 'staging:s3']);
  });
});

describe('markVerdict', () => {
  it('records a person\'s verdict with who looked, and sets the status', () => {
    const reg: any = { entries: [entry('h')] };
    core.markVerdict(reg, run, { id: 'h', verdict: 'failed', note: 'p4 sheet head row bare arms', by: 'claude' }, { checkedAt: opts.checkedAt });
    expect(reg.entries[0].status).toBe('failed');
    expect(reg.entries[0].evidence[0]).toMatchObject({ result: 'HUMAN-FAILED', by: 'claude', storyId: 'job_1' });
  });

  it('refuses a verdict without a note, an unknown id, or another word', () => {
    const reg: any = { entries: [entry('h')] };
    expect(() => core.markVerdict(reg, run, { id: 'h', verdict: 'confirmed', note: ' ' }, opts)).toThrow(/note/);
    expect(() => core.markVerdict(reg, run, { id: 'x', verdict: 'confirmed', note: 'n' }, opts)).toThrow(/no entry/);
    expect(() => core.markVerdict(reg, run, { id: 'h', verdict: 'maybe', note: 'n' }, opts)).toThrow(/confirmed, failed or fixed/);
  });
});

describe('judge + verdictOf', () => {
  it('a judged run turns into the storable verdict the write-back reads', () => {
    const e = { id: 'e', commits: ['abc'], runShape: ['any'], check: { kind: 'human', what: 'look at p1' } };
    const ctx = { build: 'f'.repeat(40), data: {} };
    const [{ j }] = core.judgeAll([e], ctx, () => true);
    expect(core.verdictOf(e, j)).toEqual({ id: 'e', result: 'HUMAN', detail: 'human check', human: 'look at p1' });
    const [{ j: j2 }] = core.judgeAll([e], ctx, () => false);
    expect(core.verdictOf(e, j2)).toMatchObject({ result: 'NOT COVERED', why: expect.stringMatching(/lacks abc/), oldCode: true });
  });
});

describe('status is the worst across runs (2026-10-09)', () => {
  const run2 = { ...run, storyId: 'job_2' };
  const pass = (e: any) => ({ e, v: { id: e.id, result: 'CONFIRMED', detail: 'ok' } });
  const fail = (e: any) => ({ e, v: { id: e.id, result: 'FAILED', detail: 'bad' } });

  it('a FAILED on a confirmed entry is recorded as a regression', () => {
    const reg: any = { entries: [entry('a', 'confirmed')] };
    const { flipped } = core.applyVerdicts(reg, run, [fail(reg.entries[0])], opts);
    expect(reg.entries[0].status).toBe('failed');
    expect(reg.entries[0].evidence.map((x: any) => x.result)).toEqual(['FAILED']);
    expect(flipped).toEqual([{ id: 'a', from: 'confirmed', to: 'failed' }]);
  });

  it('a later passing run does not clear a failed entry, but its evidence is kept', () => {
    const reg: any = { entries: [entry('a')] };
    core.applyVerdicts(reg, run, [fail(reg.entries[0])], opts);
    core.applyVerdicts(reg, run2, [pass(reg.entries[0])], opts);
    expect(reg.entries[0].status).toBe('failed');
    expect(reg.entries[0].evidence.map((x: any) => x.result)).toEqual(['FAILED', 'CONFIRMED']);
  });

  it('a human confirmed mark does not clear it either; a fixed mark does', () => {
    const reg: any = { entries: [entry('a', 'failed')] };
    core.markVerdict(reg, run2, { id: 'a', verdict: 'confirmed', note: 'passes here' }, opts);
    expect(reg.entries[0].status).toBe('failed');
    core.markVerdict(reg, run2, { id: 'a', verdict: 'fixed', note: 'fix deployed, rechecked' }, opts);
    expect(reg.entries[0].status).toBe('confirmed');
    expect(reg.entries[0].evidence.at(-1).result).toBe('HUMAN-FIXED');
  });

  it('five runs, one passing among four failing, stays failed (the effort-low chain case)', () => {
    const reg: any = { entries: [entry('a')] };
    ['f1', 'f2', 'f3', 'f4'].forEach(id => core.markVerdict(reg, { ...run, storyId: id }, { id: 'a', verdict: 'failed', note: 'n' }, opts));
    core.markVerdict(reg, { ...run, storyId: 'p' }, { id: 'a', verdict: 'confirmed', note: 'n' }, opts);
    expect(reg.entries[0].status).toBe('failed');
  });

  it('a re-pull of an already recorded failing run adds no duplicate evidence', () => {
    const reg: any = { entries: [entry('a')] };
    core.applyVerdicts(reg, run, [fail(reg.entries[0])], opts);
    core.applyVerdicts(reg, run, [fail(reg.entries[0])], opts);
    expect(reg.entries[0].evidence).toHaveLength(1);
  });
});

describe('applyVerdicts: an older build never overrides a newer pass', () => {
  const fail = (e: any) => [{ e, v: { id: e.id, result: 'FAILED', detail: 'old' } }];
  const oldRun = { ...run, storyId: 'old', build: 'a'.repeat(40) };
  const withPass = () => {
    const e = entry('a', 'confirmed');
    e.evidence.push({ storyId: 'new', env: 'staging', build: 'b'.repeat(40), result: 'CONFIRMED' });
    return { entries: [e] } as any;
  };

  it('a FAILED from an ancestor of a confirmed build is kept as history and leaves the status', () => {
    const reg = withPass();
    const seen: string[][] = [];
    core.applyVerdicts(reg, oldRun, fail(reg.entries[0]), { ...opts, buildContains: (c: string, b: string) => { seen.push([c, b]); return true; } });
    expect(reg.entries[0].status).toBe('confirmed');
    expect(reg.entries[0].evidence[1]).toMatchObject({ result: 'FAILED', superseded: true, storyId: 'old' });
    expect(seen).toEqual([[oldRun.build, 'b'.repeat(40)]]);
  });

  it('a FAILED on a build that is NOT an ancestor of the pass (or unknown) still fails the entry', () => {
    for (const answer of [false, null]) {
      const reg = withPass();
      core.applyVerdicts(reg, oldRun, fail(reg.entries[0]), { ...opts, buildContains: () => answer });
      expect(reg.entries[0].status).toBe('failed');
      expect(reg.entries[0].evidence[1].superseded).toBeUndefined();
    }
  });

  it('without a git check the failure stands (callers without git)', () => {
    const reg = withPass();
    core.applyVerdicts(reg, oldRun, fail(reg.entries[0]), opts);
    expect(reg.entries[0].status).toBe('failed');
  });
});
