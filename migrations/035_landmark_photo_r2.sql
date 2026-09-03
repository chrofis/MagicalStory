-- Our own copy of every landmark reference photo, on R2.
--
-- landmark_index.photo_url[_2..6] are Wikimedia Commons URLs — 19,377 of them
-- on prod, nothing stored locally. Every story that draws a landmark fetches
-- the photo from Commons at generation time; Commons throttles sustained
-- pulls and a single 429 leaves the illustrator without its reference plate.
-- photo_r2_url[_2..6] hold the same picture (~1280px wide, JPEG) on our R2
-- bucket. The Commons URL STAYS as provenance (attribution is a licence
-- condition tied to that source); readers prefer the R2 copy when set.
-- Keys are content-stable (landmarks/index/<id>/<sha1(source)[:12]>.jpg), so
-- slot compaction moves the column with its slot and never re-keys an object.
-- Filled by prep-landmark-descriptions.js (as it downloads) and by
-- scripts/admin/backfill-landmark-photos-to-r2.js.
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_r2_url TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_r2_url_2 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_r2_url_3 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_r2_url_4 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_r2_url_5 TEXT;
ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS photo_r2_url_6 TEXT;
