-- Migration: Add shipping columns (simple version)
-- Date: 2025-12-07
-- Adds shipping address columns to users table
-- Note: Errors for existing columns will be ignored by migration runner

ALTER TABLE users ADD COLUMN shipping_first_name VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_last_name VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_address_line1 VARCHAR(500);
ALTER TABLE users ADD COLUMN shipping_city VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_post_code VARCHAR(50);
ALTER TABLE users ADD COLUMN shipping_country VARCHAR(2);
ALTER TABLE users ADD COLUMN shipping_email VARCHAR(255);
