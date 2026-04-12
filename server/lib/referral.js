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

module.exports = { generateReferralCode };
