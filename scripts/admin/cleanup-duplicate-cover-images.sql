-- Cleanup: Delete duplicate cover image rows caused by NULL page_number UNIQUE constraint bug.
-- Covers (page_number IS NULL) were never deduplicated by ON CONFLICT, creating 7+ identical rows.
-- This keeps the row with the lowest id and deletes all duplicates.

-- Preview: see how many duplicates exist
SELECT story_id, image_type, version_index, COUNT(*) as row_count
FROM story_images
WHERE page_number IS NULL
GROUP BY story_id, image_type, version_index
HAVING COUNT(*) > 1
ORDER BY story_id, image_type, version_index;

-- Delete duplicates (keep lowest id)
DELETE FROM story_images a USING story_images b
WHERE a.id > b.id
  AND a.story_id = b.story_id
  AND a.image_type = b.image_type
  AND a.page_number IS NULL AND b.page_number IS NULL
  AND a.version_index = b.version_index;
