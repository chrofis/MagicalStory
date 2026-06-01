#!/usr/bin/env node
/**
 * Second-pass fill for cities that broad-city-overviews.js missed.
 *
 * Reads coverage-misses.json (output of audit-swiss-coverage.js) and
 * tries alternate Wikipedia title forms for each missing city:
 *
 *   1. "<City> (Gemeinde)" / "<City> (commune)" / "<City> (comune)"
 *      — Wikipedia's standard disambiguator for Swiss municipalities
 *   2. "<City>, Switzerland"
 *   3. "<City> <Canton>"        (e.g. "Bauma ZH")
 *   4. "<City>, <Canton>"       (e.g. "Bauma, Zürich")
 *
 * For each city, the first variant that resolves to a Wikipedia page
 * with a main photo wins. Same heuristic, just more permissive on the
 * title.
 *
 * Usage:
 *   node scripts/admin/broad-city-overviews-fallback.js              # dry-run
 *   node scripts/admin/broad-city-overviews-fallback.js --push       # write
 *
 * Run order:
 *   1. broad-city-overviews.js --push           (first pass)
 *   2. audit-swiss-coverage.js                  (find misses)
 *   3. broad-city-overviews-fallback.js --push  (this script — second pass)
 *   4. audit-swiss-coverage.js                  (final check)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const PUSH = args.push === 'true';

// Map canton names → Wikipedia abbreviations used in disambiguated titles
const CANTON_ABBR = {
  Aargau: 'AG', 'Appenzell Innerrhoden': 'AI', 'Appenzell Ausserrhoden': 'AR',
  Bern: 'BE', 'Basel-Landschaft': 'BL', 'Basel-Stadt': 'BS',
  Fribourg: 'FR', 'Friburgo': 'FR', Geneva: 'GE', Glarus: 'GL', Graubünden: 'GR', 'Grigioni': 'GR',
  Jura: 'JU', Luzern: 'LU', Neuchâtel: 'NE', Nidwalden: 'NW', Obwalden: 'OW',
  'Sankt Gallen': 'SG', 'St. Gallen': 'SG', Schaffhausen: 'SH', Solothurn: 'SO',
  Schwyz: 'SZ', Thurgau: 'TG', Ticino: 'TI', Uri: 'UR', Vaud: 'VD',
  Valais: 'VS', Wallis: 'VS', Zug: 'ZG', Zürich: 'ZH', Zurich: 'ZH',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchPage(title, lang) {
  const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: 'query', titles: title,
    prop: 'pageimages|coordinates|extracts|pageprops',
    piprop: 'original', pithumbsize: '1600',
    exintro: 'true', explaintext: 'true',
    coprimary: 'primary', format: 'json', formatversion: '2', origin: '*',
  });
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': 'MagicalStory fallback-coverage/1.0 (info@magicalstory.ch)' } }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
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

// Generate alternate title forms for a given Google-Ads city
function alternateTitles(cityName, lang) {
  const suffix = { de: 'Gemeinde', fr: 'commune', it: 'comune' }[lang] || 'Gemeinde';
  return [
    cityName,
    `${cityName} (${suffix})`,
    `${cityName}, Switzerland`,
  ];
}

async function tryFindPage(cityName, lang) {
  const langs = [lang, 'de'].filter((v, idx, arr) => arr.indexOf(v) === idx);
  for (const l of langs) {
    for (const title of alternateTitles(cityName, l)) {
      const p = await fetchPage(title, l);
      if (p) return { lang: l, ...p };
      await sleep(80);
    }
  }
  return null;
}

async function main() {
  const missPath = path.join(__dirname, 'coverage-misses.json');
  if (!fs.existsSync(missPath)) {
    console.error('Missing coverage-misses.json — run audit-swiss-coverage.js first.');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(missPath, 'utf8'));
  // Run for the union of catalog-misses + ads-misses (deduplicated)
  const allMissing = new Set();
  for (const m of data.catalog_missing || []) allMissing.add(m.city);
  for (const m of data.ads_missing || []) allMissing.add(m);
  const targets = [...allMissing];

  console.log(PUSH ? '⚠️  PUSH MODE — writes to DB' : 'DRY-RUN — no writes');
  console.log(`Trying alternate Wikipedia titles for ${targets.length} missing cities…\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let found = 0, stillMissing = 0;
  const stillMissingList = [];

  for (let i = 0; i < targets.length; i++) {
    const cityName = targets[i];
    if (i % 25 === 0) console.log(`  [${i+1}/${targets.length}] ${cityName}`);
    // Default to DE; ideally we'd look up the canton, but for many small towns
    // it's not in our catalog, so DE is a safe default for Swiss-German Switzerland.
    const result = await tryFindPage(cityName, 'de');
    if (!result) { stillMissing++; stillMissingList.push(cityName); continue; }
    found++;

    const synthName = `${cityName} (Stadt)`;
    const exists = await pool.query(
      `SELECT id FROM landmark_index WHERE name = $1 OR (wikidata_qid IS NOT NULL AND wikidata_qid = $2) LIMIT 1`,
      [synthName, result.wikidata]
    );
    if (exists.rowCount > 0) continue;
    if (PUSH) {
      await pool.query(
        `INSERT INTO landmark_index
           (name, wikipedia_page_id, wikidata_qid, lang, latitude, longitude,
            nearest_city, country, photo_url, photo_description, photo_source,
            photo_type, type, score, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Switzerland',$8,$9,'wikipedia',
                 'distant','City','40',NOW(),NOW())`,
        [synthName, result.pageid, result.wikidata, result.lang,
         result.lat, result.lon, cityName,
         result.photoUrl, result.photoDescription]
      );
    }
  }

  console.log(`\n━━━ SUMMARY ━━━`);
  console.log(`  ${PUSH ? 'Found + added' : 'Would add'}: ${found}`);
  console.log(`  Still missing:    ${stillMissing}`);
  if (stillMissingList.length > 0 && stillMissingList.length < 50) {
    console.log('\n  Still missing after fallback:');
    for (const c of stillMissingList) console.log('    -', c);
  }
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
