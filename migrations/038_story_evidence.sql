-- 038: mark a story as EVIDENCE so automatic cleanup never deletes it.
--
-- WHY. Several staging stories are the measured basis for findings and
-- docs/decisions.md entries. The only age-based deleter in the codebase is the
-- abandoned-anonymous-account sweep (server/routes/trial.js): every 6 hours it
-- deletes anonymous users older than 48 hours together with their story_jobs,
-- characters, files and stories, and then PRUNES THEIR R2 OBJECTS. A trial
-- story that became evidence therefore has a hard 48-hour life, and its images
-- go with it — a surviving row with dead image URLs is not preserved evidence.
--
-- Two columns, not a flag: the owner's rule is delete by OWNER, not by artefact
-- type, so the exemption has to say WHO wants it kept and WHY. A reason string
-- is also the only thing that lets a future session decide whether a mark has
-- gone stale. Chosen over a hardcoded id list in a script because the deleters
-- are SQL and live in three places (trial sweep, orphan cleanup, admin route):
-- a column is enforced at the row, survives every redeploy, and is visible to
-- anyone who runs `SELECT id, evidence_reason FROM stories`.
--
-- Seeded below with the stories cited as evidence in docs/decisions.md and
-- tasks/BACKLOG.md as of 2026-09-14. The seed is idempotent and only touches
-- rows that exist in THIS database, so it is correct on staging and a no-op on
-- production (where none of these ids live).

ALTER TABLE stories ADD COLUMN IF NOT EXISTS evidence_reason TEXT;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS evidence_marked_at TIMESTAMP;

-- Cheap and tiny: the vast majority of rows are NULL here.
CREATE INDEX IF NOT EXISTS idx_stories_evidence
  ON stories (id) WHERE evidence_reason IS NOT NULL;

UPDATE stories SET
  evidence_reason = v.reason,
  evidence_marked_at = COALESCE(evidence_marked_at, NOW())
FROM (VALUES
  ('job_1789348171785_9oxos7dwv',
   'Dragonei run: p7 repair regression (5 -> -72 -> shipped 43), duplicated dragon egg, invented holder declaration, animal-matching contradiction, worn-item off pages p8-p11/p13/p14, Lab experiment #1272 regenerated p14 as v1, text-refine partial join. Validates ~20 fixes.'),
  ('job_1789207854566_l43qgl34w',
   'Fiona: pre-fix baseline, and the one page in 679 with unparseable brief metadata - the proof that the prose-cast fallback is load-bearing.'),
  ('job_1789304198359_y3n0euk3z',
   'Liz/Ayan: pre-fix baseline and the source of the cover dual-holder finding.'),
  ('job_1789301291267_ueh8h145m',
   'Over-cap prompt evidence: 7939/8317 chars against a 7900 cap.'),
  ('job_1789343124794_z2c779f7i',
   'One of only three stories with stored repairRounds - the whole n=3 repair-regression sample.'),
  ('job_1789337998754_apslnsq1z',
   'One of only three stories with stored repairRounds - the whole n=3 repair-regression sample.'),
  ('job_1789163494908_kc2joi4ax',
   '14 animal-named presence findings - the worst instance.'),
  -- The two anonymous-owned ones. These are the only cited stories that the
  -- 48-hour trial sweep can actually reach, which is why this migration exists.
  ('job_1789296188291_thezv15y1',
   'Cited in tasks/ as measured evidence; anonymous-owned, so the 48h trial sweep would delete it and prune its R2 objects.'),
  ('job_1789337873076_qf2at21ui',
   'Cited in tasks/ as measured evidence; anonymous-owned, so the 48h trial sweep would delete it and prune its R2 objects.')
) AS v(id, reason)
WHERE stories.id = v.id
  AND stories.evidence_reason IS NULL;
