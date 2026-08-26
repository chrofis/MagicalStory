#!/usr/bin/env node
/**
 * "Which campaign produced BUYERS, not just trials?"
 *
 * Reads our own database, not Google's attribution — trial_events carries the
 * campaign and the user_id, and user_id joins to orders. That means the number
 * survives ad blockers, consent refusal, and the multi-session gap between the
 * click and the purchase (trial finishes in ~3 min, the paid story is created
 * later, generation takes an hour, the buy decision comes after that).
 *
 * Run:  node scripts/ads/attribution-report.js              (production)
 *       node scripts/ads/attribution-report.js --staging
 *       node scripts/ads/attribution-report.js --days=30
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

const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=90').split('=')[1]);
const STAGING = process.argv.includes('--staging');
const CONN = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;

const COMPLETED_STEP = 'generation_completed';

// Verified against production 2026-08-26: orders has payment_status (values
// 'paid' | 'completed' | 'failed') and amount_total in CENTS — not `status` /
// `amount_cents`. credit_transactions has no rows with price_cents > 0, i.e.
// no credit pack has ever been sold, so orders is currently the only revenue
// source. If credit packs start selling, add them as a second buyer source.
const PAID_STATUSES = "('paid', 'completed')";

async function main() {
  if (!CONN) {
    console.error(`Missing ${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} in .env`);
    process.exit(1);
  }
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  const since = `NOW() - INTERVAL '${DAYS} days'`;

  console.log(`\n=== Attribution: ${STAGING ? 'STAGING' : 'PRODUCTION'}, last ${DAYS} days (as of ${ch(new Date())}) ===`);

  // One row per campaign: visitors, how many finished a trial, how many became
  // paying customers. COUNT(DISTINCT) throughout because trial_events holds one
  // row per step, not per visitor.
  const { rows } = await pool.query(`
    WITH visit AS (
      SELECT visit_id,
             MAX(utm_source)   AS utm_source,
             MAX(utm_campaign) AS utm_campaign,
             MAX(utm_term)     AS utm_term,
             MAX(gclid)        AS gclid,
             MAX(user_id)      AS user_id,
             BOOL_OR(step = $1) AS completed_trial
        FROM trial_events
       WHERE created_at >= ${since}
       GROUP BY visit_id
    )
    SELECT COALESCE(v.utm_campaign, CASE WHEN v.gclid IS NOT NULL THEN '(paid, untagged)'
                                         WHEN v.utm_source IS NOT NULL THEN v.utm_source
                                         ELSE '(organic / direct)' END) AS campaign,
           COUNT(*)                                              AS visits,
           COUNT(*) FILTER (WHERE v.completed_trial)              AS trials,
           COUNT(DISTINCT v.user_id)                              AS accounts,
           COUNT(DISTINCT o.user_id)                              AS buyers,
           COALESCE(SUM(o.amount_total), 0)                       AS revenue_cents
      FROM visit v
      LEFT JOIN orders o
        ON o.user_id = v.user_id
       AND o.payment_status IN ('paid', 'completed')
     GROUP BY 1
     ORDER BY visits DESC`, [COMPLETED_STEP]);

  if (!rows.length) {
    console.log('\n  No trial_events rows in this window.');
  } else {
    console.log('\n  visits  trials  accts  buyers   revenue  campaign');
    for (const r of rows) {
      const rev = (Number(r.revenue_cents) / 100).toFixed(2);
      console.log(
        `  ${String(r.visits).padStart(6)}  ${String(r.trials).padStart(6)}  ` +
        `${String(r.accounts).padStart(5)}  ${String(r.buyers).padStart(6)}  ` +
        `CHF ${rev.padStart(7)}  ${r.campaign}`
      );
    }
    const t = rows.reduce((a, r) => ({
      v: a.v + Number(r.visits), t: a.t + Number(r.trials), b: a.b + Number(r.buyers),
    }), { v: 0, t: 0, b: 0 });
    console.log(`\n  TOTAL ${t.v} visits -> ${t.t} completed trials (${t.v ? (100 * t.t / t.v).toFixed(1) : '0'}%) -> ${t.b} buyers`);
  }

  // Keyword level, only meaningful once the ads carry utm_term={keyword}.
  const kw = await pool.query(`
    WITH visit AS (
      SELECT visit_id, MAX(utm_term) AS utm_term, MAX(user_id) AS user_id,
             BOOL_OR(step = $1) AS completed_trial
        FROM trial_events WHERE created_at >= ${since} GROUP BY visit_id
    )
    SELECT v.utm_term, COUNT(*) visits, COUNT(*) FILTER (WHERE v.completed_trial) trials,
           COUNT(DISTINCT o.user_id) buyers
      FROM visit v
      LEFT JOIN orders o ON o.user_id = v.user_id
       AND o.payment_status IN ('paid','completed')
     WHERE v.utm_term IS NOT NULL
     GROUP BY 1 ORDER BY visits DESC LIMIT 25`, [COMPLETED_STEP]);

  console.log('\n=== by keyword (needs utm_term={keyword} on the ad final URL) ===');
  if (!kw.rows.length) {
    console.log('  No rows carry utm_term yet — add ?utm_term={keyword} to the ads, or the');
    console.log('  campaign column above is as granular as this can get.');
  } else {
    console.log('  visits  trials  buyers  keyword');
    for (const r of kw.rows) {
      console.log(`  ${String(r.visits).padStart(6)}  ${String(r.trials).padStart(6)}  ${String(r.buyers).padStart(6)}  ${r.utm_term}`);
    }
  }

  // GCLIDs of users who bought: the exact payload for a Google Ads offline
  // conversion import, which is how a days-later purchase gets attributed back
  // to the click that paid for it.
  const g = await pool.query(`
    SELECT DISTINCT te.gclid, o.created_at, o.amount_total
      FROM trial_events te
      JOIN orders o ON o.user_id = te.user_id
       AND o.payment_status IN ('paid','completed')
     WHERE te.gclid IS NOT NULL AND te.created_at >= ${since}
     ORDER BY o.created_at DESC LIMIT 50`);
  console.log(`\n=== buyers with a gclid (ready for offline conversion import): ${g.rows.length} ===`);
  for (const r of g.rows) {
    console.log(`  ${ch(r.created_at)}  CHF ${(Number(r.amount_total) / 100).toFixed(2).padStart(7)}  ${r.gclid.slice(0, 40)}…`);
  }
  if (!g.rows.length) console.log('  (none yet — expected until tagged clicks start converting)');

  await pool.end();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
