---
name: story-outline-review
description: "Analyze CRITICAL ANALYSIS findings and verify fixes were applied to the story."
---

# Story Outline Review

## Overview

Analyzes the CRITICAL ANALYSIS section from story generation to see:
1. All issues identified (by category)
2. Proposed fixes with before/after text
3. Whether fixes were applied in the final story
4. Banned gesture scan on final text

## Quick Usage

```bash
node scripts/compare-story-draft.js
```

Or with explicit database URL:
```bash
DATABASE_PUBLIC_URL="postgresql://..." node scripts/compare-story-draft.js
```

## Database Queries

**Fetch draft story (from outline):**
```sql
SELECT data->'outline' as outline FROM stories ORDER BY created_at DESC LIMIT 1
```

The outline contains a `---STORY DRAFT---` section with the initial text before critique.

**Fetch final story:**
```sql
SELECT data->'originalStory' as story FROM stories ORDER BY created_at DESC LIMIT 1
```

**Fetch specific story by ID:**
```sql
SELECT data->'outline' as outline, data->'originalStory' as story
FROM stories WHERE id = 'your-story-id'
```

## Connection Details

Use the public Railway proxy URL (not internal URL):
```bash
# Get the public URL from Railway
railway variables -s Postgres | grep PUBLIC
```

Connection string format:
```
postgresql://postgres:<password>@turntable.proxy.rlwy.net:26087/railway
```

Requires SSL: `ssl: { rejectUnauthorized: false }`

## What to Compare

For each page, compare:

| Aspect | Draft Location | Final Location |
|--------|---------------|----------------|
| **Text** | `outline` → `---STORY DRAFT---` section | `originalStory.pages[n].text` |
| **Scene Hint** | `outline` → `[Scene Hint]` lines | `originalStory.pages[n].sceneHint` |
| **Characters** | `outline` → `[Characters]` lines | `originalStory.pages[n].characters` |
| **Clothing** | `outline` → `[Clothing]` lines | `originalStory.pages[n].clothing` |

## Key Things to Look For

### 1. Banned Gesture Fixes
The prompt includes banned gestures that should be caught and fixed:
- "hand on shoulder" → should become "fist bump" or similar
- "arm around shoulders" → should become "fist bump" or similar
- "ruffling hair" → should be changed

**Example fix found:**
```
Draft:  "Manuel legte einen Arm um seine Schultern."
Final:  "Manuel gab ihm einen Fist-Bump."
```

### 2. Formatting Improvements
- Paragraph splits for better readability
- Dialogue tag repositioning (e.g., "Lass Papa ausreden," sagte Franziska → Franziska sagte: "Lass Papa ausreden.")

### 3. Character/Scene Additions
- Added details about character powers/abilities
- Enhanced emotional moments
- Better explanations of magical elements

### 4. Scene Hint Consistency
Scene hints should match the final text:
- Characters mentioned should appear in scene
- Actions described should be visible
- Clothing matches the clothing field

## Output Format

Create a comparison table for each page:

```markdown
## Page N

| Aspect | Draft | Final | Changed? |
|--------|-------|-------|----------|
| **Text** | "Original text..." | "Modified text..." | ✅ Description |
| **Scene Hint** | Original hint | Final hint | ❌ No change |
| **Characters** | List | List | ❌ No change |
```

## Example Script

```javascript
const { Pool } = require('pg');

async function compareStory() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL,
    ssl: { rejectUnauthorized: false }
  });

  const result = await pool.query(`
    SELECT
      data->'outline' as outline,
      data->'originalStory' as story
    FROM stories
    ORDER BY created_at DESC LIMIT 1
  `);

  const outline = result.rows[0]?.outline;
  const story = result.rows[0]?.story;

  // Parse draft from outline (between ---STORY DRAFT--- markers)
  const draftMatch = outline?.match(/---STORY DRAFT---\n([\s\S]*?)(?=---|$)/);
  const draft = draftMatch?.[1];

  // Compare each page...
  for (const page of story?.pages || []) {
    console.log(`Page ${page.pageNumber}:`);
    console.log(`  Final text: ${page.text?.substring(0, 100)}...`);
    // Extract corresponding draft text and compare
  }

  await pool.end();
}
```

## Summary Metrics

After comparison, report:
- **Total pages**: Number of pages in story
- **Pages modified**: Count of pages with text changes
- **Banned gesture fixes**: Count of caught forbidden actions
- **Scene hint changes**: Count of modified scene hints
- **Critical issues fixed**: List of important corrections

## Related

- `analyze-story-log` - Analyze timing and costs from Railway logs
- `review-scene` - Review individual scene image generation
