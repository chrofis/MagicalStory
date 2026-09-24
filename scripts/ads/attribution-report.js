#!/usr/bin/env node
/**
 * "Which campaign produced BUYERS, not just trials - and what did each one cost?"
 *
 * Reads our own database, not Google's attribution — trial_events carries the
 * campaign and the user_id, and user_id joins to orders. That means the number
 * survives ad blockers, consent refusal, and the multi-session gap between the
 * click and the purchase (trial finishes in ~3 min, the paid story is created
 * later, generation takes an hour, the buy decision comes after that).
 *
 * SPEND (added 2026-09-23, owner: "we can tell how many trial stories were generated per franc"):
 * the Google Ads cost for the same days is joined on utm_campaign and on (utm_campaign, keyword), giving
 * cost per trial and cost per buyer per campaign and per keyword. The utm_campaign <-> Ads campaign link is
 * read from the live ads (scripts/ads/lib/ads-spend.js), never hand-kept.
 *
 * Run:  node scripts/ads/attribution-report.js              (production, with spend)
 *       node scripts/ads/attribution-report.js --days=7
 *       node scripts/ads/attribution-report.js --no-spend   (counts only - explicit opt-out, e.g. token expired)
 *       node scripts/ads/attribution-report.js --staging    (counts only: staging has no ad clicks)
 *
 * The window is WHOLE Swiss days (today and the N-1 days before it), because Google reports cost per
 * account-timezone day; a rolling NOW()-N window would compare different hours on each side of the join.
 * If the Ads API call fails the report stops with the reason - a missing spend column is never printed
 * as zero spend.
 *
 * Reads DATABASE_URL / STAGING_DATABASE_URL from .env.
 *
 * NOTE ON HISTORY: attribution cannot be backfilled. Rows written before the
 * 2026-08-26 fix (App.tsx capture at mount + migration 030) have a null
 * campaign no matter what — the tags were dropped on the homepage before
 * anything read them. Only clicks after that deploy appear here.
 */
require('dotenv').config();
const { Pool } = require('pg');
const { ch } = require('../lib/chTime');
const { fetchSpend } = require('./lib/ads-spend');

const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=90').split('=')[1]);
const STAGING = process.argv.includes('--staging');
const WITH_SPEND = !STAGING && !process.argv.includes('--no-spend');
const CONN = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
const TZ = 'Europe/Zurich'; // the Google Ads account timezone - verified customers/6507339241, 2026-09-21

const COMPLETED_STEP = 'generation_completed';

// Verified against production 2026-08-26: orders has payment_status (values
// 'paid' | 'completed' | 'failed') and amount_total in CENTS — not `status` /
// `amount_cents`. credit_transactions has no rows with price_cents > 0, i.e.
// no credit pack has ever been sold, so orders is currently the only revenue
// source. If credit packs start selling, add them as a second buyer source.
const PAID_STATUSES = "('paid', 'completed')";

// YYYY-MM-DD of today in Swiss time, and of N-1 days earlier (date-only arithmetic, DST-safe).
function swissWindow(days) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { startDate: d.toISOString().slice(0, 10), endDate: today };
}

const money = (micros) => `CHF ${(micros / 1e6).toFixed(2)}`;
// '-' = nothing was spent (organic rows, or a campaign with impressions but no click); 'no ' = money spent
// and zero of that outcome. Never CHF 0.00 per trial: that would read as free paid trials.
const per = (micros, n) => (!micros ? '-' : n ? money(micros / n) : 'no ');

// Site-visit events (site_arrival / site_exit, since 2026-09-24): did the ad click load the page, how long
// did the visitor stay, did they look beyond the landing page. One visit = one row per step, so MAX() reads
// the single value. Dwell is readable after a dozen clicks where trial counts need hundreds.
const VISIT_SITE_COLUMNS = `BOOL_OR(step = 'site_arrival') AS arrived,
             MAX((meta->>'seconds')::int) FILTER (WHERE step = 'site_exit') AS seconds,
             MAX((meta->>'pages')::int)   FILTER (WHERE step = 'site_exit') AS pages`;
const SITE_AGGREGATES = `COUNT(*) FILTER (WHERE v.arrived) AS arrived,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.seconds) FILTER (WHERE v.arrived) AS median_seconds,
           COUNT(*) FILTER (WHERE v.arrived AND v.pages > 1) AS multi_page`;
/** "arrived  med s  >1pg" cells; '-' where no ad-tagged arrival was recorded. */
const siteCells = (r) => {
  const a = Number(r.arrived || 0);
  const med = r.median_seconds == null ? '-' : `${Math.round(Number(r.median_seconds))}s`;
  return `${String(a).padStart(7)}  ${(a ? med : '-').padStart(5)}  ${(a ? String(r.multi_page) : '-').padStart(4)}`;
};

async function main() {
  if (!CONN) {
    console.error(`Missing ${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} in .env`);
    process.exit(1);
  }
  if (!Number.isInteger(DAYS) || DAYS < 1) throw new Error('--days must be a positive integer');
  const { startDate, endDate } = swissWindow(DAYS);

  // Spend first: if Google cannot be read, stop before printing anything that looks like a result.
  let spend = null;
  if (WITH_SPEND) {
    try {
      spend = await fetchSpend({ startDate, endDate });
    } catch (e) {
      console.error(`ERR reading Google Ads spend: ${e.message}`);
      console.error('  If the token expired (invalid_grant): node scripts/ads/authorize.js');
      console.error('  For trial counts without spend, re-run with --no-spend.');
      process.exit(1);
    }
  }

  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  // Swiss midnight of startDate as an instant; trial_events.created_at is timestamptz.
  const SINCE = `(($2::date)::timestamp AT TIME ZONE '${TZ}')`;

  console.log(`\n=== Attribution: ${STAGING ? 'STAGING' : 'PRODUCTION'}, ${startDate} .. ${endDate} (${DAYS} Swiss days, as of ${ch(new Date())}) ===`);
  console.log(WITH_SPEND ? '    spend: Google Ads, same days' : `    spend: not included (${STAGING ? 'staging has no ad clicks' : '--no-spend'})`);

  // One row per campaign: visitors, how many finished a trial, how many became
  // paying customers. COUNT(DISTINCT) throughout because trial_events holds one
  // row per step, not per visitor.
  const { rows } = await pool.query(`
    WITH visit AS (
      SELECT visit_id,
             MAX(utm_source)   AS utm_source,
             MAX(utm_campaign) AS utm_campaign,
             MAX(gclid)        AS gclid,
             MAX(user_id)      AS user_id,
             BOOL_OR(step = $1) AS completed_trial,
             ${VISIT_SITE_COLUMNS}
        FROM trial_events
       WHERE created_at >= ${SINCE}
       GROUP BY visit_id
    )
    SELECT COALESCE(v.utm_campaign, CASE WHEN v.gclid IS NOT NULL THEN '(paid, untagged)'
                                         WHEN v.utm_source IS NOT NULL THEN v.utm_source
                                         ELSE '(organic / direct)' END) AS campaign,
           COUNT(*)                                              AS visits,
           ${SITE_AGGREGATES},
           COUNT(*) FILTER (WHERE v.completed_trial)              AS trials,
           COUNT(DISTINCT v.user_id)                              AS accounts,
           COUNT(DISTINCT o.user_id)                              AS buyers,
           COALESCE(SUM(o.amount_total), 0)                       AS revenue_cents
      FROM visit v
      LEFT JOIN orders o
        ON o.user_id = v.user_id
       AND o.payment_status IN ${PAID_STATUSES}
     GROUP BY 1
     ORDER BY visits DESC`, [COMPLETED_STEP, startDate]);

  // Union with campaigns that SPENT but produced no visit at all - those are the ones that matter most.
  const camp = new Map(rows.map((r) => [r.campaign, { ...r, impressions: 0, clicks: 0, costMicros: 0, adsNames: '' }]));
  if (spend) {
    for (const [utm, s] of spend.byUtmCampaign) {
      const e = camp.get(utm) || { campaign: utm, visits: 0, arrived: 0, median_seconds: null, multi_page: 0, trials: 0, accounts: 0, buyers: 0, revenue_cents: 0 };
      Object.assign(e, { impressions: s.impressions, clicks: s.clicks, costMicros: s.costMicros, adsNames: [...s.campaigns].join(', ') });
      camp.set(utm, e);
    }
  }
  const campRows = [...camp.values()].sort((a, b) => (b.costMicros || 0) - (a.costMicros || 0) || Number(b.visits) - Number(a.visits));

  if (!campRows.length) {
    console.log('\n  No trial_events rows and no ad spend in this window.');
  } else {
    console.log('\n  ' + (spend ? '  impr  clicks        spend ' : '') + 'arrived  med s  >1pg  visits  trials  accts  buyers     revenue' +
      (spend ? '   CHF/trial   CHF/buyer' : '') + '  campaign');
    for (const r of campRows) {
      const rev = (Number(r.revenue_cents) / 100).toFixed(2);
      const s = spend
        ? `${String(r.impressions || 0).padStart(6)}  ${String(r.clicks || 0).padStart(6)}  ${money(r.costMicros || 0).padStart(11)} `
        : '';
      const c = spend
        ? `  ${per(r.costMicros || 0, Number(r.trials)).padStart(10)}  ${per(r.costMicros || 0, Number(r.buyers)).padStart(10)}`
        : '';
      console.log(
        `  ${s}${siteCells(r)}  ${String(r.visits).padStart(6)}  ${String(r.trials).padStart(6)}  ` +
        `${String(r.accounts).padStart(5)}  ${String(r.buyers).padStart(6)}  CHF ${rev.padStart(7)}${c}  ` +
        `${r.campaign}${r.adsNames && r.adsNames !== r.campaign ? `  [${r.adsNames}]` : ''}`
      );
    }
    const t = campRows.reduce((a, r) => ({
      v: a.v + Number(r.visits), t: a.t + Number(r.trials), b: a.b + Number(r.buyers),
      k: a.k + (r.clicks || 0), c: a.c + (r.costMicros || 0),
    }), { v: 0, t: 0, b: 0, k: 0, c: 0 });
    console.log(`\n  TOTAL ${t.v} visits -> ${t.t} completed trials (${t.v ? (100 * t.t / t.v).toFixed(1) : '0'}%) -> ${t.b} buyers`);
    if (spend) {
      const paid = campRows.filter((r) => r.costMicros);
      const pt = paid.reduce((a, r) => ({ t: a.t + Number(r.trials), b: a.b + Number(r.buyers) }), { t: 0, b: 0 });
      console.log(`  PAID  ${t.k} clicks, ${money(t.c)} -> ${pt.t} trials (${per(t.c, pt.t).trim()}/trial) -> ${pt.b} buyers (${per(t.c, pt.b).trim()}/buyer)`);
      console.log('  ("no " = money spent and none of that outcome. clicks vs arrived: a paid click whose page never ran our code');
      console.log('   is not an arrival. med s = median seconds on site until the visitor first left; >1pg = viewed more');
      console.log('   than the landing page. Both come from the exit event, which is sent while the page unloads and');
      console.log('   arrived for ~95% of visits in testing (Chrome + Safari engine, 2026-09-24): an arrival with no exit');
      console.log('   is a lost exit, not a visitor who never left. Arrivals are recorded from 2026-09-24 on.)');
    }
  }

  // Keyword level, only meaningful where the ads carry utm_term={keyword}.
  const kw = await pool.query(`
    WITH visit AS (
      SELECT visit_id, MAX(utm_campaign) AS utm_campaign, LOWER(MAX(utm_term)) AS utm_term, MAX(user_id) AS user_id,
             BOOL_OR(step = $1) AS completed_trial,
             ${VISIT_SITE_COLUMNS}
        FROM trial_events WHERE created_at >= ${SINCE} GROUP BY visit_id
    )
    SELECT v.utm_campaign, v.utm_term, COUNT(*) visits, ${SITE_AGGREGATES},
           COUNT(*) FILTER (WHERE v.completed_trial) trials,
           COUNT(DISTINCT o.user_id) buyers
      FROM visit v
      LEFT JOIN orders o ON o.user_id = v.user_id
       AND o.payment_status IN ${PAID_STATUSES}
     WHERE v.utm_term IS NOT NULL
     GROUP BY 1, 2`, [COMPLETED_STEP, startDate]);

  const kwMap = new Map(kw.rows.map((r) => [`${r.utm_campaign}|${r.utm_term}`, { ...r, clicks: 0, costMicros: 0, adGroup: '' }]));
  if (spend) {
    for (const [key, s] of spend.byKeyword) {
      const [utm] = key.split('|');
      const e = kwMap.get(key) || { utm_campaign: utm, utm_term: s.keyword, visits: 0, arrived: 0, median_seconds: null, multi_page: 0, trials: 0, buyers: 0 };
      Object.assign(e, { clicks: s.clicks, costMicros: s.costMicros, adGroup: s.adGroup });
      kwMap.set(key, e);
    }
  }
  const kwRows = [...kwMap.values()].sort((a, b) => (b.costMicros || 0) - (a.costMicros || 0) || Number(b.visits) - Number(a.visits)).slice(0, 40);

  console.log('\n=== by keyword (needs utm_term={keyword} on the ad URL) ===');
  if (!kwRows.length) {
    console.log('  No keyword has a click or a tagged visit in this window yet.');
  } else {
    console.log('  ' + (spend ? 'clicks        spend  ' : '') + 'arrived  med s  >1pg  visits  trials  buyers' + (spend ? '   CHF/trial' : '') + '  campaign / keyword');
    for (const r of kwRows) {
      const s = spend ? `${String(r.clicks || 0).padStart(6)}  ${money(r.costMicros || 0).padStart(11)}  ` : '';
      const c = spend ? `  ${per(r.costMicros || 0, Number(r.trials)).padStart(10)}` : '';
      console.log(`  ${s}${siteCells(r)}  ${String(r.visits).padStart(6)}  ${String(r.trials).padStart(6)}  ${String(r.buyers).padStart(6)}${c}  ${r.utm_campaign} / ${r.utm_term}`);
    }
    console.log('  Keyword counts stay 0-1 for a long time at Swiss volume - read verdicts at campaign / ad-group level.');
  }

  // GCLIDs of users who bought: the exact payload for a Google Ads offline
  // conversion import, which is how a days-later purchase gets attributed back
  // to the click that paid for it.
  const g = await pool.query(`
    SELECT DISTINCT te.gclid, o.created_at, o.amount_total
      FROM trial_events te
      JOIN orders o ON o.user_id = te.user_id
       AND o.payment_status IN ${PAID_STATUSES}
     WHERE te.gclid IS NOT NULL AND te.created_at >= ((($1::date)::timestamp AT TIME ZONE '${TZ}'))
     ORDER BY o.created_at DESC LIMIT 50`, [startDate]);
  console.log(`\n=== buyers with a gclid (ready for offline conversion import): ${g.rows.length} ===`);
  for (const r of g.rows) {
    console.log(`  ${ch(r.created_at)}  CHF ${(Number(r.amount_total) / 100).toFixed(2).padStart(7)}  ${r.gclid.slice(0, 40)}…`);
  }
  if (!g.rows.length) console.log('  (none yet — expected until tagged clicks start converting)');

  await pool.end();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
