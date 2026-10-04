/**
 * Durable record of Stripe-webhook work that failed after the customer paid.
 *
 * Everything lands in stripe_webhook_retry (migration 005) so the 5-minute monitor in
 * server.js keeps logging it at error level and /api/admin/stripe-webhook-retry lists it.
 * Two shapes:
 *  - bufferWebhookEvent: the whole event, when handling it threw (Stripe is acked 200).
 *  - recordPostPaymentFailure: one failed step of an otherwise-saved order (referral
 *    cashback, balance confirm; review 2026-10-04 P7), keyed `<event id>:<step>` so it never
 *    collides with the whole-event row, plus an admin email.
 */
const { log } = require('../utils/logger');

async function bufferWebhookEvent(pool, { eventId, eventType, payload, error }) {
  try {
    await pool.query(
      `INSERT INTO stripe_webhook_retry (event_id, event_type, payload, error_message, error_stack)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, eventType, JSON.stringify(payload), error.message, error.stack || null]
    );
    return true;
  } catch (bufferErr) {
    log.error('❌ [STRIPE WEBHOOK] CRITICAL: failed to buffer event for retry:', bufferErr.message);
    log.error('   Event payload was:', JSON.stringify(payload));
    return false;
  }
}

async function recordPostPaymentFailure(pool, { event, step, sessionId, error, sendAlert }) {
  const buffered = await bufferWebhookEvent(pool, {
    eventId: `${event.id}:${step}`,
    eventType: `post_payment_${step}_failed`,
    payload: { step, sessionId, event },
    error,
  });
  const detail = `Step: ${step}\nStripe session: ${sessionId}\nError: ${error.message}\nBuffered for retry: ${buffered ? 'yes (stripe_webhook_retry)' : 'NO - recording failed too'}\n\nThe order itself was saved. Fix the balance bookkeeping by hand, then dismiss the row at /api/admin/stripe-webhook-retry.`;
  try {
    await sendAlert(`Post-payment step failed: ${step}`, detail);
  } catch (alertErr) {
    log.error(`[STRIPE WEBHOOK] admin alert for failed ${step} could not be sent: ${alertErr.message}`);
  }
  return buffered;
}

module.exports = { bufferWebhookEvent, recordPostPaymentFailure };
