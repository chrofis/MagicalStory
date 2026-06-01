#!/usr/bin/env node
/**
 * Compare `server/data/swiss-cities.json` (catalog of 100 Swiss cities used
 * by the frontend and the story-generation pipeline) against the hardcoded
 * SWISS_CITIES list in `server/lib/landmarkPhotos.js` (used to drive the
 * Wikipedia-geosearch indexer).
 *
 * Output: which cities are in one but not the other, what's currently
 * indexed in landmark_index per city, and a recommended action list.
 *
 * Read-only — does NOT write to DB. Generates a markdown report that
 * feeds the reindex-missing-cities.js script.
 *
 * Usage: node scripts/admin/sync-swiss-cities.js
 *
 * Decision context: docs/decisions.md → "landmark_index audit + reindex"
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CATALOG_PATH = path.join(__dirname, '../../server/data/swiss-cities.json');
const INDEXER_PATH = path.join(__dirname, '../../server/lib/landmarkPhotos.js');

function loadCatalog() {
  const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  // Each entry: { id, name: { de, en, fr, it }, canton, lat, lon, lang }
  return raw.cities;
}

function loadIndexerCities() {
  // Pull the SWISS_CITIES array from the source file. We avoid `require()`ing
  // landmarkPhotos.js because it pulls in heavy deps; parsing the array
  // declaration is reliable and fast.
  const src = fs.readFileSync(INDEXER_PATH, 'utf8');
  const m = src.match(/const SWISS_CITIES = \[([\s\S]*?)\];/);
  if (!m) throw new Error('Could not locate SWISS_CITIES in landmarkPhotos.js');
  // Extract each city: 'Zürich' from { city: 'Zürich', ... }
  const cities = [];
  const cityRe = /city:\s*'([^']+)'/g;
  let cm;
  while ((cm = cityRe.exec(m[1])) !== null) cities.push(cm[1]);
  return cities;
}

function canonicalName(city) {
  // Local-language name = city.name[city.lang]. Fall back to .de when lang
  // not set. This is what nearest_city in landmark_index SHOULD be.
  const lang = city.lang || 'de';
  return city.name[lang] || city.name.de;
}

async function main() {
  const catalog = loadCatalog();
  const indexerList = loadIndexerCities();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  console.log('━━━ SWISS CITIES SYNC AUDIT ━━━\n');
  console.log(`  Catalog (swiss-cities.json):      ${catalog.length}`);
  console.log(`  Indexer SWISS_CITIES (landmarkPhotos.js): ${indexerList.length}`);

  // 1. Catalog cities NOT in indexer list
  const indexerSet = new Set(indexerList.map(s => s.toLowerCase()));
  const matchesIndexer = (canon) => {
    const lc = canon.toLowerCase();
    // Direct or substring match (e.g. 'Biel/Bienne' ↔ 'Biel')
    return [...indexerSet].some(c => c === lc || c.includes(lc) || lc.includes(c));
  };
  const missingFromIndexer = catalog.filter(c => !matchesIndexer(canonicalName(c)));

  console.log(`\n━━━ Cities in catalog but NOT in indexer SWISS_CITIES (${missingFromIndexer.length}) ━━━`);
  for (const c of missingFromIndexer) {
    console.log(`  - ${canonicalName(c)} (${c.lang || 'de'}, canton ${c.canton})`);
  }

  // 2. Indexer cities NOT in catalog
  const catalogNames = new Set(catalog.flatMap(c => [c.name.de, c.name.en, c.name.fr, c.name.it].filter(Boolean).map(n => n.toLowerCase())));
  const orphansInIndexer = indexerList.filter(s => !catalogNames.has(s.toLowerCase()));
  console.log(`\n━━━ Cities in indexer SWISS_CITIES but NOT in catalog (${orphansInIndexer.length}) ━━━`);
  for (const s of orphansInIndexer) console.log(`  - ${s}`);

  // 3. landmark_index coverage by catalog city
  console.log(`\n━━━ Per-catalog-city landmark coverage ━━━`);
  const stats = { empty: [], low: [], ok: [], rich: [] };
  for (const city of catalog) {
    const variants = [city.name.de, city.name.en, city.name.fr, city.name.it].filter(Boolean);
    const r = await pool.query(
      'SELECT COUNT(*) AS n FROM landmark_index WHERE nearest_city = ANY($1) AND photo_url IS NOT NULL',
      [variants]
    );
    const n = parseInt(r.rows[0].n, 10);
    const bucket = n === 0 ? 'empty' : n < 5 ? 'low' : n < 20 ? 'ok' : 'rich';
    stats[bucket].push({ city: canonicalName(city), n, lang: city.lang || 'de', canton: city.canton });
  }
  console.log(`  zero landmarks: ${stats.empty.length}`);
  console.log(`  1-4 landmarks:  ${stats.low.length}`);
  console.log(`  5-19 landmarks: ${stats.ok.length}`);
  console.log(`  20+ landmarks:  ${stats.rich.length}`);

  // 4. Recommended actions
  console.log(`\n━━━ RECOMMENDED ACTIONS ━━━`);
  console.log(`  1. Add ${missingFromIndexer.length} cities to SWISS_CITIES (or replace it with catalog-driven list).`);
  console.log(`  2. Run reindex-missing-cities.js for ${stats.empty.length} empty + ${stats.low.length} low-coverage cities.`);
  console.log(`  3. Run canonicalize-landmark-names.js to rename ${stats.ok.length + stats.rich.length} covered cities' entries.`);

  // 5. Write the empty/low list as JSON for the reindex script to consume
  const targetsPath = path.join(__dirname, 'reindex-targets.json');
  const targets = {
    generatedAt: new Date().toISOString(),
    cities: [...stats.empty, ...stats.low].map(s => {
      const cat = catalog.find(c => canonicalName(c) === s.city);
      return {
        canonicalName: s.city,
        lang: s.lang,
        canton: s.canton,
        nameVariants: cat ? [cat.name.de, cat.name.en, cat.name.fr, cat.name.it].filter(Boolean) : [s.city],
        lat: cat?.lat,
        lon: cat?.lon,
        currentLandmarkCount: s.n,
      };
    }),
  };
  fs.writeFileSync(targetsPath, JSON.stringify(targets, null, 2));
  console.log(`\n  ✓ Wrote ${targets.cities.length} reindex targets to ${path.relative(process.cwd(), targetsPath)}`);

  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
