#!/usr/bin/env node
/**
 * Make a campaign's clicks carry their keyword, without rebuilding its ads.
 *
 *   node scripts/ads/set-keyword-suffix.js --campaign=Search-Deutschschweiz-v1            # DRY-RUN
 *   node scripts/ads/set-keyword-suffix.js --campaign=Search-Deutschschweiz-v1 --apply    # LIVE
 *
 * Sets the campaign-level Final URL suffix to `utm_term={keyword}`. Google appends the suffix to every
 * final URL in the campaign (with `&` when the URL already has a query string) and fills {keyword} with the
 * keyword that matched. trial_events captures utm_term, so attribution-report.js can then read the
 * campaign per keyword and cost per trial per keyword.
 *
 * Why a suffix and not new final URLs: RSAs cannot be edited in place - changing a final URL means
 * replacing the ad, which resets its review and history. The suffix is tracking-only.
 *
 * Owner decision 2026-09-23: tag Search-Deutschschweiz-v1, the expensive arm (CHF 1+ clicks), which was the
 * only live campaign without utm_term. The three cheap campaigns already carry it in their final URLs.
 * Refuses to touch a campaign whose ads already carry utm_term (the tag would be duplicated).
 */
const { getClient } = require('./lib/client');

const APPLY = process.argv.includes('--apply');
const NAME = (process.argv.find(a => a.startsWith('--campaign=')) || '').slice(11);
const SUFFIX = 'utm_term={keyword}';

async function main() {
  if (!NAME) { console.error('Usage: node scripts/ads/set-keyword-suffix.js --campaign=<name> [--apply]'); process.exit(1); }
  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json');
  const q = NAME.replace(/'/g, "\\'");

  const camps = await customer.query(`SELECT campaign.resource_name, campaign.final_url_suffix, campaign.tracking_url_template
    FROM campaign WHERE campaign.name = '${q}' AND campaign.status != 'REMOVED'`);
  if (camps.length !== 1) throw new Error(`Expected exactly one campaign named ${NAME}, found ${camps.length}`);
  const c = camps[0].campaign;

  const ads = await customer.query(`SELECT ad_group_ad.ad.final_urls FROM ad_group_ad
    WHERE campaign.name = '${q}' AND ad_group_ad.status != 'REMOVED'`);
  const tagged = ads.filter(a => (a.ad_group_ad.ad.final_urls || []).some(u => u.includes('utm_term=')));
  if (tagged.length) throw new Error(`${tagged.length} ad(s) in ${NAME} already carry utm_term in the final URL - a suffix would duplicate it`);

  console.log(`Campaign: ${NAME}`);
  console.log(`  final_url_suffix: ${JSON.stringify(c.final_url_suffix || '')} -> ${JSON.stringify(SUFFIX)}`);
  if (c.tracking_url_template) console.log(`  (tracking template present, untouched: ${c.tracking_url_template})`);
  for (const a of ads) {
    const u = (a.ad_group_ad.ad.final_urls || [])[0];
    if (u) console.log(`  landing becomes: ${u}${u.includes('?') ? '&' : '?'}${SUFFIX}`);
  }
  if (c.final_url_suffix === SUFFIX) { console.log('Already set - nothing to change.'); return; }
  if (c.final_url_suffix) throw new Error(`Campaign already has a different suffix (${c.final_url_suffix}) - refusing to overwrite it`);
  if (!APPLY) { console.log('DRY-RUN - nothing was sent to Google Ads.'); return; }
  await customer.campaigns.update([{ resource_name: c.resource_name, final_url_suffix: SUFFIX }]);
  console.log('Suffix set.');
}

if (require.main === module) main().catch(e => {
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 3000));
  process.exit(1);
});
