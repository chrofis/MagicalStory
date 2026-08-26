#!/usr/bin/env node
/**
 * Update the live Search-Zürich campaign (id 23884069828):
 *   1. Add campaign-level NEGATIVE keywords (competitor brands) — stop paying
 *      for searches like "librio", "globi", "paw patrol" etc.
 *   2. Widen geo from Zürich city (1003297) → Canton of Zürich (20151):
 *      add the canton location criterion, remove the city one.
 *
 * Usage:
 *   node scripts/ads/update-zurich-negatives-geo.js --dry-run
 *   node scripts/ads/update-zurich-negatives-geo.js            # apply live
 */
const { getClient } = require('./lib/client');
const { ZURICH_SEARCH, ZURICH_NEGATIVE_KEYWORDS } = require('./lib/campaign-config');
const { enums, ResourceNames } = require('google-ads-api');

const CAMPAIGN_ID = 23884069828;
const OLD_CITY_GEO = 1003297; // Zürich city — to remove
const NEW_CANTON_GEO = ZURICH_SEARCH.geoTargetId; // 20151 — Canton of Zürich

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const { customer, cfg } = getClient();
  if (!customer) { console.error('No refresh_token.'); process.exit(1); }
  const cid = cfg.customer_id;
  const campaignRn = ResourceNames.campaign(cid, CAMPAIGN_ID);

  console.log(`━━━━━━ Update Search-Zürich (campaign ${CAMPAIGN_ID}) ━━━━━━`);
  console.log(`Mode: ${DRY_RUN ? '🟡 DRY-RUN' : '🔴 LIVE'}\n`);

  // ── 1. Negative keywords ──────────────────────────────────────────────
  console.log(`━━━ 1/3 — Add ${ZURICH_NEGATIVE_KEYWORDS.length} negative keywords`);
  const negOps = ZURICH_NEGATIVE_KEYWORDS.map(text => ({
    campaign: campaignRn,
    negative: true,
    keyword: { text, match_type: enums.KeywordMatchType.BROAD },
  }));
  if (DRY_RUN) {
    ZURICH_NEGATIVE_KEYWORDS.forEach(t => console.log(`   [DRY] negative [BROAD] "${t}"`));
  } else {
    const res = await customer.campaignCriteria.create(negOps);
    console.log(`   ✓ added ${res.results.length} negative keywords`);
  }

  // ── 2. Add canton geo ─────────────────────────────────────────────────
  console.log(`\n━━━ 2/3 — Add Canton of Zürich geo (${NEW_CANTON_GEO})`);
  const cantonGeoRn = ResourceNames.geoTargetConstant(NEW_CANTON_GEO);
  if (DRY_RUN) {
    console.log(`   [DRY] add location ${cantonGeoRn}`);
  } else {
    const res = await customer.campaignCriteria.create([
      { campaign: campaignRn, negative: false, location: { geo_target_constant: cantonGeoRn } },
    ]);
    console.log(`   ✓ ${res.results[0].resource_name}`);
  }

  // ── 3. Remove city geo ────────────────────────────────────────────────
  // Location criteria use the geo id as the criterion id, so the resource name
  // is campaignCriteria/<campaignId>~<geoId>.
  console.log(`\n━━━ 3/3 — Remove Zürich city geo (${OLD_CITY_GEO})`);
  const cityCritRn = ResourceNames.campaignCriterion(cid, CAMPAIGN_ID, OLD_CITY_GEO);
  if (DRY_RUN) {
    console.log(`   [DRY] remove ${cityCritRn}`);
  } else {
    const res = await customer.campaignCriteria.remove([cityCritRn]);
    console.log(`   ✓ removed (${res.results.length})`);
  }

  console.log(`\n━━━━━━ DONE ━━━━━━`);
  if (DRY_RUN) console.log('🟡 Dry run — nothing changed.');
  else console.log('🔴 Live: negatives added, geo now Canton of Zürich.');
}

main().catch(e => {
  console.error('❌ Failed:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
