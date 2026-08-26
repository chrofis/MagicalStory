#!/usr/bin/env node
/**
 * One-off read-only helper:
 *  1. List all campaigns (id, name, status, channel)
 *  2. Resolve geo-target constant IDs for the canton + new cities we need
 *
 * Usage: node scripts/ads/inspect-and-geo.js
 */
const { getClient } = require('./lib/client');

const GEO_QUERIES = [
  'Canton of Zurich',
  'Zurich',
  'Lucerne',
  'Luzern',
  'Schaffhausen',
  'St. Gallen',
  'St Gallen',
  'Biel',
  'Bienne',
];

async function main() {
  const { customer } = getClient();
  if (!customer) { console.error('No refresh_token.'); process.exit(1); }

  console.log('━━━━━━ CAMPAIGNS ━━━━━━');
  const camps = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status,
           campaign.advertising_channel_type
    FROM campaign
    ORDER BY campaign.name
  `);
  camps.forEach(r => {
    const c = r.campaign;
    console.log(`  id=${c.id} | ${c.status} | ${c.advertising_channel_type} | ${c.name}`);
  });

  console.log('\n━━━━━━ GEO TARGETS ━━━━━━');
  for (const q of GEO_QUERIES) {
    const rows = await customer.query(`
      SELECT geo_target_constant.id, geo_target_constant.canonical_name,
             geo_target_constant.target_type, geo_target_constant.status,
             geo_target_constant.country_code
      FROM geo_target_constant
      WHERE geo_target_constant.country_code = 'CH'
        AND geo_target_constant.name LIKE '${q.replace(/'/g, "''")}%'
        AND geo_target_constant.status = 'ENABLED'
      LIMIT 8
    `);
    console.log(`\n── "${q}"`);
    if (!rows.length) { console.log('   (no match)'); continue; }
    rows.forEach(r => {
      const g = r.geo_target_constant;
      console.log(`   id=${g.id} | ${g.target_type} | ${g.canonical_name}`);
    });
  }
}

main().catch(e => {
  console.error('Failed:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
