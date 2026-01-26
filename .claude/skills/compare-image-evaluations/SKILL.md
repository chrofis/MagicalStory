---
name: compare-image-evaluations
description: Analyze image quality evaluations from a story - reads directly from database for accurate per-page results
---

# Compare Image Evaluations

## Overview

Analyzes the three evaluation methods used during story generation to understand image quality issues. **Reads directly from the database** (not logs) for accurate per-page results.

## When to Use

- After story generation completes with quality issues
- When debugging why characters look wrong or inconsistent
- When the user asks to "analyze evaluations" or "check image quality"
- When investigating why certain pages have low scores

## Quick Start

```bash
# Analyze latest story
node scripts/compare-image-evaluations-db.js

# Analyze specific story
node scripts/compare-image-evaluations-db.js job_1769380512008_aog73mrs6
```

## The Three Evaluation Methods

| Method | What It Checks | Stored In |
|--------|----------------|-----------|
| **Quality Eval** | Single image against prompt and references | `sceneImages[].qualityReasoning` |
| **Incremental Consistency** | Current page vs previous pages | `sceneImages[].retryHistory` |
| **Final Consistency** | All pages in batches | Triggers regeneration, logged only |

## Data Sources

### Quality Evaluation (Primary)

Stored in `stories.data.sceneImages[].qualityReasoning`:

```javascript
{
  "figures": [...],           // Detected figures with position, hair, clothing
  "matches": [{               // Character identification
    "figure": 1,
    "reference": "Lukas",
    "confidence": 0.95,
    "face_bbox": [0.32, 0.48, 0.45, 0.55],
    "hair_ok": true,
    "clothing_ok": true,
    "issues": ["expression mismatch"]
  }],
  "score": 8,                 // 0-10 (multiply by 10 for percentage)
  "verdict": "PASS",          // PASS, SOFT_FAIL, HARD_FAIL
  "issues_summary": "...",    // Human-readable issues
  "fixable_issues": [...]     // Issues that can be fixed by inpainting
}
```

### Incremental Consistency

Stored in `sceneImages[].retryHistory`:

```javascript
{
  "type": "consistency",
  "consistencyScore": 7,      // 0-10
  "consistencyIssues": [
    "[MAJOR] clothing: Manuel's outfit changed..."
  ]
}
```

### Final Consistency

Not stored in DB - only triggers regeneration. Check logs if needed:
```bash
grep "CONSISTENCY REGEN" logfile.log
```

## Output Format

The script produces a table plus detailed issues:

```
| Page | Score | Verdict | Characters | Issues |
|------|-------|---------|------------|--------|
|  7 |  50% ⚠️ | PASS    | Lukas, Man | Compositional error... |
|  8 |  55% ⚠️ | PASS    | Lukas, Man | Manuel in Roger's position... |

## Detailed Issues (pages with score < 80%)

### Page 8 (55%)
Characters: Lukas, Manuel, Roger
Issues: Incorrect character in central position (Manuel instead of Roger)
Fixable issues:
  - [CRITICAL] character: The character in the center should be Roger, not Manuel
Figure matches:
  - Figure 1: Manuel (90%)
  - Figure 2: Manuel (90%) ← DUPLICATE, should be Roger
  - Figure 3: Lukas (95%)
```

## Why Database > Logs

| Approach | Pros | Cons |
|----------|------|------|
| **Database** | Accurate per-page mapping, structured data, no parsing errors | Only has final state |
| **Logs** | Has timing, retries, all attempts | Interleaved/parallel execution causes wrong page associations |

**Always prefer database** for evaluation analysis. Use logs only for timing/cost analysis.

## Common Issues Found

| Issue Type | Example | Severity |
|------------|---------|----------|
| Character swap | "Manuel in Roger's position" | CRITICAL |
| Missing character | "Roger missing from scene" | CRITICAL |
| Clothing mismatch | "Matthias wearing Lukas's outfit" | CRITICAL |
| Wrong colors | "Sneakers green instead of blue" | MODERATE |
| Pose mismatch | "Hand in pocket instead of pointing" | MODERATE |
| Object issues | "Medallion not glowing" | MINOR |

## Related Scripts

```bash
# Full story log analysis (timing, costs)
node scripts/analyze-story-log.js

# Extract faces from evaluations
node scripts/extract-faces.js <storyId>

# Check evaluation data structure
node scripts/show-eval-fields.js <storyId>
```
