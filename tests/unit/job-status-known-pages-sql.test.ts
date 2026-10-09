/**
 * DB review 2026-10-07: the job-status poll filters knownPages IN SQL.
 *
 * Before, every poll SELECTed every partial_page checkpoint (base64 imageData
 * included) and dropped the client's known pages in JS. A partial_page
 * checkpoint's step_index is its pageNumber (both saveCheckpoint call sites in
 * storyJobPipeline.js pass page.pageNumber as the index), so the exclusion
 * moves into the WHERE clause and known pages' base64 is never read.
 *
 * Pins: the partial_page query carries the NOT ANY($2::int[]) clause and takes
 * the known-page array as $2; no JS-side knownPages filter remains; the
 * response shape (full rows for unknown pages, nothing for known ones) is
 * unchanged. Also pins migration 046: IF NOT EXISTS everywhere, contiguous
 * numbering, the four indexed columns exist in earlier migrations.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const jobsSrc = fs.readFileSync(path.join(ROOT, 'server/routes/jobs.js'), 'utf8');

describe('job status poll: knownPages filtered in SQL', () => {
  const start = jobsSrc.indexOf("step_name = 'partial_page'");
  const block = jobsSrc.slice(start - 300, start + 400);

  it('the partial_page SELECT excludes known pages by step_index', () => {
    expect(block).toContain("AND NOT (step_index = ANY($2::int[]))");
    expect(block).toContain('[jobId, [...knownPages]]');
  });

  it('no JS-side knownPages filter remains', () => {
    expect(jobsSrc).not.toMatch(/partialPages\.filter\(p => !knownPages\.has/);
  });

  it('step_index is the pageNumber at every partial_page save site', () => {
    const pipeline = fs.readFileSync(path.join(ROOT, 'storyJobPipeline.js'), 'utf8');
    const sites = [...pipeline.matchAll(/saveImageCheckpoint\(jobId, 'partial_page', \{[\s\S]*?\}, ([\w.]+), /g)];
    expect(sites.length).toBe(2);
    for (const m of sites) expect(m[1]).toMatch(/\.pageNumber$/);
  });

  it('the trial status route has no knownPages path (no sibling to move)', () => {
    const trialSrc = fs.readFileSync(path.join(ROOT, 'server/routes/trial.js'), 'utf8');
    expect(trialSrc).not.toContain('knownPages');
  });
});

describe('migration 046: token + job-sweep indexes', () => {
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  const file = files.find(f => f.startsWith('046_'))!;
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');

  it('is numbered 046, the highest file, and no other file shares its number', () => {
    // 045 belongs to a parallel branch (users_marketing_opt_out); the sequence
    // has historic gaps too, so only the head position is pinned.
    const nums = files.map(f => parseInt(f.slice(0, 3), 10));
    expect(Math.max(...nums)).toBe(46);
    expect(nums.filter(n => n === 46).length).toBe(1);
  });

  it('every statement is idempotent and none is CONCURRENTLY', () => {
    const stmts = sql.split('\n').filter(l => /^CREATE INDEX/.test(l));
    expect(stmts.length).toBe(4);
    for (const s of stmts) expect(s).toMatch(/^CREATE INDEX IF NOT EXISTS/);
    expect(sql).not.toContain('CONCURRENTLY');
  });

  it('indexes the three token columns partially and the sweep pair', () => {
    for (const col of ['email_verification_token', 'password_reset_token', 'claim_token']) {
      expect(sql).toMatch(new RegExp(`ON users \\(${col}\\) WHERE ${col} IS NOT NULL;`));
    }
    expect(sql).toContain('ON story_jobs (status, updated_at);');
  });

  it('the indexed columns exist in earlier migrations', () => {
    const earlier = files.filter(f => f < file).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(earlier).toMatch(/email_verification_token VARCHAR/);
    expect(earlier).toMatch(/password_reset_token VARCHAR/);
    expect(earlier).toMatch(/claim_token\s+VARCHAR/);
    expect(earlier).toMatch(/CREATE TABLE IF NOT EXISTS story_jobs \([\s\S]*?updated_at TIMESTAMP/);
  });
});
