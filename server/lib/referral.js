/**
 * Shared referral code generation utility.
 * Used by both the API endpoint (print.js) and DB backfill (database.js).
 */
const crypto = require('crypto');

/**
 * Generate a referral code in the format "MagicRoger427".
 * 3-digit suffix → 900 slots per name. Caller retries on unique constraint violation.
 * @param {string} username - the user's display name (first name or username)
 */
function generateReferralCode(username = '') {
  const clean = username.replace(/[^a-zA-Z]/g, '').slice(0, 10);
  const name = clean ? clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase() : 'User';
  const num = crypto.randomInt(100, 1000); // [100, 1000) = 900 slots
  return `Magic${name}${num}`;
}

/**
 * Canonical form of an email for the self-referral check (review 2026-10-04 P9): lowercase,
 * strip a +tag, and strip dots for gmail.com/googlemail.com (which ignore them). Two accounts
 * whose canonical emails are equal belong to the same inbox. Returns '' for a non-email.
 */
function normalizeEmailForSelfReferral(email) {
  if (typeof email !== 'string') return '';
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return '';
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/**
 * Give back the buyer's one-referral-code claim when the checkout that claimed it never paid
 * (review 2026-10-04 P3). print.js claims users.referred_by when the Stripe session is created
 * (TOCTOU lock); without this an abandoned checkout locks the buyer out of every promo code.
 * Released only if THIS session produced no order and no referral event exists for the buyer.
 *
 * @returns {Promise<boolean>} true when a claim was released
 */
async function releaseReferralClaim(pool, { userId, code, sessionId }) {
  if (!userId || !code || !sessionId) return false;
  const res = await pool.query(
    `UPDATE users SET referred_by = NULL
      WHERE id = $1 AND referred_by = $2
        AND NOT EXISTS (SELECT 1 FROM orders WHERE stripe_session_id = $3)
        AND NOT EXISTS (SELECT 1 FROM referral_events WHERE buyer_user_id = $1)`,
    [userId, code, sessionId]
  );
  return res.rowCount === 1;
}

module.exports = { generateReferralCode, normalizeEmailForSelfReferral, releaseReferralClaim };
