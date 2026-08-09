# storyHelpers.js Split — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.
> Review checkpoint after every wave. Commits allowed; **NO PUSHES** — owner pushes.
> Do NOT start while another structural batch is undeployed/unvalidated.

**Goal:** break `server/lib/storyHelpers.js` (7,256 lines, 110 top-level functions) into domain modules so parallel agents stop colliding in it and sessions stop reading 7k lines to edit 20 — with **zero behavior change and zero importer churn**.

**The load-bearing decision — facade, not sweep:** 42 files require `storyHelpers`. We do NOT touch them. `storyHelpers.js` becomes a re-export facade (`module.exports = { ...require('./promptBuilders'), ...require('./sceneMetadata'), ... }`); every existing import keeps working byte-identically. Importers migrate to direct requires opportunistically later (or never). This turns a 42-file sweeping-shape-change into a 4-file move.

**Rules (non-negotiable):**
- **Verbatim moves only.** No renames, no signature changes, no "while I'm here" cleanups, no reformatting — `git diff --color-moved` must show pure moves. Refactoring inside functions is a separate future task.
- One wave per commit; each wave independently verified and revertable.
- Circular-require check every wave: `images.js ↔ storyHelpers` interdependence is known; if a moved function needs something from another bucket, use a lazy `require()` inside the function (existing repo pattern) rather than a top-level import — and note it in the commit.
- Module-load verification must use `node --check` + targeted stub execution — full `require()` of pipeline modules hangs on open handles (known; do not "fix" that here).

## Target modules (buckets)

| New module | Contents (representatives — Task 1 completes the list) |
|---|---|
| `server/lib/promptBuilders.js` | `buildImagePrompt`, cover/empty-scene/scene-review/scene-expansion prompt builders (`buildSceneReviewPrompt`, `buildSceneExpansionAllPrompt`, …), text-area instruction |
| `server/lib/sceneMetadata.js` | `extractSceneMetadata`, `parseProseMetadataFormat`, position handling (`normalizePositionToLCR`, `POSITION_ABBREVIATIONS`), page/marker parsers |
| `server/lib/clothingResolve.js` | `resolveCharacterReqs`, `buildClothingDescription`, `buildAvailableAvatarsForPrompt`, avatar category resolution |
| stays in facade | anything used by 2+ buckets internally, tiny glue, and the re-exports |

## Tasks

1. **Inventory (read-only).** Bucket all 110 functions + module-level constants; map the internal call graph (who calls whom across buckets); list every function's external callers (grep, context-read — names are overloaded per sweeping-shape-changes). Output: a table in this plan file, committed, reviewed by owner before any move. Flag any function whose bucket is ambiguous.
2. **Wave 1 — `clothingResolve.js`** (smallest, hottest: two workstreams touched it in one day). Move, facade re-export, verify, commit.
3. **Wave 2 — `sceneMetadata.js`.** Parsers are regression-sensitive: before/after stub run on ≥3 stored stories' raw outlines (scratch script, staging DB read-only) proving identical parse output (deep-equal). Commit.
4. **Wave 3 — `promptBuilders.js`** (largest). Before/after prompt-render comparison on ≥3 stored stories (same technique the beat-fed-review validation used): built prompts must be byte-identical. Commit.
5. **Facade shrink + docs.** storyHelpers.js is now re-exports + residue (target: <500 lines). Update CLAUDE.md key-files table + decisions.md entry (facade rationale, importer-migration policy: opportunistic, never bulk). Commit.

## Verification per wave (all of)
- `node --check` on every touched file.
- Stub-execute at least one moved function per bucket with real fixture data (smoke-testing-before-push).
- `node scripts/admin/check-settled.js` green.
- `git diff --color-moved=zebra` eyeballed: moves only.
- After all waves: one cheap validation story (rung 3, 4-page smoke — owner approval for the paid run) and compare its `story_metrics` row against the pre-split baseline — the stats framework is the regression detector: same scores/counters/churn ⇒ split changed nothing.

## Out of scope (future phase docs, do not do now)
- `server.js` job-pipeline extraction (phase 2 — own plan, higher risk: boot order, completion hooks).
- `images.js` continuation (stays opportunistic per existing pattern).
- Migrating the 42 importers to direct requires.
- Any behavior change whatsoever.
