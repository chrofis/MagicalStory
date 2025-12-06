-- Migration: Add shipping address and quota columns to users table (MySQL)
-- Date: 2025-12-06

-- Add shipping address columns to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS shipping_first_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS shipping_last_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS shipping_address_line1 VARCHAR(500),
ADD COLUMN IF NOT EXISTS shipping_city VARCHAR(255),
ADD COLUMN IF NOT EXISTS shipping_post_code VARCHAR(50),
ADD COLUMN IF NOT EXISTS shipping_country VARCHAR(2),
ADD COLUMN IF NOT EXISTS shipping_email VARCHAR(255);

-- Add story quota columns (if they don't exist)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS story_quota INT DEFAULT 2,
ADD COLUMN IF NOT EXISTS stories_generated INT DEFAULT 0;

-- Add role column for admin users (if it doesn't exist)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user';

-- Fix stories table: Add data column for JSON storage
-- The code expects a 'data' JSON column, but schema has individual columns
ALTER TABLE stories
ADD COLUMN IF NOT EXISTS data JSON;
