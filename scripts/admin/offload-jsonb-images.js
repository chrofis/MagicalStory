#!/usr/bin/env node
/**
 * offload-jsonb-images.js — the repair half of the IRON RULE guard.
 *
 *   NO IMAGE BYTES IN JSONB. R2 is the only byte store; the database keeps URLs.
 *
 * `scripts/admin/check-inline-images.js` REPORTS the violations. This script
 * FIXES them: it moves the bytes to R2 and leaves the URL in the row. Both sit
 * on the same implementation in `server/lib/dbHousekeeping.js` — the same
 * candidate-row predicate, the same byte test, the same walker — so a column the
 * sweep flags is a column this script can clean, with no second uploader to
 * drift from the first.
 *
 *   node scripts/admin/offload-jsonb-images.js --dry-run
 *   node scripts/admin/offload-jsonb-images.js --env=staging --table=characters.metadata
 *   node scripts/admin/offload-jsonb-images.js --env=production --limit=5
 *
 * Flags:
 *   --env=staging|production   which database (default: staging)
 *   --table=<t>|<t>.<column>   restrict to one table, or one column of it
 *   --dry-run                  report what would move; upload nothing, write nothing
 *   --limit=N                  at most N rows per column (largest first)
 *   --backup-dir=<path>        where the pre-write row dumps go
 *
 * WHAT IT WILL NOT DO. It never deletes bytes. A value is replaced by a URL only
 * after the object behind that URL has been fetched back and hash-matched
 * against the value being replaced; an image that cannot be verified fails its
 * whole row, and the row is left exactly as it was. Every affected row is dumped
 * to the backup directory (full JSONB, table, column, primary key) BEFORE the
 * write — a row that cannot be backed up is a row that is not touched.
 *
 * Idempotent: keys are content-addressed, so a second run re-derives the same
 * key, verifies the existing object and writes the same URL. Resumable: each row
 * is written in its own transaction, so a crash leaves every row fully old or
 * fully new.
 *
 * `story_job_checkpoints.step_data` is NOT in scope — it is the declared
 * exception (the progressive-display payload, deleted with its job).
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const {
  offloadJsonbColumn,
  OFFLOADABLE_COLUMNS,
  verifyBucketMatchesDatabase,
} = require('../../server/lib/dbHousekeeping');

const ENVS = {
  staging: { label: 'staging', urlVar: 'STAGING_DATABASE_URL' },
  production: { label: 'production', urlVar: 'DATABASE_URL' },
};

const MB = (n) => (n / 1048576).toFixed(2);

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/**
 * Prove the configured R2 bucket is the one the TARGET database actually writes
 * to, before a single byte moves.
 *
 * The verdict comes from `verifyBucketMatchesDatabase` in dbHousekeeping.js —
 * the same guard the unattended daily routine applies, so the attended tool and
 * the schedule cannot disagree about which bucket belongs to which database.
 * There the verdict is logged and the run refuses; here it is a hard error.
 *
 * Why it exists: the checked-in `.env` holds PRODUCTION R2 credentials
 * (`images.magicalstory.ch`); staging serves `images-staging.magicalstory.ch`
 * from a DIFFERENT bucket. Without this check a staging run from a developer
 * machine would replace staging's inline bytes with URLs into the production
 * bucket, which production's own R2 garbage collection would eventually delete —
 * taking the only remaining copy of those images with it.
 */
async function assertBucketMatchesDatabase(pool, envLabel) {
  const verdict = await verifyBucketMatchesDatabase(pool);
  if (!verdict.ok) {
    throw new Error(
      [
        `R2 BUCKET CHECK FAILED on ${envLabel} — refusing to run.`,
        `    ${verdict.message}`,
        '',
        '  Point R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET /',
        `  R2_PUBLIC_URL at the ${envLabel} bucket${verdict.dbHost ? ` (${verdict.dbHost})` : ''} and re-run.`,
      ].join('\n'));
  }
  console.log(`  R2 bucket verified: ${verdict.bucket} (${verdict.cfgHost}) matches ${envLabel}`);
}

/**
 * Append one row's pre-write state to <backupDir>/<env>-<table>-<column>.jsonl.
 * Throws on failure — the caller must not proceed to the write.
 */
function makeBackupWriter(backupDir, envLabel) {
  fs.mkdirSync(backupDir, { recursive: true });
  const written = new Map();
  return {
    save({ table, column, row, value }) {
      const file = path.join(backupDir, `${envLabel}-${table}-${column}.jsonl`);
      const line = JSON.stringify({
        env: envLabel, table, column, row,
        savedAt: new Date().toISOString(),
        value,
      }) + '\n';
      fs.appendFileSync(file, line, 'utf8');
      const e = written.get(file) || { rows: 0, bytes: 0 };
      e.rows++; e.bytes += Buffer.byteLength(line);
      written.set(file, e);
    },
    report() { return [...written.entries()].map(([file, e]) => ({ file, ...e })); },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name, dflt = null) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : dflt;
  };
  const envKey = arg('env', 'staging');
  const dryRun = args.includes('--dry-run');
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null;
  const tableArg = arg('table');
  const env = ENVS[envKey];
  if (!env) throw new Error(`unknown --env=${envKey} (staging | production)`);
  const url = process.env[env.urlVar];
  if (!url) throw new Error(`${env.urlVar} is not set — cannot touch ${env.label}`);

  const backupDir = arg('backup-dir')
    || path.join(__dirname, '..', '..', 'tmp', 'jsonb-offload-backups');

  let specs = OFFLOADABLE_COLUMNS;
  if (tableArg) {
    const [t, c] = tableArg.split('.');
    specs = specs.filter(s => s.table === t && (!c || s.column === c));
    if (!specs.length) throw new Error(`--table=${tableArg} matches no offloadable column`);
  }

  console.log(`\n=== offload-jsonb-images: ${env.label}${dryRun ? ' (DRY RUN — nothing is uploaded or written)' : ''} ===`);
  console.log(`  columns: ${specs.map(s => `${s.table}.${s.column}`).join(', ')}`);
  console.log(`  backups: ${backupDir}`);

  const backup = makeBackupWriter(backupDir, env.label);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const results = [];
  try {
    // Even a dry run checks it: the report is only meaningful for the bucket
    // the rows will actually be written against.
    await assertBucketMatchesDatabase(pool, env.label);
    for (const spec of specs) {
      const r = await offloadJsonbColumn(pool, log, spec, {
        limit, dryRun,
        // The backup is the precondition for the write, not a side effect of
        // it: if this throws, offloadJsonbColumn's caller sees the error and
        // the row is never touched.
        onRow: ({ table, column, row, value }) => {
          if (!dryRun) backup.save({ table, column, row, value });
        },
      });
      results.push(r);
    }
  } finally {
    await pool.end();
  }

  let totalRows = 0, totalImages = 0, totalBytes = 0, totalSkipped = 0, totalReused = 0;
  for (const r of results) {
    if (!r.candidates && !r.rows) continue;
    console.log(`\n  ${r.table}.${r.column} — ${r.candidates} candidate row(s), `
      + `${r.rows} ${dryRun ? 'would be cleaned' : 'cleaned'}, ${r.images} image(s), `
      + `${MB(r.bytes)} MB, ${r.reused} reused existing object(s), ${r.skipped} skipped`);
    for (const d of r.details) {
      console.log(`    ${d.action}  ${d.row}  ${d.images} image(s)  ${MB(d.bytes)} MB`
        + `${d.reason ? `  — ${d.reason}` : ''}`);
      const byPath = new Map();
      for (const p of d.paths) {
        const e = byPath.get(p.path) || { count: 0, bytes: 0 };
        e.count++; e.bytes += p.bytes;
        byPath.set(p.path, e);
      }
      for (const [p, e] of [...byPath.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
        console.log(`        ${p}  ${e.count}x  ${MB(e.bytes)} MB`);
      }
    }
    totalRows += r.rows; totalImages += r.images; totalBytes += r.bytes;
    totalSkipped += r.skipped; totalReused += r.reused;
  }

  if (!dryRun) {
    console.log('\n  backups written:');
    for (const b of backup.report()) console.log(`    ${b.file}  ${b.rows} row(s)  ${MB(b.bytes)} MB`);
  }
  console.log(`\n  ${dryRun ? 'WOULD MOVE' : 'MOVED'} ${totalImages} image(s) / ${MB(totalBytes)} MB `
    + `out of ${totalRows} row(s); ${totalReused} reused an object already in R2; ${totalSkipped} row(s) skipped.`);
  if (totalSkipped) {
    console.log('  A skipped row still holds its bytes and is safe — re-run to retry it.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('offload-jsonb-images failed:', err.stack || err.message); process.exit(2); });
}
