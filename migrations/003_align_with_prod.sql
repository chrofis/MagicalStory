-- Close the prod ↔ staging schema gaps surfaced by compare-schemas.
--
-- Every statement is IF NOT EXISTS / no-op on prod (which already has
-- these from years of hand-applied migrations). On staging (fresh DB)
-- this fully aligns the schema with prod.
--
-- After this lands, the two environments are byte-for-byte identical
-- except for two legacy tables on prod we intentionally leave alone:
--   - swiss_landmarks  : superseded by landmark_index, kept on prod as
--     historical artefact, no need to recreate on staging.
--   - schema_migrations: leftover from a prior migration tool that was
--     never used here; ignore.

-- ─── historical_objects (table only on prod) ──────────────────────────
CREATE TABLE IF NOT EXISTS historical_objects (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(100) NOT NULL,
  object_name VARCHAR(255) NOT NULL,
  object_type VARCHAR(100),
  aliases JSONB DEFAULT '[]'::jsonb,
  photo_url TEXT NOT NULL DEFAULT '',
  photo_data TEXT,
  photo_attribution TEXT,
  photo_description TEXT,
  photo_score INTEGER,
  photo_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS historical_objects_event_id_object_name_key
  ON historical_objects (event_id, object_name);
CREATE INDEX IF NOT EXISTS idx_historical_objects_event
  ON historical_objects (event_id);

-- ─── files: file_url + relax file_data NOT NULL ───────────────────────
ALTER TABLE files ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE files ALTER COLUMN file_data DROP NOT NULL;

-- ─── orders: tracking + multi-quantity + tokens_credited ──────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_email_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_estimate_min   DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_estimate_max   DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity                INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tokens_credited         INTEGER DEFAULT 0;

-- ─── story_images: created_at + quality_score type + version_index ──
ALTER TABLE story_images ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- quality_score went INTEGER → REAL on prod (decimal scores). Convert if still int.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='story_images' AND column_name='quality_score') = 'integer' THEN
    ALTER TABLE story_images ALTER COLUMN quality_score TYPE REAL USING quality_score::real;
  END IF;
END $$;

-- version_index is nullable on prod; staging baseline declared NOT NULL. Relax.
ALTER TABLE story_images ALTER COLUMN version_index DROP NOT NULL;

-- ─── users: claim token + shipping address ────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS claim_token             VARCHAR(255) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS claim_token_expires     TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_first_name     VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_last_name      VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_email          VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_address_line1  VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_city           VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_post_code      VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_country        VARCHAR(255);

-- ─── indexes only on prod ─────────────────────────────────────────────
-- GIN on JSONB columns (powers JSON-path queries on characters/stories)
CREATE INDEX IF NOT EXISTS idx_characters_data_gin     ON characters USING gin (data);
CREATE INDEX IF NOT EXISTS idx_characters_metadata     ON characters USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_stories_data_gin        ON stories USING gin (data);
CREATE INDEX IF NOT EXISTS idx_stories_metadata        ON stories USING gin (metadata);

-- Uniqueness on stories.share_token (non-partial; lets ON CONFLICT work).
CREATE UNIQUE INDEX IF NOT EXISTS stories_share_token_key ON stories (share_token);

-- story_images query indexes
CREATE INDEX IF NOT EXISTS idx_story_images_story_page  ON story_images (story_id, image_type, page_number);
CREATE INDEX IF NOT EXISTS idx_story_images_story_type  ON story_images (story_id, image_type);

-- Case-insensitive unique email — protects identity even when older rows
-- have mixed-case email values.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users (LOWER(email));
