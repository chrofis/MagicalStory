# Calm-Zone Text Overlay Pipeline

How story text gets onto AI-generated page images, and how the pipeline keeps that overlay area legible.

## End-to-end flow

```
                 1. Sonnet picks textPosition + textZoneDescription per page
                              │
                              ▼
                 2. enforceSpreadTextPosition (storyHelpers.js)
                    flips wrong-side corners (odd→left, even→right)
                              │
                              ▼
                 3. Empty-scene + page generation
                    use the calm-zone block in the prompt
                    (buildTextZoneInstruction → ART STYLE block)
                              │
                              ▼
                 4. detectAndLightenTextRegion (textRegion.js)
                    measures calm pixels INSIDE the actual overlay polygon
                              │
                              ▼
                 5. Text-space-repair loop (server.js)
                    if calmFound < calmNeeded → re-roll image with mask
                    keep all candidates as imageVersions[]
                              │
                              ▼
                 6. Quality-eval + repair workflow (iterate / inpaint /
                    character-fix). Each branch threads textPosition
                    through to its own prompt as a "Quiet zone:" warning.
                              │
                              ▼
                 7. Step 7.5 post-repair calm-zone recovery (images.js)
                    re-detects on repaired pages; runs text-space-repair
                    again if calm zone was degraded by a repair step.
                              │
                              ▼
                 8. Renderers consume textPosition (corner enum):
                    ┌─ Frontend (browser)        — getTextOverlayPosition
                    │  (CSS fallback) + server-rendered PNG (preferred)
                    └─ PDF                        — generateTextOverlay
                       (textOverlayRenderer.js, polygon-clipped Canvas)
```

## Position semantics

`textPosition` is one of six string values:

| Value          | Shape (from `getTextZonePolygon`)   | Renderer text alignment |
|----------------|-------------------------------------|--------------------------|
| `top-left`     | right triangle, hypotenuse cuts down-right | left-aligned, top-anchored |
| `top-right`    | right triangle, hypotenuse cuts down-left  | right-aligned, top-anchored |
| `bottom-left`  | right triangle, hypotenuse cuts up-right   | left-aligned, bottom-anchored |
| `bottom-right` | right triangle, hypotenuse cuts up-left    | right-aligned, bottom-anchored |
| `top-full`     | rectangle across the top N% of the frame   | centered, top-anchored |
| `bottom-full`  | rectangle across the bottom N% of the frame | centered, bottom-anchored |

**Critical:** corner positions are **triangles**, not rectangles. The right angle sits at the corner of the frame; the hypotenuse cuts diagonally into the scene. Triangle area ≈ half the bounding rectangle's area.

**Spread parity rule:**
- Odd pages (1, 3, 5, 7, 9) — left side of the printed two-page spread → text must use a `*-left` or `*-full` position.
- Even pages (2, 4, 6, 8, 10) — right side → text must use `*-right` or `*-full`.
- `enforceSpreadTextPosition` mechanically rewrites wrong-side corners (`top-right` → `top-left` on an odd page, etc.). Sonnet should pick correctly via the prompt's parity rule, but the deterministic flip is the safety net.

Both server (`storyHelpers.js`) and client (`textOverlay.ts`) apply the spread rule.

## Polygon size — driven by `languageLevel`

| `languageLevel`  | Bucket  | Area fraction (`SIZE_FRACTION`) |
|------------------|---------|----------------------------------|
| `1st-grade`      | small   | 10%                              |
| `standard`       | medium  | 25%                              |
| `advanced`       | large   | 40%                              |

`getTextZonePolygon` produces a polygon with that pixel area, scaled to the image dimensions. For corners, both legs are scaled by `√(2 × areaPct)`, with the horizontal leg further multiplied by `0.75` so text hugs the outer corner instead of stretching too far into the scene.

## Calm-pixel measurement (post-generation)

`detectAndLightenTextRegion` (`server/lib/textRegion.js`):

1. Greyscale the image, divide into 16×16 blocks.
2. For each block, compute brightness (mean) and variance (std).
3. Calmness score = `(1 - varianceNorm) × (0.7 + 0.3 × (1 - brightnessNorm))` — variance dominates; dark calm patches score slightly higher than light calm patches.
4. Hard-restrict the block mask to the chosen half × half quadrant (corners) or half-strip (`*-full`). Outside-zone blocks → 0.
5. Upscale the block mask to per-pixel resolution with cubic interpolation; blur for feathered edges.
6. Count calm pixels inside the actual rendered **polygon** (not a bounding rectangle). Polygon comes from `computeOverlayPolygon` (config) which mirrors `getTextZonePolygon` byte-for-byte.
7. Return:
   - `score` — fraction of total image pixels that are calm (legacy/zone metric)
   - `rect` — bounding box of all calm pixels within the constrained zone
   - `overlayCalmPx` — calm pixels inside the polygon (legibility-relevant)
   - `overlayAreaPx` — polygon's total area in pixels

## The repair gate (geometric)

`server/config/textRegion.js`:

- `requiredTextPixels(words, fontPt)` — how many pixels² of text the renderer needs, from font metrics:
  ```
  font_height = pt × 96/72 × 1.18
  char_width  ≈ pt × 0.55
  pxPerWord   = char_width × line_height × 5.5 chars/word × 1.5 overhead
  ```
  Exposed at module-level constants `PIXELS_PER_WORD = { 14: 1399, 12: 1028, 10: 714 }`.
- `requiredTextCoveragePct(words, fontPt)` — legacy fallback; unused when polygon probe succeeds.

**Gate** (in `server.js` text-region phase):
```
calmFoundPx = pixels in polygon that are calm
calmNeededPx = words × pxPerWord(fontPt)

if calmFoundPx < calmNeededPx → repair
```

Falls back to `coverage% < requiredPct%` only when the sharp probe failed (no width/height available).

**Per-page log line:**
```
📝 [TEXT-REGION] P3: 38w@12pt — calmNeeded 39064px, calmFound 9421px
                in 192871px overlay (5% calm) — BELOW THRESHOLD → repair
```

## Text-space-repair loop (initial generation)

When `calmFound < calmNeeded`:

1. Build `textSpaceRepair` prompt with the scene description (max 1200 chars).
2. Pass `textAreaMask` (a pre-built B/W layout PNG: black region marks the calm zone) as a reference image.
3. Call `generateImageOnly` with `previousImage: original`. Up to `REPAIR.maxRetries = 2` attempts.
4. After each attempt, re-detect calm pixels INSIDE the same polygon.
5. **Winner selection** (per-candidate fallback): prefer the candidate with the highest `overlayCalmPx`; if a candidate's probe failed, compare on `coverage` instead.
6. **Early exit**: stop attempting when an attempt's `overlayCalmPx ≥ calmNeededPx` (the metric that gated entry).
7. Persist all candidates as separate entries in `imageVersions[]` with `source: 'text-space-repair-N'` so the user can pick a different one in the dev panel.

## Step 7.5 — post-repair recovery

After the unified pipeline's repair rounds (iterate / inpaint / character-fix), Step 7.5 re-detects calm pixels on the active version of each repaired page. Skipped if:
- Layout is not text-in-image (`textAreaMask` absent)
- Active version's source is `'original'` (page wasn't repaired) or `'text-space-repair-*'` (already validated at initial gen)

If `calmFoundPx < calmNeededPx`, runs text-space-repair on the active image (up to `maxRetries` attempts), best by `overlayCalmPx` is added as a `'post-repair-text-space'` version. Wrapped in try/catch so a failure here cannot derail finalization.

## Renderers (production)

Both browser and PDF use the **same server-side renderer**: `server/lib/textOverlayRenderer.js → generateTextOverlay`. It:

1. Looks up the polygon via `getTextZonePolygon(textPosition, languageLevel, w, h)`.
2. Renders text at fixed 11px Georgia using Canvas, clipped to the polygon.
3. Returns a transparent PNG composited over the page image.

**Browser:** `StoryDisplay.tsx` and `SharedStoryViewer.tsx` (via `BookStoryPage`) request the overlay PNG from `/api/shared/:token/text-overlay/:pageNum` (or the authenticated equivalent) and layer it on the page image. While the PNG loads, a CSS gradient fallback is rendered using `getTextOverlayPosition` from `client/src/utils/textOverlay.ts`.

**PDF:** `server/lib/pdf.js` calls `generateTextOverlay` and bakes the composited image into the printed page.

Both apply `enforceSpreadTextPosition` before rendering. The shared viewer defaults to `showTextOverlay=false` on mobile and shows a translucent bottom strip instead.

## What's user-visible

- **Final composited page image** with white text on the calm zone — visible everywhere.
- **CSS fallback** during PNG load — visible briefly in `StoryDisplay`, never in the PDF or shared viewer.

## What's NOT user-visible (developer mode only)

- **`textRect`** (bbox of calm pixels) — written to DB, but not consumed by either renderer. Diagnostic metadata only.
- **`textCoverageReport`** with `calmNeededPx` / `calmFoundPx` / `overlayAreaPx` / `geometricPassed` — surfaced in dev panel.
- **`textSpaceCandidates`** — when text-space-repair runs (initial gen) or post-repair recovery fires (Step 7.5), all candidates persist as separate `imageVersions[]` entries. Selectable through the standard image-history modal in dev mode. **Not exposed to end users.**

## Key files

| File | Role |
|------|------|
| `prompts/story-unified.txt` | Sonnet draft + critical-review with parity / forbidden-side / collision checks |
| `server/lib/storyHelpers.js` | `enforceSpreadTextPosition`, `buildTextZoneInstruction`, `extractSceneMetadata` |
| `server/lib/textMasks.js` | `getTextAreaMask` (pre-built PNG masks), `getTextZonePolygon` (analytical polygon, **single source of truth for shape**), `polygonArea`, `sizeNameFor` |
| `server/config/textRegion.js` | `requiredTextPixels`, `requiredFontPt`, `countWords`, repair budget |
| `server/lib/textRegion.js` | `detectAndLightenTextRegion` — calmness measurement + polygon-aware calm count |
| `server/lib/textSpaceRepair.js` | **`ensureCalmZone` — single source of truth for the gate + repair loop** (used by both initial gen and post-repair recovery) |
| `server/lib/textOverlayRenderer.js` | `generateTextOverlay` — server-side text-on-image compositing |
| `server.js` (text-region phase) | calls `ensureCalmZone`, persists candidates + report |
| `server/lib/images.js` (Step 7.5) | calls `ensureCalmZone`, swaps active version on recovery win |
| `server/lib/pdf.js` | PDF rendering, calls `generateTextOverlay` |
| `client/src/utils/textOverlay.ts` | CSS fallback positioning + spread parity for the browser |
| `client/src/components/generation/StoryDisplay.tsx` | renders overlay PNG with CSS fallback |
| `client/src/pages/SharedStoryViewer.tsx` | shared viewer, mobile/desktop layouts |

## Outstanding caveats (not bugs, but worth knowing)

- The CSS fallback in `StoryDisplay` uses different visual styling (gradient ellipse / band) than the production canvas renderer (polygon-clipped text). It's only visible briefly during PNG load.
- `getTextSize` in `textOverlay.ts` is a per-CSS-fallback word-count bucket (`<20`/`<50`/`else`). It does NOT match the polygon's `languageLevel`-driven size. The fallback's gradient is a rough hint, not the production text shape.
- `textOverlayRenderer.js` font is fixed Georgia 11px. The server's `requiredTextPixels` formula assumes Helvetica metrics with 1.5× overhead — close enough for legibility budgeting, not a precise-per-glyph guarantee.
- PDF's combined-PDF path (`addStoryContentPages`) does not pre-compute a consistent font size across pages the way `addPictureBookPages` does. Visual font-size variation is possible in combined output. Tracked separately.
