-- The VILLAGE a landmark stands in, which is not always the municipality.
--
-- Swiss municipalities keep merging: Turgi was absorbed into Baden and Böbikon
-- into Zurzach, both in 2022. Reverse-geocoding returns the surviving political
-- municipality, so every Turgi landmark came back as "Baden" — and a child in
-- Turgi would then be offered the whole of Baden as their home town, with the
-- story asserting those places are local to them.
--
-- A political merger is not a move. The bridge in Turgi is still in Turgi, and
-- that is the name the child knows. locality holds the village/hamlet/suburb
-- level; municipality keeps the administrative one, because both are true and
-- the coarser one is still the right answer for a landmark in the town centre.
--
-- Town matching reads coalesce(locality, municipality, nearest_city): the
-- narrowest name we actually know.
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS locality VARCHAR(160);
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS locality_updated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_landmark_index_locality
  ON landmark_index (LOWER(translate(coalesce(locality, municipality, nearest_city),
    'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns')));
