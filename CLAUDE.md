# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important Rules

- **Do not automatically deploy.** Always ask before deploying.
- **Ask if unclear.** If there are different implementation options, ask rather than assuming.

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
