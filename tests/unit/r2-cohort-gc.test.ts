import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..', '..');
const STUB = path.join(ROOT, 'tests', 'unit', 'fixtures', 'r2-gc-stub.cjs');
const AUDIT = path.join(ROOT, 'scripts', 'admin', 'audit-r2-dead-cohorts.js');
const DELETER = path.join(ROOT, 'scripts', 'admin', 'delete-r2-dead-cohorts.js');
const MODULE = path.join(ROOT, 'scripts', 'lib', 'r2Cohorts.js');

/**
 * R2 garbage collection is a GDPR control (ruling Q7, 2026-09-12). Two
 * properties have to hold no matter how the tools are refactored:
 *
 *   1. The AUDIT entrypoint cannot delete — by construction, not by flag.
 *      Someone auditing the control reads one file; they must not have to trust
 *      argument parsing.
 *   2. The DELETE tool deletes nothing unless told twice (--confirm AND
 *      --production).
 *
 * The tools are run as real child processes against a stub that replaces the S3
 * client and the pg Pool, so nothing here touches R2, the network or a database.
 * Every DeleteObjects call the stub sees is appended to STUB_DELETE_LOG.
 */

let deleteLog: string;

function run(script: string, args: string[]) {
  // A real delete run appends its receipt to ./tasks/…jsonl, so give each run a
  // throwaway cwd rather than writing into the repo.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'r2gc-cwd-'));
  fs.mkdirSync(path.join(cwd, 'tasks'));
  const res = spawnSync(process.execPath, ['-r', STUB, script, ...args, '--no-manifest'], {
    cwd,
    env: { ...process.env, STUB_DELETE_LOG: deleteLog },
    encoding: 'utf8',
  });
  const deleted = fs.existsSync(deleteLog)
    ? fs.readFileSync(deleteLog, 'utf8').split('\n').filter(Boolean)
    : [];
  return { ...res, deleted };
}

beforeEach(() => {
  deleteLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r2gc-')), 'deleted.txt');
});

describe('audit-r2-dead-cohorts.js — read-only by construction', () => {
  it('contains no delete path at all', () => {
    const src = fs.readFileSync(AUDIT, 'utf8');
    // Not a wording check: these are the only ways this file could delete.
    expect(src).not.toMatch(/DeleteObjectsCommand/);
    expect(src).not.toMatch(/new S3Client/);
    expect(src).not.toMatch(/--confirm/);
    expect(src).not.toMatch(/--production/);
  });

  it('reaches no delete function through the shared module', () => {
    const mod = require_(MODULE);
    const names = Object.keys(mod);
    expect(names.some((n) => /delete/i.test(n))).toBe(false);
    expect(fs.readFileSync(MODULE, 'utf8')).not.toMatch(/DeleteObjectsCommand/);
  });

  it('runs the scan and deletes nothing, whatever flags it is handed', () => {
    const res = run(AUDIT, ['--confirm', '--production', '--list=5']);
    expect(res.status).toBe(0);
    expect(res.deleted).toEqual([]);
    expect(res.stdout).toContain('DEAD COHORTS');
  });
});

describe('delete-r2-dead-cohorts.js — deletion needs both flags', () => {
  it.each([
    ['no flags', [] as string[]],
    ['--confirm alone', ['--confirm']],
    ['--production alone', ['--production']],
    ['--report-only wins over both flags', ['--report-only', '--confirm', '--production']],
  ])('deletes nothing with %s', (_label, args) => {
    const res = run(DELETER, args);
    expect(res.status).toBe(0);
    expect(res.deleted).toEqual([]);
  });

  it('deletes the dead cohorts when given both --confirm and --production', () => {
    const res = run(DELETER, ['--confirm', '--production']);
    expect(res.status).toBe(0);
    // stories/s2 and characters/u2/c9 are the cohorts that are unreferenced AND
    // past the age floor. stories/s3 is dead but too young; stories/s1 and
    // characters/u1/c1 each have a referenced object.
    expect(res.deleted.sort()).toEqual([
      'characters/u2/c9/photos/p.png',
      'stories/s2/page1.png',
      'stories/s2/retry/a.png',
    ]);
  });

  it('never puts a referenced or protected object in the victim set', () => {
    const res = run(DELETER, ['--confirm', '--production']);
    for (const key of res.deleted) {
      expect(key.startsWith('orders/')).toBe(false);
      expect(key.startsWith('landmarks/')).toBe(false);
      expect(key.startsWith('weird/')).toBe(false);
      expect(key).not.toBe('stories/s1/page1.png');
      expect(key).not.toBe('characters/u1/c1/avatars/a.png');
    }
  });
});

describe('the cohort rule has one implementation', () => {
  it('is the shared module, used by both entrypoints', () => {
    for (const f of [AUDIT, DELETER]) {
      expect(fs.readFileSync(f, 'utf8')).toMatch(/r2Cohorts\.js/);
    }
    const { cohortOf } = require_(MODULE);
    expect(cohortOf('stories/abc/page1.png')).toMatchObject({ id: 'stories/abc/', prefix: 'stories/' });
    expect(cohortOf('orders/x/y.pdf')).toMatchObject({ protected: true });
    expect(cohortOf('mystery/x.bin')).toMatchObject({ protected: true, unknown: true });
  });
});
