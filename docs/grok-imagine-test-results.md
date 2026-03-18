# Grok Imagine Character Reproduction Tests

**Date:** 2026-03-18
**Model:** grok-imagine-image (Standard, $0.02/image)
**API:** xAI /images/edits endpoint

## Key Finding

Grok's edit endpoint does **full image regeneration**, not inpainting. Every call regenerates the entire image, causing drift on characters that should stay unchanged. This makes iterative refinement unreliable.

## Test Results

### 1. Single-Shot Generation (v3_test_*.jpg)

Using front-facing body crops (left column of 2x2 avatar grid) as references.

| Test | Characters | Ref Slots | Quality | Face Match | Clothing Match |
|------|-----------|-----------|---------|------------|----------------|
| 3 chars (1 per slot) | Lukas, Manuel, Sophie | 3 | Excellent | Good | Very good |
| 4 chars (4 stitched, 1 slot) | +Franziska | 1 | Great | Good | Good |
| 5 chars (2+2+1) | +Roger | 3 | Very good | Moderate | Good |
| 8 chars (3+3+2) | +Werner, Uschi, Verena | 3 | Decent | Weak | Rough |

**Conclusion:** 3-5 characters is the sweet spot. Beyond 5, faces become generic.

### 2. Single Character Replacement (v3_test_replace_marcel.jpg)

Replace one character by description ("replace the woman on the back left wearing black pullover with Marcel from Image 2").

**Result:** Worked well. Marcel appeared with correct clothing (navy hoodie with M logo). All other 7 characters preserved.

### 3. Red Box Replacement (v3_test_redbox_big_verena.jpg)

Cover target person with a red box, then tell Grok to "replace the RED BOX with person from Image 2".

| Box Size | Result |
|----------|--------|
| Small (face only) | Replaced but face didn't match reference well |
| Large (face + upper body) | Cleaner fill, but still generic face |

**Conclusion:** Red box helps Grok locate WHERE to replace, but face likeness from reference remains weak for replacement tasks.

### 4. Dual Colored Box Replacement (v3_test_redgreen_verena_werner.jpg)

Red box on person A, green box on person B. Send scene + 2 reference crops. Tell "red = Image 2, green = Image 3".

**Result:** Both boxes replaced in one pass. Grok understood the color-to-image mapping. Clothing matched better than faces.

### 5. Iterative Single Replacement (v3_test_werner_single.jpg)

Chain of: 8-char scene -> replace Marcel -> replace Verena -> replace Werner (one per call).

**Result:** Non-deterministic. Same prompt + same image gave different results on retry. Sometimes replaced the wrong person. Sometimes worked perfectly.

### 6. Progressive Ghost Approach (v2_step*.jpg)

Step 1: Generate 3 real characters + 8 numbered ghost silhouettes.
Step 2: Send result + 2 ref images, tell to fill ghosts 1-4.
Step 3: Send result + 2 ref images, tell to fill ghosts 5-8.

**Result:** Scene consistency across passes was good. Ghosts replaced successfully. But some characters from earlier steps got lost or modified. Numbered ghost labels persisted as artifacts.

### 7. "Fix Consistency" Approach (v3_fix_*.jpg)

Tell Grok "these people are already at the table but don't look exactly right, fix them to match reference".

**Result:** Failed. Each pass degraded ALL characters due to full image regeneration. Cumulative drift made everything worse after 2 passes.

## Reference Image Findings

| Format | Quality |
|--------|---------|
| Full 2x2 avatar grid | Poor — faces too small when stitched |
| 2x2 grids stitched with `fit: cover` | Terrible — heads cut off |
| Front column only (face+body front) | Best — clear face and clothing |
| Front columns stitched side-by-side | Good — up to 4 per image works |

## API Behavior Notes

- **aspect_ratio ignored for single image edits** — output matches input image dimensions
- **3 reference image slots max** — must stitch characters to fit
- **8000 char prompt limit** (exclusive — rejects >= 8000)
- **Full regeneration, not inpainting** — every pixel is regenerated, no masking support
- **Non-deterministic** — same prompt + same image can give different results
- **~10-15s per generation** at $0.02/image

## Recommendations

1. **Use 1-3 characters per scene** for best quality (matches story pipeline MAX 3 rule)
2. **Front-only crops** as references (not full 2x2 grids)
3. **Single-shot generation** is more reliable than iterative replacement
4. **Don't chain edits** — each pass introduces drift on all characters
5. **Colored box technique** works for targeting, but face likeness is weak
6. **For character repair**, Gemini inpainting is still superior (actual masking support)
