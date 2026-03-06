# Multi-Character Cover Generation Tests

This document tracks experiments for generating cover images with many characters (5-10+).

**Problem:** Cover images ideally show all main characters together (up to 10), but AI image generation struggles with:
- Maintaining distinct identities for many characters
- Consistent composition when adding characters iteratively
- Matching art style when stitching separately-generated parts

**Test Date:** January 29-30, 2025

---

## Summary of Results

| Approach | Result | Main Issue |
|----------|--------|------------|
| Single-shot 10 chars | ❌ Failed | Characters blend together, identity loss |
| Iterative add (3→6→10) | ❌ Failed | Identity drift - characters "mix" together |
| Ghost + external inpaint (FLUX/ACE++) | ❌ Failed | Inpainted figures don't match style |
| Ghost + Gemini edit | ❌ Failed | Gemini re-interprets whole scene, ignores ghost |
| Multi-turn conversation | ❌ Failed | No better than single-shot |
| Stitching separate parts | ❌ Failed | Scene elements (table, background) change between generations |

**Conclusion:** No reliable method found for 10+ character covers. Current limit is ~3-4 characters with acceptable consistency.

---

## Approach 1: Single-Shot Generation

### What We Tested
Generate all 10 characters in a single prompt with all reference images.

### Test Files
- `tests/manual/test-output/10-chars-*/10-characters.png`
- `tests/manual/test-output/table-test-*/test1-3chars-*.png` (baseline)
- `tests/manual/test-output/table-test-*/test2-6chars-gemini20.png`
- `tests/manual/test-output/table-test-*/test3-10chars-gemini20.png`

### Results

| Characters | Model | Result |
|------------|-------|--------|
| 3 | Gemini 2.0 | ✅ Good - distinct identities |
| 3 | Gemini 2.5 | ✅ Good - higher quality |
| 6 | Gemini 2.0 | ⚠️ Some identity mixing |
| 10 | Gemini 2.0 | ❌ Severe identity mixing |
| 10 | Gemini 2.5 | ❌ Characters blend together |

### Key Finding
Beyond 4-5 characters, the model starts "averaging" faces. Reference images compete for attention and identities merge.

---

## Approach 2: Iterative Build-Up

### What We Tested
Start with 3 characters, then ask the model to add 3 more to the existing image, repeat until 10.

```
Step 1: Generate base image with 3 characters
Step 2: "Add characters 4, 5, 6 to this image, keep existing characters identical"
Step 3: "Add characters 7, 8, 9, 10 to this image..."
```

### Test Files
- `tests/manual/test-output/iterative-table-*/01-base-3chars.png`
- `tests/manual/test-output/iterative-table-*/02-added-3more-6total.png`
- `tests/manual/test-output/iterative-table-*/03-final-10chars.png`
- `tests/manual/test-output/iterative-10-*/01-4chars.png`
- `tests/manual/test-output/iterative-10-*/02-7chars.png`
- `tests/manual/test-output/iterative-10-*/03-10chars.png`

### Results

| Step | Result |
|------|--------|
| Base (3-4 chars) | ✅ Good |
| +3 more (6-7 total) | ⚠️ Original characters start changing |
| +3 more (9-10 total) | ❌ Total mixture - identities blended |

### Key Finding
When adding new characters, the model doesn't preserve existing characters properly. It re-interprets the entire scene, causing original characters to drift toward the new ones.

**"Total mixture"** - characters that looked distinct in step 1 become averaged/blended by step 3.

---

## Approach 3: Ghost Placeholders + Inpainting

### What We Tested
1. Generate image with real characters + ghost/silhouette placeholders
2. Use bounding box detection to find ghost regions
3. Inpaint each ghost with a real character using ACE++/FLUX Fill

```
Step 1: "3 real children + 7 grey silhouette placeholders around a table"
Step 2: Detect bbox for each ghost
Step 3: For each ghost: mask region → inpaint with character reference
```

### Test Files
- `tests/manual/test-output/placeholder-*/01-2real-8placeholders.png`
- `tests/manual/test-output/numbered-ghosts-*/table-3real-7ghosts.png`
- `tests/manual/test-output/numbered-ghosts-*/ghost-mask.png`
- `tests/manual/test-output/numbered-ghosts-*/ace-inpaint-result.png`
- `tests/manual/test-output/numbered-ghosts-*/full-inpaint-result.png`
- `tests/manual/test-output/numbered-ghosts-*/manuel-replaced.png`

### Results

| Step | Result |
|------|--------|
| Generate with ghosts | ✅ Works - clear placeholder positions |
| Detect ghost bboxes | ✅ Works |
| Inpaint with FLUX Fill (text) | ⚠️ Generic faces, don't match characters |
| Inpaint with ACE++ (reference) | ❌ Style mismatch - inpainted figures look different |
| **Gemini edit own image** | ❌ Re-interprets whole scene, ignores ghost |

### Key Findings

**External inpainting (FLUX/ACE++):** Style mismatch - inpainted figures look "pasted in" rather than natural. ACE++ prioritizes face identity over style matching, resulting in realistic-looking faces in a cartoon scene.

**Gemini editing its own output:** Even when using Gemini to edit a Gemini-generated image, asking it to "replace this ghost with this character" causes it to **re-interpret the entire scene** rather than doing a localized edit. This is the same failure mode as the iterative approach - the model can't preserve the existing image while making targeted changes.

---

## Approach 4: Multi-Turn Conversation

### What We Tested
Use Gemini's multi-turn chat to maintain context across requests.

```
Turn 1: "Generate Sophie at a table"
Turn 2: "Add Manuel to her left, keep Sophie identical"
Turn 3: "Add Lukas to her right, keep both existing characters identical"
...continue for all characters
```

### Test Files
- `tests/manual/test-output/multi-turn-*/multi-turn-result.png`
- `tests/manual/test-output/multi-turn-base-*/`

### Results
❌ **No improvement over iterative approach**

The conversation context doesn't prevent identity drift. The model still re-interprets the scene with each addition.

### Key Finding
Multi-turn memory helps with text/reasoning tasks but doesn't create a persistent "lock" on character identities in image generation.

---

## Approach 5: Stitching Separate Parts

### What We Tested
Generate different parts of the scene separately, then composite them:

```
1. Generate left side: table + 3 characters
2. Generate right side: same table + 3 different characters
3. Stitch left + right halves together
```

### Test Files
- `tests/manual/test-output/seating-*/table.png`
- `tests/manual/test-output/seating-*/table-4people.png`
- `tests/manual/test-output/seating-*/table-4people-v2.png`
- `tests/manual/test-output/seating-*/table-edited-v3.png`
- `tests/manual/test-output/seating-*/table-edited-v4.png`
- `tests/manual/test-output/numbered-ghosts-*/right-half-cropped.png`
- `tests/manual/test-output/numbered-ghosts-*/right-side-replaced.png`

### Results
❌ **Scene elements change between generations**

| Element | Consistent? |
|---------|-------------|
| Characters | ✅ Each half has correct characters |
| Table | ❌ Different shape/angle/style each time |
| Background | ❌ Lighting, colors, details change |
| Perspective | ❌ Camera angle shifts |

### Key Finding
Even with the same prompt, the model generates different scene elements each time. The table looked different in left vs right generations, making seamless stitching impossible.

Attempted workarounds:
- Describe table in detail → still varies
- Use same seed → not supported by Gemini
- Generate full scene, crop, regenerate half → perspective mismatch

---

## What Works (Limited)

### 3-4 Characters Maximum
Single-shot generation works acceptably with 3-4 characters:
- Pass all character reference images
- Detailed prompt with positions
- Accept some identity softening

### Cover Workarounds
Current production approach for covers with many characters:

1. **Foreground focus**: Show 2-3 main characters prominently, others as small/background figures
2. **Silhouettes**: Background characters as stylized silhouettes (no face detail needed)
3. **Split covers**: Front cover shows some characters, back cover shows others
4. **Symbolic representation**: Objects/items representing characters instead of showing all faces

---

## Technical Notes

### Gemini Limits
- Maximum reference images: ~14 (6 objects + 5 humans per docs)
- Effective human references: 3-4 before identity blending
- No seed control for reproducibility

### Cost Comparison

| Approach | Images Generated | Est. Cost |
|----------|------------------|-----------|
| Single-shot | 1 | $0.05 |
| Iterative (3 steps) | 3 | $0.15 |
| Ghost + inpaint (7 ghosts) | 8 | $0.40 |
| Multi-turn (10 chars) | 10 | $0.50 |

### Test Scripts
No dedicated script was created - tests were run manually via the Gemini API and various test files:
- `tests/manual/test-inpaint.js` - for ghost inpainting
- `tests/manual/test-character-replacement.js` - for ACE++ tests

---

## Future Ideas (Not Yet Tested)

1. **ControlNet pose conditioning**: Lock body positions, only vary faces
2. **Layered compositing with AI background removal**: Generate each character separately, composite with consistent background
3. **Fine-tuned model**: Train on consistent character set
4. **Video frame extraction**: Generate video of characters, extract best frame

---

## Conclusion

**No reliable solution exists** for generating 10+ character covers with consistent identities.

**Recommendation**: Limit covers to 3-4 prominent characters. Use artistic techniques (silhouettes, partial views, symbolic elements) to suggest additional characters without requiring AI to generate all faces distinctly.

The problem is fundamental to how diffusion models handle multiple identity references - they tend to average/blend when given too many competing references.
