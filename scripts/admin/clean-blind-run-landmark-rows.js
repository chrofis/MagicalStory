#!/usr/bin/env node
/**
 * Remove the staging landmark rows written by a BLIND index run.
 *
 * On 2026-08-29 a thinking-budget misconfiguration made every Gemini photo
 * analysis return an unparseable fragment. `findBestLandmarkImage` read that as
 * "no good images" and the indexer saved the landmark anyway, so 404 real Swiss
 * places (Caumasee, Vanil de l'Ecri, Bahnhof Versam-Safien) were recorded as
 * photoless in the STAGING index — none of them present in prod, none of them
 * actually photoless. The guard that stops this recurring is in
 * `server/lib/landmarkPhotos.js` (see docs/decisions.md, 2026-08-29).
 *
 * A row is only deletable when removing it destroys nothing: all six photo
 * columns empty, no matching prod row, and created inside the incident window.
 * Dry run by default.
 *
 *   node scripts/admin/clean-blind-run-landmark-rows.js [--apply]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const APPLY = process.argv.includes('--apply');
(async () => {
  const prod = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const stg  = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const pq = new Set((await prod.query(
    `SELECT wikidata_qid FROM landmark_index WHERE wikidata_qid IS NOT NULL`)).rows.map(r => r.wikidata_qid));

  // Every photo column must be empty — a row is only deletable if deleting it
  // destroys no picture. Age is computed in SQL (node-pg misreads naive
  // TIMESTAMPs as local time).
  const rows = (await stg.query(`
    SELECT id, name, wikidata_qid FROM landmark_index
     WHERE wikidata_qid IS NOT NULL
       AND photo_url IS NULL AND photo_url_2 IS NULL AND photo_url_3 IS NULL
       AND photo_url_4 IS NULL AND photo_url_5 IS NULL AND photo_url_6 IS NULL
       AND created_at > NOW() - INTERVAL '5 days'`)).rows;

  const targets = rows.filter(r => !pq.has(r.wikidata_qid));
  console.log(`${targets.length} photoless staging row(s) from the blind run, absent from prod`);
  targets.slice(0, 5).forEach(r => console.log(`  ${r.id} | ${r.name}`));
  if (!APPLY) { console.log('\n(dry run — pass --apply to delete)'); await prod.end(); await stg.end(); return; }

  const ids = targets.map(r => r.id);
  const del = await stg.query(`DELETE FROM landmark_index WHERE id = ANY($1::int[])`, [ids]);
  console.log(`\ndeleted ${del.rowCount}`);
  const after = await stg.query(`SELECT COUNT(*) c, COUNT(*) FILTER (WHERE photo_url IS NULL) noph
    FROM landmark_index WHERE country ILIKE '%switzerland%'`);
  console.log(`staging Swiss now: ${after.rows[0].c} rows, ${after.rows[0].noph} photoless`);
  await prod.end(); await stg.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
