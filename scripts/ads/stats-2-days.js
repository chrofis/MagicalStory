#!/usr/bin/env node
/**
 * One-shot: today + yesterday Google Ads stats, per campaign.
 * Usage: node scripts/ads/stats-2-days.js
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

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const dates = new Set([fmt(today), fmt(yest)]);
  const filtered = rows.filter((r) => dates.has(r.segments.date));

  console.log('Today:', fmt(today), '— Yesterday:', fmt(yest));
  console.log('');

  const byCampDay = {};
  for (const r of filtered) {
    const k = r.segments.date + ' | ' + r.campaign.name;
    byCampDay[k] = byCampDay[k] || { impr: 0, clicks: 0, cost: 0, conv: 0 };
    byCampDay[k].impr   += Number(r.metrics.impressions || 0);
    byCampDay[k].clicks += Number(r.metrics.clicks || 0);
    byCampDay[k].cost   += Number(r.metrics.cost_micros || 0);
    byCampDay[k].conv   += Number(r.metrics.conversions || 0);
  }

  let totImpr = 0, totClicks = 0, totCost = 0, totConv = 0;
  console.log('Date       | Campaign                 | Impr | Clicks | Cost CHF | Conv');
  console.log('-----------|--------------------------|-----:|-------:|---------:|-----:');
  for (const [k, v] of Object.entries(byCampDay).sort()) {
    const [date, name] = k.split(' | ');
    const cost = (v.cost / 1e6).toFixed(2);
    console.log(
      date.padEnd(10), '|', name.padEnd(25), '|',
      String(v.impr).padStart(4), '|', String(v.clicks).padStart(6), '|',
      cost.padStart(8), '|', String(v.conv).padStart(4)
    );
    totImpr += v.impr; totClicks += v.clicks; totCost += v.cost; totConv += v.conv;
  }
  console.log('');
  console.log(
    'TOTAL 2d:', totImpr, 'impr,', totClicks, 'clicks, CHF',
    (totCost / 1e6).toFixed(2), ',', totConv.toFixed(2), 'conv'
  );
}

main().catch((e) => { console.error(e.message); process.exit(1); });
