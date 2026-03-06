# MagicalStory - Story Generation Pipeline Analysis

**Last Updated:** 2025-12-15

## Current Architecture Overview

### Complete Pipeline Flow
```
User Input (Frontend - React)
    │
    ▼
POST /api/jobs/create-story
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  BACKGROUND JOB (processStoryJob)                           │
│                                                             │
│  Step 1: Generate Outline (5%)                              │
│      └─► Claude API → outline + checkpoint                  │
│                                                             │
│  Step 2: Extract Scene Hints (internal)                     │
│      └─► Parse outline → shortSceneDescriptions + checkpoint│
│                                                             │
│  Step 3: Generate Story Text (10-40%)                       │
│      └─► Claude API batches → fullStoryText + checkpoint    │
│                                                             │
│  Step 4: Generate Scene Descriptions (parallel)             │
│      └─► Claude API per page → allSceneDescriptions[]       │
│                                                             │
│  Step 5: Generate Images (10-90%, parallel/sequential)      │
│      ├─► Gemini API per page → raw image                    │
│      ├─► Compress to JPEG                                   │
│      ├─► Gemini API: evaluateImageQuality() → score 0-100   │
│      └─► Quality retry if below threshold + checkpoint      │
│                                                             │
│  Step 6: Generate Covers (95%)                              │
│      ├─► Gemini API × 3 → coverImages{}                     │
│      └─► Quality evaluation with text accuracy check        │
│                                                             │
│  Step 7: Save Final Result (100%)                           │
│      └─► UPDATE story_jobs SET result_data = {...}          │
│          + Send completion email                            │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
GET /api/jobs/:jobId/status (polling)
    │
    ▼
Frontend receives resultData → navigates to story view
```

---

## Implementation Status

### Checkpoint System ✅ IMPLEMENTED

Checkpoints save progress after each major step:
- `outline` - After outline generation
- `scene_hints` - After scene hint extraction
- `story_batch_N` - After each story text batch
- `page_N` - After each page image generation
- `cover_TYPE` - After each cover generation

On job failure, all checkpoint data is logged for debugging.

### Image Generation Modes ✅ IMPLEMENTED

| Mode | Description | Use Case |
|------|-------------|----------|
| `parallel` | Generate all images simultaneously | Faster, less consistent |
| `sequential` | Generate one at a time, use previous as reference | Slower, more consistent characters |

### Quality Evaluation ✅ IMPLEMENTED

- **Scene Images:** Evaluated by Gemini for character accuracy and scene matching
- **Cover Images:** Additional text accuracy check (title spelling)
- **Quality Threshold:** 50% (configurable via `IMAGE_QUALITY_THRESHOLD`)
- **Auto-retry:** Up to 3 attempts for covers, 2 for scenes
- **Text Error Enforcement:** Covers with text errors forced to score 0

---

## Regeneration Endpoints ✅ IMPLEMENTED

| Endpoint | Status | Description |
|----------|--------|-------------|
| `POST /api/stories/:id/regenerate/scene-description/:pageNum` | ✅ Done | Regenerate single scene description |
| `POST /api/stories/:id/regenerate/image/:pageNum` | ✅ Done | Regenerate single page image |
| `POST /api/stories/:id/regenerate/cover/:coverType` | ✅ Done | Regenerate single cover |
| `POST /api/stories/:id/edit/image/:pageNum` | ✅ Done | Edit image with custom prompt |
| `POST /api/stories/:id/edit/cover/:coverType` | ✅ Done | Edit cover with custom prompt |
| `PATCH /api/stories/:id/page/:pageNum` | ✅ Done | Edit page text or scene description |

---

## Admin Features

### Implemented ✅

| Feature | Status |
|---------|--------|
| View all users | ✅ Done |
| View user's stories | ✅ Done |
| Impersonation mode | ✅ Done |
| Storage usage metrics | ✅ Done |
| Database size metrics | ✅ Done |
| Developer mode (skip payment) | ✅ Done |

### Developer Mode (Admin Only)

When enabled, admins can:
- Regenerate images directly from outline view
- Edit images with custom prompts
- Skip payment for print orders
- Access detailed prompts and quality scores

---

## API Endpoints Summary

### Story Jobs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/jobs/create-story` | POST | Start background story generation |
| `/api/jobs/:jobId/status` | GET | Poll job progress and results |

### Stories

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stories` | GET | List user's stories |
| `/api/stories` | POST | Save new story |
| `/api/stories/:id` | GET | Get story details |
| `/api/stories/:id` | DELETE | Delete story |
| `/api/stories/:id/pdf` | GET | Generate PDF |

### Regeneration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stories/:id/regenerate/scene-description/:pageNum` | POST | Regenerate scene description |
| `/api/stories/:id/regenerate/image/:pageNum` | POST | Regenerate page image |
| `/api/stories/:id/regenerate/cover/:coverType` | POST | Regenerate cover |
| `/api/stories/:id/edit/image/:pageNum` | POST | Edit image with prompt |
| `/api/stories/:id/edit/cover/:coverType` | POST | Edit cover with prompt |

### Admin

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/metrics/summary` | GET | Dashboard metrics |
| `/api/admin/users` | GET | List all users |
| `/api/admin/user-storage` | GET | Storage per user |
| `/api/admin/database-size` | GET | Database statistics |

### Payments & Print

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stripe/create-checkout-session` | POST | Create Stripe checkout |
| `/api/stripe/order-status/:sessionId` | GET | Check order status |
| `/api/stripe/webhook` | POST | Stripe webhook handler |
| `/api/print-provider/order` | POST | Direct print order (dev mode) |

---

## Prompt Templates

Located in `prompts/` folder:

| File | Purpose |
|------|---------|
| `story-outline.txt` | Generate story outline |
| `story-text-batch.txt` | Generate story text |
| `scene-descriptions.txt` | Generate scene descriptions |
| `image-prompt-parallel.txt` | Image generation (parallel mode) |
| `image-prompt-sequential.txt` | Image generation (sequential mode) |
| `front-cover.txt` | Front cover generation |
| `back-cover.txt` | Back cover generation |
| `page0-with-dedication.txt` | Initial page with dedication |
| `page0-no-dedication.txt` | Initial page without dedication |

---

## Future Improvements

### Potential Enhancements

| Feature | Priority | Status |
|---------|----------|--------|
| Resume failed jobs from checkpoint | Medium | Not started |
| Bulk regenerate low-quality images | Low | Not started |
| Custom image upload | Low | Not started |
| Visual Bible for secondary characters | Medium | Partially implemented |

### Visual Bible System

Tracks consistency for:
- Secondary characters (extracted from story)
- Animals
- Artifacts/objects
- Locations

Currently extracts descriptions but not yet used for image generation consistency.

---

## Error Handling

### Gemini Content Safety

If Gemini blocks image generation:
- `finishReason` and `finishMessage` are logged
- Job continues with retry
- After max retries, job fails with partial data dump

### Checkpoint Recovery

On job failure, debug log includes:
- All input parameters
- All checkpoint data
- Generated prompts
- Partial results

This allows manual recovery or debugging of failed jobs.
