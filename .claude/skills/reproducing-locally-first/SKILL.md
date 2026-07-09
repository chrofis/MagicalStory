---
name: reproducing-locally-first
description: Use when a deployed fix didn't work, a bug reproduces after a fix, you're about to push a second fix for the same bug, or you're tempted to add diagnostic logging to staging/prod
---

# Reproducing Locally First

## Overview

The worst days in this repo's history (100 commits on 2026-03-08, ~25 stratified fixes on 2026-05-16, 5 reverted diagnostic commits on 2026-01-30) were debugging sessions conducted through the deploy pipeline: hypothesize → push → run a 20-minute real-money story → observe → push again. **Core principle: production is the last verifier, never the debugger.**

## Rule 1 — before judging any fix "failed", prove it ran

When a "fixed" bug reproduces identically, the most likely cause historically was that the fix never executed:

- Poll `/api/health` and compare the commit SHA to the SHA you pushed. Timed waits (`sleep 360`) race Railway cutover and have burned two full days.
- Compare the validation job's `created_at` to the deploy-complete time — a job started before cutover ran old code.
- One "prod bug" was simply master not promoted from staging for 13 days. Check `git log origin/master..origin/staging` before diagnosing code.

## Rule 2 — the two-push rule

Two pushes for the same bug and it's still there → **stop pushing.** The third action is never another push; it is building a repro that doesn't need a deploy:

| What you need | Use |
|---|---|
| Re-run one page's generation with current prompts | `scripts/test-scene.js` |
| Inspect what a page actually stored (prompts, evals, versions) | `scripts/analysis/review-page.js <storyId> <pageNum>` |
| Eval results straight from DB | compare-image-evaluations skill |
| Full run against local backend | `npm run showcase:local` |
| Cover/repair stage in isolation | `scripts/analysis/` dumpers + rerun helpers |
| Raw pipeline evidence | `stories.data`, `story_images`, consolidator audit, Railway logs |

The evidence from the failed run is already stored — pull it instead of generating a new run to look at.

## Rule 3 — no diagnostic commits

If the question is "what value did X have?", the answer is in the DB or Railway logs. Five diagnostic-logging commits were pushed and reverted in one night; the actual root cause (a 35MB response) was found by measurement, not logging.

## Rationalizations

| Excuse | Reality |
|---|---|
| "One more small push will confirm it" | That's what pushes 3–40 said on the 100-commit day. |
| "Can't reproduce locally, it only happens in prod" | The failed run's artifacts ARE the repro. Pull them. |
| "The showcase takes 20 min anyway" | A stage-level rerun takes 2 min and costs cents. |
| "The fix obviously deployed by now" | `sleep 360` lost two days. Poll the SHA. |

## Red flags — STOP

- Writing the third commit subject for the same symptom.
- Adding `console.log` meant to be read in Railway logs.
- Launching a validation story without having compared deploy SHA to pushed SHA.
