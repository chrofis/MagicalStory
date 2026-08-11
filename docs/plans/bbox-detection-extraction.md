# images.js Bbox-Cluster Extraction → `server/lib/bboxDetection.js` — Plan

## Context

Phase 3 of the god-file program (after storyHelpers and the server.js pipeline, both shipped via verbatim moves + facades). `server/lib/images.js` (8,902 lines) still contains a self-contained detection slab: **lines 2427–4156 (~1,730 lines)** — VB-object grounding, the bbox cache, fingerprint/pairing invariants, `detectAllBoundingBoxes`/`_detectAllBoundingBoxesImpl`, `detectSubRegion`, `buildExpectedCharactersForBbox`, overlay rendering, `enrichWithBoundingBoxes`. Extracting it takes images.js to ~7,150 and isolates the detection domain next to its sibling `figureDetection.js`. This cluster is quiet (no recent commits touch it), unlike the eval cluster where another session is actively working — which is why bbox goes first.

## Load-bearing decisions (forced by exploration)

1. **D1 — NEW sibling `server/lib/bboxDetection.js`, NOT into `figureDetection.js`.** The cluster needs `callGrokVisionAPI` + `sanitizeForGemini` from images.js and lazily requires `entityConsistency` — which top-level-requires `./images`. Folding the cluster into figureDetection would invert its deliberately-bottom-of-graph position (its own header says so twice) and create a load-time cycle. The sibling requires `./figureDetection` one-way, preserving the DAG.
2. **D2 — images.js becomes a re-export facade for all cluster names** (incl. `FIGURE_COLORS`). Consumers: `storyJobPipeline.js`, `repairPipeline.js`, `entityConsistency.js` (top-level import!), `coverIterate.js`, `gridBasedRepair.js`, `testlab.js`, `regeneration.js` (top-level import), `stories.js`, plus 7 scripts/tests — one (`tests/manual/evalFigureIdentityPersist.test.js:98`) regex-asserts the `images().detectionForVersion(v)` call shape. **Zero consumer edits; facade names never change.**
3. **D3 — the two back-edges into images.js (`callGrokVisionAPI` at 4 sites, `sanitizeForGemini` at 1) become lazy `require('./images')` inside the call sites** — the exact pattern the cluster already uses for `getStoryHelpers` and `entityConsistency`. `sanitizeForGemini` stays in images.js (shared with the eval cluster and exported to entityConsistency). These 5 one-line lazy-require insertions are the ONLY permitted non-verbatim edits, each noted in the commit.
4. **D4 — moves with the cluster:** the bbox cache block (`_bboxCache` + TTL/max consts + stats — fully self-contained), `FIGURE_COLORS` (images.js:96–107, used only by the overlay renderer; facade re-export keeps `regeneration.js`'s import working), and the `LOCAL_PROMPTS.bboxRefineOverlay` template load (images.js:46 → module-local load in the new file).
5. **D5 — binding invariants (settled; violating any = STOP):**
   - `sourceImageFp` stamping (`decisions.md` 2026-07-19): `imageFingerprint`, `bboxPairsWith`, the stamping wrapper `detectAllBoundingBoxes`, and the re-stamp in `enrichWithBoundingBoxes` move **together as one implementation** — no duplicate predicate may exist anywhere.
   - `_gdinoMasks` rides detections **non-enumerably** (2026-07-21) — verbatim moves preserve this automatically; no `{...det}` rebuilds anywhere in scaffolding.
   - One-detection-per-bytes + `detectionForVersion` resolution order (2026-08-09) — name and behavior unchanged.
   - Test Lab reuses production code — its lazy `require('./images')` calls keep resolving via the facade.

## Waves (one commit each; anchors, not line numbers; verbatim moves)

- **Wave 1 — the move.** Create `server/lib/bboxDetection.js`: header (origin, D1 rationale, invariant pointers, the open-handles require warning); requires copied verbatim where shared (`sharp`, `log`, r2, prompts/fillTemplate, generationLogger, config/models MODEL_DEFAULTS + CONFIG_DEFAULTS alias, textModels MODEL_DEFAULTS/TEXT_MODELS/withRetry, `./figureDetection` trio); the `FIGURE_COLORS` block and `bboxRefineOverlay` load; then the **byte-identical cluster slab** (extract by line range into scratchpad, concatenate — never retype), with the 5 lazy-require back-edge insertions. Exports: all 16 cluster functions + `FIGURE_COLORS`.
  images.js: delete the slab + `FIGURE_COLORS` + the `bboxRefineOverlay` entry + the now-unused `./figureDetection` import; add one destructured `require('./bboxDetection')` and keep every deleted name in `module.exports` (facade). 
- **Wave 2 — docs.** decisions.md entry (D1 cycle rationale, D3 back-edges, facade policy), CLAUDE.md key-files line, executed-plan copy in `docs/plans/`.

## Verification

- **V1** `node --check` on `images.js`, `bboxDetection.js`.
- **V2** guarded require (`process.exit(0)` — pipeline modules hang on bare require): assert all 16 + `FIGURE_COLORS` exports exist on BOTH `bboxDetection.js` and the `images.js` facade, and are `===` identical (same function objects — proves single implementation per D5).
- **V3** ESLint `no-undef` over both files (client's eslint 9, scratchpad flat config, `--no-config-lookup`) — zero errors = completeness proof for the 1,730 moved lines (house technique from the server.js extraction).
- **V4** byte-identity: diff the moved slab in the new file against the pre-move committed blob region.
- **V5 — deterministic behavior checks (free, scratchpad):** with a stored staging detection + page (read-only DB): (a) `bboxPairsWith`/`imageFingerprint` round-trip on real `sourceImageFp`-stamped data; (b) `buildExpectedCharactersForBbox` + `parseVisualBibleObjects` + `resolveExpectedObjectLabels` output deep-equal captured pre-move baselines; (c) `createBboxOverlayImage` on a fixture detection → byte-identical PNG pre/post (sharp is deterministic); (d) confirm `_gdinoMasks` non-enumerability survives (`Object.keys` excludes it, direct access works) on a synthetic detection passed through the moved attach path.
- **V6** `git diff --color-moved=zebra` audit (moves + the 5 documented lazy-require lines only); `check-settled.js` green; `git status` foreign-edit check on images.js before each commit (the other session commits to staging concurrently — verified non-overlapping so far, but check every time).
- **Final gate (owner-controlled):** after owner deploys — one smoke-account validation story; its `story_metrics` row (incl. `dino_*`/`sam_*` counters, which run through the moved code) compared to baseline. Owner launches; never auto-run.

## Scope fence

No behavior changes; no consumer/route/testlab edits; no renaming; no cache-policy tuning; no touching the eval cluster (active work by another session); no fixing the DINO/Gemini routing; no pushes (owner deploys); no new deps.

## Critical files

- `server/lib/images.js` (source; facade afterwards)
- `server/lib/bboxDetection.js` (new)
- `server/lib/figureDetection.js` (read-only — its one-way position must be preserved)
- `server/routes/regeneration.js`, `server/lib/entityConsistency.js` (read-only — the two top-level importers proving the facade works)
- `docs/decisions.md` entries 2026-07-19 (sourceImageFp), 2026-07-21 (_gdinoMasks), 2026-08-09 (one-detection-per-bytes) — binding constraints

---

## Execution record (2026-08-11, commit 67b31e8f1)

Executed as planned, verbatim move + facade. **Deviations & findings:**

1. **Slab recomputed against HEAD 205b0a292/e10c1dbb4:** lines 2427–4156 of
   images.js (1,730 lines) — same content anchors as the plan; images.js was
   8,018 lines at execution (other sessions had shrunk it since the plan's
   8,902). Byte-identity of the moved slab vs the pre-move committed blob: PASS.
2. **Nine lazy back-edges, not five.** The plan's inventory (callGrokVisionAPI
   ×4 at slab-relative 410/464/531/728, sanitizeForGemini ×1 at 510) matched
   exactly — but V3 (ESLint no-undef) found four more images.js-defined
   identifiers used in the slab: `GEMINI_SAFETY_SETTINGS` ×3 and
   `modelSupportsThinking` ×1, all pre-existing (blames Jan–Apr 2026), none
   from the concurrent session. Fixed with the same lazy pattern — the three
   object-literal sites use inline `require('./images').X` (a statement
   insertion can't go inside a literal). Final locations: bboxDetection.js
   411, 466, 513, 527, 534, 733 (insertions) + 829, 831, 1045 (inline).
3. **Export set = 16 functions + FIGURE_COLORS:** all slab declarations except
   `_detectAllBoundingBoxesImpl`, which stays private so the sourceImageFp
   stamping wrapper is the only entry (decisions.md 2026-07-19). Facade adds
   six previously-unexported names (parseVisualBibleObjects,
   resolveExpectedObjectLabels, escapeXml, _hashBboxKey, _bboxCacheGet,
   _bboxCacheSet) — additive only.
4. **Inherited latent bug flagged, not fixed:** `finishReason` at
   bboxDetection.js:681 is out of scope (pre-move images.js:3026:79 —
   identical ESLint no-undef on the pre-move blob). Left verbatim per the
   scope fence; same class as the free-identifier sweep in 67509406f.
5. **Verification results:** V1 node --check PASS both files; V2 all 16 +
   FIGURE_COLORS exist on both and are ===-identical, impl not exported;
   V3 zero errors on images.js, exactly the one inherited error on
   bboxDetection.js (completeness proof); V4 slab byte-identity PASS;
   V5 deep-equal vs pre-move baselines PASS through BOTH the module and the
   facade (fixture job_1786397108357_q1fjbdzbx p1, sourceImageFp
   7a4caa5ed3e05807: fingerprint round-trip, pairing accept/reject, VB
   parser + resolver incl. ID-translation exercise, overlay PNG sha1
   byte-identical, _gdinoMasks non-enumerable through the shared path);
   V6 --color-moved=zebra audit — every non-moved addition is documented
   scaffolding or one of the nine back-edge lines; check-settled OK.
6. **Concurrency incident:** a concurrent session's `git commit` briefly swept
   the staged move files into its own commit (9a87156e6); that session
   immediately rewrote it without them (e10c1dbb4) and the move was then
   committed cleanly as 67b31e8f1. Content verified identical throughout via
   git hash-object.
7. **Final gate still owner-controlled:** one smoke-account validation story
   after deploy, comparing `story_metrics` (dino_*/sam_* counters) to baseline.
