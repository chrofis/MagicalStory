import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const STUB = path.join(ROOT, 'tests', 'unit', 'fixtures', 'r2-pending-stub.cjs');
const CLEANUP = path.join(ROOT, 'scripts', 'admin', 'cleanup-orphaned-data.js');
const ERASURE = path.join(ROOT, 'scripts', 'admin', 'delete-user-data.js');

/**
 * Every call site that deletes an owning row must prune its R2 objects through
 * server/lib/r2Pending.js, so a prune that fails is written to
 * r2_pending_deletions and retried by the daily housekeeping. The raw r2
 * helpers log and return a count — once the row is gone, nobody knows the keys
 * again. Two admin scripts still called the raw helpers (found 2026-09-15).
 */

let pruneLog: string;

function runCleanup(env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, ['-r', STUB, CLEANUP, '--apply'], {
    cwd: ROOT,
    env: { ...process.env, STUB_PRUNE_LOG: pruneLog, ...env },
    encoding: 'utf8',
  });
  const calls = fs.existsSync(pruneLog)
    ? fs.readFileSync(pruneLog, 'utf8').split('\n').filter(Boolean)
    : [];
  return { ...res, calls };
}

beforeEach(() => {
  pruneLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r2pending-')), 'calls.txt');
});

describe('cleanup-orphaned-data.js --apply', () => {
  it('prunes every deleted orphan story through r2Pending.pruneStory, never raw r2', () => {
    const r = runCleanup();
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([
      'pruneStory job_orphan_1 orphan cleanup',
      'pruneStory job_orphan_2 orphan cleanup',
    ]);
    expect(r.stdout).toContain('Pruned 6 R2 objects');
  });

  it('a prune that cannot even be recorded is an error, not a warning', () => {
    const r = runCleanup({ STUB_PRUNE_THROWS: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could NOT be recorded for retry/);
    expect(r.stderr).not.toMatch(/partial/);
    // Both orphans were still attempted — one failure does not skip the rest.
    expect(r.calls).toHaveLength(2);
  });
});

describe('delete-user-data.js (GDPR erasure) — by construction', () => {
  // The erasure runs a real multi-phase transaction with an interactive
  // confirmation, so it is pinned at source level, the way the R2 GC audit is.
  const src = fs.readFileSync(ERASURE, 'utf8');

  it('never calls the raw r2 delete helpers', () => {
    expect(src).not.toMatch(/r2\.deleteByPrefix\b/);
    expect(src).not.toMatch(/r2\.deleteObject\b/);
    expect(src).not.toMatch(/r2\.deleteStoryArtefacts\b/);
  });

  it('prunes prefixes and order PDFs through the ledger, and still throws on a failed PDF prune', () => {
    expect(src).toMatch(/await r2Pending\.prunePrefix\(prefix, pruneReason\)/);
    expect(src).toMatch(/await r2Pending\.pruneObject\(key, pruneReason\) === 1/);
    expect(src).toMatch(/throw new Error\(`R2 delete failed for order PDF/);
  });

  it('keeps the independent post-delete verification', () => {
    expect(src).toMatch(/R2 VERIFICATION FAILED/);
  });
});
