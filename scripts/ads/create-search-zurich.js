#!/usr/bin/env node
/**
 * Create the PAUSED Zürich Search campaign with 3 ad groups + RSA per group.
 *
 *   Budget: CHF 3/day, MAXIMIZE_CLICKS bidding, CHF 0.50 CPC ceiling
 *   Geo: Zürich city (1003297) | Language: German (1001)
 *   3 ad groups: local-product / gift / feature intent clusters
 *   Each ad group: keyword set + 1 Responsive Search Ad (RSA)
 *
 * Usage:
 *   node scripts/ads/create-search-zurich.js --dry-run
 *   node scripts/ads/create-search-zurich.js               # live create (PAUSED)
 */

const { getClient } = require('./lib/client');
const { COPY, ZURICH_SEARCH, buildFinalUrl } = require('./lib/campaign-config');
const { enums, ResourceNames } = require('google-ads-api');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const DRY_RUN = args['dry-run'] === 'true';

async function createBudget(customer) {
  const op = {
    name: ZURICH_SEARCH.budgetName,
    amount_micros: ZURICH_SEARCH.dailyBudgetMicros,
    delivery_method: enums.BudgetDeliveryMethod.STANDARD,
    explicitly_shared: false,
  };
  if (DRY_RUN) { console.log(`  [DRY] budget: ${op.name} = ${op.amount_micros/1e6} CHF/day`); return `[DRY] budget/${op.name}`; }
  const res = await customer.campaignBudgets.create([op]);
  console.log(`  ✓ budget: ${res.results[0].resource_name}`);
  return res.results[0].resource_name;
}

async function createCampaign(customer, budgetRn) {
  const op = {
    name: ZURICH_SEARCH.campaignName,
    status: enums.CampaignStatus.PAUSED,
    advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
    campaign_budget: budgetRn,
    bidding_strategy_type: enums.BiddingStrategyType[ZURICH_SEARCH.biddingStrategyType],
    target_spend: {
      cpc_bid_ceiling_micros: ZURICH_SEARCH.cpcBidCeilingMicros,
    },
    network_settings: {
      target_google_search: true,
      target_search_network: true,    // Google partners
      target_content_network: false,  // No Display
      target_partner_search_network: false,
    },
    contains_eu_political_advertising: ZURICH_SEARCH.containsEuPoliticalAdvertising
      ? enums.EuPoliticalAdvertisingStatus.CONTAINS_EU_POLITICAL_ADVERTISING
      : enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
  };
  if (DRY_RUN) {
    console.log(`  [DRY] campaign: ${op.name} (PAUSED, SEARCH, ${ZURICH_SEARCH.biddingStrategyType}, cap CHF ${ZURICH_SEARCH.cpcBidCeilingMicros/1e6}/click)`);
    return `[DRY] campaign/${op.name}`;
  }
  const res = await customer.campaigns.create([op]);
  console.log(`  ✓ campaign: ${res.results[0].resource_name}`);
  return res.results[0].resource_name;
}

async function addCriteria(customer, campaignRn) {
  const geoRn = ResourceNames.geoTargetConstant(ZURICH_SEARCH.geoTargetId);
  const langRn = ResourceNames.languageConstant(ZURICH_SEARCH.languageConstantId);
  const ops = [
    { campaign: campaignRn, negative: false, location: { geo_target_constant: geoRn } },
    { campaign: campaignRn, negative: false, language: { language_constant: langRn } },
  ];
  if (DRY_RUN) { console.log(`  [DRY] geo: ${geoRn} | language: ${langRn}`); return; }
  const res = await customer.campaignCriteria.create(ops);
  console.log(`  ✓ criteria added (${res.results.length})`);
}

async function createAdGroup(customer, campaignRn, agConfig) {
  const op = {
    name: agConfig.name,
    campaign: campaignRn,
    status: enums.AdGroupStatus.PAUSED,
    type: enums.AdGroupType.SEARCH_STANDARD,
    cpc_bid_micros: ZURICH_SEARCH.cpcBidCeilingMicros, // anchor at the ceiling
  };
  if (DRY_RUN) { console.log(`    [DRY] ad group: ${op.name}`); return `[DRY] adGroup/${op.name}`; }
  const res = await customer.adGroups.create([op]);
  console.log(`    ✓ ad group: ${res.results[0].resource_name}`);
  return res.results[0].resource_name;
}

async function addKeywords(customer, adGroupRn, keywords) {
  const ops = keywords.map(kw => ({
    ad_group: adGroupRn,
    status: enums.AdGroupCriterionStatus.ENABLED,
    keyword: {
      text: kw.text,
      match_type: enums.KeywordMatchType[kw.matchType],
    },
  }));
  if (DRY_RUN) {
    keywords.forEach(kw => console.log(`      [DRY] keyword: [${kw.matchType}] "${kw.text}"`));
    return;
  }
  const res = await customer.adGroupCriteria.create(ops);
  console.log(`      ✓ keywords added (${res.results.length})`);
}

async function createRsa(customer, adGroupRn) {
  // Responsive Search Ad — Google rotates headlines + descriptions to find best combos.
  const finalUrl = buildFinalUrl('zurich', 'search');
  const op = {
    ad_group: adGroupRn,
    status: enums.AdGroupAdStatus.PAUSED,
    ad: {
      final_urls: [finalUrl],
      responsive_search_ad: {
        headlines: COPY.headlines.map(t => ({ text: t })),
        descriptions: COPY.descriptions.slice(0, 4).map(t => ({ text: t })),
        // path1/path2 = the "/path1/path2" displayed in the visible URL (max 15 chars each)
        path1: 'Kinderbuch',
        path2: 'Personalisiert',
      },
    },
  };
  if (DRY_RUN) {
    console.log(`      [DRY] RSA: ${COPY.headlines.length} headlines, ${Math.min(4, COPY.descriptions.length)} descriptions, URL ${finalUrl}, paths /Kinderbuch/Personalisiert`);
    return;
  }
  const res = await customer.adGroupAds.create([op]);
  console.log(`      ✓ RSA: ${res.results[0].resource_name}`);
}

async function main() {
  const { customer } = getClient();
  console.log(`━━━━━━━━━━ Search: Zürich ━━━━━━━━━━`);
  console.log(`Mode: ${DRY_RUN ? '🟡 DRY-RUN' : '🔴 LIVE CREATE (PAUSED)'}`);
  console.log();

  console.log('━━━ Step 1/5 — Budget + Campaign');
  const budgetRn = await createBudget(customer);
  const campaignRn = await createCampaign(customer, budgetRn);
  console.log();

  console.log('━━━ Step 2/5 — Geo + Language criteria');
  await addCriteria(customer, campaignRn);
  console.log();

  console.log(`━━━ Step 3-5/5 — ${ZURICH_SEARCH.adGroups.length} ad groups (keywords + RSA each)`);
  for (const ag of ZURICH_SEARCH.adGroups) {
    console.log(`  ━ ${ag.name} — ${ag.intent}`);
    const adGroupRn = await createAdGroup(customer, campaignRn, ag);
    await addKeywords(customer, adGroupRn, ag.keywords);
    await createRsa(customer, adGroupRn);
    console.log();
  }

  console.log('━━━━━━━━━━ DONE ━━━━━━━━━━');
  if (DRY_RUN) console.log('🟡 Dry run — nothing was sent to Google Ads.');
  else console.log(`🔴 Search campaign created (PAUSED). Activate in UI when ready.`);
}

main().catch(e => {
  console.error('❌ Failed:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
