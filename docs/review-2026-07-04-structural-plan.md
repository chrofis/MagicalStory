# Structural refactors — deferred from 2026-07-04 review (STR-1..5, VAR-1)

**Status:** deferred from the 2026-07-04 cleanup pass. All 18 contained findings
(DUP-1..7, SW-1..5, SPD-1..6, STR-6) shipped to staging and were proven by a
showcase story. These 6 remaining items are **large architectural refactors**
that are behavior-preserving but touch god-files / 25 endpoints / a shared data
model. They are deliberately **not bundled** into a showcase-validated push:

- The showcase exercises the *autonomous generation pipeline*. It does **not**
  exercise the manual repair endpoints (STR-4), the version-picker data model
  (VAR-1), or prove a 14k-line file split / 7k-line component split didn't
  introduce an import-order or render regression (STR-1/2/3/5).
- Each is its own multi-hour effort with its own test surface. Bundling them
  would jeopardize the very showcase we use as the safety gate, and violates
  "Minimal Impact / Avoid introducing bugs / Would a staff engineer approve this".

Each should ship as its **own PR**, staging-tested against its specific surface,
before promotion to master. Plans below are concrete enough to execute directly.

---

## STR-1 — Split `processUnifiedStoryJob` (server.js, ~4,600-line function)

**Problem:** one 4,600-line function; ~30 shared mutables; mode passed as 5
positional booleans; `trialMode` re-checked 19×. A missed `trialMode` branch
silently gives trial users full behavior.

**Plan:**
1. Define an immutable `JobContext` object resolved once at intake:
   `{ jobId, userId, inputData, mode: {trial, dev, admin, skipCovers, ...},
   dbPool, addUsage, log, checkCancellation }`. Replace the 5 positional
   booleans + 19 ad-hoc `inputData.trialMode` reads with `ctx.mode.trial`.
2. Extract each pipeline phase into `server/lib/pipeline/*.js`, each a pure-ish
   `async function(ctx, state) → state` unit:
   `01-generateStory`, `02-expandScenes`, `03-emptyScenes`, `04-generateImages`,
   `05-textRegion`, `06-evaluate`, `07-autoRepair`, `08-characterRepair`,
   `09-pickBest`, `10-covers`. `processUnifiedStoryJob` becomes a ~150-line
   orchestrator calling them in sequence with checkpointing between.
3. Migrate incrementally: extract one phase per commit, keep the old inline body
   calling the new module until all are moved. Each commit → staging showcase.
**Test surface:** full showcase per extracted phase; diff story-data JSON of a
fixed-seed story before/after each extraction.
**Risk if rushed:** a shared mutable captured by a closure that a phase still
mutates in place → subtle state bleed. Extract phases that own their state first.

---

## STR-2 — Split `server/lib/images.js` (~14,000-line god-file, 8 domains)

**Problem:** 8 domains in one file; lazy-`require` circular-dep workarounds;
module-level caches shared across concurrent jobs (cross-user cache-bleed risk).

**Plan:** split by domain into `server/lib/image/`:
`imageGen.js` (generateImageOnly + provider dispatch), `imageEval.js`
(quality/semantic eval), `bbox.js` (detection/refine), `inpaint.js`,
`repairPipeline.js`, `vbGrid.js` (buildVisualBibleGrid), `imageCache.js`,
`aspect.js` (already extracted → grokAspect.js). Keep `images.js` as a thin
re-export barrel during migration so callers don't change until the end.
1. First map the dependency graph (which functions call which) — many are
   already island-like. Extract leaf domains first (bbox, vbGrid, aspect done).
2. Convert lazy-requires to top-level once the cycle is broken by the split.
3. Audit every module-level cache: key it by `storyId`/`userId` or move it into
   `JobContext` — this is the one place a "cleanup" can fix a latent cross-user
   bug, so do it deliberately, not mechanically.
**Test surface:** module-load all new files; full showcase; a concurrent
two-story run to prove no cache-bleed.
**Risk if rushed:** import-order-dependent `undefined`-function crashes. The
barrel + leaf-first order mitigates this.

---

## STR-3 — Collapse 17/10-positional-arg image fns → `ImageRequest` object

**Problem:** `images.js` has functions with 17 and 10 positional args; callers
pass runs of `null`. A swapped `null` → wrong model/aspect, visible only in the
output picture.

**Plan:** introduce a single `ImageRequest` param object
(`{ prompt, referencePhotos, aspectRatio, modelOverride, backendOverride,
landmarkPhotos, visualBibleGrid, pageNumber, sceneBackground, textAreaMask, ... }`)
with documented defaults. Convert one function + all its call sites per commit.
Do STR-3 **after** STR-2 (fewer, clearer call sites once split). Add a runtime
assert that rejects unknown keys (typo guard).
**Test surface:** every converted call site exercised by the showcase (page gen
+ all 3 repair rounds hit these). Grep-verify no positional call remains.
**Risk if rushed:** a mis-mapped positional→named field silently changes model
or aspect. Convert + showcase one function at a time.

---

## STR-4 — `loadOwnedStory` middleware + `sendRouteError` (regeneration.js, 25 endpoints)

**Problem:** 25 endpoints copy-paste the ownership `SELECT` + JSON-parse + error
redaction, already divergent (`getDbPool` vs `dbQuery`, `SELECT *` vs `data`).
Cross-cutting fixes (the SEC-1 class) must touch 25 handlers → some get missed.

**Plan:**
1. `loadOwnedStory(req,res,next)` middleware: resolves `:id`, runs the ownership
   check (admin bypass preserved), parses `stories.data`, attaches `req.story` +
   `req.storyRow`. 403 on cross-owner, 404 on missing — one place.
2. `sendRouteError(res, err, context)` helper: consistent redaction + status.
3. Apply to all 25 handlers, deleting their inline preambles.
**Test surface:** this is the risky one — the showcase does NOT hit these repair
endpoints. Required before promotion: a staging API smoke-suite hitting each of
the 25 (owner 200, cross-owner 403, missing 404) against a seeded story on the
smoke-test account. Do not merge to master without it.
**Risk if rushed:** an endpoint that used a slightly different ownership query
(e.g. also filtered by status) loses that nuance → auth hole or false 404.
Audit each preamble for per-endpoint conditions before replacing.

---

## STR-5 — Split `StoryDisplay.tsx` (~6,972-line component, 25 dev-mode conditionals)

**Problem:** one component mixes the customer viewer with admin/dev repair tools
gated by 25 `developerMode` conditionals; dev code ships in the customer bundle;
dev-tool state re-renders the customer view.

**Plan:**
1. Extract feature hooks: `useTextOverlay`, `useVersionPicker`, `useRepairTools`,
   `usePageParsing` (SPD-6 memo already in place).
2. Lazy-load a `<StoryDevTools>` subtree behind `developerMode` via
   `React.lazy` — keeps dev code out of the customer bundle.
3. Extract a memoized `<PageCard>` (SPD-6 flagged this needs the split first).
**Test surface:** manual — customer view render + dev-panel render on staging;
Playwright viewer test. Verify bundle no longer contains dev-tool code for the
customer path.
**Risk if rushed:** shared state between viewer and dev tools → extract state
ownership carefully; a wrong dep array re-renders the base64 page tree.

---

## VAR-1 — Unify image-version state (3 sources of truth)

**Problem:** version state lives in 3 places kept in sync by convention only:
JSONB `imageVersions` (array-position based) ↔ `story_images.version_index`
(via `arrayToDbIndex`, 10 sites) ↔ `image_version_meta.activeVersion` (stores DB
indices while the client uses array indices). `getActiveStoryImages` already
carries a fallback patch for the drift.

**Plan:**
1. Pick `story_images.version_index` as the single source of truth. Treat JSONB
   `imageVersions` as a derived cache (or drop its bytes entirely — already
   stripped on save).
2. Make `activeVersion` store the same index space everywhere (DB index);
   convert at the client boundary once, not in scattered call sites.
3. Add a DB constraint / invariant check + a one-time migration/repair script to
   reconcile existing rows, then remove the `getActiveStoryImages` fallback patch.
**Test surface:** needs a data migration + version-picker E2E (insert / delete /
reorder a version, confirm activeVersion still points at the right image).
**Risk if rushed:** a migration that mis-maps existing stories' active version →
users see the wrong image as "current". Must run against a staging DB snapshot
first. This is the only item here that touches persisted data — highest bar.

---

### Recommended order

STR-2 (unblocks STR-1 + STR-3) → STR-3 → STR-1 → STR-4 → STR-5 → VAR-1.
VAR-1 last (data migration, highest risk). Each its own staging-tested PR.
