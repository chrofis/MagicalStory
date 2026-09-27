/**
 * The staging server judges every completed story against tasks/verify.json
 * (server/lib/verifyAutoCheck.js) and verify-run.js --pull writes the stored
 * report into the registry (owner, 2026-09-27).
 *
 * Pinned here: the auto-check is off outside staging, stores one report row
 * per story with the same verdicts verify-core produces, never throws into the
 * story pipeline; --pull turns a report verdict for a commit the build lacks
 * into NOT COVERED (the server has no git and cannot tell).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../../scripts/admin/verify-core.js');

const BUILD = 'b'.repeat(40);

function fakePool(storyData: any) {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      if (/FROM stories WHERE id/.test(sql)) return { rows: [{ id: params[0], data: storyData, image_version_meta: {}, idea_source: 'user-written', idea_original: null, idea_used: null, created_at: new Date('2026-09-27T08:00:00Z') }] };
      if (/FROM story_images/.test(sql)) return { rows: [] };
      if (/FROM story_jobs/.test(sql)) return { rows: [] };
      if (/INSERT INTO story_verify_reports/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query ${sql}`);
    },
  };
}

function registryFile(entries: any[]) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-')), 'verify.json');
  fs.writeFileSync(p, JSON.stringify({ entries }));
  return p;
}

const humanEntry = { id: 'h', title: 'h', claim: 'c', commits: ['abc'], runShape: ['any'], check: { kind: 'human', what: 'look' }, status: 'pending', evidence: [] };
const gone = { ...humanEntry, id: 'gone', status: 'superseded' };

async function loadWithEnv(env: string) {
  vi.resetModules();
  process.env.RAILWAY_ENVIRONMENT_NAME = env;
  return require('../../server/lib/verifyAutoCheck.js');
}

afterEach(() => { delete process.env.RAILWAY_ENVIRONMENT_NAME; vi.resetModules(); });

describe('runVerifyAutoCheck', () => {
  it('does nothing outside staging', async () => {
    const { runVerifyAutoCheck } = await loadWithEnv('production');
    const pool = fakePool({});
    expect(await runVerifyAutoCheck('job_x', { pool, registryPath: registryFile([humanEntry]) })).toBeNull();
    expect(pool.calls).toEqual([]);
  });

  it('on staging stores one report with verify-core verdicts, superseded entries skipped', async () => {
    const { runVerifyAutoCheck } = await loadWithEnv('staging');
    const pool = fakePool({ analytics: { build: { commitFull: BUILD } } });
    const report = await runVerifyAutoCheck('job_x', { pool, registryPath: registryFile([humanEntry, gone]) });
    expect(report.build).toBe(BUILD);
    expect(report.verdicts).toEqual([{ id: 'h', result: 'HUMAN', detail: 'human check', human: 'look' }]);
    const insert = pool.calls.find(c => /INSERT INTO story_verify_reports/.test(c.sql))!;
    expect(insert.params[0]).toBe('job_x');
    expect(insert.params[3]).toBe(1);
    expect(JSON.parse(insert.params[4])).toMatchObject({ HUMAN: 1, FAILED: 0 });
  });

  it('never throws into the pipeline: a failure is logged and returns null', async () => {
    const { runVerifyAutoCheck } = await loadWithEnv('staging');
    const pool = { query: async () => { throw new Error('db down'); } };
    await expect(runVerifyAutoCheck('job_x', { pool, registryPath: registryFile([humanEntry]) })).resolves.toBeNull();
  });

  it('the pipeline calls it fire-and-forget after the completion write, guarded', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
    const i = src.indexOf("require('./server/lib/verifyAutoCheck').runVerifyAutoCheck(storyId, { pool: dbPool })");
    expect(i).toBeGreaterThan(src.indexOf("['completed', 100, 'Story generation complete!', resultJson, jobId]"));
    const block = src.slice(src.lastIndexOf('setImmediate(', i), i + 200);
    expect(block).toMatch(/try \{/);
    expect(block).toMatch(/catch \(err\)/);
  });
});

describe('verdictsFromReport (--pull)', () => {
  const report = { build: BUILD, verdicts: [
    { id: 'a', result: 'CONFIRMED', detail: 'ok' },
    { id: 'b', result: 'FAILED', detail: 'p12 touches' },
  ] };
  const entries: any[] = [
    { id: 'a', commits: ['in'], status: 'pending' },
    { id: 'b', commits: ['out'], status: 'pending' },
    { id: 'c', commits: [], status: 'pending' },
  ];
  const contains = (c: string) => (c === 'in' ? true : c === 'out' ? false : null);

  it('keeps a verdict whose commits the build contains, and demotes the rest to NOT COVERED', () => {
    const out = core.verdictsFromReport(report, entries, contains);
    const byId = Object.fromEntries(out.map((x: any) => [x.e.id, x.v]));
    expect(byId.a).toEqual({ id: 'a', result: 'CONFIRMED', detail: 'ok' });
    expect(byId.b).toMatchObject({ result: 'NOT COVERED', why: expect.stringMatching(/lacks out/) });
    expect(byId.c).toBeUndefined(); // registered after that build: not in the report
  });

  it('an unresolvable commit is NOT COVERED, never a pass', () => {
    const out = core.verdictsFromReport({ build: BUILD, verdicts: [{ id: 'a', result: 'CONFIRMED' }] }, [{ id: 'a', commits: ['zzz'] }], () => null);
    expect(out[0].v.result).toBe('NOT COVERED');
  });

  it('feeds applyVerdicts like a live judgement', () => {
    const reg: any = { entries: entries.map(e => ({ ...e, evidence: [] })) };
    const out = core.verdictsFromReport(report, reg.entries, contains);
    core.applyVerdicts(reg, { storyId: 's', env: 'staging', build: BUILD, runDate: 'd' }, out, { checkedAt: 'n', via: 'pull' });
    expect(reg.entries[0].status).toBe('confirmed');
    expect(reg.entries[1].status).toBe('pending');
    expect(reg.runs[0].via).toBe('pull');
  });
});
