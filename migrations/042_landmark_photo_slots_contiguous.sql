-- Landmark photo slots are contiguous from slot 1 (decisions.md, 2026-09-24).
--
-- Every serving query filters on slot 1 (`photo_url IS NOT NULL`, HAS_PHOTO_SQL
-- in server/lib/landmarkPhotos.js), so a landmark whose slot 1 is empty is
-- invisible however good its later photos are. On 2026-09-24, 68 prod landmarks
-- had a gap and 17 had slot 1 empty. Two producers: the indexer's
-- exteriors-in-1-3 / interiors-in-4-6 layout, and a one-off cleanup that set a
-- slot's columns to NULL in place. Both are fixed in code, and
-- scripts/admin/compact-landmark-slots.js closed the existing gaps. This
-- constraint stops any writer, including one-off SQL, from leaving a new one.
--
-- "Empty" means photo_url[_N] IS NULL, the column serving and hasSlotGap()
-- (scripts/admin/compact-landmark-slots.js) test. Each rule says: if slot N+1
-- holds a photo, slot N must too. Chained, that makes the filled slots a
-- prefix of 1..6. It is a row-level CHECK, so it looks only at the row being
-- written, at the end of the statement.
--
-- A remove is a compaction (merge-landmark-descriptions.js --apply-discards),
-- never a NULL in place.
ALTER TABLE landmark_index
  ADD CONSTRAINT landmark_photo_slots_contiguous CHECK (
        (photo_url   IS NOT NULL OR photo_url_2 IS NULL)
    AND (photo_url_2 IS NOT NULL OR photo_url_3 IS NULL)
    AND (photo_url_3 IS NOT NULL OR photo_url_4 IS NULL)
    AND (photo_url_4 IS NOT NULL OR photo_url_5 IS NULL)
    AND (photo_url_5 IS NOT NULL OR photo_url_6 IS NULL)
  );
