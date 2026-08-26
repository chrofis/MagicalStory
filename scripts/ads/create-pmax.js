#!/usr/bin/env node
/**
 * Create a PAUSED Performance Max campaign for a single city.
 * Same creatives + copy as create-demand-gen.js, but PMax channel type
 * (which the google-ads-api@23 library fully supports, unlike Demand Gen v2).
 *
 * Reuses logos / square image / business-name asset from your existing
 * "Campaign Deutsch" PMax campaign (so we don't duplicate them per city).
 *
 * Usage:
 *   node scripts/ads/create-pmax.js --city=baden --dry-run
 *   node scripts/ads/create-pmax.js --city=baden          # CREATE (PAUSED status)
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getClient } = require('./lib/client');
const { COPY, CITIES, CAMPAIGN_DEFAULTS, REUSABLE_ASSETS, buildFinalUrl } = require('./lib/campaign-config');
const { enums, ResourceNames } = require('google-ads-api');

// PMax landscape marketing images must be exactly 1.91:1 (Google spec).
// Our source creatives are 16:9 (1.78:1). Crop centered to 1.91:1, no scaling.
async function cropTo191(buf) {
  const img = sharp(buf);
  const meta = await img.metadata();
  const targetAspect = 1.91;
  const currentAspect = meta.width / meta.height;
  let cropW = meta.width;
  let cropH = meta.height;
  if (currentAspect < targetAspect) {
    // Too tall — crop top+bottom
    cropH = Math.round(meta.width / targetAspect);
  } else if (currentAspect > targetAspect) {
    // Too wide — crop left+right
    cropW = Math.round(meta.height * targetAspect);
  }
  const left = Math.round((meta.width - cropW) / 2);
  const top  = Math.round((meta.height - cropH) / 2);
  return img.extract({ left, top, width: cropW, height: cropH }).jpeg({ quality: 92 }).toBuffer();
}

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const CITY_KEY = (args.city || '').toLowerCase();
const DRY_RUN = args['dry-run'] === 'true';

if (!CITY_KEY || !CITIES[CITY_KEY]) {
  console.error(`Usage: --city=<${Object.keys(CITIES).join('|')}> [--dry-run]`);
  process.exit(1);
}
const city = CITIES[CITY_KEY];

function listCreatives(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Missing dir: ${dir}`);
  return fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f) && !f.startsWith('_')).map(f => path.join(dir, f));
}

async function uploadImageAssets(customer, paths) {
  const out = [];
  for (const p of paths) {
    const raw = fs.readFileSync(p);
    const data = await cropTo191(raw);
    const name = `pmax-${city.label.toLowerCase()}-${path.basename(p, path.extname(p))}-191`.slice(0, 100);
    if (DRY_RUN) {
      out.push({ resource_name: `[DRY] image/${name}`, file: path.basename(p), bytes: data.length });
      continue;
    }
    const res = await customer.assets.create([{
      name,
      type: enums.AssetType.IMAGE,
      image_asset: { data },
    }]);
    out.push({ resource_name: res.results[0].resource_name, file: path.basename(p), bytes: data.length });
    console.log(`  ✓ image (cropped to 1.91:1): ${path.basename(p)} → ${res.results[0].resource_name}`);
  }
  return out;
}

async function createTextAssets(customer, texts, label) {
  // PMax text assets are created as Asset resources of type TEXT.
  const out = [];
  for (const t of texts) {
    if (DRY_RUN) {
      out.push({ resource_name: `[DRY] text/${label}/${t.slice(0, 20)}`, text: t });
      continue;
    }
    const res = await customer.assets.create([{
      type: enums.AssetType.TEXT,
      text_asset: { text: t },
    }]);
    out.push({ resource_name: res.results[0].resource_name, text: t });
  }
  console.log(`  ✓ ${label}: ${texts.length} text assets`);
  return out;
}

async function createBudget(customer) {
  const op = {
    name: city.budgetName,
    amount_micros: CAMPAIGN_DEFAULTS.dailyBudgetMicros,
    delivery_method: enums.BudgetDeliveryMethod.STANDARD,
    explicitly_shared: false,
  };
  if (DRY_RUN) {
    console.log(`  [DRY] budget: ${op.name} = ${op.amount_micros / 1e6} CHF/day`);
    return `[DRY] budget/${op.name}`;
  }
  const res = await customer.campaignBudgets.create([op]);
  console.log(`  ✓ budget: ${res.results[0].resource_name}`);
  return res.results[0].resource_name;
}

async function createCampaign(customer, budgetRn) {
  const op = {
    name: city.campaignName,
    status: enums.CampaignStatus.PAUSED,
    advertising_channel_type: enums.AdvertisingChannelType.PERFORMANCE_MAX,
    campaign_budget: budgetRn,
    bidding_strategy_type: enums.BiddingStrategyType[CAMPAIGN_DEFAULTS.biddingStrategyType],
    maximize_conversions: {},
    contains_eu_political_advertising: CAMPAIGN_DEFAULTS.containsEuPoliticalAdvertising
      ? enums.EuPoliticalAdvertisingStatus.CONTAINS_EU_POLITICAL_ADVERTISING
      : enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    brand_guidelines_enabled: false,  // skip Brand Guidelines requirement (logo/business name at campaign level)
  };
  if (DRY_RUN) {
    console.log(`  [DRY] campaign: ${op.name} (PAUSED, PERFORMANCE_MAX, MAXIMIZE_CONVERSIONS)`);
    return `[DRY] campaign/${op.name}`;
  }
  const res = await customer.campaigns.create([op]);
  console.log(`  ✓ campaign: ${res.results[0].resource_name}`);
  return res.results[0].resource_name;
}

async function addCriteria(customer, campaignRn) {
  const geoRn = ResourceNames.geoTargetConstant(city.geoTargetId);
  const langRn = ResourceNames.languageConstant(CAMPAIGN_DEFAULTS.languageConstantId);
  const ops = [
    { campaign: campaignRn, negative: false, location: { geo_target_constant: geoRn } },
    { campaign: campaignRn, negative: false, language: { language_constant: langRn } },
  ];
  if (DRY_RUN) {
    console.log(`  [DRY] geo: ${geoRn} | language: ${langRn}`);
    return;
  }
  const res = await customer.campaignCriteria.create(ops);
  console.log(`  ✓ criteria added (${res.results.length})`);
}

async function createAssetGroupWithAssets(customer, campaignRn, sets) {
  // PMax requires the asset group AND all its assets to be created in a single
  // batched mutate using a temp resource name. Otherwise the asset group create
  // fails with NOT_ENOUGH_*_ASSET errors.
  const cid = campaignRn.split('/')[1];
  const tempAgRn = `customers/${cid}/assetGroups/-1`;
  const FT = enums.AssetFieldType;

  const assetOps = [];
  for (const rn of sets.headlines)       assetOps.push({ asset_group: tempAgRn, asset: rn, field_type: FT.HEADLINE });
  for (const rn of sets.longHeadlines)   assetOps.push({ asset_group: tempAgRn, asset: rn, field_type: FT.LONG_HEADLINE });
  for (const rn of sets.descriptions)    assetOps.push({ asset_group: tempAgRn, asset: rn, field_type: FT.DESCRIPTION });
  for (const rn of sets.landscapeImages) assetOps.push({ asset_group: tempAgRn, asset: rn, field_type: FT.MARKETING_IMAGE });
  assetOps.push({ asset_group: tempAgRn, asset: REUSABLE_ASSETS.logo,          field_type: FT.LOGO });
  assetOps.push({ asset_group: tempAgRn, asset: REUSABLE_ASSETS.landscapeLogo, field_type: FT.LANDSCAPE_LOGO });
  assetOps.push({ asset_group: tempAgRn, asset: REUSABLE_ASSETS.squareImage,   field_type: FT.SQUARE_MARKETING_IMAGE });
  assetOps.push({ asset_group: tempAgRn, asset: REUSABLE_ASSETS.businessName,  field_type: FT.BUSINESS_NAME });

  const operations = [
    {
      entity: 'asset_group',
      operation: 'create',
      resource: {
        resource_name: tempAgRn,
        name: `${city.label}-AssetGroup-v1`,
        campaign: campaignRn,
        final_urls: [buildFinalUrl(CITY_KEY)],
        status: enums.AssetGroupStatus.PAUSED,
      },
    },
    ...assetOps.map(r => ({ entity: 'asset_group_asset', operation: 'create', resource: r })),
  ];

  if (DRY_RUN) {
    console.log(`  [DRY] batched mutate: 1 asset_group + ${assetOps.length} asset_group_assets`);
    const byType = {};
    assetOps.forEach(o => { byType[o.field_type] = (byType[o.field_type] || 0) + 1; });
    Object.entries(byType).forEach(([ft, c]) => {
      const name = Object.keys(FT).find(k => FT[k] === parseInt(ft));
      console.log(`         ${name}: ${c} assets`);
    });
    return;
  }

  const res = await customer.mutateResources(operations);
  console.log(`  ✓ asset group + ${assetOps.length} assets created in one batch`);
  console.log(`    asset_group: ${res.mutate_operation_responses[0]?.asset_group_result?.resource_name}`);
}

async function main() {
  const { customer } = getClient();
  console.log(`━━━━━━━━━━ Performance Max: ${city.label} ━━━━━━━━━━`);
  console.log(`Mode: ${DRY_RUN ? '🟡 DRY-RUN' : '🔴 LIVE CREATE (PAUSED)'}`);
  console.log();

  const creativePaths = listCreatives(city.creativesDir);
  console.log(`Creatives (${creativePaths.length}):`);
  creativePaths.forEach(p => console.log('  -', path.basename(p)));
  console.log();

  console.log('━━━ Step 1/6 — Upload image assets (landscape)');
  const images = await uploadImageAssets(customer, creativePaths);
  console.log();

  console.log('━━━ Step 2/6 — Create text assets');
  const headlines     = await createTextAssets(customer, COPY.headlines,     'headlines');
  const longHeadlines = await createTextAssets(customer, COPY.longHeadlines, 'long headlines');
  const descriptions  = await createTextAssets(customer, COPY.descriptions,  'descriptions');
  console.log();

  console.log('━━━ Step 3/6 — Budget + Campaign');
  const budgetRn = await createBudget(customer);
  const campaignRn = await createCampaign(customer, budgetRn);
  console.log();

  console.log('━━━ Step 4/6 — Geo + Language criteria');
  await addCriteria(customer, campaignRn);
  console.log();

  console.log('━━━ Step 5/5 — Asset group + all assets (batched mutate)');
  await createAssetGroupWithAssets(customer, campaignRn, {
    headlines: headlines.map(a => a.resource_name),
    longHeadlines: longHeadlines.map(a => a.resource_name),
    descriptions: descriptions.map(a => a.resource_name),
    landscapeImages: images.map(a => a.resource_name),
  });
  console.log();

  console.log('━━━━━━━━━━ DONE ━━━━━━━━━━');
  if (DRY_RUN) console.log('🟡 Dry run — nothing was sent to Google Ads.');
  else console.log(`🔴 PMax campaign created (PAUSED). Review at https://ads.google.com/aw/campaigns and activate when ready.`);
}

main().catch(e => {
  console.error('❌ Failed:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
