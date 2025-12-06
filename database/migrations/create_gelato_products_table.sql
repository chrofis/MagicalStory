-- Migration: Create gelato_products table (MySQL)
-- Date: 2025-12-06

CREATE TABLE IF NOT EXISTS gelato_products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_uid VARCHAR(255) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  description TEXT,
  size VARCHAR(100),
  cover_type VARCHAR(100),
  min_pages INT NOT NULL,
  max_pages INT NOT NULL,
  available_page_counts JSON NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Create index on product_uid for faster lookups
CREATE INDEX idx_gelato_products_uid ON gelato_products(product_uid);

-- Create index on is_active for filtering active products
CREATE INDEX idx_gelato_products_active ON gelato_products(is_active);
