#!/usr/bin/env node
/**
 * Clean up Demand Gen orphans from failed create-demand-gen.js runs.
 *
 * Removes (REMOVED status, not hard-delete):
 *   - All campaigns starting with `DG-<city>-` for the given city (or all 3 if no --city)
 *   - All budgets starting with `DG-<city>-Budget-`
 *
 * Assets are KEPT (no cost, dedupe by content hash on next upload).
 *
 * Usage:
 *   node scripts/ads/cleanup-orphans.js                 # all 3 cities
 *   node scripts/ads/cleanup-orphans.js --city=baden    # one city only
 *   node scripts/ads/cleanup-orphans.js --dry-run       # preview, no deletes
 */
const { getClient } = require('./lib/client');
const { CITIES } = require('./lib/campaign-config');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const ONLY_CITY = (args.city || '').toLowerCase();
const DRY_RUN = args['dry-run'] === 'true';

async function main() {
  const { customer } = getClient();
  const cities = ONLY_CITY ? [ONLY_CITY] : Object.keys(CITIES);
  console.log(`Cleaning up orphans for: ${cities.join(', ')} (${DRY_RUN ? 'dry-run' : 'live delete'})\n`);

  for (const cityKey of cities) {
    const city = CITIES[cityKey];
    if (!city) continue;
    const prefix = city.campaignName.replace(/-v\d+$/, '');           // "DG-Baden-Demand-Gen"
    const budgetPrefix = city.budgetName.replace(/-v\d+$/, '');        // "DG-Baden-Budget"

    // Find campaigns
    const camps = await customer.query(`
      SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status
      FROM campaign
      WHERE campaign.name LIKE '${prefix}%' AND campaign.status != 'REMOVED'
    `);
    console.log(`━━━ ${city.label}: ${camps.length} campaign(s) match "${prefix}%"`);
    for (const r of camps) console.log(`  - ${r.campaign.id}: ${r.campaign.name} (${r.campaign.status})`);

    if (camps.length && !DRY_RUN) {
      const ops = camps.map(r => r.campaign.resource_name);
      await customer.campaigns.remove(ops);
      console.log(`  ✓ removed ${ops.length} campaign(s)`);
    }

    // Find budgets (must be done after campaign removal — campaigns reference budgets)
    const budgets = await customer.query(`
      SELECT campaign_budget.resource_name, campaign_budget.id, campaign_budget.name
      FROM campaign_budget
      WHERE campaign_budget.name LIKE '${budgetPrefix}%'
        AND campaign_budget.status != 'REMOVED'
    `);
    console.log(`  ${budgets.length} budget(s) match "${budgetPrefix}%"`);
    for (const r of budgets) console.log(`    - ${r.campaign_budget.id}: ${r.campaign_budget.name}`);

    if (budgets.length && !DRY_RUN) {
      const ops = budgets.map(r => r.campaign_budget.resource_name);
      try {
        await customer.campaignBudgets.remove(ops);
        console.log(`  ✓ removed ${ops.length} budget(s)`);
      } catch (e) {
        console.error(`  ✗ budget remove failed: ${e.message}`);
        if (e.errors) console.error('    ' + JSON.stringify(e.errors[0]));
      }
    }
    console.log();
  }
}

main().catch(e => {
  console.error('❌ Failed:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
