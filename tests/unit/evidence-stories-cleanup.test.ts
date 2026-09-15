/**
 * Evidence stories survive automatic cleanup.
 *
 * The threat is real and measured: the 6-hourly abandoned-anonymous sweep in
 * server/routes/trial.js deletes anonymous accounts older than 48 hours with
 * their stories AND prunes the stories' R2 objects, and two of the stories
 * cited as evidence this week are anonymous-owned.
 *
 * FIXTURES COME FROM THE REAL QUERY. The candidate rows below were produced by
 * running ANON_SWEEP_CANDIDATES_SQL's shape against staging on 2026-09-14:
 * `user_id` is a varchar and `evidence_stories` comes back as the STRING '0',
 * because COUNT() is a bigint and node-pg does not narrow bigints. That is the
 * whole trap — a truthiness test on '0' is true, so a hand-built fixture using
 * the number 0 would pass while production kept every account alive forever.
 */
import { describe, it, expect } from 'vitest';
import {
  ANON_SWEEP_CANDIDATES_SQL,
  ORPHAN_STORIES_WHERE,
  selectAnonSweepTargets,
  logSkipped,
} from '../../server/lib/evidenceStories.js';

// Verbatim node-pg output shape (varchar id, bigint-as-string count).
const UNMARKED_OLD_ACCOUNT = {
  user_id: '0eb46cea-3d10-404a-ae0b-138dac3065bb',
  evidence_stories: '0',
  evidence_reason: null,
};
const EVIDENCE_ACCOUNT = {
  user_id: '6468a1df-9c80-471e-a5a0-041be34acbb1',
  evidence_stories: '1',
  evidence_reason: 'Cited in tasks/ as measured evidence; anonymous-owned.',
};

describe('anonymous sweep — evidence exemption', () => {
  it('does not select an account holding an evidence story', () => {
    const { deleteUserIds } = selectAnonSweepTargets([EVIDENCE_ACCOUNT]);
    expect(deleteUserIds).toEqual([]);
  });

  it('still selects an unmarked account past the 48h cutoff', () => {
    const { deleteUserIds } = selectAnonSweepTargets([UNMARKED_OLD_ACCOUNT]);
    expect(deleteUserIds).toEqual([UNMARKED_OLD_ACCOUNT.user_id]);
  });

  it("treats the bigint string '0' as zero, not as truthy", () => {
    // The exact regression a numeric fixture would hide: if '0' were read as
    // "has evidence", the sweep would stop deleting anything at all.
    const { deleteUserIds, skipped } = selectAnonSweepTargets([
      UNMARKED_OLD_ACCOUNT, EVIDENCE_ACCOUNT,
    ]);
    expect(deleteUserIds).toEqual([UNMARKED_OLD_ACCOUNT.user_id]);
    expect(skipped.map((s) => s.userId)).toEqual([EVIDENCE_ACCOUNT.user_id]);
  });

  it('logs every skip with its reason', () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m) };
    const { skipped } = selectAnonSweepTargets([UNMARKED_OLD_ACCOUNT, EVIDENCE_ACCOUNT]);
    logSkipped(skipped, log as any, 'TRIAL CLEANUP');
    const joined = lines.join('\n');
    expect(joined).toContain(EVIDENCE_ACCOUNT.user_id);
    expect(joined).toContain('Cited in tasks/ as measured evidence');
    // The deleted account is not announced as a skip.
    expect(joined).not.toContain(UNMARKED_OLD_ACCOUNT.user_id);
  });

  it('logs nothing when there is nothing to skip', () => {
    const lines: string[] = [];
    logSkipped([], { info: (m: string) => lines.push(m) } as any, 'TRIAL CLEANUP');
    expect(lines).toEqual([]);
  });

  it('a marked account with no recorded reason is still held back, loudly', () => {
    const { deleteUserIds, skipped } = selectAnonSweepTargets([
      { user_id: 'u-x', evidence_stories: '2', evidence_reason: null },
    ]);
    expect(deleteUserIds).toEqual([]);
    expect(skipped[0].reason).toMatch(/no reason recorded/);
  });

  it('survives an empty candidate list and a null one', () => {
    expect(selectAnonSweepTargets([]).deleteUserIds).toEqual([]);
    expect(selectAnonSweepTargets(null as any).deleteUserIds).toEqual([]);
  });
});

describe('the SQL the exemption depends on', () => {
  it('counts only stories whose evidence_reason is set', () => {
    // Pins the column the migration adds against the query that reads it: a
    // rename on one side without the other silently unprotects everything.
    expect(ANON_SWEEP_CANDIDATES_SQL).toContain('s.evidence_reason IS NOT NULL');
    expect(ANON_SWEEP_CANDIDATES_SQL).toContain("u.created_at < NOW() - INTERVAL '48 hours'");
    expect(ANON_SWEEP_CANDIDATES_SQL).toContain('anonymous = true');
  });

  it('orphan cleanup skips evidence rows', () => {
    expect(ORPHAN_STORIES_WHERE).toContain('evidence_reason IS NULL');
    expect(ORPHAN_STORIES_WHERE).toContain("user_id IS NULL OR user_id = ''");
  });
});

describe('the real deleters consume the exemption', () => {
  const read = (p: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

  it('the trial sweep deletes by the selected id list, not by an inline anon subquery', () => {
    const src = read('server/routes/trial.js');
    expect(src).toContain('selectAnonSweepTargets');
    // The old filter deleted every anonymous account past 48h unconditionally.
    expect(src).not.toContain(`DELETE FROM users
        WHERE anonymous = true`);
    for (const table of ['story_jobs', 'characters', 'files', 'stories']) {
      expect(src).toContain(`DELETE FROM ${table} \${anonFilter}`);
    }
    expect(src).toContain("const anonFilter = 'WHERE user_id = ANY($1::varchar[])'");
  });

  it('purge-test-data protects evidence stories alongside ordered and shared ones', () => {
    const src = read('scripts/admin/purge-test-data.js');
    expect(src).toContain("['evidence', `select id from stories where evidence_reason is not null`]");
  });

  it('migration 038 adds the column the code reads', () => {
    const sql = read('migrations/038_story_evidence.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS evidence_reason TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS evidence_marked_at TIMESTAMP');
    // The seed must be re-runnable: migrations are transactional but a column
    // added IF NOT EXISTS invites a re-apply.
    expect(sql).toContain('evidence_reason IS NULL');
  });
});
