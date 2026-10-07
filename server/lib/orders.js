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
  // `payment_status` starts at 'paid' but processBookOrder flips it to
  // 'processing' → 'completed' within seconds (and 'failed' on fulfillment
  // error). All of these represent a genuinely-paid order (rows are only
  // inserted after a successful Stripe payment), so the first-time-buyer
  // gate must treat the whole set as "has paid" — querying 'paid' alone
  // matched almost nothing and let repeat buyers redeem first-time discounts.
  const result = await conn.query(
    `SELECT 1 FROM orders WHERE user_id = $1 AND payment_status IN (${PAID_STATUSES_SQL}) LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}

/** Every payment_status a row inserted after a successful Stripe payment can carry. */
const PAID_STATUSES = ['paid', 'processing', 'completed', 'failed'];
const PAID_STATUSES_SQL = PAID_STATUSES.map(s => `'${s}'`).join(',');

/**
 * The webhook's re-check of the first-time-buyer rule, inside its transaction: does the
 * buyer have a paid order OTHER than the session being completed? Same status set as
 * hasPaidOrder - a check on 'paid' alone misses every earlier order the moment
 * processBookOrder moves it on.
 */
async function hasOtherPaidOrder(dbClient, userId, sessionId) {
  const result = await dbClient.query(
    `SELECT 1 FROM orders
       WHERE user_id = $1
         AND payment_status IN (${PAID_STATUSES_SQL})
         AND stripe_session_id != $2
       LIMIT 1`,
    [userId, sessionId]
  );
  return result.rows.length > 0;
}

/**
 * What GET /api/stripe/order-status/:sessionId may return (review 2026-10-04 P10). The route
 * is unauthenticated - the session id travels in the success URL - so the anonymous view is
 * only the status fields the client reads (amount, currency, tokens). The recipient /
 * shipping details the success dialog shows are added only for the order's own logged-in user.
 */
function orderStatusView(row, viewerUserId = null) {
  const view = {
    amount_total: row.amount_total,
    currency: row.currency,
    tokens_credited: row.tokens_credited,
  };
  if (viewerUserId && row.user_id && String(row.user_id) === String(viewerUserId)) {
    Object.assign(view, {
      customer_name: row.customer_name,
      customer_email: row.customer_email,
      shipping_name: row.shipping_name,
      shipping_address_line1: row.shipping_address_line1,
      shipping_city: row.shipping_city,
      shipping_postal_code: row.shipping_postal_code,
      shipping_country: row.shipping_country,
    });
  }
  return view;
}

module.exports = {
  PAID_STATUSES,
  hasPaidOrder,
  hasOtherPaidOrder,
  orderStatusView,
};
