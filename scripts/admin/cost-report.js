#!/usr/bin/env node
/**
 * Railway cost report — on demand.
 *
 *   npm run cost:report              last 7 days vs the 7 before
 *   npm run cost:report -- --days=30 monthly view
 *   npm run cost:report -- --email   also send it to the admin address
 *
 * The weekly email version runs itself (server/lib/costReport.js); this is the
 * same report for when you want to look right now.
 *
 * Auth: RAILWAY_API_TOKEN from .env, else the Railway CLI login token.
 */

require('dotenv').config();
const os = require('os');
const path = require('path');
const { buildCostReport } = require('../../server/lib/railwayCost');

const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || '5da5a1d8-bac8-4881-9469-84330d81a880';

function getToken() {
  if (process.env.RAILWAY_API_TOKEN) return process.env.RAILWAY_API_TOKEN;
  try {
    const cfg = require(path.join(os.homedir(), '.railway', 'config.json'));
    if (cfg?.user?.token) return cfg.user.token;
  } catch { /* fall through */ }
  console.error('No RAILWAY_API_TOKEN in .env and no Railway CLI login (`railway login`).');
  process.exit(1);
}

const usd = (n) => '$' + n.toFixed(2);

function arrow(cur, prev) {
  if (!prev || prev === 0) return '';
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 1) return '  (flat)';
  return `  (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)`;
}

function print(report) {
  const { current, previous, days } = report;
  console.log(`\nRailway cost — ${report.projectName} — last ${days} days`);
  console.log(`${current.startISO.slice(0, 10)} → ${current.endISO.slice(0, 10)}\n`);

  const w = [26, 11, 10, 9, 9, 9, 10];
  console.log(
    'service / env'.padEnd(w[0]) + 'avg RAM'.padStart(w[1]) + 'memory'.padStart(w[2]) +
    'cpu'.padStart(w[3]) + 'egress'.padStart(w[4]) + 'disk'.padStart(w[5]) + 'TOTAL'.padStart(w[6])
  );
  console.log('-'.repeat(w.reduce((a, b) => a + b, 0)));

  for (const i of current.items) {
    console.log(
      `${i.service} / ${i.environment}`.slice(0, w[0] - 1).padEnd(w[0]) +
      (i.avgResidentGb.toFixed(2) + ' GB').padStart(w[1]) +
      usd(i.cost.memory).padStart(w[2]) +
      usd(i.cost.cpu).padStart(w[3]) +
      usd(i.cost.egress).padStart(w[4]) +
      usd(i.cost.disk).padStart(w[5]) +
      usd(i.cost.total).padStart(w[6]) +
      arrow(i.cost.total, i.previous?.cost.total)
    );
  }

  console.log('-'.repeat(w.reduce((a, b) => a + b, 0)));
  console.log(
    'TOTAL'.padEnd(w[0]) + ''.padStart(w[1]) +
    usd(current.totals.memory).padStart(w[2]) +
    usd(current.totals.cpu).padStart(w[3]) +
    usd(current.totals.egress).padStart(w[4]) +
    usd(current.totals.disk).padStart(w[5]) +
    usd(current.totals.total).padStart(w[6])
  );

  const memShare = current.totals.total > 0 ? (current.totals.memory / current.totals.total) * 100 : 0;
  console.log(`\nprevious ${days} days: ${usd(previous.totals.total)}   ` +
    `change: ${report.deltaTotal >= 0 ? '+' : ''}${usd(report.deltaTotal)}`);
  console.log(`memory is ${memShare.toFixed(0)}% of spend`);
  console.log(`projected monthly at this rate: ${usd(report.projectedMonthly)}\n`);
}

async function main() {
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;
  const report = await buildCostReport({ token: getToken(), projectId: PROJECT_ID, days });
  print(report);

  // AI API spend — the other half of the bill. Needs the database, so it is
  // skipped (with a note, never silently) when no connection string is set.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    try {
      const { buildApiCostReport } = require('../../server/lib/apiCost');
      const api = await buildApiCostReport({ pool, days });
      report.api = api;
      console.log(`AI API spend — last ${days} days (${api.stories} stories, ${api.totals.calls} calls)\n`);
      for (const p of api.providers) {
        console.log('  ' + p.name.padEnd(16) + String(p.calls).padStart(6) + ' calls' + usd(p.total).padStart(10));
      }
      console.log('  ' + 'TOTAL'.padEnd(16) + String(api.totals.calls).padStart(6) + ' calls' + usd(api.totals.total).padStart(10));
      console.log(`  ${usd(api.perStory)} per story · projected ${usd(api.projectedMonthly)}/month`);
      if (api.unpricedTokens) console.log(`  WARNING: ${api.unpricedTokens.toLocaleString()} tokens had no model recorded and are NOT priced`);
      if (api.estimatedTokens) console.log(`  note: ${api.estimatedTokens.toLocaleString()} tokens priced via the configured default model`);
      console.log(`\n  GRAND TOTAL ${usd(report.current.totals.total + api.totals.total)}` +
        `  (Railway ${usd(report.current.totals.total)} + API ${usd(api.totals.total)})` +
        `  -> ${usd(report.projectedMonthly + api.projectedMonthly)}/month\n`);
    } catch (e) {
      console.log(`AI API spend: unavailable (${e.message})\n`);
    } finally {
      await pool.end();
    }
  } else {
    console.log('AI API spend: skipped — DATABASE_URL not set.\n');
  }

  if (process.argv.includes('--email')) {
    const email = require('../../email');
    if (!email.isEmailConfigured || !email.isEmailConfigured()) {
      console.error('Email not configured (RESEND_API_KEY missing) — printed only.');
      process.exit(1);
    }
    const res = await email.sendAdminWeeklyCostReport(report);
    console.log(res ? 'Emailed.' : 'Email send returned null.');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
