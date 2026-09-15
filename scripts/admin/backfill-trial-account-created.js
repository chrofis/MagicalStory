#!/usr/bin/env node
/**
 * Backfill the terminal `account_created` trial-funnel step for visits that
 * provably converted BEFORE the step existed.
 *
 * WHY: until 2026-09-13 the funnel ended at `email_submitted`, which only the
 * email signup path emits. Every conversion that came in through Google left no
 * funnel row at all, so the panel read 1 conversion out of 8 finished stories
 * where the truth was 5 — the Google ones were simply invisible.
 *
 * The evidence used is the credit_transactions row "Welcome credits (Google
 * sign-up)": it is written once, by the server, at the moment the trial account
 * became a real account. Its timestamp is what the event is dated with, so the
 * backfilled rows land in the same date window the conversion actually happened
 * in. NOTE credit_transactions.created_at is a naive TIMESTAMP holding UTC while
 * trial_events.created_at is TIMESTAMPTZ — the insert casts it explicitly
 * (AT TIME ZONE 'UTC'); letting node-pg parse it would shift it by the local
 * offset.
 *
 * Idempotent: the unique index on trial_events (visit_id, step) plus
 * ON CONFLICT DO NOTHING means a second run inserts nothing.
 *
 *   node scripts/admin/backfill-trial-account-created.js              # dry run (default)
 *   node scripts/admin/backfill-trial-account-created.js --execute    # write
 *   node scripts/admin/backfill-trial-account-created.js --staging    # against staging
 */
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { ch } = require('../lib/chTime');

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const STAGING = args.includes('--staging');
const CONN = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;

// Converted visits: a trial visit whose user later got Google welcome credits.
// The join is on user_id, which trial_events back-fills at character_saved —
// that is the link between the anonymous trail and the real account.
const FIND_SQL = `
  SELECT DISTINCT ON (te.visit_id)
         te.visit_id,
         te.user_id,
         u.email,
         ct.created_at AT TIME ZONE 'UTC' AS converted_at,
         (SELECT COUNT(*)::int FROM trial_events x
           WHERE x.visit_id = te.visit_id AND x.step = 'account_created') AS already
    FROM trial_events te
    JOIN credit_transactions ct ON ct.user_id = te.user_id
    JOIN users u ON u.id = te.user_id
   WHERE ct.description ILIKE '%Google sign-up%'
     AND te.user_id IS NOT NULL
   ORDER BY te.visit_id, ct.created_at ASC`;

// Attribution is copied from the visit's own landing row so the backfilled
// conversion is counted under the source that paid for it, not as 'direct'.
const INSERT_SQL = `
  INSERT INTO trial_events (visit_id, step, created_at, utm_source, utm_medium, utm_campaign, referrer, language, device, user_id, meta)
  SELECT $1::uuid, 'account_created', $2::timestamptz,
         utm_source, utm_medium, utm_campaign, referrer, language, device, $3,
         '{"method":"google","backfilled":true}'::jsonb
    FROM trial_events
   WHERE visit_id = $1::uuid
   ORDER BY created_at ASC
   LIMIT 1
  ON CONFLICT (visit_id, step) DO NOTHING`;

function mask(email) {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 2)}***@${domain || ''}`;
}

(async () => {
  if (!CONN) throw new Error(`No connection string (${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'})`);
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

  const { rows } = await pool.query(FIND_SQL);
  console.log(`Target: ${STAGING ? 'STAGING' : 'PRODUCTION'}`);
  console.log(`Mode:   ${EXECUTE ? 'EXECUTE (writes)' : 'DRY RUN (no writes) — pass --execute to write'}`);
  console.log(`Converted visits found: ${rows.length}\n`);

  let toInsert = 0;
  for (const r of rows) {
    const state = r.already > 0 ? 'SKIP (already has account_created)' : (EXECUTE ? 'INSERT' : 'WOULD INSERT');
    if (r.already === 0) toInsert++;
    console.log(`  ${state.padEnd(34)} visit ${r.visit_id}  ${mask(r.email).padEnd(22)} ${ch(r.converted_at)}`);
  }

  if (EXECUTE) {
    let inserted = 0;
    for (const r of rows) {
      if (r.already > 0) continue;
      const res = await pool.query(INSERT_SQL, [r.visit_id, r.converted_at, r.user_id]);
      inserted += res.rowCount;
    }
    console.log(`\nInserted: ${inserted} row(s).`);
  } else {
    console.log(`\nWould insert: ${toInsert} row(s). Nothing written.`);
  }

  await pool.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
