-- Migration: Create gelato_products table (PostgreSQL)
-- Date: 2025-12-06

CREATE TABLE IF NOT EXISTS gelato_products (
  id SERIAL PRIMARY KEY,
  product_uid VARCHAR(255) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  description TEXT,
  size VARCHAR(100),
  cover_type VARCHAR(100),
  min_pages INTEGER NOT NULL,
  max_pages INTEGER NOT NULL,
  available_page_counts JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on product_uid for faster lookups
CREATE INDEX IF NOT EXISTS idx_gelato_products_uid ON gelato_products(product_uid);

-- Create index on is_active for filtering active products
CREATE INDEX IF NOT EXISTS idx_gelato_products_active ON gelato_products(is_active);
