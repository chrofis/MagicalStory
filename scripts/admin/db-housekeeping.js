#!/usr/bin/env node
/**
 * Database housekeeping, run by hand: keep image bytes out of JSONB, keep the
 * planner honest, and report bloat before it becomes a bill.
 *
 * THE SCHEDULED OWNER OF THIS WORK IS THE APP, not this script. Since 2026-09-06
 * server/lib/dbHousekeeping.js runs the same routines inside Railway (daily
 * 03:30 CH, weekly reclaim Sundays), because each service already holds
 * DATABASE_URL for its own database and no credential has to leave Railway.
 * This file is the manual entry point over the SAME module — useful for a dry
 * run, for targeting the other environment from a laptop, or for forcing a
 * reclaim outside the schedule.
 *
 * WHY ANY OF IT EXISTS. On 2026-09-01 production's database was 1,818 MB, of
 * which essentially all was TOAST — the out-of-line store for the JSONB blobs:
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
 *   node scripts/admin/db-housekeeping.js [--staging] [--apply] [--vacuum-full]
 *
 * --vacuum-full is the WEEKLY reclaim: it takes an ACCESS EXCLUSIVE lock that
 * kills any in-flight generation, so it checks GET /api/health/busy first and
 * refuses when the environment is working. Everything else is safe to run daily
 * against a live database.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const {
  offloadInlineImages, vacuumAnalyze, bloatReport, databaseSize, TABLES,
} = require('../../server/lib/dbHousekeeping');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const STAGING = args.includes('--staging');
const VACUUM_FULL = args.includes('--vacuum-full');

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.log(...a),
  error: (...a) => console.error(...a),
  debug: () => {},
};

/**
 * This narrows the VACUUM FULL window; it does not close it. A generation can
 * still start in the seconds between this answer and the lock being taken — an
 * accepted trade-off (owner, 2026-09-01) for automatic space reclamation. Run
 * it when traffic is lowest, and prefer staging first.
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

  console.log(`\n=== ${label} housekeeping — database ${(await databaseSize(pool)).pretty} ===`);

  // ── 1. Image bytes in JSONB ────────────────────────────────────────────
  for (const t of TABLES) {
    const r = await pool.query(
      `SELECT COUNT(*) k, COALESCE(SUM(pg_column_size(data)),0) b
         FROM ${t} WHERE data::text LIKE '%data:image%'`);
    console.log(`  ${t}: ${r.rows[0].k} row(s) with inline images (${(Number(r.rows[0].b) / 1024 / 1024).toFixed(1)} MB)`);
  }
  if (APPLY) {
    const res = await offloadInlineImages(pool, log);
    console.log(`  → ${res.rows} row(s) migrated, ${res.images} image(s) to R2, ${res.skipped} skipped`);
  } else {
    console.log('  → run with --apply to move them');
  }

  // ── 2. VACUUM ANALYZE — no lock, and it is what un-blinds autovacuum ───
  if (APPLY) await vacuumAnalyze(pool, log);

  // ── 3. Bloat report ────────────────────────────────────────────────────
  const report = await bloatReport(pool);
  console.log('\n  largest tables:');
  for (const t of report.tables) {
    console.log(`    ${t.table.padEnd(20)} ${t.totalMB.toFixed(0).padStart(6)} MB total, ` +
                `~${t.liveMB.toFixed(0)} MB live  → ~${t.reclaimablePct.toFixed(0)}% reclaimable`);
  }
  if (report.toast.length) {
    console.log('\n  TOAST relations that are majority-dead:');
    report.toast.forEach(t => console.log(`    ${t.relname}: ${t.n_dead_tup} dead vs ${t.n_live_tup} live`));
    console.log('\n  The in-app weekly reclaim returns that space on Sundays. To force it now,');
    console.log('  during an idle window (it takes an ACCESS EXCLUSIVE lock): --apply --vacuum-full');
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
    console.log('\n  NOTE: disk is back, but the container keeps the old page-cache high-water');
    console.log('  mark until Postgres restarts — scripts/admin/railway-restart-service.js');
  }

  console.log(`\n  database ${(await databaseSize(pool)).pretty}`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
