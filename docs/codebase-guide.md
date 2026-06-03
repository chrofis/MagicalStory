# Codebase Guide

Detailed reference for subsystems and features. This content was extracted from `CLAUDE.md`
to keep the always-loaded instructions file lean. Read the relevant section here before
touching the corresponding code path.

Top-level architecture, the AI provider table, the generation-pipeline summary, key-file
navigation, and the operational rules (push approval, timezone, log analysis) stay in
`CLAUDE.md`.

---

## Repair Workflow (Post-Generation)

After story generation, the user can run an automated repair workflow to improve image
quality and character consistency. Triggered from `RepairWorkflowPanel` → `runFullWorkflow()`.

**Scoring model** — one unified score drives all redo decisions:
```
finalScore = qualityScore - semanticPenalties - entityPenalties
```
- Quality eval (Gemini 2.5 Flash): produces qualityScore (0-100) and fixableIssues
- Semantic eval: compares image to scene description, penalties baked into score
- Entity penalties: from finalChecksReport.entity (critical -30, major -20, minor -10)
- Image check penalties: same scale as entity
- Quality eval issues are NOT double-penalized (already in qualityScore)

**Important**: Entity data exists from generation (the pipeline runs entity consistency
before the workflow starts). So entity penalties apply from Pass 1 onward.

```
Story completes → entity consistency already ran → finalChecksReport.entity saved
User clicks "Run Full Workflow"

1. COLLECT FEEDBACK
   Reads existing evaluation data from DB (populates UI; pass logic uses fresh API data)

═══ GLOBAL PASS LOOP (maxPasses = 3) ═══════════════════════════════════════════

  PASS 1:
  ├─ EVALUATE ALL pages (quality + semantic + entity penalties from generation)
  ├─ IDENTIFY BAD PAGES (score < 60 OR issues >= 5)
  ├─ If no bad pages → skip to final steps
  └─ REDO all bad pages (once each, generates new image version)

  PASS 2+:
  ├─ RUN ENTITY CONSISTENCY (fresh grid analysis against new images)
  ├─ EVALUATE ALL pages (quality + semantic + fresh entity penalties)
  ├─ IDENTIFY BAD PAGES (score < 60 OR issues >= 5)
  ├─ If no bad pages → skip to final steps
  └─ REDO all bad pages (once each)

═══ FINAL STEPS ═════════════════════════════════════════════════════════════════

  FINAL ENTITY CONSISTENCY (against latest images)
  FINAL EVALUATE ALL pages (with fresh entity data)
  CHARACTER REPAIR (up to 3 pages, critical severity first, Grok blended mode)
  PICK BEST VERSIONS (for each redone page, activate highest-scoring version)
```

**Thresholds** (in `server/config/models.js` → `REPAIR_DEFAULTS`):
- `scoreThreshold: 60` — pages scoring below 60/100 get redone
- `issueThreshold: 5` — pages with 5+ fixable issues get redone
- `maxPasses: 3` — max global passes through all pages
- `maxCharRepairPages: 20` — max pages for character repair per run

**Character repair methods** (in `server/lib/images.js` → `repairCharacterMismatchWithGrok()`):
- **Grok Cutout** (default): extract the figure's bbox + 20% padding → send cutout + avatar
  to Grok as an inpaint-style replacement → composite back with a feathered edge (~8% of the
  smaller dimension). Keeps background, other characters, and objects fully untouched.
- **Grok Blended**: blur the character region → Grok regenerates → feathered blend onto the
  original scene (30px feather, bbox + 50% padding). Good for face-only repairs but the blur
  radius can include too much surrounding context on larger bboxes.
- **Grok Blackout**: send full scene with blackout overlay → Grok regenerates entire scene

**When images are REDONE (full regeneration):**
- User clicks "Regenerate Image" button (manual)
- Repair workflow identifies bad pages (score < 60 or issues >= 5)
- Uses `POST /:id/iterate/:pageNum` — re-expands scene description, generates new image

**When images are FIXED (character repair only):**
- Character repair step in the workflow (final steps)
- Entity consistency found character appearance mismatches
- Uses Grok blended mode: only the character region changes, background preserved
- Cost: ~$0.02/image (vs full regeneration cost)

**Key design decisions:**
- Entity data exists from generation — penalties apply from Pass 1.
- On Pass 2+, entity consistency re-runs first (images changed), then one evaluation.
- No per-page retries — each pass redoes each bad page once. Versions accumulate.
- Character repair runs before pick-best so repair versions are also considered.
- Pick-best runs last, comparing ALL versions (original + redos + repairs) per page.
- Character repair budget: max 3 pages, critical > major priority.
- Grok blended is default when Grok is configured; falls back to Gemini otherwise.
- Abortable at every step via AbortController.

**Endpoints** (in `server/routes/regeneration.js`):
- `POST /:id/repair-workflow/re-evaluate` — quality + semantic eval, entity penalties
- `POST /:id/repair-workflow/consistency-check` — entity grid analysis
- `POST /:id/repair-workflow/pick-best-versions` — activate best version per page
- `POST /:id/repair-workflow/character-repair` — fix character appearance (Grok blended/cutout/blackout)
- Page redo uses existing `POST /:id/iterate/:pageNum` endpoint

**Key files:**
- `client/src/hooks/useRepairWorkflow.ts` — orchestrates the full workflow
- `client/src/components/generation/RepairWorkflowPanel.tsx` — UI panel
- `client/src/services/storyService.ts` — API client methods
- `server/routes/regeneration.js` — backend endpoints
- `server/lib/images.js` → `repairCharacterMismatchWithGrok()` — Grok character repair
- `server/lib/images.js` → `collectAllIssuesForPage()` — aggregates all issue sources

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

**Prompting tips for Grok Imagine:**
- Natural sentences, not tag lists ("a child running through a forest" not "child, forest, running")
- Specific artist/studio references improve results ("Studio Ghibli", "Craig Mullins")
- Add physical anchors ("feet on cobblestones") to prevent floating characters
- Avoid generic superlatives ("stunning", "ultra-detailed") — wasted tokens
- Keep prompts to 1-3 sentences + structured parameters (max ~1000 chars effective)
