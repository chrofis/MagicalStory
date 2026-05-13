# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Memory Safety (16GB System)

- **NEVER run 3D mesh generation scripts locally** (TRELLIS, TripoSG, Hunyuan3D, trimesh heavy ops). This system only has 16GB RAM and will BSOD.
- **Always use remote APIs** for 3D work: Tripo3D API, Hugging Face Spaces (ZeroGPU).
- **Before launching any Python script**, consider its memory footprint. If it loads large ML models or processes 3D meshes, it MUST run remotely.
- **Max local Python memory**: If a local Python script is necessary, limit it with `resource.setrlimit` or launch with a memory cap.

## Working Principles

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy (keep main context window clean)
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests -> then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Important Rules

- **NEVER push to `master` without explicit per-push approval — even for "safe" changes.** Every push to `master` auto-deploys to production. Each prod deploy (a) **kills any in-flight story generation** (real users mid-creation lose their work) AND (b) causes brief downtime. "Functionally safe", "additive", "backward-compatible", "trivial typo fix" are NOT valid reasons to skip the approval step — they all have the same downtime + in-flight-job cost. The mandatory flow for ANY change:
  1. `git push origin master:staging` (or push to your feature branch + PR-merge into staging)
  2. Verify on `https://staging.magicalstory.ch` — page loads, smoke test the affected area
  3. **Ask the user explicitly: "OK to push to master?"**
  4. Only after an explicit yes (not silence, not "looks good", not "ship it" from earlier in the conversation about a different change): `git push origin master`

  Even when the user said "push" earlier in the session for an unrelated commit, that authorization does NOT carry forward. Every prod push is its own approval moment. When in doubt, push staging only and wait.

- **Do not automatically deploy.** Always ask before deploying.
- **Ask if unclear.** If there are different implementation options, ask rather than assuming.
- **Default to the proper fix — never offer "quick workaround vs proper" as a choice.** When a bug has a clean root-cause fix and a hacky shortcut, silently pick proper and ship it. Don't ask which one to do. Workarounds contaminate the codebase (rotation entries get permanently mangled to dodge a spec bug, code paths get one-off skips, etc.) and waste the user's time on a vote whose answer is always "proper". Only mention the shortcut if the proper fix isn't viable for a real reason (would take days, breaks a contract) — and then frame it as a constraint, not a choice.
- **Unified mode is primary.** All new features and developer options must work in unified mode (the default story generation mode). Don't implement features only for legacy modes (pictureBook, outlineAndText) - unified mode is the mode the user wants to use.
- **Action button styling MUST be identical across rows.** When adding or modifying any button in an action button row (e.g. the StoryDisplay top/bottom action bars: Buch erstellen, PDF herunterladen, Geschichte ansehen, Neue Geschichte), copy the EXACT className from a sibling button. Never invent new gradient/padding/text-size combos for "this one special CTA" — they all share the row, they all look the same. The standard for `StoryDisplay` action buttons is: `bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600` with icon `size={16}`. If you find yourself writing different styling for one button in a row, STOP — copy the sibling instead.
- **Prompts must stay generic — no story-specific examples.** When writing or editing anything in `prompts/*.txt` or prompt builders, never embed names, characters, settings, or plotlines from a specific test story (e.g. "Gessler's soldiers", "Manuel", "Altdorf square"). The prompts run on every story — a Wilhelm Tell reference leaks into an unrelated unicorn story. Use archetypal examples only: "the main character", "a guard", "N soldiers surrounding the hero", "a marketplace crowd". Same rule for bug-fix wording: don't write "Lukas sat on the right" into a rule; write "if a character's outline position is on the forbidden side". If you can read the prompt and tell which test story it came from, rewrite it.
- **Check memory before recommending vendors, models, or technologies.** Every time you're about to suggest a specific API, model, library, or external service as a solution, FIRST read the relevant memory files (especially `project_image_model_tests.md`, `project_lora_investigation.md`, `project_image_pipeline_ideas.md`). Past experiments have usually already been done — don't recommend something that's already been rejected. If you make a recommendation based on tested experience, log the verdict in the matching project memory so future sessions don't waste the user's time re-litigating it.
- **Log decisions and verdicts — don't rely on human memory.** When a technology, vendor, parameter, or approach is tried and evaluated, write the verdict (✅ kept / ❌ rejected / 🟡 conditional) plus a one-line reason into a project memory file. The only place "we tried FLUX Dev and it's unusable" belongs is a memory file — not in someone's head or buried in a commit message.
- **Never assume — check.** When diagnosing a pipeline bug, always pull the actual stored data (DB row, log line, cached image, prompt sent to the model) before proposing a fix. Do not speculate about what "probably" happened at a prior stage. The evidence is always retrievable: scene metadata in `story_images` / `stories.data`, consolidator audit records, retry history, Railway logs. If you catch yourself writing "probably" or "must have" about pipeline state, stop and query the source.

## Showcase command

When the user says **"run a new showcase story"** (or any short variant: "run a showcase", "showcase the Bergers", "showcase entry 7"):

1. The command is the orchestrator at `scripts/admin/showcase.js` (`npm run showcase`).
2. It picks a rotation entry (default = next from `tests/demo-rotation-state.json`; override via `--entry=N`), creates a **fresh timestamped account** (`demo-{family}-{YYYYMMDD-HHmm}@magicalstory.ch`), uploads characters + the curated photos from `tests/fixtures/demo-photos/{family}/`, and triggers the Playwright spec → server starts story generation.
3. Each run is fully isolated. Old stories stay accessible on their original accounts.
4. If the user says "for the Bergers" / "with Miller" / "in French", look up the matching rotation index in `tests/helpers/demo-rotation.json` and pass `--entry=N`.
5. If photos for the family don't exist yet on disk, run `node scripts/admin/generate-demo-photos.js --family=<id> --save-to=true --no-upload` first, let the user inspect, then proceed.
6. Default backend is **production**. For local: `npm run showcase:local`. Always confirm environment with the user before launching.

Full doc: `docs/demo-stories.md`.

## Folder Organization Rules

**Do NOT create files in the project root** unless they are core config files. Use the organized folder structure:

| Content Type | Location | Examples |
|--------------|----------|----------|
| Admin/utility scripts | `scripts/admin/` | check-users.js, setup-admin.js |
| Analysis scripts | `scripts/analysis/` | compare-faces.js |
| Other scripts | `scripts/` | download-photos.js |
| Manual test scripts | `tests/manual/` | test-*.js, test_*.py |
| E2E tests | `tests/e2e/` | Playwright tests |
| Test fixtures/images | `tests/fixtures/` | (gitignored) |
| Documentation | `docs/` | *.md files (except README.md, CLAUDE.md) |
| AI prompts | `prompts/` | *.txt prompt templates |

**NEVER commit to git:**
- Test output images (test-*.png, test-*.jpg)
- Temp files (tmpclaude-*, temp_photos/)
- Large data files (*.tflite, baden-landmarks/)

**Core files that stay in root:** server.js, email.js, photo_analyzer.py, package.json, README.md, CLAUDE.md

## Build & Development Commands

```bash
# Install all dependencies
npm install && cd client && npm install && cd ..
pip install -r requirements.txt   # Python dependencies for photo processing

# Development (THREE terminals for full local setup)
npm run dev            # Terminal 1: Backend on :3000
npm run dev:client     # Terminal 2: Frontend on :5173
npm run dev:python     # Terminal 3: Python photo analyzer on :5000

# Build frontend for production
cd client && npm run build     # Outputs to /dist

# Deploy to staging (auto-deploys from `staging` branch)
git push origin staging

# Deploy to production (auto-deploys from `master` branch)
# Standard flow: merge staging → master, push.
git checkout master && git merge staging && git push origin master

# View Railway logs (current environment, set via `railway environment`)
railway logs
```

**Branch / deploy flow:**
- `feature/X` → PR → `staging` → smoke-test on staging.magicalstory.ch → `master` (prod).
- Hotfixes can push direct to `master` but should be the exception.
- See `docs/staging-setup.md` for one-time staging environment provisioning.

### Python Photo Analyzer Service

The `photo_analyzer.py` Flask service handles:
- Face detection (MediaPipe/MTCNN)
- Background removal (rembg/U2-Net)

**Must be running on port 5000 for photo upload to work locally.**

## Testing Commands

```bash
# Run E2E tests against localhost (start dev servers first!)
npm run test:local

# Run E2E tests against production
npm run test:prod

# Run tests with visible browser (for debugging)
npm run test:headed

# Run all test files
npm run test:all
```

### Pre-deployment Testing Workflow

When user says **"run tests"** or **"test before deploy"**:

1. Start local servers in background
2. Run `npm run test:local`
3. Report results (10 tests should pass)
4. If all pass, ask if user wants to deploy

Tests check: homepage images, character photos, API health, auth, no JS errors, no 404s, wizard navigation.

## Architecture Overview

### Full-Stack Structure
- **Frontend**: React 19 + Vite + TypeScript + Tailwind (`/client`)
- **Backend**: Express.js monolith (`server.js` + `/server`)
- **Database**: PostgreSQL on Railway
- **Hosting**: Railway (auto-deploys from `master`)
- **SSR**: Pre-rendered static HTML for all SEO routes (~999 files, build-time)
- **Python**: Flask service for face detection + background removal (port 5000)

### AI Service Providers
| Service | Provider | Purpose |
|---------|----------|---------|
| Text Generation | Claude (Anthropic) | Story outline, text, scene descriptions |
| Image Generation | Gemini (Google) + Grok (xAI) | Page illustrations, covers, avatars |
| Character Repair | Grok Imagine (xAI) | Cutout + blended character repair ($0.02/img) |
| Cheap Images | Runware | Dev mode, inpainting (SDXL $0.002/img) |
| Avatar Faces | Grok Imagine (xAI) | Clothing avatars (winter/standard/summer) via edit endpoint with face-photo reference. Switched from Gemini after IMAGE_OTHER safety refusals on adult-face photos left avatars stuck pending. Costumed/styled avatars (mid-story costume changes) still use Gemini — they need a 2x2 grid Grok can't produce. |
| Face Detection | Python service (MediaPipe/Haar) | Cascade face detection for illustrations |

### Story Generation Pipeline (Unified Mode)
```
POST /api/jobs/create-story → Background Job:
  1. Generate full story in ONE Claude call (outline + visual bible + text + scene hints)
  2. Parse scenes, expand each into Art Director prose (scene-expansion.txt)
     → Each scene gets: character descriptions, interactions, textPosition, emptyScenePrompt
  3. Generate empty scene backgrounds (style anchors for iterative placement)
  4. Generate page images (Grok/Gemini, parallel) with VB grid references
  5. Text region detection + white wash (calmness map → lighten calm area for text)
  6. Quality eval + semantic eval + entity consistency (parallel)
  7. Auto-repair: redo low-scoring pages (up to 3 passes)
  8. Character repair: cutout/blended fix for mismatched characters (Grok)
  9. Pick best versions per page
  10. Generate covers (front, initial/dedication, back)
  → GET /api/jobs/:id/status (polling)
```

### Repair Workflow (Post-Generation)

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
- `maxCharRepairPages: 3` — max pages for character repair per run

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

### Text Overlay System (April 2026)

Story text is overlaid directly on page images, matching the printed book layout.

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

### Referral / Promo Code System (April 2026)

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

### Shared Story Viewer — Book Spread (April 2026)

Desktop: two-page book spread layout matching a real open book.
- Odd pages: `[Image LEFT | Text RIGHT]`
- Even pages: `[Text LEFT | Image RIGHT]`
- Page turn animation always flips the RIGHT panel (spine hinge)
- Text overlay on images with toggle button
- Mobile: single column (image top, text bottom), unchanged

**Key file:** `client/src/pages/SharedStoryViewer.tsx`

### Preset-Aligned Cutout Extract (April 2026)

Character repair cutout extraction now picks dimensions that naturally match a Grok aspect preset.
No letterbox padding — extract more scene pixels instead of adding white bars.

**Algorithm:** `computePresetAlignedExtract()` in `server/lib/images.js`:
1. Start with bbox + 40% min padding
2. Pick closest of Grok's 13 aspect presets
3. Grow one axis to match the preset exactly
4. Center on bbox, clamp to scene bounds

### Entity Consistency Improvements (April 2026)

- Cascade face detection (Python anime + Haar) merged with Gemini bboxes
- Coordinates properly normalized from pixels to 0-1 `[ymin,xmin,ymax,xmax]`
- Fallback detection triggers on empty `figures: []` (not just null)
- Object name canonicalization to Visual Bible IDs
- Structured `interactions` metadata for evaluator checks

### Centralized Aspect Ratio (April 2026)

All image generation reads aspect from `MODEL_DEFAULTS.pageAspect` / `coverAspect` / `avatarAspect`
in `server/config/models.js`. No more hardcoded aspect in individual functions.
Default: 3:4 (A4 portrait) for pages and covers, 9:16 for avatars.

### Admin Trial Bypass (April 2026)

Admins can test the trial flow (`/try`) repeatedly. Fresh anonymous account each time.
Turnstile + fingerprint checks bypassed when valid admin JWT is provided.

**Key files:** `server/routes/trial.js` → `isAdminRequest()`, `client/src/pages/TrialWizard.tsx`

### Test Models (Dev Mode)

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

### Key Backend Files
- `server.js` - Main Express app, unified pipeline, Stripe webhook
- `server/config/models.js` - AI model configuration, aspect ratios, repair defaults
- `server/config/credits.js` - Credit costs, packages, referral config
- `server/lib/images.js` - Image generation, quality eval, cutout repair, VB grid
- `server/lib/textRegion.js` - Text region detection + white wash compositing
- `server/lib/entityConsistency.js` - Entity consistency, cascade face merge, object canonicalization
- `server/lib/referral.js` - Referral code generation
- `server/lib/storyHelpers.js` - Scene metadata extraction, image prompt building, text area instruction
- `server/lib/runware.js` - Runware API (FLUX, ACE++, inpainting)
- `server/lib/textModels.js` - Claude/Gemini text generation
- `server/lib/visualBible.js` - Visual Bible entity tracking
- `server/lib/grok.js` - Grok Imagine API (edit, generate, pack references)
- `server/lib/pdf.js` - PDF generation (A4/square, text overlay, print-ready)
- `server/lib/coverIterate.js` - Cover generation and iteration
- `server/routes/avatars.js` - Avatar generation endpoints
- `server/routes/stories.js` - Story CRUD and regeneration
- `server/routes/regeneration.js` - Repair workflow + image regeneration endpoints
- `server/routes/print.js` - Stripe checkout, referral endpoints, pricing, Gelato orders
- `server/routes/trial.js` - Trial story flow, admin bypass
- `server/routes/sharing.js` - Share tokens, public viewer API
- `server/services/prompts.js` - Prompt template loader
- `prompts/` - All AI prompt templates (editable without code changes)

### Key Frontend Files
- `client/src/pages/StoryWizard.tsx` - Main story creation wizard
- `client/src/pages/TrialWizard.tsx` - Trial story wizard (anonymous users)
- `client/src/pages/SharedStoryViewer.tsx` - Public story viewer (book spread)
- `client/src/pages/AccountPage.tsx` - Account info, referral code, credits
- `client/src/pages/BookBuilder.tsx` - Book checkout with promo code input
- `client/src/hooks/useRepairWorkflow.ts` - Repair workflow orchestration hook
- `client/src/hooks/useDeveloperMode.ts` - Dev mode model overrides
- `client/src/utils/textOverlay.ts` - Text overlay positioning (6 positions + explicit override)
- `client/src/types/story.ts` - Story/SceneImage types (includes textPosition, textRect)
- `client/src/types/character.ts` - Character type definitions
- `client/src/components/generation/StoryDisplay.tsx` - Story display with text overlay toggle
- `client/src/components/generation/` - Story generation UI components
- `client/src/components/common/UserMenu.tsx` - Nav dropdown (includes My Account link)

## Model Configuration

Models are configured in `server/config/models.js`. Frontend can override via developer mode.

**Important model notes:**
- `gemini-2.5-flash` is required for quality evaluation (spatial reasoning for fix_targets)
- `gemini-2.0-flash` cannot return bounding boxes for auto-repair
- Runware has 3000 char prompt limit (vs 30000 for Gemini)
- ACE++ uses `referenceImages` at root level, not inside `acePlusPlus` object

### Image Model Comparison (Grok vs Gemini)

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

## Prompt Templates

All prompts are in `/prompts/*.txt` and loaded via `server/services/prompts.js`:
- `scene-expansion.txt` - Art Director: expands outline hints into illustration briefs (includes interactions, textPosition, emptyScenePrompt)
- `image-generation.txt` - Scene illustration prompt (unified template, includes COPY SPACE instruction)
- `image-evaluation.txt` - Quality evaluation criteria (includes declared interactions check)
- `image-semantic.txt` - Semantic fidelity evaluation (includes interactions placement check)
- `empty-scene.txt` - Background-only scene generation (for iterative placement)
- `avatar-main-prompt.txt` - Gemini avatar generation
- `avatar-ace-prompt.txt` - Runware ACE++ avatars
- `character-repair-cutout.txt` - Grok cutout repair prompt
- `character-repair-blended.txt` - Grok blended repair prompt
- `bbox-refine.txt` - Bounding box refinement (2-pass detection)
- `front-cover.txt`, `back-cover.txt`, `initial-page-*.txt` - Cover generation

**Note**: `image-generation-storybook.txt` was merged into `image-generation.txt`. The `imageGenerationStorybook` template key is aliased to `imageGeneration` in prompts.js.

## Database

PostgreSQL with tables: `users`, `characters`, `stories`, `story_jobs`, `orders`, `config`, `credit_transactions`, `referral_events`, `activity_log`, `pricing_tiers`, `gelato_products`, `story_images`

**Key columns (recent additions):**
- `users.referral_code` (VARCHAR 20 UNIQUE) - personal promo code (MagicName123 format)
- `users.referred_by` (VARCHAR 20) - which code this user used (permanent, one per user ever)
- `orders.referral_code_used`, `orders.discount_cents` - referral tracking on orders
- `referral_events` table - referrer/buyer/session/credits log with unique constraint
- `story_images` table - versioned image storage (pageNumber, version_index, image_data)

**Story data** stored as JSONB in `stories.data`:
- `sceneImages[]` — per-page: imageData, textPosition, textRect, sceneDescription, bboxDetection, retryHistory, imageVersions
- `coverImages` — frontCover, initialPage, backCover (each with imageData, versions)
- `characters[]`, `relationships`, physical traits, clothing, avatars

Character data stored as JSONB in `characters.data` column.

## Log Analysis

When user asks to **"analyze log"**, **"check the log"**, **"analyze story run"**, or similar:

```bash
node scripts/analyze-story-log.js                           # Latest log in ~/Downloads
node scripts/analyze-story-log.js ~/Downloads/logs.XXX.log  # Specific log file
```

The script analyzes Railway logs and shows:
- **Story info**: title, language, characters, pages
- **Timing**: total duration, per-stage timing
- **Costs**: breakdown by provider (Anthropic, Gemini) and function
- **Issues**: errors (especially TEXT CHECK, CONSISTENCY failures), warnings, fallbacks, low quality scores

Log files are downloaded from Railway and stored in `~/Downloads/logs.*.log`

### Timezone — Railway logs are UTC, user lives in Switzerland (CEST / CET)

**Every timestamp in Railway logs, Railway dashboards, and the Postgres DB is UTC.** The user talks in Swiss local time. Always translate before comparing:

- **Summer (CEST, last Sunday of March → last Sunday of October)**: local = UTC + 2h
- **Winter (CET, rest of the year)**: local = UTC + 1h

Examples for unambiguity:
- User says "around 01:40" in summer → look for events near **23:40 UTC the previous day**.
- Log says `2026-04-19T06:39 UTC` in summer → that's **08:39 CEST** in the user's day.
- User says "yesterday evening 21:00" in winter → look at **20:00 UTC** in the log.

When reporting log findings back to the user, convert UTC → local time or quote both, so there's no confusion. "23:50 UTC (01:50 CEST)" is fine; quoting UTC alone invites a miscount.
