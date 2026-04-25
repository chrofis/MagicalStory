#!/usr/bin/env node
/**
 * Sanity check: authenticate against Google Ads API and print account info.
 *
 * Usage: node scripts/ads/whoami.js
 */
const { getClient } = require('./lib/client');

(async () => {
  const { api, cfg, customer } = getClient();
  if (!customer) {
    console.error('refresh_token is empty in config.json — run `node scripts/ads/authorize.js` first.');
    process.exit(1);
  }

  try {
    const accessibleRes = await api.listAccessibleCustomers(cfg.refresh_token);
    const accessible = accessibleRes.resource_names || [];
    console.log(`✅ Connected. Accessible customer accounts: ${accessible.length}`);
    for (const rn of accessible) console.log('  - ' + rn);
  } catch (e) {
    console.error('❌ listAccessibleCustomers failed:', e.message);
    if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
    process.exit(1);
  }

  try {
    const rows = await customer.query(`
      SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account
      FROM customer LIMIT 1
    `);
    const c = rows[0]?.customer;
    if (!c) { console.log('\n(customer query returned 0 rows)'); return; }
    console.log('\nAccount:');
    console.log('  id:        ' + c.id);
    console.log('  name:      ' + c.descriptive_name);
    console.log('  currency:  ' + c.currency_code);
    console.log('  timezone:  ' + c.time_zone);
    console.log('  manager:   ' + !!c.manager);
    console.log('  test:      ' + !!c.test_account);
  } catch (e) {
    console.error('❌ customer query failed:', e.message);
    if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
    process.exit(1);
  }
})();
