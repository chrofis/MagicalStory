#!/usr/bin/env node
/**
 * Backfill `landmark_index.municipality` from Wikidata P131.
 *
 * WHY: `nearest_city` is the city discovery was SEARCHING around, not the town
 * the landmark is in — see migrations/028_landmark_municipality.sql. Without
 * the real municipality we cannot tell a genuinely local landmark from one
 * 6km away in the next town, and the story prompt asserts the landmark is in
 * the child's home town either way.
 *
 * Wikidata is free and batchable: wbgetentities takes 50 QIDs per call, so the
 * whole production index (4762 rows with a qid) is ~96 requests. P131 gives the
 * containing administrative entity as another QID, which needs a second pass to
 * resolve to a label — those are cached, since a few hundred municipalities
 * cover thousands of landmarks.
 *
 *   node scripts/admin/backfill-landmark-municipality.js [--staging] [--city=X] [--limit=N] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const cityArg = args.find(a => a.startsWith('--city='));
const CITY = cityArg ? cityArg.split('=').slice(1).join('=') : null;
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const API = 'https://www.wikidata.org/w/api.php';
const UA = 'MagicalStory/1.0 (landmark municipality backfill; contact: rogerfischer@hotmail.com)';
const labelCache = new Map();

const chunk = (arr, n) => arr.reduce((a, x, i) => (i % n ? a[a.length - 1].push(x) : a.push([x]), a), []);

async function wd(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`wikidata ${res.status}`);
  return res.json();
}

// P131 points at whatever administrative level Wikidata happened to record, and
// for a fair number of entries that is a canton or a district, not a town:
// measured on Dübendorf, "St. Gallus (Zürich-Schwamendingen)" resolves to
// "Kanton Zürich" and "St. Michael (Dietlikon)" to "Bezirk Bülach". Storing
// those would make a municipality filter reject genuinely local landmarks, so
// a P131 target is only accepted when it is a MUNICIPALITY-class entity.
const MUNICIPALITY_CLASSES = new Set([
  'Q70208',    // municipality of Switzerland
  'Q13402009', // Swiss municipality (alt class in use)
  'Q262166',   // municipality of Germany
  'Q484170',   // commune of France
  'Q747074',   // comune of Italy
  'Q515',      // city
  'Q3957',     // town
  'Q532',      // village
  'Q15284',    // municipality (generic)
]);

// Wikidata alone leaves most of the index unresolved: measured 2026-08-27 on
// production, 4022 Swiss rows had a qid but still no municipality, and a 200-row
// sample resolved ZERO. The reason is not a bug here — most entries simply carry
// no municipality-level P131 (ABB Technikerschule points at "Kanton Aargau";
// two of three sampled rows had no P131 at all), and the class check above
// rightly refuses a canton.
//
// The coordinates, however, are populated. OSM's Nominatim reverse-geocodes them
// to a real municipality for free, and it is a REAL source, not an inference:
// it independently confirmed the two known-bad rows, placing "Sacré-Cœur (Basel)"
// in Basel (stored nearest_city: Allschwil) and the Uetliberg tower in Zürich
// (stored: Stallikon).
//
// Nominatim's usage policy caps this at one request per second with an
// identifying User-Agent, which is why the whole pass is slow by design.
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastNominatimAt = 0;

async function reverseGeocode(lat, lon, zoom) {
  if (lat == null || lon == null) return null;
  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatimAt = Date.now();
  const url = `${NOMINATIM}?${new URLSearchParams({
    format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: String(zoom), addressdetails: '1',
  })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  return (await res.json())?.address || {};
}

/** The political municipality. county/state are levels ABOVE it — taking one
 *  would reintroduce exactly the "Kanton Aargau" failure the class check blocks. */
async function municipalityFromCoords(lat, lon) {
  const a = await reverseGeocode(lat, lon, 10);
  return a && (a.city || a.town || a.village || a.municipality) || null;
}

/**
 * The VILLAGE, which a municipality merger does not change.
 *
 * Swiss municipalities keep merging — Turgi into Baden, Böbikon into Zurzach,
 * both 2022 — and zoom 10 returns only the surviving municipality, so every
 * Turgi landmark came back "Baden". Zoom 14 keeps the village: measured on the
 * same coordinates it returns village=Turgi alongside town=Baden, while Baden's
 * own centre returns no village at all and correctly stays Baden.
 *
 * ONLY village and hamlet are read — they are separate settlements. suburb,
 * quarter and neighbourhood are divisions INSIDE a town and must not be used:
 * with those included every Baden landmark came back as "Allmend", a Baden
 * neighbourhood, which would have split the town into districts instead of
 * separating the merged village. city/town would just restate the municipality.
 */
async function localityFromCoords(lat, lon) {
  const a = await reverseGeocode(lat, lon, 14);
  return a && (a.village || a.hamlet) || null;
}

/** QID → { label, isMunicipality }, cached. A few hundred towns cover thousands of rows. */
async function labelsFor(qids) {
  const missing = [...new Set(qids)].filter(q => q && !labelCache.has(q));
  for (const batch of chunk(missing, 50)) {
    const j = await wd({ action: 'wbgetentities', ids: batch.join('|'), props: 'labels|claims', languages: 'de|en' });
    for (const [qid, ent] of Object.entries(j.entities || {})) {
      const l = ent.labels || {};
      const classes = (ent.claims?.P31 || [])
        .map(c => c.mainsnak?.datavalue?.value?.id)
        .filter(Boolean);
      labelCache.set(qid, {
        label: l.de?.value || l.en?.value || null,
        isMunicipality: classes.some(c => MUNICIPALITY_CLASSES.has(c)),
      });
    }
    for (const q of batch) if (!labelCache.has(q)) labelCache.set(q, { label: null, isMunicipality: false });
  }
  return labelCache;
}

/**
 * --locality: fill the village level for every row that has coordinates.
 *
 * Separate pass from the municipality one because it answers a different
 * question and covers a different set: municipality is only fetched when
 * missing, whereas locality has to be asked for EVERY row — a row whose
 * municipality resolved perfectly to "Baden" is exactly the row that might
 * really be in Turgi.
 */
async function backfillLocality(pool) {
  const rows = (await pool.query(
    `SELECT id, name, nearest_city, municipality, latitude::float8 latitude, longitude::float8 longitude
       FROM landmark_index
      WHERE latitude IS NOT NULL AND locality_updated_at IS NULL
      ORDER BY id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`)).rows;

  console.log(`${STAGING ? 'STAGING' : 'PROD'} — ${rows.length} row(s) needing locality`);
  let found = 0, none = 0, split = 0;
  for (const r of rows) {
    let loc = null;
    try { loc = await localityFromCoords(r.latitude, r.longitude); } catch { /* leave unstamped, retried next run */ continue; }
    if (loc) found++; else none++;
    // A locality that differs from the municipality is a merged village being
    // pulled back out — the whole point of this pass.
    const differs = loc && r.municipality && loc.toLowerCase() !== String(r.municipality).toLowerCase();
    if (differs) split++;
    if (DRY) {
      if (differs) console.log(`  ${r.name}\n      municipality=${r.municipality}  →  locality=${loc}`);
    } else {
      // Stamp even when nothing was found, so a landmark in a town centre with
      // no village name is not re-queried on every run.
      await query(pool, 'UPDATE landmark_index SET locality = $2, locality_updated_at = NOW() WHERE id = $1', [r.id, loc]);
    }
    if ((found + none) % 100 === 0) process.stdout.write(`  ${found + none}/${rows.length} (${split} split out)\r`);
  }
  console.log(`\n${DRY ? '[dry-run] ' : ''}locality found ${found}, none ${none}, DIFFERENT from municipality: ${split}`);
}

/**
 * Retry a write once after reconnecting.
 *
 * Nominatim's 1 req/s policy makes this a multi-hour run with a ~1.1s gap
 * between queries, and the database drops an idle client long before the end:
 * a locality pass died at row 576 of 7158 with "Connection terminated
 * unexpectedly", losing hours of pacing. pg opens a fresh connection on the
 * next query, so the only thing needed is to not treat the first failure as
 * fatal.
 */
async function query(pool, sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    if (!/terminated|ECONNRESET|timeout|Connection/i.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 2000));
    return pool.query(sql, params);
  }
}

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    // Without keepAlive the socket goes quiet between rows and gets reaped.
    keepAlive: true,
    idleTimeoutMillis: 0,
  });
  // An idle client erroring out must not take the process down mid-run.
  pool.on('error', e => console.log(`  [pool] ${e.message} — continuing`));

  if (args.includes('--locality')) {
    await backfillLocality(pool);
    await pool.end();
    return;
  }

  // A row is resolvable from EITHER source, so accept a missing qid when there
  // are coordinates to reverse-geocode instead.
  const where = ['municipality IS NULL', '(wikidata_qid IS NOT NULL OR latitude IS NOT NULL)'];
  const params = [];
  if (CITY) {
    params.push(CITY);
    where.push(`LOWER(translate(nearest_city, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns')) = LOWER(translate($1, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns'))`);
  }
  const rows = (await pool.query(
    `SELECT id, name, wikidata_qid, nearest_city, latitude::float8 latitude, longitude::float8 longitude
       FROM landmark_index WHERE ${where.join(' AND ')} ORDER BY id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`,
    params
  )).rows;

  console.log(`${STAGING ? 'STAGING' : 'PROD'} — ${rows.length} row(s) needing municipality${CITY ? ` (city=${CITY})` : ''}`);
  if (!rows.length) { await pool.end(); return; }

  let resolved = 0, unknown = 0, mismatched = 0, viaCoords = 0;
  for (const batch of chunk(rows, 50)) {
    const qids = batch.map(r => r.wikidata_qid).filter(Boolean);
    const j = qids.length
      ? await wd({ action: 'wbgetentities', ids: qids.join('|'), props: 'claims' })
      : { entities: {} };
    // Keep EVERY P131 claim, not just the first: an entity often lists both its
    // town and its canton, and the town is not reliably first.
    const pending = [];
    for (const r of batch) {
      const qids = (j.entities?.[r.wikidata_qid]?.claims?.P131 || [])
        .map(c => c.mainsnak?.datavalue?.value?.id)
        .filter(Boolean);
      pending.push({ row: r, qids });
    }
    await labelsFor(pending.flatMap(p => p.qids));

    for (const { row, qids } of pending) {
      const hit = qids.map(q => labelCache.get(q)).find(e => e?.isMunicipality && e.label);
      let label = hit?.label || null;
      let source = 'wikidata';
      if (!label) {
        label = await municipalityFromCoords(row.latitude, row.longitude);
        if (label) { source = 'coords'; viaCoords++; }
      }
      if (!label) { unknown++; continue; }
      const differs = String(label).toLowerCase() !== String(row.nearest_city || '').toLowerCase();
      if (differs) mismatched++;
      resolved++;
      if (DRY) {
        if (differs) console.log(`  ${row.name}  [${source}]\n      nearest_city=${row.nearest_city}  →  municipality=${label}`);
      } else {
        await query(pool, 'UPDATE landmark_index SET municipality = $2, municipality_updated_at = NOW() WHERE id = $1', [row.id, label]);
      }
    }
    process.stdout.write(`  resolved ${resolved}/${rows.length}\r`);
  }

  console.log(`\n${DRY ? '[dry-run] ' : ''}resolved ${resolved} (${viaCoords} via coordinates), unknown ${unknown}, DIFFERENT from nearest_city: ${mismatched}`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
