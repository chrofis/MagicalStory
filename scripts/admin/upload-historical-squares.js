#!/usr/bin/env node
/**
 * Upload the drafted square landmark images to R2 and populate
 * historical_locations.photo_url_square.
 *
 * Reads drafts/historical-squares/<event_id>__<basename>.jpg (produced by
 * gen-historical-squares.js), uploads each to R2 at
 *   landmarks/historical/square/<basename>
 * (one shared bucket — both prod and staging reference the same public URL),
 * then sets photo_url_square on the matching historical_locations row, matched
 * by the basename of photo_url.
 *
 * The column is added (IF NOT EXISTS) on the target DB first.
 *
 * Usage:
 *   node scripts/admin/upload-historical-squares.js            # prod (DATABASE_URL)
 *   node scripts/admin/upload-historical-squares.js --staging  # staging (STAGING_DATABASE_URL)
 *   node scripts/admin/upload-historical-squares.js --skip-upload  # only set DB col (R2 already done)
 *   node scripts/admin/upload-historical-squares.js --dry-run
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const r2 = require('../../server/lib/r2');

const flag = name => process.argv.includes(`--${name}`);
const STAGING = flag('staging');
const DRY = flag('dry-run');
const SKIP_UPLOAD = flag('skip-upload');

const DRAFT_DIR = path.resolve(__dirname, '..', '..', 'drafts', 'historical-squares');
const R2_PREFIX = 'landmarks/historical/square';

function basenameFromUrl(url) {
  try { return path.basename(new URL(url).pathname); } catch { return path.basename(url || ''); }
}

(async () => {
  const cs = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const env = STAGING ? 'STAGING' : 'PROD';
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  // 1. Schema: add the column if missing
  if (!DRY) {
    await pool.query(`ALTER TABLE historical_locations ADD COLUMN IF NOT EXISTS photo_url_square TEXT`);
    console.log(`[${env}] ensured photo_url_square column`);
  }

  // 2. Load rows; index by basename(photo_url)
  const { rows } = await pool.query(`SELECT id, event_id, location_name, photo_url FROM historical_locations`);
  const byBase = new Map();
  for (const r of rows) if (r.photo_url) byBase.set(basenameFromUrl(r.photo_url), r);
  console.log(`[${env}] ${rows.length} rows (${byBase.size} with photo_url)`);

  if (!fs.existsSync(DRAFT_DIR)) { console.error('No drafts dir:', DRAFT_DIR); process.exit(1); }
  const files = fs.readdirSync(DRAFT_DIR).filter(f => f.endsWith('.jpg'));
  console.log(`[${env}] ${files.length} draft squares to process${DRY ? ' (DRY RUN)' : ''}`);

  let uploaded = 0, set = 0, unmatched = 0, failed = 0;
  for (const f of files) {
    const base = f.replace(/^[a-z0-9-]+__/, ''); // strip "<event_id>__"
    const row = byBase.get(base);
    if (!row) { unmatched++; console.warn(`  unmatched (no row for ${base}): ${f}`); continue; }
    const key = `${R2_PREFIX}/${base}`;
    try {
      let url;
      if (SKIP_UPLOAD || DRY) {
        url = `${process.env.R2_PUBLIC_URL}/${key}`;
      } else {
        const buf = fs.readFileSync(path.join(DRAFT_DIR, f));
        url = await r2.uploadImage(buf, key, 'image/jpeg');
        if (!url) throw new Error('uploadImage returned null');
        uploaded++;
      }
      if (!DRY) {
        await pool.query(`UPDATE historical_locations SET photo_url_square = $1 WHERE id = $2`, [url, row.id]);
        set++;
      }
    } catch (e) { failed++; console.error(`  FAIL ${f}: ${e.message}`); }
  }
  console.log(`\n[${env}] Done. uploaded=${uploaded} db_set=${set} unmatched=${unmatched} failed=${failed}`);
  await pool.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
