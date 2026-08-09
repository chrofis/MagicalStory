# Story Stats Page — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.
> Review checkpoints after each task. Staging only — do NOT promote to master as part of this plan.

**Goal:** Every production story leaves a per-part quality scorecard in a `story_metrics` table, and `/admin/stats` charts the trends — so "where is the pipeline going wrong" is answered by a page, not by logs or one-off test runs.

**Architecture:** Pure extraction (Phase 1, this plan): a fire-and-forget collector runs when a story job completes, reads the eval data the pipeline already stored in `stories.data` / `story_jobs`, and writes one row. A backfill script seeds the last 10 stories. An admin page renders trends. **No new AI calls anywhere in this plan.** Phases 2 (cheap title/text judges) and 3 (daily digest cron) are sketched at the bottom but explicitly out of scope.

**Tech stack:** existing Postgres (via `server/services/migrate.js` migrations), plain Node collector in `server/lib/`, React admin page alongside the existing Test Lab / AdminDashboard patterns. No new dependencies; charts as simple inline SVG/absolutely-positioned bars unless a chart helper already exists in the admin code — check before adding anything.

---

## Scorecard specification (the extraction contract)

One row per story. Headline scalars as columns (indexed, chartable cheaply); full detail in a `detail` JSONB. All sources exist today:

| Column | Type | Source |
|---|---|---|
| `story_id`, `created_at`, `environment` | ids | job record; env from `RAILWAY_ENVIRONMENT`/config |
| `pipeline_mode` | text | beats / unified (env + job data) |
| `art_style`, `language`, `pages` | text/int | story data |
| `duration_s`, `cost_usd_total` | numeric | job timings; token-accounting totals |
| `mean_page_score`, `min_page_score` | numeric | `sceneImages[].qualityReasoning` finalScore per picked version |
| `pages_below_80` | int | same |
| `findings_by_category` | jsonb | typed eval categories, summed across pages (the drill-down key) |
| `repair_rate` | numeric | pages with ≥1 repair attempt / pages |
| `repair_success_rate` | numeric | repairs whose picked version improved score / repair attempts (`retryHistory`) |
| `versions_per_page_mean` | numeric | version arrays |
| `consistency_mean` | numeric | `retryHistory` consistency entries |
| `outline_fix_count`, `outline_fixes_by_category` | int/jsonb | review output stored in `stories.data.outline` |
| `cover_scores` | jsonb | front/initial/back cover evals + title-paint success flag |
| `avatar_fallback_count` | int | pass-2 fallback / backstop trips where recorded |
| `errors_fallbacks` | jsonb | provider errors, fallback counts from job data |
| `detail` | jsonb | per-page score array + anything above at page granularity |

Rules: **`is_test` stories are never collected** (Test Lab pollution — settled). Missing data ⇒ NULL, never a guessed value; the collector logs which fields were absent (old-format stories) but never throws. Read-compat aliasing per sweeping-shape-changes when field names vary across story generations.

---

## Tasks

### Task 1 — Migration `migrations/014_story_metrics.sql`
- New table per the spec above; indexes on `(created_at)`, `(environment, created_at)`; idempotent (`IF NOT EXISTS`).
- Follows the settled rule: DDL ONLY here — nothing in any init path.
- **Verify:** boot server twice locally (idempotency), then `information_schema` check on staging after deploy.

### Task 2 — Collector `server/lib/storyMetrics.js`
- `collectStoryMetrics(storyId)` — reads the stored story + job row, computes the scorecard, INSERTs (ON CONFLICT story_id DO UPDATE, so re-runs are safe).
- Hook: the site in `server.js` where `story_jobs.status` is set to `'completed'` (locate by grep; there may be sibling completion paths — trial vs main pipeline — check both per fixing-sibling-paths). Wrap in try/catch + log: **metrics failure must never fail or delay a story.**
- **Verify (smoke-testing-before-push):** `node --check`, module load, then execute against a real stored staging story id (`node -e "require(...).collectStoryMetrics('job_...')"`) and SELECT the row.

### Task 3 — Backfill `scripts/admin/backfill-story-metrics.js`
- `--limit=10` default (owner choice), `--env=staging` default; iterates most-recent completed non-test stories, calls the same collector.
- **Verify:** run against staging DB, confirm 10 rows, spot-check 2 against `review-page.js` output for the same story.

### Task 4 — API `GET /api/admin/stats`
- Admin-gated (reuse existing admin middleware). Returns the rows (window param, default 90 days) — computation happens client-side at this scale (a few rows/day).
- **Verify:** curl as admin on staging; non-admin gets 403.

### Task 5 — Page `client/src/pages/AdminStats.tsx` (`/admin/stats`)
- Sections: (1) headline trend lines — mean page score, repair rate, cost, duration; (2) findings-by-category stacked trend (the "which layer regressed" view); (3) per-part panels — outline, covers, avatars, consistency; (4) story list with worst-first sort, each row linking the story id for `review-page.js` drill-down.
- Filters: environment, pipeline_mode, art_style, date window. Follow existing admin styling; identical button styling per the CLAUDE.md rule.
- **Verify:** `npx tsc --noEmit`; load the page on staging against the 10 backfilled rows; every number on the page spot-checked once against the DB.

### Task 6 — Docs
- `docs/decisions.md` entry (production telemetry vs Test Lab separation; is_test exclusion; fire-and-forget contract).
- Pointer in CLAUDE.md's subsystem list; note in running-validation-stories: "check /admin/stats before deciding a validation run is needed".

## Out of scope (future phases, do not build now)
- **Phase 2:** cheap per-story judges for title + text quality (Haiku/flash, ~1–2 Rp/story) writing into the same table — needs explicit owner cost approval.
- **Phase 3:** daily digest cron reading `story_metrics` (trend deltas, worst story, cost) — poor-man's alerting until the Sentry backlog item lands.
- Prod promotion: after the owner has used the page on staging.

## Open questions for review
1. Scorecard columns: anything missing you already know you'll want to trend (e.g. text-zone calmness — currently computed but storage location needs checking during Task 2)?
2. `/admin/stats` vs a tab inside the existing AdminDashboard?
3. Backfill 10 is for validation — worth re-running with a higher limit once the page proves itself?
