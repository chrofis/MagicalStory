-- Add metadata JSONB column to stories table for fast list queries
-- This stores lightweight metadata separately from the heavy image data
-- Migration: 015_add_story_metadata_column.sql

-- Add metadata column (PostgreSQL JSONB for fast JSON queries)
ALTER TABLE stories ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Create index on metadata for fast queries
CREATE INDEX IF NOT EXISTS idx_stories_metadata ON stories USING GIN (metadata);

-- Backfill metadata for existing stories
-- This extracts key fields from the data column into metadata
UPDATE stories
SET metadata = jsonb_build_object(
    'id', (data::jsonb)->>'id',
    'title', (data::jsonb)->>'title',
    'createdAt', (data::jsonb)->>'createdAt',
    'updatedAt', (data::jsonb)->>'updatedAt',
    'pages', (data::jsonb)->>'pages',
    'language', (data::jsonb)->>'language',
    'languageLevel', (data::jsonb)->>'languageLevel',
    'isPartial', COALESCE(((data::jsonb)->>'isPartial')::boolean, false),
    'generatedPages', (data::jsonb)->>'generatedPages',
    'totalPages', (data::jsonb)->>'totalPages',
    'sceneCount', COALESCE(jsonb_array_length((data::jsonb)->'sceneImages'), 0),
    'hasThumbnail', CASE
        WHEN (data::jsonb)->'coverImages'->'frontCover'->'imageData' IS NOT NULL THEN true
        WHEN (data::jsonb)->'coverImages'->'frontCover' IS NOT NULL THEN true
        WHEN (data::jsonb)->>'thumbnail' IS NOT NULL THEN true
        ELSE false
    END,
    'characters', (
        SELECT jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name'))
        FROM jsonb_array_elements((data::jsonb)->'characters') AS c
    )
)
WHERE metadata IS NULL;
