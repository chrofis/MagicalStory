# Spec: Grok Imagine Improvements

**Date:** 2026-03-18
**Status:** Draft
**Based on:** Test results from `docs/grok-imagine-test-results.md`

## 1. Reference Image Format: Front-Only Crops

### Current Behavior
When using Grok Imagine for styled avatars, the full 2x2 avatar grid (face front, face profile, body front, body profile) is sent as reference. This wastes space — Grok doesn't need the profile views.

### Change
For Grok backend only, extract the **left column** of the 2x2 grid (face front + body front) and send that as the reference image. This gives Grok a larger, clearer view of the character's face and clothing.

### Implementation
- In `packReferences()` in `server/lib/grok.js`, when processing character photos:
  - Detect if the image is a 2x2 grid (width ~768, height ~1344, roughly 1:1.75 aspect ratio)
  - If so, crop to left half (0 to width/2, full height)
  - Otherwise use as-is
- This applies to page image generation and cover generation, NOT to styled avatar conversion (which sends the full grid to Gemini/Grok for style transfer)

## 2. Configurable Max Characters Per Scene

### Current Behavior
All image prompts enforce `MAX 3` characters per scene. This is hardcoded in the unified story prompt (`Characters (MAX 3):`).

### Change
Make max characters per scene a configurable parameter. Default stays at 3 for Gemini. For Grok, increase to 5 (tested to work well with front-only crops).

### Implementation
- Add `maxCharactersPerScene` to `MODEL_DEFAULTS` in `server/config/models.js`
  - Default: 3 (Gemini)
  - For Grok image backend: 5
- Add to `IMAGE_MODELS` config per model:
  ```js
  'grok-imagine': {
    ...
    maxCharactersPerScene: 5
  }
  ```
- In `story-unified.txt` prompt template, replace hardcoded `MAX 3` with `MAX {MAX_CHARACTERS_PER_SCENE}`
- In scene expansion prompt, pass this parameter
- In the outline parser where `Characters (MAX 3):` is parsed, make the regex accept any number: `Characters (MAX \d+):`

## 3. Grok-Based Character Repair: Cut-Out Method

### How It Works
1. Detect the problematic character's bounding box in the scene image (from quality evaluation)
2. Cut out that region from the scene image
3. Send the cut-out region + correct character reference photo to Grok edit endpoint
4. Grok regenerates just that small region with the correct character
5. Stitch the fixed region back into the original scene image

### Advantages
- Only regenerates a small area — rest of scene is pixel-perfect preserved
- Grok works better with fewer elements to handle
- No drift on other characters

### Implementation
- New function `repairCharacterCutout(sceneImage, bbox, characterRef, options)` in `server/lib/grok.js`
- Parameters:
  - `sceneImage`: full scene data URI
  - `bbox`: `{ x, y, width, height }` in pixels
  - `characterRef`: character reference photo data URI (front-only crop)
  - `options.padding`: percentage to expand bbox (default: 15% — captures context around the character)
  - `options.model`: Grok model to use (standard or pro)
- Process:
  1. Extract bbox region from scene (with padding) using sharp
  2. Send extracted region + character ref to Grok edit
  3. Prompt: "Replace the person in Image 1 with the person from Image 2. Match face, hair, and clothing exactly."
  4. Composite the result back into the original scene at the bbox position
- Add `'grok-cutout'` as an option in the repair method selector (alongside Gemini and MagicAPI)

## 4. Grok-Based Character Repair: Blackout Method

### How It Works
1. Detect the problematic character's bounding box
2. Black out (or red-box) that region in the full scene image
3. Send the full scene (with blackout) + correct character reference to Grok edit
4. Grok regenerates the full image, filling the blacked-out area with the correct character

### Advantages
- Grok has full scene context (lighting, composition, other characters)
- Colored box technique tested to work — Grok understands "replace the colored box"

### Disadvantages
- Full image regeneration — risk of drift on other characters (mitigated by the blackout focusing Grok's attention)
- Non-deterministic results

### Implementation
- New function `repairCharacterBlackout(sceneImage, bbox, characterRef, options)` in `server/lib/grok.js`
- Parameters:
  - `sceneImage`: full scene data URI
  - `bbox`: `{ x, y, width, height }` in pixels
  - `characterRef`: character reference photo data URI
  - `options.boxColor`: color of the mask (default: 'red' — tested to work best)
  - `options.expandPercent`: expand bbox by this percentage (default: 20%)
  - `options.model`: Grok model to use
- Process:
  1. Overlay a colored box on the bbox region using sharp
  2. Send masked scene + character ref to Grok edit
  3. Prompt: "Image 1 is a scene with a {COLOR} BOX covering one person. Replace the {COLOR} BOX with the person from Image 2 ({description}). Remove the box completely. Keep all other people exactly as they are."
  4. Return the full regenerated image
- Add `'grok-blackout'` as an option in the repair method selector

## 5. UI Changes

### Repair Method Selector
Current dropdown in RepairWorkflowPanel has:
- Image Generation: Gemini, Grok, FLUX
- Face Repair: MagicAPI

Add new options:
```
── Image Generation ──
  Gemini 2.5 Flash Image
  Grok Imagine ($0.02)
  ...
── Character Repair ──
  Gemini (inpainting)
  MagicAPI Face+Hair
  Grok Cut-Out ($0.02)
  Grok Blackout ($0.02)
```

### Developer Mode: Max Characters Per Scene
Add a numeric input or dropdown in the ModelSelector for `maxCharactersPerScene` (range 1-8, default based on selected image model).

## 6. Priority & Order

1. **Front-only crops** — simplest change, biggest impact on reference quality
2. **Configurable max characters** — prompt template change + parser update
3. **Cut-out repair** — most reliable repair method (no drift)
4. **Blackout repair** — alternative repair method (full context)
5. **UI changes** — wire up new options

## 7. Cost Impact

| Operation | Current | After |
|-----------|---------|-------|
| Page image (3 chars) | $0.02 | $0.02 (same) |
| Page image (5 chars) | N/A (capped at 3) | $0.02 |
| Character repair (cut-out) | $0.035 (Gemini) | $0.02 (Grok) |
| Character repair (blackout) | N/A | $0.02 (Grok) |
