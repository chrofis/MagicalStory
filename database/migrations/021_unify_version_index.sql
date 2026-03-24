-- Migration 021: Unify version_index mapping for scenes
--
-- Before: scenes used imageVersions[i] → DB version_index = i+1
--         (version_index 0 = original image, version_index 1 = gap/unused, 2+ = iterations)
-- After:  scenes use imageVersions[i] → DB version_index = i (same as covers)
--         (version_index 0 = original, 1+ = iterations, no gap)
--
-- This shifts all scene version_index values >= 2 down by 1, closing the gap at 1.
-- version_index 0 (the original image) stays unchanged.

-- Pre-check: version_index = 1 should not exist for scenes (it's the gap).
-- Run this before the migration to verify:
-- SELECT COUNT(*) FROM story_images WHERE image_type = 'scene' AND version_index = 1;

-- Shift scene versions down: v2→v1, v3→v2, v4→v3, etc.
-- Process in ascending order to avoid unique constraint violations.
UPDATE story_images
SET version_index = version_index - 1
WHERE image_type = 'scene' AND version_index >= 2;
