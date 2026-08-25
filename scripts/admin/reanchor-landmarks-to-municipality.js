#!/usr/bin/env node
/**
 * Re-anchor `nearest_city` to the landmark's TRUE municipality.
 *
 * WHY: discovery searches a 10km radius around a city centre and stamps every
 * hit with the city it was SEARCHING for, so `nearest_city` is an accident of
 * which town was indexed first. Two consequences, both measured 2026-08-25:
 *
 *  - A town is offered landmarks it does not contain. A Dübendorf story was
 *    handed Zürich's Lindenhofbrunnen and wrote "am Lindenhofbrunnen in
 *    Dübendorf" — a place that does not exist.
 *  - A town cannot find its OWN landmarks. `Zürich Zoologischer Garten` exists
 *    exactly once in the index, anchored to *Dübendorf*, so a Zürich story's
 *    city lookup never sees the zoo at all. 1080 production rows were anchored
 *    to a town other than the one they stand in.
 *
 * Setting the anchor to the municipality fixes both directions at once: the
 * wrong town stops offering it, the right town starts. Rows whose municipality
 * is unknown (no municipality-class P131 — motorways, events) are LEFT ALONE:
 * an unknown municipality is not evidence the anchor is wrong.
 *
 * The radius fallback in getIndexedLandmarks still covers a town whose own
 * index is thin, so re-anchoring never leaves a story with nothing.
 *
 * Run backfill-landmark-municipality.js first — this script only moves rows
 * whose municipality is already resolved.
 *
 *   node scripts/admin/reanchor-landmarks-to-municipality.js [--staging] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const label = STAGING ? 'STAGING' : 'PROD';

  const wrong = await pool.query(`
    SELECT nearest_city, municipality, COUNT(*) c
      FROM landmark_index
     WHERE municipality IS NOT NULL
       AND LOWER(municipality) <> LOWER(nearest_city)
     GROUP BY 1, 2 ORDER BY c DESC`);
  const total = wrong.rows.reduce((s, r) => s + Number(r.c), 0);
  console.log(`${label}: ${total} row(s) anchored to the wrong town, across ${wrong.rows.length} pairs`);
  wrong.rows.slice(0, 10).forEach(r => console.log(`   ${String(r.c).padStart(4)}  ${r.nearest_city} → ${r.municipality}`));

  if (DRY) { console.log('\n--dry-run: nothing written.'); await pool.end(); return; }

  const res = await pool.query(`
    UPDATE landmark_index
       SET nearest_city = municipality, updated_at = NOW()
     WHERE municipality IS NOT NULL
       AND LOWER(municipality) <> LOWER(nearest_city)`);
  console.log(`\n✅ re-anchored ${res.rowCount} row(s)`);

  const cities = await pool.query('SELECT COUNT(DISTINCT nearest_city) c FROM landmark_index');
  console.log(`distinct anchor cities now: ${cities.rows[0].c}`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
