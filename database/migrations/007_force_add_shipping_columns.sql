-- Migration: Force add shipping columns (with error handling)
-- Date: 2025-12-07
-- This migration adds each column individually with IF NOT EXISTS

-- Add each column one by one
DO $$
BEGIN
    -- shipping_first_name
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='shipping_first_name'
    ) THEN
        ALTER TABLE users ADD COLUMN shipping_first_name VARCHAR(255);
        RAISE NOTICE 'Added shipping_first_name';
    ELSE
        RAISE NOTICE 'shipping_first_name already exists';
    END IF;
END $$;

DO $$
BEGIN
    -- shipping_last_name
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='shipping_last_name'
    ) THEN
        ALTER TABLE users ADD COLUMN shipping_last_name VARCHAR(255);
        RAISE NOTICE 'Added shipping_last_name';
    ELSE
        RAISE NOTICE 'shipping_last_name already exists';
    END IF;
END $$;

DO $$
BEGIN
    -- shipping_address_line1
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='shipping_address_line1'
    ) THEN
        ALTER TABLE users ADD COLUMN shipping_address_line1 VARCHAR(500);
        RAISE NOTICE 'Added shipping_address_line1';
    ELSE
        RAISE NOTICE 'shipping_address_line1 already exists';
    END IF;
END $$;

DO $$
BEGIN
    -- shipping_city
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='shipping_city'
    ) THEN
        ALTER TABLE users ADD COLUMN shipping_city VARCHAR(255);
        RAISE NOTICE 'Added shipping_city';
    ELSE
        RAISE NOTICE 'shipping_city already exists';
    END IF;
END $$;

DO $$
BEGIN
    -- shipping_post_code
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='shipping_post_code'
    ) THEN
        ALTER TABLE users ADD COLUMN shipping_post_code VARCHAR(50);
        RAISE NOTICE 'Added shipping_post_code';
    ELSE
        RAISE NOTICE 'shipping_post_code already exists';
    END IF;
END $$;

DO $$
BEGIN
    -- shipping_country
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='shipping_country'
    ) THEN
        ALTER TABLE users ADD COLUMN shipping_country VARCHAR(2);
        RAISE NOTICE 'Added shipping_country';
    ELSE
        RAISE NOTICE 'shipping_country already exists';
    END IF;
END $$;

DO $$
BEGIN
    -- shipping_email
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='shipping_email'
    ) THEN
        ALTER TABLE users ADD COLUMN shipping_email VARCHAR(255);
        RAISE NOTICE 'Added shipping_email';
    ELSE
        RAISE NOTICE 'shipping_email already exists';
    END IF;
END $$;
