#!/usr/bin/env node
/**
 * Create Google Ads sitelinks for MagicalStory.
 *
 *   - 5 account-level sitelinks (CustomerAsset / SITELINK field type) — apply
 *     to every campaign automatically.
 *   - 4 per-city sitelinks (CampaignAsset / SITELINK field type) — attached
 *     individually to each city campaign so the ad delivers one locally-
 *     relevant link in addition to the 5 generic ones (= 6 total per
 *     campaign, meeting Google's "≥6 sitelinks" recommendation).
 *
 * Defaults to DRY-RUN. Pass `--push` to actually write to Google Ads.
 *
 * Usage:
 *   node scripts/ads/create-sitelinks.js              # dry-run preview
 *   node scripts/ads/create-sitelinks.js --push       # create live
 *   node scripts/ads/create-sitelinks.js --account-only --push
 *                                                     # only the 5 generic
 *   node scripts/ads/create-sitelinks.js --city=baden --push
 *                                                     # only Baden sitelink
 *
 * Decision context: see docs/decisions.md → "Sitelinks: 5 account-level + 1
 * per-city" (or this file's header if that entry doesn't exist yet).
 */

const { getClient } = require('./lib/client');
const { CITIES, ZURICH_SEARCH } = require('./lib/campaign-config');

// Display labels per city. Zürich uses the umlaut (German correct form).
// PMax cities pull their label from CITIES[key].label. Zürich's campaign
// is search-only (see ZURICH_SEARCH in campaign-config.js) so it isn't
// in the CITIES map — fall back here.
const CITY_LABEL = {
  aarau: CITIES.aarau?.label || 'Aarau',
  baden: CITIES.baden?.label || 'Baden',
  winterthur: CITIES.winterthur?.label || 'Winterthur',
  zurich: ZURICH_SEARCH?.label || 'Zürich',
};
const { enums } = require('google-ads-api');

const SITE_BASE = 'https://www.magicalstory.ch';

// ─── ACCOUNT-LEVEL SITELINKS ────────────────────────────────────────────────
// These attach to the customer (account). Apply to every campaign.
// Copy approved by Roger 2026-05-29.
const ACCOUNT_SITELINKS = [
  {
    name: 'sitelink-de-zur-startseite',
    linkText: 'Zur Startseite',
    description1: 'Personalisierte Kinderbücher',
    description2: 'mit deinem Kind als Hauptfigur',
    path: '/',
  },
  {
    name: 'sitelink-de-gratis-testen',
    linkText: 'Gratis testen',
    description1: 'Erste Geschichte gratis,',
    description2: 'ohne Anmeldung möglich',
    path: '/try',
  },
  {
    name: 'sitelink-de-geschenkideen',
    linkText: 'Geschenkideen',
    description1: 'Geburtstag, Taufe, Weihnachten:',
    description2: 'Persönliches Buch verschenken',
    path: '/geschenk',
  },
  {
    name: 'sitelink-de-themen',
    linkText: 'Über 44 Themen entdecken',
    description1: 'Mut, Ängste, ABC, Geschwister',
    description2: 'und über 40 weitere Themen',
    path: '/themes',
  },
  {
    name: 'sitelink-de-preise',
    linkText: 'Preise & Pakete',
    description1: 'Ab CHF 5 starten —',
    description2: 'gedrucktes Buch verfügbar',
    path: '/pricing',
  },
];

// ─── PER-CITY SITELINKS ─────────────────────────────────────────────────────
// One per city. Attached to that city's campaign via CampaignAsset.
function citySitelinkSpec(cityKey, cityLabel) {
  return {
    name: `sitelink-de-stadt-${cityKey}`,
    linkText: `Geschichten in ${cityLabel}`,
    description1: `Echte Wahrzeichen aus ${cityLabel}`,
    description2: 'als Schauplatz der Geschichte',
    path: `/stadt/${cityKey === 'zurich' ? 'zuerich' : cityKey}`,
  };
}

// We support the four cities that have approved creatives + landing pages.
const CITY_KEYS = ['aarau', 'baden', 'winterthur', 'zurich'];

// Patterns used to find the city's campaign(s) by name. Multi-pattern
// covers the case where the campaign name doesn't carry the umlaut form
// (e.g. `Search-Zurich-v1` for the Zürich search campaign, while the
// sitelink display label uses `Zürich`).
const CITY_CAMPAIGN_PATTERNS = {
  aarau: ['Aarau'],
  baden: ['Baden'],
  winterthur: ['Winterthur'],
  zurich: ['Zurich', 'Zürich'],
};

// ─── ARGS ───────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const PUSH = args.push === 'true';
const ACCOUNT_ONLY = args['account-only'] === 'true';
const CITY_ONLY = args.city ? String(args.city).toLowerCase() : null;
const DRY = !PUSH;

if (CITY_ONLY && !CITY_KEYS.includes(CITY_ONLY)) {
  console.error(`Unknown city: ${CITY_ONLY}. Pick one of: ${CITY_KEYS.join(', ')}`);
  process.exit(1);
}

// ─── ASSERTIONS — surface bad copy before pushing ──────────────────────────
function assertSitelinkLimits(s) {
  const probs = [];
  if (s.linkText.length > 25) probs.push(`linkText ${s.linkText.length}>25`);
  if (s.description1.length > 35) probs.push(`description1 ${s.description1.length}>35`);
  if (s.description2.length > 35) probs.push(`description2 ${s.description2.length}>35`);
  if (probs.length) throw new Error(`Sitelink "${s.linkText}" exceeds limits: ${probs.join(', ')}`);
}

function buildAssetPayload(s) {
  return {
    name: s.name,
    type: enums.AssetType.SITELINK,
    final_urls: [`${SITE_BASE}${s.path}`],
    sitelink_asset: {
      link_text: s.linkText,
      description1: s.description1,
      description2: s.description2,
    },
  };
}

async function main() {
  // 1. Validate every sitelink fits Google's char limits.
  const allSitelinks = [
    ...ACCOUNT_SITELINKS,
    ...CITY_KEYS.map(k => citySitelinkSpec(k, CITY_LABEL[k])),
  ];
  for (const s of allSitelinks) assertSitelinkLimits(s);

  console.log(`Mode: ${DRY ? 'DRY-RUN (no API writes)' : '⚠️  PUSH (live writes to Google Ads)'}`);
  if (ACCOUNT_ONLY) console.log('Scope: account-level sitelinks only');
  if (CITY_ONLY) console.log(`Scope: per-city sitelink for "${CITY_ONLY}" only`);
  console.log('');

  const { customer } = getClient();
  if (!DRY && !customer) {
    console.error('Missing refresh_token in scripts/ads/config.json — run authorize.js first.');
    process.exit(1);
  }

  // 2. Account-level sitelinks.
  if (!CITY_ONLY) {
    console.log('━━━ Account-level sitelinks (5) ━━━');
    for (const s of ACCOUNT_SITELINKS) {
      console.log(`  • ${s.linkText.padEnd(28)} → ${SITE_BASE}${s.path}`);
      console.log(`    "${s.description1}" / "${s.description2}"`);
      if (DRY) continue;
      const assetRes = await customer.assets.create([buildAssetPayload(s)]);
      const assetResourceName = assetRes.results[0].resource_name;
      await customer.customerAssets.create([{
        asset: assetResourceName,
        field_type: enums.AssetFieldType.SITELINK,
      }]);
      console.log(`    ✓ created ${assetResourceName}`);
    }
  }

  // 3. Per-city sitelinks (attach to existing campaigns by name match).
  if (!ACCOUNT_ONLY) {
    console.log('\n━━━ Per-city sitelinks ━━━');
    const citiesToDo = CITY_ONLY ? [CITY_ONLY] : CITY_KEYS;

    for (const cityKey of citiesToDo) {
      const cityLabel = CITY_LABEL[cityKey];
      const spec = citySitelinkSpec(cityKey, cityLabel);
      console.log(`  • ${spec.linkText.padEnd(28)} → ${SITE_BASE}${spec.path}`);
      console.log(`    "${spec.description1}" / "${spec.description2}"`);

      const patterns = CITY_CAMPAIGN_PATTERNS[cityKey] || [cityLabel];

      if (DRY) {
        console.log(`    [dry-run] would query campaigns matching ${patterns.map(p => `"%${p}%"`).join(' OR ')} and attach as CampaignAsset`);
        continue;
      }

      // Find the campaign(s) for this city. GAQL doesn't support OR with
      // parens reliably, so run one query per alias and dedupe by resource
      // name in JS. (Zürich has two patterns: 'Zurich' AND 'Zürich'.)
      const seen = new Set();
      const rows = [];
      for (const p of patterns) {
        const r = await customer.query(`
          SELECT campaign.resource_name, campaign.name, campaign.status
          FROM campaign
          WHERE campaign.name LIKE '%${p}%'
            AND campaign.status != 'REMOVED'
        `);
        for (const row of r) {
          if (seen.has(row.campaign.resource_name)) continue;
          seen.add(row.campaign.resource_name);
          rows.push(row);
        }
      }
      if (rows.length === 0) {
        console.log(`    ⚠️  no campaign matched ${patterns.map(p => `"%${p}%"`).join(' OR ')} — skipping (run after creating the campaign)`);
        continue;
      }

      const assetRes = await customer.assets.create([buildAssetPayload(spec)]);
      const assetResourceName = assetRes.results[0].resource_name;
      console.log(`    ✓ created asset ${assetResourceName}`);
      for (const row of rows) {
        await customer.campaignAssets.create([{
          campaign: row.campaign.resource_name,
          asset: assetResourceName,
          field_type: enums.AssetFieldType.SITELINK,
        }]);
        console.log(`    ✓ attached to campaign "${row.campaign.name}" (${row.campaign.status})`);
      }
    }
  }

  console.log('');
  if (DRY) {
    console.log('Dry-run complete. Re-run with `--push` to write to Google Ads.');
  } else {
    console.log('Done.');
  }
}

main().catch((err) => {
  console.error('Sitelink creation failed:', err.errors || err);
  process.exit(1);
});
