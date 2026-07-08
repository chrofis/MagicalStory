-- Actual amount paid for credit purchases.
--
-- The Stripe webhook stores amount_total here for 'purchase' rows so
-- /api/user/orders can show what the customer really paid. Credit packages
-- have volume discounts (750 credits = CHF 20, not CHF 37.50), so the price
-- cannot be derived from the credit count. Rows from before this column
-- only carry the amount inside the description text ("... (CHF 20.00)");
-- the orders endpoint parses that as a fallback.

ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS price_cents INT;
