-- Migration: Add story sharing columns
-- Allows users to share stories via unique tokens

-- Add sharing columns to stories table
ALTER TABLE stories
ADD COLUMN IF NOT EXISTS share_token VARCHAR(64) UNIQUE,
ADD COLUMN IF NOT EXISTS is_shared BOOLEAN DEFAULT FALSE;

-- Create index for fast lookups by share token (only on non-null values)
CREATE INDEX IF NOT EXISTS idx_stories_share_token ON stories(share_token) WHERE share_token IS NOT NULL;

-- Comment for documentation
COMMENT ON COLUMN stories.share_token IS 'Unique token for sharing story publicly (64 hex chars)';
COMMENT ON COLUMN stories.is_shared IS 'Whether the story is currently shared publicly';
