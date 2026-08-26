#!/usr/bin/env node
/**
 * Create a PAUSED Demand Gen campaign for a single city.
 * Bundles all approved/<city>/*.jpg into a multi-asset Demand Gen ad.
 *
 * Usage:
 *   node scripts/ads/create-demand-gen.js --city=baden --dry-run
 *   node scripts/ads/create-demand-gen.js --city=baden --validate-only   # server-side validate, no create
 *   node scripts/ads/create-demand-gen.js --city=baden                   # CREATE for real (still PAUSED)
 *
 * Safety: campaigns are created with status=PAUSED. They will not serve until
 * you flip them to ENABLED in the Google Ads UI (or via a separate enable script).
 */

const fs = require('fs');
const path = require('path');
const { getClient } = require('./lib/client');
const { COPY, CITIES, CAMPAIGN_DEFAULTS, buildFinalUrl } = require('./lib/campaign-config');
const { enums, ResourceNames, toMicros } = require('google-ads-api');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));

const CITY_KEY = (args.city || '').toLowerCase();
const DRY_RUN = args['dry-run'] === 'true';
const VALIDATE_ONLY = args['validate-only'] === 'true';

if (!CITY_KEY || !CITIES[CITY_KEY]) {
  console.error(`Usage: --city=<${Object.keys(CITIES).join('|')}> [--dry-run | --validate-only]`);
  process.exit(1);
}
const city = CITIES[CITY_KEY];

function listCreatives(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Missing creatives dir: ${dir}`);
  return fs.readdirSync(dir)
    .filter(f => /\.jpe?g$/i.test(f) && !f.startsWith('_'))
    .map(f => path.join(dir, f));
}

function readImage(p) {
  return fs.readFileSync(p);
}

async function ensureImageAssets(customer, creativePaths) {
  // Upload each JPG as an Image Asset, return resource_names.
  const results = [];
  for (const p of creativePaths) {
    const bytes = readImage(p);
    const assetName = `dg-creative-${city.label.toLowerCase()}-${path.basename(p, path.extname(p))}`.slice(0, 100);
    const op = {
      name: assetName,
      type: enums.AssetType.IMAGE,
      image_asset: {
        data: bytes,
      },
    };
    if (DRY_RUN) {
      results.push({ resource_name: `[DRY-RUN] ${assetName}`, file: path.basename(p), bytes: bytes.length });
      continue;
    }
    const res = await customer.assets.create([op], { validate_only: VALIDATE_ONLY });
    const rn = res.results?.[0]?.resource_name;
    if (!rn && !VALIDATE_ONLY) throw new Error(`Asset upload failed for ${p}`);
    results.push({ resource_name: rn || `[VALIDATE] ${assetName}`, file: path.basename(p), bytes: bytes.length });
    console.log(`  ✓ uploaded asset: ${path.basename(p)} (${(bytes.length / 1024).toFixed(0)} KB) → ${rn}`);
  }
  return results;
}

async function ensureTextAssets(customer, texts, label) {
  // Demand Gen ads consume text as AdTextAsset (inline, not Asset resources).
  // We just return the text array as-is wrapped; included here for clarity.
  return texts.map(t => ({ text: t }));
}

async function createCampaignBudget(customer) {
  const op = {
    name: city.budgetName,
    amount_micros: CAMPAIGN_DEFAULTS.dailyBudgetMicros,
    delivery_method: enums.BudgetDeliveryMethod.STANDARD,
    explicitly_shared: false,
  };
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] budget: ${op.name} = ${op.amount_micros / 1_000_000} CHF/day`);
    return `[DRY-RUN] budget/${op.name}`;
  }
  const res = await customer.campaignBudgets.create([op], { validate_only: VALIDATE_ONLY });
  const rn = res.results?.[0]?.resource_name;
  console.log(`  ✓ budget created: ${rn}`);
  return rn || `[VALIDATE] budget/${op.name}`;
}

async function createCampaign(customer, budgetResource) {
  const op = {
    name: city.campaignName,
    status: enums.CampaignStatus.PAUSED,
    advertising_channel_type: enums.AdvertisingChannelType.DEMAND_GEN,
    campaign_budget: budgetResource,
    bidding_strategy_type: enums.BiddingStrategyType[CAMPAIGN_DEFAULTS.biddingStrategyType],
    maximize_conversions: {},
    contains_eu_political_advertising: CAMPAIGN_DEFAULTS.containsEuPoliticalAdvertising
      ? enums.EuPoliticalAdvertisingStatus.CONTAINS_EU_POLITICAL_ADVERTISING
      : enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    demand_gen_campaign_setting: {
      upgraded_targeting: false,
    },
    geo_target_type_setting: {
      positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE_OR_INTEREST,
      negative_geo_target_type: enums.NegativeGeoTargetType.PRESENCE,
    },
  };
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] campaign: ${op.name} (PAUSED, DEMAND_GEN, ${CAMPAIGN_DEFAULTS.biddingStrategyType})`);
    return `[DRY-RUN] campaign/${op.name}`;
  }
  const res = await customer.campaigns.create([op], { validate_only: VALIDATE_ONLY });
  const rn = res.results?.[0]?.resource_name;
  console.log(`  ✓ campaign created: ${rn}`);
  return rn || `[VALIDATE] campaign/${op.name}`;
}

async function addGeoTarget(customer, campaignResource) {
  // geo_target_constants/1002809 = Baden
  const geoRn = ResourceNames.geoTargetConstant(city.geoTargetId);
  const op = {
    campaign: campaignResource,
    negative: false,
    location: { geo_target_constant: geoRn },
  };
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] geo target: ${geoRn} (${city.label})`);
    return null;
  }
  const res = await customer.campaignCriteria.create([op], { validate_only: VALIDATE_ONLY });
  const rn = res.results?.[0]?.resource_name;
  console.log(`  ✓ geo target: ${rn}`);
  return rn;
}

async function addLanguageTarget(customer, campaignResource) {
  const langRn = ResourceNames.languageConstant(CAMPAIGN_DEFAULTS.languageConstantId);
  const op = { campaign: campaignResource, language: { language_constant: langRn } };
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] language: ${langRn} (de)`);
    return null;
  }
  const res = await customer.campaignCriteria.create([op], { validate_only: VALIDATE_ONLY });
  const rn = res.results?.[0]?.resource_name;
  console.log(`  ✓ language target: ${rn}`);
  return rn;
}

async function createAdGroup(customer, campaignResource) {
  const op = {
    name: city.adGroupName,
    campaign: campaignResource,
    status: enums.AdGroupStatus.PAUSED,
  };
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] ad group: ${op.name} (PAUSED)`);
    return `[DRY-RUN] adGroup/${op.name}`;
  }
  const res = await customer.adGroups.create([op], { validate_only: VALIDATE_ONLY });
  const rn = res.results?.[0]?.resource_name;
  console.log(`  ✓ ad group: ${rn}`);
  return rn || `[VALIDATE] adGroup/${op.name}`;
}

async function createDemandGenAd(customer, adGroupResource, imageAssets) {
  const headlines = COPY.headlines.map(t => ({ text: t }));
  const longHeadlines = COPY.longHeadlines.map(t => ({ text: t }));
  const descriptions = COPY.descriptions.map(t => ({ text: t }));

  const finalUrl = buildFinalUrl(CITY_KEY);
  const op = {
    ad_group: adGroupResource,
    status: enums.AdGroupAdStatus.PAUSED,
    ad: {
      final_urls: [finalUrl],
      demand_gen_multi_asset_ad: {
        headlines,
        long_headlines: longHeadlines,
        descriptions,
        business_name: COPY.businessName,
        marketing_images: imageAssets.map(a => ({ asset: a.resource_name })),
        call_to_action: enums.CallToActionType[COPY.callToAction],
      },
    },
  };

  if (DRY_RUN) {
    console.log(`  [DRY-RUN] demand gen ad with ${imageAssets.length} images, ${headlines.length} headlines, ${longHeadlines.length} long headlines, ${descriptions.length} descriptions`);
    console.log(`           final URL: ${finalUrl}`);
    console.log(`           business:  ${COPY.businessName}`);
    console.log(`           CTA:       ${COPY.callToAction}`);
    return `[DRY-RUN] ad/${city.adGroupName}`;
  }
  const res = await customer.adGroupAds.create([op], { validate_only: VALIDATE_ONLY });
  const rn = res.results?.[0]?.resource_name;
  console.log(`  ✓ ad: ${rn}`);
  return rn || `[VALIDATE] ad/${city.adGroupName}`;
}

async function main() {
  const { customer } = getClient();
  if (!customer) { console.error('No refresh_token — run authorize.js first.'); process.exit(1); }

  console.log(`━━━━━━━━━━ Demand Gen: ${city.label} ━━━━━━━━━━`);
  console.log(`Mode: ${DRY_RUN ? '🟡 DRY-RUN (no API calls)' : VALIDATE_ONLY ? '🟢 VALIDATE-ONLY (server-side validate, no create)' : '🔴 LIVE CREATE (PAUSED status)'}`);
  console.log();

  const creativePaths = listCreatives(city.creativesDir);
  console.log(`Found ${creativePaths.length} approved creatives:`);
  creativePaths.forEach(p => console.log('  -', path.basename(p)));
  console.log();

  console.log('━━━ Step 1/6 — Upload image assets');
  const imageAssets = await ensureImageAssets(customer, creativePaths);
  console.log();

  console.log('━━━ Step 2/6 — Create campaign budget');
  const budgetRn = await createCampaignBudget(customer);
  console.log();

  console.log('━━━ Step 3/6 — Create campaign');
  const campaignRn = await createCampaign(customer, budgetRn);
  console.log();

  console.log('━━━ Step 4/6 — Add geo + language targets');
  await addGeoTarget(customer, campaignRn);
  await addLanguageTarget(customer, campaignRn);
  console.log();

  console.log('━━━ Step 5/6 — Create ad group');
  const adGroupRn = await createAdGroup(customer, campaignRn);
  console.log();

  console.log('━━━ Step 6/6 — Create Demand Gen multi-asset ad');
  await createDemandGenAd(customer, adGroupRn, imageAssets);
  console.log();

  console.log('━━━━━━━━━━ DONE ━━━━━━━━━━');
  if (DRY_RUN) console.log('🟡 Dry run only — nothing was sent to Google Ads.');
  else if (VALIDATE_ONLY) console.log('🟢 Validate-only — Google accepted the config but did not persist.');
  else console.log(`🔴 Created. Campaign is PAUSED. Activate in UI when ready: https://ads.google.com/aw/campaigns?ocid=${city.geoTargetId}`);
}

main().catch(e => {
  console.error('❌ Failed:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
