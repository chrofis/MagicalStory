# Calm Region Text Overlay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fixed rectangular text overlay with a contour-based overlay that follows the natural calm region of each image. Browser and PDF show pixel-identical results.

**Architecture:** One server-side rendering pipeline produces a transparent PNG overlay with text + gradient inside the detected calm polygon. Both browser and PDF composite this same overlay image on top of the page image. When text is edited, the overlay is re-rendered server-side. No CSS text rendering, no PDFKit text rendering — one engine, one output.

**Tech Stack:** Node.js + sharp (detection), node-canvas (text rendering), sharp composite (overlay)

---

### Task 1: Port calm region detection to Node/sharp

**Files:**
- Create: `server/lib/calmRegion.js`

**What to build:**

```javascript
async function detectCalmRegion(imageBuffer, textPosition, options = {}) {
  // Returns: { polygon: [[x, y], ...], areaFraction: 0.15, bounds: {x,y,w,h} } or null
  // Coordinates are in pixels (not percentages) relative to image dimensions
}
```

Algorithm (ported from Python prototype `tests/manual/test-text-flow.py`):

1. Get raw grayscale pixels from sharp: `sharp(buffer).greyscale().raw().toBuffer()`
2. Get image dimensions from metadata
3. Divide into blocks (12px). For each block compute:
   - `brightness` = mean pixel value / 255
   - `variance` = std dev of pixel values, normalized
   - `edgeDensity` = gradient magnitude (Sobel-like: abs diff of adjacent pixels), normalized
4. Calmness formula: `(1 - variance) * (1 - edgeDensity^0.7) * (0.7 + 0.3 * brightness)`
5. Detect border (uniform edge pixels) → zero out border blocks
6. Crop to target zone: top/bottom 35% based on textPosition (vertical restriction only, full width)
7. Adaptive threshold: 55th percentile of non-zero calmness values
8. On the block grid (small, ~85x85):
   - Morphological close (dilate then erode) to fill gaps
   - Erode once to pull boundary inward
   - Blur (average neighboring blocks) for smooth shapes
   - Threshold to binary
9. Walk the binary grid to extract the outline polygon (simple marching squares or border tracing)
10. Simplify polygon (Douglas-Peucker algorithm — reduce to 6-12 vertices)
11. Convert block coordinates to pixel coordinates
12. If area < 8% of image, return null (fallback to rectangle)

**No OpenCV needed.** All operations work on the small block grid, not pixel-level. Sharp only used for grayscale conversion.

**Test:** `tests/manual/test-calm-region-node.js` — run on existing test images, compare with Python results.

---

### Task 2: Build server-side text overlay renderer

**Files:**
- Create: `server/lib/textOverlayRenderer.js`

**Dependencies:** `npm install canvas` (node-canvas for text rendering)

**What to build:**

```javascript
async function renderTextOverlay(imageWidth, imageHeight, text, polygon, options = {}) {
  // Returns: Buffer (transparent PNG with text + gradient inside polygon)
}
```

Steps:
1. Create a canvas at imageWidth x imageHeight (transparent background)
2. Draw the gradient fill inside the polygon:
   - Create a clipping path from polygon vertices
   - Fill with radial/linear gradient (white, opacity 0.55 → 0.3 → 0.0)
   - Same gradient logic as current `getGradientStyle` but on canvas
3. Render text inside the polygon:
   - Use the polygon's scanline widths (for each y, find left/right edges of polygon)
   - Render text line by line, each line clipped to the polygon width at that y
   - Font: serif (Georgia or similar), size proportional to image height
   - Color: dark gray (#222) with white text shadow for readability
4. Export as PNG with alpha channel: `canvas.toBuffer('image/png')`

**Fallback rectangle:** If polygon is null, use the standard rectangular region (matching current behavior but rendered as image).

**Public API:**

```javascript
async function generateTextOverlay(imageBuffer, text, textPosition, options = {}) {
  const { width, height } = await sharp(imageBuffer).metadata();
  const polygon = await detectCalmRegion(imageBuffer, textPosition);
  const overlayBuffer = await renderTextOverlay(width, height, text, polygon, options);
  // Composite overlay onto image
  const composited = await sharp(imageBuffer)
    .composite([{ input: overlayBuffer, top: 0, left: 0 }])
    .toBuffer();
  return {
    overlayImage: overlayBuffer,     // Transparent PNG (for browser display)
    compositedImage: composited,     // Image with text baked in (for PDF)
    polygon,                         // For metadata storage
  };
}
```

---

### Task 3: Create API endpoint for text overlay rendering

**Files:**
- Modify: `server/routes/stories.js` or `server/routes/regeneration.js`

**Endpoint:** `POST /api/stories/:id/text-overlay/:pageNum`

**Request body:** `{ text: "story text for this page" }` (optional — defaults to stored page text)

**Response:** `{ overlayImage: "data:image/png;base64,..." }`

This endpoint is called:
- On initial page display (if overlay not cached)
- When user edits text (re-renders overlay with new text)
- By the PDF generator (to get the overlay for each page)

**Caching:** Store the overlay image in memory or DB keyed by `(storyId, pageNum, textHash)`. Only re-render when text changes.

---

### Task 4: Run detection after image generation, store polygon

**Files:**
- Modify: `server.js` — in Phase 5a after each page image is generated
- Modify: `server/lib/images.js` — in the unified repair pipeline after image changes

**What to change:**

After each page image is generated:

```javascript
const { detectCalmRegion } = require('./calmRegion');
const imgBuffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
const calmRegion = await detectCalmRegion(imgBuffer, textPosition);
pageResult.calmRegion = calmRegion; // { polygon, areaFraction, bounds }
```

Stored in `sceneImages[].calmRegion` in the story data. Detection runs once per image generation (~200-500ms, no API cost).

Also run detection when images are regenerated/repaired (iterate, character repair, pick-best-version).

---

### Task 5: Update browser to show overlay image

**Files:**
- Modify: `client/src/components/generation/StoryDisplay.tsx`
- Modify: `client/src/pages/SharedStoryViewer.tsx`

**What to change:**

Replace the current CSS gradient overlay with a server-rendered overlay image:

```tsx
{textOverlay && pageText.trim() && (
  <img
    src={overlayImageUrl}
    alt=""
    className="absolute inset-0 w-full h-full"
    style={{ pointerEvents: 'none' }}
  />
)}
```

The overlay image is fetched from the API endpoint (Task 3) or served as a pre-rendered data URL.

**Text editing:** When user edits text, call the API to re-render the overlay and update the displayed image.

**Lazy loading:** On initial load, show the page image without overlay. Fetch overlays in background.

---

### Task 6: Update PDF to use overlay image

**Files:**
- Modify: `server/lib/pdf.js`

**What to change:**

Replace the current gradient rectangle + PDFKit text rendering with:

```javascript
if (textOverlay && image?.imageData) {
  const { generateTextOverlay } = require('./textOverlayRenderer');
  const imgBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const { compositedImage } = await generateTextOverlay(imgBuffer, cleanText, textPosition);
  // Use compositedImage (image with text baked in) instead of raw image
  await drawImageCovering(doc, compositedImage, ...);
}
```

No more separate gradient drawing + text rendering in PDFKit. The text overlay renderer produces the final composited image.

**Result:** Browser overlay image and PDF image come from the same renderer → pixel-identical.

---

### Task 7: Remove old CSS/PDFKit text overlay code

**Files:**
- Modify: `client/src/utils/textOverlay.ts` — keep `getTextOverlayPosition` for position cycling, remove gradient/style functions
- Modify: `client/src/components/generation/StoryDisplay.tsx` — remove CSS overlay rendering
- Modify: `server/lib/pdf.js` — remove gradient + text rendering code

Only after Tasks 5-6 are working. Keep old code as fallback during transition.

---

### Task 8: Test end-to-end

1. Generate a new story → verify `calmRegion` polygon in scene data
2. View in browser → text follows organic shape, not a box
3. Download PDF → text in same position/shape as browser
4. Edit text → overlay re-renders with new text
5. Old stories without `calmRegion` → fallback to rectangle
6. Compare browser screenshot vs PDF page → pixel-similar text placement

---

### Commit strategy

- Task 1: detection module (standalone, testable) 
- Task 2: renderer module (standalone, testable)
- Task 3: API endpoint
- Task 4: wire into generation pipeline
- Task 5-6: browser + PDF updates
- Task 7: cleanup old code
- Task 8: testing

---

### Performance budget

- Detection: <500ms per image (block grid operations on ~85x85 grid)
- Rendering: <200ms per overlay (canvas text + gradient, one composite)
- Total: <700ms per page (runs in parallel with quality eval)
- No API calls — pure local computation
- Memory: <100MB peak (canvas + image buffers)
- Overlay PNG: ~50-100KB (mostly transparent, only text + gradient area has content)

---

### Dependency: node-canvas

`npm install canvas` adds a native dependency (Cairo graphics library). It's well-established and used in production by many Node projects. If native deps are a problem on Railway, alternative: use sharp's own text rendering (`sharp.text()`) which is more limited but has no additional deps.

Test on Railway deployment before committing to node-canvas.
