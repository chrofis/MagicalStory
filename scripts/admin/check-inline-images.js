#!/usr/bin/env node
/**
 * check-inline-images.js — the on-demand face of the standing guard for the
 * IRON RULE:
 *
 *   NO IMAGE BYTES IN JSONB. R2 is the only byte store; `extractInlineImagesToR2()`
 *   (server/services/database.js, docs/r2-storage.md) is the offload path, and
 *   the database keeps URLs.
 *
 * The rule kept being restated and re-broken (characters.data leaked base64 for
 * months; story_jobs.result_data carried a whole second copy of the book), so it
 * is now checked instead of remembered. The sweep itself lives in
 * server/lib/dbHousekeeping.js — ONE implementation — and runs automatically as
 * part of the daily Railway housekeeping routine (03:30 CH, each service against
 * its own database). This script is the same sweep on demand, against either
 * environment, with a non-zero exit so a scheduler or a hook can fail on it.
 *
 *   node scripts/admin/check-inline-images.js                  # staging (default)
 *   node scripts/admin/check-inline-images.js --env=production
 *   node scripts/admin/check-inline-images.js --env=both --json
 *
 * Read-only: it never writes, and it never prints a connection URL.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { sweepInlineImages, TRANSIENT_CHECKPOINT_STEPS } = require('../../server/lib/dbHousekeeping');

const ENVS = {
  staging: { label: 'staging', urlVar: 'STAGING_DATABASE_URL' },
  production: { label: 'production', urlVar: 'DATABASE_URL' },
};

const MB = (n) => (n / 1048576).toFixed(2);

async function sweepEnv(envKey) {
  const env = ENVS[envKey];
  const url = process.env[env.urlVar];
  if (!url) throw new Error(`${env.urlVar} is not set — cannot sweep ${env.label}`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    return { env: env.label, ...(await sweepInlineImages(pool)) };
  } finally {
    await pool.end();
  }
}

function print(sweep) {
  console.log(`\n=== ${sweep.env}: ${sweep.columns} json/jsonb columns swept, ${sweep.rowsScanned} candidate row(s) opened ===`);

  const byColumn = new Map();
  for (const v of sweep.violations) {
    const key = `${v.table}.${v.column}`;
    const e = byColumn.get(key) || { rows: [], bytes: 0, paths: new Map() };
    e.rows.push(v.row);
    e.bytes += v.bytes;
    for (const p of v.paths) {
      const pe = e.paths.get(p.path) || { count: 0, bytes: 0 };
      pe.count += p.count; pe.bytes += p.bytes;
      e.paths.set(p.path, pe);
    }
    byColumn.set(key, e);
  }

  for (const [col, e] of [...byColumn.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`\n  ${col} — ${e.rows.length} row(s) carry inline bytes, ${MB(e.bytes)} MB`);
    for (const [p, pe] of [...e.paths.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.log(`    ${p}  ${pe.count}x  ${MB(pe.bytes)} MB`);
    }
    console.log(`    rows: ${e.rows.slice(0, 10).join(', ')}${e.rows.length > 10 ? ` … +${e.rows.length - 10}` : ''}`);
  }

  if (sweep.transient.rows) {
    console.log(`\n  story_job_checkpoints.step_data — ${sweep.transient.rows} transient row(s), `
      + `${MB(sweep.transient.bytes)} MB (${[...TRANSIENT_CHECKPOINT_STEPS].join('/')}). `
      + `Declared exception: the progressive-display payload, deleted with its job.`);
  }

  console.log(sweep.violations.length
    ? `\n  ❌ ${sweep.env}: ${sweep.violations.length} row(s) hold image bytes in JSONB.`
    : `\n  ✅ ${sweep.env}: no image bytes in JSONB.`);
  return sweep.violations.length;
}

async function main() {
  const args = process.argv.slice(2);
  const envArg = (args.find(a => a.startsWith('--env=')) || '--env=staging').split('=')[1];
  const asJson = args.includes('--json');
  const targets = envArg === 'both' ? ['staging', 'production'] : [envArg];
  for (const t of targets) {
    if (!ENVS[t]) throw new Error(`unknown --env=${t} (staging | production | both)`);
  }

  let failing = 0;
  const payload = [];
  for (const t of targets) {
    const sweep = await sweepEnv(t);
    payload.push(sweep);
    if (asJson) failing += sweep.violations.length;
    else failing += print(sweep);
  }
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  process.exit(failing ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => { console.error('check-inline-images failed:', err.message); process.exit(2); });
}
