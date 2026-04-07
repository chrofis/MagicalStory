-- Migration: Add quantity column to orders table
-- Date: 2026-04-07
-- Reason: The Stripe webhook and createCheckoutSession write a `quantity`
-- field to record how many copies the user ordered (multi-book support),
-- but the column was never added to the table. Orders were failing with
-- `column "quantity" of relation "orders" does not exist` and the payment
-- succeeded on Stripe while our order row was never created.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;
