-- The municipality a landmark is ACTUALLY in (2026-08-25).
--
-- WHY: `nearest_city` does not mean "is in this town". Discovery searches a
-- 10km radius around a city's geocoded centre and then stamps every hit with
-- the city it was SEARCHING for (server/lib/landmarkPhotos.js — `landmark.
-- nearestCity = city`). So churches in Wallisellen, Dietlikon, Schwerzenbach
-- and Zürich-Schwamendingen are all filed as Dübendorf landmarks.
--
-- The prompt then tells the writer "The story takes place in <city> ... at
-- least one scene MUST take place at one of these real local landmarks", and
-- the writer, reasonably, places the landmark inside that city. Measured on
-- staging job_1787687259758_k7mennm8c: the story ends "am Lindenhofbrunnen in
-- Dübendorf" — the Lindenhofbrunnen is on the Lindenhof in ZÜRICH, ~6km away.
-- A book personalised to a family's home town named a place that does not
-- exist there.
--
-- `municipality` is the truth, backfilled from Wikidata P131 (located in the
-- administrative territorial entity) — 4762 of 4764 rows carry a wikidata_qid,
-- so it is recoverable without guessing. `nearest_city` KEEPS its meaning as
-- the discovery anchor: it is what the city-lookup query matches on, and
-- changing it would silently repoint every existing story's landmark search.
--
-- Nullable and additive: rows not yet backfilled read NULL, and selection must
-- treat NULL as "unknown", never as "not local".

ALTER TABLE landmark_index
  ADD COLUMN IF NOT EXISTS municipality TEXT,
  ADD COLUMN IF NOT EXISTS municipality_updated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_landmark_index_municipality
  ON landmark_index (LOWER(municipality))
  WHERE municipality IS NOT NULL;

COMMENT ON COLUMN landmark_index.municipality IS 'Actual municipality from Wikidata P131. nearest_city is the discovery search anchor, NOT the containing town.';
COMMENT ON COLUMN landmark_index.nearest_city IS 'The city discovery was searching around when this row was found (10km radius). NOT necessarily the municipality — see municipality.';
