#!/usr/bin/env node
/**
 * Copy `landmark_index` from PRODUCTION to STAGING.
 *
 * WHY: staging and production are separate Postgres instances, and each one's
 * landmark_index is filled by its own discovery runs. They drift badly —
 * measured 2026-08-25: prod 4764 rows across 1594 cities, staging 449 rows
 * across 21. A staging story set in a city prod knows about therefore falls
 * through to the radius fallback and is offered landmarks from a DIFFERENT
 * town: a Dübendorf story was handed Zürich's Lindenhofbrunnen (~6 km away)
 * and wrote "am Lindenhofbrunnen in Dübendorf", a place that does not exist.
 *
 * The index is REFERENCE data — discovered from Wikipedia/Wikidata, identical
 * for every environment, and owned by no user. Copying prod → staging is
 * therefore safe in that direction only. Never the reverse: staging discovery
 * runs are experiments and must not leak into the production index.
 *
 * Photo URLs are copied verbatim and are not re-hosted: staging and production
 * share the same R2 bucket (see the iterating-on-production-stories skill), so
 * a prod photo URL already resolves on staging.
 *
 * Upserts on wikidata_qid (UNIQUE). Rows with no qid are skipped — without a
 * stable key they would duplicate on every run.
 *
 *   node scripts/admin/sync-landmark-index-to-staging.js [--city=Dübendorf] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const cityArg = args.find(a => a.startsWith('--city='));
const CITY = cityArg ? cityArg.split('=').slice(1).join('=') : null;

const COLUMNS = [
  'name', 'wikipedia_page_id', 'wikidata_qid', 'lang', 'latitude', 'longitude',
  'nearest_city', 'country', 'region', 'type', 'boost_amount', 'categories',
  'photo_url', 'photo_attribution', 'photo_source', 'photo_description',
  'commons_photo_count', 'score', 'wikipedia_extract',
  'photo_url_2', 'photo_attribution_2', 'photo_description_2',
  'photo_url_3', 'photo_attribution_3', 'photo_description_3',
  'photo_url_4', 'photo_attribution_4', 'photo_description_4',
  'photo_url_5', 'photo_attribution_5', 'photo_description_5',
  'photo_url_6', 'photo_attribution_6', 'photo_description_6',
  'photo_type', 'photo_type_2', 'photo_type_3', 'photo_type_4', 'photo_type_5', 'photo_type_6',
  'fame_sitelinks', 'fame_pageviews', 'fame_updated_at',
];

(async () => {
  if (!process.env.DATABASE_URL || !process.env.STAGING_DATABASE_URL) {
    console.error('Need DATABASE_URL and STAGING_DATABASE_URL in .env');
    process.exit(1);
  }
  const prod = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const stg = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const where = CITY
    ? `WHERE wikidata_qid IS NOT NULL AND LOWER(translate(nearest_city, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns')) = LOWER(translate($1, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns'))`
    : 'WHERE wikidata_qid IS NOT NULL';
  const params = CITY ? [CITY] : [];

  const src = await prod.query(`SELECT ${COLUMNS.join(', ')} FROM landmark_index ${where}`, params);
  const before = await stg.query('SELECT COUNT(*) c FROM landmark_index');
  console.log(`prod rows to copy : ${src.rows.length}${CITY ? ` (city=${CITY})` : ' (all)'}`);
  console.log(`staging rows now  : ${before.rows[0].c}`);

  if (DRY) {
    console.log('\n--dry-run: nothing written. Sample:');
    src.rows.slice(0, 5).forEach(r => console.log(`  ${r.nearest_city} | ${r.name} | score ${r.score}`));
    await prod.end(); await stg.end();
    return;
  }

  const cols = COLUMNS.join(', ');
  const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
  const updates = COLUMNS.filter(c => c !== 'wikidata_qid').map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO landmark_index (${cols}) VALUES (${placeholders})
               ON CONFLICT (wikidata_qid) DO UPDATE SET ${updates}, updated_at = NOW()`;

  let done = 0;
  for (const row of src.rows) {
    await stg.query(sql, COLUMNS.map(c => row[c]));
    if (++done % 250 === 0) console.log(`  ${done}/${src.rows.length}`);
  }

  const after = await stg.query('SELECT COUNT(*) c, COUNT(DISTINCT nearest_city) cities FROM landmark_index');
  console.log(`\n✅ staging now: ${after.rows[0].c} rows across ${after.rows[0].cities} cities (was ${before.rows[0].c})`);
  await prod.end(); await stg.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
