---
name: story-outline-review
description: "Analyze CRITICAL ANALYSIS findings and verify fixes were applied to the story."
---

# Story Outline Review

Compares a story's draft (inside the stored outline) with the final text to see what the review pass changed: issues identified, fixes proposed, and whether they landed.

## Data access

Query the DB directly with an inline `pg` script — connection strings are in `.env` (`DATABASE_URL` / `STAGING_DATABASE_URL`; see db-direct-access memory). Requires `ssl: { rejectUnauthorized: false }`.

```sql
-- Draft lives inside the outline; final text in originalStory
SELECT data->'outline' AS outline, data->'originalStory' AS story
FROM stories WHERE id = 'your-story-id';
```

The outline contains a `---STORY DRAFT---` section with the pre-critique text; extract with `/---STORY DRAFT---\n([\s\S]*?)(?=---|$)/`. The raw model output is stored verbatim in `stories.data.outline` (see unified-call memory).

## What to compare, per page

| Aspect | Draft location | Final location |
|--------|---------------|----------------|
| **Text** | outline → `---STORY DRAFT---` | `originalStory.pages[n].text` |
| **Scene hint** | outline → `[Scene Hint]` lines | `originalStory.pages[n].sceneHint` |
| **Characters** | outline → `[Characters]` lines | `originalStory.pages[n].characters` |
| **Clothing** | outline → `[Clothing]` lines | `originalStory.pages[n].clothing` |

## What to look for

1. **Banned-gesture fixes** — the prompt bans certain gestures (e.g. hand on shoulder, arm around shoulders, ruffling hair); the review should have replaced them. Verify the final text is clean.
2. **Formatting** — paragraph splits, dialogue-tag repositioning, Swiss orthography («…» guillemets, ss not ß).
3. **Scene-hint consistency** — characters mentioned appear in the scene, actions are visible, clothing matches the clothing field.

## Report

Per-page table (Draft / Final / Changed?), then summary: total pages, pages modified, banned-gesture fixes caught, scene-hint changes, critical issues fixed vs missed.

## Related

- `analyze-story-log` — timing and costs from Railway logs
- Test Lab stage `story_bible_replay` — replay costume/bible rules against a shipped story
