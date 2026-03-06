# Prompt 2: Full Story Text Generation

**Location:** `server.js:3967-4002`
**API:** Claude API
**Two Modes:** Batch Mode (for lower API tiers) and Single-Shot Mode (for higher tiers)

---

## Mode Selection

```javascript
const useBatching = STORY_BATCH_SIZE > 0 && STORY_BATCH_SIZE < totalPages;
```

- **Batch Mode:** Used when `STORY_BATCH_SIZE` is set (e.g., 5-10 for Tier 1 API limits)
- **Single-Shot Mode:** Used when `STORY_BATCH_SIZE` is 0 (requires higher rate limits)

---

## Batch Mode Prompt

**Max Tokens:** 16,000 per batch
**Location:** `server.js:3967-3975`

```
Based on this outline:

${outline}

Now write the complete story text with full narrative details, descriptions, and dialogue for PAGES ${startPage} through ${endPage} ONLY.

CRITICAL: You MUST preserve ALL page markers exactly as they appear in the outline:
- Keep all "## Seite X" or "## Page X" headers for pages ${startPage}-${endPage}
- Keep all "---" separators between pages
- ${batchNum === 0 ? 'Include the title and dedication at the beginning' : 'Start directly with the page content (no title/dedication)'}
- Write ONLY pages ${startPage} through ${endPage}

Write the full story content for each page in this range, but maintain the exact page structure from the outline.
```

**Process:**
- Story is split into batches of `STORY_BATCH_SIZE` pages
- Each batch generates `startPage` through `endPage`
- First batch includes title and dedication
- Subsequent batches start directly with page content
- All batches are concatenated with `\n\n` separator

---

## Single-Shot Mode Prompt

**Max Tokens:** 64,000 (Claude Sonnet 4.5's output limit)
**Location:** `server.js:3994-4001`

```
Based on this outline:

${outline}

Now write the complete story text with full narrative details, descriptions, and dialogue.

CRITICAL: You MUST preserve ALL page markers exactly as they appear in the outline:
- Keep all "## Seite X" or "## Page X" headers
- Keep all "---" separators between pages
- The structure must remain: Title, dedication, then each page with its marker

Write the full story content for each page, but maintain the exact page structure from the outline.
```

**Process:**
- Entire story generated in one API call
- Faster and more coherent than batch mode
- Requires higher API rate limits

---

## Critical Instructions

Both prompts emphasize:
1. **Preserve page markers** - Keep "## Seite X" or "## Page X" headers exactly
2. **Preserve separators** - Keep "---" between pages
3. **Maintain structure** - Title, dedication, then pages in order
4. **Full narrative** - Complete story with details, descriptions, and dialogue

---

## Example Input/Output

**Input (Outline):**
```
# Die Abenteuer von Max

Für meinen lieben Sohn

---

## Seite 1
Max wacht auf und findet eine magische Karte.

---

## Seite 2
Er folgt der Karte in den Wald.
```

**Output (Story Text):**
```
# Die Abenteuer von Max

Für meinen lieben Sohn

---

## Seite 1

Der Sonnenschein fiel durch das Fenster und kitzelte Max an der Nase. Er öffnete die Augen und streckte sich. Da sah er etwas Merkwürdiges auf seinem Nachttisch – eine alte, vergilbte Karte mit seltsamen Symbolen darauf. "Was ist das?", fragte er sich und nahm die Karte in die Hand. Sie fühlte sich warm an und begann leicht zu leuchten.

---

## Seite 2

Neugierig folgte Max den Markierungen auf der Karte. Sie führten ihn zum Waldrand, wo die hohen Bäume wie Wächter standen. "Sollte ich wirklich dort hineingehen?", überlegte er. Aber die Karte leuchtete heller und schien ihm den Weg zu zeigen. Mit klopfendem Herzen machte er den ersten Schritt in den dichten Wald.
```

---

## Notes

- The prompt assumes Claude will understand "full narrative details, descriptions, and dialogue" without specific examples
- No explicit word count or length guidance per page
- No tone or style instructions (e.g., "exciting", "gentle", "humorous")
- Relies on the age range from the outline to set appropriate complexity
