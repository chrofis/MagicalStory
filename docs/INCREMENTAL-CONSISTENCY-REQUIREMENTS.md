# Incremental Consistency Check - Requirements Document

## Overview

This feature adds real-time consistency checking during story generation. After each image is generated, it is evaluated both for quality issues AND consistency against previously generated images. All issues are collected and fixed in a single inpainting call.

---

## Current System

### Existing Flow

```
For each page:
  1. Generate image
  2. Evaluate image quality (evaluateImageQuality)
     - Checks: rendering errors, character match to reference photos
     - Returns: score, issues, fix_targets
  3. If issues found → fix via inpainting (one call per issue type)
  4. Re-evaluate if fixed

After all pages complete:
  5. Run final consistency check (evaluateConsistencyAcrossImages)
     - Checks: consistency across ALL images
     - Returns: issues per image
  6. Currently: issues logged but NOT auto-fixed
```

### Problems with Current Approach

1. **Late detection**: Consistency issues only found at the end
2. **No auto-fix**: Final consistency check doesn't trigger repairs
3. **Multiple fix calls**: Quality issues fixed one at a time
4. **Drift accumulates**: Small inconsistencies compound across pages

---

## New System

### Proposed Flow

```
For each page:
  1. Generate image
  2. Evaluate image quality (existing)
     - Returns: qualityIssues[], fix_targets[]
  3. NEW: Evaluate against previous images (incremental consistency)
     - Compare with last N images (configurable, default 3)
     - Returns: consistencyIssues[]
  4. Merge all issues into unified fix list
  5. Make SINGLE inpainting call to fix all issues
  6. Re-evaluate if fixed
```

### Key Changes

| Aspect | Current | New |
|--------|---------|-----|
| Consistency check timing | End of story | After each image |
| Images compared | All at once | Current + last N |
| Fix calls per image | Multiple (per issue) | Single (all issues) |
| Dry-run mode | None | Shows what would be fixed |

---

## Detailed Requirements

### 1. Incremental Consistency Check Function

```typescript
interface IncrementalConsistencyOptions {
  // How many previous images to compare against
  lookbackCount: number;        // Default: 3

  // What to check
  checkCharacterAppearance: boolean;  // Hair, clothing, etc.
  checkArtStyle: boolean;             // Color palette, rendering style
  checkEnvironment: boolean;          // Background consistency

  // Dry-run mode
  dryRun: boolean;              // If true, return issues but don't fix

  // Character reference photos (for identity verification)
  referencePhotos: Array<{
    characterName: string;
    photoUrl: string;
  }>;
}

interface ConsistencyIssue {
  type: 'character_appearance' | 'art_style' | 'environment' | 'other';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  affectedCharacter?: string;

  // For inpainting
  fixTarget?: {
    region: 'full' | BoundingBox;
    instruction: string;
  };
}

async function evaluateIncrementalConsistency(
  currentImage: string,           // Base64 image data
  currentPageNumber: number,
  previousImages: Array<{
    imageData: string;
    pageNumber: number;
    characters: string[];
    clothing: Record<string, string>;
  }>,
  options: IncrementalConsistencyOptions
): Promise<{
  consistent: boolean;
  score: number;                  // 0-10
  issues: ConsistencyIssue[];
  summary: string;
}>;
```

### 2. Unified Issue Collection

After both evaluations complete, merge issues:

```typescript
interface UnifiedIssueReport {
  // From quality evaluation
  qualityIssues: QualityIssue[];

  // From consistency evaluation
  consistencyIssues: ConsistencyIssue[];

  // Merged and deduplicated
  allIssues: Issue[];

  // Single fix plan
  fixPlan: {
    requiresFix: boolean;
    fixTargets: FixTarget[];      // Consolidated targets
    estimatedFixCount: number;    // How many regions to inpaint
  };

  // For dry-run display
  dryRunReport?: {
    wouldFix: string[];           // Human-readable list
    wouldSkip: string[];          // Issues below threshold
    estimatedCost: string;        // Token/API cost estimate
  };
}
```

### 3. Single Fix Call

Instead of multiple inpainting calls:

```typescript
// CURRENT (multiple calls):
for (const issue of issues) {
  await inpaintRegion(image, issue.target, issue.instruction);
}

// NEW (single call with multiple targets):
const fixResult = await inpaintMultipleRegions(image, {
  targets: unifiedReport.fixPlan.fixTargets,
  combineInstructions: true,  // Merge overlapping regions
  prioritize: 'critical_first'
});
```

### 4. Dry-Run Mode

When `dryRun: true`:

```typescript
// Returns report without making any fixes
const report = await evaluateWithConsistency(image, pageNum, prevImages, {
  dryRun: true
});

// Log what WOULD be fixed
console.log('=== DRY RUN REPORT ===');
console.log('Quality issues found:', report.qualityIssues.length);
console.log('Consistency issues found:', report.consistencyIssues.length);
console.log('');
console.log('Would fix:');
for (const fix of report.dryRunReport.wouldFix) {
  console.log(`  - ${fix}`);
}
console.log('');
console.log('Would skip (below threshold):');
for (const skip of report.dryRunReport.wouldSkip) {
  console.log(`  - ${skip}`);
}
```

---

## Configuration

### New Config Options

Add to `server/config/models.js` or story generation options:

```javascript
const INCREMENTAL_CONSISTENCY_DEFAULTS = {
  // Enable/disable the feature
  enabled: true,

  // How many previous images to check against
  lookbackCount: 3,

  // Minimum score to trigger fix (0-10)
  fixThreshold: 7,

  // Issue severity threshold
  minSeverityToFix: 'major',  // 'critical' | 'major' | 'minor'

  // Dry-run mode (for testing)
  dryRun: false,

  // What aspects to check
  checks: {
    characterAppearance: true,
    artStyle: true,
    environment: false,  // Less important for children's books
  },

  // Performance tuning
  compressImagesForComparison: true,
  maxComparisonResolution: 768,
};
```

### Developer Mode Override

In frontend developer mode, allow toggling:

```typescript
interface DevModeOptions {
  incrementalConsistency: {
    enabled: boolean;
    dryRun: boolean;
    lookbackCount: number;
    showDetailedReport: boolean;
  };
}
```

---

## Prompt Template

Create new prompt file: `prompts/incremental-consistency-check.txt`

```
You are evaluating a newly generated storybook illustration for consistency with previous pages.

**CURRENT IMAGE**: Image 1 (Page {{PAGE_NUMBER}})
**PREVIOUS IMAGES**: Images 2-{{PREV_COUNT}} (Pages {{PREV_PAGES}})

**CHARACTERS IN SCENE**: {{CHARACTERS}}
**EXPECTED CLOTHING**: {{CLOTHING}}

**TASK**: Check if the current image (Image 1) is consistent with the previous images.

**CHECK FOR**:
1. **Character Appearance**: Does each character look the same as in previous images?
   - Hair color, style, length
   - Skin tone
   - Facial features
   - Body proportions

2. **Clothing Consistency**: Are characters wearing the expected clothing?
   - Match against provided clothing descriptions
   - Note any unexplained changes

3. **Art Style**: Does the image match the style of previous images?
   - Color palette
   - Line work
   - Shading style
   - Background rendering

**OUTPUT**: Return JSON only:
```json
{
  "consistent": true/false,
  "score": 0-10,
  "issues": [
    {
      "type": "character_appearance|art_style|clothing|environment",
      "severity": "critical|major|minor",
      "description": "...",
      "affectedCharacter": "character name or null",
      "fixTarget": {
        "region": "full" or {"x":0,"y":0,"width":100,"height":100},
        "instruction": "Fix instruction for inpainting"
      }
    }
  ],
  "summary": "Brief summary of findings"
}
```
```

---

## Implementation Steps

### Phase 1: Dry-Run Mode (Testing)

1. Create `evaluateIncrementalConsistency()` function
2. Integrate into image generation loop (after quality eval)
3. Log results but DON'T fix anything
4. Add `--dry-run` flag or config option

### Phase 2: Issue Merging

1. Create `UnifiedIssueReport` structure
2. Implement issue deduplication logic
3. Create consolidated fix plan
4. Log merged report

### Phase 3: Single Fix Call

1. Modify inpainting to accept multiple targets
2. Implement region merging for overlapping issues
3. Make single API call with all fixes
4. Re-evaluate after fix

### Phase 4: Frontend Integration

1. Add dev mode toggle for feature
2. Show consistency status per page in generation UI
3. Display dry-run reports when enabled

---

## API Changes

### Story Generation Job

Add to job options:

```typescript
interface StoryJobOptions {
  // ... existing options ...

  incrementalConsistency?: {
    enabled?: boolean;
    dryRun?: boolean;
    lookbackCount?: number;
  };
}
```

### Job Status Updates

Include consistency info in status:

```typescript
interface PageStatus {
  pageNumber: number;
  imageStatus: 'generating' | 'evaluating' | 'fixing' | 'complete';

  // NEW
  consistencyCheck?: {
    score: number;
    issueCount: number;
    fixesApplied: number;
    dryRunReport?: string[];
  };
}
```

---

## Logging

### Log Format

```
📸 [PAGE 5] Image generated
⭐ [PAGE 5] Quality eval: score=7, issues=2 (finger count, minor clipping)
🔍 [PAGE 5] Consistency check vs pages 2,3,4: score=8, issues=1 (hair color drift)
📋 [PAGE 5] Unified report: 3 issues total, 2 will be fixed
🔧 [PAGE 5] Fixing: [finger count, hair color] in single call
✅ [PAGE 5] Fixed, re-eval score: 9

--- DRY RUN MODE ---
📸 [PAGE 5] Image generated
⭐ [PAGE 5] Quality eval: score=7, issues=2
🔍 [PAGE 5] Consistency check: score=8, issues=1
📋 [PAGE 5] DRY RUN - Would fix:
   - Finger count on left hand (severity: major)
   - Hair color drift from page 3 (severity: major)
   - Minor clipping on edge (severity: minor) [SKIPPED - below threshold]
```

---

## Testing Checklist

- [ ] Dry-run mode shows correct issues without fixing
- [ ] Consistency check compares against correct previous images
- [ ] Issues from both evaluations are merged correctly
- [ ] Duplicate issues are deduplicated
- [ ] Single inpainting call made (not multiple)
- [ ] Re-evaluation runs after fix
- [ ] Lookback count is configurable
- [ ] Feature can be disabled entirely
- [ ] Performance acceptable (not too slow)
- [ ] Token usage logged for cost tracking

---

## Performance Considerations

1. **Image compression**: Compress previous images before comparison
2. **Caching**: Cache compressed versions of previous images
3. **Batch size**: Limit lookback to 3-5 images max
4. **Early exit**: Skip consistency check if quality score is very low (will regenerate anyway)

---

## Rollout Plan

1. **Week 1**: Implement dry-run mode, test internally
2. **Week 2**: Enable for dev mode users only
3. **Week 3**: Gradual rollout to production (10% → 50% → 100%)
4. **Week 4**: Remove dry-run default, full production
