-- Stripe webhook retry buffer.
--
-- The Stripe webhook handler buffers events whose post-verification
-- processing threw — instead of returning 400 (which would make Stripe
-- abandon the event after 3 retries, leaving the customer charged with
-- no order) it now buffers + acks 200. Operators triage via
-- /api/admin/stripe-webhook-retry; the monitor at server.js boot
-- polls this table every 5 min and alerts when rows pile up.
--
-- event_id UNIQUE prevents double-buffering if Stripe re-delivers the
-- same event after our buffer already captured it.

CREATE TABLE IF NOT EXISTS stripe_webhook_retry (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(255) UNIQUE,
  event_type VARCHAR(100),
  payload JSONB NOT NULL,
  error_message TEXT,
  error_stack TEXT,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_retry_unprocessed
  ON stripe_webhook_retry(created_at) WHERE processed_at IS NULL;
