---
name: review-scene
description: Use when reviewing scene descriptions from generated stories, debugging scene prompt issues, or adding new checks to the scene prompts (scene-expansion.txt / scene-review.txt)
---

# Review Scene

Interactive workflow for reviewing a generated story's scene descriptions and improving the scene prompts.

## Usage

```
/review-scene <story-id-or-url> <page-number>
```

## Workflow

### 1. Fetch the scene data

Preferred: `node scripts/analysis/review-page.js <storyId> <pageNum>` — dumps the page's stored scene description, prompts, evals, and versions (see page-review-tool memory). Raw fallback: `stories.data->sceneImages` / `story_jobs.result_data->sceneDescriptions` in the DB.

### 2. Display key info

- **Scene summary (input)**: what was requested
- **Location / characters / objects**: where the model placed things
- **Critique run**: which checks passed/failed

### 3. User identifies the issue

Wait for the user: wrong location, characters too close/far, missing elements, physics, continuity.

### 4. Add a check to the scene prompts

The relevant files (which one is live depends on `PIPELINE_MODE` — beats vs unified; check before editing):

- `prompts/scene-expansion.txt` (and `scene-expansion-all.txt`) — Art Director authoring rules
- `prompts/scene-review.txt` — cross-page critique checks
- `prompts/scene-iteration.txt` / `scene-repair.txt` — downstream siblings; check them for the same rule (fixing-sibling-paths)

Follow the validating-prompt-changes skill before editing: terse rules, archetypal examples only, validate against ≥3 stored pages, and grep for duplicate instruction sites.

## Quick reference

| Issue type | Likely missing check |
|------------|---------------------|
| Wrong location | Location continuity |
| Characters too close | Distance & separation |
| Teleporting objects | Object continuity |
| Weather mismatch | Weather consistency |
| Scale problems | Scale feasibility |
