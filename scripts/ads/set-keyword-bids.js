#!/usr/bin/env node
/**
 * Per-keyword max CPC for the cheap Search campaigns: cheap keywords keep the ad-group default,
 * contested keywords get their OWN bid at Google's first-page CPC estimate, up to a ceiling.
 *
 *   node scripts/ads/set-keyword-bids.js --ceiling=0.50            # DRY-RUN: prints every change it WOULD make
 *   node scripts/ads/set-keyword-bids.js --ceiling=0.50 --apply    # LIVE
 *
 * Owner decision 2026-09-23, after two days at a flat CHF 0.20 cap produced 2 impressions across the three
 * cheap campaigns (impression share <10%, >90% lost to rank): "The cheap adwords we should be winning all.
 * For the contested ones we might need to raise the limit." Ceiling chosen: CHF 0.50.
 *
 * Rules, per keyword:
 *   estimate <= ad-group default   -> no keyword bid (inherits the default; a stale keyword bid is cleared)
 *   default < estimate <= ceiling  -> keyword bid = estimate, rounded UP to CHF 0.01
 *   estimate > ceiling             -> no keyword bid (stays at the default, i.e. effectively out)
 *   no estimate / no-data filler   -> no keyword bid
 *
 * The no-data filler: Google returns one identical first-page estimate for every keyword it has no data on
 * (CHF 1.16 on 106 of 194 keywords on 2026-09-23). It is not an auction price, so the most common value is
 * treated as filler when it covers more than a quarter of the keywords - detected, not hard-coded.
 *
 * Search-Deutschschweiz-v1 is deliberately NOT in scope (owner: leave it as is).
 * The total daily spend is still capped by the campaign budgets set in activate-week.js - a higher max CPC
 * raises the price per click, never the daily ceiling.
 */
const { getClient } = require('./lib/client');

const APPLY = process.argv.includes('--apply');
const ceilingArg = (process.argv.find(a => a.startsWith('--ceiling=')) || '').slice(10);
const CEILING = Number(ceilingArg);
const CAMPAIGNS = ['Search-Cheap-Age-CH', 'Search-Cheap-Occasion-CH', 'Search-LifeChallenge-CH'];
const UNIT = 10000; // CHF 0.01 in micros - the billable unit

if (!ceilingArg || !Number.isFinite(CEILING) || CEILING <= 0) {
  console.error('Usage: node scripts/ads/set-keyword-bids.js --ceiling=<CHF> [--apply]');
  process.exit(1);
}

const chf = m => (m / 1e6).toFixed(2);

async function main() {
  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json');
  const q = CAMPAIGNS.map(n => `'${n}'`).join(',');
  const rows = await customer.query(`
    SELECT campaign.name, ad_group.name, ad_group.cpc_bid_micros,
           ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.cpc_bid_micros,
           ad_group_criterion.position_estimates.first_page_cpc_micros
    FROM ad_group_criterion
    WHERE campaign.name IN (${q}) AND campaign.status = 'ENABLED' AND ad_group_criterion.type = 'KEYWORD'
      AND ad_group_criterion.negative = false AND ad_group_criterion.status = 'ENABLED'`);
  if (!rows.length) throw new Error('No enabled keywords found in ' + CAMPAIGNS.join(', '));

  // Detect the no-data filler: the modal estimate, if it covers > 25% of keywords.
  const freq = new Map();
  for (const r of rows) {
    const fp = r.ad_group_criterion.position_estimates && r.ad_group_criterion.position_estimates.first_page_cpc_micros;
    if (fp) freq.set(fp, (freq.get(fp) || 0) + 1);
  }
  const [modeVal, modeCount] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  const filler = modeCount > rows.length / 4 ? modeVal : null;
  console.log(`Ceiling CHF ${CEILING.toFixed(2)} - ${rows.length} keywords in ${CAMPAIGNS.length} campaigns`);
  console.log(filler ? `No-data filler detected: CHF ${chf(filler)} on ${modeCount} keywords - ignored as an estimate` : 'No no-data filler detected');
  console.log(`Mode: ${APPLY ? 'LIVE' : 'DRY-RUN - nothing is sent (pass --apply to execute)'}\n`);

  const ops = [];
  const tally = { raise: 0, clear: 0, unchanged: 0, aboveCeiling: 0, cheap: 0, noEstimate: 0 };
  for (const r of rows) {
    const c = r.ad_group_criterion;
    const fp = c.position_estimates && c.position_estimates.first_page_cpc_micros;
    const def = r.ad_group.cpc_bid_micros;
    const cur = c.cpc_bid_micros || 0; // 0 / unset = inherits the ad-group default
    let want = 0;
    if (!fp || fp === filler) tally.noEstimate++;
    else if (fp <= def) tally.cheap++;
    else if (fp > CEILING * 1e6) tally.aboveCeiling++;
    else want = Math.ceil(fp / UNIT) * UNIT;

    if (want && want !== cur) {
      tally.raise++;
      ops.push({ resource_name: c.resource_name, cpc_bid_micros: want });
      console.log(`  RAISE  ${r.campaign.name.padEnd(25)} ${r.ad_group.name.padEnd(15)} "${c.keyword.text}"  ${cur ? chf(cur) : 'default ' + chf(def)} -> ${chf(want)}  (estimate ${chf(fp)})`);
    } else if (!want && cur && cur !== def) {
      // A keyword bid left over from an earlier run whose estimate has since moved out of range.
      tally.clear++;
      ops.push({ resource_name: c.resource_name, cpc_bid_micros: def });
      console.log(`  RESET  ${r.campaign.name.padEnd(25)} ${r.ad_group.name.padEnd(15)} "${c.keyword.text}"  ${chf(cur)} -> default ${chf(def)}  (estimate ${fp ? chf(fp) : '-'})`);
    } else tally.unchanged++;
  }

  console.log(`\nraise ${tally.raise} · reset ${tally.clear} · unchanged ${tally.unchanged}` +
    `  (of the unchanged/reset: cheap<=default ${tally.cheap}, above ceiling ${tally.aboveCeiling}, no estimate/filler ${tally.noEstimate})`);
  if (!ops.length) { console.log('Nothing to change.'); return; }
  if (!APPLY) { console.log('DRY-RUN - nothing was sent to Google Ads.'); return; }
  await customer.adGroupCriteria.update(ops);
  console.log(`Sent ${ops.length} keyword bid update(s).`);
}

if (require.main === module) main().catch(e => {
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 3000));
  process.exit(1);
});
