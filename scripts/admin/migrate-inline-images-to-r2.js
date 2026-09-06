#!/usr/bin/env node
/**
 * Move every inline image byte out of `characters.data` / `stories.data` into R2.
 *
 * WHY: the no-images-in-JSONB rule was enforced at the STORY save path only
 * (`extractInlineImagesToR2`, whose every call site passes a storyId).
 * Characters have their own write paths and were never covered, and story rows
 * written before the June 2026 fix were never back-migrated. Measured on
 * production 2026-09-01: 621 MB of `stories.data` and 73 MB of `characters.data`
 * still held base64.
 *
 * This is not cosmetic. Railway bills the container's memory, which counts the
 * OS page cache holding the database files — `shared_buffers` is only 160 MB,
 * so Postgres RAM tracks database SIZE almost exactly (prod DB 1,818 MB → 2.14 GB
 * container). Shrinking the rows is what lowers the memory line.
 *
 * The walker and the upload loop live in server/lib/dbHousekeeping.js, which is
 * also what the in-app scheduler runs — one implementation, so a fix here can
 * never diverge from what runs nightly inside Railway. This file is the manual
 * entry point: dry run by default, and it can target either database.
 *
 *   node scripts/admin/migrate-inline-images-to-r2.js [--staging] [--table=characters|stories] [--limit=N] [--apply]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const r2 = require('../../server/lib/r2');
const { collect, offloadInlineImages, databaseSize } = require('../../server/lib/dbHousekeeping');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const STAGING = args.includes('--staging');
const tableArg = args.find(a => a.startsWith('--table='));
const TABLES = tableArg ? [tableArg.split('=')[1]] : ['characters', 'stories'];
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const MB = (n) => (n / 1024 / 1024).toFixed(1);

// The module logs through the app logger's shape; console is the CLI equivalent.
const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.log(...a),
  error: (...a) => console.error(...a),
  debug: () => {},
};

(async () => {
  if (!r2.isConfigured()) {
    console.error('R2 is not configured — refusing to run. Bytes must go somewhere real.');
    process.exit(1);
  }
  const cs = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const label = STAGING ? 'STAGING' : 'PROD';

  for (const table of TABLES) {
    const rows = (await pool.query(
      `SELECT id, data FROM ${table} WHERE data::text LIKE '%data:image%'
        ORDER BY pg_column_size(data) DESC${LIMIT ? ` LIMIT ${LIMIT}` : ''}`)).rows;
    const bytes = rows.reduce((s, r) => s + collect(r.data, 'x').reduce((a, t) => a + t.bytes, 0), 0);
    console.log(`\n=== ${label} ${table}: ${rows.length} row(s) with inline images, ~${MB(bytes)} MB ===`);
  }

  if (!APPLY) {
    console.log('\n(dry run — pass --apply)');
  } else {
    const res = await offloadInlineImages(pool, log, { tables: TABLES, limit: LIMIT });
    console.log(`\n✅ ${res.rows} row(s) migrated, ${res.images} image(s) to R2 ` +
                `(${res.mb.toFixed(1)} MB), ${res.skipped} row(s) skipped`);
  }

  console.log(`\n${label} database now ${(await databaseSize(pool)).pretty}`);
  console.log('NOTE: space is not returned to the OS until VACUUM FULL / pg_repack runs.');
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
