-- Migration: Add shipping columns (MySQL compatible - fixed version)
-- Date: 2025-12-06
-- Fixes the previous migration that used invalid MySQL syntax

-- Add shipping address columns (MySQL will error if column exists, which is fine)
ALTER TABLE users ADD COLUMN shipping_first_name VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_last_name VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_address_line1 VARCHAR(500);
ALTER TABLE users ADD COLUMN shipping_city VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_post_code VARCHAR(50);
ALTER TABLE users ADD COLUMN shipping_country VARCHAR(2);
ALTER TABLE users ADD COLUMN shipping_email VARCHAR(255);
