#!/usr/bin/env node
/**
 * Close the landmark COVERAGE gap for cities that have no real landmark.
 *
 * WHY: measured 2026-08-26, only 43 of the 100 cities in swiss-cities.json —
 * the ones with public SEO landing pages — have a single landmark a story can
 * be set at. Davos, Arosa, Andermatt, Adelboden, Flims and Ascona have exactly
 * ONE row each: the `<Town> (Stadt)` aerial that broad-city-overviews.js
 * creates. Their landmarks were never discovered.
 *
 * Three earlier passes all completed and all missed them, because each was
 * driven by a signal that is blind to resort towns:
 *   - broad-city-overviews.js  → one aerial per town, by design
 *   - the A→Z photo gap-fill   → improved PHOTOS on rows that already existed
 *   - the famous-buildings fill → Wikidata's top-1000 by SITELINK count
 *
 * This runs the per-landmark Wikipedia geosearch (`indexLandmarksForCity`)
 * that those passes never applied to these towns.
 *
 * FREE: `analyzePhotos: false` is mandatory — the default path sends every
 * photo to Gemini. Wikipedia/Wikidata/Commons are free; nothing here is billed.
 *
 * Discovery is the pass that made the index station-heavy (294 Swiss railway
 * stations) and anchored rows to whatever town was searched, so afterwards it
 * stamps `municipality` from Wikidata P131 on the new rows — the query-time
 * guard in landmarkPhotos.js then keeps a town from being offered a
 * neighbour's landmark as its own.
 *
 * New rows land with `story_score` NULL, i.e. unjudged. Judge them with
 * scripts/admin/score-landmarks-for-stories.js before trusting the ranking —
 * an undiscovered photo can be a construction site.
 *
 *   node scripts/admin/discover-missing-city-landmarks.js [--limit=N] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const BACKDROP = ['Cathedral', 'Church', 'Abbey', 'Monastery', 'Castle', 'Palace', 'Museum',
  'Bridge', 'Tower', 'Fountain', 'Square', 'Theatre', 'Park', 'Monument', 'Library'];

(async () => {
  const db = require('../../server/services/database');
  db.initializePool();
  const { indexLandmarksForCity } = require('../../server/lib/landmarkPhotos');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const cities = require('../../server/data/swiss-cities.json').cities;

  // Which SEO cities have no landmark a scene can be set at?
  const missing = [];
  for (const c of cities) {
    const name = c.name.de || c.name.en;
    const r = await pool.query(
      `SELECT COUNT(*) k FROM landmark_index
        WHERE LOWER(translate(nearest_city, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns'))
            = LOWER(translate($1, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns'))
          AND type = ANY($2)`, [name, BACKDROP]);
    if (Number(r.rows[0].k) === 0) missing.push(name);
  }

  const todo = LIMIT ? missing.slice(0, LIMIT) : missing;
  console.log(`SEO cities with no real landmark: ${missing.length}/100`);
  console.log(`processing ${todo.length}: ${todo.join(', ')}\n`);
  if (DRY) { await pool.end(); return; }

  let added = 0;
  for (const city of todo) {
    const before = Number((await pool.query(
      `SELECT COUNT(*) k FROM landmark_index WHERE LOWER(nearest_city) = LOWER($1)`, [city])).rows[0].k);
    try {
      // analyzePhotos:false keeps this free — the default sends photos to Gemini.
      await indexLandmarksForCity(city, 'Switzerland', { analyzePhotos: false, maxLandmarks: 20 });
    } catch (e) {
      console.log(`  ${city}: discovery failed (${e.message})`);
      continue;
    }
    const after = Number((await pool.query(
      `SELECT COUNT(*) k FROM landmark_index WHERE LOWER(nearest_city) = LOWER($1)`, [city])).rows[0].k);
    const gained = after - before;
    added += gained;
    const real = Number((await pool.query(
      `SELECT COUNT(*) k FROM landmark_index WHERE LOWER(nearest_city) = LOWER($1) AND type = ANY($2)`,
      [city, BACKDROP])).rows[0].k);
    console.log(`  ${city.padEnd(18)} +${String(gained).padStart(3)} rows | now ${real} usable as a scene`);
  }

  console.log(`\n${added} row(s) added. Stamping municipality on the new rows…`);
  await pool.end();

  // Free, and it is what stops a newly discovered neighbour being offered as local.
  try {
    execFileSync('node', [path.join(__dirname, 'backfill-landmark-municipality.js')],
      { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  } catch (e) {
    console.log(`municipality backfill did not finish: ${e.message} — re-run it directly`);
  }

  console.log('\nNEW ROWS ARE UNJUDGED (story_score NULL).');
  console.log('Run: node scripts/admin/score-landmarks-for-stories.js   (costs Haiku calls)');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
