---
name: extract-faces
description: "Extract character faces from a story's scene images using evaluation bounding boxes"
---

# Extract Faces from Story

## Overview

Extracts character faces from all scene images of a story. Uses the quality evaluation's bounding box data for accurate character identification and face location.

## Usage

```bash
node scripts/extract-faces.js <storyId>
```

**Example:**
```bash
node scripts/extract-faces.js job_1769360030111_ufyj3zi84
```

## How It Works

### 1. Primary Method: Evaluation Data

The script reads `qualityReasoning` from each scene image. The quality evaluation produces character identification with face bounding boxes.

**Two evaluation formats exist:**

#### OLD Format (before Jan 2026)
```javascript
{
  "subject_mapping": [...],
  "identity_sync": [{
    "figure": 1,
    "matched_reference": "Lukas",
    "confidence": 0.95,
    "face_bbox": [0.29, 0.45, 0.40, 0.52],  // [ymin, xmin, ymax, xmax]
    "facial_match": "Good match - consistent face shape...",
    "hair_match": "Correct brown color, short length...",
    "age_match": "Child proportions correct...",
    "attire_audit": "Blue striped jacket matches reference..."
  }],
  "rendering_integrity": {...},
  "object_integrity": {...},
  "scene_check": {...},
  "fix_targets": [...]
}
```

#### NEW Format (current)
```javascript
{
  "figures": [{
    "id": 1,
    "position": "Left side, Middle ground",
    "hair": "brown, short, side-swept",
    "clothing": "dark blue winter coat with fur-lined hood",
    "action": "standing, hands open",
    "view": "three-quarter front"
  }],
  "matches": [{
    "figure": 1,
    "reference": "Lukas",
    "confidence": 0.9,
    "face_bbox": [0.32, 0.48, 0.45, 0.55],  // [ymin, xmin, ymax, xmax]
    "hair_ok": true,
    "clothing_ok": true,
    "issues": ["expression mismatch"]
  }],
  "rendering": {...},
  "scene": {...},
  "fixable_issues": [...]
}
```

**Key difference:**
- OLD: Character detection + matching combined in `identity_sync`
- NEW: Detection (`figures`) and matching (`matches`) are separate

**Bounding box format:** `[ymin, xmin, ymax, xmax]` normalized 0-1

### 2. Fallback: Cascade Detection

When evaluation data is missing, falls back to:
1. **Anime cascade detector** (OpenCV) with aggressive settings:
   - `min_size: 15` (detects small faces)
   - `scale_factor: 1.03` (fine-grained scanning)
   - `min_neighbors: 1` (sensitive detection)
2. **Gemini validation** - confirms faces and identifies characters
3. **Non-maximum suppression** - removes duplicate detections

### 3. Face Extraction

For each detected face:
1. Convert normalized bbox to pixel coordinates
2. Add 60% padding around the face
3. Expand small crops to minimum 15% of image width
4. Resize to **256x256 pixels** (consistent size)
5. Save as JPEG 90% quality

## Output Structure

```
output/story-<storyId>/
├── faces/
│   ├── Lukas/
│   │   ├── Lukas_page1.jpg
│   │   ├── Lukas_page2.jpg
│   │   └── ...
│   ├── Manuel/
│   │   └── Manuel_page1.jpg
│   └── <Character>/
│       └── <Character>_page<N>.jpg
└── faces-manifest.json
```

## Manifest Format

```json
{
  "storyId": "job_...",
  "storyTitle": "Story Name",
  "extractedAt": "2026-01-25T...",
  "totalFaces": 41,
  "fromEvaluation": 41,
  "fromFallback": 0,
  "faces": [
    {
      "character": "Lukas",
      "page": 1,
      "file": "faces/Lukas/Lukas_page1.jpg",
      "confidence": 0.9,
      "source": "evaluation"
    }
  ]
}
```

## Data Flow

```
Story DB (stories.data)
    ↓
sceneImages[].qualityReasoning
    ↓
Parse evaluation format:
  OLD: identity_sync[].matched_reference + face_bbox
  NEW: matches[].reference + face_bbox
    ↓
Extract face_bbox + character name
    ↓
Convert normalized [ymin, xmin, ymax, xmax] → pixel coordinates
    ↓
Load image from story_images table
    ↓
Crop face region with 60% padding
    ↓
Resize to 256x256
    ↓
Save to faces/<Character>/<Character>_page<N>.jpg
```

## Related Commands

```bash
# List recent stories
node scripts/list-stories.js

# Get latest story ID
node scripts/get-latest-story.js

# Compare expected vs extracted
node scripts/count-expected-faces.js <storyId>

# Check face consistency for a character
node scripts/compare-faces.js <storyId> <characterName>
```

## Alternative: Bbox Detection from Retry History

For debugging or when qualityReasoning is unavailable, use the raw bboxDetection data stored in retryHistory.

### Find Pages with Bbox Data

```javascript
const result = await pool.query(`
  SELECT result_data->'sceneImages' as images
  FROM story_jobs WHERE id = $1
`, [jobId]);

const images = result.rows[0]?.images || [];
images.forEach((img) => {
  const bbox = img.retryHistory?.find(h => h.bboxDetection)?.bboxDetection;
  if (bbox) {
    console.log(`Page ${img.pageNumber}: ${bbox.figures?.length} figures, ${bbox.objects?.length} objects`);
  }
});
```

### Extract Bbox Data for a Page

```javascript
// Page index = pageNumber - 1
const result = await pool.query(`
  SELECT result_data->'sceneImages'->${pageIndex}->'retryHistory' as history
  FROM story_jobs WHERE id = $1
`, [jobId]);

const bbox = result.rows[0]?.history?.find(h => h.bboxDetection)?.bboxDetection;
// bbox.figures: [{label, bodyBox, faceBox, position}]
// bbox.objects: [{label, bodyBox, position}]
```

### Crop Regions Using Sharp

```javascript
const sharp = require('sharp');
const metadata = await sharp(imageBuffer).metadata();

// Bbox format: [ymin, xmin, ymax, xmax] normalized 0-1
const [ymin, xmin, ymax, xmax] = bbox.figures[0].bodyBox;

await sharp(imageBuffer).extract({
  left: Math.round(xmin * metadata.width),
  top: Math.round(ymin * metadata.height),
  width: Math.round((xmax - xmin) * metadata.width),
  height: Math.round((ymax - ymin) * metadata.height)
}).png().toFile('output.png');
```

### Quick Script

```bash
node scripts/extract-bbox-crops.js <jobId> <pageNumber>
```

Output directory: `tests/fixtures/bbox-crops/`

### Known Issue: Face Detection Often Wrong

The `faceBox` from bboxDetection is unreliable - often points to background elements instead of faces. **Prefer using `face_bbox` from qualityReasoning matches instead.**

Body detection (`bodyBox`) works correctly.

## Troubleshooting

**"From evaluation: 0"** - Story has no qualityReasoning data, or uses unknown format. Check with:
```bash
node scripts/check-evaluation-fields.js <storyId>
```

**Missing characters** - Either not in scene, or evaluation didn't detect them. Falls back to cascade which may miss some.

**Duplicate filenames** - Multiple faces per page overwrite each other. TODO: Add index suffix.

**Face crops show wrong area** - bboxDetection faceBox is unreliable. Use qualityReasoning face_bbox instead.
