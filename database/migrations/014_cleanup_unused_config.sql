-- Migration: Clean up unused config table entries
-- API keys are stored in environment variables, not in the config table
-- These empty entries cause confusion and are never used

-- Remove unused API key config entries (they use env vars instead)
DELETE FROM config WHERE config_key IN ('anthropic_api_key', 'gemini_api_key') AND (config_value IS NULL OR config_value = '');

-- Add a comment/note entry to explain where config actually comes from
INSERT INTO config (config_key, config_value)
VALUES ('_note', 'API keys are stored in environment variables, not in this table')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
