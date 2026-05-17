// Trial reminder email sweep.
//
// Two reminders per unclaimed trial account, gated by per-row timestamp columns:
//   - day5  : sent 5 days after trial creation, while claim_token is still live.
//   - day25 : sent inside the last 5 days before claim_token_expires.
//
// The claim token currently lasts 30 days (see server.js around the trial
// story-complete email block). Day-25 ≈ 5 days before expiry.
//
// Each account can receive each reminder at most once — the timestamp columns
// trial_reminder_5d_sent_at / trial_reminder_25d_sent_at are the dedupe key.
// Migration 004 adds them.
//
// We deliberately skip attaching the trial PDF on reminders: the user already
// has the original story-complete email with the PDF; resending it doubles
// Resend bandwidth, costs us PDF re-generation compute, and doesn't move the
// needle on whether they click the claim link.

const { CREDIT_CONFIG } = require('../config/credits');
const email = require('../../email');

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.BASE_URL || 'https://magicalstory.ch';

// Per-sweep cap so a backlog can't pin a worker on Resend rate limits.
const PER_SWEEP_CAP = 50;

function buildClaimUrl(token) {
  return `${FRONTEND_URL}/claim/${token}`;
}

function daysUntil(date) {
  if (!date) return 0;
  const ms = new Date(date).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

async function fetchLatestStoryTitle(dbPool, userId) {
  try {
    const result = await dbPool.query(
      `SELECT data->>'title' AS title
         FROM stories
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );
    return result.rows[0]?.title || null;
  } catch (err) {
    // Non-fatal — title is only used as a soft hint; reminders don't require it.
    return null;
  }
}

async function sendOne(dbPool, log, row, reminderType) {
  const claimUrl = buildClaimUrl(row.claim_token);
  const firstName = row.shipping_first_name || row.username?.split(' ')[0] || null;
  const language = row.preferred_language || 'English';
  const storyTitle = await fetchLatestStoryTitle(dbPool, row.id);
  const daysLeft = reminderType === 'day25' ? daysUntil(row.claim_token_expires) : null;

  const result = await email.sendTrialReminderEmail(row.email, firstName, claimUrl, language, {
    reminderType,
    daysLeft,
    storyTitle,
    // PDF intentionally omitted — see file header.
  });

  if (!result) {
    throw new Error(`sendTrialReminderEmail returned null for ${row.email}`);
  }

  const column = reminderType === 'day5'
    ? 'trial_reminder_5d_sent_at'
    : 'trial_reminder_25d_sent_at';
  await dbPool.query(`UPDATE users SET ${column} = NOW() WHERE id = $1`, [row.id]);
  log.info(`[trial-reminders] sent ${reminderType} to ${row.email} (lang=${language})`);
}

async function runTrialReminderSweep(dbPool, log = console) {
  if (!dbPool) {
    log.warn?.('[trial-reminders] no dbPool, skipping sweep');
    return { sent: { day5: 0, day25: 0 }, errors: 0 };
  }
  if (!email.isEmailConfigured()) {
    log.info?.('[trial-reminders] email not configured, skipping sweep');
    return { sent: { day5: 0, day25: 0 }, errors: 0 };
  }

  const counts = { day5: 0, day25: 0 };
  let errors = 0;

  // Day 5 — created 5+ days ago, token still valid, not yet reminded.
  try {
    const { rows: day5Rows } = await dbPool.query(
      `SELECT id, email, username, shipping_first_name, preferred_language,
              claim_token, claim_token_expires
         FROM users
        WHERE is_trial = TRUE
          AND has_set_password = FALSE
          AND claim_token IS NOT NULL
          AND claim_token_expires > NOW()
          AND created_at < NOW() - INTERVAL '5 days'
          AND trial_reminder_5d_sent_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1`,
      [PER_SWEEP_CAP]
    );

    for (const row of day5Rows) {
      try {
        await sendOne(dbPool, log, row, 'day5');
        counts.day5 += 1;
      } catch (err) {
        errors += 1;
        log.error?.(`[trial-reminders] day5 failed for ${row.email}: ${err.message}`);
      }
    }
  } catch (err) {
    errors += 1;
    log.error?.(`[trial-reminders] day5 query failed: ${err.message}`);
  }

  // Day 25 — token expires within 5 days, not yet reminded.
  try {
    const { rows: day25Rows } = await dbPool.query(
      `SELECT id, email, username, shipping_first_name, preferred_language,
              claim_token, claim_token_expires
         FROM users
        WHERE is_trial = TRUE
          AND has_set_password = FALSE
          AND claim_token IS NOT NULL
          AND claim_token_expires > NOW()
          AND claim_token_expires < NOW() + INTERVAL '5 days'
          AND trial_reminder_25d_sent_at IS NULL
        ORDER BY claim_token_expires ASC
        LIMIT $1`,
      [PER_SWEEP_CAP]
    );

    for (const row of day25Rows) {
      try {
        await sendOne(dbPool, log, row, 'day25');
        counts.day25 += 1;
      } catch (err) {
        errors += 1;
        log.error?.(`[trial-reminders] day25 failed for ${row.email}: ${err.message}`);
      }
    }
  } catch (err) {
    errors += 1;
    log.error?.(`[trial-reminders] day25 query failed: ${err.message}`);
  }

  if (counts.day5 || counts.day25 || errors) {
    log.info?.(`[trial-reminders] sweep done: day5=${counts.day5} day25=${counts.day25} errors=${errors}`);
  }
  return { sent: counts, errors };
}

module.exports = { runTrialReminderSweep };
