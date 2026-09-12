#!/usr/bin/env node
/**
 * GDPR ERASURE — erase one person's data on request (art. 17, "right to be forgotten").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE MOST DESTRUCTIVE SCRIPT IN THE REPO. Read docs/gdpr-erasure.md
 *  before running it. Design notes and the FK reasoning: tasks/gdpr-erasure-2026-09-11.md
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Safety model
 *   - DRY RUN IS THE DEFAULT. Without --confirm nothing is written, ever.
 *   - Deleting needs BOTH --confirm=<email> and --email=<email>, and the two must
 *     be identical. Typing the address twice is the interlock.
 *   - Staging is the default target. Production needs --production as well.
 *   - The whole DB portion is ONE transaction. R2 runs only after COMMIT, because
 *     object storage is not transactional and a rollback cannot bring images back.
 *   - Every failure is fatal. Nothing is swallowed: a partial erasure reported as
 *     success is the worst possible outcome of this script.
 *
 * Owner rulings 2026-09-12 (tasks/gdpr-erasure-2026-09-11.md §8, docs/decisions.md)
 *   - Q1: credit_transactions + referral_payouts are KEPT, moved to a sentinel
 *     user and scrubbed of free text and pointers.
 *   - Q2/Q3: third parties' own rows are never rewritten — their `referred_by`
 *     and `orders.referral_code_used` keep the erased person's name-bearing
 *     code. Counted and reported at every run so the limit stays visible.
 *   - Q4: an UNPROCESSED stripe_webhook_retry row aborts the run by design —
 *     that is an unbooked payment; an admin resolves it and re-runs.
 *   - Q8: there are no staging R2 credentials, so the R2 half only ever runs
 *     against production and can never be rehearsed. The dry run therefore
 *     prints the exact keys it would delete.
 *
 * Usage
 *   node scripts/admin/delete-user-data.js --email=person@example.com
 *   node scripts/admin/delete-user-data.js --email=p@x.com --confirm=p@x.com
 *   node scripts/admin/delete-user-data.js --email=p@x.com --confirm=p@x.com --production
 *   ... --actor=<admin username>      # recorded on the audit row (default: OS user)
 */
'use strict';

const path = require('path');
const { Pool } = require('pg');
const {
  S3Client, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const r2 = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'r2.js'));
const r2Pending = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'r2Pending.js'));
const { ch, fromPgNaive } = require(path.resolve(__dirname, '..', 'lib', 'chTime.js'));
const {
  GDPR_SENTINEL_USER_ID, GDPR_SENTINEL_USERNAME, GDPR_SENTINEL_EMAIL, GDPR_SENTINEL_PASSWORD,
} = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'gdprSentinel.js'));

/**
 * Swiss local time for a node-pg naive TIMESTAMP column. The driver parses the
 * stored UTC wall clock as LOCAL, so it must be rehomed before formatting —
 * skipping this double-shifts (CLAUDE.md → Timezone).
 */
const chPg = (d) => (d ? ch(fromPgNaive(d)) : '(none)');

// ─── Constants ───────────────────────────────────────────────────────────────

/** Replaces the erased id on referral_events rows where they were the BUYER. */
const USER_TOMBSTONE = 'erased-gdpr-user';

/**
 * Ledger columns scrubbed as the rows move to the sentinel (owner ruling Q1,
 * 2026-09-12). Moving a row without scrubbing it is relabelling, not erasure:
 * `description` is free text written by the app and may name the person or
 * their story, and `reference_id` points back at a row that is being deleted.
 * Everything else — amounts, balances, types, dates, `order_stripe_session_id`,
 * `stripe_refund_id` — is the audit trail the owner is preserving.
 */
const CREDIT_TX_SCRUB_COLUMNS = ['description', 'reference_id'];
const REFERRAL_PAYOUT_SCRUB_COLUMNS = ['description'];

/**
 * orders columns cleared on anonymisation. The financial row SURVIVES:
 * Swiss OR art. 958f (10y) — the privacy policy now states 10 years for payment
 * records too (owner ruling Q5, 2026-09-12) —
 * GDPR art. 17(3)(b). See tasks/gdpr-erasure-2026-09-11.md §3 for the kept columns.
 */
const ORDER_PII_COLUMNS = [
  'user_id', 'story_id',
  'customer_name', 'customer_email',
  'shipping_name', 'shipping_address_line1', 'shipping_address_line2',
  'shipping_city', 'shipping_state', 'shipping_postal_code',
  'tracking_number', 'tracking_url',
];

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {} };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) die(`Unrecognised argument: ${a}`);
    if (m[2] === undefined) out.flags.add(m[1]);
    else out.opts[m[1]] = m[2];
  }
  return out;
}

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function section(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function row(label, value) {
  console.log(`  ${String(label).padEnd(34)} ${value}`);
}

// ─── R2 listing (dry-run needs sizes; r2.js exposes no list) ─────────────────

function r2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Prove the configured R2 bucket is the one the TARGET database actually writes to.
 *
 * Measured 2026-09-11: staging serves images from `images-staging.magicalstory.ch`
 * while `.env`'s R2_PUBLIC_URL / R2_BUCKET point at the PRODUCTION bucket
 * (`images.magicalstory.ch` / magicalstory-images). Without this check a staging
 * erasure lists a bucket that holds none of its objects, finds nothing, deletes
 * nothing — and reports success while every photograph survives. Worse, the
 * prefixes it would have deleted are production keys.
 *
 * So: sample a real image URL from the target DB and compare hosts. No guessing,
 * no second set of env vars invented — if they disagree, refuse.
 */
async function assertBucketMatchesDatabase(client, envName) {
  const sample = (await client.query(
    "SELECT image_url FROM story_images WHERE image_url LIKE 'http%' ORDER BY id DESC LIMIT 1",
  )).rows[0];
  if (!sample) {
    console.log('  ⚠️  No stored image URL on this database — cannot verify the R2 bucket.');
    return;
  }
  const dbHost = new URL(sample.image_url).host;
  const cfgHost = new URL(process.env.R2_PUBLIC_URL).host;
  if (dbHost !== cfgHost) {
    die(`R2 BUCKET MISMATCH — refusing to run.\n`
      + `    ${envName} database serves images from : ${dbHost}\n`
      + `    .env R2_PUBLIC_URL points at          : ${cfgHost}  (bucket "${process.env.R2_BUCKET}")\n\n`
      + `  Deleting with these settings would miss every ${envName} object AND aim the\n`
      + `  delete prefixes at the wrong bucket. Point R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /\n`
      + `  R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_URL at the ${envName} bucket\n`
      + `  (${dbHost}) and re-run.`);
  }
  row('R2 bucket verified', `${process.env.R2_BUCKET} (${cfgHost}) matches ${envName}`);
}

/**
 * List every object under a prefix. Throws on failure — a dry run that cannot
 * see the objects must not print a reassuring zero.
 */
async function listPrefix(client, prefix) {
  const objects = [];
  let ContinuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET, Prefix: prefix, ContinuationToken, MaxKeys: 1000,
    }));
    for (const o of res.Contents || []) objects.push({ key: o.Key, size: o.Size || 0 });
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : null;
  } while (ContinuationToken);
  return objects;
}

// ─── Phase A: resolve the person and everything that points at them ─────────

async function resolveTarget(client, email) {
  const users = (await client.query(
    'SELECT id, username, email, referral_code, referred_by, created_at, anonymous FROM users WHERE LOWER(email) = LOWER($1)',
    [email],
  )).rows;

  if (users.length === 0) die(`No user with email "${email}" on this database.`);
  if (users.length > 1) {
    die(`${users.length} users share "${email}" (ids: ${users.map((u) => u.id).join(', ')}). `
      + 'Refusing to guess which one to erase — resolve the duplicate first.');
  }
  return users[0];
}

/** Per-table counts of what would be removed. Every query is explicit. */
async function collectCounts(client, userId, storyIds, jobIds) {
  const sids = storyIds.length ? storyIds : [''];
  const q = async (sql, params) => Number((await client.query(sql, params)).rows[0].n);

  return {
    // Owned directly by the user (no FK — explicit deletes required).
    characters: await q('SELECT COUNT(*) n FROM characters WHERE user_id = $1', [userId]),
    stories: storyIds.length,
    story_jobs: jobIds.length,
    story_drafts: await q('SELECT COUNT(*) n FROM story_drafts WHERE user_id = $1', [userId]),
    files: await q('SELECT COUNT(*) n FROM files WHERE user_id = $1', [userId]),
    logs: await q('SELECT COUNT(*) n FROM logs WHERE user_id = $1', [userId]),
    trial_events: await q('SELECT COUNT(*) n FROM trial_events WHERE user_id = $1', [userId]),
    failure_log_user: await q(
      // failure_log.user_id is UUID while users.id is VARCHAR — cast, and tolerate
      // a non-UUID id (anonymous accounts) rather than throwing on the cast.
      "SELECT COUNT(*) n FROM failure_log WHERE $1 ~ '^[0-9a-fA-F-]{36}$' AND user_id = $1::uuid",
      [userId],
    ),

    // referral_events cascades from users. credit_transactions / referral_payouts
    // would too, but are moved to the sentinel first and KEPT (ruling Q1).
    credit_transactions: await q('SELECT COUNT(*) n FROM credit_transactions WHERE user_id = $1', [userId]),
    referral_events_as_referrer: await q('SELECT COUNT(*) n FROM referral_events WHERE referrer_user_id = $1', [userId]),
    referral_payouts: await q('SELECT COUNT(*) n FROM referral_payouts WHERE user_id = $1', [userId]),

    // Story-scoped, NO FK on story_id — silently orphaned unless deleted explicitly.
    consolidator_calls: await q('SELECT COUNT(*) n FROM consolidator_calls WHERE story_id = ANY($1)', [sids]),
    story_metrics: await q('SELECT COUNT(*) n FROM story_metrics WHERE story_id = ANY($1)', [sids]),
    story_scores: await q('SELECT COUNT(*) n FROM story_scores WHERE story_id = ANY($1)', [sids]),
    failure_log_story: await q('SELECT COUNT(*) n FROM failure_log WHERE story_id = ANY($1)', [sids]),

    // Cascade from stories — reported, not deleted by us.
    story_images: await q('SELECT COUNT(*) n FROM story_images WHERE story_id = ANY($1)', [sids]),
    story_retry_images: await q('SELECT COUNT(*) n FROM story_retry_images WHERE story_id = ANY($1)', [sids]),
    style_lab_images: await q('SELECT COUNT(*) n FROM style_lab_images WHERE story_id = ANY($1)', [sids]),
    benchmark_scenes: await q('SELECT COUNT(*) n FROM benchmark_scenes WHERE story_id = ANY($1)', [sids]),
    // Cascade from story_jobs.
    story_job_checkpoints: await q('SELECT COUNT(*) n FROM story_job_checkpoints WHERE job_id = ANY($1)',
      [jobIds.length ? jobIds : ['']]),
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

// ─── Pre-flight blockers ─────────────────────────────────────────────────────

async function preflight(client, user) {
  const problems = [];

  const busy = (await client.query(
    "SELECT id, status FROM story_jobs WHERE user_id = $1 AND status IN ('pending','running','processing')",
    [user.id],
  )).rows;
  if (busy.length) {
    problems.push(`${busy.length} story job(s) still in flight (${busy.map((r) => `${r.id}:${r.status}`).join(', ')}). `
      + 'Erasing mid-generation would leave the pipeline writing rows back after the delete. Wait for them to finish.');
  }

  // stripe_webhook_retry.payload is the raw Stripe event: customer email, name and
  // full shipping address. An UNPROCESSED row means a payment that has not been
  // turned into an order yet — erasing it loses a real purchase.
  const pending = (await client.query(
    "SELECT id, event_id, event_type, created_at FROM stripe_webhook_retry "
    + 'WHERE processed_at IS NULL AND payload::text ILIKE $1',
    [`%${user.email}%`],
  )).rows;
  if (pending.length) {
    problems.push(`${pending.length} UNPROCESSED stripe_webhook_retry row(s) mention this address `
      + `(ids: ${pending.map((r) => r.id).join(', ')}). These are payments not yet booked as orders. `
      + 'Triage them via /api/admin/stripe-webhook-retry first, then re-run.');
  }

  return problems;
}

// ─── The sentinel that owns retained ledger rows (owner ruling Q1) ──────────

/**
 * Create the sentinel `users` row if it is not there yet, idempotently.
 *
 * `credit_transactions.user_id` and `referral_payouts.user_id` are both
 * `NOT NULL REFERENCES users(id) ON DELETE CASCADE`, so keeping those ledgers
 * requires a row for them to belong to. It is not a person: no name, no real
 * address, a password that is not a bcrypt hash, and it is filtered out of the
 * admin user list, the admin user count, the storage report and the activity
 * feed (server/lib/gdprSentinel.js).
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  const email = args.opts.email;
  const confirm = args.opts.confirm;
  const production = args.flags.has('production');
  const actor = args.opts.actor || process.env.USER || process.env.USERNAME || 'unknown-admin';

  if (!email) die('--email=<address> is required (the person requesting erasure).');

  if (args.flags.has('confirm')) {
    die('--confirm must carry the address: --confirm=' + email
      + '  (typing it twice is the interlock; a bare --confirm is refused).');
  }

  const apply = confirm !== undefined;
  if (apply && confirm.trim().toLowerCase() !== email.trim().toLowerCase()) {
    die(`--confirm ("${confirm}") does not match --email ("${email}"). Nothing was touched.`);
  }

  const connectionString = production ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  const envName = production ? 'PRODUCTION' : 'staging';
  if (!connectionString) {
    die(`${production ? 'DATABASE_URL' : 'STAGING_DATABASE_URL'} is not set in .env — cannot reach ${envName}.`);
  }
  if (production && !apply) {
    console.log('\n⚠️  --production with no --confirm: this is a READ-ONLY dry run against production.\n');
  }

  console.log(`\n╔${'═'.repeat(70)}╗`);
  console.log(`║  GDPR ERASURE  ${(apply ? '*** LIVE — WILL DELETE ***' : 'DRY RUN (nothing is written)').padEnd(54)}║`);
  console.log(`╚${'═'.repeat(70)}╝`);
  row('Target environment', envName);
  row('Subject', email);
  row('Operator', actor);
  row('Time', ch(new Date()));

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  let receipt = null;
  try {
    // ── Phase A ────────────────────────────────────────────────────────────
    const user = await resolveTarget(client, email);

    section('1. SUBJECT');
    row('user id', user.id);
    row('username', user.username);
    row('email', user.email);
    row('anonymous account', String(!!user.anonymous));
    row('referral code', user.referral_code || '(none)');
    row('created', chPg(user.created_at));

    const problems = await preflight(client, user);
    if (problems.length) {
      section('PRE-FLIGHT FAILED');
      problems.forEach((p) => console.error(`  ✗ ${p}`));
      die('Refusing to proceed. Nothing was touched.');
    }

    const storyIds = (await client.query('SELECT id FROM stories WHERE user_id = $1', [user.id])).rows.map((r) => r.id);
    const jobIds = (await client.query('SELECT id FROM story_jobs WHERE user_id = $1', [user.id])).rows.map((r) => r.id);
    const fileRows = (await client.query('SELECT id, file_url FROM files WHERE user_id = $1', [user.id])).rows;

    const counts = await collectCounts(client, user.id, storyIds, jobIds);
    const inline = await collectInlineBytes(client, user.id, storyIds);

    // Does the sentinel that will own the retained ledgers exist yet? (read-only)
    const sentinelExists = (await client.query(
      'SELECT 1 FROM users WHERE id = $1', [GDPR_SENTINEL_USER_ID],
    )).rowCount === 1;

    // ── Retention set ──────────────────────────────────────────────────────
    const orders = (await client.query(
      'SELECT id, stripe_session_id, gelato_order_id, amount_total, currency, payment_status, created_at '
      + 'FROM orders WHERE user_id = $1 ORDER BY created_at', [user.id],
    )).rows;

    // ── Referral fan-out ───────────────────────────────────────────────────
    const referees = user.referral_code
      ? (await client.query('SELECT id FROM users WHERE LOWER(referred_by) = LOWER($1)', [user.referral_code])).rows
      : [];
    const buyerEvents = (await client.query(
      'SELECT id FROM referral_events WHERE buyer_user_id = $1', [user.id],
    )).rows;
    const payoutSource = (await client.query(
      'SELECT id FROM referral_payouts WHERE source_user_id = $1', [user.id],
    )).rows;
    const ordersUsingCode = user.referral_code
      ? Number((await client.query(
        'SELECT COUNT(*) n FROM orders WHERE LOWER(referral_code_used) = LOWER($1) AND (user_id IS NULL OR user_id <> $2)',
        [user.referral_code, user.id],
      )).rows[0].n)
      : 0;

    section('2. DATABASE — WOULD BE DELETED');
    console.log('  Owned rows (no FK to users — deleted explicitly):');
    for (const k of ['characters', 'stories', 'story_jobs', 'story_drafts', 'files', 'logs', 'trial_events', 'failure_log_user']) {
      row(`    ${k}`, counts[k]);
    }
    console.log('  Story-scoped, no FK on story_id (orphaned unless deleted explicitly):');
    for (const k of ['consolidator_calls', 'story_metrics', 'story_scores', 'failure_log_story']) row(`    ${k}`, counts[k]);
    console.log('  Cascades from stories / story_jobs (ON DELETE CASCADE, verified):');
    for (const k of ['story_images', 'story_retry_images', 'style_lab_images', 'benchmark_scenes', 'story_job_checkpoints']) {
      row(`    ${k}`, counts[k]);
    }
    console.log('  Cascades from users (ON DELETE CASCADE, verified):');
    row('    referral_events_as_referrer', counts.referral_events_as_referrer);
    row('    users', 1);
    console.log('  (credit_transactions / referral_payouts are NOT deleted — see §3)');

    section('3. LEDGERS — KEPT, REASSIGNED TO THE SENTINEL USER');
    console.log('  Owner ruling 2026-09-12 (Q1): the credit ledger and the commission ledger');
    console.log('  are retained as an audit trail. Both have user_id NOT NULL with an');
    console.log('  ON DELETE CASCADE FK, so DELETE FROM users would destroy them — the rows');
    console.log('  are moved to a sentinel user first, and scrubbed on the way across.');
    row('  sentinel user id', GDPR_SENTINEL_USER_ID);
    row('  sentinel row on this DB', sentinelExists ? 'already exists' : 'WOULD BE CREATED');
    row('  credit_transactions moved', `${counts.credit_transactions} row(s)`);
    console.log(`      scrubbed: ${CREDIT_TX_SCRUB_COLUMNS.join(', ')}`);
    console.log('      kept:     amount, balance_after, transaction_type, price_cents, created_at');
    row('  referral_payouts moved', `${counts.referral_payouts} row(s)`);
    console.log(`      scrubbed: ${REFERRAL_PAYOUT_SCRUB_COLUMNS.join(', ')}`);
    console.log('      kept:     amount_cents, type, balance_after_cents, pending_after_cents,');
    console.log('                order_stripe_session_id, stripe_refund_id, created_at');
    console.log('  The sentinel cannot log in (password is not a bcrypt hash), cannot be');
    console.log('  emailed (@invalid, RFC 2606) and is excluded from the admin user list,');
    console.log('  the admin user count, the storage report and the activity feed.');

    section('4. RETENTION CARVE-OUT — ORDERS ANONYMISED, NOT DELETED');
    if (orders.length === 0) {
      console.log('  No orders. Nothing retained.');
    } else {
      console.log(`  ${orders.length} order row(s) are kept as accounting vouchers and unlinked from the person.`);
      console.log('  Rule: Swiss OR art. 958f — business records, 10 years; the privacy policy');
      console.log('        states 10 years for payment records. GDPR art. 17(3)(b) exempts');
      console.log('        processing required by law. Nothing records WHEN a retained row');
      console.log('        expires, and no purge job exists (ruling Q5, 2026-09-12).');
      console.log(`  Columns cleared: ${ORDER_PII_COLUMNS.join(', ')}`);
      console.log('  Columns kept:    id, created_at, amount_total, currency, payment_status,');
      console.log('                   stripe_session_id, stripe_payment_intent_id, gelato_order_id,');
      console.log('                   shipping_country, discount_cents, stripe_mode, shipped_at, delivered_at');
      for (const o of orders) {
        row(`    order #${o.id}`, `${(o.amount_total ?? 0) / 100} ${o.currency || ''} ${o.payment_status || ''} — ${chPg(o.created_at)}`);
      }
      const gelato = orders.map((o) => o.gelato_order_id).filter(Boolean);
      if (gelato.length) {
        console.log('\n  ⚠️  THIRD-PARTY FOLLOW-UP REQUIRED (this script never calls their APIs):');
        console.log(`      Gelato holds the recipient address AND the book PDF for: ${gelato.join(', ')}`);
        console.log('      Raise a deletion request with Gelato support citing those ids.');
      }
      console.log('\n  ⚠️  Stripe holds the customer object, email and full address for sessions:');
      console.log(`      ${orders.map((o) => o.stripe_session_id).filter(Boolean).join(', ') || '(none)'}`);
      console.log('      Stripe is the record-keeper for the invoice; handle per docs/gdpr-erasure.md.');
    }

    section('5. REFERRAL HANDLING');
    if (!user.referral_code && referees.length === 0 && buyerEvents.length === 0) {
      console.log('  No referral entanglement.');
    } else {
      row('erased code', user.referral_code || '(none)');
      row('referral_events as BUYER', `${buyerEvents.length} → buyer_user_id = "${USER_TOMBSTONE}"`);
      console.log('      (kept: these rows record credits granted to a DIFFERENT user; deleting');
      console.log('       them would corrupt that person\'s audit trail. Only the erased id goes.)');
      row('referral_payouts.source_user_id', `${payoutSource.length} → "${USER_TOMBSTONE}"`);

      // Owner ruling 2026-09-12 (Q2 + Q3): third parties' own rows are NOT
      // rewritten. The erased person's referral code is `Magic<Firstname><NNN>`
      // (server/lib/referral.js), so a first name survives on those rows — an
      // accepted limit, reported at every erasure so it stays visible.
      console.log('\n  ACCEPTED LIMIT — a first name survives on third parties\' rows (ruling Q2/Q3,');
      console.log('  2026-09-12): these rows belong to other people and are left untouched.');
      row('    users.referred_by', `${referees.length} row(s) still carry "${user.referral_code || '(none)'}"`);
      row('    orders.referral_code_used', `${ordersUsingCode} retained order row(s) still carry it`);
      if (referees.length || ordersUsingCode) {
        console.log('    (NULLing referred_by would silently restore another person\'s one-code-ever');
        console.log('     entitlement — server/routes/print.js:1493 tests only for NOT NULL; scrubbing');
        console.log('     orders.referral_code_used would damage a retained financial record.)');
      }
    }

    section('6. R2 OBJECT STORAGE');
    let r2Groups = [];
    let r2Total = 0; let r2Bytes = 0;
    if (!r2.isConfigured()) {
      console.log('  ✗ R2 is NOT configured in this environment (R2_* env vars missing).');
      die('Refusing to run an erasure that cannot reach the image store. '
        + 'The photographs would survive the database delete.');
    }
    await assertBucketMatchesDatabase(client, envName);
    const s3 = r2Client();
    const prefixes = [
      [`characters/${user.id}/`, 'uploaded photos + avatars (MOST SENSITIVE)'],
      [`stories/${user.id}/`, 'housekeeping "migrated" offloads (dbHousekeeping.js:148)'],
      ...storyIds.map((sid) => [`stories/${sid}/`, `story ${sid}`]),
    ];
    for (const [prefix, label] of prefixes) {
      const objs = await listPrefix(s3, prefix);
      if (objs.length === 0) continue;
      const b = objs.reduce((s, o) => s + o.size, 0);
      r2Groups.push({ prefix, label, count: objs.length, bytes: b, keys: objs.map((o) => o.key) });
      r2Total += objs.length; r2Bytes += b;
    }
    // Order PDFs: keyed by files.id, no user prefix — reachable only via the DB
    // rows. Same derivation the app's delete paths use (r2Pending.keyForFileRow),
    // so there is one mechanism, not two. This script keeps its own STRICTER
    // policy afterwards: it throws on a failed delete instead of recording a
    // pending retry, because an erasure must be proven, not deferred.
    const pdfKeys = fileRows.map((f) => r2Pending.keyForFileRow(f)).filter(Boolean);
    for (const g of r2Groups) row(`    ${g.prefix}`, `${g.count} objects, ${bytes(g.bytes)}  — ${g.label}`);
    if (pdfKeys.length) row('    orders/*.pdf', `${pdfKeys.length} object(s) (via files.file_url)`);
    if (r2Groups.length === 0 && pdfKeys.length === 0) console.log('  No R2 objects found for this user.');
    row('  TOTAL', `${r2Total + pdfKeys.length} objects, ${bytes(r2Bytes)}`);

    if (!apply && (r2Total || pdfKeys.length)) {
      // Owner ruling 2026-09-12 (Q8): the R2 half runs against PRODUCTION only —
      // there are no staging R2 credentials, so this code can never be rehearsed
      // and the first real erasure is its first real exercise. The dry run
      // therefore prints every key it would delete, so an admin can eyeball the
      // actual list before confirming.
      console.log('\n  EXACT KEYS THAT WOULD BE DELETED (no rehearsal is possible — read them):');
      for (const g of r2Groups) {
        console.log(`\n    ${g.prefix}  — ${g.label}`);
        for (const k of g.keys) console.log(`      ${k}`);
      }
      if (pdfKeys.length) {
        console.log('\n    order PDFs (via files.file_url):');
        for (const k of pdfKeys) console.log(`      ${k}`);
      }
    }

    section('7. RESIDUAL INLINE BYTES IN POSTGRES (go with the row delete)');
    for (const [k, v] of Object.entries(inline)) row(`    ${k}`, bytes(v));

    if (!apply) {
      section('DRY RUN COMPLETE — NOTHING WAS WRITTEN');
      console.log(`  To perform the erasure:\n`);
      console.log(`    node scripts/admin/delete-user-data.js --email=${email} --confirm=${email}`
        + `${production ? ' --production' : ''}\n`);
      console.log('  Before you do: verify the requester\'s identity per docs/gdpr-erasure.md.');
      return;
    }

    // ── LIVE ────────────────────────────────────────────────────────────────
    section('EXECUTING — one transaction, R2 only after COMMIT');

    const deleted = {};
    const del = async (label, sql, params) => {
      const res = await client.query(sql, params);
      deleted[label] = res.rowCount;
      console.log(`  deleted ${String(res.rowCount).padStart(6)}  ${label}`);
    };

    await client.query('BEGIN');

    // Phase B — anonymise BEFORE anything cascades. orders.user_id is
    // ON DELETE CASCADE: DELETE FROM users would destroy the retained rows.
    const setNull = ORDER_PII_COLUMNS.map((c) => `${c} = NULL`).join(', ');
    const anonRes = await client.query(
      `UPDATE orders SET ${setNull}, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [user.id],
    );
    console.log(`  anonymised ${String(anonRes.rowCount).padStart(3)}  orders (retained, unlinked)`);

    // Owner ruling 2026-09-12 (Q2/Q3): other users' `referred_by` and
    // `orders.referral_code_used` are NOT rewritten — they are third parties'
    // own rows. The erased person's name-bearing code survives there; the
    // counts above and on the receipt keep that accepted limit visible.

    // Ledgers: move to the sentinel BEFORE the users delete cascades them away
    // (ruling Q1). Scrub the free text and the pointer on the way — a move
    // without a scrub is a relabelling, not an erasure.
    const sentinelState = await ensureSentinelUser(client);
    console.log(`  sentinel user ${GDPR_SENTINEL_USER_ID} — ${sentinelState}`);

    const ctScrub = CREDIT_TX_SCRUB_COLUMNS.map((c) => `${c} = NULL`).join(', ');
    const ctRes = await client.query(
      `UPDATE credit_transactions SET user_id = $1, ${ctScrub} WHERE user_id = $2`,
      [GDPR_SENTINEL_USER_ID, user.id],
    );
    console.log(`  retained   ${String(ctRes.rowCount).padStart(3)}  credit_transactions → sentinel (scrubbed: ${CREDIT_TX_SCRUB_COLUMNS.join(', ')})`);

    const rpScrub = REFERRAL_PAYOUT_SCRUB_COLUMNS.map((c) => `${c} = NULL`).join(', ');
    const rpRes = await client.query(
      `UPDATE referral_payouts SET user_id = $1, ${rpScrub} WHERE user_id = $2`,
      [GDPR_SENTINEL_USER_ID, user.id],
    );
    console.log(`  retained   ${String(rpRes.rowCount).padStart(3)}  referral_payouts → sentinel (scrubbed: ${REFERRAL_PAYOUT_SCRUB_COLUMNS.join(', ')})`);

    const beRes = await client.query(
      'UPDATE referral_events SET buyer_user_id = $1 WHERE buyer_user_id = $2', [USER_TOMBSTONE, user.id],
    );
    console.log(`  tombstoned ${String(beRes.rowCount).padStart(3)}  referral_events.buyer_user_id`);

    const psRes = await client.query(
      'UPDATE referral_payouts SET source_user_id = $1 WHERE source_user_id = $2', [USER_TOMBSTONE, user.id],
    );
    console.log(`  tombstoned ${String(psRes.rowCount).padStart(3)}  referral_payouts.source_user_id`);

    // Phase C — story-scoped satellites with NO foreign key.
    const sids = storyIds.length ? storyIds : [''];
    await del('consolidator_calls', 'DELETE FROM consolidator_calls WHERE story_id = ANY($1)', [sids]);
    await del('story_metrics', 'DELETE FROM story_metrics WHERE story_id = ANY($1)', [sids]);
    await del('story_scores', 'DELETE FROM story_scores WHERE story_id = ANY($1)', [sids]);
    await del('failure_log (by story)', 'DELETE FROM failure_log WHERE story_id = ANY($1)', [sids]);

    // Phase D — owned rows. stories cascades story_images / story_retry_images /
    // style_lab_images / benchmark_scenes; story_jobs cascades story_job_checkpoints.
    await del('stories (+4 cascades)', 'DELETE FROM stories WHERE user_id = $1', [user.id]);
    await del('characters', 'DELETE FROM characters WHERE user_id = $1', [user.id]);
    await del('story_jobs (+checkpoints)', 'DELETE FROM story_jobs WHERE user_id = $1', [user.id]);
    await del('story_drafts', 'DELETE FROM story_drafts WHERE user_id = $1', [user.id]);
    await del('files', 'DELETE FROM files WHERE user_id = $1', [user.id]);
    await del('trial_events', 'DELETE FROM trial_events WHERE user_id = $1', [user.id]);
    await del('failure_log (by user)',
      "DELETE FROM failure_log WHERE $1 ~ '^[0-9a-fA-F-]{36}$' AND user_id = $1::uuid", [user.id]);
    await del('stripe_webhook_retry (processed)',
      'DELETE FROM stripe_webhook_retry WHERE processed_at IS NOT NULL AND payload::text ILIKE $1',
      [`%${user.email}%`]);
    await del('logs', 'DELETE FROM logs WHERE user_id = $1', [user.id]);

    // Phase E — the user row. Cascades referral_events (as referrer). orders is
    // already detached and the two ledgers already belong to the sentinel, so
    // nothing retained is in the cascade's path any more (Phase B).
    await del('users', 'DELETE FROM users WHERE id = $1', [user.id]);
    if (deleted.users !== 1) throw new Error(`Expected to delete exactly 1 user row, deleted ${deleted.users}`);

    // Phase F — the receipt. The FACT of the erasure, never the erased content:
    // the subject's id only, no email, no name. Written after the per-user logs
    // delete so it is not swept by its own run. actor = the admin who ran it.
    await client.query(
      'INSERT INTO logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
      [null, actor, 'GDPR_ERASURE', JSON.stringify({
        erasedUserId: user.id,
        environment: envName,
        at: ch(new Date()),
        deleted,
        anonymisedOrders: anonRes.rowCount,
        retainedToSentinel: {
          sentinelUserId: GDPR_SENTINEL_USER_ID,
          sentinel: sentinelState,
          creditTransactions: ctRes.rowCount,
          referralPayouts: rpRes.rowCount,
        },
        referralTombstones: { buyerEvents: beRes.rowCount, payoutSource: psRes.rowCount },
        // Accepted limit (ruling Q2/Q3): the name-bearing code survives here.
        thirdPartyRowsStillCarryingTheCode: {
          usersReferredBy: referees.length,
          ordersReferralCodeUsed: ordersUsingCode,
        },
        r2PrefixesQueued: prefixes.length,
      })],
    );

    await client.query('COMMIT');
    console.log('\n  ✓ transaction COMMITTED');

    // ── Phase G — R2, only after the commit ────────────────────────────────
    section('R2 DELETION (post-commit)');
    let r2Deleted = 0;
    for (const [prefix] of prefixes) {
      r2Deleted += await r2.deleteByPrefix(prefix);
    }
    for (const key of pdfKeys) {
      if (await r2.deleteObject(key)) r2Deleted++;
      else throw new Error(`R2 deleteObject failed for order PDF "${key}" — the file still exists.`);
    }
    console.log(`  deleted ${r2Deleted} object(s)`);

    // deleteByPrefix logs failures and returns a count rather than throwing, so
    // verify independently: anything still listed under these prefixes is a
    // FAILED erasure and must be reported as one.
    const leftovers = [];
    for (const [prefix] of prefixes) {
      const rest = await listPrefix(s3, prefix);
      if (rest.length) leftovers.push(`${prefix} (${rest.length} objects)`);
    }
    if (leftovers.length) {
      throw new Error('R2 VERIFICATION FAILED — objects survive under: ' + leftovers.join(', ')
        + '. The database rows are gone but the images are NOT. Erasure is INCOMPLETE.');
    }
    console.log('  ✓ verified: 0 objects remain under every prefix');

    receipt = {
      user, deleted, anon: anonRes.rowCount, orders, r2Deleted, beRes, psRes, envName, actor,
      ctRes, rpRes, sentinelState, referees: referees.length, ordersUsingCode,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already closed */ }
    section('FAILED');
    console.error(`  ✗ ${err.message}`);
    console.error('\n  The transaction was rolled back. If this failed AFTER the commit line');
    console.error('  above printed, the database is erased but R2 may not be — re-run the');
    console.error('  R2 prefixes by hand and do NOT report the request as closed.\n');
    console.error(err.stack);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
    await pool.end();
  }

  // ── Receipt ─────────────────────────────────────────────────────────────
  if (!receipt) return;
  section('RECEIPT');
  row('Environment', receipt.envName);
  row('Erased user id', receipt.user.id);
  row('Performed by', receipt.actor);
  row('Completed', ch(new Date()));
  console.log('\n  DELETED');
  for (const [k, v] of Object.entries(receipt.deleted)) row(`    ${k}`, v);
  row('    R2 objects', receipt.r2Deleted);
  console.log('\n  ANONYMISED (retained under a legal obligation)');
  row('    orders', `${receipt.anon} row(s)`);
  console.log('    Rule: Swiss OR art. 958f business records, 10 years (privacy policy says');
  console.log('    10 years too); GDPR art. 17(3)(b). Person unlinked, financial row kept.');
  console.log('\n  RETAINED AS AUDIT TRAIL (moved to the sentinel user, free text scrubbed)');
  row('    sentinel user', `${GDPR_SENTINEL_USER_ID} (${receipt.sentinelState})`);
  row('    credit_transactions', `${receipt.ctRes.rowCount} row(s)`);
  row('    referral_payouts', `${receipt.rpRes.rowCount} row(s)`);
  console.log('    Ruling Q1 (2026-09-12): amounts, types, dates and Stripe references kept;');
  console.log('    description / reference_id cleared. The sentinel is not a person.');
  console.log('\n  TOMBSTONED (the erased id removed from a row that records someone else)');
  row('    referral_events.buyer_user_id', receipt.beRes.rowCount);
  row('    referral_payouts.source_user_id', receipt.psRes.rowCount);
  console.log('\n  ACCEPTED LIMIT — the erased person\'s referral code (which contains their');
  console.log('  first name) is left on third parties\' own rows (ruling Q2/Q3, 2026-09-12):');
  row('    users.referred_by', `${receipt.referees} row(s)`);
  row('    orders.referral_code_used', `${receipt.ordersUsingCode} retained order row(s)`);
  console.log('\n  STILL OUTSTANDING — manual, outside this system');
  if (receipt.orders.length) {
    console.log('    • Stripe: request deletion/redaction of the customer object for sessions');
    console.log(`      ${receipt.orders.map((o) => o.stripe_session_id).filter(Boolean).join(', ')}`);
    const g = receipt.orders.map((o) => o.gelato_order_id).filter(Boolean);
    if (g.length) console.log(`    • Gelato: request deletion of order(s) ${g.join(', ')} (address + book PDF)`);
  } else {
    console.log('    • none (no orders)');
  }
  console.log('\n  Audit row written to `logs` as GDPR_ERASURE (id + counts only).');
  console.log('  Close the request per docs/gdpr-erasure.md.\n');
}

main().catch((err) => {
  console.error('\n✗ FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
