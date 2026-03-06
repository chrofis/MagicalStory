---
name: analyze-scene-changes
description: Use when analyzing what the scene self-critique system changed in a generated story, comparing draft vs output for each page
---

# Analyze Scene Changes

## Overview

Analyzes what the scene description self-critique system changed between draft and output for each page of a generated story. Shows issues found, corrections applied, and field-by-field differences.

## Usage

```
/analyze-scene-changes <job-id> [page-number]
```

Examples:
- `/analyze-scene-changes job_1769373235483_1cazuipuh` - Analyze all pages
- `/analyze-scene-changes job_1769373235483_1cazuipuh 5` - Analyze only page 5

## Running the Script

```bash
node scripts/analyze-scene-changes.js <job-id> [page-number]
```

Requires DATABASE_URL in .env pointing to Railway PostgreSQL public proxy.

## Output Format

For each page with changes:

1. **Issues Found** - Problems the self-critique identified
2. **Corrections Applied** - How each issue was fixed
3. **Field Changes** - Exact draft → output differences:
   - `imageSummary` - Scene description text
   - `setting` - location, camera, lighting, depthLayers
   - `characters` - added/removed, position, pose, action, expression, holding
   - `objects` - position changes

Pages with no issues show "Draft was correct".

## Example Output

```markdown
## Page 5

**Issues Found:** 3
1. Critical Rule #3 violation: Scene requires 3 children but only Lukas included
2. Story text fidelity: Manuel 'verschränkte die Arme' - missing character
3. Holding inventory conflict: Franziska holding with both hands

**Corrections Applied:**
1. Add Manuel to character array with crossed arms pose
2. Add Sophie to character array displaying her golden shield
3. Fix Franziska's holding: L:holding Roger's hand, R:resting on table

**Field Changes (Draft → Output):**

`characters` (added/removed):
  + Added: Manuel, Sophie

`Lukas`:
  - pose: "Standing, body turned three-quarter" → "Standing, weight on right leg"
```

## Use Cases

- **Debug scene quality** - See what self-critique is catching/missing
- **Prompt tuning** - Identify common issues to add new checks for
- **Validate fixes** - Confirm prompt changes reduce specific error types
- **Track improvements** - Compare draft accuracy across story generations

## Summary Statistics

At the end of a full analysis, shows:
- Pages with issues: X/Y (Z% draft accuracy)
- Total issues found: N
