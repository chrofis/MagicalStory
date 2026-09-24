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
 * Per-image scores (landmark_photo_scores) are MIRRORED, not merged: for every
 * landmark this run syncs, staging ends up holding exactly prod's score rows,
 * and a staging row prod does not have is deleted. Upsert-only left staging on
 * 2026-09-24 with 2,615 scores for slots whose photo prod had since removed or
 * reshuffled (1,809 of them >= 40, so bestPhotoSlots served empty slots) and 10
 * scores describing a different picture than the slot now holds. Landmarks that
 * exist only on staging are not touched. The mirror is one transaction, and the
 * rows it deletes are written to a JSON backup first (--backup=FILE, default
 * $TEMP/landmark-sync-deleted-scores-<ms>.json). --dry-run prints them.
 *
 *   node scripts/admin/sync-landmark-index-to-staging.js [--city=Dübendorf] [--dry-run] [--backup=FILE]
 */
'use strict';

const path = require('path');
const fs = require('fs');

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
  // Our R2 copies (migration 035) — one shared bucket, so the URLs are valid on staging too.
  'photo_r2_url', 'photo_r2_url_2', 'photo_r2_url_3', 'photo_r2_url_4', 'photo_r2_url_5', 'photo_r2_url_6',
  'fame_sitelinks', 'fame_pageviews', 'fame_updated_at',
  // Enrichment lives on prod and must travel with the row, or staging silently
  // ranks on the old signals while prod ranks on the new ones.
  'municipality', 'municipality_updated_at',
  'locality', 'locality_updated_at',
  'story_score', 'story_score_reason', 'story_score_at',
];

const scoreKey = (qid, slot) => `${qid}_${Number(slot)}`;

/**
 * The staging score rows to delete so that, for every synced landmark, staging
 * holds exactly prod's rows. A staging row survives when its landmark was not
 * synced (staging-only, or outside --city) or when prod has the same
 * (qid, slot). Pure: the unit test drives it with rows shaped like the queries.
 *
 * @param {Iterable<string>} prodKeys   scoreKey(qid, slot) of every prod score row
 * @param {Iterable<string>} syncedQids the qids this run copies from prod
 * @param {Array<{wikidata_qid: string|null, slot: number}>} stagingRows
 */
function scoreRowsToDelete(prodKeys, syncedQids, stagingRows) {
  const keep = new Set(prodKeys);
  const synced = new Set(syncedQids);
  return stagingRows.filter(r => r.wikidata_qid && synced.has(r.wikidata_qid)
    && !keep.has(scoreKey(r.wikidata_qid, r.slot)));
}

async function main() {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
  const { Pool } = require('pg');

  const args = process.argv.slice(2);
  const DRY = args.includes('--dry-run');
  const cityArg = args.find(a => a.startsWith('--city='));
  const CITY = cityArg ? cityArg.split('=').slice(1).join('=') : null;
  const backupArg = args.find(a => a.startsWith('--backup='));
  const BACKUP = backupArg ? backupArg.split('=').slice(1).join('=')
    : path.join(process.env.TEMP || '/tmp', `landmark-sync-deleted-scores-${Date.now()}.json`);

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
  const syncedQids = src.rows.map(r => r.wikidata_qid);
  const before = await stg.query('SELECT COUNT(*) c FROM landmark_index');
  console.log(`prod rows to copy : ${src.rows.length}${CITY ? ` (city=${CITY})` : ' (all)'}`);
  console.log(`staging rows now  : ${before.rows[0].c}`);

  // Per-image judgements live in their own table and must travel too. Without
  // them staging keeps story_score but has no landmark_photo_scores, so
  // bestPhotoSlots() finds nothing and every landmark silently falls back to
  // its lead image — the exact behaviour the judging exists to replace.
  //
  // Keyed on the staging row's OWN id, resolved through wikidata_qid: ids are
  // per-database and assuming they match would attach Zürich's scores to a
  // Ticino church. judged_at travels as text: it is a naive TIMESTAMP, and a
  // JS Date round trip through node-pg reinterprets it in local time.
  const scores = (await prod.query(`
    SELECT l.wikidata_qid, s.slot, s.draw_score, s.photo_score, s.framing, s.reason, s.judged_at::text judged_at
      FROM landmark_photo_scores s JOIN landmark_index l ON l.id = s.landmark_id
     WHERE l.wikidata_qid = ANY($1)`, [syncedQids])).rows;
  const prodKeys = scores.map(r => scoreKey(r.wikidata_qid, r.slot));
  const STG_SCORES_SQL = `
    SELECT s.landmark_id, s.slot, s.draw_score, s.photo_score, s.framing, s.reason,
           s.judged_at::text judged_at, l.wikidata_qid, l.name,
           (ARRAY[l.photo_url, l.photo_url_2, l.photo_url_3, l.photo_url_4, l.photo_url_5, l.photo_url_6])[s.slot] slot_photo_url
      FROM landmark_photo_scores s JOIN landmark_index l ON l.id = s.landmark_id
     WHERE l.wikidata_qid = ANY($1)`;

  if (DRY) {
    const stgScores = (await stg.query(STG_SCORES_SQL, [syncedQids])).rows;
    const del = scoreRowsToDelete(prodKeys, syncedQids, stgScores);
    console.log(`prod score rows   : ${scores.length}`);
    console.log(`staging score rows: ${stgScores.length} on synced landmarks — ${del.length} would be DELETED (prod has no such row):`);
    del.forEach(r => console.log(`  ${r.wikidata_qid} slot ${r.slot} | ${r.name} | photo ${r.photo_score} | ${r.slot_photo_url ? 'slot has a photo' : 'slot empty'} | ${r.reason}`));
    console.log('\n--dry-run: nothing written.');
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

  // The mirror is ONE transaction: a half-applied one (deleted, not yet
  // re-inserted) would leave landmarks with no judged slot at all.
  const client = await stg.connect();
  try {
    await client.query('BEGIN');
    const stgScores = (await client.query(`${STG_SCORES_SQL} FOR UPDATE OF s`, [syncedQids])).rows;
    const del = scoreRowsToDelete(prodKeys, syncedQids, stgScores);
    // Backup BEFORE deleting: the rows are judging evidence.
    fs.writeFileSync(BACKUP, JSON.stringify(del, null, 1));
    console.log(`backup of ${del.length} score row(s) to delete → ${BACKUP}`);
    if (del.length) {
      const r = await client.query(
        `DELETE FROM landmark_photo_scores s
          USING unnest($1::int[], $2::int[]) AS d(landmark_id, slot)
          WHERE s.landmark_id = d.landmark_id AND s.slot = d.slot`,
        [del.map(x => x.landmark_id), del.map(x => x.slot)]);
      if (r.rowCount !== del.length) throw new Error(`deleted ${r.rowCount} score rows, expected ${del.length}`);
    }
    const up = await client.query(`
      INSERT INTO landmark_photo_scores (landmark_id, slot, draw_score, photo_score, framing, reason, judged_at)
      SELECT l.id, x.slot, x.draw, x.photo, x.framing, x.reason, x.judged_at::timestamp
        FROM unnest($1::text[], $2::int[], $3::int[], $4::int[], $5::text[], $6::text[], $7::text[])
             AS x(qid, slot, draw, photo, framing, reason, judged_at)
        JOIN landmark_index l ON l.wikidata_qid = x.qid
      ON CONFLICT (landmark_id, slot) DO UPDATE
        SET draw_score = EXCLUDED.draw_score, photo_score = EXCLUDED.photo_score,
            framing = EXCLUDED.framing, reason = EXCLUDED.reason, judged_at = EXCLUDED.judged_at`,
      [scores.map(r => r.wikidata_qid), scores.map(r => r.slot), scores.map(r => r.draw_score),
        scores.map(r => r.photo_score), scores.map(r => r.framing), scores.map(r => r.reason),
        scores.map(r => r.judged_at)]);
    if (up.rowCount !== scores.length) throw new Error(`upserted ${up.rowCount} score rows, expected ${scores.length}`);
    await client.query('COMMIT');
    console.log(`image scores mirrored: ${up.rowCount} upserted, ${del.length} deleted`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const after = await stg.query('SELECT COUNT(*) c, COUNT(DISTINCT nearest_city) cities FROM landmark_index');
  console.log(`\n✅ staging now: ${after.rows[0].c} rows across ${after.rows[0].cities} cities (was ${before.rows[0].c})`);
  await prod.end(); await stg.end();
}

module.exports = { scoreRowsToDelete, scoreKey, COLUMNS };

if (require.main === module) {
  main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
}
