# Image Repair Mechanisms

This document describes the three different repair mechanisms used in the codebase for fixing image quality issues.

## Summary

There are **three different repair mechanisms**, used in different contexts:

| Mechanism | Used By | Approach | Provider |
|-----------|---------|----------|----------|
| **Grid-Based Repair** | Auto-repair pipeline (default) | Extract 512px regions → batch into grids → Gemini repairs → verify → composite back | Gemini only |
| **Direct Inpainting** | Auto-repair fallback, manual inpainting | Create mask → single API call with mask/coordinates | Runware (default) or Gemini |
| **Full Regeneration** | Manual regenerate, major issues | Completely regenerate with new prompt | Gemini (primary) |

---

## 1. Grid-Based Repair (Default for Auto-Repair)

**Files:** `server/lib/gridBasedRepair.js`, `server/lib/repairGrid.js`

### Flow

1. Collect all issues from quality evaluation
2. Extract 256x512px regions around each issue
3. Batch into grids (max 12 issues per grid)
4. Send to Gemini with manifest describing each issue
5. Extract repaired regions from returned grid
6. **Verify each repair** via Gemini comparison (confidence threshold: 70%)
7. Apply verified repairs, retry failed ones individually
8. Final artifact check

### Called From

- `generateImageWithQualityRetry()` when `useGridRepair=true` (default)
- `executeRepairPlan()` for batch repairs
- `autoRepairWithTargets()` (hybrid mode)

### Key Thresholds

| Threshold | Value | Purpose |
|-----------|-------|---------|
| AUTO_REPAIR_THRESHOLD | 90% | Trigger repair if score ≤ 90% |
| LLM_CONFIDENCE_THRESHOLD | 70% | Accept repair if confidence ≥ 70% |
| TARGET_REGION_SIZE | 512px | Default region extraction size |
| MAX_PER_GRID | 12 | Max issues per grid batch |

---

## 2. Direct Inpainting

**File:** `server/lib/images.js` (functions: `inpaintWithMask`, `autoRepairWithTargets`)

### Flow

1. Group fix targets by type (face, anatomy, objects)
2. Check mask coverage (skip if > MAX_MASK_COVERAGE_PERCENT)
3. Create combined mask for bounding boxes
4. Single inpaint API call per group
5. No verification step

### Two Backends

#### Runware (Default)
- Uses actual mask image
- SDXL model (`runware:101@1`)
- Cost: ~$0.002/image
- Function: `inpaintWithRunwareBackend()`

#### Gemini
- Uses text-based coordinates in prompt (no mask image needed)
- More reliable for multiple similar elements
- Function: `inpaintWithMask()` with `backend='gemini'`

### Called From

- Auto-repair when `useGridRepair=false`
- Legacy repair flows

---

## 3. Full Image Regeneration

**File:** `server.js` (endpoint: `/api/stories/:id/regenerate/image/:pageNum`)

### Flow

1. User clicks "Regenerate" in UI
2. Calls `generateImageWithQualityRetry()` with same prompt
3. Creates new image version (doesn't replace original)
4. Runs quality evaluation + optional auto-repair on new version

### Triggers

- User manually clicks regenerate button
- Quality score < 30% (auto-regenerate threshold)
- Major issues detected (missing characters, extra limbs, physics violations)

---

## Comparison Table

| Aspect | Grid Repair | Direct Inpaint | Full Regen |
|--------|-------------|----------------|------------|
| **Verification** | Yes (70% confidence) | No | Quality eval |
| **Batching** | Up to 12 issues/grid | Single call | N/A |
| **Provider** | Gemini only | Runware or Gemini | Gemini (primary) |
| **Cost** | Higher (multiple calls) | Lower ($0.002 Runware) | Varies |
| **Retry logic** | Failed repairs retried | None | Up to 3 attempts |
| **Coverage limit** | Per-cell (512px regions) | Global mask coverage % | N/A |

---

## Decision Flow

```
Story Generation → Auto-Repair Pipeline
  ├─ useGridRepair=true (default)
  │   └─ gridBasedRepair() [Gemini]
  └─ useGridRepair=false
      └─ autoRepairWithTargets() → inpaintWithMask() [Runware]

Manual Regenerate → /api/stories/:id/regenerate/image/:pageNum
  └─ generateImageWithQualityRetry() → Full new image
      └─ May trigger auto-repair on new image if enabled

executeRepairPlan() → Batch repair multiple pages
  ├─ useGridRepair=true → gridBasedRepair() per page
  └─ Regenerate pages with major issues
```

---

## Issue Classification → Repair Method

| Issue Type | Detection | Repair Method |
|------------|-----------|---------------|
| Missing character | `scene.all_present=false` | Regenerate |
| Extra limbs | `rendering.extra_limbs=true` | Regenerate |
| Physics violation | `rendering.physics_ok=false` | Regenerate |
| Cross-eyes | `rendering.cross_eyes=true` | Regenerate |
| Wrong pointing direction | `spatial.issues.length>0` | Regenerate |
| Age mismatch | `match.age_match=false` | Targeted replace or regen |
| Height order wrong | `match.height_order_ok=false` | Targeted replace or regen |
| Hair mismatch | `match.hair_match=false` | Targeted replace or regen |
| Clothing wrong | `match.clothing_match=false` | Grid inpaint |
| Fixable clothing | `fixable_issues[].type=clothing` | Grid inpaint |
| Style inconsistent | `scene.style_consistent=false` | Style transfer |
| Low score (< 30%) | Score-based | Regenerate |

---

## Key Files

| File | Purpose |
|------|---------|
| `server/lib/images.js` | Main orchestrator, quality evaluation, direct inpainting |
| `server/lib/gridBasedRepair.js` | Grid repair pipeline orchestration |
| `server/lib/repairGrid.js` | Grid creation, Gemini repair calls, region extraction |
| `server/lib/repairVerification.js` | Repair verification, diff images |
| `server/lib/issueExtractor.js` | Issue normalization, deduplication |
| `server/lib/runware.js` | Runware API for inpainting |
| `server/utils/config.js` | Quality thresholds, model defaults |
| `prompts/grid-repair.txt` | Gemini repair instruction prompt |
| `prompts/image-evaluation.txt` | Quality evaluation criteria |

---

## Known Inconsistencies

1. **Provider mismatch**: Grid repair only uses Gemini, while direct inpainting defaults to Runware - different quality/cost tradeoffs

2. **Verification gap**: Only grid repair verifies if repairs succeeded; direct inpainting has no verification

3. **Threshold fragmentation**:
   - Auto-repair triggers at ≤ 90% score
   - Quality threshold for regeneration is 50%
   - Grid repair verification uses 70% confidence
