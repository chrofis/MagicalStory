# images.js Eval-Cluster Extraction → `server/lib/evalPipeline.js` — Plan

## Context

Phase 4 of the god-file program (after storyHelpers, the server.js pipeline, and bboxDetection — all shipped as verbatim moves + facades). `server/lib/images.js` (6,304 lines) still contains the image-evaluation slab: **lines 571–2434 (~1,864 lines)** — visual inventory (P1), empty-scene QC, three-stage compliance eval, the 1,133-line `evaluateImageQuality` core, `sanitizeForGemini`, `isBlockedResponse`, `capComplianceIdentitySeverity`. Extracting it takes images.js to ~4,400 lines, leaving it genuinely the image-*generation* module. The slab is quiet (all four recent images.js commits — shrink-prompts, rendering-rules, inset-leaks, namer-revert — landed OUTSIDE it), so the move window is open.

## Load-bearing decisions (forced by exploration)

1. **D1 — NEW `server/lib/evalPipeline.js`; images.js becomes facade for all 8 public names** (`runVisualInventory`, `validateEmptyScene`, `capComplianceIdentitySeverity`, `evaluateThreeStage`, `sanitizeForGemini`, `evaluateImageQuality`, plus consts `IMAGE_QUALITY_THRESHOLD`, and non-exported `isBlockedResponse` moves as private). Top-level destructure consumers (`server.js:96–108`, `regeneration.js:118–138`, `entityConsistency.js:20` for `sanitizeForGemini`) keep working ONLY via plain re-exports in `module.exports` — same as bbox.
2. **D2 — the slab moves verbatim, including the orphaned JSDoc at 1244–1256** (an `evaluateImageQuality` doc block physically sitting above `sanitizeForGemini`). Do NOT "fix" the misplacement — byte-identity gate.
3. **D3 — moves with the cluster:** `EVAL_TEMPERATURE` (line 89 require), `EVAL_THINKING_BUDGET` (90) **with the variance-test rationale comment 79–88**, and `IMAGE_QUALITY_THRESHOLD` (393) — all cluster/eval-exclusive; images.js re-exports the threshold.
4. **D4 — back-edges into images.js become lazy `require('./images')` at call sites** (the proven D3-bbox pattern): `callGrokVisionAPI` (6 sites: 589, 621, 659, 1064, 1651, 1753), `GEMINI_SAFETY_SETTINGS` (4 sites: 602, 910, 1077, 1670). **Exception — `getStoryHelpers` (7 sites): do NOT back-edge; redefine the identical lazy accessor locally in evalPipeline.js** (`require('./storyHelpers')` is cycle-free and the accessor holds no shared state).
5. **D5 — `compressedRefCache` is a SINGLE-INSTANCE shared LRU (images.js:390; eval reads/writes 1584/1602, generation 2819/2825, stats 6038). It stays in images.js; eval reaches the LIVE singleton lazily.** Add `compressedRefCache`, `hashImageData`, `compressImageToJPEG` to images.js `module.exports` (documented additive edit) and back-edge at the two call sites. Duplicating the cache would silently double compression cost — the one genuinely dangerous item. (Hoisting to a `refCache.js` module is the eventual clean home when the generation cluster is split later — out of scope now.)
6. **D6 — reverse back-edge:** `evaluateImageQuality` is called by non-cluster images.js code at 3077, 3341 (`callGeminiAPIForImage`), 3998 (`evaluateImageBatch`), 5481 (`iteratePageCore`). The facade's top-level destructure `const { evaluateImageQuality, ... } = require('./evalPipeline')` puts the name back in scope — those 4 call sites need zero edits.
7. **D7 — cycle law:** evalPipeline.js may top-level require only leaves (`textModels`, `evalBuckets`, `evalJudges`, `../services/prompts`, `../config/models`, `r2`, loggers, sharp/path/crypto). **`./sceneValidator` (line 1396) and `./entityConsistency` (line 1372) MUST stay lazy** — both reach `entityConsistency` which top-level-requires `./images`; hoisting either creates a real load-time cycle that would hand entityConsistency a half-built exports object. `./scoring`, `./figureDetection`, `./bboxDetection` are NOT required at all (zero cluster uses — the settled scoring invariant holds: the cluster produces findings, severity caps live in scoring.js).
8. **D8 — deliberate stays (documented in decisions.md):** `evaluateImageBatch` (3951–4179) and `collectAllIssuesForPage` (6077–6166) stay in images.js — they are the eval↔bbox seam (call `enrichWithBoundingBoxes`, `parseVisualBibleObjects`, overlay etc.), not eval-pure. `shrinkPromptForModel` + helpers (2490–2612) are GENERATION side (Grok prompt budget inside `_dispatchImageGeneration`) — untouched.
9. **D9 — source-scraping tests get path updates (permitted consumer edits, each documented):**
   - `tests/manual/test-compliance-severity-cap.js:22` — `readFileSync` path → `evalPipeline.js` (it vm-extracts `capComplianceIdentitySeverity` from source text; can't require images.js there).
   - `tests/manual/evalFigureIdentityPersist.test.js:51` — split-source fix: read `evalPipeline.js` for the `evaluateImageQuality` needles (`figures,\n matches` return shape, `rawOutput: responseText,`) and keep reading `images.js` for the `evaluateImageBatch` whitelist needles. Two `readFileSync` calls instead of one; assertions unchanged.
   - Stale doc pointer: `server/lib/figureIdentityCheck.js:29` comment cites "images.js ~2138-2160" → update to evalPipeline.js (wave 2).

## Waves (one commit each; anchors, not line numbers; verbatim moves)

- **Wave 1 — the move.** Create `server/lib/evalPipeline.js`: header (origin, D5/D7 pointers, open-handles require warning); top-level requires copied where shared (`sharp`, `path`, `crypto`, `log`, r2, `PROMPT_TEMPLATES`/`fillTemplate`, `withRetry`, `MODEL_DEFAULTS`, `TEXT_MODELS`, local `getStoryHelpers` accessor per D4); the `EVAL_TEMPERATURE`/`EVAL_THINKING_BUDGET` block with its 79–88 comment; `IMAGE_QUALITY_THRESHOLD`; then the **byte-identical 571–2434 slab** (extract by line range into scratchpad, concatenate — never retype), with the 12 lazy-require back-edge insertions (6× callGrokVisionAPI, 4× GEMINI_SAFETY_SETTINGS, 2× refCache trio per D5). Exports: the 7 public names + `IMAGE_QUALITY_THRESHOLD`.
  images.js: delete the slab + the three moved consts; add `const { … } = require('./evalPipeline')` destructure (all 8 names — D6 needs `evaluateImageQuality` in scope); keep every deleted name in `module.exports` (facade); ADD `compressedRefCache`, `hashImageData`, `compressImageToJPEG` to exports (D5).
  Update the two source-scraping tests (D9).
- **Wave 2 — docs.** decisions.md entry (D5 singleton rationale, D7 cycle law, D8 stays, D9 test-path edits), CLAUDE.md key-files line for evalPipeline.js, figureIdentityCheck.js:29 comment, executed-plan copy in `docs/plans/`.

## Verification

- **V1** `node --check` on `images.js`, `evalPipeline.js`.
- **V2** guarded require (`process.exit(0)` — pipeline modules hang on bare require): assert all 8 exports exist on BOTH modules and are `===` identical (single implementation), AND `require('./images').compressedRefCache === ` the object evalPipeline resolves (singleton proof for D5).
- **V3** ESLint `no-undef` over both files (client's eslint 9, scratchpad flat config, `--no-config-lookup`) — zero errors = completeness proof for the 1,864 moved lines.
- **V4** byte-identity: diff the moved slab against the pre-move committed blob region (the orphaned JSDoc must survive misplaced, per D2).
- **V5** run the two updated source-scraping tests (`test-compliance-severity-cap.js`, `evalFigureIdentityPersist.test.js`) — both green.
- **V6** `git diff --color-moved=zebra` audit (moves + the 12 documented lazy-require lines + 3 additive exports only); `check-settled.js` green; `git status` foreign-edit check on images.js before each commit (other sessions commit to staging concurrently).
- **Final gate:** push to staging (idle-gate respected, never --no-verify), verify `/api/health` SHA == pushed head and stable, then one 4-page validation story on the smoke account (`scripts/test-scene-composite-smoke.js`, TEST_BASE_URL=staging, full eval) — the eval path IS the moved code, so findings/scores/eval counters in its `story_metrics` row landing sanely = behavioral proof. Compare against today's baseline row `job_1786563358202_vb3f0zy6v`.

## Scope fence

No behavior changes; no renaming; no eval-prompt or scoring edits (settled); no touching `evaluateImageBatch` / `collectAllIssuesForPage` / `shrinkPromptForModel`; no refCache hoist; no consumer edits beyond the two source-scraping tests; no new deps.

## Critical files

- `server/lib/images.js` (source; facade afterwards)
- `server/lib/evalPipeline.js` (new)
- `server/lib/entityConsistency.js`, `server/routes/regeneration.js`, `server.js` (read-only — top-level destructure consumers proving the facade)
- `server/lib/sceneValidator.js` (read-only — the cycle hazard, D7)
- `tests/manual/test-compliance-severity-cap.js`, `tests/manual/evalFigureIdentityPersist.test.js` (path updates, D9)
- `server/lib/scoring.js`, `server/lib/evalBuckets.js` (read-only — settled severity invariant)
