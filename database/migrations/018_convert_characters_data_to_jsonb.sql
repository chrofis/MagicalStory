-- Migration: Convert characters.data from TEXT to JSONB for faster manipulation
-- This significantly speeds up character delete operations by avoiding TEXT->JSONB parsing

-- Step 1: Add a new JSONB column
ALTER TABLE characters ADD COLUMN IF NOT EXISTS data_jsonb JSONB;

-- Step 2: Copy data from TEXT to JSONB (this may take a moment for large datasets)
UPDATE characters SET data_jsonb = data::jsonb WHERE data_jsonb IS NULL AND data IS NOT NULL;

-- Step 3: Drop the old TEXT column
ALTER TABLE characters DROP COLUMN IF EXISTS data;

-- Step 4: Rename the new column to 'data'
ALTER TABLE characters RENAME COLUMN data_jsonb TO data;

-- Step 5: Add NOT NULL constraint
ALTER TABLE characters ALTER COLUMN data SET NOT NULL;

-- Step 6: Create a GIN index for faster JSONB queries
CREATE INDEX IF NOT EXISTS idx_characters_data_gin ON characters USING GIN (data);
