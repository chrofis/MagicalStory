---
name: running-validation-stories
description: Use when a change needs validating with a story run - picking between stored evidence, a page rerun, a cheap 4-page run on the smoke account, or a full fresh-account showcase
---

# Running Validation Stories

Validation runs cost real money (a full story ~CHF 2) and time (~20 min). **Climb this ladder from the top — stop at the first rung that answers the question.** Paid rungs fall under the CLAUDE.md spend-guard rule: they need an assigned task, and two failed attempts at the same thing means stop and ask.

## The ladder

| Rung | Cost | Use when | How |
|---|---|---|---|
| **1. Stored evidence** | free | The failed run already happened — its artifacts ARE the repro | `scripts/analysis/review-page.js <storyId> <pageNum>`, compare-image-evaluations skill, `stories.data` / `story_images` / Railway logs |
| **2. Single-page rerun** | cents | A prompt/eval/repair change scoped to one page | `scripts/test-scene.js` (current templates, overlays, masks) or a Test Lab stage — prefer the Lab so the run is visible |
| **3. Cheap story run** | fraction of full | The change spans pages (continuity, outline, pipeline order) but not characters | Smoke account, 4 pages, skip covers — see below |
| **4. Full-story rerun** | ~CHF 1-2, no char creation | Full-length output needed for judgment (pacing, cross-page consistency, covers) — or an A/B on ONE knob (art style, location) with everything else identical | Same runner, same account, full pages + covers + eval — see below |
| **5. Full E2E showcase** | ~CHF 2 + 20 min | Long/structural changes; anything touching photo analysis, character creation, avatars, wizard, or account flows | `npm run showcase` (prod) / `npm run showcase:local` — fresh account + photos + characters |

## Rung 3 — the cheap story run (the default validation run)

**Reuse the smoke account; never recreate characters unless the change is about character creation.**

- Auth: `TOKEN=$(node scripts/admin/get-admin-token.js)` is the canonical way to get an admin Bearer token (see CLAUDE.md → "Admin API auth"); the runner below does its own login with the same account. The staging Basic gate covers HTML only — `/api/*` needs just the Bearer.
- Account: `demo-b-hnecf@magicalstory.ch` (admin: unlimited quota, allows 4-page stories + skipCovers, bypassing the wizard's 10-page minimum). It already has characters and styled avatars — pick a story category matching the existing avatars so nothing regenerates.
- Runner: `scripts/test-scene-composite-smoke.js` — historic name, but it IS the generic cheap-run harness: logs in, POSTs `/api/jobs/create-story` with `pages: 4`, `skipCovers: true`, optional `--skipEval=false` for the full eval/repair pipeline, then polls to completion.

```bash
STAGING_AUTH_USER=... STAGING_AUTH_PASSWORD=... TEST_BASE_URL=https://staging.magicalstory.ch \
  node scripts/test-scene-composite-smoke.js --pages=4 --skipEval=true
```

(Leave the composite/phantom flags alone — the composite pipeline is dead by kill-switch; the flags are inert history.)

## Rung 4 — full-story rerun (identical start point, no character creation)

The same runner scales to a full comparable story: the wizard inputs are pinned by the flags, the characters/avatars come from the account, so two runs differ ONLY in the knob you change. Use `--dryRun` first to preview the exact payload without spending anything.

```bash
node scripts/test-scene-composite-smoke.js \
  --pages=14 --skipCovers=false --skipEval=false --repair=true \
  --artStyle=comic                                  # the ONE knob you vary
# location lives in the details prose:
#   --details="Die Geschichte spielt in Paris."
# other knobs: --category=, --topic=
```

Defaults reproduce the standard story (adventure/pirate, watercolor, de), so an unflagged rerun is a before/after baseline for pipeline changes. Change one knob per run — two changed knobs make the comparison unreadable.

## Rung 5 — full showcase, only when it's actually needed

Fresh timestamped account, generated family photos, full character creation, all pages + covers. Justified by: multi-day change batches, anything in the trial/wizard/account flows, photo-analyzer or avatar-pipeline changes, or a pre-release confidence pass. Otherwise it wastes CHF 2 re-testing character creation that didn't change.

## Rules that apply to every rung with a run

- **Verify the deploy first**: poll `/api/health` and match the commit SHA to what you pushed — timed waits race Railway cutover (reproducing-locally-first skill).
- **Never launch unprompted** — showcases and story runs only when the user asked for validation.
- **Don't push while a run is in flight** — a deploy kills it (the pre-push hook checks, but don't lean on it).
- **"Orchestrator exited 0" ≠ story done** — check `story_jobs.status='completed'`, then look at EVERY page image and report per-page issues.
