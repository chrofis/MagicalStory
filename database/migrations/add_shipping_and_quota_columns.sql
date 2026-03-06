-- Migration: Add shipping address and quota columns to users table (MySQL)
-- Date: 2025-12-06
-- NOTE: MySQL doesn't support IF NOT EXISTS for ALTER TABLE, so we handle errors gracefully

-- Add shipping address columns to users table (one at a time to handle errors)
ALTER TABLE users ADD COLUMN shipping_first_name VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_last_name VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_address_line1 VARCHAR(500);
ALTER TABLE users ADD COLUMN shipping_city VARCHAR(255);
ALTER TABLE users ADD COLUMN shipping_post_code VARCHAR(50);
ALTER TABLE users ADD COLUMN shipping_country VARCHAR(2);
ALTER TABLE users ADD COLUMN shipping_email VARCHAR(255);

-- Add story quota columns
ALTER TABLE users ADD COLUMN story_quota INT DEFAULT 2;
ALTER TABLE users ADD COLUMN stories_generated INT DEFAULT 0;

-- Add role column for admin users
ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'user';

-- Fix stories table: Add data column for JSON storage
ALTER TABLE stories ADD COLUMN data JSON;
