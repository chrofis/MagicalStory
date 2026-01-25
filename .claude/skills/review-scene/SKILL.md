---
name: review-scene
description: Use when reviewing scene descriptions from generated stories, debugging scene prompt issues, or adding new checks to scene-descriptions.txt
---

# Review Scene

## Overview

Interactive workflow for reviewing scene descriptions from generated stories and improving the scene prompt.

## Usage

```
/review-scene <story-id-or-url> <page-number>
```

Examples:
- `/review-scene job_1769251765157_a4qh1nzza 8`
- `/review-scene https://www.magicalstory.ch/create?storyId=job_1769251765157_a4qh1nzza 6`

## Workflow

### 1. Fetch Scene Data

Query the database for the story job:

```javascript
// Extract job ID from URL if needed
const jobId = url.includes('storyId=')
  ? url.split('storyId=')[1].split('&')[0]
  : storyId;

// Query result_data for scene descriptions
SELECT result_data->'sceneDescriptions'->N as scene
FROM story_jobs WHERE id = $1
```

### 2. Display Key Info

Show the user:
- **Scene Summary (input)**: What was requested
- **Location**: Where the LLM placed the scene
- **Characters**: Positions and actions
- **Objects**: What's in the scene
- **Critique run**: What checks passed/failed

### 3. User Identifies Issue

Wait for user to explain what's wrong:
- Wrong location
- Characters too close/far
- Missing elements
- Physics issues
- Continuity problems

### 4. Add Check to Scene Prompt

If the issue reveals a missing check:

1. Add numbered check rule after existing checks in `prompts/scene-descriptions.txt`
2. Add corresponding field to critique JSON schema
3. Add to example critique section

Check format:
```markdown
**N. Check Name:**
- Bullet points explaining what to verify
- WRONG: example of failure
- RIGHT: example of correct behavior
```

JSON field format:
```json
"checkName": "Brief description of what to verify. PASS/FAIL"
```

## Files

- `prompts/scene-descriptions.txt` - Scene prompt with checks
- `story_jobs` table - Contains `result_data->'sceneDescriptions'`

## Quick Reference

| Issue Type | Likely Missing Check |
|------------|---------------------|
| Wrong location | Location Continuity |
| Characters too close | Distance & Separation |
| Teleporting objects | Object Continuity |
| Weather mismatch | Weather Consistency |
| Scale problems | Scale Feasibility |
