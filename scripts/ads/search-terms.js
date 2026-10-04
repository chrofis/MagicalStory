#!/usr/bin/env node
/**
 * What people actually typed when our ads showed - the daily review that broad match needs.
 *
 *   node scripts/ads/search-terms.js                 # last 2 Swiss days, the three cheap campaigns
 *   node scripts/ads/search-terms.js --days=7
 *   node scripts/ads/search-terms.js --campaign=Search-LifeChallenge-CH
 *
 * Search-Cheap-Occasion-CH and Search-LifeChallenge-CH switched PHRASE -> BROAD on 2026-09-27 (owner); broad
 * match reaches related searches, which is the point (6 days on PHRASE found almost no eligible auctions) and
 * also the risk. Read this list, and add a negative to the campaign's spec for any off-target query - that is
 * how `kinderspielzeug` (a toy search the BROAD `spielzeug` negative does not block) was found.
 *
 * Read-only: GAQL only, no mutate calls. Sorted by spend, then impressions.
 */
const { getClient } = require('./lib/client');

const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=2').split('=')[1]);
const ONE = (process.argv.find((a) => a.startsWith('--campaign=')) || '').slice(11);
const CAMPAIGNS = ONE ? [ONE] : ['Search-Cheap-Age-CH', 'Search-Cheap-Occasion-CH', 'Search-LifeChallenge-CH'];
const TZ = 'Europe/Zurich';

function swissWindow(days) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { startDate: d.toISOString().slice(0, 10), endDate: today };
}

async function main() {
  if (!Number.isInteger(DAYS) || DAYS < 1) throw new Error('--days must be a positive integer');
  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json - run node scripts/ads/authorize.js');
  const { startDate, endDate } = swissWindow(DAYS);
  const q = CAMPAIGNS.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(',');
  const rows = await customer.query(`
    SELECT campaign.name, ad_group.name, search_term_view.search_term,
           metrics.impressions, metrics.clicks, metrics.cost_micros
      FROM search_term_view
     WHERE campaign.name IN (${q}) AND segments.date BETWEEN '${startDate}' AND '${endDate}'`);

  // One line per (campaign, ad group, term), summed over the days.
  const agg = new Map();
  for (const r of rows) {
    const key = `${r.campaign.name}|${r.ad_group.name}|${r.search_term_view.search_term}`;
    const e = agg.get(key) || { campaign: r.campaign.name, adGroup: r.ad_group.name, term: r.search_term_view.search_term, impr: 0, clicks: 0, cost: 0 };
    e.impr += r.metrics.impressions || 0; e.clicks += r.metrics.clicks || 0; e.cost += r.metrics.cost_micros || 0;
    agg.set(key, e);
  }
  const list = [...agg.values()].sort((a, b) => b.cost - a.cost || b.impr - a.impr);
  console.log(`Search terms ${startDate} .. ${endDate} (Swiss days) - ${CAMPAIGNS.join(', ')}`);
  if (!list.length) { console.log('  (none - no impressions in this window)'); return; }
  console.log('   impr  clicks     spend  campaign / ad group  "search term"');
  for (const e of list) {
    console.log(`  ${String(e.impr).padStart(5)}  ${String(e.clicks).padStart(6)}  CHF ${(e.cost / 1e6).toFixed(2).padStart(5)}  ${e.campaign.replace('Search-', '')} / ${e.adGroup}  "${e.term}"`);
  }
}

main().catch((e) => {
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 2000));
  process.exit(1);
});
