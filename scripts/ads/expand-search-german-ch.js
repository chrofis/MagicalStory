#!/usr/bin/env node
/**
 * Search-Zurich-v1 is the only converting campaign but is rank-starved at
 * CHF 1.50/day (impression share 30%→10%, losing 80-90% to ad rank). Per user
 * 2026-06-19: raise budget to CHF 5/day and extend geo from Zürich canton only
 * to ALL German-speaking (Deutschschweiz) cantons.
 *
 * German-majority cantons (19) — includes Bern + Graubünden (German-majority),
 * EXCLUDES French/Italian-majority Fribourg, Geneva, Jura, Neuchâtel, Ticino,
 * Valais, Vaud. (FR/VS have German minorities but canton-level targeting there
 * would mostly hit French speakers.)
 *
 * Usage:
 *   node scripts/ads/expand-search-german-ch.js          # dry-run
 *   node scripts/ads/expand-search-german-ch.js --apply
 */
const { getClient } = require('./lib/client');

const APPLY = process.argv.includes('--apply');
const NEW_BUDGET_MICROS = 5_000_000; // CHF 5.00/day

// id → name, for logging. All German-speaking cantons.
const GERMAN_CANTONS = {
  20126: 'Aargau', 20127: 'Appenzell Innerrhoden', 20128: 'Appenzell Ausserrhoden',
  20129: 'Bern', 20130: 'Basel-Landschaft', 20131: 'Basel-Stadt', 20134: 'Glarus',
  20135: 'Graubünden', 20137: 'Luzern', 20139: 'Nidwalden', 20140: 'Obwalden',
  20141: 'St. Gallen', 20142: 'Schaffhausen', 20143: 'Solothurn', 20144: 'Schwyz',
  20145: 'Thurgau', 20147: 'Uri', 20150: 'Zug', 20151: 'Zürich',
};

async function main() {
  const { customer } = getClient();
  console.log(`Mode: ${APPLY ? '🔴 LIVE' : '🟡 DRY-RUN (pass --apply)'}\n`);

  // Resolve campaign + budget + existing location criteria
  const camp = await customer.query(`
    SELECT campaign.id, campaign.resource_name, campaign_budget.resource_name, campaign_budget.amount_micros
    FROM campaign WHERE campaign.name = 'Search-Deutschschweiz-v1'
  `);
  if (!camp.length) throw new Error('Search-Deutschschweiz-v1 not found');
  const campaignRn = camp[0].campaign.resource_name;
  const budgetRn = camp[0].campaign_budget.resource_name;
  const curBudget = Number(camp[0].campaign_budget.amount_micros) / 1e6;

  const existing = await customer.query(`
    SELECT campaign_criterion.location.geo_target_constant
    FROM campaign_criterion
    WHERE campaign.name = 'Search-Deutschschweiz-v1' AND campaign_criterion.type = 'LOCATION'
      AND campaign_criterion.negative = false
  `);
  const haveIds = new Set(existing.map(r =>
    Number(String(r.campaign_criterion.location.geo_target_constant).split('/')[1])));
  console.log('Already targeted:', [...haveIds].map(id => GERMAN_CANTONS[id] || id).join(', ') || '(none)');

  // Budget plan
  console.log(`\nBudget: CHF ${curBudget.toFixed(2)} → CHF ${(NEW_BUDGET_MICROS / 1e6).toFixed(2)}/day`);

  // Geo additions (skip any already present)
  const toAdd = Object.keys(GERMAN_CANTONS).map(Number).filter(id => !haveIds.has(id));
  console.log(`\nAdding ${toAdd.length} canton(s):`);
  for (const id of toAdd) console.log('  +', GERMAN_CANTONS[id], `(${id})`);

  if (!APPLY) { console.log('\n🟡 Dry run — nothing sent.'); return; }

  // 1. Budget
  await customer.campaignBudgets.update([{ resource_name: budgetRn, amount_micros: NEW_BUDGET_MICROS }]);
  console.log(`\n✅ Budget set to CHF ${(NEW_BUDGET_MICROS / 1e6).toFixed(2)}/day`);

  // 2. Geo criteria
  if (toAdd.length) {
    const ops = toAdd.map(id => ({
      campaign: campaignRn,
      location: { geo_target_constant: `geoTargetConstants/${id}` },
    }));
    await customer.campaignCriteria.create(ops);
    console.log(`✅ Added ${toAdd.length} canton location target(s)`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
