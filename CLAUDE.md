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

- **Do not automatically deploy.** Always ask before deploying.
- **Ask if unclear.** If there are different implementation options, ask rather than assuming.
- **Unified mode is primary.** All new features and developer options must work in unified mode (the default story generation mode). Don't implement features only for legacy modes (pictureBook, outlineAndText) - unified mode is the mode the user wants to use.

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

# Deploy to Railway
git push origin master && railway redeploy --yes

# View Railway logs
railway logs
```

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
- **Frontend**: React 18 + Vite + TypeScript + Tailwind (`/client`)
- **Backend**: Express.js monolith (`server.js` + `/server`)
- **Database**: PostgreSQL on Railway
- **Hosting**: Railway (auto-deploys from `master`)

### AI Service Providers
| Service | Provider | Purpose |
|---------|----------|---------|
| Text Generation | Claude (Anthropic) | Story outline, text, scene descriptions |
| Image Generation | Gemini (Google) | Page illustrations, covers, avatars |
| Cheap Images | Runware | Dev mode, inpainting (SDXL $0.002/img) |
| Avatar Faces | Runware ACE++ | Face-consistent avatar generation |

### Story Generation Pipeline
```
POST /api/jobs/create-story → Background Job:
  1. Generate Outline (Claude)
  2. Extract Scene Hints
  3. Generate Story Text (Claude, batched)
  4. Generate Scene Descriptions (Claude, parallel)
  5. Generate Images (Gemini, parallel/sequential)
  6. Quality Evaluation + Auto-Repair (optional)
  7. Generate Covers (front, back, dedication)
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
- **Grok Blended** (default): blackout character bbox → Grok regenerates → feathered blend
  onto original scene (30px feather, bbox + 50% padding). Preserves background quality.
- **Grok Cutout**: extract character region with 20% padding → Grok repairs → composite back
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
- `server.js` - Main Express app with all routes embedded
- `server/config/models.js` - AI model configuration and defaults
- `server/lib/images.js` - Image generation, quality eval, inpainting
- `server/lib/runware.js` - Runware API (FLUX, ACE++, inpainting)
- `server/lib/textModels.js` - Claude/Gemini text generation
- `server/lib/visualBible.js` - Character consistency tracking
- `server/routes/avatars.js` - Avatar generation endpoints
- `server/routes/stories.js` - Story CRUD and regeneration
- `server/routes/regeneration.js` - Repair workflow + image regeneration endpoints
- `prompts/` - All AI prompt templates (editable without code changes)

### Key Frontend Files
- `client/src/pages/StoryWizard.tsx` - Main story creation wizard
- `client/src/hooks/useRepairWorkflow.ts` - Repair workflow orchestration hook
- `client/src/hooks/useDeveloperMode.ts` - Dev mode model overrides
- `client/src/types/character.ts` - Character type definitions
- `client/src/components/generation/` - Story generation UI components

## Model Configuration

Models are configured in `server/config/models.js`. Frontend can override via developer mode.

**Important model notes:**
- `gemini-2.5-flash` is required for quality evaluation (spatial reasoning for fix_targets)
- `gemini-2.0-flash` cannot return bounding boxes for auto-repair
- Runware has 3000 char prompt limit (vs 30000 for Gemini)
- ACE++ uses `referenceImages` at root level, not inside `acePlusPlus` object

## Prompt Templates

All prompts are in `/prompts/*.txt` and loaded via `server/services/prompts.js`:
- `avatar-main-prompt.txt` - Gemini avatar generation (4500+ chars)
- `avatar-ace-prompt.txt` - Runware ACE++ avatars (2900 char limit)
- `image-generation.txt` - Scene illustration prompts
- `image-evaluation.txt` - Quality evaluation criteria

## Database

PostgreSQL with tables: `users`, `characters`, `stories`, `story_jobs`, `orders`, `config`

Character data stored as JSONB in `characters.data` column containing:
- `characters[]` - Array of character objects
- `relationships` - Character relationship mappings
- Physical traits, clothing, avatars per character

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
