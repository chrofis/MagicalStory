-- 041: eval_calls — the prompt and raw reply of every per-image judge call.
--
-- WHY. The quality, semantic and blind-inventory judges, the background-plate
-- QC and the iterate re-brief sent prompts that were never stored anywhere:
-- the 2026-09-23 prompt audit of staging job_1790100385959_1nitlympp had to
-- rebuild them from the builders to see what each judge was actually told
-- (docs/prompt-inventory.md, "Prompts and replies that are NOT stored").
--
-- Its own table, like consolidator_calls: text only (never an image — memory
-- "no images in JSONB"), and kept out of stories.data, which upsertStory
-- rewrites whole at the end of generation and which must not grow by the
-- ~30k characters of judge prompts each rendered version carries.
--
-- No FK on story_id: judges run for trials and before the story row exists.

CREATE TABLE IF NOT EXISTS eval_calls (
  id SERIAL PRIMARY KEY,
  story_id VARCHAR(255) NOT NULL,
  page_number INT,
  kind VARCHAR(40) NOT NULL,
  label VARCHAR(120),
  model VARCHAR(120),
  prompt TEXT NOT NULL,
  raw_response TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_eval_calls_story_page ON eval_calls (story_id, page_number, kind);
