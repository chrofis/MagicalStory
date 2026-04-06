-- Migration: Subtract CHF 10 shipping from all book prices
-- Date: 2026-04-06
-- Reason: Display book price separately from shipping (CHF 10) so the headline
-- price looks lower. Shipping is shown as a separate line item, applied once
-- per order regardless of quantity. Replaces the old multi-book "discount" model.

UPDATE pricing_tiers
SET
  softcover_price = softcover_price - 10,
  hardcover_price = hardcover_price - 10,
  updated_at = NOW();
