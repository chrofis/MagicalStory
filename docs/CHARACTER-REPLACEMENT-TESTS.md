# Character Replacement Technology Tests

This document tracks testing of various AI tools for character replacement/swapping in story scenes.

---

## Goal

Replace character A in a scene with character B while preserving:
- Scene composition (background, objects, lighting)
- Character pose
- Art style consistency

---

## FLUX Kontext Testing (February 2025)

### What We Tested
- **Provider:** Runware
- **Model ID:** `runware:106@1` (FLUX.1 Kontext [dev])
- **Cost:** ~$0.02/image

### Test 1: Using referenceImages Parameter

**Approach:**
```javascript
{
  seedImage: sceneWithCharacterA,
  referenceImages: [characterBReference],
  prompt: "Replace the person with this girl"
}
```

**Result:** ❌ FAILED
- Model generated completely unrelated image (TV wrapped in plastic)
- Scene was not preserved at all
- Character reference was ignored

### Test 2: Image Stitching Approach

**Approach:**
- Stitched scene + character reference side-by-side
- Used stitched image as single input
- Prompt: "Replace the person in the left image with the girl from the right image"

**Result:** ❌ PARTIAL - Not suitable for our use case
- Scene composition changed significantly
- Character pose not preserved
- Character likeness loosely approximated but not accurate

### Key Findings

| Finding | Details |
|---------|---------|
| **Not a character swapper** | FLUX Kontext is an instruction-based editor, not a face/character swap tool |
| **referenceImages ignored** | For Kontext, this param is for style guidance, not character insertion |
| **Stitching workaround limited** | Model "remixes" rather than precisely swaps |
| **Good for** | Style transfer, background changes, text editing, artistic remixing |
| **Not good for** | Precise character replacement while preserving scene |

### Documentation Sources
- [Runware Blog](https://runware.ai/blog/introducing-flux1-kontext-instruction-based-image-editing-with-ai)
- [ComfyUI Multi-Image Guide](https://comfyui-wiki.com/en/tutorial/advanced/image/flux/flux-1-kontext)
- [Replicate FLUX Kontext](https://replicate.com/blog/flux-kontext)

### Supported Dimensions (Runware)
```
1568x672, 1504x688, 1456x720, 1392x752, 1328x800, 1248x832,
1184x880, 1104x944, 1024x1024, 944x1104, 880x1184, 832x1248,
800x1328, 752x1392, 720x1456, 688x1504, 672x1568
```

---

## PuLID Testing (January 2025 - Replicate)

### Previous Test Results

Tested via Replicate's `zsxkib/flux-pulid` model.

**Result:** ❌ NOT RECOMMENDED

| Issue | Description |
|-------|-------------|
| Smooth/painterly skin | All outputs look like digital paintings, not photos |
| Identity drift | Randomly adds facial hair, changes age, adds features |
| Pose prompts ignored | "3/4 view" never worked - always front-facing |
| Unpredictable | Same settings produce different results each time |
| Expensive for quality | ~$0.07/image at 1536x1536 for mediocre results |

**Best settings found (still not good enough):**
```javascript
{
  true_cfg: 6,
  id_weight: 1.5,
  guidance_scale: 7,
  width: 1536,
  height: 1536
}
```

### Runware PuLID (February 2025)

Tested via `generateWithPuLID()` in `server/lib/runware.js` using FLUX Dev model.

**Model:** `runware:101@1` (FLUX.1 Dev)
**Cost:** ~$0.002/image (35x cheaper than Replicate!)
**Time:** ~10 seconds

**Test prompt:**
```
"Young girl in a purple jacket standing in a medieval covered wooden bridge,
holding a wooden table with another person, children book illustration style"
```

**Result:** ✅ Works for generation, ❌ NOT for replacement
- Generated a NEW scene with children at archway
- Girl somewhat resembles Sophie reference
- But this is TEXT-TO-IMAGE with face identity, NOT scene editing

**Key Finding:** PuLID generates new images with face consistency.
It does NOT replace characters in existing scenes.

| Use Case | PuLID Suitable? |
|----------|-----------------|
| Generate avatar with face consistency | ✅ Yes |
| Create new scene with specific character | ✅ Yes |
| Replace character in existing scene | ❌ No |

---

## ACE++ Testing

### Current Implementation

Available via `generateAvatarWithACE()` in `server/lib/runware.js`.

**What it does:**
- Uses FLUX Fill model with ACE++ configuration
- Preserves facial identity from reference photo
- Good for portrait generation

**Limitations:**
- Designed for portrait generation, not scene character replacement
- Type: 'portrait' mode for face-consistent avatars

**Cost:** ~$0.005/image

---

## Recommended Approach for Character Replacement

Based on testing, the best approach for replacing a character in a scene:

### Option 1: Inpainting Workflow (Recommended)
1. **Detect character bounding box** in scene (using existing evaluation)
2. **Create mask** for character region
3. **Inpaint with description** of new character

```javascript
// Use existing inpaintWithRunware()
await inpaintWithRunware(sceneImage, characterMask,
  "Young girl with brown hair in purple jacket, same pose",
  { model: RUNWARE_MODELS.FLUX_FILL }
);
```

### Option 2: Full Regeneration
- Regenerate the scene with new character description
- Pass new character's avatar as reference
- Loses exact scene composition

### Option 3: Composite Approach
1. Generate new character in matching pose separately
2. Remove old character from scene (inpaint background)
3. Composite new character into scene

---

## Test Files

| File | Purpose |
|------|---------|
| `tests/manual/test-flux-kontext.js` | FLUX Kontext testing |
| `tests/manual/test-inpaint.js` | Inpainting testing |
| `server/lib/runware.js` | All Runware integrations |

---

## Summary

| Tool | What It Does | Character Replacement | Scene Preservation | Cost | Recommended |
|------|--------------|----------------------|-------------------|------|-------------|
| FLUX Kontext | Instruction-based editing | ❌ Remixes scene | ❌ Poor | $0.02 | No |
| PuLID (Replicate) | Text-to-image + face | ❌ Generates new scene | N/A | $0.07 | No |
| PuLID (Runware) | Text-to-image + face | ❌ Generates new scene | N/A | $0.002 | For new scenes only |
| ACE++ | Portrait generation | N/A | N/A | $0.005 | For avatars only |
| Inpainting | Region replacement | ✅ With mask | ✅ Good | $0.002-0.05 | **Yes** |

## Inpainting Tests (February 2025)

### FLUX Fill Inpainting ✅ WINNER

**Result:** Excellent - Best approach for character replacement

| Aspect | Result |
|--------|--------|
| Scene preserved | ✅ Background, lighting, composition intact |
| Other characters preserved | ✅ Untouched |
| Pose preserved | ✅ Same pose as original |
| Style consistent | ✅ Matches illustration style |
| Cost | $0.002/image |
| Time | ~13 seconds |

**How it works:**
```javascript
await inpaintWithRunware(sceneImage, characterMask,
  "young girl with brown hair in red medieval dress, carrying table",
  { model: RUNWARE_MODELS.FLUX_FILL }
);
```

**Limitation:** Text description only - new character matches description, not a specific face reference.

### ACE++ Local Editing ❌ NOT SUITABLE

**Result:** Destroys scene, not usable for character replacement

| Aspect | Result |
|--------|--------|
| Scene preserved | ❌ Completely destroyed |
| Pose preserved | ❌ Wrong pose |
| Face matches reference | ⚠️ Somewhat |
| Cost | $0.05/image |

**Problem:** ACE++ prioritizes the reference face over scene preservation, resulting in a completely new image.

---

---

## Face Swap Tests (February 2025) ✅ BEST SOLUTION

### Replicate codeplugtech/face-swap ✅ WINNER

**Result:** Excellent - This is the real solution for character face replacement!

| Aspect | Result |
|--------|--------|
| Scene preserved | ✅ Perfect - background, lighting, composition |
| Poses preserved | ✅ All poses intact |
| Faces swapped | ✅ Accurately replaces faces with reference |
| Art style | ✅ Maintained |
| Cost | **$0.003/run** |
| Time | ~60 seconds |

**How it works:**
```javascript
// Replicate API
const result = await replicate.run("codeplugtech/face-swap", {
  input: {
    input_image: sceneImageUrl,   // Target scene with person(s)
    swap_image: faceReferenceUrl  // Face to swap in
  }
});
```

**Key behavior:**
- Detects ALL faces in the target image
- Swaps ALL detected faces with the source face
- Preserves pose, clothing, lighting, background perfectly

### Optimization Tests (February 2025)

| Approach | Result |
|----------|--------|
| Full photo as source | Works - swaps all faces |
| Cropped face as source | Works - similar quality |
| Two-pass (swap result again) | More consistent swap on all faces |
| **Selective: crop→swap→composite** | ✅ **Best for single person swap** |
| Frontal face only | Works well |

### For selective face swap (only one person):

```javascript
// 1. Crop scene to isolate target person
const rightHalf = await sharp(sceneBuffer)
  .extract({ left: Math.round(width * 0.45), top: 0, width: Math.round(width * 0.55), height })
  .toBuffer();

// 2. Face swap on cropped region only
const swappedRight = await runFaceSwap(rightHalf, sophiePhoto);

// 3. Composite back into original scene
const final = await sharp(sceneBuffer)
  .composite([{ input: swappedRight, left: Math.round(width * 0.45), top: 0 }])
  .toBuffer();
```

### Source image recommendations:
- **Frontal face** works best
- Can use full photo or cropped face - similar results
- Clear, well-lit source faces produce better results
- Reference sheet with multiple angles can work, but single frontal is simpler

**API Details:**
- Model: `codeplugtech/face-swap`
- Version: `278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34`
- Cost: ~$0.003/run (~333 runs per $1)
- Hardware: CPU (no GPU needed)

---

## Final Conclusion

### Best Approach: Replicate Face Swap

For face replacement in existing scenes:

```javascript
// Using Replicate API
const Replicate = require('replicate');
const replicate = new Replicate();

const output = await replicate.run(
  "codeplugtech/face-swap:278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34",
  {
    input: {
      input_image: sceneImageUrl,   // Scene with character(s)
      swap_image: faceReferenceUrl  // Face to swap in
    }
  }
);
```

### Comparison Summary

| Tool | Scene Preservation | Face Match | Cost | Recommendation |
|------|-------------------|------------|------|----------------|
| **Replicate face-swap** | ✅ Perfect | ✅ Excellent | $0.003 | **USE THIS** |
| FLUX Fill Inpaint | ✅ Excellent | ❌ Text only | $0.002 | For text-based replacement |
| ACE++ local_editing | ❌ Destroyed | ⚠️ Partial | $0.05 | Don't use |
| FLUX Kontext | ❌ Remixed | ❌ None | $0.02 | Don't use |
| PuLID | N/A (new scene) | ✅ Good | $0.002 | For new scenes only |

### When to Use Each Tool

| Use Case | Best Tool |
|----------|-----------|
| **Swap face in scene (preserve everything)** | **Replicate face-swap** |
| Replace character with text description | FLUX Fill Inpainting |
| Generate new scene with specific face | PuLID |
| Generate avatar with face consistency | ACE++ portrait / PuLID |
| Edit text/colors/style in image | FLUX Kontext |

---

## Test Files

| File | Description |
|------|-------------|
| `tests/manual/test-face-swap.js` | **Face swap test script (BEST)** |
| `tests/manual/test-character-replacement.js` | Inpainting test script |
| `tests/manual/test-flux-kontext.js` | FLUX Kontext test script |
| `tests/fixtures/test-faceswap-replicate.png` | **Replicate face swap result ✅ BEST** |
| `tests/fixtures/test-faceswap-comparison.png` | Face swap comparison |
| `tests/fixtures/test-inpaint-flux-result.png` | FLUX Fill inpaint result |
| `tests/fixtures/test-replacement-ace.png` | ACE++ result ❌ |

---

## IP-Adapter FaceID Tests (February 2025) ✅ BEST FOR ILLUSTRATIONS

### The Problem with Face Swap for Illustrations

Face swap models (codeplugtech, inswapper) are trained on **photorealistic** images. When used on illustrations:
- Identity is poorly preserved
- Style mismatch causes blending issues
- Face doesn't match the source

### Solution: IP-Adapter FaceID

**IP-Adapter FaceID** generates NEW images conditioned on a face identity. It can apply any style while preserving facial features.

**API on Replicate:** `lucataco/ip-adapter-faceid`
**Version:** `fb81ef963e74776af72e6f380949013533d46dd5c6228a9e586c57db6303d7cd`

```javascript
const output = await replicate.run("lucataco/ip-adapter-faceid:fb81ef96...", {
  input: {
    face_image: sophiePhotoUrl,
    prompt: "children book illustration of a young girl in red medieval dress, whimsical style",
    negative_prompt: "realistic, photorealistic, photo, blurry",
    width: 1024,
    height: 1024,
    agree_to_research_only: true
  }
});
```

### Comparison Results

| Method | Identity Match | For Illustrations |
|--------|----------------|-------------------|
| Face Swap (codeplugtech) | ❌ Weak | ❌ Not suitable |
| **IP-Adapter FaceID** | ✅ Strong | ✅ **Best choice** |

### What Each Tool Does

| Tool | Function |
|------|----------|
| **Face Swap** | Swaps face in EXISTING image (photo→photo only) |
| **IP-Adapter FaceID** | Generates NEW image with face identity + style |

### For Illustrated Children's Books

Use **IP-Adapter FaceID** to generate scene illustrations with consistent character faces:
1. Upload child's photo as `face_image`
2. Describe scene in `prompt` with art style
3. Generate illustration that resembles the child

---

## Environment Variables

```bash
# Required for Replicate APIs
REPLICATE_API_TOKEN=your_token_here

# Optional (for fal.ai testing)
FAL_KEY=your_key_here
```
