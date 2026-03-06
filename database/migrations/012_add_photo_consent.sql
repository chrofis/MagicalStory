-- Migration: Add photo consent tracking to users table
-- Users only need to consent once before uploading photos
-- All existing users are assumed to have consented

-- Add photo_consent_at column (NULL means not yet consented)
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_consent_at TIMESTAMP;

-- Set all existing users as having consented (retroactive consent)
UPDATE users SET photo_consent_at = CURRENT_TIMESTAMP WHERE photo_consent_at IS NULL;

-- Add index for potential queries
CREATE INDEX IF NOT EXISTS idx_users_photo_consent ON users(photo_consent_at);
