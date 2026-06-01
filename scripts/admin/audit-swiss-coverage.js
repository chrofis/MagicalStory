#!/usr/bin/env node
/**
 * Coverage audit after broad indexing completes. Two cuts:
 *
 *   1. swiss-cities.json (100 cities, our SEO catalog) — which still
 *      lack any indexed entry? These are the cities most likely to
 *      have public landing pages, so any miss here is user-facing.
 *
 *   2. Google Ads CH catalog (~1,439 cities + municipalities) — which
 *      are missing? These are the broader pool for future ad targeting.
 *
 * For each missing city, suggests why (no Wikipedia page, no
 * pageimage, alternate Wikipedia title, etc.) so the iconic-fill
 * approach knows what to manually add.
 *
 * Usage: node scripts/admin/audit-swiss-coverage.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { getClient } = require('../ads/lib/client');

const SUFFIXES = ['(Stadt)', '(ville)', '(città)'];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // ─── Cut 1: swiss-cities.json catalog ─────────────────────────────────
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../../server/data/swiss-cities.json'), 'utf8')).cities;
  let cat_covered = 0;
  const cat_missing = [];
  for (const c of catalog) {
    const variants = [c.name.de, c.name.en, c.name.fr, c.name.it].filter(Boolean);
    const synthNames = variants.flatMap(v => SUFFIXES.map(s => `${v} ${s}`));
    // Match either by synthetic name or by nearest_city = any variant
    const r = await pool.query(
      `SELECT COUNT(*) AS n
         FROM landmark_index
        WHERE photo_url IS NOT NULL
          AND (name = ANY($1) OR nearest_city = ANY($2))`,
      [synthNames, variants]
    );
    if (parseInt(r.rows[0].n, 10) > 0) cat_covered++;
    else cat_missing.push({ city: c.name.de, lang: c.lang || 'de', canton: c.canton });
  }

  console.log('━━━ swiss-cities.json catalog (100 cities) ━━━');
  console.log(`  Covered: ${cat_covered} / ${catalog.length}`);
  console.log(`  Missing: ${cat_missing.length}`);
  if (cat_missing.length > 0) {
    console.log('\n  Still missing:');
    for (const m of cat_missing) console.log(`    - ${m.city} (${m.lang}, ${m.canton})`);
  }

  // ─── Cut 2: Google Ads catalog ────────────────────────────────────────
  console.log('\n━━━ Google Ads CH catalog (City + Municipality) ━━━');
  const { customer } = getClient();
  const ads = await customer.query(`
    SELECT geo_target_constant.name, geo_target_constant.canonical_name
    FROM geo_target_constant
    WHERE geo_target_constant.country_code = 'CH'
      AND geo_target_constant.target_type IN ('City', 'Municipality')
      AND geo_target_constant.status = 'ENABLED'
    LIMIT 5000
  `);
  console.log(`  Google catalog: ${ads.length} entries`);

  let ads_covered = 0;
  const ads_missing = [];
  for (const a of ads) {
    const name = a.geo_target_constant.name;
    const synthNames = SUFFIXES.map(s => `${name} ${s}`);
    const r = await pool.query(
      `SELECT COUNT(*) AS n
         FROM landmark_index
        WHERE photo_url IS NOT NULL
          AND (name = ANY($1) OR nearest_city = $2)`,
      [synthNames, name]
    );
    if (parseInt(r.rows[0].n, 10) > 0) ads_covered++;
    else ads_missing.push(name);
  }
  console.log(`  Covered: ${ads_covered} / ${ads.length}`);
  console.log(`  Missing: ${ads_missing.length}`);

  // Save the missing list for later batching
  const out = path.join(__dirname, 'coverage-misses.json');
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    catalog_missing: cat_missing,
    ads_missing: ads_missing,
    summary: {
      catalog: { total: catalog.length, covered: cat_covered, missing: cat_missing.length },
      ads:     { total: ads.length, covered: ads_covered, missing: ads_missing.length },
    },
  }, null, 2));
  console.log(`\n  ✓ Wrote ${path.relative(process.cwd(), out)}`);

  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
