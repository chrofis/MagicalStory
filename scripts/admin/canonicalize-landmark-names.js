#!/usr/bin/env node
/**
 * Two-pass cleanup of landmark_index:
 *
 *   PASS 1 — purge non-Swiss leakage. Some past indexer runs left
 *   ~280 rows tagged country = 'United States' / 'Germany' / 'Japan' /
 *   'England' etc. (likely from a debug/test run with the wrong city
 *   list). These are unreachable from the Swiss content pipeline and
 *   take up space.
 *
 *   PASS 2 — rename Swiss landmarks to the canonical local-language
 *   Wikipedia title. Looks up each landmark's Wikidata QID, fetches
 *   that QID's sitelinks across language Wikipedias, and picks the
 *   title matching the city's primary language (DE/FR/IT) per
 *   swiss-cities.json. Fixes the cross-language drift bug:
 *     "Palais fédéral" → "Bundeshaus (Bern)"
 *     "Cathédrale de Bâle" → "Basler Münster"
 *     "Kathedrale Notre-Dame (Lausanne)" → "Cathédrale de Lausanne"
 *
 * Defaults to DRY-RUN. Pass --push to actually mutate the DB.
 *
 * Usage:
 *   node scripts/admin/canonicalize-landmark-names.js              # preview
 *   node scripts/admin/canonicalize-landmark-names.js --push       # apply
 *   node scripts/admin/canonicalize-landmark-names.js --skip-purge --push
 *     (rename only, don't delete the non-Swiss rows)
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
// Purge defaults to SKIPPED — keeping non-Swiss landmarks for future
// multi-market expansion (Swiss user wanting a Paris-set story, etc.).
// Pass --purge=true to actually delete them.
const SKIP_PURGE = args.purge !== 'true';
const SKIP_RENAME = args['skip-rename'] === 'true';

// Map every catalog city's nearest_city variants → primary language.
function buildCityLangMap() {
  const cities = JSON.parse(fs.readFileSync(path.join(__dirname, '../../server/data/swiss-cities.json'), 'utf8')).cities;
  const m = new Map();
  for (const c of cities) {
    const lang = c.lang || 'de';
    for (const v of [c.name.de, c.name.en, c.name.fr, c.name.it]) {
      if (v) m.set(v, lang);
    }
  }
  return m;
}

async function fetchCanonicalName(wikidataQid, targetLang) {
  if (!wikidataQid) return null;
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${wikidataQid}.json`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'MagicalStory canonicalize/1.0 (info@magicalstory.ch)' } });
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  const entity = data?.entities?.[wikidataQid];
  const sitelinks = entity?.sitelinks || {};
  const siteKey = `${targetLang}wiki`;
  return sitelinks[siteKey]?.title || null;
}

async function pass1_purgeNonSwiss(pool) {
  console.log('\n━━━ PASS 1 — purge non-Swiss leakage ━━━');
  const rows = await pool.query(
    `SELECT id, name, nearest_city, country FROM landmark_index WHERE country IS DISTINCT FROM 'Switzerland'`
  );
  console.log(`  Found ${rows.rowCount} non-Swiss rows`);
  if (rows.rowCount === 0) return;

  const sample = rows.rows.slice(0, 8);
  console.log(`  Sample to be ${PUSH ? 'DELETED' : 'flagged'}:`);
  for (const r of sample) console.log(`    [${r.country}] ${r.name} (${r.nearest_city})`);
  if (rows.rowCount > 8) console.log(`    ... + ${rows.rowCount - 8} more`);

  if (!PUSH) {
    console.log(`  [dry-run] would delete ${rows.rowCount} rows`);
    return;
  }
  const del = await pool.query(`DELETE FROM landmark_index WHERE country IS DISTINCT FROM 'Switzerland'`);
  console.log(`  ✓ deleted ${del.rowCount} rows`);
}

async function pass2_rename(pool, cityLangMap) {
  console.log('\n━━━ PASS 2 — rename to canonical local language ━━━');
  const rows = await pool.query(
    `SELECT id, name, nearest_city, wikidata_qid, lang
       FROM landmark_index
      WHERE wikidata_qid IS NOT NULL
        AND country = 'Switzerland'
        AND nearest_city IS NOT NULL
      ORDER BY nearest_city, name`
  );
  console.log(`  Inspecting ${rows.rowCount} landmarks with QIDs…`);

  let renamed = 0, skipped = 0, noLang = 0, noTitle = 0, clashes = 0;
  for (const r of rows.rows) {
    const targetLang = cityLangMap.get(r.nearest_city);
    if (!targetLang) {
      // nearest_city not in our catalog (e.g. 'Bremgarten', 'Wettingen' — towns we don't manage).
      // Default to 'de' for these (most are German-speaking AG/ZH/BE towns).
      noLang++;
      continue;
    }
    const canonical = await fetchCanonicalName(r.wikidata_qid, targetLang);
    if (!canonical) { noTitle++; continue; }
    if (canonical === r.name) { skipped++; continue; }

    // Check for clash: another row already has the canonical name
    const clash = await pool.query(
      `SELECT id FROM landmark_index WHERE name = $1 AND id != $2 LIMIT 1`,
      [canonical, r.id]
    );
    if (clash.rowCount > 0) {
      console.log(`  ⚠ clash: "${r.name}" → "${canonical}" — target name already taken, skipping`);
      clashes++;
      continue;
    }

    if (PUSH) {
      await pool.query(
        `UPDATE landmark_index SET name = $1, lang = COALESCE(lang, $2), updated_at = NOW() WHERE id = $3`,
        [canonical, targetLang, r.id]
      );
      renamed++;
      if (renamed <= 20 || renamed % 50 === 0) {
        console.log(`  ✓ "${r.name}" → "${canonical}" [${r.nearest_city}, ${targetLang}]`);
      }
    } else {
      renamed++;
      if (renamed <= 20) {
        console.log(`  ~ would rename "${r.name}" → "${canonical}" [${r.nearest_city}, ${targetLang}]`);
      }
    }
  }
  console.log('\n  Summary:');
  console.log(`    ${PUSH ? 'Renamed' : 'Would rename'}: ${renamed}`);
  console.log(`    Already canonical:    ${skipped}`);
  console.log(`    No catalog match:     ${noLang}  (left untouched — small towns outside swiss-cities.json)`);
  console.log(`    No QID/Wikidata data: ${noTitle}`);
  console.log(`    Name clashes:         ${clashes}`);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cityLangMap = buildCityLangMap();
  console.log(PUSH ? '⚠️  PUSH MODE — writes to DB' : 'DRY-RUN — no writes');

  if (!SKIP_PURGE) await pass1_purgeNonSwiss(pool);
  if (!SKIP_RENAME) await pass2_rename(pool, cityLangMap);

  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
