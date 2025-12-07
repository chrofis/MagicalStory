-- Migration: Add shipping address columns to users table (PostgreSQL)
-- Date: 2025-12-07
-- This migration is idempotent - safe to run multiple times

-- Function to add column if it doesn't exist
DO $$
BEGIN
    -- Add shipping_first_name
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='shipping_first_name') THEN
        ALTER TABLE users ADD COLUMN shipping_first_name VARCHAR(255);
    END IF;

    -- Add shipping_last_name
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='shipping_last_name') THEN
        ALTER TABLE users ADD COLUMN shipping_last_name VARCHAR(255);
    END IF;

    -- Add shipping_address_line1
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='shipping_address_line1') THEN
        ALTER TABLE users ADD COLUMN shipping_address_line1 VARCHAR(500);
    END IF;

    -- Add shipping_city
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='shipping_city') THEN
        ALTER TABLE users ADD COLUMN shipping_city VARCHAR(255);
    END IF;

    -- Add shipping_post_code
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='shipping_post_code') THEN
        ALTER TABLE users ADD COLUMN shipping_post_code VARCHAR(50);
    END IF;

    -- Add shipping_country
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='shipping_country') THEN
        ALTER TABLE users ADD COLUMN shipping_country VARCHAR(2);
    END IF;

    -- Add shipping_email
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='users' AND column_name='shipping_email') THEN
        ALTER TABLE users ADD COLUMN shipping_email VARCHAR(255);
    END IF;
END $$;
