# Covers as pages — plan (2026-09-24)

Owner, 2026-09-24: *"Do it the same as a page. The AD makes full briefs of the image. No code telling the AD
what is in the code. Basically what is in the code should be the beats for the cover pages, and the AD treats
it like any other page."*

This rejects the 2026-09-23 design (a structured cover hint + an Art Director `Scene:` line + a code-built
cover scene). **No code in this plan is written yet.** Owner decisions are collected in §8.

---

## 1. Current cover data flow (as of staging 7f4699979)

### Full story (beats pipeline)
| Step | Where | What happens to a cover |
|---|---|---|
| Writer / planner | `beatsPipeline.js` steps 0-2 | Covers do not exist. No beat, no plan line. |
| Wardrobe | step 3, `story-bible-from-beats.txt` | Clothing contract; covers read it later. |
| Art Director | step 4, `scene-expansion-all.txt` "## Cover scene hints" + `---COVER SCENE HINTS---` | ONE call writes the Visual Bible, then three STRUCTURED cover hints (`Mood`, `Objects`, `Scene` [added 09-23], `Characters: Name (position): clothing, holds, priority`), then the page briefs. Cover rules live in the prompt: one LOC each, distinct, real landmark preferred, props belong in the backdrop, `holds` is one ART, cast from `{COVER_CAST}` (`buildCoverCastLines`: Title Page = mains only; Initial/Back = up to 5 incl. mains), costumed-if-any, `{COVER_ELEMENT_CAP}`, title-named creature on the Title Page. |
| Scene review | step 5, `scene-review.txt` | Reviews page briefs only. Covers are never reviewed. |
| Parse | `outlineParser/unified.js extractCoverHints` (+ `progressive.js` streaming emit) | Hint objects; code enforces one-backdrop / real-landmark / distinct-per-cover; `validateCoverHintCast` (coverIterate) drops phantom names. `reconcileCoverClothingWithRequirements` (clothingCategories) rewrites per-cover clothing. Stored as `stories.data.coverHints`. |
| Build | `storyJobPipeline.js startCoverGeneration` (~l.1450-2000) | Code picks the cast (`MAX_COVER_CHARACTERS`, main/extras split), clothing, worn-vs-held dedupe (`applyCoverWornHeldDedupe`), then **code writes the scene text** (`buildCoverSceneFromHint`: starter sentence, AD `Scene` prose, one sentence per character, gaze sentence), cover NAME invariant (`reconcileCoverSceneEntities` — strips/injects names), `coverBriefWithObjects` (METADATA block → REQUIRED OBJECTS), `buildCoverPrompt` (image-generation.txt + `cover-composition.txt` section + baked TITLE / REQUIRED TEXT). |
| References | `coverIterate.buildCoverReferences` | Landmark photos, a cover PLATE (from the cover prose via `buildPlateDescription`, plate-or-fail), VB grid by hint ids + name-match union. |
| Render | `generateImageOnly` | `coverAspect`, cover model / baked-title model, shrink (must-keep tail). Composite path (`coverComposite.js`) when >5 figures. |
| Record | `rawImages.push` cover pseudo-pages (l.~6261; sibling set `pipeline-page-record-vs-cover-record`) | `coverImages.{frontCover,initialPage,backCover}` + `story_images` rows keyed by cover key. |
| Eval | `images.evaluateImageBatch` cover branch (`evalPipeline.js`) | Same judges as pages + `cover-evaluation-notes.txt` (gaze, flat title, text regime), expected text (title/dedication), D-16b from the sent prompt's REQUIRED OBJECTS. |
| Repair | `repairPipeline.js` → `iterateCover` for covers (pages use iteratePage / char-fix / inpaint) | `iterateCover` re-reads the STORED description + `coverHints`, re-briefs, re-renders. |
| User iterate / regenerate / Lab | `regeneration.js` (3 routes) + `testlab.js` cover stage → `iterateCover` | Same. |
| Typography | `coverTypography.js` | Baked title on front (SETTLED); dedication / back text app-stamped where not baked. |

### Trial
| Step | What happens |
|---|---|
| Writer (`story-trial.txt`) | ONE call writes title, VB, **`---COVER SCENE---` JSON** (`imageSummary`, `setting`, `characters`, `objects` — the same shape as a trial page's SCENE HINT), then the pages. |
| Streaming (`storyJobPipeline.js onCoverScene`, l.~2341) | The JSON blob IS the scene description (trial pages likewise: "using rich scene hints directly", l.~3503). Cast = main character(s), name invariant (token mode), `withTrialCoverObjects`, `buildCoverPrompt('front')`, `buildCoverReferences` (trial plate from `trialCoverPlateDescription`), render. |
| Hints | `coverHints.frontCover` for a trial is a derived LOC-only hint (not the writer's objects). |
| Repair / regenerate | `iterateCover` on the stored JSON brief (kept as-is since 09-23). |

---

## 2. Target flow

**A cover is a page the Art Director briefs.** Code owns only the cover's BEAT (its plan line + the facts code
already knows) and the render-side concerns that genuinely differ (§2.3).

### 2.1 Full story
1. `beatsPipeline` appends three cover beats (§3) to the page beats handed to the Art Director, with the cover
   page numbers `COVER_PAGE_NUMBERS` (−1 / −2 / −3).
2. The Art Director writes a full page brief for each (prose, `characters[]` with positions/depth/looksAt,
   `interactions[]`, `objects[]`, `wornItems`, `emptyScenePrompt`, metadata) under its own page header, by the
   SAME rules as every page. No separate cover section in the template.
3. The scene review (step 5), the mechanical brief checks (`sceneBriefCheck`, `clothingCheck`), and the brief
   corrective loop see them like any page (subject to Q3).
4. The cover renders through the PAGE render path (`buildImagePrompt` via the page references
   `getElementReferenceImagesForPage` + the AD's `emptyScenePrompt` plate) with cover render options (§2.3).
5. Eval, repair (iteratePage / char-fix / inpaint), user iterate/regenerate and the Lab go through the page
   entry points, keyed by the cover page number; results are stored back into `coverImages` (Q5).

### 2.2 Trial (decision proposed: the trial cover becomes a normal trial page)
The writer's `---COVER SCENE---` JSON is already a page-shaped scene hint. It is parsed as page −1 and rendered
by the SAME trial page render path the trial pages use (`sceneHint` as `sceneDescription`), with the cover
render options. It keeps its early streaming start (it is written first). The derived LOC-only trial
`coverHints` disappear. `story-trial.txt` COVER SCENE text stays the trial's cover "beat" (the trial has no
beats; the writer IS its own Art Director, exactly as for its pages).

### 2.3 Cover concerns that stay cover-specific (render / eval / storage only)
| Concern | Where it stays |
|---|---|
| Aspect (`MODEL_DEFAULTS.coverAspect`) | render option |
| Baked front-cover title (SETTLED) + REQUIRED TEXT | `buildCoverPrompt` title block / `requiredText.coverRequiredTexts` |
| Cover layout: title-safe top third, initial-page bottom band, back-cover bottom band (`cover-composition.txt`) | render-side template section — or into the beat (Q4) |
| App-stamped dedication / back text / brand line | `coverTypography.js` |
| Cover model routing (`coverImage`, `coverTitleBakedModel`) | render option |
| Cover judge notes (gaze, flat title, text regime) | `cover-evaluation-notes.txt` (kept, sibling set `cover-generator-vs-critic`) |
| Storage container + versions | `coverImages` + `story_images` cover keys (Q5) |
| Composite covers (>5 figures) | `coverComposite.js` — keep, re-point, or delete (Q6) |

### 2.4 Code DELETED (not demoted)
Prompts
- `scene-expansion-all.txt`: the whole "## Cover scene hints" rules block, the `---COVER SCENE HINTS---` output
  format (incl. today's `Scene:` line, `{COVER_CAST}`, `{COVER_ELEMENT_CAP}`, the title-creature rule).
Parse / storage
- `outlineParser/unified.js extractCoverHints` (incl. the `scene` field and the backdrop enforcement — the rule
  moves into the beat), `progressive.js` coverHints emission, the `stories.data.coverHints` write.
- `clothingCategories.reconcileCoverClothingWithRequirements` + the cover-hint clothing lookup;
  `entityConsistency` cover clothing from hints (pages already read the brief's clothing).
coverIterate.js (2,339 lines; most of it goes)
- `buildCoverSceneFromHint`, `coverBriefWithObjects`, `withTrialCoverObjects`, `collectCoverHintElementIds`,
  `enrichCoverHintWithArtifacts`, `matchVbEntitiesInText` / `reconcileCoverSceneEntities` /
  `stripEntityNameFromDescription` / `entityNameRegex` (the cover NAME invariant — pages have none; their prose
  is AD-written), `applyCoverWornHeldDedupe` (pages use declared `wornItems`; sibling set
  `worn-vs-held-resolvers` shrinks to one member), `validateCoverHintCast`, `narrowCoverCastToMains`,
  `filterBackCoverToMainCharacters`, `buildInitialPageComposition` (→ beat or layout, Q4), `stripCharacterSentences`,
  `buildPlateDescription`, `trialCoverLocationId`, `trialCoverPlateDescription`, `buildCoverReferences` (→ page
  references), the cover-cast selection in `iterateCover`, and `iterateCover` itself if Q7 lands on "page
  iterate" — `warnTitleNamedEntitiesMissingFromCover` is re-pointed at the front cover brief's `objects[]`.
- `promptBuilders.buildCoverCastLines`, the `COVER_CAST` / `COVER_ELEMENT_CAP` fills.
storyJobPipeline.js
- `startCoverGeneration` body (cast pick, clothing, scene text, name invariant, reference build) and the
  trial `onCoverScene` body — replaced by calls into the page render path.
Tests
- Every unit test pinning the above (cover-objects-any-element, cover-name-invariant, cover-key-elements-secondary,
  cover-title-named-cast-warning (re-pointed), cover worn/held tests, trial cover plate tests, …).

Kept: `coverKeys.js`, `COVER_PAGE_NUMBERS`, the covers' final-object-state rule (`resolveObjectState` rule 0,
684f51d93 — still keyed on the cover page numbers), `vehicleDescription`, the shrink must-keep tail, `coverTypography`,
`cover-composition.txt` (per Q4), `cover-evaluation-notes.txt`, `buildCoverPrompt` reduced to "page prompt + cover
render options".

### 2.5 Today's commits — revert first, or replace?
**Replace, as part of this change; do not revert first.** Reverting 8dfdb2b0d would resurrect KEY STORY ELEMENTS
and full-path covers with no REQUIRED OBJECTS (no D-16b, no bbox labels) on staging, only to delete them again.
Every piece 8dfdb2b0d added that this plan removes (`Scene` line, `hint.scene`, `coverBriefWithObjects`,
`withTrialCoverObjects`) is on the §2.4 delete list; the pieces it and the earlier commits added that stay are
independent of the cover-hint design (final-state rule 684f51d93, shrink must-keep b794b9731, `vehicleDescription`
30f2c6913, the page element budget as the cover cap). Staging keeps running the 09-23 design until this lands;
`tasks/verify.json` entry `cover-briefed-like-a-page` becomes `superseded` in the same change.

---

## 3. What goes into a cover beat, and where it comes from

A beat is a plan line: `shot — who is in frame — the instant — what is true after`. A cover beat carries the facts
code owns today as prompt rules, as DATA on that one line (plus, where needed, one short "cover facts" suffix the
beat formatter adds — the same way `{PLAN_LINE_CAST}` facts ride a page).

| Beat field | Title Page (−1) | Initial Page (−2) | Back Cover (−3) | Source (already in code) |
|---|---|---|---|---|
| shot | wide | wide | wide | constant |
| who is in frame | the main characters | up to 5 incl. the mains | up to 5 incl. the mains | `buildCoverCastLines` rules over `inputData.characters` / `mainCharacters` (Q6) |
| clothing | costumed if any character has a costumed variant | same | same | clothing contract (step 3, done before the AD) |
| setting | a real-landmark LOC from the bible; each cover a different LOC | same | same | the AD's own bible (it authors LOCs in the same call); the rule text moves from the cover section into the beat |
| the instant / purpose | "the book's title picture: the cast at their story's key place" | "an inviting opening picture of the cast" | "a relaxed after-the-story picture" | constants (from `cover-composition.txt` bullets) |
| elements | any ART/ANI/VEH the picture calls for, up to the page budget (4); a creature the story centres on is in the Title Page | same | same | `VB_ELEMENT_BUDGET`; the title itself is NOT known at step 4 (title is picked at step 6) — the warn-only check stays as the title-side guard |
| gaze | every figure looks at the viewer (Q2) | same | same | SETTLED line |
| layout | top third open for the title | bottom 20% calm | bottom 10% calm | `cover-composition.txt` (Q4) |
| mood | — (the AD writes it from the arc, as on pages) | | | — |
| what is true after | — | | | — |

---

## 4. Trial
The trial has no Art Director: the writer authors pages AND their scene hints in one call, and trial pages render
the hint directly. The cover JSON is the same shape, so the trial cover becomes **trial page −1**: parsed with the
pages, rendered by the trial page render function with cover render options, evaluated and repaired as a page.
`story-trial.txt`'s COVER SCENE block stays as the writer's instruction for that page (its cast rule — main
character plus VB animals/artifacts — is the trial's cover beat). Deleted: `onCoverScene`'s bespoke build, the
derived trial `coverHints`, `trialCoverLocationId`, `trialCoverPlateDescription`, `withTrialCoverObjects`.
Latency: the cover is written first, so it can still start first (it only waits for the VB and avatars, as now).

---

## 5. Stored stories (constraint — owner decides, no fallback proposed)
Every story generated before this change has `coverHints` and a code-built cover description, and NO Art Director
cover brief. After the change there is no code that can turn a hint into a brief. What a cover iterate /
regenerate / repair does on such a story is the owner's call — options in Q1.

---

## 6. Reversals, sibling paths, judges

**SETTLED.md**
- "Cover gaze is code-owned: always at the viewer; `gazes at:` is banned from cover hints" — the hint and the code
  owner both disappear. Reversal (full protocol) unless the rule is restated as beat data + a check (Q2).
- "Four Visual Bible elements per page — locations are not elements" — now applies to covers too (extension, not
  reversal).
- "Cover title text: model-baked everywhere" — unaffected (render side).

**decisions.md superseded** — 2026-05-10 structured-only cover hints; 2026-07-11 cover gaze code-owned (if Q2 ≠ c);
2026-08-26 "ONE builder for covers and pages" (fulfilled further, not reversed); 2026-09-06 point 6 (already
superseded); 2026-09-11 "cover KEY STORY ELEMENTS includes secondaries"; 2026-09-23 C4 "covers follow the AD cast,
validateCoverHintCast drops phantoms" (the check moves to the page cast checks); all four 2026-09-23 cover entries
from this session (title-named creature, any-element, Scene line/REQUIRED OBJECTS, KEY STORY ELEMENTS deletion).

**Sibling registry**
- `cover-and-plate-reference-builders` → collapses (covers use the page reference builder); delete or re-point to
  the page render sites.
- `pipeline-page-record-vs-cover-record` → goal met if covers are recorded by the page record code; otherwise keep.
- `worn-vs-held-resolvers` → one member left; delete the set.
- `detector-identity-lines` → drop `coverIterate.buildExpectedCoverCharacters` (covers use the page builder).
- `cover-cast-builders` → depends on Q6 (composite).
- `art-director-templates` (scene-expansion.txt ↔ scene-expansion-all.txt): the per-page fallback template must
  accept a cover beat too.
- `art-director-vs-iterate` (scene-iteration*.txt): covers now iterate through them (Q7).
- `vb-authoring-sites` (scene-expansion-all ↔ story-trial): the cover-section rules leave the AD template; the
  trial template keeps its COVER SCENE block — record why the two differ.
- `cover-generator-vs-critic`: generator side becomes `cover-composition.txt` + the cover beat; critics unchanged
  (`cover-evaluation-notes.txt`, image-semantic, consolidator, requiredText).

**Judges (generator ↔ critic).** A cover brief is judged exactly like a page brief: the semantic judge scores the
render against the AD's brief (no longer a code-built one), D-16b / bbox read REQUIRED OBJECTS from the sent prompt.
To re-check with the `syncing-generator-and-critic` skill:
- `cover-evaluation-notes.txt` "do not deduct for facing the viewer" must match what the beat asks (Q2);
- the scene review's checks (check 5 cast-in-beat vs brief, plate rules, landmark view, text zone) must accept a
  cover beat — e.g. a text-zone / copy-space check against a cover layout (Q4);
- the plan counters (`planCounters.js`) must not count cover beats as story pages (arc coverage, shot variety,
  page count).

---

## 7. Validation plan and size

| Rung | What | Cost |
|---|---|---|
| 1 | Replay: the real AD prompt builder with cover beats over 3 stored staging full stories (no unfilled placeholder, beats well-formed); unit tests for the beat formatter, the parser (cover headers → −1/−2/−3), and the page-path cover render over stored briefs | free |
| 2a | Test Lab `beats_scenes` (stored beats + the three cover beats, no review) on the 4-page staging story `job_1788555701112_99txp8evx`: the AD returns full briefs for −1/−2/−3 that parse as pages | ≈ $0.25 (Lab 1453 was $0.205 for 4 pages; +3 short pages) |
| 2b | Same with the scene review on (if Q3 = include) | ≈ +$0.10-0.30 |
| 2c | Render the three returned cover briefs through the page render path (Lab `image` stage or a cover stage re-pointed) | ≈ $0.12-0.30 (3 × grok-imagine 2.0 / baked-title model) |
| 3 | 4-page smoke story on `demo-b-hnecf@magicalstory.ch` (covers generated, evaluated, repaired end to end) + one trial on the smoke account | ≈ CHF 1-2 + ≈ CHF 0.7 — needs owner OK |

Size (rough): 20-25 files. Deletes ≈ 1,500-2,500 lines (most of `coverIterate.js`, the pipeline cover blocks, the
AD cover section, hint parsing, cover-hint consumers, their tests); adds ≈ 500-800 (cover beat formatter, parser
headers, page-path cover options, storage mapping, tests). ≈ 2-4 agent-days including the Lab rungs. One change,
staging only, with `tasks/verify.json` entries for rung 3.

---

## 8. Open questions (owner decisions)

**Q1 — Stored stories without an AD cover brief, on iterate / regenerate / repair.**
- (a) One paid Art Director call for that cover, on demand, from a cover beat built from the stored story (≈$0.03-0.08 per cover; slower regenerate).
- (b) Refuse: cover iterate / regenerate on a pre-change story fails loudly with a clear message.
- (c) One-time backfill: run the AD cover call for every stored story (paid batch; count and price first).
- (d) Iterate re-sends the cover's own stored SENT prompt (the record of what was drawn), no re-brief — note this keeps a second, non-page cover path alive for old stories.

**Q2 — Cover gaze (SETTLED "code-owned: always at the viewer").**
- (a) Beat data: the cover beat says "every figure looks at the viewer"; the AD writes `looksAt: viewer`; a mechanical brief check flags any other gaze (restates the SETTLED line; no reversal of the outcome).
- (b) Keep it code-owned: the builder forces viewer gaze on cover page numbers regardless of the brief (code overriding the AD — against "no code telling the AD").
- (c) Drop the rule: the AD stages each cover's gaze like a page (full SETTLED reversal protocol + evidence).

**Q3 — Scene review and plan checks over the cover briefs.**
- (a) Include the three covers in the one scene-review call (cost/time +10-20%; covers finally get reviewed).
- (b) Mechanical brief checks only (sceneBriefCheck/clothingCheck), no LLM review for covers.
- (c) Neither (covers ship as the AD wrote them).

**Q4 — Cover layout (title top third, initial-page bottom band, back-cover bottom band).**
- (a) Stay render-side in `cover-composition.txt` as now.
- (b) Move into the cover beat, so the AD stages the copy space like a page's `textPosition` (the judge's text-zone check then applies).
- (c) Both: beat states it, render keeps a short guard.

**Q5 — Storage.**
- (a) Keep `coverImages.{frontCover,initialPage,backCover}` + cover keys in `story_images` (client, PDF, print, share viewer unchanged); the page path writes there for cover page numbers.
- (b) Store covers as `sceneImages` entries −1/−2/−3 and migrate every reader (client, PDF, Gelato, share, Lab).

**Q6 — Cover cast and the composite path.**
- (a) Code puts the cast into the beat (today's rules: Title = mains, others ≤5 incl. mains); the AD stages exactly that cast. Composite covers (>5 figures) become impossible → delete `coverComposite.js` + `compositeCastBuilder` cover side.
- (b) As (a) but keep the composite path for >5-figure covers, fed from the brief.
- (c) The beat lists the available cast and the AD chooses who appears (like a page's plan line naming who is in frame).

**Q7 — Cover repair / iterate.**
- (a) Covers repair exactly like pages (iteratePage, char-fix, inpaint); `iterateCover` is deleted.
- (b) Keep `iterateCover` as a thin wrapper that calls the page iterate with cover render options (one path, cover options only).

**Q8 — Trial cover.**
- (a) Trial cover = trial page −1 through the trial page render path (proposed §4).
- (b) Keep a separate trial cover builder (not recommended: it is the 3-path duplication this change removes).

---

## 9. Owner answers (2026-09-24) — the plan is executed with these

| Q | Answer |
|---|---|
| Q1 | **(b) refuse loudly** — cover iterate / regenerate / repair on a pre-change story (no Art Director cover brief) fails with a clear message. |
| Q2 | **(a)** the beat says every figure looks at the viewer; the AD writes it; a mechanical brief check flags any other gaze. SETTLED outcome unchanged. |
| Q3 | **(a)** the three covers go into the one scene-review call. |
| Q4 | **(b)** the layout (title top third, bottom bands) lives in the beat; the AD stages the copy space like a page's `textPosition`; the judge's text-zone check applies; the render-side layout text that becomes redundant is deleted. |
| Q5 | **(a)** keep `coverImages` + the cover keys in `story_images`; the page path writes there for cover page numbers. |
| Q6 | **(b)** code puts the cast into the beat (today's rules); the AD stages exactly that cast; the composite path stays for >5-figure covers, fed from the brief. |
| Q7 | **(a), AMENDED by the owner (2026-09-24):** full-story covers repair, iterate and regenerate through the page path only; `iterateCover` is KEPT as the trial-only cover iterate, next to the trial-only cover builder (front via `onCoverScene`, back via the default hint). The split is explicit: `iterateCover` and the trial builder are called only for trial stories and throw for a full-story cover; the trial path is its own sibling set. |
| Q8 | **CHANGED — keep the trial cover separate.** The change is FULL-STORY ONLY. The trial cover builder stays (speed: target ≈1 min, rendered first from the writer's streamed cover JSON); only what is genuinely dead once the full-path code is gone leaves the trial path. Separately: measure the trial cover's time-to-image (§10). |

Execution rules: CLAUDE.md (sibling registry, generator-critic sync, SETTLED/decisions entries for every §6
reversal); tests in the same commits; today's commits REPLACED, not reverted; validate on rungs 1 and 2 only
(cap CHF 1.00, burn-loop rule); STOP before rung 3 and ask.

## 10. Trial cover latency (measured 2026-09-24)

**The stored data cannot measure the trial cover's time-to-image.**
- `stories.data.generationLog` of a trial has no cover event at all (prod `job_1790169018278_n57xpnufo`: 32 events
  — `stage_start`, `page_streamed`, VB cell gates, `generation_complete`, `api_usage`, `timing_summary`; nothing for
  the cover). The only cover lines are Railway `log.info` lines (`[TRIAL-COVER] Starting title page generation`,
  `Title page image ready in Xs`), which are not stored and not reachable from this machine (no Railway CLI login).
- `coverImages.frontCover.generatedAt` is stamped at the FINAL assembly, not when the cover is ready, and the
  `story_images` cover row is written at the final save too: both equal the end of the job (cover row and first
  page row are within 1 s of each other on every one of 15 staging and 9 prod trials).
- The `partial_cover` checkpoint (written the moment the cover is ready) is deleted with the job's checkpoints.

What the stored data does say (job start → job complete, recent trials):
| env | trials | job total |
|---|---|---|
| prod (09-11 … 09-24) | 9 | 137-199 s |
| staging (09-08 … 09-15) | 15 | 110-181 s |
On `job_1790169018278_n57xpnufo` the writer streamed page 1 at 52 s, so the cover JSON (written before the pages)
and the VB were in by ~50 s; the cover then also waits for avatar styling, then renders (~15-30 s per Grok call).

**Plate-or-fail (8c1a6b4b3, 2026-09-23) — code reading, not measurement.** Since that commit the trial cover:
1. waits for the page plate of its LOC when a trial page shares it (`await pagePlate.promise`,
   storyJobPipeline ~l.2513) — the plate render is started when the backgrounds section streams, so the wait is
   whatever of that plate's ~10-20 s is still outstanding when the cover is otherwise ready;
2. otherwise renders its OWN plate first (`buildCoverReferences` → one extra `generateImageOnly`, sequential,
   ~10-20 s), then the cover.
Either way the cover now has a plate render on its critical path that it did not have before. **No trial has run on
staging since 8c1a6b4b3, and it is not on prod**, so the added latency has never been observed.

**To actually measure it** (options, not done — the trial latency path is not to be changed without asking):
- (a) add one genLog event `trial_cover_ready` with ms since job start and the waits (VB, avatars, plate, render) —
  no behaviour change — then one staging trial (rung 3, needs approval, ≈CHF 0.7);
- (b) read the `[TRIAL-COVER]` Railway lines for recent prod trials with an owner Railway login.

**If it breaks ≈1 min** (options for the owner): (a) start the cover's plate the moment the cover JSON arrives, in
parallel with avatar styling, instead of after; (b) reuse the page plate only if it is already done, else render the
cover plate in parallel; (c) render the cover plate at the cover aspect from the cover JSON setting at VB time.

## 11. Execution record (2026-09-24)

Commit `6fbd2b599` (staging) — decisions.md "Full-story covers are pages".

- [x] Cover beats in code (`coverBeats.js`), appended after the story beats; AD template's cover section deleted.
- [x] Covers briefed in the one AD call and reviewed in the one scene review (Q3); checks `cover_gaze_not_viewer`,
      `cover_text_zone_mismatch` (Q2, Q4); negative page headings parsed everywhere the briefs flow.
- [x] Render through the page path with `coverRenderOptions` only; `{COVER_COMPOSITION}` empty for full-story covers
      (Q4); storage unchanged, record marked `briefedAsPage` (Q5).
- [x] Repair pipeline: covers iterate via `iteratePage`, char-fix allowed; `iterateCover` branch removed there (Q7).
- [x] Routes (`/iterate/-N`, `/regenerate/cover`, manual character repair) and the Lab cover stage route by
      `coverIteratePath`; pre-change covers refused with 409 (Q1).
- [x] Trial split explicit (Q7 amendment, Q8); dead trial pieces removed (initialPage composition, Scene line).
- [x] Consumers: clothing, entity collection, EXPECTED CAST, pose fill line.
- [x] Tests (`covers-as-pages.test.ts` + updated cover tests), sibling registry (3 new sets, 2 updated), verify entry
      `covers-are-pages` (supersedes `cover-briefed-like-a-page`), SETTLED gaze line, prompt inventory.
- [x] Rung 1 — free replay of the real cover-beat + AD builders over 4 stored staging stories.
- [ ] Rung 2 — Lab `beats_scenes` with cover beats + render of the three returned briefs (see below).
- [ ] Rung 3 — needs owner approval (smoke story / trial).

Deviations from the plan, and why:
- The regenerate route's cast picker on a full-story cover maps to a free iterate with a rule naming exactly the picked
  cast (the page path has no cast-override render); the edited scene becomes the brief the rewrite starts from.
- The composite cover path (Q6 (b)) is kept in code but is unreachable for a full story: the beat caps the cast at 5
  and the page path has no composite route for covers.
- The pixel calm-zone repair stays page-only: on a cover it would wash the baked title.

Found, not fixed (trial path — the owner asked for no trial change without asking): the trial's
`parser.extractCoverHints()` returns a truthy EMPTY hint for every cover (the trial writer emits no COVER SCENE HINTS
section), so the trial start block's "default hint" branches never run and the back cover renders from an empty hint:
every one of the last 3 staging and 3 prod trials stored `coverHints.backCover.hint = ""` and a back-cover description
starting "A portrait of a single character set before <place>" — never the intended "calm closing back-cover scene".
