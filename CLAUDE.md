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

### Key Backend Files
- `server.js` - Main Express app with all routes embedded
- `server/config/models.js` - AI model configuration and defaults
- `server/lib/images.js` - Image generation, quality eval, inpainting
- `server/lib/runware.js` - Runware API (FLUX, ACE++, inpainting)
- `server/lib/textModels.js` - Claude/Gemini text generation
- `server/lib/visualBible.js` - Character consistency tracking
- `server/routes/avatars.js` - Avatar generation endpoints
- `server/routes/stories.js` - Story CRUD and regeneration
- `prompts/` - All AI prompt templates (editable without code changes)

### Key Frontend Files
- `client/src/pages/StoryWizard.tsx` - Main story creation wizard
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
