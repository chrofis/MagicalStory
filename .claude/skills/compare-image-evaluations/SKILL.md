---
name: compare-image-evaluations
description: Use when analyzing story generation logs to understand image quality issues, comparing Quality Eval vs Incremental Consistency vs Final Consistency results per page
---

# Compare Image Evaluations

## Overview

Story generation uses three different evaluation methods that catch different types of issues. Analyzing them together reveals patterns that individual checks miss.

**Core principle:** Extract characters per page FIRST, then match evaluations to ensure issues reference correct characters.

## When to Use

- After story generation completes with quality issues
- When debugging why characters look wrong or inconsistent
- When the user asks to "analyze the log" or "check image quality"
- When investigating why certain pages were regenerated

## The Three Evaluation Methods

| Method | What It Checks | Best At Finding |
|--------|----------------|-----------------|
| **Quality Eval** | Single image against prompt and references | Rendering errors, anatomical issues, prompt compliance, art style match |
| **Incremental Consistency** | Current page vs 1-3 previous pages | Identity drift page-to-page, clothing changes without context, missing/duplicate characters |
| **Final Consistency** | All pages in batches | Cross-story patterns (character resemblance), clothing vs JSON mismatch, batch-level issues |

## Log Analysis Steps

### Step 1: Extract Characters Per Page

```bash
# Primary: UNIFIED-PARSER (has clothing info)
grep -E "UNIFIED-PARSER.*Page.*clothing=" logfile.log

# Fallback: Scene characters from image prompt
grep -E "\[IMAGE PROMPT\] Scene characters:" logfile.log
```

**Critical:** Scene hints may show fewer characters than final expansion.

### Step 2: Extract Quality Evaluation Results

```bash
# Get scores and verdicts
grep -E "QUALITY.*Score:.*Verdict:" logfile.log

# Get issue text
grep -E "QUALITY.*Issues:|fixable issues" logfile.log
```

### Step 3: Extract Incremental Consistency Results

```bash
# Get scores per page
grep -E "INCR-CONSISTENCY.*Page.*score:" logfile.log

# Get issue details
grep -E "\[critical\]|\[major\]|\[minor\]" logfile.log
```

### Step 4: Extract Final Consistency Results

```bash
# Get batch processing info
grep -E "CONSISTENCY.*Processing.*batches|CONSISTENCY.*Checking.*batch" logfile.log

# Get issues found (count)
grep -E "CONSISTENCY.*Found.*issue" logfile.log

# Get issue details (type, severity, pages, images compared)
grep -E "CONSISTENCY REGEN.*Issue:" logfile.log

# Get regeneration results
grep -E "CONSISTENCY REGEN.*Replaced|CONSISTENCY REGEN.*Regenerating" logfile.log
```

**Note:** Final consistency logs `type`, `severity`, `pagesToFix`, and `images` (pages compared), but NOT a text description. The issue types are:
- `character_appearance` - Characters look different across pages
- `clothing_mismatch` - Clothing doesn't match expected/previous

### Step 5: Build Consolidated Table

Create one row per page with ALL THREE evaluations as separate columns:

## Required Output Format

**ALWAYS produce this exact table structure:**

| Page | Characters | Quality Eval | Quality Issues | Incr. Consistency | Incr. Issues | Final Consistency |
|------|------------|--------------|----------------|-------------------|--------------|-------------------|
| 1 | Lukas, Manuel | 90% ✅ | - | - | (first page) | Batch 1: ✅ |
| 2 | Lukas, Sophie | 100% ✅ | No issues | ✅ 10/10 | - | Batch 1: ✅ |
| 3 | Manuel, Sophie | 80% ✅ | Lukas's jacket wrong color | ⚠️ 7/10 | [major] Clothing changed | Batch 1: ❌ **REGEN** |
| 4 | Lukas, Manuel | 95% ✅ | 🐛 [Sophie not in scene] Sophie missing glasses | ✅ 10/10 | - | Batch 1+2: ✅ |

**Column definitions:**
- **Page**: Page number
- **Characters**: From UNIFIED-PARSER or `[IMAGE PROMPT] Scene characters:`
- **Quality Eval**: Score as percentage + emoji (✅ ≥80%, ⚠️ 50-79%, ❌ <50%)
- **Quality Issues**: Full issue text, flag ghost characters with 🐛
- **Incr. Consistency**: Score as X/10 + emoji (✅ 8-10, ⚠️ 5-7, ❌ 1-4)
- **Incr. Issues**: [severity] issue text, or "-" if none
- **Final Consistency**: Which batch(es) + result, mark **REGEN** if triggered

**Legend:** ✅ pass | ⚠️ warning | ❌ fail | 🐛 ghost character bug

**After the table, ALWAYS add Final Consistency Details:**

```
**Final Consistency Summary:**
- Batch 1 (pages 1-10): X issue(s) found
- Batch 2 (pages 6-15): X issue(s) found

**Final Consistency Issues (detailed):**
| Page | Type | Severity | Images Compared | Result |
|------|------|----------|-----------------|--------|
| 10 | character_appearance | high | 10, 9 | **REGEN** → 90% ✅ |

- **Page 10**: `character_appearance` (high) - Compared images 9-10, found appearance mismatch. Regenerated successfully (90%)
```

**Always include:**
1. Which batches found issues
2. For each issue: page, type, severity, which images were compared
3. Regeneration result (new score) if applicable

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using scene hint characters instead of final | Always use UNIFIED-PARSER output |
| Copying evaluation text without verifying characters | Cross-check characters in scene before including issue text |
| Missing that evaluations check ALL reference images | Quality eval may mention characters not in scene if their reference was passed |
| Confusing page numbers due to log interleaving | Match by timestamp, not just page number mentions |

## Evaluation Bugs to Flag

When building the table, **flag these as bugs** (not valid issues):

### Ghost Character Issues
Evaluation mentions a character NOT in the scene:
```
Page 9 characters: Lukas, Manuel, Sophie
Issue says: "Franziska's robe on Page 9 changed..."
```
**This is a BUG** - the model is either:
- Misidentifying one character as another (Sophie → Franziska)
- Hallucinating a character from previous pages' reference images

**How to report:** Mark with 🐛 emoji: `🐛 [Franziska not in scene] "issue text..."`

### Root Cause (fixed)
Previously, the incremental consistency prompt received `{CHARACTERS}` built from **previous pages**, not the current page. This caused the model to look for characters from previous pages who weren't in the current scene, leading to misidentification.

**Fix applied**: Prompt now receives `{CURRENT_CHARACTERS}` (who should be in this scene) separately from `{PREVIOUS_CHARACTERS}` (for reference only).

### Valid vs Invalid "Missing Character"
- **VALID:** "Sophie is absent from the scene" when Sophie WAS expected (in character list)
- **INVALID:** Clothing issue for character not in scene ("Franziska's robe changed" when Franziska not present)

## What Each Score Means

**Quality Eval (percentage):**
- 90-100%: Excellent rendering, minor issues only
- 70-89%: Acceptable, some rendering or consistency issues
- 50-69%: Passed threshold but has significant issues
- <50%: Would trigger retry

**Incremental Consistency (1-10):**
- 8-10: Consistent with previous pages
- 5-7: Minor inconsistencies (clothing, accessories)
- 1-4: Major issues (identity drift, missing characters, duplicates)

**Final Consistency:**
- Reports `type=clothing_mismatch` or `type=character_appearance`
- Logs: `type`, `severity` (high/medium/low), `pagesToFix`, `images` (pages compared)
- Does NOT log a text description - only structured fields
- Triggers regeneration of affected pages
- After regen, logs new score: `[CONSISTENCY REGEN] [PAGE X] Replaced image (score: Y%)`

## Key Insight

Quality Eval can pass (60%+) while Incremental Consistency fails (1/10). This happens when:
- Image renders correctly but characters don't match previous pages
- All three characters unrecognizable but image technically valid
- Height order wrong but faces rendered properly

Always check ALL THREE evaluations to understand full picture.
