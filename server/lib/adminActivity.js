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

/**
 * @param {Pool} dbPool
 * @param {number} hours - lookback window (1..168)
 * @returns {Promise<{since: string, hours: number, summary: Object, events: Array}>}
 */
async function buildActivityFeed(dbPool, hours = 24) {
  const h = Math.min(168, Math.max(1, parseInt(hours, 10) || 24));
  const events = [];

  // New users (registered + anonymous trials)
  const newUsers = await dbPool.query(`
    SELECT email, username, created_at, email_verified,
           COALESCE(anonymous, false) AS anonymous,
           COALESCE(is_trial, false) AS is_trial
    FROM users
    WHERE created_at > NOW() - ($1 * INTERVAL '1 hour')
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

  // Orders
  const orders = await dbPool.query(`
    SELECT o.id, o.created_at, o.payment_status, u.email
    FROM orders o LEFT JOIN users u ON u.id::text = o.user_id::text
    WHERE o.created_at > NOW() - ($1 * INTERVAL '1 hour')
    ORDER BY o.created_at`, [h]);
  for (const o of orders.rows) {
    events.push({
      ts: o.created_at,
      type: 'order',
      user: o.email || '(unknown)',
      label: `Order placed (payment: ${o.payment_status})`,
      orderId: o.id,
    });
  }

  // Credit top-ups / refunds (positive amounts only — generation deductions
  // would just mirror the story events as noise)
  const credits = await dbPool.query(`
    SELECT ct.created_at, ct.amount, ct.transaction_type, ct.description, u.email
    FROM credit_transactions ct LEFT JOIN users u ON u.id = ct.user_id
    WHERE ct.created_at > NOW() - ($1 * INTERVAL '1 hour') AND ct.amount > 0
    ORDER BY ct.created_at`, [h]);
  for (const c of credits.rows) {
    events.push({
      ts: c.created_at,
      type: 'credits',
      user: c.email || '(unknown)',
      label: `+${c.amount} credits (${c.transaction_type}${c.description ? `: ${c.description.slice(0, 80)}` : ''})`,
    });
  }

  events.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const count = (t) => events.filter(e => e.type === t).length;
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
      creditTopUps: count('credits'),
    },
    events,
  };
}

module.exports = { buildActivityFeed };
