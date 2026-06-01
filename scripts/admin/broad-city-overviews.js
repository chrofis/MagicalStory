#!/usr/bin/env node
/**
 * Broad-coverage city overview fetcher. For every Swiss city in Google's
 * Ads geo-target catalog (~851 CITY entries), upsert ONE row into
 * landmark_index with a "<City> (Stadt|ville|città)" name and the main
 * Wikipedia article photo as the overview/aerial.
 *
 * Why this exists:
 *   - swiss-cities.json has 100 catalog entries; Google Ads has 851
 *     targetable Swiss cities. Most of the gap is small towns that
 *     never had iconic landmarks, but we DO want a basic photo for them
 *     so creative generation can later use the city as a setting for a
 *     story (even if it's just the aerial view).
 *   - Zero Gemini calls (we know overviews are 'distant' by definition),
 *     so this is essentially free — leaves the $5 budget intact for
 *     targeted per-landmark classification later.
 *
 * Strategy:
 *   1. Fetch all 851 CH-CITY geo_target_constants from Google Ads.
 *   2. For each, derive a canton + likely Wikipedia language (DE / FR / IT)
 *      from the canonical_name's structure ("City, Canton, Switzerland").
 *   3. Lookup Wikipedia in the city's primary language; fall back to DE.
 *   4. Extract main pageimage; insert into landmark_index.
 *
 * Usage:
 *   node scripts/admin/broad-city-overviews.js              # dry-run
 *   node scripts/admin/broad-city-overviews.js --push       # write
 *   node scripts/admin/broad-city-overviews.js --max=50 --push
 *
 * Decision context: docs/decisions.md → "broad-city coverage"
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');
const { getClient } = require('../ads/lib/client');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const PUSH = args.push === 'true';
const MAX_CITIES = args.max ? parseInt(args.max, 10) : Infinity;

// French-speaking Swiss cantons (Romandy)
const FR_CANTONS = new Set(['Genève','Geneva','Vaud','Neuchâtel','Neuchatel','Jura','Fribourg','Friburgo','Valais']);
const IT_CANTONS = new Set(['Ticino','Tessin']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchSwissCitiesFromAds() {
  const { customer } = getClient();
  const rows = await customer.query(`
    SELECT geo_target_constant.id, geo_target_constant.name,
           geo_target_constant.canonical_name, geo_target_constant.target_type
    FROM geo_target_constant
    WHERE geo_target_constant.country_code = 'CH'
      AND geo_target_constant.target_type IN ('City', 'Municipality')
      AND geo_target_constant.status = 'ENABLED'
    LIMIT 5000
  `);
  return rows.map(r => {
    const c = r.geo_target_constant;
    // canonical_name is like "Bern,Bern,Switzerland" or "Genève,Geneva,Switzerland"
    const parts = (c.canonical_name || '').split(',').map(s => s.trim());
    const canton = parts[1] || null;
    let lang = 'de';
    if (FR_CANTONS.has(canton)) lang = 'fr';
    else if (IT_CANTONS.has(canton)) lang = 'it';
    return { id: c.id, name: c.name, canton, lang, canonicalName: c.canonical_name };
  });
}

async function fetchCityOverview(cityName, lang) {
  const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: 'query', titles: cityName,
    prop: 'pageimages|coordinates|extracts|pageprops',
    piprop: 'original', pithumbsize: '1600',
    exintro: 'true', explaintext: 'true',
    coprimary: 'primary', format: 'json', formatversion: '2', origin: '*',
  });
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'MagicalStory broad-coverage/1.0 (info@magicalstory.ch)' } });
  } catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  const page = data?.query?.pages?.[0];
  if (!page || page.missing || !page.original?.source) return null;
  return {
    pageid: page.pageid,
    wikidata: page.pageprops?.wikibase_item || null,
    title: page.title,
    photoUrl: page.original.source,
    photoDescription: (page.extract || '').slice(0, 600),
    lat: page.coordinates?.[0]?.lat ?? null,
    lon: page.coordinates?.[0]?.lon ?? null,
  };
}

async function upsertOverview(pool, city, overview) {
  const synthSuffix = { de: '(Stadt)', fr: '(ville)', it: '(città)' }[city.lang] || '(Stadt)';
  const synthName = `${city.name} ${synthSuffix}`;

  const exists = await pool.query(
    `SELECT id, photo_url FROM landmark_index WHERE name = $1 OR (wikidata_qid IS NOT NULL AND wikidata_qid = $2) LIMIT 1`,
    [synthName, overview.wikidata]
  );

  if (exists.rowCount > 0) {
    const row = exists.rows[0];
    if (PUSH && !row.photo_url) {
      await pool.query(
        `UPDATE landmark_index
           SET photo_url = $1, photo_description = $2,
               nearest_city = COALESCE(nearest_city, $3),
               photo_type = COALESCE(photo_type, 'distant'),
               updated_at = NOW()
         WHERE id = $4`,
        [overview.photoUrl, overview.photoDescription, city.name, row.id]
      );
      return 'updated';
    }
    return 'exists';
  }

  if (PUSH) {
    await pool.query(
      `INSERT INTO landmark_index
        (name, wikipedia_page_id, wikidata_qid, lang, latitude, longitude,
         nearest_city, country, photo_url, photo_description, photo_source,
         photo_type, type, score, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Switzerland',$8,$9,'wikipedia',
               'distant','City','40',NOW(),NOW())`,
      [synthName, overview.pageid, overview.wikidata, city.lang,
       overview.lat, overview.lon, city.name,
       overview.photoUrl, overview.photoDescription]
    );
  }
  return 'added';
}

async function main() {
  console.log(PUSH ? '⚠️  PUSH MODE — writes to DB' : 'DRY-RUN — no writes');
  console.log('Fetching Swiss cities from Google Ads catalog…');
  const cities = await fetchSwissCitiesFromAds();
  console.log(`  ${cities.length} CH cities/municipalities in Google's targeting catalog\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const targets = cities.slice(0, MAX_CITIES);

  let added = 0, updated = 0, exists = 0, missing = 0;
  for (let i = 0; i < targets.length; i++) {
    const city = targets[i];
    if ((i + 1) % 25 === 0 || i < 3) {
      console.log(`  [${i+1}/${targets.length}] ${city.name} (${city.lang}, ${city.canton})`);
    }

    // Try primary lang first, then DE as fallback
    const langs = [city.lang, 'de'].filter((v, idx, arr) => arr.indexOf(v) === idx);
    let overview = null;
    for (const lang of langs) {
      overview = await fetchCityOverview(city.name, lang);
      if (overview) { city.lang = lang; break; }
      await sleep(50);
    }

    if (!overview) {
      missing++;
      continue;
    }

    const action = await upsertOverview(pool, city, overview);
    if (action === 'added') added++;
    else if (action === 'updated') updated++;
    else exists++;

    // Throttle Wikipedia API politely
    await sleep(120);
  }

  console.log(`\n━━━ SUMMARY ━━━`);
  console.log(`  ${PUSH ? 'Added' : 'Would add'}:   ${added}`);
  console.log(`  ${PUSH ? 'Updated' : 'Would update'}: ${updated}`);
  console.log(`  Already covered:  ${exists}`);
  console.log(`  No Wikipedia page or no main image: ${missing}`);
  console.log(`  Total Gemini calls: 0  (cost: $0.00)`);
  if (!PUSH) console.log(`\n  Re-run with --push to write to DB.`);

  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
