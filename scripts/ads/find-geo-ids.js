#!/usr/bin/env node
/**
 * One-off helper: look up Google Ads geo-target constant IDs for Swiss cities.
 *
 * Geo target constants are Google's canonical IDs for places (city = 1, region = 2, etc.).
 * We need these as integers to populate campaign-level geo targeting.
 *
 * Read-only API call (SuggestGeoTargetConstants). Free.
 *
 * Usage: node scripts/ads/find-geo-ids.js
 */
const { getClient } = require('./lib/client');

const CITIES = ['Baden', 'Aarau', 'Winterthur', 'Zürich'];
const COUNTRY = 'CH';
const LOCALE = 'de';

async function main() {
  const { customer } = getClient();
  if (!customer) {
    console.error('No refresh_token — run scripts/ads/authorize.js first.');
    process.exit(1);
  }

  // GAQL query against geo_target_constant
  for (const city of CITIES) {
    const query = `
      SELECT
        geo_target_constant.id,
        geo_target_constant.canonical_name,
        geo_target_constant.country_code,
        geo_target_constant.name,
        geo_target_constant.target_type,
        geo_target_constant.status
      FROM geo_target_constant
      WHERE geo_target_constant.country_code = '${COUNTRY}'
        AND geo_target_constant.name LIKE '${city.replace(/'/g, "''").replace('ü', 'u')}%'
        AND geo_target_constant.status = 'ENABLED'
      LIMIT 10
    `;
    let rows;
    try {
      rows = await customer.query(query);
    } catch (e) {
      console.error(`✗ ${city}:`, e.errors?.[0]?.message || e.message);
      continue;
    }
    console.log(`━━━ ${city}`);
    if (!rows.length) {
      console.log('  (no match — try suggest API)');
      continue;
    }
    rows.forEach(r => {
      const g = r.geo_target_constant;
      console.log(`  id=${g.id} | type=${g.target_type} | ${g.canonical_name}`);
    });
  }
}

main().catch(e => {
  console.error('Failed:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
