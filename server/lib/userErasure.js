'use strict';

/**
 * GDPR ERASURE — the ONE implementation (art. 17, "right to be forgotten").
 *
 * Two callers, no second code path:
 *   - scripts/admin/delete-user-data.js   (the CLI: dry run by default, prints the plan)
 *   - DELETE /api/admin/users/:userId     (server/routes/admin/users.js, admin + typed-back email)
 *
 * Until 2026-10-07 the admin route was a divergent copy: no transaction, no
 * sentinel move, and it DELETED `orders` — the rows the owner's rulings say to
 * retain. The CLI had the rulings but was missing every table added after it
 * was written (email_sends, email_events, idea_events, eval_calls,
 * eval_finding_stats, story_verify_reports). Both now run this module, and
 * tests/unit/user-erasure.test.ts fails the moment a migration adds a table
 * with a user_id / story_id column that ERASURE_COVERAGE does not name.
 *
 * Shape
 *   resolveSubject   → the users row (throws ERASURE_NOT_FOUND / ERASURE_AMBIGUOUS)
 *   preflight        → blockers (in-flight job, unbooked Stripe payment)
 *   planErasure      → READ-ONLY: per-table counts, retention set, R2 keys. This IS the dry run.
 *   executeErasure   → one transaction: anonymise, move ledgers, delete, receipt row, COMMIT
 *   pruneErasureR2   → after COMMIT: delete every prefix/key, re-list, report every failure
 *   eraseUser        → the orchestration both callers use
 *
 * Owner rulings 2026-09-12 (docs/decisions.md, docs/gdpr-erasure.md §7/§11)
 *   Q1  credit_transactions + referral_payouts are KEPT, moved to the sentinel user, scrubbed.
 *   Q2/Q3 third parties' own rows are never rewritten (users.referred_by, orders.referral_code_used).
 *   Q4  an UNPROCESSED stripe_webhook_retry row aborts — an unbooked payment; a human resolves it.
 *   Q5  orders are retained 10 years (Swiss OR art. 958f), anonymised, not deleted.
 *   Q8  R2 runs against production only; the dry run prints the exact keys instead.
 */

const r2 = require('./r2');
const r2Pending = require('./r2Pending');
const { log } = require('../utils/logger');
const {
  GDPR_SENTINEL_USER_ID, GDPR_SENTINEL_USERNAME, GDPR_SENTINEL_EMAIL, GDPR_SENTINEL_PASSWORD,
} = require('./gdprSentinel');

// ─── Constants ───────────────────────────────────────────────────────────────

/** Replaces the erased id on rows that record someone ELSE's transaction. */
const USER_TOMBSTONE = 'erased-gdpr-user';

/**
 * Ledger columns scrubbed as the rows move to the sentinel (ruling Q1). Moving
 * a row without scrubbing it is relabelling, not erasure: `description` is free
 * text that may name the person or their story, `reference_id` points at a row
 * being deleted. Amounts, balances, types, dates, `order_stripe_session_id` and
 * `stripe_refund_id` are the audit trail the owner is preserving.
 */
const CREDIT_TX_SCRUB_COLUMNS = ['description', 'reference_id'];
const REFERRAL_PAYOUT_SCRUB_COLUMNS = ['description'];

/**
 * orders columns cleared on anonymisation. The financial row SURVIVES (Swiss OR
 * art. 958f, 10 years; GDPR art. 17(3)(b)). Kept: id, created_at, amount_total,
 * currency, payment_status, stripe_session_id, stripe_payment_intent_id,
 * gelato_order_id, shipping_country, discount_cents, stripe_mode, shipped_at,
 * delivered_at, referral_code_used.
 */
const ORDER_PII_COLUMNS = [
  'user_id', 'story_id',
  'customer_name', 'customer_email',
  'shipping_name', 'shipping_address_line1', 'shipping_address_line2',
  'shipping_city', 'shipping_state', 'shipping_postal_code',
  'tracking_number', 'tracking_url',
];

/**
 * Story-keyed tables with NO foreign key on story_id — a `DELETE FROM stories`
 * leaves them behind silently. These rows are story CONTENT (judge transcripts
 * with the child's name, metrics, scores, failure detail) and go with the story.
 * Shared by the user story-delete route, the anonymous-trial cleanup and the
 * erasure, through deleteStoryDerivedRows().
 */
const STORY_DERIVED_DELETE = [
  'consolidator_calls',
  'story_metrics',
  'story_scores',
  'failure_log',
  'eval_calls',
  'eval_finding_stats',
  'story_verify_reports',
];

/**
 * Story-keyed event logs that are NOT story content: a mail we sent, an idea
 * the customer picked. On a story delete their story_id is NULLed (the
 * pointer goes, the event stays — deleting idea picks would skew the idea
 * funnel's pick rate). On an ERASURE the rows are deleted by user anyway.
 */
const STORY_DERIVED_UNLINK = ['email_sends', 'idea_events'];

/**
 * Every table that carries a user_id or story_id column, and what the erasure
 * does with it. The guard test parses migrations/*.sql and fails when a table
 * with such a column is missing here — so a new table cannot drift past the
 * erasure unnoticed again. Values are documentation for the dry run and for
 * the test; the SQL below is the behaviour.
 */
const ERASURE_COVERAGE = Object.freeze({
  // Deleted explicitly by user id (no FK to users).
  users: 'delete',
  characters: 'delete',
  stories: 'delete',
  story_jobs: 'delete',
  story_drafts: 'delete',
  files: 'delete',
  logs: 'delete',
  trial_events: 'delete',
  failure_log: 'delete (by user id AND by story id)',
  idea_events: 'delete (by user id)',
  email_sends: 'delete (by user id OR recipient address)',
  email_events: 'delete (by recipient address OR send_id of the user\'s sends)',
  stripe_webhook_retry: 'delete processed rows mentioning the address; an UNPROCESSED row aborts (Q4)',
  // Retained under a legal obligation / owner ruling.
  orders: 'retain, anonymise (OR art. 958f; PII columns NULLed)',
  credit_transactions: 'retain, move to sentinel, scrub description + reference_id (Q1)',
  referral_payouts: 'retain, move to sentinel, scrub description; source_user_id tombstoned (Q1)',
  referral_events: 'cascade from users as referrer; buyer_user_id tombstoned',
  // Story-derived, no FK (deleteStoryDerivedRows).
  consolidator_calls: 'story-derived delete',
  story_metrics: 'story-derived delete',
  story_scores: 'story-derived delete',
  eval_calls: 'story-derived delete',
  eval_finding_stats: 'story-derived delete',
  story_verify_reports: 'story-derived delete',
  // ON DELETE CASCADE, verified in migrations.
  story_images: 'cascade from stories',
  story_retry_images: 'cascade from stories',
  style_lab_images: 'cascade from stories',
  benchmark_scenes: 'cascade from stories',
  story_job_checkpoints: 'cascade from story_jobs',
});

/** Tables the transaction must never DELETE FROM (pinned by the unit test). */
const RETAINED_TABLES = Object.freeze(['orders', 'credit_transactions', 'referral_payouts', 'referral_events']);

const UUID_RE = "'^[0-9a-fA-F-]{36}$'";

function erasureError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ─── Story-derived rows (shared with the story delete route) ─────────────────

/**
 * Delete / unlink every story-keyed row with no FK for `storyIds`. Runs on the
 * caller's client (inside its transaction when it has one). Returns per-table
 * row counts. Story ids and job ids share one id space (stories.js deletes
 * `story_jobs WHERE id = storyId`), so pass both when erasing.
 */
async function deleteStoryDerivedRows(client, storyIds) {
  const ids = (storyIds || []).filter(Boolean);
  const counts = {};
  if (ids.length === 0) return counts;
  for (const table of STORY_DERIVED_DELETE) {
    counts[table] = (await client.query(`DELETE FROM ${table} WHERE story_id = ANY($1)`, [ids])).rowCount || 0;
  }
  for (const table of STORY_DERIVED_UNLINK) {
    counts[`${table} (unlinked)`] = (await client.query(
      `UPDATE ${table} SET story_id = NULL WHERE story_id = ANY($1)`, [ids],
    )).rowCount || 0;
  }
  return counts;
}

// ─── Phase A: the subject ────────────────────────────────────────────────────

async function resolveSubject(client, { email, userId }) {
  const sql = 'SELECT id, username, email, referral_code, referred_by, created_at, anonymous FROM users WHERE ';
  const rows = userId
    ? (await client.query(`${sql}id = $1`, [userId])).rows
    : (await client.query(`${sql}LOWER(email) = LOWER($1)`, [email])).rows;
  if (rows.length === 0) throw erasureError('ERASURE_NOT_FOUND', `No user ${userId ? `with id "${userId}"` : `with email "${email}"`} on this database.`);
  if (rows.length > 1) {
    throw erasureError('ERASURE_AMBIGUOUS', `${rows.length} users share "${email}" (ids: ${rows.map((u) => u.id).join(', ')}). `
      + 'Refusing to guess which one to erase — resolve the duplicate first.');
  }
  if (rows[0].id === GDPR_SENTINEL_USER_ID) throw erasureError('ERASURE_SENTINEL', 'The sentinel user owns every retained ledger row and is never erased.');
  return rows[0];
}

/** Blockers. Each one is a decision (docs/gdpr-erasure.md §3), not a default. */
async function preflight(client, user) {
  const problems = [];
  const busy = (await client.query(
    "SELECT id, status FROM story_jobs WHERE user_id = $1 AND status IN ('pending','running','processing')", [user.id],
  )).rows;
  if (busy.length) {
    problems.push(`${busy.length} story job(s) still in flight (${busy.map((r) => `${r.id}:${r.status}`).join(', ')}). `
      + 'Erasing mid-generation would leave the pipeline writing rows back after the delete. Wait for them to finish.');
  }
  // stripe_webhook_retry.payload is the raw Stripe event (email, name, full
  // address). UNPROCESSED = a payment not yet booked as an order (ruling Q4).
  const pending = (await client.query(
    'SELECT id FROM stripe_webhook_retry WHERE processed_at IS NULL AND payload::text ILIKE $1', [`%${user.email}%`],
  )).rows;
  if (pending.length) {
    problems.push(`${pending.length} UNPROCESSED stripe_webhook_retry row(s) mention this address `
      + `(ids: ${pending.map((r) => r.id).join(', ')}). These are payments not yet booked as orders. `
      + 'Triage them via /api/admin/stripe-webhook-retry first, then re-run.');
  }
  return problems;
}

// ─── Phase B: the plan (read-only — this is the dry run) ─────────────────────

async function collectCounts(client, user, storyIds, jobIds) {
  const sids = storyIds.length ? storyIds : [''];
  const jids = jobIds.length ? jobIds : [''];
  const q = async (sql, params) => Number((await client.query(sql, params)).rows[0].n);
  const byUser = (t) => q(`SELECT COUNT(*) n FROM ${t} WHERE user_id = $1`, [user.id]);
  const byStory = (t) => q(`SELECT COUNT(*) n FROM ${t} WHERE story_id = ANY($1)`, [sids]);
  return {
    owned: {
      characters: await byUser('characters'),
      stories: storyIds.length,
      story_jobs: jobIds.length,
      story_drafts: await byUser('story_drafts'),
      files: await byUser('files'),
      logs: await byUser('logs'),
      trial_events: await byUser('trial_events'),
      idea_events: await byUser('idea_events'),
      email_sends: await q('SELECT COUNT(*) n FROM email_sends WHERE user_id = $1 OR LOWER(recipient) = LOWER($2)', [user.id, user.email]),
      email_events: await q(
        'SELECT COUNT(*) n FROM email_events WHERE LOWER(recipient) = LOWER($2) '
        + 'OR send_id IN (SELECT id FROM email_sends WHERE user_id = $1 OR LOWER(recipient) = LOWER($2))', [user.id, user.email]),
      // failure_log.user_id is UUID while users.id is VARCHAR — cast, tolerating a non-UUID id.
      failure_log_user: await q(`SELECT COUNT(*) n FROM failure_log WHERE $1 ~ ${UUID_RE} AND user_id = $1::uuid`, [user.id]),
      stripe_webhook_retry_processed: await q(
        'SELECT COUNT(*) n FROM stripe_webhook_retry WHERE processed_at IS NOT NULL AND payload::text ILIKE $1', [`%${user.email}%`]),
    },
    storyDerived: Object.fromEntries(await Promise.all(
      [...STORY_DERIVED_DELETE].map(async (t) => [t, await byStory(t)]),
    )),
    cascades: {
      story_images: await byStory('story_images'),
      story_retry_images: await byStory('story_retry_images'),
      style_lab_images: await byStory('style_lab_images'),
      benchmark_scenes: await byStory('benchmark_scenes'),
      story_job_checkpoints: await q('SELECT COUNT(*) n FROM story_job_checkpoints WHERE job_id = ANY($1)', [jids]),
      referral_events_as_referrer: await q('SELECT COUNT(*) n FROM referral_events WHERE referrer_user_id = $1', [user.id]),
    },
    retained: {
      credit_transactions: await byUser('credit_transactions'),
      referral_payouts: await byUser('referral_payouts'),
    },
  };
}

/** Residual inline base64 — should be zero (IRON RULE), reported so it is visible. */
async function collectInlineBytes(client, userId, storyIds) {
  const sids = storyIds.length ? storyIds : [''];
  const one = async (sql, params) => Number((await client.query(sql, params)).rows[0].n || 0);
  return {
    'characters.data': await one('SELECT COALESCE(SUM(pg_column_size(data)),0) n FROM characters WHERE user_id = $1', [userId]),
    'stories.data': await one('SELECT COALESCE(SUM(pg_column_size(data)),0) n FROM stories WHERE id = ANY($1)', [sids]),
    'files.file_data': await one('SELECT COALESCE(SUM(octet_length(file_data)),0) n FROM files WHERE user_id = $1', [userId]),
    'story_images.image_data (inline fallback)': await one(
      'SELECT COALESCE(SUM(octet_length(image_data)),0) n FROM story_images WHERE story_id = ANY($1) AND image_data IS NOT NULL', [sids]),
    'story_retry_images.image_data (inline fallback)': await one(
      'SELECT COALESCE(SUM(octet_length(image_data)),0) n FROM story_retry_images WHERE story_id = ANY($1) AND image_data IS NOT NULL', [sids]),
  };
}

/**
 * Prove the configured bucket is the one THIS database writes to. Measured
 * 2026-09-11: .env points at production while staging serves
 * images-staging.magicalstory.ch — without this an erasure lists a bucket with
 * none of its objects, deletes nothing and reports success.
 */
async function assertBucketMatchesDatabase(client) {
  if (!r2.isConfigured()) {
    throw erasureError('ERASURE_R2_UNAVAILABLE', 'R2 is NOT configured (R2_* env vars missing). '
      + 'Refusing an erasure that cannot reach the image store — the photographs would survive the database delete.');
  }
  const sample = (await client.query(
    "SELECT image_url FROM story_images WHERE image_url LIKE 'http%' ORDER BY id DESC LIMIT 1",
  )).rows[0];
  const cfgHost = new URL(process.env.R2_PUBLIC_URL).host;
  if (!sample) return { verified: false, bucket: process.env.R2_BUCKET, cfgHost };
  const dbHost = new URL(sample.image_url).host;
  if (dbHost !== cfgHost) {
    throw erasureError('ERASURE_R2_UNAVAILABLE', 'R2 BUCKET MISMATCH — refusing to run. '
      + `This database serves images from ${dbHost} but R2_PUBLIC_URL points at ${cfgHost} (bucket "${process.env.R2_BUCKET}"). `
      + 'Deleting with these settings would miss every object AND aim the prefixes at the wrong bucket.', { dbHost, cfgHost });
  }
  return { verified: true, bucket: process.env.R2_BUCKET, cfgHost };
}

/**
 * Everything the erasure would touch, read-only. Every query is explicit.
 * Throws ERASURE_PREFLIGHT when a blocker is present.
 */
async function planErasure(client, user) {
  const problems = await preflight(client, user);
  if (problems.length) throw erasureError('ERASURE_PREFLIGHT', problems.join('\n'), { problems });

  const storyIds = (await client.query('SELECT id FROM stories WHERE user_id = $1', [user.id])).rows.map((r) => r.id);
  const jobIds = (await client.query('SELECT id FROM story_jobs WHERE user_id = $1', [user.id])).rows.map((r) => r.id);
  const fileRows = (await client.query('SELECT id, file_url FROM files WHERE user_id = $1', [user.id])).rows;
  // A job that failed before its story row existed still has eval_calls /
  // failure_log rows under the job id, which is the story id.
  const derivedIds = [...new Set([...storyIds, ...jobIds])];

  const counts = await collectCounts(client, user, derivedIds, jobIds);
  counts.owned.stories = storyIds.length;
  const inline = await collectInlineBytes(client, user.id, storyIds);
  const sentinelExists = (await client.query('SELECT 1 FROM users WHERE id = $1', [GDPR_SENTINEL_USER_ID])).rowCount === 1;

  const orders = (await client.query(
    'SELECT id, stripe_session_id, gelato_order_id, amount_total, currency, payment_status, created_at '
    + 'FROM orders WHERE user_id = $1 ORDER BY created_at', [user.id],
  )).rows;

  const referees = user.referral_code
    ? (await client.query('SELECT id FROM users WHERE LOWER(referred_by) = LOWER($1)', [user.referral_code])).rows.length
    : 0;
  const buyerEvents = (await client.query('SELECT COUNT(*) n FROM referral_events WHERE buyer_user_id = $1', [user.id])).rows[0].n;
  const payoutSource = (await client.query('SELECT COUNT(*) n FROM referral_payouts WHERE source_user_id = $1', [user.id])).rows[0].n;
  const ordersUsingCode = user.referral_code
    ? Number((await client.query(
      'SELECT COUNT(*) n FROM orders WHERE LOWER(referral_code_used) = LOWER($1) AND (user_id IS NULL OR user_id <> $2)',
      [user.referral_code, user.id],
    )).rows[0].n)
    : 0;

  // R2: list what would go. The dry run prints the keys — that is the only
  // rehearsal there is (ruling Q8).
  const bucket = await assertBucketMatchesDatabase(client);
  const prefixes = [
    { prefix: `characters/${user.id}/`, label: 'uploaded photos + avatars (MOST SENSITIVE)' },
    { prefix: `stories/${user.id}/`, label: 'housekeeping "migrated" offloads (dbHousekeeping.js)' },
    ...storyIds.map((sid) => ({ prefix: r2.storyPrefix(sid), label: `story ${sid}` })),
  ];
  const r2Groups = [];
  for (const p of prefixes) {
    const objs = await r2.listByPrefix(p.prefix);
    if (objs.length === 0) continue;
    r2Groups.push({ ...p, count: objs.length, bytes: objs.reduce((s, o) => s + o.size, 0), keys: objs.map((o) => o.key) });
  }
  // Order PDFs: keyed by files.id, no user prefix — reachable only via the rows.
  const pdfKeys = fileRows.map((f) => r2Pending.keyForFileRow(f)).filter(Boolean);

  return {
    user, storyIds, jobIds, derivedIds, fileRows, counts, inline, sentinelExists, orders,
    referral: { referees, buyerEvents: Number(buyerEvents), payoutSource: Number(payoutSource), ordersUsingCode },
    r2: { bucket, prefixes, groups: r2Groups, pdfKeys, objects: r2Groups.reduce((s, g) => s + g.count, 0) + pdfKeys.length,
      bytes: r2Groups.reduce((s, g) => s + g.bytes, 0) },
    coverage: ERASURE_COVERAGE,
  };
}

// ─── Phase C: the transaction ────────────────────────────────────────────────

/**
 * Create the sentinel `users` row if it is not there yet, idempotently. Both
 * ledgers have `user_id NOT NULL REFERENCES users(id) ON DELETE CASCADE`, so
 * keeping them requires a row for them to belong to (server/lib/gdprSentinel.js).
 */
async function ensureSentinelUser(client) {
  const res = await client.query(
    `INSERT INTO users (id, username, email, password, role, credits, story_quota,
                        stories_generated, email_verified, anonymous)
     VALUES ($1, $2, $3, $4, 'user', 0, 0, 0, FALSE, FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [GDPR_SENTINEL_USER_ID, GDPR_SENTINEL_USERNAME, GDPR_SENTINEL_EMAIL, GDPR_SENTINEL_PASSWORD],
  );
  return res.rowCount === 1 ? 'created' : 'already existed';
}

/**
 * The write half: ONE transaction. R2 is deliberately not in here — object
 * storage is not transactional and a rollback cannot bring images back.
 * `onStep(line)` receives one human line per statement (the CLI prints them).
 */
async function executeErasure(client, plan, { actor, environment, onStep = () => {} }) {
  const { user } = plan;
  const deleted = {};
  const del = async (label, sql, params) => {
    const res = await client.query(sql, params);
    deleted[label] = res.rowCount;
    onStep(`deleted ${String(res.rowCount).padStart(6)}  ${label}`);
  };

  await client.query('BEGIN');
  try {
    // Phase B — anonymise BEFORE anything cascades. orders.user_id is
    // ON DELETE CASCADE: DELETE FROM users would destroy the retained rows.
    const setNull = ORDER_PII_COLUMNS.map((c) => `${c} = NULL`).join(', ');
    const anonRes = await client.query(
      `UPDATE orders SET ${setNull}, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [user.id],
    );
    onStep(`anonymised ${String(anonRes.rowCount).padStart(3)}  orders (retained, unlinked)`);

    // Ledgers → sentinel BEFORE the users delete cascades them away (Q1).
    const sentinelState = await ensureSentinelUser(client);
    onStep(`sentinel user ${GDPR_SENTINEL_USER_ID} — ${sentinelState}`);
    const ctRes = await client.query(
      `UPDATE credit_transactions SET user_id = $1, ${CREDIT_TX_SCRUB_COLUMNS.map((c) => `${c} = NULL`).join(', ')} WHERE user_id = $2`,
      [GDPR_SENTINEL_USER_ID, user.id],
    );
    onStep(`retained   ${String(ctRes.rowCount).padStart(3)}  credit_transactions → sentinel (scrubbed: ${CREDIT_TX_SCRUB_COLUMNS.join(', ')})`);
    const rpRes = await client.query(
      `UPDATE referral_payouts SET user_id = $1, ${REFERRAL_PAYOUT_SCRUB_COLUMNS.map((c) => `${c} = NULL`).join(', ')} WHERE user_id = $2`,
      [GDPR_SENTINEL_USER_ID, user.id],
    );
    onStep(`retained   ${String(rpRes.rowCount).padStart(3)}  referral_payouts → sentinel (scrubbed: ${REFERRAL_PAYOUT_SCRUB_COLUMNS.join(', ')})`);

    // Tombstones: rows that record someone ELSE's transaction but carried the id.
    const beRes = await client.query('UPDATE referral_events SET buyer_user_id = $1 WHERE buyer_user_id = $2', [USER_TOMBSTONE, user.id]);
    onStep(`tombstoned ${String(beRes.rowCount).padStart(3)}  referral_events.buyer_user_id`);
    const psRes = await client.query('UPDATE referral_payouts SET source_user_id = $1 WHERE source_user_id = $2', [USER_TOMBSTONE, user.id]);
    onStep(`tombstoned ${String(psRes.rowCount).padStart(3)}  referral_payouts.source_user_id`);

    // Phase C — story-scoped satellites with NO foreign key.
    const derived = await deleteStoryDerivedRows(client, plan.derivedIds);
    for (const [t, n] of Object.entries(derived)) { deleted[t] = n; onStep(`deleted ${String(n).padStart(6)}  ${t}`); }

    // Phase D — owned rows. email_events BEFORE email_sends: send_id is ON
    // DELETE SET NULL and would lose the join. stories cascades story_images /
    // story_retry_images / style_lab_images / benchmark_scenes; story_jobs
    // cascades story_job_checkpoints.
    await del('email_events',
      'DELETE FROM email_events WHERE LOWER(recipient) = LOWER($2) '
      + 'OR send_id IN (SELECT id FROM email_sends WHERE user_id = $1 OR LOWER(recipient) = LOWER($2))', [user.id, user.email]);
    await del('email_sends', 'DELETE FROM email_sends WHERE user_id = $1 OR LOWER(recipient) = LOWER($2)', [user.id, user.email]);
    await del('idea_events', 'DELETE FROM idea_events WHERE user_id = $1', [user.id]);
    await del('stories (+4 cascades)', 'DELETE FROM stories WHERE user_id = $1', [user.id]);
    await del('characters', 'DELETE FROM characters WHERE user_id = $1', [user.id]);
    await del('story_jobs (+checkpoints)', 'DELETE FROM story_jobs WHERE user_id = $1', [user.id]);
    await del('story_drafts', 'DELETE FROM story_drafts WHERE user_id = $1', [user.id]);
    await del('files', 'DELETE FROM files WHERE user_id = $1', [user.id]);
    await del('trial_events', 'DELETE FROM trial_events WHERE user_id = $1', [user.id]);
    await del('failure_log (by user)', `DELETE FROM failure_log WHERE $1 ~ ${UUID_RE} AND user_id = $1::uuid`, [user.id]);
    await del('stripe_webhook_retry (processed)',
      'DELETE FROM stripe_webhook_retry WHERE processed_at IS NOT NULL AND payload::text ILIKE $1', [`%${user.email}%`]);
    await del('logs', 'DELETE FROM logs WHERE user_id = $1', [user.id]);

    // Phase E — the user row. Cascades referral_events (as referrer). orders is
    // detached and both ledgers belong to the sentinel, so nothing retained is
    // in the cascade's path any more.
    await del('users', 'DELETE FROM users WHERE id = $1', [user.id]);
    if (deleted.users !== 1) throw new Error(`Expected to delete exactly 1 user row, deleted ${deleted.users}`);

    // Phase F — the receipt: the FACT of the erasure, never the erased content
    // (id only). Written after the per-user logs delete so it is not swept.
    const receipt = {
      erasedUserId: user.id,
      environment,
      at: new Date().toISOString(),
      deleted,
      anonymisedOrders: anonRes.rowCount,
      retainedToSentinel: {
        sentinelUserId: GDPR_SENTINEL_USER_ID, sentinel: sentinelState,
        creditTransactions: ctRes.rowCount, referralPayouts: rpRes.rowCount,
      },
      referralTombstones: { buyerEvents: beRes.rowCount, payoutSource: psRes.rowCount },
      // Accepted limit (Q2/Q3): the name-bearing code survives here.
      thirdPartyRowsStillCarryingTheCode: { usersReferredBy: plan.referral.referees, ordersReferralCodeUsed: plan.referral.ordersUsingCode },
      r2PrefixesQueued: plan.r2.prefixes.length,
    };
    await client.query(
      'INSERT INTO logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
      [null, actor, 'GDPR_ERASURE', JSON.stringify(receipt)],
    );
    await client.query('COMMIT');
    return { ...receipt, sentinelState };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  }
}

// ─── Phase D: R2, only after COMMIT ──────────────────────────────────────────

/**
 * Delete every prefix and PDF key in the plan, then re-list every prefix.
 * Through the failed-prune ledger (r2Pending), so an outage is retried by the
 * daily housekeeping — but a prune that did not finish is a FAILED erasure and
 * is returned in `failures` and logged at ERROR. Never swallowed, never thrown:
 * the rows are already gone, and the caller must report partial completion.
 */
async function pruneErasureR2(plan) {
  const reason = `GDPR erasure of user ${plan.user.id}`;
  const failures = [];
  let deleted = 0;
  for (const { prefix } of plan.r2.prefixes) {
    try {
      deleted += await r2Pending.prunePrefix(prefix, reason);
    } catch (err) {
      failures.push(`prune ${prefix}: ${err.message}`);
    }
  }
  for (const key of plan.r2.pdfKeys) {
    let ok = 0;
    try { ok = await r2Pending.pruneObject(key, reason); } catch (err) { failures.push(`delete ${key}: ${err.message}`); continue; }
    if (ok === 1) deleted++;
    else failures.push(`order PDF "${key}" still exists (recorded for retry)`);
  }
  // prunePrefix returns a count rather than throwing — verify independently.
  for (const { prefix } of plan.r2.prefixes) {
    try {
      const rest = await r2.listByPrefix(prefix);
      if (rest.length) failures.push(`${rest.length} object(s) survive under ${prefix}`);
    } catch (err) {
      failures.push(`could not verify ${prefix}: ${err.message}`);
    }
  }
  for (const f of failures) log.error(`[GDPR] R2 erasure INCOMPLETE for user ${plan.user.id}: ${f}`);
  return { deleted, failures };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/**
 * The entry point both callers use. `apply: false` is the dry run: resolves,
 * preflights and plans, and issues no write of any kind.
 *
 * @param {import('pg').PoolClient} client  a dedicated connection (BEGIN/COMMIT run on it)
 * @returns {{ user, plan, result?, r2?, complete: boolean }}
 */
async function eraseUser(client, { email, userId, actor, environment, apply = false, onStep }) {
  const user = await resolveSubject(client, { email, userId });
  const plan = await planErasure(client, user);
  if (!apply) return { user, plan, complete: false, dryRun: true };
  const result = await executeErasure(client, plan, { actor, environment, onStep });
  const r2Result = await pruneErasureR2(plan);
  return { user, plan, result, r2: r2Result, complete: r2Result.failures.length === 0, dryRun: false };
}

module.exports = {
  eraseUser,
  resolveSubject,
  preflight,
  planErasure,
  executeErasure,
  pruneErasureR2,
  deleteStoryDerivedRows,
  ensureSentinelUser,
  ERASURE_COVERAGE,
  RETAINED_TABLES,
  STORY_DERIVED_DELETE,
  STORY_DERIVED_UNLINK,
  ORDER_PII_COLUMNS,
  CREDIT_TX_SCRUB_COLUMNS,
  REFERRAL_PAYOUT_SCRUB_COLUMNS,
  USER_TOMBSTONE,
};
