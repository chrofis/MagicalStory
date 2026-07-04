#!/usr/bin/env node
/**
 * Weekly Google Ads health snapshot for Search-Deutschschweiz-v1.
 * Run: node scripts/ads/weekly-report.js
 *
 * Tracks the levers we're improving:
 *  - Volume + cost + CTR (7d)
 *  - Impression share and WHY we lose auctions (rank vs budget)
 *  - Quality Score per keyword + the three component buckets
 *  - Conversions (7d) by action
 *
 * Watch over the coming weeks: impression share ↑, lost-to-rank ↓, QS component
 * buckets (esp. Landing page experience) moving Below → Average → Above as the
 * speed + hero + assets changes accrue field history.
 */
const { getClient } = require('./lib/client');
const CAMPAIGN = 'Search-Deutschschweiz-v1';
const BUCKET = { 0: '?', 1: '?', 2: 'BELOW', 3: 'Avg', 4: 'ABOVE' };

async function main() {
  const { customer } = getClient();

  // ── 7-day totals + impression share ──
  const [c] = await customer.query(`
    SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
           metrics.ctr, metrics.average_cpc, metrics.search_impression_share,
           metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
    FROM campaign WHERE campaign.name='${CAMPAIGN}' AND segments.date DURING LAST_7_DAYS`);
  const m = c ? c.metrics : {};
  const is = m.search_impression_share || 0;
  const eligible = is > 0 ? (m.impressions || 0) / is : 0;
  console.log(`\n=== ${CAMPAIGN} — last 7 days ===`);
  console.log(`  impressions ${m.impressions || 0} | clicks ${m.clicks || 0} | cost CHF ${((m.cost_micros || 0) / 1e6).toFixed(2)} | CTR ${((m.ctr || 0) * 100).toFixed(2)}% | avgCPC CHF ${((m.average_cpc || 0) / 1e6).toFixed(2)}`);
  console.log(`  impression share ${(is * 100).toFixed(1)}%  |  lost to RANK ${((m.search_rank_lost_impression_share || 0) * 100).toFixed(1)}% (~${Math.round(eligible * (m.search_rank_lost_impression_share || 0))} auctions)  |  lost to BUDGET ${((m.search_budget_lost_impression_share || 0) * 100).toFixed(1)}%`);
  console.log(`  conversions ${(m.conversions || 0).toFixed(1)}`);

  // ── Quality Score per keyword ──
  const kw = await customer.query(`
    SELECT ad_group_criterion.keyword.text,
           ad_group_criterion.quality_info.quality_score,
           ad_group_criterion.quality_info.creative_quality_score,
           ad_group_criterion.quality_info.search_predicted_ctr,
           ad_group_criterion.quality_info.post_click_quality_score
    FROM keyword_view WHERE campaign.name='${CAMPAIGN}' AND ad_group_criterion.status='ENABLED'`);
  console.log('\n  Quality Score (QS | AdRel | ExpCTR | LandingPage):');
  for (const r of kw) {
    const q = r.ad_group_criterion.quality_info || {};
    if (q.quality_score == null) continue;
    console.log(`    ${q.quality_score}  ${(BUCKET[q.creative_quality_score] || '-').padEnd(5)} ${(BUCKET[q.search_predicted_ctr] || '-').padEnd(5)} ${(BUCKET[q.post_click_quality_score] || '-').padEnd(5)}  ${r.ad_group_criterion.keyword.text}`);
  }

  // ── Conversions by action (7d) ──
  const conv = await customer.query(`
    SELECT segments.conversion_action_name, metrics.conversions
    FROM campaign WHERE campaign.name='${CAMPAIGN}' AND segments.date DURING LAST_7_DAYS AND metrics.conversions > 0`);
  console.log('\n  Conversions (7d) by action:');
  if (!conv.length) console.log('    none');
  for (const r of conv) console.log(`    ${r.segments.conversion_action_name}: ${r.metrics.conversions}`);
  console.log('');
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
