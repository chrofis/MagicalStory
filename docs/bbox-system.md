# Bounding Box (Bbox) Detection System

## Overview

The bbox system detects, tracks, and uses character/object bounding boxes throughout the story image pipeline. It serves three purposes:

1. **Quality evaluation** — identify which character/object has an issue and where it is
2. **Targeted repair** — crop and fix specific regions without regenerating the full image
3. **Entity consistency** — verify character appearance across pages

---

## Architecture

```
Image Generated
    |
    v
enrichWithBoundingBoxes()          <-- Stage 2 of quality pipeline
    |
    +-- detectAllBoundingBoxes()   <-- Two-pass Gemini/Grok vision
    |       +-- Pass 1: initial detection (characters + objects)
    |       +-- Pass 2: refinement (overlay feedback loop)
    |
    +-- Match issues to elements   <-- Link quality issues to bbox regions
    |
    v
Store: scene.bboxDetection        <-- Persisted per image version
       scene.bboxOverlayImage      <-- Debug visualization
       scene.fixTargets            <-- Repair targets with bbox coords
    |
    v
Character Repair (Grok)           <-- Uses bodyBox/faceBox for region targeting
Auto Repair (Runware)             <-- Uses fixTargets with boundingBox
```

---

## 1. Detection

### `detectAllBoundingBoxes(imageData, options)`

**File:** `server/lib/images.js` (~line 1265)

**Models:** Gemini 2.5 Flash (primary) | Grok 4 Fast (fallback)

**Pass 1 — Initial Detection:**
- Sends image + expected characters (names, descriptions, positions) + expected objects
- AI returns JSON with `figures[]` and `objects[]`
- Each figure: `{name, label, faceBox, bodyBox, confidence, position}`
- Confidence: `high` | `medium` | `low`
- Coordinates: 0-1000 scale (normalized to 0-1 on return)

**Pass 2 — Refinement:**
- Only runs if Pass 1 found identified characters (skips UNKNOWN-only)
- Creates overlay image from Pass 1 boxes via `createBboxOverlayImage()`
- Sends overlay back to model: "refine these boxes for accuracy"
- Focus: face boxes must cover full face (forehead to chin), body boxes must cover full figure (head to feet)
- Merges: refined main characters + UNKNOWN crowd figures from Pass 1

**Fallback chain:**
1. Gemini 2.5 Flash → JSON response
2. On API error → Grok 4 Fast vision
3. On empty response (0 tokens) → retry once, then Grok fallback
4. JSON parse fail → repair truncated JSON → regex extraction

### `detectSubRegion(characterCrop, targetElement)`

**File:** `server/lib/images.js` (~line 1688)

Detects specific body parts (shoes, shirt, hands, face) within a character crop. Used for targeted auto-repair of individual elements.

Returns: `{found, box, confidence, description}`

---

## 2. Storage

### Type: `BboxSceneDetection`

**File:** `client/src/types/story.ts` (line 216)

```typescript
interface BboxSceneDetection {
  figures: Array<{
    name: string;            // Character name or "UNKNOWN"
    label: string;           // Visual description
    bodyBox?: number[];      // [ymin, xmin, ymax, xmax] normalized 0-1
    faceBox?: number[];      // [ymin, xmin, ymax, xmax] normalized 0-1
    position?: string;       // "left", "center", "right"
    confidence?: string;     // "high", "medium", "low"
  }>;
  objects: Array<{
    name?: string;           // Expected object name
    found?: boolean;         // Whether expected object was found
    label?: string;
    bodyBox?: number[];
    position?: string;
  }>;
  // Metadata
  expectedCharacters?: Array<{name, description, position}>;
  expectedPositions?: Record<string, string>;
  positionMismatches?: Array<{character, expected, expectedLCR, actual}>;
  missingCharacters?: string[];
  expectedObjects?: string[];
  foundObjects?: string[];
  missingObjects?: string[];
  unknownFigures?: number;
  characterDescriptions?: Record<string, {age, gender, isChild}>;
  // Debug
  rawPrompt?: string;
  rawResponse?: string;
  refinementResponse?: string;
}
```

### Where stored

| Location | Field | Description |
|----------|-------|-------------|
| `sceneImages[n].bboxDetection` | BboxSceneDetection | Active detection for page |
| `sceneImages[n].bboxOverlayImage` | string (base64) | Debug visualization |
| `sceneImages[n].retryHistory[].bboxDetection` | BboxSceneDetection | Per-attempt detection |
| `coverImages.{front\|initial\|back}.bboxDetection` | BboxSceneDetection | Cover detection |
| `imageVersionHistory[v].bboxDetection` | BboxSceneDetection | Per-version detection |

---

## 3. Enrichment Pipeline

### `enrichWithBoundingBoxes(imageData, issues, options)`

**File:** `server/lib/images.js` (~line 2078)

Bridges quality evaluation and repair. Takes quality issues and matches them to detected elements.

**Process:**
1. Build expected characters from metadata (names, descriptions, clothing, positions)
2. Run `detectAllBoundingBoxes()` with expectations
3. Match detected figures to characters by name
4. Detect position mismatches (expected vs actual position)
5. Find missing characters/objects
6. Match each quality issue to a specific bbox region:
   - Priority 1: Explicit `issue.character` field
   - Priority 2: Character name extracted from issue text
   - Priority 3: Type-based (face issue → character, object issue → object)
   - Priority 4: Fallback to largest element

**Output:**
```javascript
{
  targets: [{
    boundingBox,      // faceBox or bodyBox
    faceBox, bodyBox, // Both stored
    issue, severity, type, fixPrompt,
    affectedCharacter, matchMethod
  }],
  detectionHistory: BboxSceneDetection
}
```

---

## 4. Overlay Visualization

### `createBboxOverlayImage(imageData, bboxDetection)`

**File:** `server/lib/images.js` (~line 1922)

Draws colored rectangles on the image as an SVG overlay:

| Element | Color | Stroke |
|---------|-------|--------|
| Body box (identified) | Green `#00cc00` | 4px |
| Body box (UNKNOWN) | Gray `#888888` | 4px |
| Face box (original) | Blue `#0066ff` | 5px |
| Face box (refined) | Cyan `#00cccc` | 5px, labeled "FACE check" |
| Face box (redetected) | Magenta `#ff00cc` | 5px, labeled "FACE redo" |
| Object box (found) | Cyan `#00cccc` | 2px |
| Object box (unknown) | Orange `#ff8800` | 2px |

Labels include confidence icons: `star` (high), `diamond` (medium), `circle` (low)

---

## 5. Character Repair

### `repairCharacterMismatchWithGrok(imageData, characterPhoto, bbox, charName, options)`

**File:** `server/lib/images.js` (~line 6079)

Uses bbox to target character region for Grok-based repair.

**Three modes:**

| Mode | Method | Best for |
|------|--------|----------|
| **Blended** (default) | Gradient whiteout + Grok redraw + feathered blend | General character repair |
| **Cutout** | Extract region + Grok repair + composite back | Isolated character fixes |
| **Blackout** | Full whiteout + Grok regenerate entire scene | Major character issues |

**Blended mode detail:**
1. Create gradient whiteout overlay on character bbox (inner 20% fully white, outer fades)
2. Send whiteout image + character reference photo to Grok
3. Grok redraws character through semi-transparent overlay
4. Feathered blend (30px feather) merges Grok output with original scene
5. Protected faces (other characters) forced to 100% original

**Key parameters:**
- `bbox`: [ymin, xmin, ymax, xmax] — the character's body box
- `options.faceBbox`: Optional face box for head-specific handling
- `options.protectedFaces`: Other character face boxes to preserve during blend

---

## 6. Auto Repair (Inpainting)

### `autoRepairWithTargets(imageData, fixTargets, maxAttempts, options)`

**File:** `server/lib/images.js` (~line 8922)

Three-pass inpainting using fix targets with bbox regions:

| Pass | Model | Target Type | Priority |
|------|-------|-------------|----------|
| 1 | FLUX Fill (`runware:102@1`) | Face/head issues | Highest |
| 2 | SDXL (`runware:101@1`) | Anatomy (hands, limbs) | Medium |
| 3 | SDXL (`runware:101@1`) | Objects, props, background | Lowest |

**Safety:** Skips repair if combined mask coverage > 50% of image.

---

## 7. API Endpoints

### `POST /api/stories/:id/refresh-bbox/:pageNum`

**File:** `server/routes/regeneration.js` (~line 3993)

Run fresh bbox detection on active image. Dev/admin only.

- **Request:** `{ bboxModel?: string }`
- **Response:** `{ bboxDetection, bboxOverlayImage, fixTargets }`
- Saves results to DB

### `POST /api/stories/:id/iterate-bbox/:pageNum`

**File:** `server/routes/regeneration.js` (~line 4107)

Refine existing bbox detection using overlay feedback.

- **Request:** `{ bboxModel?, currentDetection, overlayImage }`
- **Response:** `{ bboxDetection, bboxOverlayImage }`
- Sends current overlay + refinement prompt to model

---

## 8. Frontend Display

### `ObjectDetectionDisplay` component

**File:** `client/src/components/generation/story/ObjectDetectionDisplay.tsx`

Dev-mode component showing:
- Overlay image with colored boxes (click to enlarge)
- Figures list: name, confidence icon, face/body box coordinates
- Objects list: found/missing status
- Position mismatches: expected vs actual
- Missing characters/objects: red badges
- Controls: model selector, re-detect button, refine button
- Debug: raw prompt/response export, JSON download

---

## 9. Issue Collection

### `collectAllIssuesForPage(scene, storyData, pageNumber)`

**File:** `server/lib/images.js` (~line 10542)

Aggregates issues from all sources that feed into bbox-targeted repair:

| Source | Type | Origin |
|--------|------|--------|
| Quality eval | fixableIssues | Initial image evaluation |
| Retry history | pre/post-repair eval | Repair attempt evaluations |
| Entity consistency | character appearance | Cross-page comparison |
| Object consistency | object appearance | Cross-page comparison |
| Image cross-checks | character consistency | Grid-based visual checks |

---

## 10. Coordinate System

All bbox coordinates use **normalized 0-1 scale**:

```
[ymin, xmin, ymax, xmax]

(0,0) -------- (0,1)
  |              |
  |   [face]     |
  |              |
(1,0) -------- (1,1)
```

- Gemini returns 0-1000 scale → normalized on receipt
- Grok uses same 0-1000 scale
- All internal storage and usage is 0-1
- Frontend displays as percentages for readability
