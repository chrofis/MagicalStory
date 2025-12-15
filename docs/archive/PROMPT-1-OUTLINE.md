# Prompt 1: Story Outline Generation

**Location:** `server.js:4250-4273` (function `buildStoryPrompt()`)
**Called at:** `server.js:3940`
**API:** Claude API
**Max Tokens:** 8192

---

## The Prompt Template

```
Create a children's story with the following parameters:
    Title: ${inputData.title || 'Untitled'}
    Age: ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years
    Length: ${inputData.pages || 15} pages
    Language: ${inputData.language || 'en'}
    Characters: ${JSON.stringify(characterSummary)}
    Story Type: ${inputData.storyType || 'adventure'}
    Story Details: ${inputData.storyDetails || 'None'}
    Dedication: ${inputData.dedication || 'None'}
```

---

## Character Summary Format

The `characterSummary` is extracted from `inputData.characters` with only these fields:
- `name`
- `gender`
- `age`
- `personality`
- `strengths`
- `weaknesses`
- `fears`
- `specialDetails`

**Note:** Photos are explicitly excluded to avoid token limits.

---

## Example Output Expected

The outline should include:
- Story title
- Dedication
- Page-by-page outline with markers (e.g., "## Page 1", "## Seite 1")
- Page separators ("---")
- Brief description of what happens on each page
- Optional: Title Page Scene, Page 0 Scene, Back Cover Scene

---

## Notes

This is a very simple prompt that relies on Claude's built-in understanding of children's story structure. There are no explicit instructions about:
- Story pacing
- Character development
- Conflict and resolution
- Age-appropriate content
- Formatting requirements

The AI is expected to infer these from the "children's story" genre and the age range provided.
