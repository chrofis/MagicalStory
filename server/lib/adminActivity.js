/**
 * Admin activity feed — derived chronologically from existing tables
 * (no event-log table needed): new users, logins, stories, failed jobs,
 * orders, credit top-ups.
 *
 * Shared by:
 *   - GET /api/admin/activity        (AdminDashboard "Aktivität" tab)
 *   - server/lib/dailySummary.js     (daily admin summary email)
 *
 * Known limitation: `users.last_login` stores only the LATEST login per
 * user, so the feed shows at most one login event per user per window.
 */

'use strict';

const { sentinelExclusion } = require('./gdprSentinel');

// Credit packs are sold in CHF only (server/config/credits.js CREDIT_PACKAGES /
// print.js checkout), and credit_transactions has no currency column — so the
// pack currency is a fact about the product, not a guess about the row.
const CREDIT_PACK_CURRENCY = 'CHF';

/** Order statuses that mean the money was actually collected. */
const PAID_ORDER_STATUSES = new Set(['paid', 'completed']);

/** Stripe stores lowercase ISO codes ('chf'); the report shows them uppercase. */
function normaliseCurrency(c) {
  return String(c || CREDIT_PACK_CURRENCY).toUpperCase();
}

/** Cents -> "CHF 42.00". A missing amount says so instead of showing 0. */
function formatAmount(cents, currency) {
  if (cents == null || !Number.isFinite(cents)) return `${currency} ?`;
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

/**
 * @param {Pool} dbPool
 * @param {number} hours - lookback window (1..168)
 * @returns {Promise<{since: string, hours: number, summary: Object, events: Array}>}
 */
async function buildActivityFeed(dbPool, hours = 24) {
  const h = Math.min(168, Math.max(1, parseInt(hours, 10) || 24));
  const events = [];

  // Revenue accumulates per currency. Cents of different currencies are never
  // added together and no conversion rate is invented — a mixed window reports
  // each currency on its own line.
  const revenueByCurrency = {};
  let revenueUnknownCount = 0;
  const addRevenue = (cents, currency) => {
    if (cents == null || !Number.isFinite(cents)) { revenueUnknownCount++; return; }
    revenueByCurrency[currency] = (revenueByCurrency[currency] || 0) + cents;
  };

  // New users (registered + anonymous trials)
  const newUsers = await dbPool.query(`
    SELECT email, username, created_at, email_verified,
           COALESCE(anonymous, false) AS anonymous,
           COALESCE(is_trial, false) AS is_trial
    FROM users
    WHERE created_at > NOW() - ($1 * INTERVAL '1 hour')
      AND ${sentinelExclusion()}
    ORDER BY created_at`, [h]);
  for (const u of newUsers.rows) {
    events.push({
      ts: u.created_at,
      type: u.anonymous ? 'trial_started' : 'new_user',
      user: u.email,
      label: u.anonymous
        ? 'Anonymous trial account created'
        : `New user registered${u.email_verified ? ' (verified)' : ' (unverified)'}`,
    });
  }

  // Logins (latest per user only — see header note)
  const logins = await dbPool.query(`
    SELECT email, last_login, COALESCE(anonymous, false) AS anonymous
    FROM users
    WHERE last_login > NOW() - ($1 * INTERVAL '1 hour')
      AND last_login > created_at + INTERVAL '5 minutes'
      AND ${sentinelExclusion()}
    ORDER BY last_login`, [h]);
  for (const u of logins.rows) {
    events.push({ ts: u.last_login, type: 'login', user: u.email, label: 'Logged in' });
  }

  // Stories created
  const stories = await dbPool.query(`
    SELECT s.id, s.created_at, s.data->>'title' AS title,
           (s.data->>'pages')::int AS pages, u.email,
           COALESCE(u.anonymous, false) AS anonymous
    FROM stories s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.created_at > NOW() - ($1 * INTERVAL '1 hour')
    ORDER BY s.created_at`, [h]);
  for (const s of stories.rows) {
    events.push({
      ts: s.created_at,
      type: s.anonymous ? 'trial_story' : 'story',
      user: s.email || '(deleted user)',
      label: `Story "${s.title || 'Untitled'}"${s.pages ? ` (${s.pages} pages)` : ''}`,
      storyId: s.id,
    });
  }

  // Failed jobs
  const failed = await dbPool.query(`
    SELECT sj.id, sj.updated_at, sj.error_message, u.email
    FROM story_jobs sj LEFT JOIN users u ON u.id = sj.user_id
    WHERE sj.status = 'failed'
      AND sj.updated_at > NOW() - ($1 * INTERVAL '1 hour')
    ORDER BY sj.updated_at`, [h]);
  for (const j of failed.rows) {
    events.push({
      ts: j.updated_at,
      type: 'job_failed',
      user: j.email || '(unknown)',
      label: `Story generation FAILED: ${(j.error_message || 'no error message').slice(0, 140)}`,
      jobId: j.id,
    });
  }

  // Orders. amount_total/currency are what Stripe charged — the revenue side of
  // the report reads THESE, never a price recomputed from the product config.
  const orders = await dbPool.query(`
    SELECT o.id, o.created_at, o.payment_status, o.amount_total, o.currency,
           o.quantity, o.story_id, u.email
    FROM orders o LEFT JOIN users u ON u.id::text = o.user_id::text
    WHERE o.created_at > NOW() - ($1 * INTERVAL '1 hour')
    ORDER BY o.created_at`, [h]);
  for (const o of orders.rows) {
    const cents = o.amount_total == null ? null : Number(o.amount_total);
    const currency = normaliseCurrency(o.currency);
    events.push({
      ts: o.created_at,
      type: 'order',
      user: o.email || '(unknown)',
      label: `Order placed — ${formatAmount(cents, currency)}${o.quantity > 1 ? ` (${o.quantity}×)` : ''} (payment: ${o.payment_status})`,
      orderId: o.id,
      storyId: o.story_id || undefined,
      amountCents: cents,
      currency,
      quantity: o.quantity == null ? null : Number(o.quantity),
    });
    // Only a paid order is revenue. 'completed' is a LATER state of a paid
    // order (print.js flips it once Gelato accepts the print job), so it counts
    // too; 'failed' rows carry an amount that was never collected and must not
    // inflate the number. They still show in the feed.
    if (PAID_ORDER_STATUSES.has(o.payment_status)) addRevenue(cents, currency);
  }

  // Credit top-ups / refunds (positive amounts only — generation deductions
  // would just mirror the story events as noise)
  const credits = await dbPool.query(`
    SELECT ct.created_at, ct.amount, ct.transaction_type, ct.description,
           ct.price_cents, u.email
    FROM credit_transactions ct LEFT JOIN users u ON u.id = ct.user_id
    WHERE ct.created_at > NOW() - ($1 * INTERVAL '1 hour') AND ct.amount > 0
    ORDER BY ct.created_at`, [h]);
  for (const c of credits.rows) {
    const paid = c.transaction_type === 'purchase';
    if (paid) {
      // A bought pack is money; a signup bonus is not. They get different event
      // types so the report can never present one as the other.
      const cents = c.price_cents == null ? null : Number(c.price_cents);
      events.push({
        ts: c.created_at,
        type: 'credit_purchase',
        user: c.email || '(unknown)',
        label: `+${c.amount} credits purchased — ${formatAmount(cents, CREDIT_PACK_CURRENCY)}${c.description ? ` (${c.description.slice(0, 80)})` : ''}`,
        amountCents: cents,
        currency: CREDIT_PACK_CURRENCY,
      });
      addRevenue(cents, CREDIT_PACK_CURRENCY);
    } else {
      events.push({
        ts: c.created_at,
        type: 'credits',
        user: c.email || '(unknown)',
        label: `+${c.amount} credits (${c.transaction_type}${c.description ? `: ${c.description.slice(0, 80)}` : ''})`,
      });
    }
  }

  events.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const count = (t) => events.filter(e => e.type === t).length;
  const { getApiHealth } = require('./apiHealth');
  const health = await getApiHealth(dbPool, h); // AI provider rate-limit/overload hits
  // EVERY failure, grouped, customer-visible first. Provider limits above are one
  // kind among them and stay broken out for continuity; this is the rest —
  // rejected repairs, failed stages, anything that called recordFailure. It rides
  // the summary the daily report already reads, so a new failure kind needs no
  // second delivery path.
  let failures = null;
  try { failures = await require('./failureLog').summariseFailures({ hours: h }); }
  catch (e) { require('../utils/logger').log.debug(`[ADMIN ACTIVITY] failure summary unavailable: ${e.message}`); }

  return {
    since: new Date(Date.now() - h * 3600 * 1000).toISOString(),
    hours: h,
    summary: {
      newUsers: count('new_user'),
      trialsStarted: count('trial_started'),
      logins: count('login'),
      stories: count('story'),
      trialStories: count('trial_story'),
      failedJobs: count('job_failed'),
      orders: count('order'),
      creditPurchases: count('credit_purchase'),
      creditTopUps: count('credits'),
      purchases: count('order') + count('credit_purchase'),
      revenueByCurrency,
      // Single number only while one currency is in play; null means "look at
      // revenueByCurrency", never "zero".
      revenueCents: Object.keys(revenueByCurrency).length === 1
        ? Object.values(revenueByCurrency)[0]
        : (Object.keys(revenueByCurrency).length === 0 ? 0 : null),
      revenueCurrency: Object.keys(revenueByCurrency).length === 1
        ? Object.keys(revenueByCurrency)[0]
        : null,
      revenueUnknownCount,
      customerFailures: failures?.totals.customer ?? 0,
      internalFailures: failures?.totals.internal ?? 0,
    },
    failures,
    health,
    events,
  };
}

module.exports = { buildActivityFeed, PAID_ORDER_STATUSES, formatAmount, normaliseCurrency, CREDIT_PACK_CURRENCY };
