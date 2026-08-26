#!/usr/bin/env node
/**
 * Fetch reference photos for landmark_index rows that have none.
 *
 * WHY: `indexLandmarksForCities` guards its whole photo block with
 * `if (analyzePhotos && …)` — and that block does TWO different things:
 * `findBestLandmarkImage` (Wikipedia/Commons, free) fetches the photos, and
 * `analyzeLandmarkPhoto` (Gemini, paid) describes them. Passing
 * `analyzePhotos: false` to keep a bulk run free therefore also skips the
 * FETCH, so the 2026-08-26 all-towns discovery inserted 4,742 rows — 661
 * castles, 634 churches, 178 bridges — with no reference image at all.
 *
 * A landmark with no photo is close to useless downstream: the story can name
 * the place, but the illustrator gets no reference plate, so the render is
 * whatever the model imagines a "Schloss X" looks like.
 *
 * This re-runs ONLY the free half. No model is called: findBestLandmarkImage
 * hits Wikipedia article images and the Commons category, and the descriptions
 * written here are Commons metadata, never AI text.
 *
 *   node scripts/admin/backfill-landmark-photos.js [--limit=N] [--staging] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

// Only types a scene can be set at are worth the fetch — a station or a river
// with no photo costs nothing by staying photoless.
const BACKDROP = ['Cathedral', 'Church', 'Abbey', 'Monastery', 'Castle', 'Palace', 'Museum',
  'Bridge', 'Tower', 'Fountain', 'Square', 'Theatre', 'Park', 'Monument', 'Library'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (STAGING) process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
  const db = require('../../server/services/database');
  db.initializePool();
  const { findBestLandmarkImage } = require('../../server/lib/landmarkPhotos');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const rows = (await pool.query(
    `SELECT id, name, type, lang, wikipedia_page_id, wikidata_qid, region, country
       FROM landmark_index
      WHERE photo_url IS NULL
        AND type = ANY($1)
      -- Newest first. The OLDEST photoless rows are the ones the 2026-06 A→Z
      -- gap-fill already tried and failed on — art museums whose Commons
      -- category holds the artworks not the building, stub QIDs, demolished
      -- sites. Ordering by id ascending spends the whole run re-failing on
      -- those and never reaches the rows that actually need filling.
      ORDER BY id DESC${LIMIT ? ` LIMIT ${LIMIT}` : ''}`, [BACKDROP])).rows;

  console.log(`${STAGING ? 'STAGING' : 'PROD'}: ${rows.length} photoless backdrop landmark(s)`);
  if (DRY) { rows.slice(0, 10).forEach(r => console.log(`   ${r.type} — ${r.name}`)); await pool.end(); return; }

  let filled = 0, none = 0;
  for (const l of rows) {
    let best = null;
    try {
      best = await findBestLandmarkImage(
        l.name, l.type, l.lang, l.wikipedia_page_id, l.wikidata_qid, l.region, l.country);
    } catch (e) {
      console.log(`  ${l.name}: fetch failed (${e.message})`);
    }
    const ext = best?.exteriorImages || [];
    const int = best?.interiorImages || [];
    if (!ext.length && !int.length) { none++; await sleep(250); continue; }

    const pick = [...ext.slice(0, 3), ...int.slice(0, 3)];
    const cols = [];
    const vals = [l.id];
    pick.forEach((img, i) => {
      const s = i === 0 ? '' : `_${i + 1}`;
      vals.push(img.url, img.attribution || null, img.description || null);
      cols.push(`photo_url${s} = $${vals.length - 2}`, `photo_attribution${s} = $${vals.length - 1}`, `photo_description${s} = $${vals.length}`);
    });
    vals.push(best?.source || 'commons');
    cols.push(`photo_source = $${vals.length}`);

    await pool.query(`UPDATE landmark_index SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);
    filled++;
    if (filled % 25 === 0) console.log(`  ${filled} filled / ${none} without any image (${filled + none}/${rows.length})`);
    await sleep(250);   // one Wikimedia consumer at a time; 429s return empty downloads
  }

  console.log(`\n✅ ${filled} landmark(s) given photos, ${none} had none available on Commons.`);
  console.log('New photos are UNJUDGED — run score-landmarks-for-stories.js to score them.');
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
