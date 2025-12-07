-- Migration: Add shipping address columns (final fix)
-- Date: 2025-12-07
-- This ensures shipping columns exist even if previous migrations failed

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS shipping_first_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS shipping_last_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS shipping_address_line1 VARCHAR(500),
  ADD COLUMN IF NOT EXISTS shipping_city VARCHAR(255),
  ADD COLUMN IF NOT EXISTS shipping_post_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS shipping_country VARCHAR(2),
  ADD COLUMN IF NOT EXISTS shipping_email VARCHAR(255);
