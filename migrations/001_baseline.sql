-- Baseline schema.
--
-- Every DDL statement that used to live in server.js's initializeDatabase()
-- function, captured as one idempotent migration. All CREATE / ALTER are
-- IF NOT EXISTS-guarded so this is a no-op on prod (where the schema
-- already exists from a long lineage of manual migrations) and builds the
-- full schema on a fresh DB (staging, local).
--
-- Going forward: every schema change is a new migrations/00N_*.sql file.
-- Never edit this file.

-- ─── users ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(255) PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  story_quota INT DEFAULT 2,
  stories_generated INT DEFAULT 0,
  credits INT DEFAULT 500,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP,
  preferred_language VARCHAR(20) DEFAULT 'English',
  email_verified BOOLEAN DEFAULT FALSE,
  email_verification_token VARCHAR(255),
  email_verification_expires TIMESTAMP,
  password_reset_token VARCHAR(255),
  password_reset_expires TIMESTAMP,
  photo_consent_at TIMESTAMP,
  last_verification_email_sent TIMESTAMP
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_verification_email_sent TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymous BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (referral_balance_cents >= 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_pending_cents INTEGER NOT NULL DEFAULT 0 CHECK (referral_pending_cents >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_lower ON users(LOWER(referral_code)) WHERE referral_code IS NOT NULL;

-- ─── config ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config (
  id SERIAL PRIMARY KEY,
  config_key VARCHAR(255) UNIQUE NOT NULL,
  config_value TEXT
);

-- ─── trial_daily_stats ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trial_daily_stats (
  date DATE PRIMARY KEY,
  stories_generated INT DEFAULT 0,
  avatars_generated INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── logs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255),
  username VARCHAR(255),
  action VARCHAR(255),
  details TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── characters ────────────────────────────────────────────────────────
-- data is queried with JSONB operators (data->'characters' etc.).
-- Old prod tables had data TEXT; converted to JSONB on the fly.
CREATE TABLE IF NOT EXISTS characters (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  data JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_characters_user_id ON characters(user_id);
ALTER TABLE characters ADD COLUMN IF NOT EXISTS metadata JSONB;
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='characters' AND column_name='data') = 'text' THEN
    ALTER TABLE characters ALTER COLUMN data TYPE JSONB USING data::jsonb;
  END IF;
END $$;

-- ─── stories ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stories (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  data JSONB NOT NULL,
  metadata JSONB,
  is_shared BOOLEAN DEFAULT FALSE,
  share_token VARCHAR(255),
  image_version_meta JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS is_shared BOOLEAN DEFAULT FALSE;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS share_token VARCHAR(255);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS image_version_meta JSONB DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_stories_share_token ON stories(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stories_image_version_meta ON stories USING GIN (image_version_meta);
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='stories' AND column_name='data') = 'text' THEN
    ALTER TABLE stories ALTER COLUMN data TYPE JSONB USING data::jsonb;
  END IF;
END $$;

-- ─── story_drafts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS story_drafts (
  user_id VARCHAR(255) PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── files ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  file_type VARCHAR(50) NOT NULL,
  story_id VARCHAR(255),
  mime_type VARCHAR(100) NOT NULL,
  file_data BYTEA NOT NULL,
  file_size INT,
  filename VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_story_id ON files(story_id);

-- ─── gelato_products ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gelato_products (
  id SERIAL PRIMARY KEY,
  product_uid VARCHAR(500) UNIQUE NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  description TEXT,
  size VARCHAR(100),
  cover_type VARCHAR(100),
  min_pages INT,
  max_pages INT,
  available_page_counts TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gelato_products_active ON gelato_products(is_active);

-- ─── orders ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
  story_id VARCHAR(255),
  stripe_session_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_payment_intent_id VARCHAR(255),
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  shipping_name VARCHAR(255),
  shipping_address_line1 VARCHAR(255),
  shipping_address_line2 VARCHAR(255),
  shipping_city VARCHAR(100),
  shipping_state VARCHAR(100),
  shipping_postal_code VARCHAR(20),
  shipping_country VARCHAR(2),
  amount_total INTEGER,
  currency VARCHAR(3),
  payment_status VARCHAR(50),
  gelato_order_id VARCHAR(255),
  gelato_status VARCHAR(50),
  tracking_number VARCHAR(255),
  tracking_url VARCHAR(500),
  shipped_at TIMESTAMP,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session_id ON orders(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_gelato_order_id ON orders(gelato_order_id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url VARCHAR(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_code_used VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents INT DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_mode VARCHAR(8);

-- ─── credit_transactions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INT NOT NULL,
  balance_after INT NOT NULL,
  transaction_type VARCHAR(50) NOT NULL,
  reference_id VARCHAR(255),
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_type ON credit_transactions(transaction_type);

-- ─── story_jobs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS story_jobs (
  id VARCHAR(100) PRIMARY KEY,
  user_id VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  input_data JSONB NOT NULL,
  result_data JSONB,
  error_message TEXT,
  progress INT DEFAULT 0,
  progress_message TEXT,
  credits_reserved INT DEFAULT 0,
  idempotency_key VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_story_jobs_user ON story_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_story_jobs_status ON story_jobs(status);
ALTER TABLE story_jobs ADD COLUMN IF NOT EXISTS credits_reserved INT DEFAULT 0;
ALTER TABLE story_jobs ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_jobs_idempotency
  ON story_jobs(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ─── story_job_checkpoints ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS story_job_checkpoints (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL REFERENCES story_jobs(id) ON DELETE CASCADE,
  step_name VARCHAR(50) NOT NULL,
  step_index INT DEFAULT 0,
  step_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, step_name, step_index)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_job ON story_job_checkpoints(job_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_step ON story_job_checkpoints(step_name);
ALTER TABLE story_job_checkpoints ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- ─── pricing_tiers ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pricing_tiers (
  id SERIAL PRIMARY KEY,
  max_pages INT NOT NULL UNIQUE,
  label VARCHAR(20) NOT NULL,
  softcover_price INT NOT NULL,
  hardcover_price INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default pricing tiers only on fresh DBs (no rows yet).
INSERT INTO pricing_tiers (max_pages, label, softcover_price, hardcover_price)
SELECT * FROM (VALUES
  (30,  '1-30',   38, 53),
  (40,  '31-40',  45, 60),
  (50,  '41-50',  51, 66),
  (60,  '51-60',  57, 72),
  (70,  '61-70',  63, 78),
  (80,  '71-80',  69, 84),
  (90,  '81-90',  75, 90),
  (100, '91-100', 81, 96)
) AS v(max_pages, label, softcover_price, hardcover_price)
WHERE NOT EXISTS (SELECT 1 FROM pricing_tiers);

-- ─── landmark_index ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS landmark_index (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  wikipedia_page_id INT,
  wikidata_qid VARCHAR(20),
  lang VARCHAR(10),
  latitude DECIMAL(10, 7),
  longitude DECIMAL(10, 7),
  nearest_city VARCHAR(100),
  country VARCHAR(100),
  region VARCHAR(50),
  type VARCHAR(50),
  boost_amount INT DEFAULT 0,
  categories TEXT[],
  photo_url TEXT,
  photo_attribution TEXT,
  photo_source VARCHAR(50),
  photo_description TEXT,
  commons_photo_count INT DEFAULT 0,
  score INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(wikidata_qid)
);
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_url_2 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_attribution_2 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_description_2 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_url_3 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_attribution_3 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_description_3 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_url_4 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_attribution_4 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_description_4 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_url_5 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_attribution_5 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_description_5 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_url_6 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_attribution_6 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_description_6 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS wikipedia_extract TEXT;
CREATE INDEX IF NOT EXISTS idx_landmark_index_location ON landmark_index(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_landmark_index_city ON landmark_index(LOWER(nearest_city));
CREATE INDEX IF NOT EXISTS idx_landmark_index_type ON landmark_index(type);
CREATE INDEX IF NOT EXISTS idx_landmark_index_country ON landmark_index(LOWER(country));

-- Drop obsolete discovered_landmarks table (unified into landmark_index).
DROP TABLE IF EXISTS discovered_landmarks;

-- ─── historical_locations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historical_locations (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(100) NOT NULL,
  location_name VARCHAR(255) NOT NULL,
  location_query VARCHAR(255),
  location_type VARCHAR(100),
  aliases JSONB DEFAULT '[]',
  photo_url TEXT NOT NULL DEFAULT '',
  photo_data TEXT,
  photo_attribution TEXT,
  photo_description TEXT,
  photo_score INT,
  photo_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, location_name, photo_url)
);
CREATE INDEX IF NOT EXISTS idx_historical_locations_event ON historical_locations(event_id);

-- ─── style_lab_images ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS style_lab_images (
  id SERIAL PRIMARY KEY,
  story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  page_number INT NOT NULL,
  run_id VARCHAR(100) NOT NULL,
  model_id VARCHAR(100) NOT NULL,
  image_data TEXT,
  image_url TEXT,
  thumbnail TEXT,
  style_prompt TEXT NOT NULL,
  elapsed_ms INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_style_lab_story ON style_lab_images(story_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_style_lab_unique ON style_lab_images(story_id, page_number, run_id, model_id);
ALTER TABLE style_lab_images ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE style_lab_images ALTER COLUMN image_data DROP NOT NULL;

-- ─── consolidator_calls ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consolidator_calls (
  id SERIAL PRIMARY KEY,
  story_id VARCHAR(255) NOT NULL,
  page_number INT,
  round INT,
  full_prompt TEXT,
  raw_response TEXT,
  plan JSONB,
  usage JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consolidator_calls_story ON consolidator_calls(story_id);
CREATE INDEX IF NOT EXISTS idx_consolidator_calls_story_page ON consolidator_calls(story_id, page_number, round);

-- ─── story_images ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS story_images (
  id SERIAL PRIMARY KEY,
  story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  image_type VARCHAR(50) NOT NULL,
  page_number INT,
  version_index INT NOT NULL DEFAULT 0,
  image_data TEXT,
  image_url TEXT,
  quality_score INT,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_images_unique_with_page
  ON story_images(story_id, image_type, page_number, version_index) WHERE page_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_images_unique_without_page
  ON story_images(story_id, image_type, version_index) WHERE page_number IS NULL;
CREATE INDEX IF NOT EXISTS idx_story_images_story_id ON story_images(story_id);
CREATE INDEX IF NOT EXISTS idx_story_images_story_version ON story_images(story_id, version_index);
ALTER TABLE story_images ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE story_images ALTER COLUMN image_data DROP NOT NULL;

-- ─── story_retry_images ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS story_retry_images (
  id SERIAL PRIMARY KEY,
  story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  page_number INT NOT NULL,
  retry_index INT NOT NULL,
  image_type VARCHAR(50) NOT NULL,
  grid_index INT,
  image_data TEXT,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_retry_images_story ON story_retry_images(story_id);
CREATE INDEX IF NOT EXISTS idx_retry_images_page ON story_retry_images(story_id, page_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_retry_images_unique
  ON story_retry_images(story_id, page_number, retry_index, image_type, COALESCE(grid_index, -1));
ALTER TABLE story_retry_images ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE story_retry_images ALTER COLUMN image_data DROP NOT NULL;

-- ─── referral_events ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_events (
  id SERIAL PRIMARY KEY,
  referrer_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_user_id VARCHAR(255) NOT NULL,
  order_stripe_session_id VARCHAR(255) NOT NULL UNIQUE,
  discount_cents INT NOT NULL,
  credits_granted INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_referral_events_referrer ON referral_events(referrer_user_id);

-- ─── referral_payouts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_payouts (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  type VARCHAR(20) NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  pending_after_cents INTEGER NOT NULL,
  order_stripe_session_id VARCHAR(255),
  stripe_refund_id VARCHAR(255),
  source_user_id VARCHAR(255),
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referral_payouts_user_id ON referral_payouts(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_payouts_earned_session ON referral_payouts(order_stripe_session_id) WHERE type = 'earned';
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_payouts_pending_session ON referral_payouts(order_stripe_session_id) WHERE type = 'pending_checkout';
