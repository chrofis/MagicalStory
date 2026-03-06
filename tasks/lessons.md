# Lessons Learned

This file captures patterns and lessons from corrections to prevent repeated mistakes.

## Format

Each lesson should include:
- **Date**: When the lesson was learned
- **Context**: What task/feature was being worked on
- **Mistake**: What went wrong
- **Correction**: What the user pointed out
- **Rule**: The rule to follow going forward

---

## Lessons

<!-- Add lessons below as they occur -->

### 2026-02-05: Semantic Fidelity is the Main Gap

**Context**: Improving image evaluation prompts for story generation

**Mistake**: Focused on technical details (bounding boxes, defect detection, running two prompts) instead of identifying the core problem: we don't check if the generated image actually depicts what the story text describes.

**Correction**: The real gap is semantic fidelity - checking "A chases B" isn't rendered as "B chases A". Neither existing prompt compares the image to the story text for action/relationship accuracy.

**Rule**: When analyzing evaluation systems, ask "what's the actual goal?" first. For story illustrations, the goal is depicting the story correctly - not just avoiding artifacts. Start with the user's problem (story accuracy), not technical implementation details.

---

### 2026-02-05: Split Prompts for Quality, Not Overload

**Context**: After identifying semantic evaluation gap

**Mistake**: Initially proposed adding semantic checking to `generated-image-analysis.txt`, then later proposed adding it to `image-evaluation.txt` - overloading one prompt with multiple concerns.

**Correction**: User asked "Are we not overloading image detection? Is it good to have this in one prompt or better to split in 2?" - preferring quality over cost, split into focused prompts running in parallel.

**Rule**:
- When a prompt does multiple things, consider splitting for quality
- Parallel execution eliminates latency cost
- Each prompt should have ONE focus (visual quality OR semantic fidelity)
- Ask: "Does this prompt do one thing well?"

---

### 2026-02-05: Detection vs Iteration Feedback are Different Concerns

**Context**: Implementing semantic fidelity checking

**Mistake**: Added semantic checking to `generated-image-analysis.txt` (iteration feedback prompt) instead of the detection phase.

**Correction**: Two separate concerns:
- **Detection** (`image-evaluation.txt`, `image-semantic.txt`) - "Is this image good enough? What's wrong?"
- **Iteration Feedback** (`generated-image-analysis.txt`) - "Describe what's here so regeneration knows what to keep"

**Rule**: Understand the PURPOSE of each prompt before modifying it. Detection runs after every generation; iteration feedback only runs when regenerating.

---

### 2026-02-05: Cache-Only Storage Causes Pipeline Issues

**Context**: Character consistency checks were using face photos instead of styled avatars

**Mistake**: Styled avatars were stored only in an in-memory cache during generation, with persistence to character objects happening at the end of the pipeline. Consistency checks ran mid-pipeline before persistence, so they couldn't find styled avatars and fell back to face photos.

**Correction**: User pointed out log showed "No styledAvatars for pixar, fallback=photo" during consistency checks even though styled avatars had been generated earlier. Timeline showed:
- 20:38-20:40: Styled avatars generated (stored in cache)
- 20:49-20:53: Consistency checks run (can't find styled avatars!)
- 21:03: Styled avatars finally persisted to character objects

**Rule**: When generating data that will be used by multiple pipeline stages, store it on the primary objects (not just cache) immediately after generation. Don't defer persistence to the end if other steps need the data mid-pipeline.

---

### 2026-02-15: Metadata Column Must Match Full Data Structure

**Context**: Photo upload route was writing corrupted metadata to the characters table, causing the character list to show only names without gender, age, or avatar faces.

**Mistake**: The photo upload route in `avatars.js` wrote minimal metadata `{ characters: chars.map(c => ({ id: c.id, name: c.name })) }` to the metadata column. This stripped ALL display-critical fields (gender, age, physical, traits, avatars) for ALL characters, not just the new one. The GET route reads from metadata first, so the character list was broken.

**Correction**: Found the root cause at `avatars.js:1832` — the metadata write must build lightweight metadata the same way as the POST route (strip heavy base64 fields, keep everything else). Also added corruption detection + auto-repair in the GET route.

**Rule**:
- EVERY code path that writes to the `metadata` column must produce the same lightweight structure as the POST route
- The metadata column is the PRIMARY read source for the character list — corruption here is immediately user-visible
- When adding metadata writes, copy the stripping pattern from the canonical POST route (strip photos/heavy avatars, keep everything else)
- Add defensive checks: if metadata looks corrupted, fall back to the full data column and auto-repair

### 2026-02-17: Regex Patterns Must Match Current Prompt Format

**Context**: Removed numeric age (`7 years old`) from character reference text in prompts for cleaner output. This broke `parseCharacterDescriptions()` which used a regex requiring `(\d+)\s*years?\s*old` — the entity consistency check could no longer identify any characters.

**Mistake**: Changed the prompt format without updating all downstream regex parsers that depend on it. The `parseCharacterDescriptions` function silently returned empty results, causing "No entity appearances found with bounding boxes" in entity consistency.

**Rule**:
- When changing prompt format/structure, grep for ALL regex patterns that parse that format
- Silent failures (regex returns empty instead of error) are the hardest to catch — add logging when parsers return empty results
- The unified pipeline was also missing `sceneCharacters` in the options to `generateImageWithQualityRetry` — always check both storybook AND unified pipelines when adding options

---

### 2026-02-22: Token Budget Must Match Output Size

**Context**: Scene description JSON was being truncated, causing "Could not parse scene JSON for mismatches: Unexpected end of JSON input"

**Mistake**: `maxTokens=6000` was used for scene description generation, but the full JSON output (17 validation checks + characters + setting + summaries) needs 7000-10000 tokens. Response was cut off mid-JSON.

**Rule**:
- When a prompt generates structured JSON, estimate the ACTUAL output size and add 30% headroom
- If JSON parsing fails with "Unexpected end of JSON input", the FIRST thing to check is maxTokens
- Scene description calls need 10000 tokens minimum

---

### 2026-02-22: enrichedFixTargets Must Be Returned, Not Just Used Locally

**Context**: Blackout iteration mode had no fix targets despite bbox detection running successfully

**Mistake**: `enrichedFixTargets` (with precise bounding boxes from bbox detection) were computed in `generateImageWithQualityRetry` but never included in the return object. The function returned `{...result}` which only had the raw quality eval targets (often empty). The enriched targets were used locally for repair decisions but discarded on return.

**Rule**:
- When a function computes enriched/improved data, ALWAYS propagate it in the return value
- Don't compute something just for local use if downstream consumers need it too
- Check: "Who else needs this data after this function returns?"

---

### 2026-02-22: Regex Must Match Current Prompt Output Format

**Context**: Scene parser couldn't find Characters section because Claude generates `Characters (MAX 3):` but regex expected `Characters:`

**Mistake**: The regex `(?:Characters)(?::\*{0,2}|\*{0,2}:?)` required colon immediately after keyword. Claude's prompt template generates `Characters (MAX 3):` with parenthetical content between keyword and colon.

**Rule**:
- After changing prompt templates, always check ALL regex parsers that consume the output
- Add optional groups for common prompt format variations: `(?:\s*\([^)]*\))?` for parentheticals
- Test regex against actual Claude output, not assumed format

---

### 2026-02-22: All Code Paths Must Pass Same Context to Shared Functions

**Context**: Bbox detection had no character positions in regen/iterate routes, but worked fine in main pipeline

**Mistake**: Main pipeline passed `sceneMetadata`, `sceneCharacters`, `sceneCharacterCount` to `generateImageWithQualityRetry`. Regen and iterate routes called the same function WITHOUT these options. Bbox detection fell back to `extractSceneMetadata(currentPrompt)` which returned nothing because `buildImagePrompt` strips JSON metadata.

**Rule**:
- When the main pipeline passes options to a shared function, ALL other callers must pass the same options
- Grep for ALL call sites of a function when adding new parameters
- If a function has a fallback path (e.g., extract from prompt), test that the fallback actually works — stripped prompts can't be re-parsed

---

### 2026-02-22: Always Update tasks/lessons.md and tasks/todo.md

**Context**: Fixed 5 issues across a session without documenting in tasks/ files as CLAUDE.md requires

**Mistake**: Did the work but didn't follow the self-improvement loop (lessons.md) or task management (todo.md) requirements from CLAUDE.md.

**Rule**:
- At session start: read `tasks/lessons.md` for relevant patterns
- After ANY user correction: immediately update `tasks/lessons.md`
- For multi-step work: track in `tasks/todo.md` with checkable items
- Document BEFORE pushing, not after being reminded

---

### 2026-02-22: Helmet Defaults Block Social Media Crawlers

**Context**: WhatsApp link previews showed no thumbnail for homepage OG image

**Mistake**: Helmet's default `Cross-Origin-Resource-Policy: same-origin` blocked WhatsApp/Facebook crawlers from fetching the static `og-image.jpg`. The dynamic share routes had manual overrides but static files didn't.

**Rule**:
- When using Helmet, check if `crossOriginResourcePolicy` blocks social media crawlers
- For public-facing sites with OG images, set `crossOriginResourcePolicy: { policy: 'cross-origin' }` globally
- Test OG images with `curl -sI` and check the `Cross-Origin-Resource-Policy` header

---

### 2026-02-22: Stale Metadata Flags Miss New Data Sources

**Context**: First 3 stories in story list showed no cover thumbnail despite having covers in `story_images` table

**Mistake**: `hasThumbnail` in the cached metadata column was written when covers were stored in the data blob. After migrating covers to `story_images`, the metadata flag was never updated for old stories.

**Rule**:
- When migrating data to a new storage location, update all cached flags that reference the old location
- Use live checks (e.g., `EXISTS` subquery on `story_images`) alongside cached metadata for critical display flags
- Cached metadata can become stale — always consider: "What if this flag was written before the current storage scheme?"

---

### 2026-02-22: Don't Blame Caching When User Says It's Broken

**Context**: WhatsApp link previews not showing thumbnails. Repeatedly told user it was "WhatsApp caching" even after they said a brand new story had the same issue.

**Mistake**: Deflected to caching explanation 3 times instead of investigating further. The OG tags and image endpoint were actually working correctly — but I should have trusted the user's report and investigated more aggressively.

**Rule**:
- If the user says "it still doesn't work" after you explain caching, STOP suggesting caching
- Trust user reports over theoretical analysis — they're testing in real time
- Use Facebook's Sharing Debugger (`developers.facebook.com/tools/debug/`) as the definitive test
- When stuck, ask the user to test via the debugger rather than theorizing

---

### 2026-02-22: Parallel Async Loads Must Not Overwrite Each Other

**Context**: Dev metadata (API prompts, reference photos, generation history) disappeared on story load despite being fetched correctly

**Mistake**: Full metadata and dev metadata were loaded in parallel. Dev metadata merged into scene images first, but then full metadata's `.then()` callback ran `setSceneImages()` which spread `...metaScene` (without dev fields) and only preserved `imageData` and `imageVersions` from existing state. All dev metadata fields were silently overwritten.

**Correction**: User had to toggle dev mode off/on to trigger a fresh dev metadata fetch after full metadata was already in place.

**Rule**:
- When multiple async loads merge into the same state, chain them sequentially (dependent data after base data)
- If using functional state updates (`prev =>`), audit what fields are preserved vs overwritten
- Pattern: `{ ...newData, fieldA: existing?.fieldA || newData.fieldA }` must list ALL fields that could come from a different source
- Test: load a page fresh and verify all data appears without user interaction
