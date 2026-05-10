#!/usr/bin/env node
/**
 * seed-staging.js — copy sanitized production data into the staging DB.
 *
 * Usage:
 *   node scripts/admin/seed-staging.js \
 *     --source=$DATABASE_URL_PROD \
 *     --target=$DATABASE_URL_STAGING \
 *     --max-users=5 \
 *     [--sanitize] [--dry-run]
 *
 * What it copies:
 *   - up to N most recently active users (their `users` row)
 *   - all `characters` rows for those users
 *   - all `stories` rows for those users (with full data JSONB)
 *   - all `story_images` rows for those stories (R2 URLs only —
 *     staging won't have the bucket bytes, regenerate if needed)
 *
 * What it sanitizes (with --sanitize, default ON):
 *   - users.email           → staging-user-{id}@test.magicalstory.ch
 *   - users.password_hash   → null (use Google OAuth or password reset)
 *   - users.stripe_customer_id → null
 *   - users.referral_code   → fresh staging-only code
 *   - users.referred_by     → null
 *   - users.email_verified  → true (skip verification on staging)
 *   - users.email_verification_token → null
 *   - users.credits         → 100 (easy testing)
 *
 * What it skips:
 *   - orders, credit_transactions, referral_events (real billing data)
 *   - story_jobs (in-flight jobs from prod don't apply to staging)
 *   - activity_log (real audit trail)
 *   - config (regenerate from defaults on staging)
 *
 * SAFETY: refuses to run if --target points to the same host:port:db as
 * --source. Refuses to run if --target has any data unless --force.
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

function parseArgs(argv) {
  const out = { sanitize: true, dryRun: false, force: false, maxUsers: 5 };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--source=')) out.source = arg.slice(9);
    else if (arg.startsWith('--target=')) out.target = arg.slice(9);
    else if (arg.startsWith('--max-users=')) out.maxUsers = parseInt(arg.slice(12), 10);
    else if (arg === '--no-sanitize') out.sanitize = false;
    else if (arg === '--sanitize') out.sanitize = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') { out.help = true; }
  }
  return out;
}

function urlSummary(connStr) {
  try {
    const u = new URL(connStr);
    return `${u.hostname}:${u.port || 5432}/${u.pathname.slice(1)}`;
  } catch { return '<malformed>'; }
}

function genReferralCode(name) {
  const slug = (name || 'user').replace(/[^A-Za-z]/g, '').slice(0, 8) || 'Stage';
  const suffix = String(Math.floor(100 + Math.random() * 900));
  return `Stage${slug}${suffix}`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.source || !args.target) {
    console.log(`Usage: node seed-staging.js --source=<prod-db-url> --target=<staging-db-url> [--max-users=N] [--no-sanitize] [--dry-run] [--force]`);
    process.exit(args.help ? 0 : 1);
  }
  if (urlSummary(args.source) === urlSummary(args.target)) {
    console.error('REFUSED: --source and --target point at the same database. This script writes to --target; it would corrupt prod.');
    process.exit(1);
  }

  console.log(`📦 seed-staging`);
  console.log(`   source: ${urlSummary(args.source)} (read-only)`);
  console.log(`   target: ${urlSummary(args.target)} (writes)`);
  console.log(`   max users: ${args.maxUsers}, sanitize: ${args.sanitize}, dry-run: ${args.dryRun}`);

  const src = new Pool({ connectionString: args.source, ssl: { rejectUnauthorized: false } });
  const dst = new Pool({ connectionString: args.target, ssl: { rejectUnauthorized: false } });

  // Safety: refuse if target already has users (unless --force).
  if (!args.force) {
    const existing = await dst.query('SELECT COUNT(*)::int AS n FROM users').catch(() => null);
    if (existing && existing.rows[0].n > 0) {
      console.error(`REFUSED: target already has ${existing.rows[0].n} users. Re-run with --force to overwrite.`);
      await src.end(); await dst.end();
      process.exit(1);
    }
  }

  // Pick the top N users by recent activity (last story job).
  const userQ = await src.query(`
    SELECT u.*
    FROM users u
    LEFT JOIN LATERAL (
      SELECT MAX(created_at) AS last_seen FROM stories WHERE user_id = u.id
    ) s ON true
    ORDER BY COALESCE(s.last_seen, u.created_at) DESC
    LIMIT $1
  `, [args.maxUsers]);
  const users = userQ.rows;
  console.log(`\n👥 Selected ${users.length} users:`);
  for (const u of users) {
    console.log(`   - id=${u.id} name="${u.name || ''}" email=${u.email}`);
  }

  if (args.dryRun) {
    console.log('\n(dry-run; not writing to target)');
    await src.end(); await dst.end();
    return;
  }

  const tx = await dst.connect();
  try {
    await tx.query('BEGIN');

    for (const u of users) {
      const sanitized = args.sanitize ? {
        ...u,
        email: `staging-user-${u.id}@test.magicalstory.ch`,
        password_hash: null,
        stripe_customer_id: null,
        referral_code: genReferralCode(u.name),
        referred_by: null,
        email_verified: true,
        email_verification_token: null,
        credits: 100,
      } : u;

      const cols = Object.keys(sanitized);
      const vals = cols.map(c => sanitized[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      await tx.query(
        `INSERT INTO users (${cols.join(',')}) VALUES (${placeholders.join(',')})`,
        vals
      );

      // Characters for this user
      const charR = await src.query('SELECT * FROM characters WHERE user_id = $1', [u.id]);
      for (const c of charR.rows) {
        const ccols = Object.keys(c);
        const cvals = ccols.map(k => c[k]);
        const cph = ccols.map((_, i) => `$${i + 1}`);
        await tx.query(
          `INSERT INTO characters (${ccols.join(',')}) VALUES (${cph.join(',')})`,
          cvals
        );
      }

      // Stories for this user
      const storyR = await src.query('SELECT * FROM stories WHERE user_id = $1', [u.id]);
      for (const s of storyR.rows) {
        const scols = Object.keys(s);
        const svals = scols.map(k => s[k]);
        const sph = scols.map((_, i) => `$${i + 1}`);
        await tx.query(
          `INSERT INTO stories (${scols.join(',')}) VALUES (${sph.join(',')})`,
          svals
        );

        // story_images for this story (R2 URLs survive; data bytes were
        // already extracted to R2 in prod, so staging gets refs that resolve
        // against the *prod* R2 bucket. For genuine staging isolation, plan
        // a follow-up step that copies R2 objects between buckets.)
        const imgR = await src.query('SELECT * FROM story_images WHERE story_id = $1', [s.id]);
        for (const img of imgR.rows) {
          const icols = Object.keys(img);
          const ivals = icols.map(k => img[k]);
          const iph = icols.map((_, i) => `$${i + 1}`);
          await tx.query(
            `INSERT INTO story_images (${icols.join(',')}) VALUES (${iph.join(',')})`,
            ivals
          );
        }
      }

      console.log(`   ✓ migrated user ${u.id} (${charR.rows.length} chars, ${storyR.rows.length} stories)`);
    }

    await tx.query('COMMIT');
    console.log(`\n✅ Done. Staging DB seeded with ${users.length} users.`);
    if (args.sanitize) {
      console.log(`   Test login emails: staging-user-{id}@test.magicalstory.ch`);
      console.log(`   No passwords — use Google OAuth or trigger password-reset flow.`);
    }
    console.log(`   ⚠️  Note: story_images point at the prod R2 bucket. New images on staging`);
    console.log(`           write to the staging R2 bucket. Mixing is fine for browsing /`);
    console.log(`           reading; clean separation needs an R2 bucket-copy step.`);
  } catch (err) {
    await tx.query('ROLLBACK');
    console.error(`❌ Failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  } finally {
    tx.release();
    await src.end();
    await dst.end();
  }
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
