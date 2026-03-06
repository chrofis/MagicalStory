-- Add image_version_meta column for fast active image switching
-- This stores only which version is active per page, avoiding full data blob updates

-- Add new column (small JSONB, ~100 bytes vs 12MB data blob)
ALTER TABLE stories ADD COLUMN IF NOT EXISTS image_version_meta JSONB DEFAULT '{}';

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_stories_image_version_meta ON stories USING GIN (image_version_meta);

-- Migration: extract activeVersion from existing data.sceneImages[].imageVersions[].isActive
-- This populates the new column for existing stories
UPDATE stories
SET image_version_meta = COALESCE(
  (
    SELECT jsonb_object_agg(
      page_num::text,
      jsonb_build_object('activeVersion', active_idx)
    )
    FROM (
      SELECT
        (scene->>'pageNumber')::int as page_num,
        COALESCE(
          (
            SELECT idx
            FROM jsonb_array_elements(scene->'imageVersions') WITH ORDINALITY AS t(version, idx)
            WHERE (version->>'isActive')::boolean = true
            LIMIT 1
          ) - 1,  -- WITH ORDINALITY is 1-based, we want 0-based
          0
        )::int as active_idx
      FROM jsonb_array_elements(data->'sceneImages') as scene
      WHERE scene->'imageVersions' IS NOT NULL
        AND jsonb_array_length(scene->'imageVersions') > 0
    ) sub
    WHERE page_num IS NOT NULL
  ),
  '{}'::jsonb
)
WHERE data->'sceneImages' IS NOT NULL
  AND image_version_meta IS NULL OR image_version_meta = '{}'::jsonb;
