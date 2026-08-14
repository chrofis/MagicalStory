-- Cost + time per round, generation and judge separately, so the scores page can
-- answer "faster/cheaper/better" (e.g. 3 flash rounds vs 1 expensive round).
-- Additive to 017. Idempotent.
ALTER TABLE story_scores ADD COLUMN IF NOT EXISTS gen_cost_usd   NUMERIC;  -- cost of the model that produced/reviewed the artifact this round
ALTER TABLE story_scores ADD COLUMN IF NOT EXISTS gen_ms         INT;      -- wall-clock of that generation/review
ALTER TABLE story_scores ADD COLUMN IF NOT EXISTS judge_cost_usd NUMERIC;  -- cost of the judge scoring call
ALTER TABLE story_scores ADD COLUMN IF NOT EXISTS judge_ms       INT;      -- wall-clock of the judge call
