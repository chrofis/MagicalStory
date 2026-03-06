-- Migration: Add tracking columns to orders table for Gelato webhook integration
-- This allows storing shipment tracking information from Gelato

-- Add tracking columns if they don't exist
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url VARCHAR(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;

-- Add index on gelato_order_id for faster webhook lookups
CREATE INDEX IF NOT EXISTS idx_orders_gelato_order_id ON orders(gelato_order_id);

-- Add index on gelato_status for filtering
CREATE INDEX IF NOT EXISTS idx_orders_gelato_status ON orders(gelato_status);
