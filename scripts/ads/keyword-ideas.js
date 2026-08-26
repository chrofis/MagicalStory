#!/usr/bin/env node
/**
 * Keyword Planner discovery: what should we bid on that we are not bidding on?
 *
 * Run: node scripts/ads/keyword-ideas.js            (German, Switzerland)
 *      node scripts/ads/keyword-ideas.js --lang=fr
 *
 * Seeds come from three places, all evidence-based:
 *  1. the creation-intent cluster the SEO audit found least contested
 *  2. search terms that actually converted in the account (2026-01..08)
 *  3. the AI angle, which the account has zero keywords for
 *
 * Output is sorted CHEAPEST FIRST among ideas with real volume, and marks
 * anything already in the account so it is not double-counted.
 */
const { getClient } = require('./lib/client');

const GEO_CH = 'geoTargetConstants/2756';
const LANG = { de: 'languageConstants/1001', fr: 'languageConstants/1002', en: 'languageConstants/1000' };
const COMP = { 0: '?', 1: 'UNSPEC', 2: 'LOW', 3: 'MEDIUM', 4: 'HIGH' };

const SEEDS = {
  de: [
    'kinderbuch mit ki erstellen', 'ki kinderbuch', 'kinderbuch generator',
    'kinderbuch selber schreiben', 'kinderbuch selber gestalten',
    'eigenes bilderbuch erstellen', 'eigene geschichte schreiben lassen',
    'personalisiertes kinderbuch mit eigenen fotos',
    'kinderbuch mit eigenem namen als hauptdarsteller',
    'personalisiertes buch kindergarten', 'individuelle geschichte kind',
    'gute nacht geschichte personalisiert', 'buch zur einschulung personalisiert',
  ],
  fr: [
    'livre personnalisé enfant', 'créer livre enfant ia', 'histoire personnalisée enfant',
    'livre photo enfant personnalisé', 'écrire histoire pour enfant',
  ],
  en: [
    'ai childrens book generator', 'create childrens book with ai',
    'personalized childrens book photo', 'write my own childrens story',
  ],
};

async function main() {
  const langArg = (process.argv.find((a) => a.startsWith('--lang=')) || '--lang=de').split('=')[1];
  const { customer } = getClient();

  // Keywords already live in the account — so we can flag duplicates.
  const existing = new Set();
  const kws = await customer.query(`
    SELECT ad_group_criterion.keyword.text FROM ad_group_criterion
    WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = false`);
  for (const r of kws) existing.add(r.ad_group_criterion.keyword.text.toLowerCase());

  const negatives = new Set();
  const negs = await customer.query(`
    SELECT campaign_criterion.keyword.text FROM campaign_criterion
    WHERE campaign_criterion.negative = true AND campaign_criterion.type = 'KEYWORD'`);
  for (const r of negs) negatives.add(r.campaign_criterion.keyword.text.toLowerCase());

  const res = await customer.keywordPlanIdeas.generateKeywordIdeas({
    customer_id: customer.credentials.customer_id,
    language: LANG[langArg],
    geo_target_constants: [GEO_CH],
    include_adult_keywords: false,
    keyword_seed: { keywords: SEEDS[langArg] },
  });

  const rows = [];
  for (const r of res) {
    const m = r.keyword_idea_metrics || {};
    const vol = Number(m.avg_monthly_searches || 0);
    if (vol < 10) continue;                       // no volume, no point
    const text = r.text.toLowerCase();
    if ([...negatives].some((n) => text.includes(n))) continue;   // we already excluded it
    const low = Number(m.low_top_of_page_bid_micros || 0) / 1e6;
    const high = Number(m.high_top_of_page_bid_micros || 0) / 1e6;
    rows.push({ text, vol, comp: COMP[m.competition] || '?', low, high, have: existing.has(text) });
  }

  // Cheapest first among things we do NOT already have.
  const fresh = rows.filter((r) => !r.have).sort((a, b) => (a.high || 99) - (b.high || 99) || b.vol - a.vol);

  console.log(`\n=== ${langArg.toUpperCase()} / Switzerland — ${rows.length} ideas with volume, ${fresh.length} not yet bid on ===`);
  console.log('  vol/mo  comp    top-of-page bid   keyword');
  for (const r of fresh.slice(0, 60)) {
    console.log(`  ${String(r.vol).padStart(6)}  ${r.comp.padEnd(6)}  CHF ${r.low.toFixed(2)}-${r.high.toFixed(2)}`.padEnd(46) + `  ${r.text}`);
  }
  const already = rows.filter((r) => r.have);
  if (already.length) {
    console.log(`\n  -- already in the account (${already.length}) --`);
    for (const r of already) console.log(`  ${String(r.vol).padStart(6)}  ${r.comp.padEnd(6)}  CHF ${r.low.toFixed(2)}-${r.high.toFixed(2)}`.padEnd(46) + `  ${r.text}`);
  }
}

main().catch((e) => console.error('ERR', (e.message || JSON.stringify(e)).slice(0, 400)));
