# Prompt 3: Scene Descriptions Generation

**Location:** `server.js:4012-4024`
**Called at:** `server.js:4025`
**API:** Claude API
**Max Tokens:** 4096

---

## The Prompt Template

```
From this story, create EXACTLY ${inputData.pages} scene descriptions for the ${inputData.pages} pages of the story.

Format: Provide ONLY the scene descriptions, one per line, separated by double newlines. Do NOT include:
- Page numbers
- Introductory text
- Explanations
- Separators like "---"
- Any other formatting

Each scene description should be a single paragraph describing what should be illustrated for that page.

Story:
${storyText}
```

---

## Purpose

This prompt extracts visual scene descriptions from the full story text to guide the image generation in the next step.

---

## Input

**Story Text:** The full story text generated in Step 2, including all pages with their markers and separators.

**Example Input:**
```
# Die Abenteuer von Max

Für meinen lieben Sohn

---

## Seite 1

Der Sonnenschein fiel durch das Fenster und kitzelte Max an der Nase. Er öffnete die Augen und streckte sich. Da sah er etwas Merkwürdiges auf seinem Nachttisch – eine alte, vergilbte Karte mit seltsamen Symbolen darauf.

---

## Seite 2

Neugierig folgte Max den Markierungen auf der Karte. Sie führten ihn zum Waldrand, wo die hohen Bäume wie Wächter standen.
```

---

## Expected Output Format

**Important:** The output should be ONLY scene descriptions, one per page, separated by double newlines:

```
Ein kleiner Junge namens Max liegt in seinem Bett am Morgen. Sonnenlicht strömt durch das Fenster. Auf seinem Nachttisch liegt eine alte, leuchtende Karte mit mysteriösen Symbolen.

Max steht am Rand eines dichten Waldes. Er hält die leuchtende Karte in der Hand und schaut auf die hohen Bäume vor ihm. Die Karte zeigt einen Weg in den Wald hinein.
```

**NOT:**
```
Page 1: Ein kleiner Junge...  ❌ (no page numbers)
Scene 1: Ein kleiner Junge... ❌ (no labels)
---                           ❌ (no separators)
Here are the scene descriptions: ❌ (no intro text)
```

---

## Post-Processing

After receiving the output, the code parses it using `parseSceneDescriptions()` (server.js:4276-4310):

**Parsing Rules:**
1. Split by double newlines (`\n\n`)
2. Filter out empty lines
3. Filter out separators (`---`, `***`, `___`)
4. Filter out lines shorter than 20 characters
5. Filter out page headers (e.g., "Page 1:", "Scene 1:")
6. If more scenes than expected, trim excess
7. If fewer scenes than expected, warn but continue

**Validation:**
```javascript
if (scenes.length > expectedCount) {
  console.warn(`Got ${scenes.length} scenes but expected ${expectedCount}, trimming excess`);
  return scenes.slice(0, expectedCount);
}
```

---

## Example Full Pipeline

**Input Story (2 pages):**
```
# Max and the Magic Map
For my dear son
---
## Page 1
Max woke up to find a glowing map on his nightstand...
---
## Page 2
Following the map, Max entered the mysterious forest...
```

**Scene Descriptions Output:**
```
A young boy named Max lying in bed in the morning, sunlight streaming through the window. On his nightstand is an old, glowing map with mysterious symbols.

Max standing at the edge of a dense forest, holding the glowing map in his hand, looking up at the tall trees before him.
```

**Parsed Array:**
```javascript
[
  "A young boy named Max lying in bed in the morning, sunlight streaming through the window. On his nightstand is an old, glowing map with mysterious symbols.",
  "Max standing at the edge of a dense forest, holding the glowing map in his hand, looking up at the tall trees before him."
]
```

---

## Notes

- This prompt is designed to extract **visual** descriptions, not narrative content
- Each description should be a single paragraph focusing on what to **illustrate**
- No character dialogue or internal thoughts
- Focus on setting, character positions, and key visual elements
- The descriptions will be used to generate images in Step 4
