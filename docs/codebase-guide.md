# Codebase Guide

Detailed reference for subsystems and features. This content was extracted from `CLAUDE.md`
to keep the always-loaded instructions file lean. Read the relevant section here before
touching the corresponding code path.

Top-level architecture, the AI provider table, the generation-pipeline summary, key-file
navigation, and the operational rules (push approval, timezone, log analysis) stay in
`CLAUDE.md`.

---

## Repair Workflow (Post-Generation)

Two separate orchestrators share the same repair primitives:

1. **Pipeline auto-repair** — `runUnifiedRepairPipeline()` in `server/lib/images.js` (~6239).
   Runs automatically inside every story generation (server.js Phases 5b-5g), pages AND
   covers (covers join as negative page numbers -1/-2/-3).
2. **Manual repair workflow** — `useRepairWorkflow.ts → runFullWorkflow()` (~1154), triggered
   from `RepairWorkflowPanel`. Orchestrates the HTTP endpoints in `server/routes/regeneration.js`.

**Scoring model** — canonical scores live in `server/lib/scoring.js` (`computeFinalScore`,
`applyScore`, `setVersionScores`, `capEntityPenalty`):
```
imageScore  = visualScore − semanticPenalty     (quality eval already folds semantic in)
finalScore  = imageScore − entityPenalty        (entity penalty CAPPED via capEntityPenalty)
```
- Entity penalties: critical −30, major −20, minor −10 (character AND object issues), then capped
  so a stack of non-actionable entity flags can't sink a good original below the redo threshold.
- Per-evaluator sub-scores live under `version.scoreBreakdown.<evaluator>.score`; legacy
  `qualityScore`/`semanticScore` fields are read-only fallbacks for pre-migration stories.

**Thresholds** (`server/config/models.js` → `REPAIR_DEFAULTS`; client mirror in
`client/src/config/repairDefaults.ts` — keep in sync, they drifted once):
- `scoreThreshold: 60` — pages with finalScore below this get repaired
- `issueThreshold: 5` — pages with 5+ fixable issues get repaired
- `maxPasses: 3` — repair rounds
- `maxCharRepairPages: 20` — character-repair budget per run (hard spend ceiling)
- `inpaintMaxPasses: 1` — inpaint attempts per page per round
- Client-only: `semanticThresholdForIterate: 30`, `qualityThresholdForIterate: 20`

### Pipeline auto-repair (`runUnifiedRepairPipeline`)

```
(before the pipeline) SCALE-REPAIR per page — outline-triggered, see subsection below

Step 1  Evaluate ALL images + entity consistency in ONE parallel batch
        (evaluateImageBatch + runEntityConsistencyChecks; checkObjects:false —
        objects are per-page concerns handled by quality/semantic eval)

Step 2  ROUND LOOP (round 1..maxPasses):
        ├─ findBadPages (server/lib/repairLogic.js) on best-version scores:
        │    finalScore < 60 OR fixableIssues >= 5 OR eval failed (evaluated:false)
        ├─ decideRepairMethod (repairLogic.js:179) per bad page, EVERY round:
        │    1. visualScore < 50 OR semanticScore < 30 (hardcoded inline) → iterate
        │    2. major/critical entity issue on this page (scene pages only) → char-fix
        │    3. anything inpaintable (fixableIssues/fixTargets/semantic)   → inpaint
        │    4. otherwise → skip
        ├─ flip logic: inpaint↔iterate flips when the last repair regressed or the
        │    same method failed twice; a page where BOTH regressed is given up on
        │    (outstanding critical issues logged). char-fix is never flipped.
        ├─ execute in parallel (pLimit 50):
        │    iterate  → iteratePage (scene re-expansion, styled-only refs, saved
        │               plate reused) / iterateCover for covers / generateImageOnly
        │    inpaint  → inpaintPage (consolidated instruction → editImageWithPrompt)
        │    char-fix → repairCharacterMismatch (Grok; see modes below)
        └─ re-evaluate repaired pages + fresh entity check in parallel; append
           versions; failed attempts persist to retryHistory (round_repair_failed)

Step 3  Pick best version per page across original + all rounds (selectBestVersion).
        Score-based selection respects PINNED active versions: explicit user
        choices (manual version pick, iterate, style-transfer, scale-repair,
        cover regen/edit) write image_version_meta[key] = { activeVersion,
        pinned: true } and every recompute skips them; a plain setActiveVersion
        (pipeline / repair-workflow pick-best) clears the pin. Regen routes also
        stamp version entries with dbVersionIndex (real DB version_index) —
        pickers and rehydrate prefer the stamp over the identity array mapping.
        See docs/decisions.md 2026-07-10 and server/lib/versionManager.js.
Step 3b Rescue eval: if best < RESCUE_THRESHOLD (60, hardcoded) and an unscored
        original exists (e.g. pre-scale-repair v0), evaluate it and re-pick —
        prevents a damaged repair from shipping just because the original had no score
Step 4  Post-repair calm-zone recovery — ensureCalmZone (textSpaceRepair.js) on
        repaired text-overlay pages; a better candidate becomes a new version
Step 5  Style-consistency audit (styleConsistency.js → checkStoryStyleConsistency)
        across the picked images; verdict + outliers surfaced on the results
```

There is **no separate post-loop character-repair stage** — char-fix is a per-round
per-page method inside the loop, and entity consistency re-runs once per round (the last
round's report is the final verdict). Char-fix resolves the target bbox via
`resolveCharBbox` (entity report → bbox detection → eval matches), builds protection
bboxes for every OTHER character on the page, picks face-vs-body from the issue text, and
attaches the styled avatar matching the page's clothing category.

### Manual workflow (`runFullWorkflow` in useRepairWorkflow.ts)

```
collect-feedback
ROUNDS 1..maxPasses(3):
  re-evaluate ALL pages + covers (POST /:id/repair-workflow/re-evaluate;
    server-side findBadPages returns badPages)
  per bad page: local chooseRepairStrategy —
    round >= 3            → inpaint (last chance, cheap)
    semantic < 30 or quality < 20 → iterate
    round 2               → alternate from round-1 action
    has fixableIssues/fixTargets  → inpaint, else iterate
  inpaint → POST /:id/repair/image/:pageNum ; iterate → POST /:id/iterate/:pageNum
pick-best (changed pages)             → POST /:id/repair-workflow/pick-best-versions
entity check                          → POST /:id/repair-workflow/consistency-check
character repair                      → POST /:id/repair-workflow/character-repair
                                        { autoSelect: true, maxCharRepairPages }
                                        (selectCharRepairTasks: major/critical, dedup,
                                        critical-first, budget 20)
re-evaluate changed pages
style audit                           → POST /:id/style-check (non-fatal on error)
final pick-best (incl. char-repair versions), refresh story
```

Note the two orchestrators intentionally differ: the client keeps character repair as a
post-round step; the server pipeline runs it inside the rounds. Abortable at every step
via AbortController.

### Character repair — FOUR modes (`repairCharacterMismatchWithGrok`, images.js)

Defaults (both the pipeline char-fix and the manual endpoint): **face repairs → blended,
body repairs → fullScene**. In `regeneration.js`:
`effectiveMode = grokRepairMode || (useFaceOnly ? 'blended' : 'fullScene')`.
Cutout and blackout only run when explicitly requested via `grokRepairMode`.

| Mode | method label | What it does | Prompt file |
|------|--------------|--------------|-------------|
| **blended** | `grok_blended` | Blur the face/figure region → Grok redraws → feathered blend back onto the original scene | `character-repair-blended.txt` (face) / `character-repair-body-blended.txt` (body whiteout) |
| **fullScene** | `grok_inpaint` | Mirror-pad scene to a Grok preset → magenta crosshatch over body + solid block over face → Grok edits the FULL scene → unpad → conditional feather composite | `character-repair-inpaint.txt` |
| **cutout** | `grok_cutout` | Preset-aligned extract of bbox + **40% min padding** (`PAD_FACTOR = 0.4`, `computePresetAlignedExtract`) → magenta hatch → Grok → feathered composite back | `character-repair-cutout.txt` |
| **blackout** | `grok_blackout` | Legacy fallback: full scene + avatar ref to Grok, no mask, no composite | `character-repair-grok-fullscene.txt` |

**Prompt-file naming trap:** `character-repair-grok-fullscene.txt` belongs to the
BLACKOUT mode; the fullScene mode uses `character-repair-inpaint.txt`.

Non-Grok paths on the character-repair endpoint: `useGeminiRepair` →
`entityConsistency.repairSinglePage()` (also the fallback when bbox/avatar/bytes are
missing); `useMagicApiRepair` → MagicAPI face swap. `repairSinglePage()` is a repair
dispatcher exported by `server/lib/entityConsistency.js` — that module does repair, not
just detection.

### Scale repair (`server/lib/scaleRepair.js`)

Fixes "tiny background figure" scenes where Grok pulls a `depth: background` character
into the foreground. **Outline-triggered, not eval-triggered**: runs unconditionally when
the scene metadata declares ≥1 background AND ≥1 foreground character (skips indoor
scenes and shared-vessel scenes — boat/cart/wagon). Runs during generation right after
the first render (server.js ~5815), **before** the repair pipeline's eval rounds. One
Grok edit with a relocate+shrink prompt (foreground avatars attached as identity
anchors). `verifyScaleRepair` then checks each background character is still present by
visual signature — **fails open** (API hiccup accepts the repair; only a confident "not
present" discards it). The pre-repair image is kept as an unscored v0 version; Step 3b's
rescue eval protects it. Manual rerun: `POST /:id/scale-repair/:pageNum`.

### Text-space repair (`server/lib/textSpaceRepair.js` → `ensureCalmZone`)

**Regenerates pixels** — distinct from `textRegion.js`, which only measures calmness and
composites a white wash. Gate: calm pixels inside the overlay polygon must be ≥
`calmNeededPx = words × pxPerWord(fontPt)`. On failure it re-rolls the image via the
caller-supplied `generateImage` (Grok/Gemini edit with the `textAreaMask` hint), up to
`REPAIR.maxRetries` (2, `server/config/textRegion.js`), picks the candidate with the
highest `calmFoundPx`, and **returns the best candidate even when none pass** the
threshold. Used at initial generation (server.js text-region phase) and in pipeline
Step 4 (post-repair recovery). All candidates persist as versions
(`textSpaceCandidates`), the non-winner original gets a baseline eval in pipeline Step 1.

### Endpoints (`server/routes/regeneration.js`)

Repair workflow:
- `POST /:id/repair-workflow/re-evaluate` — quality + semantic eval, returns badPages
- `POST /:id/repair-workflow/consistency-check` — entity grid analysis
- `POST /:id/repair-workflow/pick-best-versions` — activate best version per page
- `POST /:id/repair-workflow/character-repair` — autoSelect or explicit repairs; options
  `grokRepairMode` (blended/cutout/blackout/fullScene), `whiteoutTarget`, `useGeminiRepair`,
  `useMagicApiRepair`, `maxCharRepairPages`, `featherComposite`
- `POST /:id/repair-workflow/artifact-repair` — grid-based artifact repair

Regenerate / edit:
- `POST /:id/regenerate/scene-description/:pageNum`
- `POST /:id/regenerate/image/:pageNum` (credits)
- `POST /:id/regenerate/cover/:coverType` — funnels through `iterateCover`
- `POST /:id/iterate/:pageNum` — re-expansion iterate (covers via negative pageNum)
- `POST /:id/edit/image/:pageNum`, `POST /:id/edit/cover/:coverType` — user-prompt edit → `editImageWithPrompt`
- `POST /:id/repair/image/:pageNum` — manual inpaint (multi-pass, Grok text edit)

Eval / detection:
- `POST /:id/evaluate-single/:pageNum`
- `POST /:id/refresh-bbox/:pageNum`, `POST /:id/iterate-bbox/:pageNum`

Style / scale / dev (admin):
- `POST /:id/style-check` — cross-page style audit (detection only)
- `POST /:id/scale-repair/:pageNum`
- `POST /:id/style-transfer/:pageNum`, `POST /:id/analyze-style/:pageNum`
- `POST /:id/style-lab/:pageNum` (+ `/evaluate`, `GET .../history`, `GET .../history/:runId`)
- `POST /:id/test-models/:pageNum`

### Observability — what's stored per version (2026-07-09 O-series)

- Every repair version carries the prompt actually sent (`prompt` / `inpaintInstruction`),
  `inpaintReferenceImages`/`inpaintReferenceSources`, `consolidatedPlan`, and for char-fix
  the pipeline images (`charRepairWhiteout` / `charRepairGrokRaw` / `charRepairBlendMask`)
  plus telemetry (`charName`, `targetBbox`, `targetBboxSource`, `whiteoutTarget`).
- All char-repair modes return `promptSent` ungated; the user endpoint persists it as
  `charRepairPrompt` on the version; the manual repair loop stores the per-pass
  `editInstruction`.
- Evals persist `qualityRawOutput` (verbatim model output) + `evalTemplateHash` (md5-8 of
  the eval template) so stored scores stay re-derivable after prompt edits.
- Composite-cover versions carry `compositeAttempts` (pass-1/pass-2 inputs, prompts,
  outputs, plus the clean `plate` and per-character `cutouts`).
- Failures persist to `retryHistory`: `round_repair_failed` (pipeline rounds),
  `char_repair_failed` (endpoint). Cover retryHistory bytes save to `story_retry_images`
  under the negative cover page numbers (-1/-2/-3).

**Key files:**
- `server/lib/images.js` → `runUnifiedRepairPipeline()`, `inpaintPage()`, `repairCharacterMismatchWithGrok()`
- `server/lib/repairLogic.js` — `findBadPages()`, `decideRepairMethod()`, `selectCharRepairTasks()`
- `server/lib/scoring.js` — canonical score computation
- `server/lib/scaleRepair.js`, `server/lib/textSpaceRepair.js`, `server/lib/styleConsistency.js`
- `server/lib/entityConsistency.js` → `repairSinglePage()` + detection
- `server/routes/regeneration.js` — all endpoints above
- `client/src/hooks/useRepairWorkflow.ts` — manual workflow orchestration
- `client/src/components/generation/RepairWorkflowPanel.tsx` — UI panel
- `client/src/config/repairDefaults.ts` — client threshold mirror

---

## Text Overlay System

Story text is overlaid directly on page images, matching the printed book layout.
(See also `docs/text-overlay.html` for the richer write-up.)

**Pipeline:**
1. **Scene expansion** (Claude) picks `textPosition` per page (top-left, bottom-right, etc.)
   - Spread rule: odd pages = left side, even pages = right side
   - Claude writes the scene prose to keep the chosen area calm and light
2. **Image prompt** includes a COPY SPACE instruction telling the model to keep the area light
3. **Post-generation** text region detection (`server/lib/textRegion.js`):
   - Computes per-block brightness + variance → calmness heatmap
   - Builds a pixel-level alpha mask, constrains to correct spread side
   - Composites a white wash (45% opacity) directly into the stored image
   - Returns the detected rect for PDF text placement
4. **enforceSpreadTextPosition** corrects Claude's mistakes (flips left↔right for wrong side)
5. **PDF renderer** uses the detected rect coordinates for text placement, falls back to corners

**Key files:**
- `server/lib/textRegion.js` — calmness detection + white wash compositing
- `client/src/utils/textOverlay.ts` — frontend text overlay positioning (6-position cycle + explicit override)
- `server/lib/storyHelpers.js` → `buildImagePrompt()` — COPY SPACE instruction injection
- `server/lib/pdf.js` — PDF text rendering with detected rect support

**Frontend display:**
- StoryDisplay (editor): text overlay on by default, Eye icon toggle button
- SharedStoryViewer: text overlay on images + toggle, uses stored textPosition from API

---

## Referral / Promo Code System

Every user gets a unique referral code (format: `MagicRoger427`). When someone uses it at checkout:
- Buyer gets CHF 10 off the book price
- Referrer gets 350 story credits (= CHF 10 package value)

**Rules:** No self-referral. Each buyer can use ONE referral code, ever (`users.referred_by` column).

**Key files:**
- `server/lib/referral.js` — code generation (3-digit suffix, 900 slots/name)
- `server/routes/print.js` — `GET /api/referral/my-code`, `POST /api/referral/validate`, checkout discount logic
- `server.js` — webhook credits referrer (transactional, atomic `referred_by` lock)
- `server/config/credits.js` → `REFERRAL` config block
- `client/src/pages/AccountPage.tsx` — referral code display, copy button, stats
- `client/src/pages/BookBuilder.tsx` — promo code input + discount line in price summary

---

## Shared Story Viewer — Book Spread

Desktop: two-page book spread layout matching a real open book.
- Odd pages: `[Image LEFT | Text RIGHT]`
- Even pages: `[Text LEFT | Image RIGHT]`
- Page turn animation always flips the RIGHT panel (spine hinge)
- Text overlay on images with toggle button
- Mobile: single column (image top, text bottom), unchanged

**Key file:** `client/src/pages/SharedStoryViewer.tsx`

---

## Preset-Aligned Cutout Extract

Character repair cutout extraction picks dimensions that naturally match a Grok aspect preset.
No letterbox padding — extract more scene pixels instead of adding white bars.

**Algorithm:** `computePresetAlignedExtract()` in `server/lib/images.js`:
1. Start with bbox + 40% min padding
2. Pick closest of Grok's 13 aspect presets
3. Grow one axis to match the preset exactly
4. Center on bbox, clamp to scene bounds

---

## Entity Consistency Improvements

- Cascade face detection (Python anime + Haar) merged with Gemini bboxes
- Coordinates properly normalized from pixels to 0-1 `[ymin,xmin,ymax,xmax]`
- Fallback detection triggers on empty `figures: []` (not just null)
- Object name canonicalization to Visual Bible IDs
- Structured `interactions` metadata for evaluator checks

---

## Centralized Aspect Ratio

All image generation reads aspect from `MODEL_DEFAULTS.pageAspect` / `coverAspect` / `avatarAspect`
in `server/config/models.js`. No more hardcoded aspect in individual functions.
Default: 3:4 (A4 portrait) for pages and covers, 9:16 for avatars.

---

## Admin Trial Bypass

Admins can test the trial flow (`/try`) repeatedly. Fresh anonymous account each time.
Turnstile + fingerprint checks bypassed when valid admin JWT is provided.

**Key files:** `server/routes/trial.js` → `isAdminRequest()`, `client/src/pages/TrialWizard.tsx`

---

## Trial Flow — Prewarm + PATCH Sync

The trial character step prewarms `POST /api/trial/create-anonymous-account` in the background the moment the form becomes valid (name + gender + photo). The Next-button click awaits the prewarmed promise — usually instant by then. If the user edited any user-facing field (name / age / gender / traits / customTraits) after the prewarm fired, the click also fires `PATCH /api/trial/update-character-details` with the diff, so the latest values land on the character row before advancing. Server-owned fields (`physical` from Gemini, avatars) are never overwritten by the PATCH.

Other trial-flow plumbing:

- **Trait cache** in `server/routes/trial.js`: photo-hash keyed cache, TTL 10min. `generate-preview-avatar` writes; `create-anonymous-account` reads. Skips the duplicate ~5–7s `extractTraitsWithGemini` call.
- **Photo consent**: stamped at trial-account INSERT time (`photo_consent_at = CURRENT_TIMESTAMP`) — the wizard's 2 consent checkboxes count as the legal capture, the INSERT is the binding moment. Verified users (Google link, verify-email) keep the timestamp through trial→full conversion.
- **`set-password` guard**: refuses with `{ code: 'EMAIL_REQUIRED_FIRST' }` if the trial user's email still matches `anon_*@anonymous`. Prevents creating a "full account" with an unloginable email.
- **Trial completion email is deferred**: pipeline skips the Resend send when email matches `^anon_.+@anonymous$/i` (avoids `validation_error`). `server/lib/trialEmail.js → sendTrialCompletionEmailIfDeferred(userId)` is called from `verify-email` and `link-google` handlers; idempotent via `users.trial_completion_email_sent_at`.
- **Trial 2-pass empty scene**: when a real landmark is linked to a bg, the empty-scene render gets it as Slot 1 — bakes it into the plate. Page render then receives the plate as `sceneBackground` and `packReferences` correctly skips the standalone landmark slot. Wired in `server.js` trial-mode `onVisualBible` block.
- **Landmark proximity fallback**: `getIndexedLandmarks({city, latitude, longitude})` falls back to `getIndexedLandmarksNearLocation` at 20km → 50km → 100km when name match returns 0. Wabern → Bern works without per-city indexing.
- **Landmark name normalization**: `LANDMARK-LINK` strips parens/brackets/commas/dots before comparing — `Holzbrücke Baden` now matches the Wikidata-indexed `Holzbrücke (Baden)`.
- **Phantom age tiers**: `convertAvatarToStyle` MUST pass `age/gender/physical` through to the `adHocChar` it builds for `generateCharacter2x4Sheet` — otherwise `loadPhantom(undefined)` falls back to the generic adult phantom and proportions leak into kid characters.
- **One trial story per user — no environment exceptions, no merges, no email reclaim**: the cap (`stories_generated < 1`) in `/api/trial/create-job` is hard. Do NOT reintroduce a staging bypass, do NOT add an "if the email is already taken, merge into the existing account" path, do NOT strip emails from prior trial users to free up the address. To re-test the trial flow, create a fresh trial account with a fresh email each time. This is a product policy: the trial is the user's one free shot at the experience and the entire claim/conversion funnel is calibrated around scarcity. Any "convenience" workaround that lets the same person claim multiple times distorts conversion numbers, abuse-resistance tests, and the deferred-email helper's idempotency guard — all of which assume one trial = one user.
- **Avatar generation logs are per-cache-scope (NOT a global array)**: both `styledAvatarGenerationLog` (`server/lib/styledAvatars.js`) and `costumedAvatarGenerationLog` (`server/routes/avatars.js`) are `Map<scopeId, entries[]>` keyed by `runInCacheScope` AsyncLocalStorage. Trial pre-warm (`/api/trial/prepare-title`) and the trial story job BOTH run under `runInCacheScope('trial-${userId}', …)` so prepare-title entries flow into the job's dev-panel capture AND the avatar cache hits the pre-warmed sheets (perf win). Full mode uses `jobId` as scope (unique per job). `processStoryJob` clears both logs in its `finally` after the impl returns. **Do not** reintroduce a module-level `let X = []` for these logs — that was the 2026-01-03 bug that caused trial-story avatar bleed across users.
- **Trial character physical traits reach Claude**: `buildTrialStoryPrompt` (`server/lib/storyHelpers.js`) passes `character.physical` (`hairColor / eyeColor / skinTone / detailedHairAnalysis` — populated by `trial.js:737-745` after Gemini analyzes the uploaded photo) into the CHARACTERS section so scene prose can weave in real visual descriptors instead of bare action lines. Don't drop these when refactoring the prompt builder.
- **Invented secondaries get per-page descriptors**: `buildImagePrompt` injects a `**SECONDARY CHARACTERS IN THIS SCENE:**` block built from `visualBible.secondaryCharacters` filtered by `.pages[]`, even when `skipVisualBible: true` (the default for Grok). Without this, characters Claude invents (no uploaded photo, no VB grid presence) reach Grok as bare names and get reinvented every page. Filter by `.pages[]` is load-bearing — including the full cast on every page blows Grok's 7500-char effective limit.
- **Landmark photo variants reach Claude**: `storyIdeas.js` maps `photo_url_N + photo_description_N` from `landmark_index` into `photoVariants: [{n, description}]` on each landmark. The trial landmarks instruction (`storyHelpers.js → buildTrialStoryPrompt`) emits a `PHOTO ANGLES` block per landmark when ≥2 variants exist, plus an explicit `[LOC###.N]` syntax hint. Some landmarks have interior-shot variants — Claude picks them for "inside" scenes when prompted. Do NOT add specific landmark names as examples in the prompt — Claude pattern-matches the example and picks it deterministically on every story in that city.
- **Avatar eval base threshold raised 5→7**: `MIN_BASE_AVATAR_SCORE` in `server/routes/avatars.js:130` is now 7 (was 5), paired with a tightened `prompts/avatar-evaluation.txt` that explicitly scores `foreheadCheekJawline` and caps cross-style benefit-of-doubt. Expect ~30-40% more retry attempts on base clothing avatars — that's by design (the prior 5 was letting through avatars with visibly different face geometry). If retry rate is causing latency, tune down to 6 rather than 5.
- **Avatar eval inputs normalized via `bytesFromAnyImage`**: `evaluateAvatarFaceMatch` (`server/routes/avatars.js`) decodes both `originalPhoto` and `generatedAvatar` through `r2.bytesFromAnyImage()` before sending to Gemini. The old string `.replace(/^data:image\/\w+;base64,/, '')` path was a silent no-op for HTTPS R2 URLs (common post-R2 migration), causing the eval to fail in production and return null without logging. Don't revert.
- **Avatar eval uses dedicated `facePhoto` for face match**: all `evaluateAvatarFaceMatch` callsites prefer `facePhoto` (zoomed crop from the Python service) over `referencePhoto` (bg-removed body — face is ~5% of pixels). Falls back to `referencePhoto` only when no dedicated face crop was uploaded. When wiring a new callsite, follow the same `faceRef = facePhoto || referencePhoto` pattern.

---

## Test Models (Dev Mode)

Allows admins to compare image generation across multiple AI models side-by-side for the same
page/scene. Accessible via the "Test Models" button on each page in developer mode.

**How it works:**
1. User selects which image models to test (Grok Standard/Pro, Gemini Flash/Pro)
2. Clicks "Run Test" — all selected models generate the same scene in parallel
3. Results appear in a grid with timing and "Use This" buttons to adopt a result

**Iterative Placement** option (checkbox in TestModelsPanel): when enabled, uses a two-pass
generation strategy instead of single-pass. Pass 1 generates foreground characters only,
Pass 2 composites them onto the background scene. This improves character placement when
multiple characters appear at different depths (foreground vs background). Only activates
when the scene metadata contains background-depth characters.

**Style Transfer** (in TestModelsPanel): takes the current page image and re-renders it in
the story's art style using a different model. The original scene composition, characters,
and layout are preserved — only the visual rendering style changes. Useful for comparing
how different models interpret the same art style.

**Endpoints:**
- `POST /:id/test-models/:pageNum` — generate same scene with multiple models
- `POST /:id/style-transfer/:pageNum` — re-render current image in art style via different model

**Key files:**
- `client/src/components/generation/TestModelsPanel.tsx` — UI panel with model selection, results grid, style transfer
- `client/src/services/storyService.ts` → `testModels()`, `styleTransfer()` — API client methods
- `server/routes/regeneration.js` — backend endpoints
- `server/lib/images.js` → `generateImageOnly()`, `generateWithIterativePlacement()`, `applyStyleTransfer()`

**CLI script** (`scripts/test-models.js`): command-line tool for comparing scene expansion and
iteration prompts across text AI models (not image models). Tests how different LLMs expand
scene descriptions. Usage: `node scripts/test-models.js <story-id> <page-number> [expansion|iterate|both]`

---

## Image Model Comparison (Grok vs Gemini)

Also tracked in memory `project_image_model_tests.md` — check there before recommending a vendor.

**Gemini (primary generator):**
- Better prompt adherence — follows style/composition instructions more reliably
- More consistent across multiple generations (critical for 15-page stories)
- Handles structured illustration, watercolor, whimsical storybook styles well
- Better at conveying emotional narrative in character illustrations
- Better at complex scenes with crowds/many elements

**Grok Imagine (secondary — repair + concept art):**
- Best for: concept art, anime/Studio Ghibli, cinematic, photorealistic styles
- Weak for: flat illustration, watercolor, minimalist — adds unwanted 3D/polish
- 2-4x faster than Gemini, same price ($0.02/image standard)
- Character consistency across generations is weaker than Gemini
- Style consistency is weakest among major models — same prompt can look very different
- No negative prompt support — use positive phrasing only
- Aurora model is autoregressive — prompt ORDER matters (scene → style → lighting → camera)

**When to use Grok:** Character repair (blended mode $0.02), concept art style stories,
speed-critical operations. **When to use Gemini:** Primary story generation, watercolor/whimsical
styles, any scene requiring consistent style across multiple pages.

**The deciding factor — edit MAGNITUDE (verified avatar A/B, 2026-07-19):**
- **Gemini is much better at ART / big transformations** — style transfer, full re-render, "make this Pixar/watercolor", large structural change. In the avatar 2×4 A/B, Gemini-3-pro produced real Pixar 3D on the style-transfer pass while Grok barely stylized the same input. Route big transforms to Gemini.
- **Gemini is LAZY on tiny tweaks** — for a small/precise edit (nudge a hand, minor colour fix, small targeted repair) it often returns the input essentially unchanged. This is what "Gemini returns the source unchanged" actually means: it's magnitude-dependent, not universal. Don't send a small edit to Gemini expecting a change.
- **Grok reliably applies even small/precise edits** — so Grok (or Qwen for masked repair) is the right backend for targeted tweaks and repairs; Gemini for large stylize/transform passes.
- Consequence for avatars: the 2×4 pipeline runs BOTH passes on Grok; the realistic anchor (Round 1, identity-preserving) is correct on Grok, but the Pixar style transfer (Round 2, a BIG transform) is exactly where Grok underperforms and Gemini should be used. See `project_image_model_tests.md` → "Avatar 2×4 sheet — Grok vs Gemini per pass".

**Prompting tips for Grok Imagine:**
- Natural sentences, not tag lists ("a child running through a forest" not "child, forest, running")
- Specific artist/studio references improve results ("Studio Ghibli", "Craig Mullins")
- Add physical anchors ("feet on cobblestones") to prevent floating characters
- Avoid generic superlatives ("stunning", "ultra-detailed") — wasted tokens
- Keep prompts to 1-3 sentences + structured parameters (max ~1000 chars effective)
