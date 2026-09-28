#!/usr/bin/env node
/**
 * Activate (or pause) the week's four Search campaigns at a KNOWN TOTAL daily budget.
 *
 *   node scripts/ads/activate-week.js               # DRY-RUN: prints the plan and the current live state
 *   node scripts/ads/activate-week.js --apply       # set budgets + set each arm to its declared status (ARMS[].status, default ENABLED)
 *   node scripts/ads/activate-week.js --pause --apply   # pause every arm (budgets untouched)
 *
 * Owner mandate 2026-09-21: "activate the campaigns, try at least 3 different ones, total CHF 10 a day
 * for this week to get a bit of signal." The four arms and the split are below; the script REFUSES to run
 * if they do not add up to TOTAL_CAP, so the cap cannot drift by editing one line.
 *
 * Every campaign is Manual CPC — there is no smart bidding to overspend the daily budget beyond Google's
 * usual 2x-daily / monthly-capped delivery. Pausing is the reverse of activating; nothing is destroyed.
 */
const { getClient } = require('./lib/client');
const { enums } = require('google-ads-api');

const APPLY = process.argv.includes('--apply');
const PAUSE = process.argv.includes('--pause');
const CHF = n => Math.round(n * 1e6);
const TOTAL_CAP = 10.00;

// The four arms. `budget` is CHF/day. `status` is the arm's intended state (default ENABLED); a paused arm
// keeps its budget reserved so resuming it is one edit, and the TOTAL_CAP check still holds.
const ARMS = [
  // PAUSED 2026-09-28 (owner): 26-27 Sept = 14 clicks / CHF 11.85 / 0 trials. The clicks were the right people
  // (5 of 14 opened /try) but the pages lose them on phones: 8 of 14 never left the homepage (Google rates its
  // landing-page experience BELOW_AVERAGE on all 5 keywords) and 4 of the 5 who opened /try left on its first
  // screen without a tap. Resume once the phone first screen is fixed.
  { name: 'Search-Deutschschweiz-v1', budget: 3, status: 'PAUSED', why: 'existing high-intent converter (all 9 account conversions came from here)' },
  { name: 'Search-Cheap-Age-CH', budget: 3, why: 'age-gift cluster, CPC cap 0.20 - the most clicks per franc' },
  { name: 'Search-Cheap-Occasion-CH', budget: 2, why: 'Goettikind / Einschulung / Geschwisterkind, mostly unbid tails' },
  { name: 'Search-LifeChallenge-CH', budget: 2, why: 'life-challenge topics (Trotzphase, Schnuller, Eingewoehnung, Aengste) - zero advertisers bidding' },
];

const sum = ARMS.reduce((a, x) => a + x.budget, 0);
if (Math.abs(sum - TOTAL_CAP) > 1e-9) {
  console.error(`REFUSING: arm budgets sum to CHF ${sum.toFixed(2)}/day but TOTAL_CAP is CHF ${TOTAL_CAP.toFixed(2)}/day.`);
  console.error('Change TOTAL_CAP deliberately if the owner raised the cap - do not let it drift.');
  process.exit(1);
}

const q = s => String(s).replace(/'/g, "\\'");
const enumName = (en, v) => (typeof v === 'string' ? v : (enums[en] && enums[en][v]) || String(v));

async function main() {
  const { customer } = getClient();
  if (!customer) throw new Error('Missing refresh_token in scripts/ads/config.json');

  const targetOf = (arm) => (PAUSE ? 'PAUSED' : (arm.status || 'ENABLED'));
  const enabledArms = ARMS.filter((a) => targetOf(a) === 'ENABLED');
  console.log(`Target: ${PAUSE ? 'ALL PAUSED' : `${enabledArms.length} of ${ARMS.length} enabled`} - budgets total CHF ${sum.toFixed(2)}/day, CHF ${enabledArms.reduce((a, x) => a + x.budget, 0).toFixed(2)}/day on enabled arms`);
  console.log(`Mode: ${APPLY ? 'LIVE' : 'DRY-RUN - nothing is sent (pass --apply to execute)'}\n`);

  const names = ARMS.map(a => `'${q(a.name)}'`).join(',');
  const rows = await customer.query(`
    SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status,
           campaign_budget.resource_name, campaign_budget.amount_micros
    FROM campaign WHERE campaign.name IN (${names}) AND campaign.status != 'REMOVED'`);
  const live = new Map(rows.map(r => [r.campaign.name, r]));

  const missing = ARMS.filter(a => !live.has(a.name));
  if (missing.length) {
    console.error(`REFUSING: these campaigns do not exist yet - create them first:\n  ` + missing.map(m => m.name).join('\n  '));
    console.error('\n  node scripts/ads/create-search-cheap.js --set=both --apply');
    console.error('  node scripts/ads/create-search-lifechallenge.js --apply');
    process.exit(1);
  }

  const budgetOps = [];
  const campaignOps = [];
  for (const arm of ARMS) {
    const r = live.get(arm.name);
    const curBudget = r.campaign_budget.amount_micros / 1e6;
    const curStatus = enumName('CampaignStatus', r.campaign.status);
    const wantBudget = CHF(arm.budget);
    const target = targetOf(arm);
    console.log(`${arm.name}`);
    console.log(`  ${arm.why}`);
    console.log(`  budget CHF ${curBudget.toFixed(2)} -> ${arm.budget.toFixed(2)}/day${curBudget === arm.budget ? '  (unchanged)' : ''}`);
    console.log(`  status ${curStatus} -> ${target}${curStatus === target ? '  (unchanged)' : ''}`);
    if (r.campaign_budget.amount_micros !== wantBudget) budgetOps.push({ resource_name: r.campaign_budget.resource_name, amount_micros: wantBudget });
    if (curStatus !== target) campaignOps.push({ resource_name: r.campaign.resource_name, status: enums.CampaignStatus[target] });
    console.log('');
  }

  if (!budgetOps.length && !campaignOps.length) { console.log('Nothing to change - already in the target state.'); return; }
  console.log(`${APPLY ? 'Sending' : 'Would send'} ${budgetOps.length} budget update(s) + ${campaignOps.length} status update(s).`);
  if (!APPLY) { console.log('DRY-RUN - nothing was sent to Google Ads.'); return; }

  if (budgetOps.length) { await customer.campaignBudgets.update(budgetOps); console.log('  budgets updated'); }
  if (campaignOps.length) { await customer.campaigns.update(campaignOps); console.log(`  ${campaignOps.length} campaign status(es) updated`); }
  console.log(`\nDone. Read results with: node scripts/ads/attribution-report.js --days=7`);
}

if (require.main === module) main().catch(e => {
  console.error('ERR:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors, null, 2).slice(0, 3000));
  process.exit(1);
});
