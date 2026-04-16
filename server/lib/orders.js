/**
 * Order helpers — small utilities used across routes / webhooks.
 *
 * The "first-time buyer" rule: a user can only redeem someone else's referral
 * code at checkout if they have NO past paid orders. hasPaidOrder() is the
 * canonical check, used both at validation time (POST /referral/validate)
 * AND at webhook completion time (race protection — two simultaneous
 * checkouts could both pass the gate, the webhook closes the window).
 */

const { getPool } = require('../services/database');

/**
 * Returns true iff the user has at least one paid order. Trial stories,
 * canceled checkouts, and unpaid orders do NOT count.
 *
 * @param {string} userId
 * @param {object} [dbClient] Optional pg client for use inside a transaction.
 *                            Defaults to the shared pool.
 * @returns {Promise<boolean>}
 */
async function hasPaidOrder(userId, dbClient = null) {
  if (!userId) return false;
  const conn = dbClient || getPool();
  const result = await conn.query(
    `SELECT 1 FROM orders WHERE user_id = $1 AND payment_status = 'paid' LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}

module.exports = {
  hasPaidOrder,
};
