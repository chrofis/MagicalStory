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

### 2026-08-09: "Redo X in the lab" after a detection discussion ≠ regenerate the image

- **Context**: User was analyzing why the Charakterkonsistenz report flipped Emma/Hans on P8. They said "Redo page 8 in the lab... image must be able to differentiate between an old man and a child". I ran the `image` stage (paid regeneration, $0.02 + evals) — they wanted the `bbox` stage: re-run detection/identification on the STORED image.
- **Mistake**: Picked the expensive, destructive-ish interpretation of an ambiguous "redo" when the whole conversation context was about identification, not rendering. The word "redo" anchored me to the redo/regen machinery.
- **Rule**: When a request is ambiguous between a read-only re-analysis and a paid regeneration, default to the read-only interpretation — or ask. The conversation's subject (detection/eval vs image quality) decides what "redo/rerun" means, not the verb alone.

### 2026-08-08: Verify every assumption twice (or ask) BEFORE coding — never build on an unverified conclusion

- **Context**: Story `job_1786193650012_7baiaeftb` — Daniel & Sarah shipped 3 bad realistic avatars in a row. User asked (at the very start) to reproduce the generation prompt in the lab. Instead I ran a long analysis and repeatedly jumped to conclusions: first mis-stated the timing ("pose didn't run" — it did, proven by `poseCells` in the stored verdict + gen timestamp 12:59 > deploy 12:39), then glanced at a montage and concluded "the avatars are actually fine, it's a split artifact" — which contradicted BOTH the user AND my own pose data (`head_max 0.001` = headless). I then started proposing/writing code fixes on top of that wrong conclusion.
- **Mistake**: Let a fast visual impression override hard evidence I already had; constructed a theory to reconcile the contradiction instead of re-checking the raw data; and moved toward code changes before the conclusion was verified. Wasted a lot of the user's time.
- **Rule**:
  - **Before writing/proposing ANY code, each assumption behind it must be verified twice from independent evidence, OR surfaced to the user and confirmed** — unless explicitly in auto/autonomous mode. No coding on an unverified conclusion.
  - **When a new conclusion contradicts existing hard data (a stored score, a measurement) or the user's stated observation, STOP.** Do not build a reconciling theory. Re-pull the raw data and trust the measurement over a quick visual read. If they still disagree, surface the contradiction and ask — don't pick a side and code.
  - **Reproduce before theorising.** If the user asks to reproduce something in the lab, do THAT first — a reproduction is worth more than any amount of after-the-fact analysis.
  - An occasional bad output is expected; a *pattern* (e.g. 3-in-a-row) is a real signal — investigate the cause (prompt/template), don't explain it away.

### 2026-04-20: Field-subset drift — prompt builders that each copy their own subset of character traits

- **Context**: Roger has `physical.glasses = "schwarze Brille"`. Image correctly rendered him with glasses. Quality eval flagged them as "anachronistic", repair loop thrashed for 3 rounds trying to remove them. Unified-pass prose had also hallucinated "short dark beard" although Roger is clean-shaven.
- **Mistake**: The unified-story prompt (`buildUnifiedStoryPrompt`) built its `characterSummary` with only name, gender, age, personality, traits — it dropped every `physical.*` field. Sonnet was told to "weave physical description into prose" while given no data, so it hallucinated. Additionally, `initializeVisualBibleMainCharacters` copied only 7 coarse fields, dropping glasses/hairStyle/hairLength/facialHair. Five independent builders each had their own field subset; none carried `glasses`.
- **Rule**:
  - When writing a prompt that describes a character's physical appearance, the builder MUST receive the full `physical` object (via `getPhysical(char)`) and pass it all the way through to the model. No subsets.
  - Use the canonical path: `extractCharacterVisualProfile` → `buildLabeledPhysicalParts` → `buildCharacterPromptBlock` (in `storyHelpers.js`). Never hand-roll a field-by-field picker.
  - When a new physical field is added (e.g. "left-handed", "freckles"), grep for every builder that projects `char.physical` and route them to the canonical path. Five copies of the same picker is a smell — fix it by deleting four of them, not by adding the new field to all five.
  - For image-pipeline consumers, use VISUAL age (`ageCategory`: "school-age"/"teenager"/"adult") — not the numeric age. A 45-year-old and a 50-year-old look the same to the model. Numeric age is only for reading-level / text-generation decisions.


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

---

### 2026-03-06: Don't Mention "AI" in Customer-Facing Content

**Context**: Email templates had tagline "Personalized AI-Generated Children's Books" in footers

**Mistake**: Used the technical tagline in customer-facing emails. Mentioning "AI-Generated" undermines the magical, premium feel of the product.

**Correction**: User asked "No AI in the tagline" — changed to "Creating Magical Moments, One Story at a Time"

**Rule**:
- Never mention AI/ML/algorithm in customer-facing content (emails, marketing, UI copy)
- Use benefit-oriented language ("magical", "personalized", "unique") instead of technical descriptors
- Technical accuracy matters in docs/code, but customer messaging should sell the experience

---

### 2026-03-06: Email Footers Need Compliance Info for Deliverability

**Context**: Simplified email footer to just a centered logo + website link

**Mistake**: Removed company info (tagline, contact email, physical location) from footer. This hurts spam filter scoring and CAN-SPAM compliance.

**Correction**: User pointed out the original footer had company info and asked if it's needed for spam filters. Yes — CAN-SPAM requires physical address, and contact info improves deliverability scoring.

**Rule**:
- Email footers MUST include: company name, website, contact email, physical location
- Use table-based layout for logo + text side-by-side (no flexbox in emails)
- Footer text should be translated per language section
- Test with real email clients (not just code review)

---

### 2026-03-06: Don't Hardcode Product Details That May Change

**Context**: Email templates said "Order a printed hardcover book"

**Mistake**: Hardcoded "hardcover" in email copy when the actual product might not always be hardcover.

**Correction**: User asked to remove "hardcover" — changed to "Order a printed book"

**Rule**:
- Don't over-specify product details in templates unless they're guaranteed
- Keep product descriptions generic enough to remain accurate as offerings change

---

### 2026-03-06: German UI Copy Should Use Imperative Form

**Context**: German email bullet point "Ein gedrucktes Buch bestellen" (infinitive)

**Correction**: User said "Bestelle ein gedrucktes Buch" (imperative) is better

**Rule**:
- German action items / bullet points should use imperative form ("Bestelle...", "Sieh dir an...") not infinitive ("Bestellen...", "Ansehen...")
- Imperative is more natural and direct in German UI/marketing copy

---

### 2026-03-07: Race Conditions in Multi-Writer Save Endpoints

**Context**: Avatar generation failed with "CHARACTER NOT FOUND" after 30 retries because `POST /api/characters` overwrote the DB, deleting characters created by photo analysis

**Mistake**: Proposed a complex retry/create mechanism in the avatar route instead of fixing the root cause.

**Correction**: User pushed back: "This sounds complicated, is this really state of the art?" — the real fix was a 10-line guard in the POST route to preserve DB-only characters that the frontend doesn't know about yet.

**Rule**:
- When endpoint A creates data and endpoint B overwrites the table, fix the WRITER (B), not the READER (A)
- Always preserve DB records that aren't in the incoming payload — they may have been created by another process
- Prefer simple root-cause fixes over complex workarounds. If a fix feels hacky, step back and find the real cause

---

### 2026-03-24: Verify DB Data Before Writing Migrations

**Context**: Unifying version_index mapping for scenes (removing +1 offset). Plan assumed version_index=1 was always an empty gap for scenes.

**Mistake**: Wrote migration SQL that shifts ALL scene version_index >= 2 down by 1, assuming no rows existed at version_index=1. Reality: 210 pages had real image data at version_index=1 (created by admin migration scripts with hardcoded `i + 1`). The blind migration would have caused unique constraint violations and data corruption.

**Correction**: Ran pre-check query before executing. Discovered the 210 rows. Rewrote migration to only shift gap pages (47 pages that genuinely had no v1). Also needed two-step approach (shift up by 10000, then down by 10001) to avoid unique constraint violations during the UPDATE.

**Rule**:
- ALWAYS run pre-check queries against production data before executing migrations
- Never assume DB state matches the mental model — admin scripts, bulk imports, and edge cases create unexpected rows
- For UPDATE migrations that change indexed/unique columns, use a two-step shift to avoid constraint violations (PostgreSQL doesn't guarantee UPDATE order)
- When a migration plan says "X should not exist", verify with `SELECT COUNT(*) ... WHERE X` before proceeding

### 2026-03-25: Database Table Creation Lives in server.js, NOT database.js

**Context**: Style Lab feature — added `style_lab_images` table to `database.js`'s `initializeDatabase()`

**Mistake**: Both `server.js` and `server/services/database.js` have their own `initializeDatabase()` function with `CREATE TABLE` statements. Only the one in `server.js` runs on startup (called at line ~5182). Adding the table to `database.js` meant it was never created in production.

**Rule**:
- New tables MUST be added to `server.js`'s `initializeDatabase()` (the one that actually runs on startup)
- The `database.js` version is a secondary copy — update it too for completeness, but `server.js` is authoritative
- After adding any new table, verify it was created by checking Railway logs for the `CREATE TABLE` output

## Showcase "POST create-story never fires" was a test-locator bug, not a prod outage (2026-06-27)

**Symptom**: French (Dubois) showcase failed repeatedly — Playwright threw "POST /api/jobs/create-story did not complete within 60s". No job row, credits untouched (200), wizard stuck on Summary. German showcases worked fine.

**Wrong turns I took**: chased a server-side create-story hang (queried prod DB health, locks, idle txns), then the wizard's pre-POST avatar-regen loop, then the email-verification guard. All dead ends.

**What actually found it**: instrumented the spec to (a) capture the browser console `[generateStory]` trail and (b) report when generateStory was NEVER invoked. The trail showed the click never reached generateStory().

**Root cause**: `GENERATE_RE` had a bare `/générer/` alternative. The FR summary screen has TWO "Générer" buttons — "Générer une suggestion" (regenerate idea, earlier in DOM) and "Générer l'histoire !" (real). `.first()` clicked the wrong one. German "geschichte erstellen" only matched the real button, so DE never broke.

**Rules**:
- A button-text regex for a test MUST match the FULL per-language label, never a shared verb stem. "Generate X" and "Generate suggestion" collide on the stem.
- When a flow "silently does nothing", first prove WHICH handler ran (capture console / add a log), before theorizing about servers, DB, or downstream awaits. The fastest path to the truth was 2 console listeners, not hours of DB forensics.
- Per-language UI tests: enumerate every button containing the matched verb in EACH language before trusting `.first()`.

## 2026-07-05 — Deploy race: three "failed fixes" that never ran
**What happened:** Three consecutive staging showcases failed with the same 256MB
jsonb error. Fixes #1 and #2 were correct, but each showcase was launched ~6-10
minutes after `git push` using a blind `sleep 360` — Railway's build hadn't cut
over, so every run executed PRE-fix code. Two days of "the fix didn't work"
was actually "the fix was never deployed yet".
**Rule:** NEVER launch a validation run after a timed wait. Verify the deployed
build first — `/api/health` now returns the commit SHA (RAILWAY_GIT_COMMIT_SHA);
poll until it equals the pushed SHA, then launch.
**Second lesson:** when a "fixed" bug reproduces identically, first ask "did my
fix actually run?" (check deployed version / add a log marker) before writing
the next fix. I wrote fix #2 while fix #1 was unverified, and fix #3's review
revealed both were probably fine.
**Third lesson:** the failure-path partial-save overwrote a SUCCESSFUL full
story save (stories.data) with a checkpoint skeleton, destroying evidence and
the user's story. Failure-path writes must check what they're overwriting.

## 2026-07-08 — Week-review pattern: fixes shipped on one of two sibling paths
**What happened:** A four-agent review of the week's 42 commits found the same
defect shape four times: a correct fix applied to one code path while its
sibling kept the bug. Entity-penalty cap → scoring.js helpers but not the
inline finalScore math in images.js; clothing source-of-truth →
entityConsistency but not the eval/bbox path or the Grok repair; cover
solid-ground rule → single-pass prompt but not the two-pass fallback; cover
version imageUrl fallback → dev iterate route but not the production
/regenerate/cover route.
**Rule:** before declaring a fix done, grep for the pattern being fixed
(the raw field read, the inline formula, the prompt clause) across the whole
repo and enumerate every occurrence. Parallel paths to check explicitly:
dev-mode route vs production route, single-pass vs fallback branch, Gemini
path vs Grok path, scoring helper vs inline arithmetic.
**Second lesson:** an aggressive sanitizer (the jsonb byte sweep) shared
between write paths and read paths breaks the read path the moment it gets
stricter. When hardening a shared function, list every caller and re-verify
the read-path callers still get what they need.

## 2026-07-09 — Schema change added to the DEAD database.js init, caught on staging
**What happened:** Added `credit_transactions.price_cents` to
`server/services/database.js initializeDatabase()` — which is NOT on the
startup path. Prod/staging schema comes exclusively from `migrations/00N_*.sql`
via `server/services/migrate.js` (runs at boot, fails loud). Staging deployed
the code but the column never appeared; caught it by checking
information_schema on staging BEFORE promoting to prod. Migration 006's header
comment documents a previous session making the exact same mistake with
`trial_completion_email_sent_at`.
**Rule:** every schema change = a new `migrations/00N_*.sql` file, nothing
else. Never touch database.js initializeDatabase() or the dead
REMOVED_initializeDatabase_DEAD() in server.js. After deploy, verify the
column/table actually exists in the target environment's information_schema
before shipping dependent code to the next environment.

## Editing a call's options can silently drop a sibling line — execute it

**2026-07-12:** An Edit to `_gdinoDetect` that only meant to change
`AbortSignal.timeout(180_000)` → `300_000` also dropped the
`body: JSON.stringify({image, prompts})` line in the replacement. Every
GroundingDINO POST then went out with no body → Flask `get_json()` raised on
"char 0" → 400/500 → silent Gemini fallback on every realistic detection. I
parse-checked and module-loaded, but never EXECUTED the changed fetch, so the
runtime-only symptom slipped through — then I burned hours misdiagnosing it as
a Flask-dev-server / WSGI issue and shipped an unnecessary waitress migration.

**Rule:** when an Edit rewrites a multi-line object/args literal (fetch options,
config objects, function-call arg lists), re-read the FULL new block and diff it
line-by-line against the old — a dropped `body`/`headers`/positional arg passes
parse + load and only fails at runtime. And per smoke-testing-before-push:
actually execute the changed call path (stub the endpoint if needed), don't stop
at `node --check`. If a request suddenly "returns nothing / empty body", suspect
the CLIENT is sending nothing before blaming the server.

## Model downgrades: match the model to the REASONING type, not just cost tier (2026-07-26)
When downgrading a call off Sonnet for cost, don't reflexively pick gemini-flash
as "the cheap utility tier." First ask what the task actually REQUIRES:
- **Spatial / compositional reasoning** (repair a scene description from left/right
  + count + who's-where composition issues) → gemini-flash reasons about this
  poorly. Use a strong cheap REASONER (qwen3-max — already the codebase's trusted
  spatial model for complianceModel), still ~4× cheaper than Sonnet.
- gemini-2.5-flash's spatial strength in this codebase is VISION (bounding boxes
  for quality eval), NOT text reasoning. Don't conflate the two.
Owner corrected a gemini-flash downgrade with "those have spatial reasoning, they
probably need qwen max." Route qwen/openrouter models through guardModel() so a
missing OPENROUTER_API_KEY degrades to claude-sonnet (strong), never to a weak model.

## Image prompts: state reserved-area rules WITHOUT the purpose (2026-08-01)
Never write "reserve this area for the title / text / overlay" in an image
prompt — explaining WHY an area must stay clear makes the model treat it as a
special strip (blank white band, or worse, it paints text there). State only
the constraint + what the area SHOULD contain:
- "The top third contains no character or prop — only calm scene background
  in the scene's own colors and lighting (sky outdoors, upper wall/ceiling
  indoors). Never plain white."
Owner rule ("Explaining why area must be free is stupid"). Reserved zones:
front cover = top third; initial page = bottom 20%; back cover = bottom 10%.
Keep the wording SIMPLE — one bullet, no outdoor/indoor sub-lists beyond the
parenthetical, no design essays.

## 2026-07-17 — Test Lab: contract bugs from grep-level integration (user: "how can you have so many bugs")

Pattern behind ALL the bugs (repairMode silently ignored; fig.bbox vs stored
bodyBox/faceBox; free-text character name the system already knew; template
not loaded for avatar evals; unparsed Response body in editWithQwen):
I integrated ~20 stage runners against GREPPED SIGNATURES without opening the
callee body or a real stored record. Signature grep tells you the arg list —
not which options are consumed, what the return object contains, or what the
JSONB actually stores.

RULES going forward:
1. Before calling any existing function from new code: read the callee's
   DESTRUCTURING + RETURN statements, not just its signature line.
2. Before reading any stored-JSON field: dump ONE real record (staging DB)
   and diff the field names against the code. Never trust a field name from
   another code path's variable naming.
3. Any param my code accepts must be provably consumed downstream — trace it
   to the callee's destructure or delete it.
4. UI never asks for data the system already has (names, boxes, versions):
   derive choices from snapshots/detections; free-text only as fallback.
5. After wiring N similar units, run the CHEAPEST real invocation of each
   class (report-only stages are free) before declaring done — the pick_best/
   consolidate micro-runs caught nothing precisely because I only ran the
   units I'd already debugged.

## Test Lab must reuse production code (2026-07-18)
User correction: "Test Lab must reuse production code. That is the whole purpose. Only if we
explicitly test something can it be in test lab." The lab's hand-rolled buildExpectedCharacters
drifted from production's builder (no costume resolution) and silently broke character identity on
every costumed story. Rule for any lab stage: import the production function and vary ONLY the input
under test; if I find myself re-implementing >10 lines of pipeline logic in testlab.js, stop — either
export the production piece or the reimplementation is the bug. Silent fallbacks (stale stored box,
face→body downgrade) are the same defect class: fail loudly instead.

## The container entrypoint is start.sh, NOT `npm start` (2026-08-04)
Chasing a Railway memory bill I "found" `--max-old-space-size=8192` in
`package.json` and reported it as the root cause. Wrong: the Dockerfile `CMD` is
`bash start.sh`, and start.sh runs `node server.js` directly — that flag had
never executed in production. The real defect was the *absence* of any cap.
RULE: before attributing runtime behaviour to a flag, trace the ACTUAL exec
chain (Dockerfile CMD → shell script → binary). A flag in `package.json`
`scripts` proves nothing about a container that never runs npm. Same class of
error as trusting a field name from another code path — verify the path that
actually runs.

## Stored rows are not RAM (2026-08-04)
I proposed pruning staging Postgres to cut its memory line. User: "the issue is
not the accumulated stories, they do not need RAM." Correct — Postgres RSS is
`shared_buffers` + per-backend memory + page cache, not table size. Checked
after: 12 connections, `shared_buffers=160MB`. Disk growth and the memory line
are separate problems; don't conflate "the DB is big" with "the DB needs RAM".

## Batch through the lab's run mechanism — not per-item bespoke scripts (2026-08-06)
Debugging the cyber-avatar background bug I wrote three separate throwaway node
scripts, each looping `runStageOnTarget` per character and hand-inserting its own
`testlab_experiments` row (#364 eval, #367 eval+bg-check, #368 regen). It worked,
but the user: "do fucking experiments not individually." The reproducible path is
the lab's OWN batch machinery: pin the failing cases to a `testlab_set` ONCE, then
re-run the set with the prompt/param change as a `variant` (executeExperiment /
`POST /sets/:id/run`). One row per run, every target inside it, re-runnable from the
UI with the override recorded — vs a bespoke script that vanishes and can't be
replayed. RULE: never author a per-item loop that hand-builds experiment rows. If
the same set of targets needs a second pass (new prompt, new eval, regen), it's a
set re-run with a variant, not a new script.

## Eval prompts grew into incident logs — length is a defect, not thoroughness (2026-08-08)
Owner, seeing the evaluator prompt: "This is way way too long and has to get fixed."
`image-evaluation.txt` is 36,321 chars / 406 lines — 129 bullet rules and 119 instances of
"never / do not deduct". Filled for one page: 46,019 chars ≈ 11,500 tokens. One 10-page
story spent 862,221 input tokens over 109 eval calls (~86k input tokens PER PAGE).

Every paragraph in there is individually defensible — each was added to stop one specific
false positive. Together they stop working: §4 already caps accessory details at MODERATE
and "missing glasses" still came back MAJOR five times in one story; two identical runs at
temperature 0 produced 0/6 identical issue sets. I contributed to this — I added the same
art-style rule in FOUR places across two files, because there is no single place in a 406-line
file where a rule is reliably read.

RULE: when an eval misfires, do not append another carve-out paragraph. First check whether a
rule for it already exists and is being ignored — if it is, the fix is consolidation or
removal, not addition. Adding text to a prompt this size measurably buys nothing and makes
the next person's rule less likely to be read. Before editing any eval prompt, check its size
in `docs/prompt-inventory.md` (Evaluation section carries char/line counts) and prefer
deleting or merging over appending.

## 2026-08-13: "Get ready" is not "run it"
Prepared a full-story rerun (dry-run, deploy check, payload) and then LAUNCHED it
without a final explicit go. "Get ready", "prepare", "set up" end at the ready-to-fire
state: show the exact command + cost, then wait. A paid run launches only on an
explicit "run/go/launch" for THAT run — answering setup questions (env, style) is
configuration, not authorization.

## 2026-08-14 — A new evaluator input must be traced to EVERY caller's data shape
Added CLOTHING_CONTRACT reading `clothingDescription` off the refs array and validated it on the
generation-time eval path — but the repair-round batch eval passes a DIFFERENT refs array
(`allCharacterPhotos`, `{name, photoUrl}` only, predating the feature), so the contract was silently
empty on every batch eval; a correct costumed cover was HARD_FAILed and repair-stripped. The warning
I added even fired in logs, unnoticed. Rule: when adding an input that a shared function derives
from its arguments, grep every call site and verify each caller's argument SHAPE actually carries
the field — and make empty-input warnings fire for every evaluation type, not just the one I tested.

## 2026-08-15 — from the wardrobe/consistency/title sessions
- **Use the stored boxes before inventing geometry.** I cut head crops as a blind top-of-body band while every figure carried `faceBox` + a SAM mask ("we have face boxes not?"). Before deriving any region, grep the detection payload for what's already there.
- **A prompt rule proves the writer CAN comply, not that it WILL.** Bible set costumed:mermaid one day, false the next, from near-identical inputs. Fixes that must hold need an enforcement point (reviewer with the evidence + a merge that can apply the correction), not another writer sentence.
- **When a reviewer's output is dropped, suspect the parser before the model.** DeepSeek's `costumed (costume: mermaid)` heading was valid — mirrored our own echo format — and my parser binned it. Accept every notation we ourselves print.
- **Tolerant parsers hide producer drift until one strict consumer meets one odd form.** Audit contracts producer-side (the notation each prompt prescribes), not just parser-side. Found: era lost on iterate, UPPERCASE severities charging 0, wornAs missing in beats mode.
- **"Keep every fact" + "cut 25%" is unsolvable; models pick a side.** Flash deleted facts, DeepSeek refused to shorten. Name the MAIN POINTS to keep and say them in fewer words — 0.5% → 33% compression with nothing lost.
- **The beat states the action, not the aftermath, and never composes the frame** — scale/framing words in beats get overridden by the reference photo anyway; put the story in the pose.

## 2026-08-23 — rerun-full runs on the SOURCE story's account (a real customer)
Fired a full rerun of a customer's story to test new prompts; the job ran on
HER account and would have emailed her at completion (story-complete email).
Only a container restart stopped it, because cancel had no check after the
image phase. Rules going forward:
1. Before ANY rerun-full: check who owns the source story (`stories.user_id`
   → users.email). If it is not an owner/admin account, STOP and ask.
2. State scope + cost before firing any run that generates images — "rerun"
   from the user does not imply the full pipeline.
3. The adminRerun flag now suppresses the email, but the story still lands in
   the source account's library — repoint stories.user_id after completion.

## Never re-login per poll — cache the admin token (2026-08-23)

**What happened:** every status poll and every helper script ran
`scripts/admin/get-admin-token.js`, which logged in fresh each time. Dozens of
logins across one session tripped the login rate limiter — `429 Too many login
attempts, try again in 15 minutes` — and the lockout landed mid-experiment,
blocking the next Lab run for a quarter of an hour.

**Rule:** capture the token ONCE per shell and reuse it (`TOK=$(node
scripts/admin/get-admin-token.js)` at the top of a loop, never inside it). The
helper now caches to the OS temp dir until shortly before expiry, so repeated
calls are free; `--no-cache` forces a fresh login.

**The wider pattern:** a monitor that re-authenticates every tick is
self-throttling. Anything a poll loop does per iteration — logging in, opening a
DB pool, spawning node — should be hoisted out of the loop or cached.

## A payload cannot change a character's age — the job re-reads the account row (2026-08-25)

**What happened:** validating toddler mode (`age <= 3` on the focus character)
called for a 10-page story with a toddler main character. The smoke runner was
given a `--mainAge=2` flag that overrode the age in the POSTed payload. The job
ran to completion and produced "Emma und der vergrabene Schatz" — a buried
treasure quest, which toddler mode explicitly forbids ("Never a quest, a search,
a rescue, a secret or a prize"). The stored story had Emma at age 5.

**Root cause:** `processStoryJob` replaces `inputData.characters` wholesale with
the rows from `characters_<user_id>` (the 2026-08-10 cross-account guard, added
after a story generated with another account's faces). Every payload field on a
character — age included — is discarded. `inputData.mainCharacters` is NOT
overwritten, which is why `--mains=1` worked and `--mainAge=2` did not.

**Rules going forward:**
1. To exercise age-driven behaviour, change the age on the characters ROW,
   snapshot the original first, and restore it as soon as the run completes.
2. A validation knob that the pipeline can silently discard must fail loudly,
   not degrade. `--mainAge` now exits with an explanation instead of producing a
   confidently wrong story. Prefer this shape for any test flag.
3. Before spending on a validation run, ask which layer actually reads the knob.
   The payload is not the source of truth wherever a guard re-hydrates from the
   database.

**Also:** the runner's poll timeout was sized from the text phase alone
(~520-631s for 10 pages) and expired at 64% while the job was healthy. A poll
exiting non-zero is not a failed story — check `story_jobs` before concluding
anything.

## 2026-09-01 — Fixes without tripwires rot silently
Three separately "already fixed" mechanisms were found dead this weekend, all killed by later
refactors that nothing detected: the character-repair scene template (orphaned by the Stage-3
refactor — loaded, zero consumers), the entity→char-fix severity gate (uppercase/lowercase,
dead for weeks), the entrance rules (both redesign commits each assumed the other kept them).
Rule: a fix is not done when the code changes — it is done when something breaks loudly if the
fix stops working. Every mechanism fix ships with at least one of: a regression test, a
startup/wiring assertion (template has ≥1 consumer; gate matches ≥1 stored real finding), or a
bugs.json entry whose repro script can be re-run. "Verified today" is worth nothing in a repo
where five agents refactor concurrently.

## 2026-09-02 — Never repo-wide `git checkout`/`restore` in a shared tree
An agent left `git checkout HEAD -- .` in a helper loop while filtering its own hunks; it reverted EVERY
uncommitted tracked file from all concurrent sessions (recovered except possibly start.sh +
tests/unit/inpaint-routing.test.ts edits). Rule: to stage only your own hunks, build a filtered patch and
`git apply --cached` it — never a checkout/restore with a repo-wide pathspec. Same day, two agents also had
their staged index swept into a foreign commit: commit promptly after staging, and name what you commit.

## 2026-09-06 — parallel agents in one worktree
- A finding list from an eval is a menu: present it, let the owner triage, dispatch only chosen items. Fanning out agents first got "stop your agents".
- Never leave a stopped agent's partial hunks in shared files: another session swept `require('./vbElementBudget')` to staging while the module was untracked → deployed code that would crash page generation. After every push, verify every new `require` target is tracked.
- Dirty shared file → commit your hunk only via `git show HEAD:` copy + `git hash-object -w` + `git update-index --cacheinfo`; verify with `git show HEAD -- file`. Never `git add -A`, never stash on the shared tree.
- Showcase spec: Playwright `hasText` is a contains-match; "Realistic" matched the category header, not the card. Assertions must accept the wizard's auto-advance.

## 2026-09-06 — `showcase.js --help` launches a real PRODUCTION run
`scripts/admin/showcase.js` ignores unknown flags and defaults to production. Probing it
with `--help` (2026-09-06) started a real Dubois showcase on prod; it died only because the
output pipe closed. Never execute the orchestrator to learn its options — read the header
comment (`sed -n 1,60p`) and `parseArgs()` instead. Same rule for every script under
`scripts/admin/` that talks to a backend: read, don't run.

## 2026-09-06 — Verify a scripted patch landed BEFORE the paid run
A node heredoc patch on `tests/trial-to-full.spec.ts` silently did nothing (escaped
backslashes in the search string), the run was launched anyway, and it burned another
preview avatar failing on the exact same line. Rule: after any scripted edit, `grep` for the
new text and read the diff; if a run costs money, the patch check is part of the launch
command, not an afterthought. Prefer the Edit tool for literal replacements.

## 2026-09-06 — Never a bare `git commit` on the shared tree
Two sessions swept each other's staged files within ten minutes: `git add <paths>` followed by
a bare `git commit` takes WHATEVER is staged at that instant, including another session's
files. 451286c91 carries one session's decisions entry over another session's diff. Rule:
`git commit -- <explicit paths>` always, so a commit can only contain the files its author
named; re-check `git show --stat HEAD` before pushing. Owner decision: one shared tree stays,
discipline tightens. Also announce before starting a run; the push gate cannot see the build
window, so a job that starts during a build dies on the restart.

## 2026-09-06 — `--allow-empty` is not protection either
An attribution note committed with a bare `git commit --allow-empty` took seven files another
session had just staged (a8a6b5566). Rules that survive tonight: (1) never stage until the
moment you commit, and commit in the same command; (2) every commit names its paths with
`git commit -- <paths>`; (3) a deliberately empty commit is `git diff --cached --quiet &&
git commit --only --allow-empty`; (4) `git show --stat HEAD` before every push.

## 2026-09-06 — `docs/decisions.md` is a hotspot: stage it by hunk
Appending an entry and `git add docs/decisions.md` took three uncommitted amendments another
session had made further up the same file (655b25f9b). An empty index is not enough when the
FILE is shared; check `git diff <file>` shows only your hunks, or stage your hunk alone with
`git diff -U3 -- <file>` → keep your hunk → `git apply --cached`. Hot files tonight:
promptBuilders.js, decisions.md, BACKLOG.md, prompts/story-*.txt.

## 2026-09-06 — Get the authoritative artifact before theorising about a third-party UI
A customer-facing "Google hasn't verified this app" screen took three wrong diagnoses before
the right one, and every wrong turn came from reasoning about state I could not see. Theory 1
(sensitive scopes on the customer project leak project-wide) died when the console's Data
Access tables came back empty. Theory 2 (the owner was looking at the admin project's tab)
died the moment the actual consent URL arrived carrying `client_id=…cl8hv6p5…` — the customer
login client. The screen text alone never carried a client_id or a scope list, so re-pasting it
could not discriminate between causes; the URL settled it in one message. Rule: when the
evidence lives in a third-party console or a browser flow, ask for the ONE artifact that
identifies the actor (a URL with its query string, a request id, a config table's contents) and
stop reasoning until it arrives — and when a datum is asked for twice and not supplied, give the
full remaining fix list rather than asking a third time. Also worth remembering: repo greps do
prove things here — `grep` over both auth paths showed `scope: 'openid email profile'` and
nothing else, which is what ruled out a rogue scope and pointed at undeclared-scope state.

## 2026-09-07 — A price in a code comment is not a price

**What happened:** I told the owner Gemini 3.7 Flash was cost-neutral against 2.5 Flash, taking "$0.38/$1.88 per 1M" from a comment in `server/config/models.js`. The owner doubted it. The vendor pages say $0.75/$3.75 (Flex, Google list through 2026) and $1.50/$7.50 (standard route, list from 2027): 1.8-3.5x per call, not neutral.
**Rule:** any cost comparison put in front of the owner is computed from a vendor page fetched that day (ai.google.dev pricing, openrouter.ai model page, x.ai pricing), with the source named in the table. Repo comments, memory and model-card summaries are leads, never the number. Include the date-bound price when the vendor announces a change.

## 2026-09-08 — "All 4 fixed" after viewing 2

Reported four page re-renders as fixed having looked at two of them. The owner
opened the other two: one was improved-but-wrong (a scale drawn as a dish of
scales), one was not fixed at all (the trapped woman could reach the rim; a model
pose where the beat needed distress). Same failure class as
`feedback_view_actual_pixels_not_metadata` and
`feedback_evaluate_every_picture_after_run`, one level up: an agent's summary of
an image is not the image either.

Rule: a claim that N things are fixed requires N looks — mine, not the agent's.
Report per item ("2 fixed, 1 improved, 1 not") before any group verdict. A
group verdict issued on a sample is a guess wearing a conclusion's clothes.

Second lesson from the same page: the trapped figure was drawn reaching the rim
because the BEAT said "gripping its rim". A beat that puts an exit within a
trapped character's reach has contradicted its own story; downstream stages
drew it faithfully. When an image is "wrong", read the beat before blaming the
Art Director or the renderer — the earliest stage that states the contradiction
owns it.

## 2026-09-08 — "No fallback logged" is not "the model ran"
Claimed the first staging story ran under the Qwen inventory because no fallback warning appeared. It never ran: the pipeline passed the default quality model as an override, which beat the inventory key. The absence of a failure log says nothing about which model answered. Rule: before claiming model X ran, read a stored per-call signature (token count, modelId, response shape) on the actual rows — and compare it to a Lab run of X where the model is known.

## 2026-09-08 — A rule drafted from one failure comes out as that failure's jargon

Sent the owner a beats rule for the "stick levers water into the trough" page
written in the vocabulary of that page: tool, target, receiver, strike, release.
He rejected it: not generic, and unreadable English. The generic rule already
existed ("one moment — no before-and-after"); the gap was only that the action
count let cause + effect pass as one. The fix was one plain line: a deed is one
action, its effect another, where the effect goes a third; extra ones move to
the next page.

Rule: before sending any prompt rule, rewrite it with zero words from the
motivating page, then read it against two unrelated pages (a door pushed open
onto a room; a chip pressed to a scale while someone refuses). If it only
makes sense for the page that broke, it is not a rule yet. Short sentences,
no em-dash chains.

## A prompt check that detects reliably is not a prompt check that repairs (2026-09-09)

Adding a check to a critique prompt proves the model can SEE a fault. It proves nothing about
whether the model can FIX it. Fourteen paid attempts went into forcing a planner to split a page
it correctly identified as holding two actions; every attempt it answered by destroying the page
instead. Before promoting a new check to must-fix, ask what the model does when it is told to
repair that fault, and what the worst repair looks like next to the original fault. If the worst
repair is silent and the fault is visible, leave the check advisory.

## A heredoc ends the && chain (2026-09-09)

A `cat >> file <<EOF` inside an `a && b && c` chain terminates the chain at the heredoc: every
command on the lines after the closing EOF runs UNCONDITIONALLY. That is how a commit and a push
to staging ran after step one of the chain had already failed — the tree happened to be green,
verified afterwards, but the gate did not run before the push. Rule: a heredoc is always the
ONLY command in its Bash call. Write the file first, on its own; run the guarded chain second,
with `-m` flags and no heredocs in it.

## 2026-09-09 — a `python - <<'EOF'` heredoc still eats backslashes
A `\n` written inside a quoted heredoc arrived at Python as a real newline, so
every `assert old in s` against a JS template literal containing `\n` failed
silently-looking ("no match") while the file was obviously right. Build such
needles with `B = chr(92)` and concatenate — never rely on `\n` surviving the
heredoc. Two wasted edit attempts before this was spotted.

## A pipe masks a failed push; a wait loop needs a bound (2026-09-10)

In a guarded && chain, `git push ... | grep | tail` reports TAIL's exit code, so a push the pre-push gate
refused read as success and the chain went on to "wait for the deploy" of a commit that never left the
machine - an unbounded `until curl ...` loop that ran until the OS killed it for memory. Two rules:
(1) never pipe a command whose exit code guards the chain - run it bare, or `set -o pipefail`;
(2) every wait loop gets a deadline (`for i in $(seq 1 60)` ...) and fails loudly when it expires.
The gate itself was right (check-no-undef found three real ReferenceErrors).

## Never pipe the test runner in a guarded chain (2026-09-10, same day as the push lesson)

Recorded this morning for git push, repeated this afternoon for vitest: `npx vitest run | grep -E "Tests |FAIL"`
exits with GREP's status, so two failing tests read as success and the chain committed and pushed them
(34b7d7a8). Rule: `npx vitest run --reporter=dot > "$LOG" 2>&1; RC=$?; tail -3 "$LOG"; test $RC -eq 0 && ...`
- the exit code comes from the runner, never from a filter. Applies to every command whose result
gates the next step: run it bare or capture to a file, then filter the file.

## 2026-09-11 — a stage that fails open is invisible until you count it
The production composite aborted on every trigger for 17 days ("cleanBackgroundPrompt or scene.description required") and nobody saw it: the pipeline caught the throw, kept the direct render, and every "composite verdict" in that period was a Lab verdict. A rerun meant to validate a composite change validated nothing.
Rules: (1) before claiming a stage ran, read the stored outcome field for the pages it should have touched (here `compositeOutcome`), not the log of the change; (2) when wiring a call from a closure, confirm each field exists ON THAT OBJECT at that point (`pageData.scene.sceneDescription`, not `pageData.sceneDescription`); (3) a fail-open stage needs an abort count in the run summary.

## 2026-09-13 — "no reference in the database" is not proof an object is dead
Three R2 orphan classifiers in one session, three different false-positive classes, all from the same
inference: absence of a reference means deletable. (1) An `orders` row owns a PDF but never stores its
URL — structurally invisible to a URL scan; 22 paid-order PDFs were queued for deletion. (2)
`dbHousekeeping.js:148` writes `{table}/{userId}/{rowId}/migrated/…`, so segment 2 is a USER id — a live
user with 27 stories and 77 orders landed on the delete list. (3) Numeric ids are simultaneously user ids,
character ids and JSONB values, so the substring VERIFIER was wrong too.
Rules: (1) when a destructive action rests on "X is absent", find a positive test instead — here, group by
owner prefix and delete only if ZERO members are in the referenced set, which never interprets an id;
(2) an unrecognised shape is protected, never defaulted to deletable; (3) verify a classifier by sampling
and proving the negative through a DIFFERENT code path — that is what caught it; (4) price the thing before
proposing deletion: the whole 20 GB bucket cost $0.16/month, so storage was never a reason to delete
anything, and the owner's actual concern was deletion COMPLETENESS.
