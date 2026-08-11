> **EXECUTED 2026-08-11** — all waves complete on `staging` (commits: wave 0a
> `56e8d71f4`, wave 0b `dae342caa`, wave 1 `2fd56c5c8`, wave 2 `7ac04a42b`,
> wave 3 = this docs commit). server.js 8,671 → 2,657 lines;
> storyJobPipeline.js 6,141 lines. Moved region verified byte-identical against
> the pre-move committed blob; ESLint `no-undef` zero errors over both files.
>
> **Deviations from plan (all minor):**
> 1. V5 jobs-route smoke returned **401** (route is auth-gated), not 404 — a
>    clean handled response proving the injected route works; accepted.
> 2. ESLint flagged a PRE-EXISTING free reference in
>    `savePartialStoryFromCheckpoints`: `typeof clothingRequirements !==
>    'undefined' && clothingRequirements` — always undefined at module scope
>    (typeof short-circuits; the costume projection always resolves to null,
>    same as before the move). Suppressed via a documented `/* global */`
>    directive in the module's (new) header; moved code untouched. Flagged as a
>    latent quirk, NOT fixed (scope fence: no behavior change).
> 3. Working-copy line endings are CRLF-translated on this Windows checkout and
>    `sed` normalizes them, so byte-identity was verified against the committed
>    HEAD blob (LF — the source of truth), not the working copy.
> 4. The bare-require stub (V2) additionally needs `.env` loaded: the module's
>    require chain reaches `server/middleware/auth.js` (via
>    `server/routes/avatars`), which process-exits without JWT_SECRET.
>    Pre-existing guard, not a cycle.
>
> **Final gate still owed (owner-controlled):** one staging validation story on
> the smoke account + story_metrics comparison vs baseline; plus one early
> cancel and one text-only run to exercise the refund and early-completion
> paths. NOT run — deploys are owner-only.

# server.js Story-Pipeline Extraction — Plan

## Context

`server.js` is 8,671 lines: an Express bootstrap AND the entire story-generation pipeline in one file. This is phase 2 of the god-file program (phase 1, the storyHelpers split, shipped and was validated end-to-end by a real staging story). Goal: move the pipeline (`processUnifiedStoryJob` + `processStoryJob` + `_processStoryJobImpl`, lines 2553–8349) and the checkpoint block (2255–2476) into a new module — **zero behavior change, zero route-file churn** — leaving server.js at ~2,550 lines of pure server wiring.

Exploration verified: the block is contiguous; **no file requires server.js** (routes already receive `processStoryJob` via the DI seam at lines 1436–1456); no `app`/`req`/`res` references inside the block; no module-level job maps or limiters; zero boot-time entry points into the pipeline (boot recovery only fails/refunds zombie jobs).

## Load-bearing decisions

1. **D1 — new module at repo ROOT: `storyJobPipeline.js`.** The block contains ~60 inline `require('./server/lib/...')` call sites (27 distinct paths), many in rarely-executed branches (failure/refund, trial, Swiss stories). Root placement (same dir as server.js) makes required path rewrites **zero** — verbatim stays verbatim, and a missed-rewrite class of production-only bugs can't exist. Precedent: `server.js`, `email.js` live at root; CLAUDE.md's root-files list gets updated in Wave 3. **Rule: NO require-path edits anywhere; if one seems needed, STOP — a placement assumption broke.**
2. **D2 — one module, built across waves** (checkpoints Wave 1, pipeline Wave 2): they share `dbPool`/`log`/`STORAGE_MODE` and the pipeline calls checkpoint fns 9×; same file keeps those calls internal.
3. **D3 — `log` extracted verbatim to `server/lib/serverLog.js`, NOT unified with `server/utils/logger.js`** — the utils logger forwards to registered listeners (Test Lab capture); switching 320 call sites onto it would be a behavior change. Non-unification documented in the file header.
4. **D4 — injection seam**: `initStoryJobPipeline({ dbPool, STORAGE_MODE, userLandmarkCache, LANDMARK_CACHE_TTL })`, called in server.js right after `initModularPool()` (~line 387). Module-level `let`s assigned by init; verbatim bodies keep referencing the same names. `IMAGE_GEN_MODE` const line moves into the module. Landmark cache Map + its cleanup interval STAY in server.js (also used by admin routes + the landmarks route).
5. **D5 — DI seam unchanged in shape**: lines 1436–1456 keep injecting `processStoryJob`/checkpoint fns into jobs/trial/auth/admin routes — identifiers now come from the module's destructure. **Zero route files change.**

## Waves (one commit each, independently revertable; anchor by quoted comments, not line numbers)

- **Wave 0a** — `server/lib/serverLog.js`: move server.js lines 22–33 (`LOG_LEVELS` … `log`) verbatim + exports; server.js requires it. Leaf module → full require safe to test directly.
- **Wave 0b** — lift the stranded `POST /api/landmarks/discover` route (2477–2544) to just before the `// CHECKPOINT SYSTEM` banner, making 2255–8349 one contiguous cut. No `app.*` registrations exist between 1520 and 2476 → order preserved. Live curl smoke: empty body → `{"status":"skipped"}`.
- **Wave 1** — checkpoint block (2255–2476) → new `storyJobPipeline.js` with the init scaffolding; server.js destructures the checkpoint fns from it (DI at 1439 + boot/stall recovery keep working). Stub run proves the file-mode early-return guard.
- **Wave 2** — the pipeline region (banner at 2545 → trailer at 8349) appended verbatim: all inline requires, all completion sites (normal completion + `collectStoryMetrics` setImmediate hook; text-only early completion; both failure/refund catches), stale comments left as-is. Module gets the dependency requires (copied verbatim from server.js's import block, pruned to used names) + exports `processStoryJob`. server.js: delete region, extend init + destructure; surplus imports in server.js deliberately NOT pruned.
- **Wave 3** — docs only: plan marked executed, CLAUDE.md key-files + root-files list, decisions entry (D1/D3/D5 rationale).

## Verification (per wave)

- **V1** `node --check` all touched files.
- **V2** guarded require with `process.exit(0)` — bare `require()` of pipeline modules hangs on open handles; assert all exports are functions.
- **V3 — the completeness gate:** ESLint `no-undef` (client's eslint 9, flat config in scratchpad, `--no-config-lookup`) over `storyJobPipeline.js` AND `server.js` — zero errors proves every free variable in ~6,000 moved lines is imported/injected/global. This catches missed imports in branches no smoke can reach (refund paths, trial costumes). Mandatory, not optional.
- **V4** boot test: `node server.js` locally (bounded), expect listen + `initialize()` completing (exercises boot-recovery through the moved checkpoint imports), then kill.
- **V5** live DI smokes while booted: landmarks curl; a jobs-route call for a nonexistent job id → clean 404 (proves injected fns work).
- **V6** `git diff --color-moved=zebra` pure-moves audit; `check-settled.js` green every wave.
- **Final gate (owner-controlled, after owner deploys):** one staging validation story on the smoke account; compare its `story_metrics` row to baseline (same scores/counters/churn ⇒ nothing changed). Cheap extras that exercise otherwise-unreachable moved code: cancel one job early (JobCancelledError + refund path), one text-only run (the separate early-completion write).

## Scope fence (explicitly NOT doing)

No dead-code deletion (the 630-line `REMOVED_initializeDatabase_DEAD` stays; separate trivial commit someday). No logger unification. No trial special-casing. No route-file changes. No pruning of server.js's surplus imports. No fixing stale comments, no renames, no reformatting. No touching the pre-existing `getCostumedAvatarGenerationLog` lib→route edge. No further splitting of the new 6,100-line module (future phase, facade technique). **No pushes — owner deploys.** No new npm deps.

## Critical files

- `server.js` (all moves originate here; seam edits: lines 22–33, 309, ~387, import block, 1436–1456)
- `storyJobPipeline.js` (new, root)
- `server/lib/serverLog.js` (new)
- `server/routes/jobs.js` (read-only V5 reference — must not change)
- `docs/plans/storyhelpers-split.md` (binding phase-1 conventions)
