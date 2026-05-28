/**
 * Trial completion email helper.
 *
 * Trial accounts are created with a placeholder email (`anon_<uuid>@anonymous`)
 * that Resend rejects. The unified pipeline skips the story-complete email send
 * for those accounts. This helper sends the deferred email later, when the user
 * claims the trial account with a real email (verify-email link click, Google
 * link, or password-set conversion).
 *
 * Idempotent via `users.trial_completion_email_sent_at`: once sent, we don't
 * resend on re-verification or repeat claims.
 */

const crypto = require('crypto');
const { log } = require('../utils/logger');
const { getPool, isDatabaseMode, rehydrateStoryImages } = require('../services/database');
const { generateViewPdf } = require('./pdf');
const email = require('../../email');

const ANON_EMAIL_RE = /^anon_.+@anonymous$/i;

async function sendTrialCompletionEmailIfDeferred(userId) {
  if (!isDatabaseMode()) return { sent: false, reason: 'no-db' };
  const pool = getPool();
  if (!pool) return { sent: false, reason: 'no-pool' };

  try {
    // Check user state: real email, no prior send, has a completed trial story.
    const userRes = await pool.query(
      `SELECT id, email, username, shipping_first_name, preferred_language,
              claim_token, trial_completion_email_sent_at
         FROM users WHERE id = $1`,
      [userId]
    );
    if (userRes.rows.length === 0) return { sent: false, reason: 'no-user' };

    const user = userRes.rows[0];
    if (!user.email || ANON_EMAIL_RE.test(user.email)) {
      return { sent: false, reason: 'still-anon' };
    }
    if (user.trial_completion_email_sent_at) {
      return { sent: false, reason: 'already-sent' };
    }

    // Find the most recent completed story for this user.
    const storyRes = await pool.query(
      `SELECT id, data
         FROM stories
        WHERE user_id = $1
          AND data->>'isPartial' IS DISTINCT FROM 'true'
        ORDER BY (data->>'createdAt') DESC NULLS LAST
        LIMIT 1`,
      [userId]
    );
    if (storyRes.rows.length === 0) return { sent: false, reason: 'no-story' };

    const storyId = storyRes.rows[0].id;
    let storyData = typeof storyRes.rows[0].data === 'string'
      ? JSON.parse(storyRes.rows[0].data)
      : storyRes.rows[0].data;

    // Generate the PDF (same path as the unified pipeline).
    storyData = await rehydrateStoryImages(storyId, storyData);
    const pdfBuffer = await generateViewPdf(storyData, 'A4', { trialLayout: true });
    const pdfSizeMB = pdfBuffer.length / 1024 / 1024;

    const emailOptions = {};
    if (pdfSizeMB <= 35) {
      emailOptions.pdfBuffer = pdfBuffer;
      emailOptions.pdfFilename = `${storyData.title || 'story'}.pdf`;
    } else {
      log.warn(`[TRIAL-EMAIL] PDF too large (${pdfSizeMB.toFixed(2)}MB) — sending without attachment`);
    }

    // Reuse / generate a claim token so the email's claim link works.
    let claimToken = user.claim_token;
    if (!claimToken) {
      claimToken = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await pool.query(
        'UPDATE users SET claim_token = $1, claim_token_expires = $2 WHERE id = $3',
        [claimToken, expires, userId]
      );
    }
    emailOptions.claimUrl = `${process.env.FRONTEND_URL || process.env.BASE_URL || 'https://magicalstory.ch'}/claim/${claimToken}`;

    const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
    const language = storyData.language || user.preferred_language || 'English';
    const title = storyData.title || storyData.metadata?.title || 'Your story';

    await email.sendStoryCompleteEmail(user.email, firstName, title, storyId, language, emailOptions);

    // Mark sent so we don't double-send on repeated verify clicks.
    await pool.query(
      'UPDATE users SET trial_completion_email_sent_at = CURRENT_TIMESTAMP WHERE id = $1',
      [userId]
    );

    log.info(`[TRIAL-EMAIL] Sent deferred completion email to ${user.email} for story ${storyId}`);
    return { sent: true, storyId };
  } catch (err) {
    log.error(`[TRIAL-EMAIL] Failed to send deferred completion email for ${userId}: ${err.message}`);
    return { sent: false, reason: 'error', error: err.message };
  }
}

module.exports = { sendTrialCompletionEmailIfDeferred };
