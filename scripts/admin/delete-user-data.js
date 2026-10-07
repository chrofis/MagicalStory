#!/usr/bin/env node
/**
 * GDPR ERASURE — erase one person's data on request (art. 17, "right to be forgotten").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE MOST DESTRUCTIVE SCRIPT IN THE REPO. Read docs/gdpr-erasure.md
 *  before running it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This file is the CLI only. The table list, the order, the retention rules and
 * the R2 work live in server/lib/userErasure.js — the SAME module the admin
 * route DELETE /api/admin/users/:userId runs. There is one implementation.
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
 * Usage
 *   node scripts/admin/delete-user-data.js --email=person@example.com
 *   node scripts/admin/delete-user-data.js --email=p@x.com --confirm=p@x.com
 *   node scripts/admin/delete-user-data.js --email=p@x.com --confirm=p@x.com --production
 *   ... --actor=<admin username>      # recorded on the audit row (default: OS user)
 */
'use strict';

const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const erasure = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'userErasure.js'));
const { GDPR_SENTINEL_USER_ID } = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'gdprSentinel.js'));
const { ch, fromPgNaive } = require(path.resolve(__dirname, '..', 'lib', 'chTime.js'));

/** Swiss local time for a node-pg naive TIMESTAMP column (CLAUDE.md → Timezone). */
const chPg = (d) => (d ? ch(fromPgNaive(d)) : '(none)');

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

// ─── The plan, printed ───────────────────────────────────────────────────────

function printPlan(plan, apply) {
  const { user, counts, orders, referral, r2, inline } = plan;

  section('1. SUBJECT');
  row('user id', user.id);
  row('username', user.username);
  row('email', user.email);
  row('anonymous account', String(!!user.anonymous));
  row('referral code', user.referral_code || '(none)');
  row('created', chPg(user.created_at));

  section('2. DATABASE — WOULD BE DELETED');
  console.log('  Owned rows (no FK to users — deleted explicitly):');
  for (const [k, v] of Object.entries(counts.owned)) row(`    ${k}`, v);
  console.log('  Story-scoped, no FK on story_id (orphaned unless deleted explicitly):');
  for (const [k, v] of Object.entries(counts.storyDerived)) row(`    ${k}`, v);
  console.log('  Cascades (ON DELETE CASCADE, verified in migrations):');
  for (const [k, v] of Object.entries(counts.cascades)) row(`    ${k}`, v);
  row('    users', 1);
  console.log('  (credit_transactions / referral_payouts are NOT deleted — see §3)');

  section('3. LEDGERS — KEPT, REASSIGNED TO THE SENTINEL USER');
  console.log('  Owner ruling 2026-09-12 (Q1): the credit ledger and the commission ledger');
  console.log('  are retained as an audit trail. Both have user_id NOT NULL with an');
  console.log('  ON DELETE CASCADE FK, so DELETE FROM users would destroy them — the rows');
  console.log('  are moved to a sentinel user first, and scrubbed on the way across.');
  row('  sentinel user id', GDPR_SENTINEL_USER_ID);
  row('  sentinel row on this DB', plan.sentinelExists ? 'already exists' : 'WOULD BE CREATED');
  row('  credit_transactions moved', `${counts.retained.credit_transactions} row(s)`);
  console.log(`      scrubbed: ${erasure.CREDIT_TX_SCRUB_COLUMNS.join(', ')}`);
  console.log('      kept:     amount, balance_after, transaction_type, price_cents, created_at');
  row('  referral_payouts moved', `${counts.retained.referral_payouts} row(s)`);
  console.log(`      scrubbed: ${erasure.REFERRAL_PAYOUT_SCRUB_COLUMNS.join(', ')}`);
  console.log('      kept:     amount_cents, type, balance_after_cents, pending_after_cents,');
  console.log('                order_stripe_session_id, stripe_refund_id, created_at');

  section('4. RETENTION CARVE-OUT — ORDERS ANONYMISED, NOT DELETED');
  if (orders.length === 0) {
    console.log('  No orders. Nothing retained.');
  } else {
    console.log(`  ${orders.length} order row(s) are kept as accounting vouchers and unlinked from the person.`);
    console.log('  Rule: Swiss OR art. 958f — business records, 10 years; GDPR art. 17(3)(b).');
    console.log('        Nothing records WHEN a retained row expires (ruling Q5, 2026-09-12).');
    console.log(`  Columns cleared: ${erasure.ORDER_PII_COLUMNS.join(', ')}`);
    for (const o of orders) {
      row(`    order #${o.id}`, `${(o.amount_total ?? 0) / 100} ${o.currency || ''} ${o.payment_status || ''} — ${chPg(o.created_at)}`);
    }
    const gelato = orders.map((o) => o.gelato_order_id).filter(Boolean);
    if (gelato.length) {
      console.log('\n  ⚠️  THIRD-PARTY FOLLOW-UP REQUIRED (this tool never calls their APIs):');
      console.log(`      Gelato holds the recipient address AND the book PDF for: ${gelato.join(', ')}`);
    }
    console.log('\n  ⚠️  Stripe holds the customer object, email and full address for sessions:');
    console.log(`      ${orders.map((o) => o.stripe_session_id).filter(Boolean).join(', ') || '(none)'}`);
  }

  section('5. REFERRAL HANDLING');
  if (!user.referral_code && referral.referees === 0 && referral.buyerEvents === 0) {
    console.log('  No referral entanglement.');
  } else {
    row('erased code', user.referral_code || '(none)');
    row('referral_events as BUYER', `${referral.buyerEvents} → buyer_user_id = "${erasure.USER_TOMBSTONE}"`);
    row('referral_payouts.source_user_id', `${referral.payoutSource} → "${erasure.USER_TOMBSTONE}"`);
    console.log('\n  ACCEPTED LIMIT — a first name survives on third parties\' rows (ruling Q2/Q3,');
    console.log('  2026-09-12): these rows belong to other people and are left untouched.');
    row('    users.referred_by', `${referral.referees} row(s) still carry "${user.referral_code || '(none)'}"`);
    row('    orders.referral_code_used', `${referral.ordersUsingCode} retained order row(s) still carry it`);
  }

  section('6. R2 OBJECT STORAGE');
  row('R2 bucket', r2.bucket.verified
    ? `${r2.bucket.bucket} (${r2.bucket.cfgHost}) matches this database`
    : `${r2.bucket.bucket} — ⚠️  no stored image URL on this database, bucket NOT verified`);
  for (const g of r2.groups) row(`    ${g.prefix}`, `${g.count} objects, ${bytes(g.bytes)}  — ${g.label}`);
  if (r2.pdfKeys.length) row('    orders/*.pdf', `${r2.pdfKeys.length} object(s) (via files.file_url)`);
  if (r2.objects === 0) console.log('  No R2 objects found for this user.');
  row('  TOTAL', `${r2.objects} objects, ${bytes(r2.bytes)}`);
  if (!apply && r2.objects) {
    console.log('\n  EXACT KEYS THAT WOULD BE DELETED (no rehearsal is possible — read them):');
    for (const g of r2.groups) {
      console.log(`\n    ${g.prefix}  — ${g.label}`);
      for (const k of g.keys) console.log(`      ${k}`);
    }
    if (r2.pdfKeys.length) {
      console.log('\n    order PDFs (via files.file_url):');
      for (const k of r2.pdfKeys) console.log(`      ${k}`);
    }
  }

  section('7. RESIDUAL INLINE BYTES IN POSTGRES (go with the row delete)');
  for (const [k, v] of Object.entries(inline)) row(`    ${k}`, bytes(v));
}

function printReceipt(out, envName, actor) {
  const { result, r2, plan } = out;
  section('RECEIPT');
  row('Environment', envName);
  row('Erased user id', result.erasedUserId);
  row('Performed by', actor);
  row('Completed', ch(new Date()));
  console.log('\n  DELETED');
  for (const [k, v] of Object.entries(result.deleted)) row(`    ${k}`, v);
  row('    R2 objects', r2.deleted);
  console.log('\n  ANONYMISED (retained under a legal obligation)');
  row('    orders', `${result.anonymisedOrders} row(s)`);
  console.log('\n  RETAINED AS AUDIT TRAIL (moved to the sentinel user, free text scrubbed)');
  row('    sentinel user', `${GDPR_SENTINEL_USER_ID} (${result.sentinelState})`);
  row('    credit_transactions', `${result.retainedToSentinel.creditTransactions} row(s)`);
  row('    referral_payouts', `${result.retainedToSentinel.referralPayouts} row(s)`);
  console.log('\n  TOMBSTONED (the erased id removed from a row that records someone else)');
  row('    referral_events.buyer_user_id', result.referralTombstones.buyerEvents);
  row('    referral_payouts.source_user_id', result.referralTombstones.payoutSource);
  console.log('\n  ACCEPTED LIMIT — the erased person\'s referral code (first name) survives on');
  console.log('  third parties\' own rows (ruling Q2/Q3, 2026-09-12):');
  row('    users.referred_by', `${plan.referral.referees} row(s)`);
  row('    orders.referral_code_used', `${plan.referral.ordersUsingCode} retained order row(s)`);
  console.log('\n  STILL OUTSTANDING — manual, outside this system');
  if (plan.orders.length) {
    console.log('    • Stripe: request deletion/redaction of the customer object for sessions');
    console.log(`      ${plan.orders.map((o) => o.stripe_session_id).filter(Boolean).join(', ')}`);
    const g = plan.orders.map((o) => o.gelato_order_id).filter(Boolean);
    if (g.length) console.log(`    • Gelato: request deletion of order(s) ${g.join(', ')} (address + book PDF)`);
  } else {
    console.log('    • none (no orders)');
  }
  console.log('\n  Audit row written to `logs` as GDPR_ERASURE (id + counts only).');
  console.log('  Close the request per docs/gdpr-erasure.md.\n');
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
    die(`--confirm must carry the address: --confirm=${email}  (typing it twice is the interlock; a bare --confirm is refused).`);
  }
  const apply = confirm !== undefined;
  if (apply && confirm.trim().toLowerCase() !== email.trim().toLowerCase()) {
    die(`--confirm ("${confirm}") does not match --email ("${email}"). Nothing was touched.`);
  }

  const connectionString = production ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  const envName = production ? 'PRODUCTION' : 'staging';
  if (!connectionString) die(`${production ? 'DATABASE_URL' : 'STAGING_DATABASE_URL'} is not set in .env — cannot reach ${envName}.`);
  if (production && !apply) console.log('\n⚠️  --production with no --confirm: this is a READ-ONLY dry run against production.\n');

  console.log(`\n╔${'═'.repeat(70)}╗`);
  console.log(`║  GDPR ERASURE  ${(apply ? '*** LIVE — WILL DELETE ***' : 'DRY RUN (nothing is written)').padEnd(54)}║`);
  console.log(`╚${'═'.repeat(70)}╝`);
  row('Target environment', envName);
  row('Subject', email);
  row('Operator', actor);
  row('Time', ch(new Date()));

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let committed = false;
  try {
    const user = await erasure.resolveSubject(client, { email });
    const plan = await erasure.planErasure(client, user);
    printPlan(plan, apply);

    if (!apply) {
      section('DRY RUN COMPLETE — NOTHING WAS WRITTEN');
      console.log('  To perform the erasure:\n');
      console.log(`    node scripts/admin/delete-user-data.js --email=${email} --confirm=${email}${production ? ' --production' : ''}\n`);
      console.log('  Before you do: verify the requester\'s identity per docs/gdpr-erasure.md.');
      return;
    }

    section('EXECUTING — one transaction, R2 only after COMMIT');
    const result = await erasure.executeErasure(client, plan, {
      actor, environment: envName, onStep: (line) => console.log(`  ${line}`),
    });
    committed = true;
    console.log('\n  ✓ transaction COMMITTED');

    section('R2 DELETION (post-commit)');
    const r2Result = await erasure.pruneErasureR2(plan);
    console.log(`  deleted ${r2Result.deleted} object(s)`);
    if (r2Result.failures.length) {
      throw new Error('R2 ERASURE INCOMPLETE:\n    ' + r2Result.failures.join('\n    ')
        + '\n  The database rows are gone but the images are NOT. Finish the R2 deletion by hand.');
    }
    console.log('  ✓ verified: 0 objects remain under every prefix');
    printReceipt({ result, r2: r2Result, plan }, envName, actor);
  } catch (err) {
    section('FAILED');
    if (err.code === 'ERASURE_PREFLIGHT') {
      for (const p of err.problems) console.error(`  ✗ ${p}`);
      console.error('\n  Refusing to proceed. Nothing was touched.');
    } else {
      console.error(`  ✗ ${err.message}`);
      if (committed) {
        console.error('\n  The database is erased but R2 may not be — finish the R2 prefixes by hand');
        console.error('  and do NOT report the request as closed.\n');
      } else {
        console.error('\n  Nothing was committed.\n');
      }
      console.error(err.stack);
    }
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n✗ FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
