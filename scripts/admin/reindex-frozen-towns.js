#!/usr/bin/env node
/**
 * Re-index the towns the auto-index guard deliberately freezes.
 *
 * WHY: since 2026-08-29 an already-indexed town never triggers discovery again
 * (`townAlreadyIndexed()` in server/lib/landmarkPhotos.js) — that stopped an
 * infinite loop where 146 Swiss towns re-discovered the same rejected
 * landmarks forever, at ~30 landmarks of paid analysis a turn.
 *
 * The guard is right, but it has a cost: a town whose ONLY rows are junk is now
 * frozen with that junk. Menzingen's single row was a BATTLE — nothing
 * servable, so it resolved to zero, so it used to re-discover; now it never
 * would, even though Menzingen has real landmarks. Discovery belongs at
 * MAINTENANCE time, not on a user's request, and this is that maintenance pass.
 *
 * COSTS MONEY. `indexLandmarksForCity` sends every candidate photo to Gemini.
 * Budget roughly per town = maxLandmarks × candidate images. Dry run by
 * default, `--limit` is mandatory for a real run, and there is no "all" mode
 * on purpose — this is a capped, deliberate spend, not a background job.
 *
 *   node scripts/admin/reindex-frozen-towns.js                 # list them, spend nothing
 *   node scripts/admin/reindex-frozen-towns.js --limit=5 --apply
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const STAGING = args.includes('--staging');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const maxArg = args.find(a => a.startsWith('--max-landmarks='));
const MAX_LANDMARKS = maxArg ? parseInt(maxArg.split('=')[1], 10) : 10;

// Mirrors the live serving filters — a town is frozen when NOTHING it holds can
// be offered: every row is a non-place, judged unusable, or has no picture.
const NORM = t => `LOWER(translate(${t}, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns'))`;
const TOWN = `coalesce(locality, municipality, nearest_city)`;
const CH = `(country ILIKE '%switzerland%' OR country ILIKE '%schweiz%' OR country = 'CH')`;
const SERVABLE = `coalesce(type,'x') NOT IN ('Event','Organisation','Other')
  AND (story_score IS NULL OR story_score >= 40)
  AND photo_url IS NOT NULL`;

(async () => {
  const cs = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  // Must mirror TOWN_MATCHES_SQL exactly. Grouping rows by
  // coalesce(locality, municipality, nearest_city) does NOT: it splits one
  // town's rows across several group keys, so a town looks empty while the
  // live lookup — which matches locality OR municipality/nearest_city — finds
  // them. That mistake reported Bellinzona as frozen when it serves its UNESCO
  // castles perfectly well.
  const MATCHES = `(${NORM(`coalesce(l.locality, '')`)} = t.town
                    OR ${NORM('coalesce(l.municipality, l.nearest_city)')} = t.town)`;
  const towns = (await pool.query(`
    WITH t AS (
      SELECT DISTINCT ${NORM(TOWN)} town FROM landmark_index
       WHERE ${CH} AND ${TOWN} IS NOT NULL AND btrim(${TOWN}) <> ''
         AND ${NORM(TOWN)} NOT LIKE 'kanton %' AND ${NORM(TOWN)} NOT LIKE 'bezirk %')
    SELECT t.town,
           (SELECT COUNT(*) FROM landmark_index l WHERE ${MATCHES}) rows
      FROM t
     WHERE NOT EXISTS (SELECT 1 FROM landmark_index l WHERE ${MATCHES} AND ${SERVABLE})
     ORDER BY 2 DESC, 1`)).rows;

  // The SQL above is a CANDIDATE list, not an answer: it cannot model the
  // resolver's comma-normalised, first-word and proximity fallbacks, so it
  // over-reports ("Wil (SG)" has no row under that exact name, yet the
  // first-word fallback serves it four). Confirm every candidate through the
  // real resolver before spending a franc — it is a DB read, so it is free.
  const db = require('../../server/services/database');
  db.initializePool();
  const { getIndexedLandmarks } = require('../../server/lib/landmarkPhotos');

  const confirmed = [];
  for (const t of towns) {
    // Runtime passes the user's coordinates, which is what lets proximity
    // rescue a town. Use the town's own rows as the stand-in for that.
    const c = (await pool.query(
      `SELECT AVG(latitude::float) lat, AVG(longitude::float) lon FROM landmark_index l
        WHERE (${NORM(`coalesce(l.locality, '')`)} = $1
            OR ${NORM('coalesce(l.municipality, l.nearest_city)')} = $1)
          AND latitude IS NOT NULL`, [t.town])).rows[0];
    const loc = { city: t.town };
    if (c?.lat != null) { loc.latitude = c.lat; loc.longitude = c.lon; }
    const served = await getIndexedLandmarks(loc, 5);
    const usable = served.filter(r => r.photo_url && !['City', 'Village', 'Event', 'Organisation', 'Other'].includes(r.type || 'x'));
    if (usable.length === 0) confirmed.push(t);
  }

  console.log(`${STAGING ? 'STAGING' : 'PROD'}: ${towns.length} candidate(s) → ` +
    `${confirmed.length} genuinely frozen after asking the resolver\n`);
  const todo = LIMIT ? confirmed.slice(0, LIMIT) : confirmed;
  todo.forEach(t => console.log(`  ${t.town} (${t.rows} unusable row(s))`));

  if (!APPLY) {
    console.log(`\n(dry run — nothing spent. Re-run with --limit=N --apply to index the first N.)`);
    console.log(`Every town costs ~${MAX_LANDMARKS} landmarks of PAID Gemini photo analysis.`);
    await pool.end();
    return;
  }
  if (!LIMIT) {
    console.error('\nRefusing to run without --limit: this spends money per town.');
    await pool.end();
    process.exit(1);
  }

  const { indexLandmarksForCity } = require('../../server/lib/landmarkPhotos');

  let gained = 0;
  for (const t of todo) {
    const before = Number((await pool.query(
      `SELECT COUNT(*) k FROM landmark_index WHERE ${NORM(TOWN)} = ${NORM('$1')}`, [t.town])).rows[0].k);
    let res;
    try {
      res = await indexLandmarksForCity(t.town, 'Switzerland', { maxLandmarks: MAX_LANDMARKS });
    } catch (e) {
      console.log(`  ${t.town}: failed (${e.message})`);
      continue;
    }
    // The analyser being down means later towns would be recorded blind too.
    if (res?.abortedAnalyzerDown) {
      console.error(`\n🛑 image analysis unavailable — stopping before more towns are indexed blind.`);
      break;
    }
    const after = Number((await pool.query(
      `SELECT COUNT(*) k FROM landmark_index WHERE ${NORM(TOWN)} = ${NORM('$1')}`, [t.town])).rows[0].k);
    const servable = Number((await pool.query(
      `SELECT COUNT(*) k FROM landmark_index WHERE ${NORM(TOWN)} = ${NORM('$1')} AND ${SERVABLE}`, [t.town])).rows[0].k);
    gained += after - before;
    console.log(`  ${String(t.town).padEnd(24)} +${after - before} row(s) | ${servable} now servable`);
  }

  console.log(`\n${gained} row(s) added. New rows are UNJUDGED (story_score NULL) and are served as such —`);
  console.log('judge them with scripts/admin/prep-landmark-judging.js when convenient.');
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
