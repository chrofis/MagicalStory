-- 044: idempotency flag for the "your order shipped" email.
-- WHY: the email is now triggered by a tracking code on a 'printed' or 'shipped'
-- event (prod order 99 never got a 'shipped' event), so Gelato re-sending events
-- must not re-send the mail. Same pattern as confirmation_email_sent.
-- Backfill: orders that already reached shipped/delivered got the mail under the
-- old rule. Order 99 (printed, shipped_at NULL) is deliberately left FALSE.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_email_sent BOOLEAN DEFAULT FALSE;
UPDATE orders SET shipped_email_sent = TRUE
 WHERE shipped_email_sent IS NOT TRUE
   AND (shipped_at IS NOT NULL OR gelato_status IN ('shipped', 'delivered'));
