# MagicalStory - Story Generation Pipeline Analysis

## Current Architecture Overview

### Complete Pipeline Flow
```
User Input (Frontend)
    │
    ▼
POST /api/jobs/create-story
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  BACKGROUND JOB (processStoryJob)                           │
│                                                             │
│  Step 1: Generate Outline (5%)                              │
│      └─► Claude API → outline (in memory)                   │
│                                                             │
│  Step 2: Extract Scene Hints (internal)                     │
│      └─► Parse outline → shortSceneDescriptions (in memory) │
│                                                             │
│  Step 3: Generate Story Text (10-40%)                       │
│      └─► Claude API batches → fullStoryText (in memory)     │
│                                                             │
│  Step 4: Generate Scene Descriptions (parallel)             │
│      └─► Claude API per page → allSceneDescriptions[]       │
│                                                             │
│  Step 5: Generate Images (10-90%, parallel, max 5)          │
│      ├─► Gemini API per page → raw image                    │
│      ├─► Compress to JPEG                                   │
│      └─► Claude API: evaluateImageQuality() → score 0-100   │
│                                                             │
│  Step 6: Generate Covers (95%)                              │
│      └─► Gemini API × 3 → coverImages{}                     │
│                                                             │
│  Step 7: Save Final Result (100%)                           │
│      └─► UPDATE story_jobs SET result_data = {...}          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
GET /api/jobs/:jobId/status (polling)
    │
    ▼
Frontend receives resultData → saves to /api/stories
```

---

## Current State: What's on Browser vs Server

### Browser-Side Operations (index.html)

| Operation | Location | Status |
|-----------|----------|--------|
| `runAutoMode()` | line 4034 | Entry point - delegates to server |
| `runAutoModeBackground()` | line 3064 | Creates job, polls status |
| `runAutoModeClientSide()` | line 3256 | **LEGACY** - client-side fallback |
| Job polling | line 3146 | 10-second interval |
| Story saving | line 3226 | POST to /api/stories after completion |
| Manual regeneration buttons | various | **Still client-side** |

### Server-Side Operations (server.js)

| Operation | Function | Progress |
|-----------|----------|----------|
| Create job | POST /api/jobs/create-story | 0% |
| Generate outline | callClaudeAPI(outlinePrompt) | 5% |
| Generate story batches | callClaudeAPI(batchPrompt) | 10-40% |
| Generate scene descriptions | callClaudeAPI(scenePrompt) | 10-90% |
| Generate images | callGeminiAPIForImage() | 10-90% |
| **Evaluate image quality** | evaluateImageQuality() via Claude | 10-90% |
| Generate covers | callGeminiAPIForImage() × 3 | 95% |
| Save results | UPDATE story_jobs | 100% |

---

## Gap Analysis: Missing Intermediate Access

### Data NOT Accessible During Pipeline

| Step | Data Generated | Accessible? | Problem |
|------|----------------|-------------|---------|
| 1 | Story Outline | NO | Only in memory until job completes |
| 2 | Scene Hints | NO | Extracted but not saved |
| 3 | Story Text (partial) | NO | Concatenated in memory |
| 4 | Scene Descriptions | NO | Array in memory |
| 5a | Images (partial) | NO | Array in memory |
| 5b | Quality Scores | NO | Stored with images but not queryable |
| 6 | Cover Images | NO | Object in memory |
| 7 | Final Result | YES | Saved to story_jobs.result_data |

### Failure Scenarios

1. **Server crash mid-pipeline** → All work lost
2. **API rate limit** → Job fails, no partial recovery
3. **Single image fails** → Entire job fails (after retries)
4. **Database disconnect** → Progress updates lost

---

## Admin Story Editing Requirements

### Use Cases for Admin

1. **View any user's story** ✅ Already implemented (impersonation mode)
2. **Edit story text** - Modify individual page text
3. **Regenerate single scene description** - Without regenerating entire story
4. **Regenerate single image** - Without regenerating all images
5. **Regenerate single cover** - Just front/page0/back
6. **View quality scores** - See which images scored low
7. **Replace image manually** - Upload custom image
8. **Adjust and re-run image prompt** - Edit prompt, regenerate

### Current Limitations

- Cannot regenerate single elements server-side
- Must regenerate entire story or use client-side buttons
- No API to regenerate individual pieces
- Image prompts visible but not editable/reusable

---

## Proposed Architecture: Modular Regeneration

### New Server Endpoints for Regeneration

```
POST /api/stories/:storyId/regenerate/outline
    → Regenerate outline only, update story

POST /api/stories/:storyId/regenerate/page/:pageNum/text
    → Regenerate single page text

POST /api/stories/:storyId/regenerate/page/:pageNum/scene-description
    → Regenerate scene description for one page

POST /api/stories/:storyId/regenerate/page/:pageNum/image
    Body: { customPrompt?: string }
    → Regenerate image for one page (optionally with custom prompt)

POST /api/stories/:storyId/regenerate/cover/:coverType
    coverType: 'front' | 'page0' | 'back'
    Body: { customPrompt?: string }
    → Regenerate single cover

POST /api/stories/:storyId/upload-image/:pageNum
    Body: { imageData: base64 }
    → Replace image with custom upload

PATCH /api/stories/:storyId/page/:pageNum
    Body: { text?: string, sceneDescription?: string }
    → Edit page text or scene description directly
```

### Admin UI Workflow

```
Admin Panel → User List → View Stories → Select Story
    │
    ▼
Story Editor (impersonation mode, new tab)
    │
    ├─► View all pages with images
    ├─► See quality scores per image (highlight low scores)
    ├─► Click page to expand:
    │       ├─► Edit page text (inline)
    │       ├─► View/edit scene description
    │       ├─► View image prompt used
    │       ├─► [Regenerate Description] button
    │       ├─► [Regenerate Image] button
    │       ├─► [Edit Prompt & Regenerate] button
    │       └─► [Upload Custom Image] button
    │
    ├─► Cover section:
    │       ├─► View front/page0/back covers
    │       ├─► [Regenerate] button per cover
    │       └─► [Upload Custom] button per cover
    │
    └─► [Save Changes] → Updates story in database
```

---

## Proposed Improvements

### Phase 1: Checkpoint System (Fault Tolerance)

Add `story_job_checkpoints` table to save after each step:

```sql
CREATE TABLE story_job_checkpoints (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  step_name VARCHAR(50) NOT NULL,
  step_index INT DEFAULT 0,
  step_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, step_name, step_index)
);
```

### Phase 2: Modular Regeneration APIs

New endpoints to regenerate individual components:
- Scene description per page
- Image per page (with optional custom prompt)
- Cover images individually
- Story text per page

### Phase 3: Admin Story Editor

Enhanced UI for admins:
- View all story components
- See quality scores
- Edit text inline
- Regenerate individual pieces
- Upload custom images

### Phase 4: Image Quality Dashboard

- List images by quality score
- Filter: show only low-scoring images
- Bulk regenerate low-quality images
- Compare before/after regeneration

---

## Complete Pipeline with All Steps

```
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: OUTLINE GENERATION                                     │
│  ─────────────────────────────                                  │
│  Input: characters, storyType, theme, pages                     │
│  API: Claude (callClaudeAPI)                                    │
│  Tokens: 8192                                                   │
│  Output: Structured outline with page summaries                 │
│  Template: prompts/story-outline.txt                            │
│  Save to: checkpoint + result_data.outline                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2: SCENE HINTS EXTRACTION                                 │
│  ──────────────────────────────                                 │
│  Input: outline                                                 │
│  Function: extractShortSceneDescriptions()                      │
│  Output: Map of pageNum → short scene hint                      │
│  Save to: checkpoint (optional)                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3: STORY TEXT GENERATION (batched or all-at-once)         │
│  ──────────────────────────────────────────────────────         │
│  Input: outline, characters, style                              │
│  API: Claude (callClaudeAPI)                                    │
│  Tokens: 16000 per batch                                        │
│  Batch size: STORY_BATCH_SIZE env (0 = all at once)             │
│  Output: Story text with "## Page X" markers                    │
│  Template: prompts/story-text-batch.txt                         │
│  Save to: checkpoint per batch + result_data.storyText          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 4: SCENE DESCRIPTION GENERATION (parallel per page)       │
│  ────────────────────────────────────────────────────────       │
│  Input: page text, characters, scene hint                       │
│  API: Claude (callClaudeAPI)                                    │
│  Tokens: 2048                                                   │
│  Parallelism: All pages in batch simultaneously                 │
│  Output: Detailed visual scene description                      │
│  Template: prompts/scene-descriptions.txt                       │
│  Save to: checkpoint per page + result_data.sceneDescriptions   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 5: IMAGE GENERATION (parallel, rate-limited)              │
│  ─────────────────────────────────────────────────              │
│  Input: scene description, character photos, art style          │
│  API: Gemini (callGeminiAPIForImage)                            │
│  Parallelism: Max 5 concurrent (pLimit)                         │
│  Retries: 2 per image                                           │
│  Output: Base64 PNG image                                       │
│  Template: prompts/image-generation.txt                         │
│  Post-process: Compress to JPEG (sharp)                         │
│  Save to: checkpoint per page + result_data.images              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 5b: IMAGE QUALITY EVALUATION                              │
│  ─────────────────────────────────                              │
│  Input: generated image, original prompt, reference photos      │
│  API: Claude (evaluateImageQuality)                             │
│  Output: Score 0-100                                            │
│  Criteria: Character accuracy, scene matching, art quality      │
│  Template: prompts/image-evaluation.txt                         │
│  Save to: result_data.images[].qualityScore                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 6: COVER GENERATION                                       │
│  ────────────────────────                                       │
│  6a: Front Cover                                                │
│      Input: title, main characters, art style                   │
│      Template: prompts/front-cover.txt                          │
│                                                                 │
│  6b: Page 0 (Dedication)                                        │
│      Input: dedication text, characters                         │
│      Template: prompts/page0-with-dedication.txt                │
│               prompts/page0-no-dedication.txt                   │
│                                                                 │
│  6c: Back Cover                                                 │
│      Input: story summary, characters                           │
│      Template: prompts/back-cover.txt                           │
│                                                                 │
│  API: Gemini (callGeminiAPIForImage) × 3                        │
│  Save to: checkpoint per cover + result_data.coverImages        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 7: FINAL ASSEMBLY                                         │
│  ──────────────────────                                         │
│  Combine all results into result_data:                          │
│  {                                                              │
│    outline: string,                                             │
│    storyText: string,                                           │
│    sceneDescriptions: [{ pageNumber, description }],            │
│    images: [{ pageNumber, imageData, description, score }],     │
│    coverImages: { frontCover, page0, backCover },               │
│    imagePrompts: { pageNum: prompt },                           │
│    title: string                                                │
│  }                                                              │
│  Save to: story_jobs.result_data                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## API Endpoints Summary

### Existing Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/jobs/create-story` | POST | Start background job |
| `/api/jobs/:jobId/status` | GET | Poll job progress |
| `/api/jobs/my-jobs` | GET | List user's jobs |
| `/api/stories` | GET/POST | List/save stories |
| `/api/stories/:id` | GET/DELETE | Get/delete story |
| `/api/admin/users/:userId/stories` | GET | Admin: list user's stories |
| `/api/admin/users/:userId/stories/:storyId` | GET | Admin: get full story |

### Proposed New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/jobs/:jobId/checkpoints` | GET | List all checkpoints |
| `/api/jobs/:jobId/checkpoints/:step` | GET | Get specific checkpoint |
| `/api/stories/:id/regenerate/scene-description/:page` | POST | Regenerate one scene desc |
| `/api/stories/:id/regenerate/image/:page` | POST | Regenerate one image |
| `/api/stories/:id/regenerate/cover/:type` | POST | Regenerate one cover |
| `/api/stories/:id/page/:page` | PATCH | Edit page text/description |
| `/api/stories/:id/upload-image/:page` | POST | Upload custom image |
| `/api/admin/stories/low-quality-images` | GET | List low-scoring images |

---

## Implementation Priority

### High Priority
1. ✅ Server-side job pipeline (done)
2. Add checkpoint saves
3. Add regenerate single image endpoint
4. Add regenerate single scene description endpoint

### Medium Priority
5. Add quality score visibility in UI
6. Add admin story editor with regenerate buttons
7. Add custom image upload

### Low Priority
8. Checkpoint inspection API
9. Auto-resume crashed jobs
10. Remove legacy client-side generation code

---

## Summary

**Current State:**
- Full pipeline runs server-side ✅
- All-or-nothing: no partial saves
- Image quality scoring exists but not exposed
- Admin can view but not edit/regenerate individual pieces

**Target State:**
- Checkpoints after each step
- Regenerate any single component
- Admin can edit text, regenerate images, upload custom
- Quality scores visible, low-quality flagged
- Resume failed jobs from last checkpoint
