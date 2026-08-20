-- Magical Story Platform - Complete Database Schema
-- PostgreSQL 15+
-- Version: 1.0
-- Last Updated: 2025-01-26

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- For text search

-- ============================================================================
-- USERS & AUTHENTICATION
-- ============================================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  email_verified BOOLEAN DEFAULT FALSE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  date_of_birth DATE NOT NULL,
  role VARCHAR(50) DEFAULT 'user' NOT NULL,
  subscription_tier VARCHAR(50) DEFAULT 'free' NOT NULL,

  -- MFA
  mfa_enabled BOOLEAN DEFAULT FALSE,
  mfa_secret VARCHAR(255),
  backup_codes TEXT[],

  -- Security
  account_locked BOOLEAN DEFAULT FALSE,
  locked_until TIMESTAMP,
  failed_login_attempts INTEGER DEFAULT 0,
  last_login TIMESTAMP,

  -- GDPR
  deletion_scheduled_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_role CHECK (role IN ('user', 'premium_user', 'moderator', 'admin')),
  CONSTRAINT valid_tier CHECK (subscription_tier IN ('free', 'basic', 'premium', 'enterprise'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- ============================================================================

CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255) UNIQUE NOT NULL,
  token_family UUID NOT NULL,
  device_info JSONB,
  expires_at TIMESTAMP NOT NULL,
  revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_sessions_token ON user_sessions(refresh_token_hash);

-- ============================================================================

CREATE TABLE social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMP,
  profile_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(provider, provider_user_id)
);

-- ============================================================================
-- CHARACTERS & RELATIONSHIPS
-- ============================================================================

CREATE TABLE characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  gender VARCHAR(20),
  age INTEGER CHECK (age >= 0 AND age <= 150),
  description TEXT,
  hair_color VARCHAR(50),
  physical_features TEXT,
  strengths TEXT[] NOT NULL,
  weaknesses TEXT[] NOT NULL,
  fears TEXT[],
  special_details TEXT,
  photo_url VARCHAR(500),
  thumbnail_url VARCHAR(500),
  version INTEGER DEFAULT 1,
  usage_count INTEGER DEFAULT 0,
  deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT min_strengths CHECK (array_length(strengths, 1) >= 3),
  CONSTRAINT min_weaknesses CHECK (array_length(weaknesses, 1) >= 2)
);

CREATE INDEX idx_characters_user ON characters(user_id) WHERE deleted = FALSE;
CREATE INDEX idx_characters_name ON characters(name);

-- ============================================================================

CREATE TABLE character_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character1_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  character2_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  relationship_type VARCHAR(100) NOT NULL,
  inverse_relationship_type VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT different_characters CHECK (character1_id != character2_id),
  CONSTRAINT unique_relationship UNIQUE (character1_id, character2_id)
);

CREATE INDEX idx_relationships_char1 ON character_relationships(character1_id);
CREATE INDEX idx_relationships_char2 ON character_relationships(character2_id);

-- ============================================================================
-- STORY CONFIGURATION
-- ============================================================================

CREATE TABLE custom_story_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, name)
);

-- ============================================================================

CREATE TABLE story_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  story_type VARCHAR(100) NOT NULL,
  custom_story_type_id UUID REFERENCES custom_story_types(id),
  language VARCHAR(10) NOT NULL,
  number_of_pages INTEGER NOT NULL CHECK (number_of_pages BETWEEN 3 AND 30),
  reading_level VARCHAR(20) NOT NULL,
  main_character_ids UUID[] NOT NULL,
  supporting_character_ids UUID[],
  status VARCHAR(20) DEFAULT 'draft',
  last_used_at TIMESTAMP,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_reading_level CHECK (reading_level IN ('1st-grade', 'standard', 'advanced')),
  CONSTRAINT main_char_count CHECK (array_length(main_character_ids, 1) BETWEEN 1 AND 2)
);

CREATE INDEX idx_story_configs_user ON story_configurations(user_id);

-- ============================================================================
-- STORIES
-- ============================================================================

CREATE TABLE stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  configuration_id UUID NOT NULL REFERENCES story_configurations(id),
  title VARCHAR(500),
  language VARCHAR(10) NOT NULL,
  reading_level VARCHAR(20) NOT NULL,
  num_pages INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'generating',

  -- AI Metadata
  ai_model VARCHAR(100),
  ai_provider VARCHAR(50),
  prompt_version VARCHAR(20),
  tokens_used INTEGER,
  generation_time_ms INTEGER,
  cost_usd DECIMAL(10, 4),

  -- Versioning
  version INTEGER DEFAULT 1,
  parent_story_id UUID REFERENCES stories(id),

  -- Content reference (MongoDB)
  content_ref VARCHAR(100),

  -- Status
  deleted BOOLEAN DEFAULT FALSE,
  deletion_scheduled_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,

  CONSTRAINT valid_status CHECK (status IN ('queued', 'generating', 'completed', 'failed', 'approved', 'rejected'))
);

CREATE INDEX idx_stories_user ON stories(user_id) WHERE deleted = FALSE;
CREATE INDEX idx_stories_config ON stories(configuration_id);
CREATE INDEX idx_stories_status ON stories(status);

-- ============================================================================

CREATE TABLE generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  story_id UUID NOT NULL REFERENCES stories(id),
  configuration_id UUID NOT NULL REFERENCES story_configurations(id),
  priority INTEGER DEFAULT 2,
  status VARCHAR(50) DEFAULT 'queued',
  ai_provider VARCHAR(50),
  ai_model VARCHAR(100),
  queued_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  processing_time_ms INTEGER,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  error_message TEXT,
  estimated_cost DECIMAL(10, 4),
  actual_cost DECIMAL(10, 4),
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (status IN ('queued', 'processing', 'completed', 'failed'))
);

CREATE INDEX idx_jobs_status ON generation_jobs(status, priority, queued_at);

-- ============================================================================
-- IMAGES
-- ============================================================================

CREATE TABLE images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  story_id UUID REFERENCES stories(id),
  character_id UUID REFERENCES characters(id),
  image_type VARCHAR(50) NOT NULL,
  page_number INTEGER,
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  style VARCHAR(50),
  ai_model VARCHAR(100),
  ai_provider VARCHAR(50),
  generation_params JSONB,
  url VARCHAR(500) NOT NULL,
  cdn_url VARCHAR(500),
  thumbnail_url VARCHAR(500),
  width INTEGER,
  height INTEGER,
  file_size_bytes INTEGER,
  format VARCHAR(10),
  is_reference BOOLEAN DEFAULT FALSE,
  version INTEGER DEFAULT 1,
  parent_image_id UUID REFERENCES images(id),
  quality_score DECIMAL(3, 2),
  status VARCHAR(50) DEFAULT 'generating',
  generation_cost_usd DECIMAL(10, 4),
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,

  CONSTRAINT valid_type CHECK (image_type IN ('portrait', 'scene', 'cover', 'reference')),
  CONSTRAINT valid_status CHECK (status IN ('queued', 'generating', 'completed', 'failed', 'approved', 'rejected'))
);

CREATE INDEX idx_images_story ON images(story_id);
CREATE INDEX idx_images_character ON images(character_id);

-- ============================================================================

CREATE TABLE character_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  reference_image_id UUID NOT NULL REFERENCES images(id),
  lora_model_url VARCHAR(500),
  style VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(character_id, style)
);

-- ============================================================================
-- REVIEWS & MODERATION
-- ============================================================================

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id),
  user_id UUID NOT NULL REFERENCES users(id),
  reviewer_id UUID REFERENCES users(id),
  review_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  priority INTEGER DEFAULT 2,
  assigned_at TIMESTAMP,
  completed_at TIMESTAMP,
  due_date TIMESTAMP,
  decision VARCHAR(50),
  decision_reason TEXT,
  ai_safety_score DECIMAL(3, 2),
  ai_quality_score DECIMAL(3, 2),
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_type CHECK (review_type IN ('ai_safety', 'ai_quality', 'human', 'user')),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'in_review', 'approved', 'rejected', 'revision_requested'))
);

CREATE INDEX idx_reviews_story ON reviews(story_id);
CREATE INDEX idx_reviews_status ON reviews(status, priority);

-- ============================================================================

CREATE TABLE review_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id),
  user_id UUID NOT NULL REFERENCES users(id),
  comment_type VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  page_number INTEGER,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- PAYMENTS & SUBSCRIPTIONS
-- ============================================================================

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_customer_id VARCHAR(255) NOT NULL,
  tier VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  current_period_start TIMESTAMP NOT NULL,
  current_period_end TIMESTAMP NOT NULL,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  billing_cycle VARCHAR(20) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_tier CHECK (tier IN ('free', 'basic', 'premium', 'enterprise')),
  CONSTRAINT valid_status CHECK (status IN ('active', 'past_due', 'canceled', 'trialing'))
);

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

-- ============================================================================

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  stripe_payment_intent_id VARCHAR(255) UNIQUE,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(50) NOT NULL,
  payment_method_type VARCHAR(50),
  description TEXT,
  receipt_url VARCHAR(500),
  refunded BOOLEAN DEFAULT FALSE,
  refund_amount DECIMAL(10, 2),
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded'))
);

CREATE INDEX idx_payments_user ON payments(user_id);

-- ============================================================================

CREATE TABLE usage_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  stories_generated INTEGER DEFAULT 0,
  stories_limit INTEGER NOT NULL,
  images_generated INTEGER DEFAULT 0,
  images_limit INTEGER NOT NULL,
  quota_reset_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, period_start)
);

-- ============================================================================
-- PRINT ORDERS
-- ============================================================================

CREATE TABLE print_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  story_id UUID NOT NULL REFERENCES stories(id),
  format VARCHAR(50) NOT NULL,
  size VARCHAR(20) NOT NULL,
  quantity INTEGER DEFAULT 1,
  status VARCHAR(50) DEFAULT 'draft',
  provider VARCHAR(50),
  provider_order_id VARCHAR(255),
  subtotal DECIMAL(10, 2),
  shipping_cost DECIMAL(10, 2),
  tax DECIMAL(10, 2),
  total DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'USD',
  shipping_address JSONB NOT NULL,
  tracking_number VARCHAR(255),
  print_file_url VARCHAR(500),
  estimated_delivery DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  submitted_at TIMESTAMP,

  CONSTRAINT valid_format CHECK (format IN ('hardcover', 'softcover', 'pdf')),
  CONSTRAINT valid_status CHECK (status IN ('draft', 'processing', 'printing', 'shipped', 'delivered', 'cancelled'))
);

CREATE INDEX idx_print_orders_user ON print_orders(user_id);
CREATE INDEX idx_print_orders_story ON print_orders(story_id);

-- ============================================================================
-- LOGGING & ANALYTICS
-- ============================================================================

CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  event_type VARCHAR(100) NOT NULL,
  event_category VARCHAR(50),
  severity VARCHAR(20),
  message TEXT,
  metadata JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activity_logs_user ON activity_logs(user_id);
CREATE INDEX idx_activity_logs_event ON activity_logs(event_type);
CREATE INDEX idx_activity_logs_created ON activity_logs(created_at);

-- ============================================================================

CREATE TABLE audit_trail (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,
  user_id UUID REFERENCES users(id),
  changes JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_trail(entity_type, entity_id);
CREATE INDEX idx_audit_user ON audit_trail(user_id);

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_characters_updated_at BEFORE UPDATE ON characters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_stories_updated_at BEFORE UPDATE ON stories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Active users with subscription info
CREATE VIEW v_active_users AS
SELECT
  u.id,
  u.email,
  u.full_name,
  u.role,
  s.tier,
  s.status AS subscription_status,
  s.current_period_end,
  uq.stories_generated,
  uq.stories_limit
FROM users u
LEFT JOIN subscriptions s ON u.id = s.user_id
LEFT JOIN usage_quotas uq ON u.id = uq.user_id
WHERE u.deletion_scheduled_at IS NULL;

-- ============================================================================
-- INITIAL DATA
-- ============================================================================

-- Insert default admin user (password: Admin@123)
INSERT INTO users (email, email_verified, password_hash, full_name, date_of_birth, role, subscription_tier)
VALUES (
  'admin@magicalstory.com',
  TRUE,
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5p39WVypZfM4q',
  'Admin User',
  '1990-01-01',
  'admin',
  'enterprise'
);

-- ============================================================================
-- DATABASE SETTINGS
-- ============================================================================

-- Optimize for write-heavy workload
ALTER SYSTEM SET shared_buffers = '4GB';
ALTER SYSTEM SET effective_cache_size = '12GB';
ALTER SYSTEM SET maintenance_work_mem = '1GB';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
ALTER SYSTEM SET wal_buffers = '16MB';
ALTER SYSTEM SET default_statistics_target = 100;
ALTER SYSTEM SET random_page_cost = 1.1;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE users IS 'Core user accounts and authentication data';
COMMENT ON TABLE characters IS 'User-created character profiles';
COMMENT ON TABLE stories IS 'Generated stories metadata';
COMMENT ON TABLE subscriptions IS 'User subscription and billing data';
COMMENT ON TABLE print_orders IS 'Physical book print orders';

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
