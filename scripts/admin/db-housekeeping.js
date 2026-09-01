#!/usr/bin/env node
/**
 * Daily database housekeeping: keep image bytes out of JSONB, keep the planner
 * honest, and report bloat before it becomes a bill.
 *
 * WHY THIS EXISTS. On 2026-09-01 production's database was 1,818 MB, of which
 * essentially all was TOAST — the out-of-line store for the JSONB blobs:
 *
 *     stories     heap 376 kB  |  TOAST 1,280 MB
 *     characters  heap  56 kB  |  TOAST   364 MB
 *
 * Two separate problems produced that:
 *
 *  1. IMAGE BYTES IN JSONB. `extractInlineImagesToR2` only ever ran on the
 *     story save path; character writes were never covered. 694 MB of live
 *     base64 sat in rows that should have held R2 URLs.
 *  2. DEAD TOAST. Every update rewrites the whole blob, so the old TOAST chunks
 *     become garbage. `pg_toast_16432` (stories) held 448 dead against 112 live
 *     — 80% garbage — with `last_autovacuum = NEVER`.
 *
 * Autovacuum was not broken or blocked (no replication slots, no long
 * transactions, healthy xid age). It was BLIND: `pg_stat_user_tables` reported
 * `stories` as live=2 with last_analyze NEVER, when the table has ~174 rows.
 * Autovacuum sizes its trigger from those numbers — threshold = 50 + 0.2 × 2 ≈
 * 50 — so a table of huge blobs never looked busy enough to bother with. The
 * ANALYZE below is what makes autovacuum see the table at all.
 *
 * Why it matters commercially: Railway bills container memory, and Postgres
 * memory tracks database SIZE (shared_buffers is only 160 MB; the rest is the
 * OS page cache holding the files). 1,818 MB of database ⇒ 2.14 GB of RAM.
 *
 * WHAT THIS DOES (all safe to run against a live database):
 *   - reports any image bytes still inline, and moves them with --apply
 *   - VACUUM (ANALYZE): marks dead space reusable and refreshes the stats
 *     autovacuum depends on. Takes no exclusive lock.
 *   - reports bloat and the space a VACUUM FULL would return
 *
 * WHAT IT DELIBERATELY DOES NOT DO: `VACUUM FULL`. That returns space to the
 * OS but takes an ACCESS EXCLUSIVE lock — no reads, no writes, for minutes on a
 * GB-scale table. It kills in-flight story generation. It is a scheduled
 * maintenance action for an idle window, printed here as a suggestion only.
 *
 *   node scripts/admin/db-housekeeping.js [--staging] [--apply] [--vacuum-full]
 *
 * --vacuum-full is the WEEKLY reclaim: it checks GET /api/health/busy first and
 * refuses when a generation is running. Everything else is safe to run daily.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const STAGING = args.includes('--staging');
const VACUUM_FULL = args.includes('--vacuum-full');
const TABLES = ['characters', 'stories'];

/**
 * VACUUM FULL takes an ACCESS EXCLUSIVE lock: no reads, no writes, for minutes
 * on a GB-scale table. A story generating at that moment dies. So the weekly
 * reclaim asks the environment whether it is idle and refuses otherwise.
 *
 * This narrows the window; it does not close it. A generation can still start
 * in the seconds between this answer and the lock being taken — an accepted
 * trade-off (owner, 2026-09-01) for automatic space reclamation. Run it when
 * traffic is lowest, and prefer staging first.
 */
async function refuseIfBusy() {
  const base = STAGING ? 'https://staging.magicalstory.ch' : 'https://magicalstory.ch';
  const res = await fetch(`${base}/api/health/busy`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`busy check failed (HTTP ${res.status}) — refusing to lock the tables`);
  const j = await res.json();
  if (j.busy) throw new Error(`${base} is busy (${(j.reasons || []).join('; ')}) — not vacuuming`);
  return base;
}

(async () => {
  const cs = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const label = STAGING ? 'STAGING' : 'PROD';
  const dbSize = async () => (await pool.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) s`)).rows[0].s;

  console.log(`\n=== ${label} housekeeping — database ${await dbSize()} ===`);

  // ── 1. Image bytes in JSONB ────────────────────────────────────────────
  let inlineFound = 0;
  for (const t of TABLES) {
    const r = await pool.query(
      `SELECT COUNT(*) k, COALESCE(SUM(pg_column_size(data)),0) b
         FROM ${t} WHERE data::text LIKE '%data:image%'`);
    const mb = (Number(r.rows[0].b) / 1024 / 1024).toFixed(1);
    inlineFound += Number(r.rows[0].k);
    console.log(`  ${t}: ${r.rows[0].k} row(s) with inline images (${mb} MB)`);
  }
  if (inlineFound && APPLY) {
    console.log('  → migrating to R2…');
    execFileSync('node', [path.join(__dirname, 'migrate-inline-images-to-r2.js'),
      ...(STAGING ? ['--staging'] : []), '--apply'], { stdio: 'inherit' });
  } else if (inlineFound) {
    console.log('  → run with --apply to move them (or migrate-inline-images-to-r2.js)');
  }

  // ── 2. VACUUM ANALYZE — no lock, and it is what un-blinds autovacuum ───
  if (APPLY) {
    for (const t of TABLES) {
      const t0 = Date.now();
      await pool.query(`VACUUM (ANALYZE) ${t}`);
      console.log(`  VACUUM ANALYZE ${t}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }

  // ── 3. Bloat report ────────────────────────────────────────────────────
  const bloat = await pool.query(`
    SELECT c.relname,
           pg_total_relation_size(c.oid) total,
           COALESCE(pg_total_relation_size(t.oid), 0) toast,
           s.n_live_tup, s.n_dead_tup
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 5`);
  console.log('\n  largest tables:');
  for (const b of bloat.rows) {
    const live = await pool.query(`SELECT COALESCE(SUM(pg_column_size(t.*)),0) b FROM ${b.relname} t`);
    const totalMB = Number(b.total) / 1024 / 1024;
    const liveMB = Number(live.rows[0].b) / 1024 / 1024;
    const wastePct = totalMB > 1 ? Math.max(0, 100 * (1 - liveMB / totalMB)).toFixed(0) : '0';
    console.log(`    ${b.relname.padEnd(20)} ${totalMB.toFixed(0).padStart(6)} MB total, ~${liveMB.toFixed(0)} MB live  → ~${wastePct}% reclaimable`);
  }

  const toast = await pool.query(`
    SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_all_tables
     WHERE schemaname='pg_toast' AND n_dead_tup > n_live_tup AND n_dead_tup > 100
     ORDER BY n_dead_tup DESC LIMIT 5`);
  if (toast.rows.length) {
    console.log('\n  TOAST relations that are majority-dead:');
    toast.rows.forEach(t => console.log(`    ${t.relname}: ${t.n_dead_tup} dead vs ${t.n_live_tup} live`));
    console.log('\n  To RETURN that space to the OS (and to Railway\'s memory bill), run during an');
    console.log('  idle window — it takes an ACCESS EXCLUSIVE lock and will kill any running');
    console.log('  generation. Check GET /api/health/busy first:');
    console.log('      VACUUM (FULL, ANALYZE) stories;  VACUUM (FULL, ANALYZE) characters;');
  }

  // ── 4. Weekly reclaim (only with --vacuum-full, only when idle) ───────
  if (VACUUM_FULL) {
    const base = await refuseIfBusy();          // throws, so a busy env stops here
    console.log(`\n  ${base} reports idle — reclaiming space (tables locked while this runs)`);
    for (const t of TABLES) {
      const t0 = Date.now();
      await pool.query(`VACUUM (FULL, ANALYZE) ${t}`);
      console.log(`    VACUUM FULL ${t}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  console.log(`\n  database ${await dbSize()}`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
