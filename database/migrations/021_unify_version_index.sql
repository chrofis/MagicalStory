-- Migration 021: Unify version_index mapping for scenes
--
-- Before: scenes used imageVersions[i] → DB version_index = i+1
--         (version_index 0 = original image, version_index 1 = gap/unused, 2+ = iterations)
-- After:  scenes use imageVersions[i] → DB version_index = i (same as covers)
--         (version_index 0 = original, 1+ = iterations, no gap)
--
-- Only 47 pages had the gap (v0 then v2+ with no v1).
-- 210 pages already had data at v1 (from admin migration scripts), so they're
-- already contiguous and must NOT be shifted.
--
-- Two-step approach to avoid unique constraint violations on (story_id, image_type, page_number, version_index):

-- Step 1: Shift gap page versions UP by 10000 (temporary offset)
UPDATE story_images si
SET version_index = si.version_index + 10000
WHERE si.image_type = 'scene'
  AND si.version_index >= 2
  AND NOT EXISTS (
    SELECT 1 FROM story_images gap_check
    WHERE gap_check.story_id = si.story_id
      AND gap_check.page_number = si.page_number
      AND gap_check.image_type = 'scene'
      AND gap_check.version_index = 1
  );

-- Step 2: Shift back down by 10001 (net effect: -1)
UPDATE story_images
SET version_index = version_index - 10001
WHERE image_type = 'scene' AND version_index >= 10000;
