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

module.exports = { generateReferralCode, normalizeEmailForSelfReferral };
