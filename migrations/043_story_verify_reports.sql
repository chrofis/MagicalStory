-- 043: story_verify_reports — the verification registry judged against each
-- story the server completes (owner, 2026-09-27).
--
-- WHY. tasks/verify.json lists every change that needs a story run to be
-- proven; scripts/admin/verify-run.js judges a stored run against it. It only
-- ran when someone remembered to run it — z3fw660ie sat unjudged with two
-- FAILED checks. The staging server now runs the same code-checkable checks
-- when a story completes (server/lib/verifyAutoCheck.js, one engine:
-- scripts/admin/verify-core.js) and stores the verdicts here. The server
-- cannot commit to git, so `verify-run.js --pull` reads these rows, re-checks
-- with git whether each entry's commits are in the run's build (the container
-- has no .git), and writes tasks/verify.json.
--
-- Its own table, not stories.data: upsertStory rewrites data whole, and a
-- report written after completion must not race or bloat it. Text only.
-- No FK on story_id, like eval_calls.

CREATE TABLE IF NOT EXISTS story_verify_reports (
  story_id VARCHAR(255) PRIMARY KEY,
  env VARCHAR(40) NOT NULL,
  build VARCHAR(64),
  registry_entries INT NOT NULL,
  counts JSONB NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_story_verify_reports_created ON story_verify_reports (created_at);
