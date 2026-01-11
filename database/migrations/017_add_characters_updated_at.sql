-- Migration 017: Add updated_at column to characters table
-- This column tracks when character data was last modified

-- Add the updated_at column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'characters' AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE characters ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();

        -- Set initial value for existing rows
        UPDATE characters SET updated_at = created_at WHERE updated_at IS NULL;
    END IF;
END $$;
