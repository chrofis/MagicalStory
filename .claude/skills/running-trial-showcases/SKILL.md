---
name: running-trial-showcases
description: Use when the owner asks to run a trial showcase, test the /try funnel end-to-end, or check trial story quality and speed - the trial equivalent of the full-story showcase
---

# Running Trial Showcases

A **trial showcase** runs one real trial story end-to-end through the public `/try` API and reports it. It is the trial counterpart of `npm run showcase` (which runs full stories on fresh demo-family accounts).

**One trial = 5 pages + title page + one preview avatar ≈ CHF 0.20–0.35.** This is a paid run under the CLAUDE.md spend-guard rule: launch only when the owner asked for it in this conversation. Preparing the command is never permission to fire it.

## Run it

```bash
node scripts/admin/trial-showcase.js                 # next rotation entry, STAGING (default)
node scripts/admin/trial-showcase.js --entry=2       # a specific rotation entry
node scripts/admin/trial-showcase.js --dry-run       # print the plan, make no paid call
node scripts/admin/trial-showcase.js --base=https://magicalstory.ch   # production
node scripts/admin/trial-showcase.js --no-wait       # fire and exit, print the job id
```

Default is **staging** deliberately: trial had never run there before 2026-08-15, and staging is where the `trialMode → never beats` gate needs exercising.

## What it does

Drives the same endpoints the wizard calls — no browser, so no Turnstile flakiness:

1. `GET /api/trial/admin-bypass-token` (admin JWT via `scripts/admin/get-admin-token.js`) → 5-minute HMAC that skips Turnstile + the fingerprint check.
2. `POST /api/trial/analyze-photo` → physical traits + face box.
3. `POST /api/trial/generate-preview-avatar` → the avatar the pipeline seeds `avatars.standard` from.
4. `POST /api/trial/create-anonymous-account` → fresh trial user (so the one-trial-per-user cap never blocks a rerun).
5. `POST /api/trial/create-story` → job id.
6. Polls `GET /api/trial/job-status/:jobId` to completion and prints the story URL.

## Rotation

`tests/helpers/trial-rotation.json`, state in `tests/trial-showcase-state.json` (auto-advances). A trial has **exactly one character**, so each entry names a single curated demo face from `tests/fixtures/demo-photos/{family}/` — Emma/Noah (Berger, DE), Léa/Jules (Dubois, FR), Lily/Ethan (Miller, EN) across adventure and life-skill categories.

To add an entry: append to the JSON with the next `index`, keep the face file present on disk.

## Judging the result

- **Speed is the trial's product requirement.** Baseline: **123 s end-to-end** (last real production trial, 5 pages). Anything multiples of that means something switched the trial onto a heavy path — check `pipelineMode` first (`resolvePipelineMode` must return `unified` for `trialMode`; see the 2026-08-15 decisions.md entry).
- **Quality has no safety net in trial**: `skipQualityEval: true` and `enableFullRepair: false`, so no eval, no repair, no redo. Whatever the first render produces is what the user sees — look at every page image yourself.
- **Cast size**: a trial has one real character with one avatar. Any invented secondary figure renders with no reference photo and no repair pass behind it. Count the cast per page when reviewing.

## Related

- Full-story runs: the `running-validation-stories` skill (ladder from stored evidence → page rerun → 4-page smoke → showcase).
- Trial → claim → account E2E assertion test: `npm run test:trial` (`tests/trial-to-full.spec.ts`) — that one is pass/fail, not a showcase.
- Trial pipeline gates: `server/routes/trial.js` (`buildTrialInputData`), `prompts/story-trial.txt`, decisions.md 2026-08-15.
