#!/usr/bin/env node
/**
 * Purge old TEST data (owner's own test runs, demo showcases, debug tables) to
 * shrink the databases — and with them Railway's memory bill, since Postgres
 * container RAM tracks database SIZE (see reference_railway_cost_api).
 *
 * WHAT IS NEVER DELETED, in either environment:
 *   - any story with an order against it (a real purchase)
 *   - any shared story (is_shared — someone may hold the link)
 *   - any story referenced by a testlab_experiments target (Lab evidence backs
 *     docs/decisions.md entries; deleting the story guts the finding)
 *   - production stories belonging to real (non-admin, non-demo) users
 *   - the `files` table (order PDFs)
 *
 * SELECTION (owner's ruling, 2026-09-03):
 *   production — admin + demo-* test stories older than 90 days, keeping every
 *     4th one chronologically so the progression of the pipeline stays visible.
 *     Plus consolidator_calls older than 14 days (pure debug prompt/response).
 *   staging — everything older than 30 days (staging is test data by
 *     definition), minus the protections above. Plus consolidator_calls older
 *     than 30 days, and demo characters whose owner has no surviving story.
 *     testlab_experiments are NOT touched at all.
 *
 * Deleting rows does NOT return space to the OS — the pages become reusable
 * free space inside the same files. `--vacuum-full` is what actually shrinks
 * them, and it takes an ACCESS EXCLUSIVE lock, so it refuses to run while
 * GET /api/health/busy reports a generation in flight.
 *
 *   node scripts/admin/purge-test-data.js [--staging] [--apply] [--vacuum-full]
 *
 * Default is a DRY RUN: it prints exactly what it would delete and changes
 * nothing.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const STAGING = args.includes('--staging');
const VACUUM_FULL = args.includes('--vacuum-full');

const ENV = STAGING ? 'staging' : 'production';
const CONN = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
const HEALTH = STAGING ? 'https://staging.magicalstory.ch' : 'https://magicalstory.ch';

// Age cut-off and the "keep 1 in N" sample rate, per environment.
const AGE_DAYS = STAGING ? 30 : 90;
const KEEP_EVERY = STAGING ? 0 : 4; // 0 = keep none of the selected set
const CALLS_DAYS = STAGING ? 30 : 14;

// Tables holding story_id with NO foreign key — cascade will not clean these.
const ORPHAN_TABLES = ['consolidator_calls', 'story_scores', 'story_metrics', 'failure_log'];

const mb = (b) => (Number(b || 0) / 1048576).toFixed(1) + ' MB';

async function main() {
  if (!CONN) throw new Error(`no connection string for ${ENV}`);
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

  const size = async () => (await pool.query('select pg_database_size(current_database()) b')).rows[0].b;
  const before = await size();
  console.log(`=== PURGE ${ENV.toUpperCase()} — database ${mb(before)} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // ---- protected ids -------------------------------------------------------
  const protectedIds = new Set();
  for (const [label, sql] of [
    ['ordered', `select distinct story_id id from orders where story_id is not null`],
    ['shared', `select id from stories where is_shared`],
    ['testlab', `select distinct t->>'storyId' id from testlab_experiments e,
        jsonb_array_elements(case when jsonb_typeof(e.targets)='array' then e.targets else '[]'::jsonb end) t
        where t->>'storyId' is not null`],
  ]) {
    try {
      const r = await pool.query(sql);
      r.rows.forEach((x) => x.id && protectedIds.add(x.id));
      console.log(`  protected via ${label}: ${r.rows.length}`);
    } catch (e) {
      console.log(`  protected via ${label}: SKIPPED (${e.message})`);
    }
  }

  // ---- candidate stories ---------------------------------------------------
  const ownerFilter = STAGING
    ? 'true' // staging is test data by definition
    : `(u.role = 'admin' or u.email like 'demo-%')`;

  const cand = await pool.query(
    `select s.id, s.created_at, coalesce(u.email,'(orphan)') email, pg_column_size(s.data) bytes
       from stories s left join users u on u.id = s.user_id
      where s.created_at < now() - interval '${AGE_DAYS} days'
        and ${ownerFilter}
      order by s.created_at asc`
  );

  const eligible = cand.rows.filter((r) => !protectedIds.has(r.id));
  // Keep every KEEP_EVERY-th row chronologically so the progression stays visible.
  const keep = [];
  const doomed = [];
  eligible.forEach((r, i) => {
    if (KEEP_EVERY > 0 && i % KEEP_EVERY === 0) keep.push(r);
    else doomed.push(r);
  });

  const sum = (rows) => rows.reduce((a, r) => a + Number(r.bytes || 0), 0);
  console.log(`  stories older than ${AGE_DAYS}d: ${cand.rows.length}`);
  console.log(`    protected (kept):      ${cand.rows.length - eligible.length}`);
  console.log(`    sampled to keep (1/${KEEP_EVERY || '∞'}): ${keep.length}  ${mb(sum(keep))}`);
  console.log(`    TO DELETE:             ${doomed.length}  ${mb(sum(doomed))}`);
  if (keep.length) {
    console.log('    kept sample spans ' + keep[0].created_at.toISOString().slice(0, 10) +
      ' → ' + keep[keep.length - 1].created_at.toISOString().slice(0, 10));
  }

  const ids = doomed.map((r) => r.id);

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing changed. Re-run with --apply.');
    await pool.end();
    return;
  }
  if (!ids.length && !VACUUM_FULL) {
    console.log('\n  nothing to delete.');
    await pool.end();
    return;
  }

  // ---- delete --------------------------------------------------------------
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let n;

    if (ids.length) {
      for (const t of ORPHAN_TABLES) {
        try {
          n = await client.query(`delete from ${t} where story_id = any($1::text[])`, [ids]);
          if (n.rowCount) console.log(`  ${t}: ${n.rowCount} rows`);
        } catch (e) { console.log(`  ${t}: skipped (${e.message})`); }
      }
      try {
        n = await client.query(`delete from story_job_checkpoints where job_id = any($1::text[])`, [ids]);
        if (n.rowCount) console.log(`  story_job_checkpoints: ${n.rowCount} rows`);
      } catch (e) { console.log(`  story_job_checkpoints: skipped (${e.message})`); }

      n = await client.query(`delete from story_jobs where id = any($1::text[])`, [ids]);
      console.log(`  story_jobs: ${n.rowCount} rows`);

      // cascades: story_images, story_retry_images, benchmark_scenes, style_lab_images
      n = await client.query(`delete from stories where id = any($1::text[])`, [ids]);
      console.log(`  stories: ${n.rowCount} rows`);
    }

    // debug prompt/response log, regardless of which story it belongs to
    n = await client.query(
      `delete from consolidator_calls where created_at < now() - interval '${CALLS_DAYS} days'`);
    console.log(`  consolidator_calls older than ${CALLS_DAYS}d: ${n.rowCount} rows`);

    if (STAGING) {
      n = await client.query(
        `delete from characters c using users u
          where u.id = c.user_id and u.email like 'demo-%'
            and c.created_at < now() - interval '${AGE_DAYS} days'
            and not exists (select 1 from stories s where s.user_id = c.user_id)`);
      console.log(`  characters (demo, no surviving story): ${n.rowCount} rows`);

      n = await client.query(
        `delete from story_jobs where created_at < now() - interval '${AGE_DAYS} days'
           and not exists (select 1 from stories s where s.id = story_jobs.id)`);
      console.log(`  story_jobs (orphaned): ${n.rowCount} rows`);
    }

    await client.query('COMMIT');
    console.log('  committed.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const afterDelete = await size();
  console.log(`  database after delete: ${mb(afterDelete)} (space is free but not returned to the OS)`);

  // ---- reclaim -------------------------------------------------------------
  if (VACUUM_FULL) {
    const busy = await fetch(`${HEALTH}/api/health/busy`).then((r) => r.json()).catch(() => null);
    if (!busy) throw new Error('could not reach /api/health/busy — refusing VACUUM FULL');
    if (busy.busy) throw new Error(`${ENV} is BUSY (${JSON.stringify(busy.reasons)}) — refusing VACUUM FULL`);
    console.log(`  ${ENV} idle — running VACUUM (FULL, ANALYZE)`);

    const targets = await pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relkind='r' and pg_total_relation_size(c.oid) > 5*1024*1024
        order by pg_total_relation_size(c.oid) desc`);
    for (const { relname } of targets.rows) {
      const t0 = Date.now();
      await pool.query(`VACUUM (FULL, ANALYZE) ${relname}`);
      console.log(`    ${relname} ✓ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    await pool.query('ANALYZE');
    const after = await size();
    console.log(`  database ${mb(before)} → ${mb(after)}  (freed ${mb(before - after)})`);
    console.log('  NOTE: restart the Postgres service to drop the OS page cache — that is what');
    console.log('        actually lowers the Railway memory bill.');
  }

  await pool.end();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
