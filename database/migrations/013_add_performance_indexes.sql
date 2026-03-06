-- Migration: Add performance indexes for admin queries
-- These indexes improve query performance for dashboard and reporting

-- Index on users.created_at for sorting users by registration date
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);

-- Index on orders.created_at for sorting orders by date
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

-- Compound index on credit_transactions for user history queries
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_created ON credit_transactions(user_id, created_at DESC);

-- Index on logs.created_at for activity log queries
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);
