#!/usr/bin/env node
/**
 * Google Ads performance — last 5 days, per campaign + daily totals.
 * Usage: node scripts/ads/stats-5-days.js
 */
const { getClient } = require('./lib/client');

async function main() {
  const { customer } = getClient();
  const rows = await customer.query(`
    SELECT campaign.name, segments.date,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions
    FROM campaign
    WHERE segments.date DURING LAST_7_DAYS
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date DESC, campaign.name
  `);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 0; i < 5; i++) { const d = new Date(today); d.setDate(d.getDate() - i); days.push(fmt(d)); }
  const dayset = new Set(days);
  const filtered = rows.filter((r) => dayset.has(r.segments.date));

  console.log('Window:', days[days.length - 1], '→', days[0], '(last 5 days)\n');

  // per campaign (5-day total)
  const byCamp = {}; const byDay = {};
  for (const r of filtered) {
    const c = r.campaign.name;
    byCamp[c] = byCamp[c] || { impr: 0, clicks: 0, cost: 0, conv: 0 };
    byDay[r.segments.date] = byDay[r.segments.date] || { impr: 0, clicks: 0, cost: 0, conv: 0 };
    for (const bucket of [byCamp[c], byDay[r.segments.date]]) {
      bucket.impr += Number(r.metrics.impressions || 0);
      bucket.clicks += Number(r.metrics.clicks || 0);
      bucket.cost += Number(r.metrics.cost_micros || 0);
      bucket.conv += Number(r.metrics.conversions || 0);
    }
  }

  const line = (a, b, c, d, e) => `${String(a).padEnd(28)}| ${String(b).padStart(5)} | ${String(c).padStart(6)} | ${String(d).padStart(9)} | ${String(e).padStart(5)}`;
  console.log('PER CAMPAIGN (5-day total)');
  console.log(line('Campaign', 'Impr', 'Clicks', 'Cost CHF', 'Conv'));
  console.log('-'.repeat(66));
  let T = { impr: 0, clicks: 0, cost: 0, conv: 0 };
  for (const [c, v] of Object.entries(byCamp).sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(line(c, v.impr, v.clicks, (v.cost / 1e6).toFixed(2), v.conv.toFixed(1)));
    T.impr += v.impr; T.clicks += v.clicks; T.cost += v.cost; T.conv += v.conv;
  }
  console.log('-'.repeat(66));
  console.log(line('TOTAL', T.impr, T.clicks, (T.cost / 1e6).toFixed(2), T.conv.toFixed(1)));

  console.log('\nPER DAY (all campaigns)');
  console.log(line('Date', 'Impr', 'Clicks', 'Cost CHF', 'Conv'));
  console.log('-'.repeat(66));
  for (const d of days) {
    const v = byDay[d] || { impr: 0, clicks: 0, cost: 0, conv: 0 };
    console.log(line(d, v.impr, v.clicks, (v.cost / 1e6).toFixed(2), v.conv.toFixed(1)));
  }
  const ctr = T.impr ? (100 * T.clicks / T.impr).toFixed(2) : '0';
  const cpc = T.clicks ? (T.cost / 1e6 / T.clicks).toFixed(2) : '0';
  console.log(`\n5-day: CTR ${ctr}%, avg CPC CHF ${cpc}, cost/conv CHF ${T.conv ? (T.cost / 1e6 / T.conv).toFixed(2) : 'n/a'}`);
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
