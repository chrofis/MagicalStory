# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Subsystem deep-dives live in `docs/codebase-guide.md`** (repair workflow, text overlay,
> referral, trial flow, test models, Grok-vs-Gemini comparison, etc.). Read the relevant
> section there before touching that code path. This file stays lean so it loads fast every session.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Memory Safety (16GB System)

This machine has only 16GB RAM. **NEVER run 3D mesh generation or large ML models locally** (TRELLIS,
TripoSG, Hunyuan3D, trimesh heavy ops) — they BSOD the system. Always use remote APIs (Tripo3D, HF
Spaces). Before launching any Python script, consider its memory footprint; cap it with
`resource.setrlimit` if a local run is unavoidable. (Full rule in `~/.claude/CLAUDE.md`.)

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

- **Confirm the issue is real before fixing anything — and never fix what wasn't asked.** Before touching code for a "problem" you noticed yourself, first verify it actually exists from stored evidence (DB rows, logs, a reproduction) and report it; the deliverable is the finding, not an unrequested fix. If a fix has meaningfully different options (scope, approach, which file), list them and stop — use `AskUserQuestion`, don't pick and ship.

- **Paid API calls need a mandate and a cap.** Every Grok/Gemini/Anthropic/Runware/OpenRouter call and every story generation costs real money. Rules:
  1. Paid calls are allowed only as part of a task the user actually assigned — never for a side-quest Claude invented.
  2. Within an assigned task, individual calls under ~CHF 0.50 are fine without asking; anything bigger (showcases, full story runs, batch experiments) needs explicit permission or a spend cap the user stated for THIS task.
  3. **Burn-loop hard stop:** if two paid attempts at the same thing fail, or you suspect the approach is off track, STOP — no third paid retry. Report what happened, list the options, and wait. Ten repeats of a 50-cent call while off track is exactly the failure mode this rule exists to prevent.
  4. A spend cap authorizes the task it was given for, nothing else. New idea → new ask.

- **NEVER push to `master` without explicit per-push approval — even for "safe" changes.** Every push to `master` auto-deploys to production. Each prod deploy (a) **kills any in-flight story generation** (real users mid-creation lose their work) AND (b) causes brief downtime. "Functionally safe", "additive", "backward-compatible", "trivial typo fix" are NOT valid reasons to skip the approval step — they all have the same downtime + in-flight-job cost. The mandatory flow for ANY change:
  1. `git push origin master:staging` (or push to your feature branch + PR-merge into staging)
  2. Verify on `https://staging.magicalstory.ch` — page loads, smoke test the affected area
  3. **Ask the user explicitly: "OK to push to master?"**
  4. Only after an explicit yes (not silence, not "looks good", not "ship it" from earlier in the conversation about a different change): `git push origin master`

  Even when the user said "push" earlier in the session for an unrelated commit, that authorization does NOT carry forward. Every prod push is its own approval moment. When in doubt, push staging only and wait.

- **Pushes are gated on the target environment being idle.** `.githooks/pre-push` asks
  `GET /api/health/busy` (staging for `staging`, production for `master`) and refuses the
  push while a story generation or Test Lab experiment is running — a deploy restarts the
  container and kills it. **Enabled automatically by `npm install`** (`prepare` →
  `scripts/admin/setup-git-hooks.js`); run that script directly if you skipped install.
  It sets `core.hooksPath` to an ABSOLUTE path deliberately — a relative one is resolved
  per working tree, so an agent worktree on a branch older than the hook has no
  `.githooks/pre-push`, and **git skips a missing hook silently**. That is exactly how a
  push killed a running Test Lab experiment on 2026-08-05.
  If it blocks you, **wait** — `--no-verify` is only for a run you are willing to destroy,
  and on `master` that means a real user's paid generation. Never disable the hook to get
  a push through. Check status any time with `node scripts/admin/check-push-idle.js`
  (`docs/decisions.md`, 2026-08-04 entry).
- **Ask if unclear.** If there are different implementation options, ask rather than assuming.
- **Interview the user with `AskUserQuestion` — never decide direction for them.** When the user surfaces a problem with multiple valid resolutions (different scopes, different trade-offs, different "which file to touch" choices, "revert vs adjust vs leave alone"), STOP and ask via `AskUserQuestion` with 2-4 framed options + their trade-offs. Do NOT pick the option you think makes sense and "just ship it" with a "let me know if you want differently" tail. Do NOT bury the choice in prose ("Want me to do X? Or Y?") — that loses framing, hides trade-offs, and ends up as a slow back-and-forth. Use the actual question tool with explicit options. Exception: the "default to the proper fix" rule above (clean root-cause vs hacky shortcut) — there you don't ask, you ship proper. Every other choice → interview.
- **Default to the proper fix — never offer "quick workaround vs proper" as a choice.** When a bug has a clean root-cause fix and a hacky shortcut, silently pick proper and ship it. Don't ask which one to do. Workarounds contaminate the codebase (rotation entries get permanently mangled to dodge a spec bug, code paths get one-off skips, etc.) and waste the user's time on a vote whose answer is always "proper". Only mention the shortcut if the proper fix isn't viable for a real reason (would take days, breaks a contract) — and then frame it as a constraint, not a choice.
- **Unified mode is primary.** All new features and developer options must work in unified mode (the default story generation mode). Don't implement features only for legacy modes (pictureBook, outlineAndText) - unified mode is the mode the user wants to use.
- **Action button styling MUST be identical across rows.** When adding or modifying any button in an action button row (e.g. the StoryDisplay top/bottom action bars: Buch erstellen, PDF herunterladen, Geschichte ansehen, Neue Geschichte), copy the EXACT className from a sibling button. Never invent new gradient/padding/text-size combos for "this one special CTA" — they all share the row, they all look the same. The standard for `StoryDisplay` action buttons is: `bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600` with icon `size={16}`. If you find yourself writing different styling for one button in a row, STOP — copy the sibling instead.
- **Prompts must stay generic — no story-specific examples.** When writing or editing anything in `prompts/*.txt` or prompt builders, never embed names, characters, settings, or plotlines from a specific test story (e.g. "Gessler's soldiers", "Manuel", "Altdorf square"). The prompts run on every story — a Wilhelm Tell reference leaks into an unrelated unicorn story. Use archetypal examples only: "the main character", "a guard", "N soldiers surrounding the hero", "a marketplace crowd". Same rule for bug-fix wording: don't write "Lukas sat on the right" into a rule; write "if a character's outline position is on the forbidden side". If you can read the prompt and tell which test story it came from, rewrite it.
- **Read `docs/SETTLED.md` before editing prompts, eval rules, model routing, or pipeline behavior — reversing a settled verdict has a protocol.** That file is the one-page index of decisions that historically flip-flopped (A → B → back to A). Reversing any line on it requires ALL of: (1) explicit user sign-off via `AskUserQuestion`, framed as a reversal; (2) evidence — a Test Lab experiment ID or ≥3 pages/stories showing the current rule failing (one motivating page is never enough); (3) a superseding `docs/decisions.md` entry citing that evidence; (4) updating the SETTLED.md line. String-detectable verdicts are enforced by `scripts/admin/check-settled.js` in the pre-push hook — if it blocks you, that's the flip-flop guard working, not an obstacle to route around.

- **Check memory before recommending vendors, models, or technologies.** Every time you're about to suggest a specific API, model, library, or external service as a solution, FIRST read the relevant memory files (especially `project_image_model_tests.md`, `project_lora_investigation.md`, `project_image_pipeline_ideas.md`). Past experiments have usually already been done — don't recommend something that's already been rejected. If you make a recommendation based on tested experience, log the verdict in the matching project memory so future sessions don't waste the user's time re-litigating it.
- **Read `docs/image-routing.md` before any image-gen ROUTING decision (which model, direct vs composite, which pass).** It's the single decision map: task → method/model → verdict → which Test Lab stage re-tests it. It exists so we stop re-deriving and flipping back and forth — link back to the Test Lab stage instead of re-scripting an experiment. **Update it after every experiment** (add the verdict + the stage that reproduces it). It routes to the deep sources below.
- **Read `docs/image-generation-methods.html` before touching any image-generation code path.** It's the inventory of every entry function (`editWithGrok`, `generateImageWithQualityRetry`, `repairCharacterMismatchWithGrok`, etc.), which provider each one dispatches to, the by-task lookup ("I'm working on X — which function do I call?"), the aspect-ratio behaviour quirks per provider (especially Grok edit's input-aspect coercion), and the rejected-approach log. Any new image-gen feature or refactor: read this first, and update it in the same PR.
- **Lab findings, decisions, and SETTLED are one system with directional flow.** The Lab's eval-findings registry holds raw measured findings (evidence); a `docs/decisions.md` entry born from a Lab run MUST cite its experiment/registry IDs; a registry finding that changes behavior gets a decisions.md entry (otherwise it's just data); the re-litigated ones get a SETTLED.md line. Measured facts live in the repo where agents can see them — never only in the registry or only in memory files.
- **Log decisions and verdicts — don't rely on human memory.** When a technology, vendor, parameter, or approach is tried and evaluated, write the verdict (✅ kept / ❌ rejected / 🟡 conditional) plus a one-line reason into a project memory file. The only place "we tried FLUX Dev and it's unusable" belongs is a memory file — not in someone's head or buried in a commit message.
- **Log every architectural decision in `docs/decisions.md`.** Not just tried-and-rejected tech — also deliberate design choices, mode-specific shortcuts ("trial skips X to be fast"), and "we omit Y because Z". If the answer to "why does the code do this" lives only in someone's head, a commit message, or a single inline comment, log it. Triggers that mean a decision needs an entry: writing `// we deliberately skip…` / `// by design…` / `// intentionally omit…` in code; choosing a different path for trial / dev / admin mode; disabling a feature for speed or cost; setting a non-obvious threshold; suppressing a downstream warning. Each entry: **Context / Decision / Rationale / Touched files**. **Read `docs/decisions.md` before diagnosing any warning** — a warning about something "missing" may be a logging bug because the thing is missing on purpose.
- **Never assume — check.** When diagnosing a pipeline bug, always pull the actual stored data (DB row, log line, cached image, prompt sent to the model) before proposing a fix. Do not speculate about what "probably" happened at a prior stage. The evidence is always retrievable: scene metadata in `story_images` / `stories.data`, consolidator audit records, retry history, Railway logs. If you catch yourself writing "probably" or "must have" about pipeline state, stop and query the source.

## Showcase command

When the user says **"run a new showcase story"** (or any short variant: "run a showcase", "showcase the Bergers", "showcase entry 7"):

1. The command is the orchestrator at `scripts/admin/showcase.js` (`npm run showcase`).
2. It picks a rotation entry (default = next from `tests/demo-rotation-state.json`; override via `--entry=N`), creates a **fresh timestamped account** (`demo-{family}-{YYYYMMDD-HHmm}@magicalstory.ch`), uploads characters + the curated photos from `tests/fixtures/demo-photos/{family}/`, and triggers the Playwright spec → server starts story generation.
3. Each run is fully isolated. Old stories stay accessible on their original accounts.
4. If the user says "for the Bergers" / "with Miller" / "in French", look up the matching rotation index in `tests/helpers/demo-rotation.json` and pass `--entry=N`.
5. If photos for the family don't exist yet on disk, run `node scripts/admin/generate-demo-photos.js --family=<id> --save-to=true --no-upload` first, let the user inspect, then proceed.
6. Default backend is **production**. For local: `npm run showcase:local`. Always confirm environment with the user before launching.

Rotation config: `tests/helpers/demo-rotation.json`; state: `tests/demo-rotation-state.json`; orchestrator source is the doc (`scripts/admin/showcase.js`).

**A showcase is the LAST resort for validation, not the first.** For validating a change, use the running-validation-stories skill's ladder: stored evidence → single-page rerun → cheap 4-page run on the existing smoke account (`demo-b-hnecf@magicalstory.ch`, no character recreation) → full-story rerun on that same account (identical wizard start point; vary one knob like art style or location) → full showcase only after long/structural changes or character-pipeline changes.

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
3. Report results (all tests should pass)
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
| Avatar Faces | Grok Imagine (xAI) | Clothing + costumed avatars: both passes (identity sheet + style transfer) default to Grok (env `AVATAR_STYLE_BACKEND`). Gemini is NOT used by default (refuses realistic adult faces). Full history + rationale: `docs/decisions.md` → "Avatar style transfer (pass-2) uses Grok, not Gemini" and the avatar-guarantee entry. |
| Face Detection | Python service (MediaPipe/Haar) | Cascade face detection for illustrations |

### Story Generation Pipeline (Unified Mode)
`PIPELINE_MODE=beats` (staging) is the intended target pipeline — it decides which story prompt file is live; treat it as deliberate, not an open defect.

```
POST /api/jobs/create-story → Background Job:
  1. Generate full story: writer call (outline + visual bible + text + scene hints; arc→scenes→text order) + separate review call (analysis + fixes; SPLIT_OUTLINE_REVIEW gate; reviewer model set in server/config/models.js — currently DeepSeek V4 Pro, was Opus)
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

### Subsystem deep-dives → `docs/codebase-guide.md`

These detailed sections were moved out of CLAUDE.md to keep it lean. Read the matching one
before touching that code:

- **Repair Workflow (Post-Generation)** — scoring model, pass loop, repair methods, endpoints, key files
- **Text Overlay System** — calmness detection, white wash, spread rules (also `docs/text-overlay.html`)
- **Referral / Promo Code System** — codes, discounts, credits, key files
- **Shared Story Viewer — Book Spread** — desktop two-page layout
- **Preset-Aligned Cutout Extract** — `computePresetAlignedExtract()` algorithm
- **Entity Consistency Improvements** — cascade face merge, coordinate normalization
- **Centralized Aspect Ratio** — `MODEL_DEFAULTS.pageAspect` / `coverAspect` / `avatarAspect`
- **Admin Trial Bypass** — repeated `/try` testing for admins
- **Trial Flow — Prewarm + PATCH Sync** — prewarm, trait cache, consent, deferred email, the one-trial-per-user hard cap, per-cache-scope avatar logs, avatar eval thresholds, and other trial plumbing
- **Test Models (Dev Mode)** — side-by-side model comparison, iterative placement, style transfer
- **Image Model Comparison (Grok vs Gemini)** — strengths, when-to-use, Grok prompting tips

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
Grok-vs-Gemini strengths and prompting tips → `docs/codebase-guide.md`.

**Important model notes:**
- `gemini-2.5-flash` is required for quality evaluation (spatial reasoning for fix_targets)
- `gemini-2.0-flash` cannot return bounding boxes for auto-repair
- Runware has 3000 char prompt limit (vs 30000 for Gemini)
- ACE++ uses `referenceImages` at root level, not inside `acePlusPlus` object

## Prompt Templates

All prompts are in `/prompts/*.txt` and loaded via `server/services/prompts.js`.
**Full inventory of all ~72 templates (consumer + stage + hardcoded JS prompts) → `docs/prompt-inventory.md`** — keep it updated when adding/renaming a template. Most-touched ones:
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

**Note**: `image-generation.txt` is the single image-prompt template. Legacy `image-generation-storybook.txt` was merged into it, and the per-language (`-de`, `-fr`) plus `-sequential` variants were deleted along with the `isStorybook` / `isSequential` flags on `buildImagePrompt()` — unified mode is the only generation pipeline.

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

## Admin API auth (for scripts, agents, Test Lab, smoke stories)

Any script or agent that needs an admin Bearer token — Test Lab runs, `/api/admin/*`, 4-page smoke/validation stories — gets it ONE way:

```bash
TOKEN=$(node scripts/admin/get-admin-token.js)                    # staging (default)
TOKEN=$(node scripts/admin/get-admin-token.js --base=https://magicalstory.ch)  # prod
curl -H "Authorization: Bearer $TOKEN" https://staging.magicalstory.ch/api/admin/...
```

It logs in as the admin smoke-test account (`demo-b-hnecf@magicalstory.ch`; overrides via `TESTLAB_USER`/`TESTLAB_PASSWORD` env). Two facts agents keep getting wrong: (1) the staging Basic-auth gate (`STAGING_AUTH_USER/PASSWORD` in `.env`) protects HTML/static ONLY — `/api/*` needs just the Bearer token; (2) don't hand-roll a login flow or hunt for credentials — the helper is the canonical path. Runners that already embed this flow: `scripts/admin/run-testlab-set.js`, `scripts/test-scene-composite-smoke.js`.

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

### Timezone — Swiss local ONLY, via `scripts/lib/chTime.js` (settled 2026-08-09)

**Every timestamp shown to the user — in scripts and in replies — is Swiss local time, marked `CH`. UTC is never shown, and no timezone arithmetic is ever done by hand.** Format via the helper: `ch(d)` → `2026-07-30 22:01:15 CH`, `chTime(d)` → `22:01:15 CH`. `Intl`/`Europe/Zurich` handles DST. (This supersedes the May-2026 UTC-only rule, which superseded dual-labeling — see docs/SETTLED.md; a third reversal needs the full protocol.)

Three timestamp behaviors exist; pick the right entry point:
- **Railway logs / ISO strings with Z**: true UTC → `ch()` directly.
- **Naive Postgres `TIMESTAMP` columns via node-pg**: the driver parses the stored-UTC wall clock as LOCAL — rehome with `fromPgNaive(d)` FIRST, then format (skipping this double-shifts; the trap once killed two live Test Lab runs via client-side age math — or compute ages in SQL).
- **Browser-rendered admin pages**: already local; leave alone.

When searching logs for a time the user named, convert silently in code (Swiss → UTC) — never narrate the conversion, never show the UTC value in the reply.
