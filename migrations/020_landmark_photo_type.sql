-- 020: landmark_index.photo_type_1..6 — the per-photo-slot view kind.
-- Production has carried these columns since the index was built (7,100+
-- classified photos); staging never got them, so a prod->staging row copy
-- fails on the column and kind-matching attachment has nothing to match on.
-- Vocabulary in use: exterior | interior | view-from | distant | close
-- ('bad' marks a reject; NULL = unclassified). photo_type describes slot 1.
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_type   TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_type_2 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_type_3 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_type_4 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_type_5 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_type_6 TEXT;
