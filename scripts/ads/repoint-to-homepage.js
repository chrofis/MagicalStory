#!/usr/bin/env node
/**
 * Repoint every ad whose Final URL lands on /try to the homepage instead,
 * preserving host + the per-city UTM query string so GA4 attribution survives.
 *
 * Rationale: /try is a thin trial-start page ("very empty") converting at 0;
 * the homepage carries the full product overview. Ad traffic ONLY — /try stays
 * live for organic/direct/referral. Fully reversible in the Ads UI.
 *
 * Touches: PMax asset_group.final_urls + Search ad.final_urls. Only entries
 * whose current URL path is /try are changed; anything already on the homepage
 * is skipped.
 *
 * Usage:
 *   node scripts/ads/repoint-to-homepage.js            # dry-run (default)
 *   node scripts/ads/repoint-to-homepage.js --apply    # live update
 */
const { getClient } = require('./lib/client');

const APPLY = process.argv.includes('--apply');

// Change ONLY the path to '/', keep host + query (UTMs) verbatim.
function toHomepage(url) {
  const u = new URL(url);
  if (u.pathname.replace(/\/+$/, '') !== '/try') return null; // not a /try URL — skip
  u.pathname = '/';
  return u.toString();
}

async function main() {
  const { customer } = getClient();
  console.log(`Mode: ${APPLY ? '🔴 LIVE UPDATE' : '🟡 DRY-RUN (pass --apply to execute)'}\n`);

  // ── PMax asset groups ──
  const assetGroups = await customer.query(`
    SELECT campaign.name, asset_group.resource_name, asset_group.final_urls
    FROM asset_group
    WHERE campaign.status != 'REMOVED'
  `);
  const agOps = [];
  for (const r of assetGroups) {
    const cur = r.asset_group.final_urls || [];
    const next = cur.map(u => toHomepage(u) || u);
    if (JSON.stringify(cur) === JSON.stringify(next)) continue; // nothing on /try
    console.log(`PMax  ${r.campaign.name}`);
    console.log(`   ${cur[0]}\n →  ${next[0]}`);
    agOps.push({ resource_name: r.asset_group.resource_name, final_urls: next });
  }

  // ── Search responsive ads ──
  const ads = await customer.query(`
    SELECT campaign.name, ad_group_ad.ad.resource_name, ad_group_ad.ad.final_urls
    FROM ad_group_ad
    WHERE campaign.status != 'REMOVED' AND campaign.advertising_channel_type = 'SEARCH'
  `);
  const adOps = [];
  for (const r of ads) {
    const cur = r.ad_group_ad.ad.final_urls || [];
    const next = cur.map(u => toHomepage(u) || u);
    if (JSON.stringify(cur) === JSON.stringify(next)) continue;
    console.log(`Search ${r.campaign.name} (ad)`);
    console.log(`   ${cur[0]}\n →  ${next[0]}`);
    adOps.push({ resource_name: r.ad_group_ad.ad.resource_name, final_urls: next });
  }

  console.log(`\n${agOps.length} asset group(s) + ${adOps.length} search ad(s) to repoint.`);

  if (!APPLY) {
    console.log('🟡 Dry run — nothing sent to Google Ads.');
    return;
  }
  if (agOps.length) {
    await customer.assetGroups.update(agOps);
    console.log(`✅ Updated ${agOps.length} asset group(s).`);
  }
  if (adOps.length) {
    await customer.ads.update(adOps);
    console.log(`✅ Updated ${adOps.length} search ad(s).`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
