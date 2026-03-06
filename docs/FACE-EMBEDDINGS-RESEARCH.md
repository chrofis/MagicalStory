# Face Embeddings & Identity Preservation Research

## Current Approach

Our current pipeline:
```
Photo → Python face detection (MTCNN) → Gemini image generation → 2x2 character sheet
                                              ↓
                                     Avatar evaluation (traits extraction)
```

**Current costs:**
| Component | Provider | Cost | Quality |
|-----------|----------|------|---------|
| Avatar generation | Gemini 2.5 Flash Image | ~$0.03/img | Good, but no face embedding |
| Dev mode avatars | Runware ACE++ | ~$0.005/img | Uses FLUX Fill + face reference |
| Inpainting | Runware SDXL | ~$0.002/img | Good for repairs |

**Current weaknesses:**
1. No face embedding - Gemini generates from prompt + reference image but doesn't extract facial landmarks
2. Identity drift - Each generation is independent, no "anchor" for identity
3. Profile views struggle - Without landmarks, 3/4 and profile views can diverge

---

## What Are Face Embeddings?

A **face embedding** is a numerical representation of a face - a vector of ~512 numbers that uniquely describes someone's facial features.

```
Photo of person → Face Recognition Model → [0.023, -0.156, 0.892, ..., 0.034]
                   (InsightFace/ArcFace)         ↑
                                           512 numbers that ARE this face
```

Think of it like a fingerprint for faces. Two photos of the same person produce similar vectors. Different people produce different vectors.

### What InsightFace Extracts

| Feature | What it captures |
|---------|------------------|
| Face shape | Oval, round, square, heart |
| Eye geometry | Size, spacing, tilt, depth |
| Nose structure | Bridge height, width, tip shape |
| Mouth | Width, lip thickness, smile line |
| Bone structure | Cheekbones, jaw, chin |
| Proportions | All ratios between features |

### How Current Generation Works (Without Embeddings)

```
Prompt: "Generate a 2x2 character sheet of this person"
        + Reference image (raw pixels)
                    ↓
              Gemini sees pixels
              Tries to copy what it sees
              Each view is a NEW interpretation
                    ↓
              Front view: looks like person
              Profile view: might drift (different nose, jawline)
```

**Problem:** Gemini doesn't "understand" the face mathematically. It just tries to copy pixels.

### How It Works WITH Face Embeddings

```
Photo → InsightFace extracts:
        - Face embedding: [0.023, -0.156, 0.892, ...]  (identity)
        - Landmarks: eye positions, nose tip, mouth corners
                    ↓
        These are INJECTED into the generation model
                    ↓
        Model is FORCED to maintain these specific features
        across ALL generated views
```

### Why This Helps

| Problem We Have | How Embeddings Fix It |
|-----------------|----------------------|
| Profile view looks like different person | Same embedding enforces same bone structure |
| Nose changes between views | Nose shape locked in embedding |
| Eyes look different at angles | Eye geometry preserved mathematically |
| Multiple regenerations drift | Same embedding = same face every time |
| Child looks older/younger in different views | Age-related proportions locked |

---

## Alternative Technologies

### PuLID-FLUX (Best Identity Fidelity)

```
Photo → InsightFace embedding → PuLID-FLUX → Generated image
```

| Aspect | Details |
|--------|---------|
| **Cost** | ~$0.02/image on Replicate |
| **Identity Fidelity** | ~90%+ (best in class) |
| **API** | Replicate `zsxkib/flux-pulid` |
| **Pros** | Best detail preservation, tuning-free |
| **Cons** | Rigidly copies hair/pose, resource heavy, single image only |

**Key parameters:**
- `id_weight`: 0-3 (controls identity strength, default 1)
- `start_step`: 0-1 for high fidelity, 4 for editability
- `num_steps`: 1-20 denoising iterations (default 20)

### InstantID (Balance of Quality/Speed)

```
Photo → InsightFace + ControlNet landmarks → InstantID → Generated image
```

| Aspect | Details |
|--------|---------|
| **Cost** | ~$0.01-0.02/image on Replicate |
| **Identity Fidelity** | ~82-86% |
| **API** | Replicate `zsxkib/instant-id` |
| **Pros** | Good balance, text editability, SDXL-based |
| **Cons** | Subtle features can diminish |

**Key parameters:**
- `controlnet_conditioning_scale`: Higher = more identity
- `ip_adapter_scale`: Higher = more face fidelity

### Gemini 3 Pro Image (Nano Banana Pro)

| Aspect | Details |
|--------|---------|
| **Cost** | ~$0.15/image |
| **Identity Fidelity** | Very good for single person |
| **API** | Already have Gemini API |
| **Pros** | Multi-person support (up to 5), 3-5 seconds, complex prompts |
| **Cons** | 5x more expensive than current |

---

## Capability Comparison

| Capability | Gemini | PuLID-FLUX | InstantID | ACE++ |
|------------|--------|------------|-----------|-------|
| Face identity preservation | Medium | Excellent | Good | Good |
| 2x2 grid character sheets | Yes | **No** | **No** | **No** |
| Complex prompt following | Excellent | Limited | Limited | Limited |
| Multiple poses in one image | Yes | No | No | No |
| Clothing changes | Yes | Limited | Limited | Good |
| Art style control | Good | Basic | Basic | Basic |
| Multi-person scenes | Yes (up to 5) | No | No | No |

**Key limitation:** PuLID/InstantID are **single-image generators**. They cannot generate our 2x2 character sheet layout directly.

---

## Cost Comparison

| Method | Cost/Image | Identity Quality | Can Do Grid? |
|--------|------------|------------------|--------------|
| Gemini 2.5 Flash | $0.03 | Medium | Yes |
| Runware ACE++ | $0.005 | Medium-Good | No |
| PuLID-FLUX | $0.02 | Excellent | No |
| InstantID | $0.02 | Good | No |
| Gemini 3 Pro | $0.15 | Very Good | Yes |

---

## Implementation Options

### Option A: Hybrid - PuLID for Each Quadrant
```
1. Use PuLID to generate 4 SEPARATE images (front, 3/4, full front, full side)
2. Stitch them together into 2x2 grid ourselves

Cost: 4 × $0.02 = $0.08 per character sheet
Pros: Best face consistency
Cons: 4x API calls, need stitching code, slower
```

### Option B: Keep Gemini, Add Face Repair
```
1. Gemini generates 2x2 sheet (current approach)
2. If face looks wrong, use PuLID to regenerate just that quadrant
3. Composite the fixed face back

Cost: $0.03 + $0.02 if fix needed
Pros: Usually works, only pay extra when needed
Cons: Complex compositing
```

### Option C: Improve ACE++ Usage
```
Already integrated for dev mode
Test with better prompting

Cost: $0.005/image
Pros: Already integrated, cheap
Cons: May not match PuLID quality
```

### Option D: Upgrade to Gemini 3 Pro
```
Better identity preservation built-in
"up to 5 people consistent"

Cost: $0.15/image (5x current)
Pros: Single API, best prompt following
Cons: Expensive
```

---

## Recommended Next Steps

1. **Trial PuLID** - Single photo, single output to test quality
2. **Compare results** - Same photo through Gemini vs PuLID vs ACE++
3. **Decide architecture** - Based on quality/cost tradeoff
4. **If PuLID wins** - Implement 4-image + stitching approach

---

## Testing Results (January 2025)

### Conclusion: Not Recommended

After extensive testing with Replicate's PuLID-FLUX, the technology is **not suitable** for our use case.

**Problems found:**
| Issue | Description |
|-------|-------------|
| Smooth/painterly skin | All outputs look like digital paintings, not photos |
| Identity drift | Randomly adds facial hair, changes age, adds features (pigtails) |
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
  height: 1536,
  prompt: "extremely sharp photograph, hyper detailed, 8k, raw photo, DSLR, Canon 5D Mark IV, 85mm lens, f/2.8, perfect sharp focus on face, every pore visible, studio lighting, neutral gray background, no retouching, documentary style portrait"
}
```

**What PuLID is actually good for:**
- Stylized/artistic character portraits
- Rough identity transfer for illustrations
- NOT photorealistic face recreation

**Recommendation:** Stick with Gemini for avatar generation. It's designed for illustrated content, follows prompts better, and generates all 4 views in one image.

---

## Implementation Status

### Runware PuLID Integration (Added)

We already have Runware API access, and Runware supports PuLID! No additional API keys needed.

**Files:**
- `server/lib/runware.js` - Added `generateWithPuLID()` function
- `scripts/test-pulid.js` - Test script to compare PuLID vs ACE++

**Test Commands:**
```bash
# Test PuLID
node scripts/test-pulid.js path/to/photo.jpg "portrait as pirate"

# Test ACE++ for comparison
node scripts/test-pulid.js path/to/photo.jpg "portrait as pirate" --ace

# Compare outputs
# - pulid-test-output.png
# - ace-test-output.png
```

**Cost Comparison (via Runware):**
| Method | Model | Cost |
|--------|-------|------|
| PuLID | FLUX Dev | ~$0.004/image |
| ACE++ | FLUX Fill | ~$0.005/image |
| Current | Gemini Flash | ~$0.03/image |

---

## Sources

- [PuLID-FLUX on Replicate](https://replicate.com/zsxkib/flux-pulid)
- [InstantID on Replicate](https://replicate.com/zsxkib/instant-id)
- [InstantID vs PuLID Comparison 2025](https://apatero.com/blog/instantid-vs-pulid-vs-faceid-ultimate-face-swap-comparison-2025)
- [InstantID GitHub](https://github.com/instantX-research/InstantID)
- [PuLID GitHub](https://github.com/ToTheBeginning/PuLID)
- [Nano Banana Pro - Google AI](https://ai.google.dev/gemini-api/docs/image-generation)
- [ACE++ Character Consistency](https://www.runcomfy.com/comfyui-workflows/ace-plus-plus-character-consistency)
- [Runware Pricing](https://runware.ai/pricing)
