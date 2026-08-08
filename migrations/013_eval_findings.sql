-- Eval findings registry — the durable home for everything the evaluator prompts
-- currently encode as inline history.
--
-- WHY THIS EXISTS. prompts/image-evaluation.txt reached 36,321 chars / 406 lines
-- because every false positive anyone ever hit was answered by appending another
-- carve-out paragraph, each carrying its own rationale ("image generators can't
-- render fine expression deltas", "manga is the ONLY style where this applies",
-- "this is how child names leaked onto pages"). Measured consequences: rules
-- inside it stop being applied (§4 caps accessory detail at MODERATE, yet
-- "missing glasses" returned MAJOR five times in one story), two identical runs
-- at temperature 0 produced 0/6 identical issue sets, and the same art-style
-- rule ended up in four places because no single spot in a 406-line file is
-- reliably read.
--
-- The split this table enforces:
--   rule_text  — the ONE terse line the prompt is allowed to carry
--   rationale  — the history, the incident, the measurement. NEVER in the prompt.
--   evidence   — story ids / page numbers / Test Lab experiment ids that prove it
--
-- A prompt line may reference a finding by slug (e.g. "[F-mirror-facing]") so the
-- reasoning is one click away in the Lab instead of inlined for every model call.

CREATE TABLE IF NOT EXISTS eval_findings (
  id SERIAL PRIMARY KEY,
  -- Stable human-readable key used in prompt comments and commit messages.
  slug VARCHAR(80) NOT NULL UNIQUE,
  title TEXT NOT NULL,
  -- non-deduction | severity-policy | detection | determinism | input-plumbing | output-format
  category VARCHAR(40) NOT NULL,
  -- Which prompt(s) this governs, and where. Free text: a finding can span files.
  prompt_file VARCHAR(120),
  prompt_section VARCHAR(120),
  -- The terse rule the prompt should carry. Empty when the finding is about
  -- plumbing or model behaviour rather than a prompt instruction.
  rule_text TEXT,
  -- The part that must NOT live in a prompt.
  rationale TEXT NOT NULL,
  -- {stories:[], pages:[], experiments:[], commits:[], measurements:"..."}
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- active     — currently governs behaviour
  -- superseded — replaced by another finding (see superseded_by)
  -- rejected   — tried and measured NOT to work; keep so it is not retried
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  superseded_by VARCHAR(80),
  created_by VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_findings_category ON eval_findings(category);
CREATE INDEX IF NOT EXISTS idx_eval_findings_status ON eval_findings(status);
CREATE INDEX IF NOT EXISTS idx_eval_findings_file ON eval_findings(prompt_file);
