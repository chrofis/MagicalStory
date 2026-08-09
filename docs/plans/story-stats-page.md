# Story Stats — Metrics Framework + AdminDashboard Tab

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.
> Review checkpoints after each task. Staging only — do NOT promote to master as part of this plan.

**Goal (owner intent, 2026-08-09):** see where the pipeline goes wrong, per part, on every story — including (a) independent quality ratings of the cheap-model steps, (b) HOW MUCH redo/repair steps actually changed things (a tiny touch vs a complete redo), and (c) process counters that today only exist in logs (garment correction runs, style-change repairs, DINO/SAM box failures). Framework first; end state is "evaluate everything".

**Architecture — three data sources feeding ONE `story_metrics` row per story, shown as a tab in AdminDashboard:**

1. **Extraction** (free): scores the pipeline already stores (page quality/semantic/consistency, repairs, covers, avatars, outline fixes, cost, timing).
2. **Runtime counters + deltas** (free, new plumbing): a metrics recorder object that pipeline code increments as it runs (`metrics.count('dino_box_fail')`), persisted with the story — plus change-magnitude metrics computed from data already stored (text draft→final diff %, per-repair score delta, pixel-diff between image versions).
3. **Judges** (paid, ~1–2 Rp/story, owner-approved): cheap-model outputs rated independently — title quality, text quality (the Lab's 5 text criteria). The pipeline grading its own homework is not enough; judges are separate calls with their own prompts.

---

## The scorecard (one row per story)

**A. Extracted (exists today)** — mean/min page score, pages<80, findings_by_category (typed), repair rate, versions/page, consistency mean, outline fix count by category, cover scores + title-paint success, avatar fallback count, duration, cost, environment/pipeline_mode/art_style. `is_test` excluded; missing → NULL, never guessed.

**B. Change-magnitude (computed free from stored data)** — the "did the redo change a tiny bit or completely" family:
- `text_churn_pct` — draft→final per-page text diff ratio (reuse `compareStoryDraftVsFinal` in `scripts/analysis/fetch-story-data.js`).
- `scene_churn_pct` — scene-brief fields changed by critique/consistency passes (reuse the analyze-scene-changes logic).
- `beats_churn` — beats-mode outline delta, same approach (beats is the live staging pipeline).
- `repair_delta_mean` — per repair: score(after) − score(before) from version history; also `repair_pixel_change_pct` — normalized pixel diff between consecutive versions (sharp, cheap) so "repair claimed success but barely touched the image" and "repair repainted the whole page" become visible.

**C. Runtime counters (new recorder — Task 2)** — per story: `garment_correction_runs`, `style_repair_runs`, `dino_box_fail`, `sam_mask_fail`/`sam_rejected`, `redo_triggers` by reason, `consistency_regens`, `gemini_fallbacks`/`grok_fallbacks`, `sanitizer_hits`, plus anything a site already logs as a WARN. Counters are additive and cheap; instrument the chokepoints, not every line.

**D. Judged (paid — Task 6, after framework verified)** — `title_score`, `text_score` (5 criteria), each with one-line reasoning stored in `detail`. Judge model + prompt via the Test Lab conventions (temperature 0, category-typed findings); judge prompts live in `prompts/` and are A/B-able in the Lab.

## Tasks

1. **Migration `migrations/014_story_metrics.sql`** — table with scalar columns for the headline metrics of A–D + `detail` JSONB; idempotent; indexes on (created_at), (environment, created_at). Verify: double boot + information_schema on staging.
2. **Runtime recorder `server/lib/runMetrics.js`** — per-job counter object (`get(jobId).count(name)`), attached at job start, flushed into `stories.data.runMetrics` at finalize (survives crashes = flush on checkpoint too). Fire-and-forget: recorder errors never fail a story. Then instrument the C-list chokepoints (locate each via its existing log line; fixing-sibling-paths applies — e.g. garment correction runs in eval AND repair paths). Verify: smoke-test story on staging shows non-zero counters.
3. **Collector `server/lib/storyMetrics.js`** — computes A + B + reads C, one INSERT ON CONFLICT UPDATE at job completion (all completion paths). Verify: run against a stored staging story, SELECT the row, spot-check vs review-page.js.
4. **Backfill `scripts/admin/backfill-story-metrics.js --limit=10`** — fills A + B for the last 10 stories (C/D are NULL pre-deployment — expected).
5. **AdminDashboard tab "Stats"** — inside the existing AdminDashboard (owner choice, no new route): headline trends (score, cost, duration, repair rate), findings-by-category stacked trend, churn panel (B), process-counter panel (C), worst-stories list linking story ids. Filters: env, pipeline_mode, art style, window. Existing admin styling; identical buttons per CLAUDE.md.
6. **Judges (needs explicit cost go-ahead at implementation time)** — `prompts/judge-title.txt`, `prompts/judge-text.txt`; called post-completion from the collector, results into the same row; Test Lab stage mirrors them for A/B.
7. **Docs** — decisions.md entry (telemetry vs Lab separation; recorder contract; judge cost); CLAUDE.md pointer; running-validation-stories note ("check the Stats tab before deciding a validation run is needed").

## Later (out of scope)
- Daily digest cron reading `story_metrics` (trend deltas + worst story each morning) — trivial once the table exists.
- More judges (scene-brief quality, cover text, translation quality) — same slot as Task 6.
- Prod promotion after the owner has used the tab on staging.

## Owner decisions recorded
- Tab in AdminDashboard, not a standalone page. Framework first, judges after; end state = evaluate everything.
- Judges wanted: title, text. Deltas wanted: beats/text/scene churn, repair magnitude. Counters wanted: garment correction, style change, DINO/SAM failures, main-issue categories.
- Backfill: last 10 stories. Staging only until reviewed.
