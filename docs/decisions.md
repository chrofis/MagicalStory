# Architectural Decisions

The "why does the code do this?" log. Read this **before** diagnosing a
warning, before changing behaviour you don't fully understand, and before
asking the user to explain a deliberate mode-specific shortcut.

Per `CLAUDE.md`: every architectural decision is logged here. Format:

```
## Title (one sentence verdict)
**Context:**   what problem / constraint led here
**Decision:**  what we actually do
**Rationale:** why we picked this over the alternative
**Touched:**   files that implement the decision
**Status:**    ✅ active | 🟡 conditional | 🗄 superseded (with link)
```

Append new entries at the bottom of the matching section. Don't rewrite
history — if a decision is reversed, add a new entry marking the old one
superseded and link forward.

---

## Story generation

### Trial stories skip draft → analysis → revise
**Context:** Trial stories run on the `/try` flow for anonymous users, no
credits charged. They must feel instant — long generation kills conversion.
**Decision:** Trial generation uses `prompts/story-trial.txt` (172 lines, no
`---STORY DRAFT---` and no `---ANALYSIS---` sections — single-pass writing
straight into `---STORY PAGES---`). Full-account generation uses
`prompts/story-unified.txt` (951 lines, the full draft → self-critique →
patch loop).
**Rationale:** Cuts generation time roughly in half and saves ~5–10k output
tokens per story. Quality is lower than the full unified prompt (no
self-critique pass) but acceptable for the trial-conversion goal: the user
gets one taste, then claims their account to unlock the full pipeline.
**Touched:**
- `prompts/story-trial.txt` (trial prompt — no draft/analysis sections)
- `prompts/story-unified.txt` (full prompt — all sections)
- `server.js:2835` — picks prompt based on `inputData.trialMode`
- `server/lib/storyHelpers.js:5343` — `buildTrialStoryPrompt()` builder
- `server/routes/trial.js:2175` — sets `trialMode: true` on the job
- `server/lib/outlineParser/shared.js:343` — `extractDraftPagesFromText`
  accepts `{ isTrial }` and skips scanning + warning for trial responses
**Status:** ✅ active.

### Trial stories skip the quality-eval + repair pipeline
**Context:** Quality eval costs another Gemini call per page, plus the
auto-repair loop can re-generate pages and add several minutes to wall
time. Trial users won't wait.
**Decision:** Trial jobs set `skipQualityEval: true` (see
`server/routes/trial.js:2243`). `server.js:6060` short-circuits the entire
evaluation + repair pipeline when this flag is set.
**Rationale:** Same as draft skip — speed and cost. Trial output is "good
enough to demonstrate the product"; full users pay for the polish.
**Touched:**
- `server/routes/trial.js:2243` — sets the flag
- `server.js:5970, 6060, 6367` — short-circuits eval + repair
- `server/lib/styledAvatars.js`, `server/lib/character2x4Sheet.js` —
  per-call `skipQualityEval` override flows through the avatar pipeline too
**Status:** ✅ active.

### Phantom character recovery
**Context:** Sonnet sometimes references a character in scene prose or
`clothingRequirements` without declaring them in the Visual Bible. Without
recovery the downstream image-gen has no appearance description and
renders the character generically (or omits them).
**Decision:** After parsing, scan all page metadata for character names
not in the VB. For each phantom, call Sonnet with a small follow-up prompt
asking for the appearance description, append the result to the VB as a
new `CHRxxx` entry.
**Rationale:** ~$0.004 per phantom call (Sonnet 4.6) vs the alternative
of asking the main prompt to be perfect. Cheap insurance.
**Caveat:** ~~The phantom is added to the Visual Bible (so prompts pick her
up), but the reference-sheet generator may skip generating a dedicated
reference image for single-page side characters~~ — RESOLVED, see "Every named
secondary character gets its own reference image (Pt 8)" below: named
secondaries now qualify for a reference on a single page in full mode.
**Touched:**
- `server/lib/phantomCharacters.js` — detection + Sonnet patch call
- `server.js` (unified pipeline, after parsing) — invokes the recovery
**Status:** ✅ active.

---

### Every secondary character gets its own reference image, even in a single scene (2026-07-26)
**Context:** Two disjoint character pools exist: **primaries**
(`inputData.characters` — get avatars + face/body reference photos) and
**secondaries** (`visualBible.secondaryCharacters` — get an image ONLY if a VB
reference is generated). Reference generation was gated by `minAppearances`
(default 2), so a secondary appearing on a single page never got a reference.
With no reference, the secondary contributed zero image slots; `packReferences`
then sent Grok/Gemini only the **primary's** face as the sole human reference,
and the model — anchored to its input images — painted the secondary borrowing
the primary's face. The secondary's identity survived only as prose, which loses
to the image reference. Owner rule: "They should be in the visual bible. We had
if they appear in more than 2 scenes. We just need to change that even in a
single scene." The cost of generating secondary references IS accepted.
**Decision:** Lower the appearance gate for **characters only** to 1 page while
locations / artifacts / animals / vehicles keep the 2-page recurring-element gate
(a one-page prop/place doesn't justify a reference-gen call).
`getElementsNeedingReferenceImages(visualBible, minAppearances=2,
characterMinAppearances=1)` takes a per-type gate. **No name/identity filter** —
any entry the story placed in `secondaryCharacters` gets its own face. Once a
secondary has a reference, the existing per-page path
(`getElementReferenceImagesForPage` → `buildVisualBibleGrid` → `visualBibleGrid`
→ `packReferences`) already carries its own face to both providers — no
provider-branch change needed. Applies **the same in trial mode** (its
`maxElements: 6` cap still bounds total refs).
**Correction (same day):** an earlier version of this fix added an
`isNamedIndividualCharacter` guard + `GENERIC_CROWD_TERMS` blocklist that skipped
article-prefixed names ("a guard", "the innkeeper") and plural collectives, and
kept trial at gate 2. That was over-engineered and wrong for the common case:
"a guard" / "the innkeeper" are single individuals, and excluding them left them
inheriting the primary's face — the exact bug. Removed the guard entirely: every
`secondaryCharacters` entry qualifies. (True crowds are a story-text data-quality
issue that belongs in the scene `background` field, not a reference-gen blocklist;
giving a group entry its own reference is not a regression toward the primary-face
bug — it just gets its own face — and matches the pre-existing behaviour that
generated references for whatever the story put in the pool at ≥2 pages.)
**Cost/latency:** one extra reference-gen call per newly-qualifying single-page
secondary (batched up to 4 per grid). A story with K such secondaries adds ⌈K/4⌉
grid generations. Logged at `[REF-SHEET] 🧑 N secondary CHARACTER reference(s)…`.
**Touched:**
- `server/lib/visualBible.js` — `getElementsNeedingReferenceImages()` per-type gate (character=1, others=2); removed the name guard + crowd blocklist + export
- `server/lib/images.js` — `generateReferenceSheet` accepts `characterMinAppearances`, threads it, logs secondary-character ref count
- `server.js` — full-mode AND trial call both pass `characterMinAppearances: 1`
- `tests/manual/test-pt8-secondary-references.js` — unit test
**Status:** ✅ active.

### Beats-first pipeline is opt-in (`pipelineMode: 'beats'`) and ships without VB / clothing / cover hints
**Context:** Production makes ONE Sonnet `unified_story` call (outline + visual
bible + clothing + cover hints + text + scene hints) followed by ONE DeepSeek
`outline_review`. The beats-first restructure splits that into five staged
calls so each stage is reviewable and only faulted pages get rewritten:
beats → beats review → per-page scene expansion → one review over all scene
briefs → page text. Step 6 (`text_refine`) already existed and is unchanged.
**Decision:** `server/lib/beatsPipeline.js` → `generateStoryViaBeats()`, gated
behind `inputData.pipelineMode === 'beats'` (admin-only, stripped for
non-admins exactly like `maxRepairPasses`) with a `PIPELINE_MODE` env default;
`inputData` wins over env, anything unrecognised falls back to `unified`. When
on, `processUnifiedStoryJob` skips BOTH the unified writer call and the
`outline_review` call, and Phase 3 consumes the already-expanded scene briefs
instead of running `startSceneExpansion`. Everything downstream (images,
repair, `text_refine`, covers) runs unchanged.
**Deliberate omissions in beats mode** — no beats-stage prompt produces them:
- **Visual Bible** — empty `{}`. No secondary-character/location/artifact ids,
  no VB grid references, no landmark photo fetch, no reference sheets.
- **clothingRequirements** — `null`. Per-page clothing comes only from what the
  scene brief's METADATA declares; avatar styling falls back to the late path.
- **coverHints** — `null`. Only the front cover gets its built-in default hint;
  initial page and back cover have none.
- **Scene-consistency pre-check** (`checkSceneConsistency`) — skipped; it reads
  the unified outline's SCENE DESIGN blocks, which a beats transcript has not
  got. The scene review is the equivalent gate.
`data.outline` stores a beats transcript (title, beats, both review analyses,
final page text) instead of the raw writer response.
**Rationale:** Gating on a flag keeps the default path byte-identical, so the
restructure can be measured on staging against real runs without risking a
paid story. Building VB/clothing/cover generation into the beats path is a
separate piece of work; shipping the five stages first makes the gap visible
and measurable rather than hidden behind a half-built sixth stage. Model
choice mirrors the Test Lab `beats_scenes` stage: generation =
`MODEL_DEFAULTS.outline`, reviews = `MODEL_DEFAULTS.outlineReviewModel`.
**Touched:**
- `server/lib/beatsPipeline.js` — the five stages, usage labels `beats_plan`,
  `beats_review`, `beats_scene_expansion`, `beats_scene_review`,
  `beats_story_text`; `resolvePipelineMode()`
- `prompts/story-text-from-beats.txt` + `storyHelpers.buildStoryTextFromBeatsPrompt`
- `server/lib/storyHelpers.js` — `buildDoNotWriteSection()` extracted so the
  refiner and the beats writer ban the same categories
- `server.js` — `beatsMode` branch at the writer call, outline-review gate,
  title/storyPages/expandedScenes sources, non-admin `pipelineMode` strip
**Status:** 🟡 conditional — staging experiment only; not a production default
until the VB / clothing / cover gap is closed.

---

## Email

### Cover hero in transactional emails — R2 URLs only, never base64
**Context:** Story emails (story-complete, trial-story-complete,
order-confirmation, order-shipped) want to show the front cover as a hero
or thumbnail. Covers exist either as a public R2 URL (`image_url`) or as
inline base64 in the DB (`image_data`).
**Decision:** `email.js`'s `getCoverPublicUrl(storyId)` returns the R2
`image_url` if present, otherwise `null`. Base64 covers are **never**
inlined. Templates wrap the hero in `{?coverUrl}…{/coverUrl}` so a null
cleanly strips the block.
**Rationale:** A typical cover is 200 KB+ as base64. Gmail clips emails
over 102 KB, hiding the unsubscribe link and downstream content. A missing
hero is better than a clipped email.
**Touched:**
- `email.js` — `getCoverPublicUrl()` helper, called by send functions
- `emails-src/components/Cover.tsx` — renders the image when URL present
- `emails-src/components/Cond.tsx` + `email.js` `fillTemplate` —
  `{?key}...{/key}` conditional block support
**Status:** ✅ active.

### Trial reminder emails do not attach the PDF
**Context:** The original trial-story-complete email already attached the
PDF. Reminders go to users who haven't claimed yet, days later.
**Decision:** `server/lib/trialReminders.js` deliberately skips
`pdfBuffer` when calling `sendTrialReminderEmail`.
**Rationale:** The user already has the PDF from the first email — sending
it again wastes bandwidth and storage on their end, and re-triggers Gmail
attachment scanning that occasionally bumps deliverability scores.
**Touched:**
- `server/lib/trialReminders.js:14, 65` — explicit no-PDF comments
**Status:** ✅ active.

### Reply address is `info@magicalstory.ch`, not `support@`
**Context:** Older email copy used `support@magicalstory.ch`. The actual
Resend `replyTo` configuration in `email.js` is `info@magicalstory.ch`.
**Decision:** Every user-facing email surface uses `info@magicalstory.ch`.
`support@` was retired.
**Rationale:** Only one mailbox is actually monitored. Surfacing an
unmonitored alias as the contact point burns user trust on the rare reply.
**Touched:**
- `email.js` line 14 — `EMAIL_REPLY_TO`
- `emails-src/components/Footer.tsx` — `SUPPORT_EMAIL` constant
- `emails-src/i18n.ts` — `orderFailed.questions` copy in all 4 languages
**Status:** ✅ active.

---

## Image generation

### Scene-plate slot 0 is magenta-extended, never gray-pillarboxed (2026-06-16)
**Context:** A portrait landmark photo (e.g. Baden Altstadt 533×800) used as
the slot-0 scene anchor for a square (1:1) story got pillarboxed to square by
`packReferences` using SAMPLED edge colours — grey on a stone-lane photo. Those
flat-grey bars baked into the empty-scene plate and survived the Grok edit into
the final page (showcase `job_1781557946649` p8+p9, ~17% bars each side). The
earlier magenta-extension fix (`02abce7d`) lived inside `editWithGrok`, but the
page/empty-scene path runs `packReferences` FIRST, which pre-squares slot 0
before `editWithGrok` sees it — so the magenta step was a no-op there. It only
ever worked for covers (which call `editWithGrok` directly).
**Decision:** `padInputWithExtension` is threaded through `packReferences`. When
slot 0 is a scene plate whose aspect differs from target, `packReferences`
leaves it at native aspect and `editWithGrok` magenta-pads + extends it (paints
real scene continuation into the gap). Later slots keep their pad/letterbox
behaviour. Both `generateImageOnly` Grok branches (imageBackend-routed AND
modelConfig-routed) pass the flag to `packReferences` as well as `editWithGrok`.
**Rationale:** Extension preserves the full landmark (no crop, no loss of
the tower/sky) AND produces full-bleed output. Cropping was rejected because it
loses landmark detail; gray pillarbox is the bug itself. Verified end-to-end on
the p8 landmark: before = 17%/17% bars, after = 1%/1% full-bleed.
**Touched:**
- `server/lib/grok.js` — `packReferences` accepts `padInputWithExtension`, skips
  slot-0 pad when set; `editWithGrok` magenta logic unchanged
- `server/lib/images.js` — both Grok branches in `generateImageOnly` pass the flag
**Status:** ✅ active.

### One shared provider-dispatch core: `_dispatchImageGeneration` (2026-07-29)
**Context:** The two image-gen entry functions `callGeminiAPIForImage` (eval
path, 17 positional params) and `generateImageOnly` (gen-only, options object)
each re-implemented the SAME Grok→Gemini→Runware dispatch ladder — primary
Runware, primary Grok, Gemini parts-building, model-routed Runware, model-routed
Grok, Gemini fallback — in parallel. Improvements to reference packing, aspect
resolution, prompt truncation, or the Grok pad-extension flag only ever landed
in one path (owner: "we only improve one path").
**Decision:** Extract a single private core
`_dispatchImageGeneration(prompt, characterPhotos, opts)` that owns the WHOLE
provider-selection ladder up to (and including) building the Gemini `parts`
array, model-id resolution, prompt truncation, aspect, reference packing (both
Grok branches, both Runware branches), and the `onImageReady` callback. It does
NO quality eval and NO caching. It returns a provider-tagged RAW result
(`{ provider, imageData, modelId, usage, packedRefs, promptSent }`) for the
Runware/Grok branches, or a Gemini-fallback sentinel
(`{ provider: 'gemini', parts, modelId, effectivePrompt }`) when no upstream
provider produced an image. Each entry function is now a thin wrapper: it keeps
its own cache namespace + lookup/store, its own per-branch result shaping, and —
for the Gemini fallback — its own terminal Gemini fetch (the two Gemini
generators are genuinely different: `generateImageOnly` runs a 3-level safety
sanitization retry loop and no usage recording; `callGeminiAPIForImage` is a
single-shot fallback with `recordImageApiUsage` and rich refusal-error
extraction). Every divergence between the two ladders is a documented `opts`
field each wrapper supplies its own value for, so behavior is byte-preserved:
`verbose` (log detail + per-photo hash logging + model-name in truncate warning),
`usePadExtension` (gen-only pads scene-plate slot 0; eval path does not),
`avatarMode` (eval path avatar-slices refs in model-routed Grok),
`grokPrimaryModel`/`grokPrimaryModelKey` (gen-only forces STANDARD; eval path
honors the pro override), `includeSceneBackgroundPart` (gen-only adds a
`[Background]` Gemini part), `defaultModel` (eval path is cover-aware),
`pageLabel`, `outputAspect`, `textAreaMask`, `evaluationType` (Grok log only).
**Rationale:** Collapses ~500 lines of duplicated dispatch into one core; a
Grok/Runware/packing/aspect improvement now reaches both entry points. The
terminal Gemini fetch and the per-branch RESULT SHAPING stay in the wrappers
because they are genuinely function-specific (eval vs no-eval), not duplication —
forcing them into the core would need ~10 more flags and two co-located Gemini
execution modes, net-negative for simplicity. Byte-faithful extraction only: no
behavior change, no provider-call change. Verified with a stubbed-provider unit
test (`tests/manual/test-images-dispatch-core.js`) asserting each branch calls
the same provider fn with the same key args as the pre-refactor inline ladder.
**Touched:**
- `server/lib/images.js` — new `_dispatchImageGeneration`; `callGeminiAPIForImage`
  and `generateImageOnly` rewritten as thin wrappers (signatures, cache
  namespaces, return shapes unchanged)
- `docs/image-generation-methods.html` — both entries flagged as sharing the core
- `tests/manual/test-images-dispatch-core.js` — faithfulness unit test
**Status:** ✅ active.

### Covers = images; `composite` is a shared-path OPTION, not a cover-only fork (2026-07-29)
**Context:** Owner directive: "Covers should now be identical to all other
images — we add the text separately app-side. The only thing is they have the
COMPOSITE option (figures composited onto a background = simpler image)…
composite should just be an OPTION that is ON for covers and OFF for images.
Everything must be implemented this way between cover and normal images. They
can have different DEFAULTS but the CODE should be the same." Previously
`iterateCover` FORKED: `if (compositeOn && landmarkBuf) → generateCoverViaComposite`
(a cover-only path that returned its own result shape) `else → generateImageWithQualityRetry`.
Pages and direct covers already shared `generateImageWithQualityRetry`; only the
composite branch lived outside it.
**Decision:** `composite` is now a first-class option on the shared
`generateImageWithQualityRetry` path (default **false**). A new private router
`_maybeGenerateComposite(options, usageTracker, pageLabel)` runs at the top of
the function: when `options.composite === true` AND `options.compositeInputs.landmarkBuf`
is present, it calls `generateCoverViaComposite` (the composite internals are
UNCHANGED — it's still the implementation, just called through the option) and
returns an imageResult-shaped object marked `composite:true`, `score:null`
(composite skips eval, as before). It returns `null` — meaning "run the normal
direct generate+eval path" — when composite is off (the default; every page),
when the landmark prerequisite is missing (invented-location fallback), or when
the composite generator throws. `iterateCover` STOPS calling
`generateCoverViaComposite` directly: it computes `compositeOn` with the exact
same gate (figure-count `>5` default, explicit `options.compositeCovers` true/false
override) and passes `composite: compositeOn` + `compositeInputs` (artifact-enriched
hint + resolved landmark bytes — cover-domain producer prep stays in coverIterate)
into the SINGLE shared call. Its two-branch generation fork collapses into that
one call. After it, `iterateCover` still branches on `imageResult.composite` to
skip the app-side restamp for composite covers (their title is baked in by the
composite passes) — that is a return-assembly difference, not a second generator
call, and it preserves today's behaviour exactly.
**Rationale:** The owner's "covers = images, composite as an option" principle,
made literal — one code path, gated on the OPTION VALUE (never on
`evaluationType==='cover'`, so a page COULD opt in), with different defaults
(covers on for >5 figures, pages off). Composite-default-on-for-covers is right
because covers are STATIC group portraits — no action, every figure faces
forward — which is exactly what compositing pre-rendered figure cutouts onto a
background plate handles well; page scenes have action/interaction/depth that
the direct render captures better, so they stay direct. This is a REFACTOR, not
a redesign: the composite result, the direct result, eval, versioning, the
`restampCover` restamp, and the no-landmark → direct fallback all behave
byte-identically — only WHERE the composite-vs-direct decision is made moved
(into the shared function as an option). The PAGE PATH is provably untouched:
with no `composite` option, `_maybeGenerateComposite` returns null on its first
line and the direct generate+eval loop runs exactly as before.
**Rejected:** hardcoding composite to `evaluationType==='cover'` inside the
shared function (violates "same code, page could opt in"); moving the full
cover-return assembly (referencePhotos, previousImage, previousScore) into the
shared function (those are cover-domain values not available there — keeps the
shared fn generic).
**Touched:**
- `server/lib/images.js` — new `_maybeGenerateComposite` router + early-return
  in `generateImageWithQualityRetry`; exported for testing
- `server/lib/coverIterate.js` — fork removed; computes `compositeOn`, builds
  `compositeInputs`, one shared call, `imageResult.composite` return branch
- `server/lib/coverComposite.js` — UNCHANGED (composite internals preserved)
- `docs/image-routing.md`, `docs/image-generation-methods.html` — composite
  documented as a shared-path option
- `tests/manual/test-composite-option-dispatch.js` — dispatch faithfulness test
**Status:** ✅ active.

### Text-overlay font size never shrinks
**Context:** Page text gets overlaid on the rendered illustration. Longer
paragraphs are tempting to shrink so they always fit a fixed box.
**Decision:** `server/lib/textOverlayRenderer.js:116` — the renderer never
auto-shrinks the font. If the text doesn't fit, the calmness-detection
pass either expands the safe area or the upstream scene-expansion is asked
to keep the chosen corner calmer.
**Rationale:** Visual consistency across the printed book matters more
than fitting any one paragraph. A book where every page has the same text
size feels typeset; a book where page 7 has tiny text feels like a
glitch.
**Touched:**
- `server/lib/textOverlayRenderer.js:116`
- `server/lib/textRegion.js` — calmness map + safe-area expansion
- `server/lib/storyHelpers.js` `buildImagePrompt()` — COPY SPACE
  instruction the model uses to keep the chosen corner light
**Status:** ✅ active.

### Scene composite pipeline killed — every page goes direct
**Context:** Two scene-composite variants were built between 2026-05-08
and 2026-05-16: (1) the **uniform composite** (populated plate with ALL
cast as colored silhouettes → bbox detect → depopulate → paste 2×4 cell
cutouts → blend; ~3 Grok calls flat, +N per phantom-pose render), and
(2) the **stratified composite** (cast depth-split: back stratum rendered
natively in the anchor plate, front stratum as silhouettes → front-figure
plate → diff-crop → composite onto depopulated back plate → blend; flat 4
Grok calls; N=1 short-circuits to anchor plate only). Initial stratified
commit `23fcf070` 2026-05-16 16:04; killed `8557b0ac` 2026-05-16 23:28
(~7.5 hours and ~28 fix-commits later). Same-day saga.
**Decision:** Hard-disable the composite branch at `server.js:5668` —
`const compositeEnabled = false;` regardless of what `decidePageRoute()`
returns. `routeDecision` metadata still populates so the dev panel reports
which method WOULD have been picked; only the gate flips. Every page
takes the direct Grok-edit path (`generateImageWithQualityRetry`).
`server/lib/sceneComposite.js`, `server/lib/compositeCastBuilder.js`,
`server/lib/phantomPoseRender.js` remain in the tree but are unreachable.
**Rationale:** Composite pages produced score-0 outputs on staging
`job_1778925296736_c9ia8qrio` pages 3 + 4. The auto-repair iterate path
salvaged every failed composite by re-running it as direct, so every
composite call was pure cost. Failure modes that never stabilised:
- **Style drift across 3–4 sequential Grok edits.** Each edit shifted
  brushwork, palette, or detail level; the final blend pass couldn't
  reconcile back to the anchor's style.
- **Silhouette detection failures.** Desaturated reds drifted past the
  RGB-distance threshold (commits `d359fabe`, `1a66a0b6`); translucent
  silhouettes required tolerance tuning (`f3096b00`); label bars from
  identity packs leaked into the mask (`5061bdd3`); split silhouette
  fragments needed merge logic (`fb1e6ca8`).
- **Depopulate drift.** Grok edit on the populated plate to "remove the
  silhouettes" frequently moved a building, swapped a VB prop, or
  repainted the floor (`ead1ed8b` ended up dropping the step entirely
  in favor of a direct RGB mask, defeating the architectural purpose).
- **Identity pack leakage.** Grok kept copying labels and reference cells
  from the identity packs into the output (`6f84dbca`, `a08aff78`,
  `11094490`) — same VB-grid-label problem we hit again on covers in
  2026-06-04 (commit `27e375ba`).
- **Aspect / cropping bugs.** Grok edit's input-aspect coercion clipped
  silhouettes off the edges (`3f38b295`, `144041df`, `9e9ce7bc`) — same
  root cause as the cover blur problem solved in 2026-06-04 with
  magenta-pad-extend.
The cover variant (`server/lib/coverComposite.js`) is unaffected and is
still on by default (`MODEL_DEFAULTS.compositeCovers: true`) — covers
have a different shape (3–5 figures in a single group portrait, landmark
backdrop, pre-styled costumed avatars), and 2026-06-04's single-pass
single-edit refactor (commit `b8e72eb9`) stabilised it.
**Before re-enabling scene composite, fix:**
1. Style-drift across sequential edits (probably means collapsing to a
   single edit, like the cover did in `b8e72eb9`).
2. Identity-pack label leakage (apply the `composeCharWithVbRow` no-label
   fix from `27e375ba` to whatever reference packing the composite path
   uses).
3. Grok input-aspect coercion (apply the magenta-pad-extend trick from
   the cover work).
4. End-to-end validation: pick 3 staging stories with cast ≥ 4 and prove
   the composite pages score ≥ direct on quality eval (semantic + visual).
   Without that gate, re-enabling is the same trap.
**Touched:**
- `server.js:5658-5668` — the kill-switch + the comment block explaining
  why it's hardcoded
- `server/lib/sceneComposite.js` — uniform composite (still in tree,
  unreachable)
- `server/lib/compositeCastBuilder.js` — cast builder (still in tree,
  unreachable)
- `server/lib/phantomPoseRender.js` — per-figure pose render (still in
  tree, unreachable)
- `server/config/models.js:enableSceneComposite` /
  `compositeStrategy` / `phantomPoseRender` — flags still defined but
  the kill-switch bypasses them
- `docs/image-generation-methods.html` — Why-not table entry; the
  scene-composite row in the methods table marked killed
- `memory/project_scene_composite_killed.md` — short verdict + don't
  re-suggest without addressing the 4 fixes above
**Status:** 🗄 superseded by direct path. Re-enable only after the four
fixes above land + the validation gate passes.

### Cover & scene composite unified at the test-models dispatcher
**Context:** Two parallel composite pipelines exist — `coverComposite.js`
for covers (sharp-composite figures + 1–2 Grok edits) and `sceneComposite.js`
for scene pages (uniform: populated plate → depopulate → cutout → blend;
stratified: back native + front silhouettes → depopulate front →
front-figure plate → composite → blend). The dev-panel TestModelsPanel
showed Method 1/2/3 toggles for both surfaces but for cover pages
(`pageNumber < 0`) the backend at `regeneration.js:1249` silently ignored
the strategy and ran cover composite regardless. The UI lied to the user.
The split was historical (different code authors, different times), not
principled — covers ARE just scenes with a fixed group-portrait layout and
title/dedication/branding text.
**Decision:** Make `generateSceneComposite` cover-capable by adding
`scene.textOverlay = { type, text, artStyle }` plumbing through
`buildBlendEditPrompt`. Add `buildCoverCompositeCast()` adapter in
`compositeCastBuilder.js` — synthesises a scene-shaped pageData from
`coverHint.characterDetails` + `coverHint.characters`, then delegates to
the existing `buildCompositeCast` for avatar resolution and lazy 2×4 sheet
generation (no duplication). Test-models cover branch dispatches by
`compositeStrategy`: when `'uniform'` or `'stratified'`, route through
the new path; anything else preserves the legacy `iterateCover` call.
**Rationale:** Truthful UI > parallel parallel pipelines. The user picked
Method 2/3 — they should get scene composite for covers, not be silently
re-routed to the legacy cover path. Auto-pipeline routing is unchanged
(covers still default to `generateCoverViaComposite` single-pass);
Method 2/3 for covers is manual-only via test-models, same gate scene
pages already use. Scene composite's documented failure modes (style
drift, label leakage, depopulate drift) will likely show up on covers
via Method 2/3 — that's a known limitation, not a blocker, since manual
testing is exactly where you want to discover that.
**Touched:**
- `server/lib/compositeCastBuilder.js` — new `buildCoverCompositeCast`
  adapter (~120 lines, delegates to existing `buildCompositeCast`)
- `server/lib/sceneComposite.js` — `scene.textOverlay` plumbing through
  `buildBlendEditPrompt`; new `buildTextOverlayDirective` helper
- `server/routes/regeneration.js:1249` — dispatcher branch on
  `compositeStrategy` for `pageNumber < 0`
- `docs/image-generation-methods.html` — methods table updated to note
  the new cover-via-scene-composite path
- `memory/project_scene_composite_killed.md` — note that covers can
  reach scene composite via test-models
**Production-path behaviour after this change:**
- V1 covers (streaming initial gen): unchanged — direct path
- V2+ covers (auto-repair iterate): unchanged — cover composite
  single-pass
- Manual cover regen via repair-panel "Iterate Cover": unchanged
- Test-models on covers with NO composite toggle: unchanged
- Test-models on covers with Method 2 / Method 3 toggle: NEW — runs
  scene composite adapted for the cover, with text rendered in the
  blend step
**Status:** ✅ active.

### Evaluators never judge direction of travel from a mid-motion pose
**Context:** A page whose beat was "character leaps from a vehicle onto
a surface" rendered correctly (push-off foot still touching the
vehicle), but the blind vision inventory *guessed* the leap direction
from the frozen pose ("jumping from the ledge toward the boat") and the
text-only compliance scorer treated that guess as fact → `wrong_action`
CRITICAL on a correct image → unnecessary repair. The repair came back
genuinely inverted, and the scorer then stretched the left/right-mirror
leniency to a *surface swap* (foot on vehicle vs foot on rock),
downgrading it to MAJOR → the wrong image passed and won pick-best over
the correct original (job_1781289599516 p7).
**Decision:** Two rules added to all three eval prompts
(`image-vision-inventory.txt`, `image-prompt-compliance.txt`,
`image-evaluation.txt`): (1) a still frame cannot show direction of
travel — describers report only which surfaces/objects each limb
touches, scorers never flag `wrong_action` from inferred motion
direction; (2) mirror equivalence covers body sides and frame halves
only — a limb contacting a *different object* than declared is a real
contradiction, not a mirror.
**Rationale:** Direction-of-motion in a static image is a guess stacked
on a guess (vision infers, compliance scores the inference). The same
ambiguous pose got CRITICAL when correct and MAJOR when wrong — the
asymmetry, not the ambiguity, is what broke the page. Judging only
visible contacts makes both versions score consistently.
**Touched:** `prompts/image-vision-inventory.txt`,
`prompts/image-prompt-compliance.txt`, `prompts/image-evaluation.txt`.
**Status:** ✅ active.

### Scene-hint `background` is forwarded verbatim into the image prompt
**Context:** The unified outline correctly placed story-essential
antagonists in the scene hint's `background` field ("faint soldier
faces inside the retreating boat" — per the ANTAGONISTS rule in
`story-unified.txt`), but the field never reached the image generator:
`extractSceneMetadata()` dropped it, and the prose — the only channel
into `buildImagePrompt` — omitted the soldiers. The evaluator, which
scores against the hint, flagged the empty boat but only as MODERATE,
so nothing forced a fix. Result: an escape scene with no one to escape
from (job_1781289599516 p7).
**Decision:** (1) `extractSceneMetadata()` exposes `background`
(top-level + `fullData`); (2) `buildImagePrompt()` appends a
`**BACKGROUND:**` line with the hint's background text to the scene
description — even when the prose already covers it (short, harmless
redundancy beats a silent drop); (3) both evaluators score
prompt-placed supporting figures (role + location given) as MAJOR
`missing_element` when entirely absent — ambient decoration ("a few
passersby") stays no-deduction.
**Rationale:** Generator and evaluator must see the same contract. The
prose weaving background in is the happy path, not a guarantee — a
deterministic append closes the gap for every story instead of relying
on the prose writer never dropping a clause.
**Touched:** `server/lib/storyHelpers.js` (`extractSceneMetadata`,
`buildImagePrompt`); `prompts/image-evaluation.txt`;
`prompts/image-prompt-compliance.txt`.
**Status:** ✅ active.

### Antagonists: outline declares them in prose + objects[]; builder keeps the CHR filter
**Context:** Follow-up to the background-forwarding fix. The Visual
Bible had a secondary-character entry for the antagonists (CHR002,
`pages` including the failing page), but the scene hint never
referenced it — soldiers lived only in background prose, and the
2026-06-09 builder change silently skips CHR ids in `objects[]` on the
assumption the prose always carries secondaries.
**Decision (user-chosen scope: outline rule only, no builder safety
net):** `story-unified.txt` now requires story-present antagonists to
be (1) named in the SCENE prose with count + placement + VB signature
look, (2) listed by CHR id in `objects[]` (presence metadata — the
builder still filters CHR ids out of REQUIRED OBJECTS to avoid
duplicating the prose), (3) summarised in `background`. A builder-side
re-inject fallback (when prose drops a declared CHR) was offered and
declined — revisit if antagonist drops recur despite the new rules.
**Touched:** `prompts/story-unified.txt` (SCENE prose rules +
ANTAGONISTS + OBJECTS); `server/lib/storyHelpers.js` (comment on the
CHR filter).
**Status:** ✅ active.

### Scale-repair is verified before promotion; unscored originals get a rescue eval
**Context:** Page 9 of job_1781289599516: the unconditional scale-repair
("shrink the background character") edit DELETED Gessler instead of
shrinking him; the edit was promoted blindly; the pre-repair original is
stored with score:null (eval only runs on the promoted image) and
selectBestVersion skips null scores — so the original (the best image of
the run) was mathematically locked out and the Gessler-less version
shipped at score 30 after three repair rounds made everything worse.
Compounding factor: Gessler is a VB secondary (CHR001), not a user
character, so bgDescriptions came up empty — the repair prompt said
"move Gessler" to a model that has no idea who Gessler is.
**Decision:**
1. `verifyScaleRepair()` (scaleRepair.js) — one gemini-2.5-flash call on
   the edited image checks each background character by VISUAL SIGNATURE
   (clothing/colours/mount, never by name — a silhouette passes for a
   name, not for "crimson cloak + white-feathered hat"). Any "not
   present" → repair discarded, original stays active. Fails OPEN on API
   errors (a verification hiccup must not discard a probably-fine edit).
2. Step 3b rescue eval (images.js) — when a page's best version scores
   < 60 and an unscored original exists, evaluate it with the standard
   eval and re-pick. Healthy pages never pay the extra eval.
3. bgDescriptions in server.js fall back to Visual Bible
   secondaryCharacters for background characters that aren't user
   characters — both the repair prompt and the verification gate need
   the signature description.
4. `sanitizeIssueForInpaint()` (images.js) — entity-consistency grid
   vocabulary ("cells A, D, E, F", "reference (R)", "costume costume")
   is stripped from issue text before it lands in inpaint prompts; the
   inpaint model never sees the comparison grid.
**Verified:** gate replayed on the stored p9 images (flags v1 missing
Gessler, passes v0); rescue re-pick flips best from scale-repair(30) to
original; sanitizer tested on the exact leaked strings.
**Touched:** `server/lib/scaleRepair.js`, `server/lib/images.js`,
`server.js`.
**Status:** ✅ active.

---

## Cross-cuts already documented elsewhere

These are referenced from `CLAUDE.md` and aren't duplicated here, but
listed for discoverability:

- **Unified mode is primary** — all new features target unified, not legacy
  `pictureBook` / `outlineAndText`. See CLAUDE.md → "Important Rules".
- **Action button styling identical across rows** — copy sibling
  className verbatim. See CLAUDE.md → "Important Rules".
- **Repair workflow scoring formula** — `qualityScore − semanticPenalties
  − entityPenalties`, threshold 60, max 3 passes. See CLAUDE.md → "Repair
  Workflow".
- **Centralized aspect ratios** — `MODEL_DEFAULTS` in
  `server/config/models.js`. See CLAUDE.md → "Centralized Aspect Ratio".
- **Prompts must stay generic** — no story-specific names/plotlines in
  `prompts/*.txt`. See CLAUDE.md → "Important Rules".
- **Memory check before recommending vendors** — see CLAUDE.md and the
  `memory/project_image_model_tests.md` log.

---

## Marketing & Google Ads

### Conversion goal: demote PAGE_VIEW, add "Trial story completed", uncap PMax
**Context:** PMax campaigns were optimizing toward whatever fired most — and
that turned out to be the "Page view" conversion (counting_type MANY,
value CHF 1, primary). Conversion count ≈ click count → algorithm chased
clicks, not value. CHF 0.50 Target CPA on top of that throttled
campaigns toward zero because real conversions cost ~CHF 1.38–2.58.
**Decision:**
1. **Demote PAGE_VIEW** at the customer_conversion_goal level
   (`biddable: false`). It still counts for analytics; just no longer
   feeds the bidder. Done via `customerConversionGoals.update()` —
   the per-conversion-action `primary_for_goal` field is read-only for
   GA4-sourced conversions (origin=2).
2. **Create "Trial story completed"** — a real high-value signal.
   Category SIGNUP, value CHF 10, counting ONE_PER_CLICK, type WEBPAGE.
   Conversion action id 7629103661. Fire is **not yet wired** —
   needs gtag event from the trial-completion screen in the React app.
3. **Remove CHF 0.50 Target CPA** from PMax-Baden/Winterthur/Aarau.
   Daily budget cap (CHF 3/day) is the real spending control at this
   volume. Target CPA needs ~30+ conversions/campaign/month to be
   useful; we have 7/3/2.
**Rationale:** At ~12 conversions/month total, Google's ML bidding
flies blind. Better to keep the algorithm unconstrained but optimizing
for a higher-quality signal (real story completion, not landing page
view).
**Re-evaluate trigger:** once we hit 30+ "Trial story completed"
conversions/campaign/month, switch to Maximize Conversion Value with
per-action values: Trial=CHF 10, Account claim=CHF 30, Book purchase
=CHF 60. Until then, no Target CPA.
**Touched:**
- Google Ads conversions + bidding (no code changes for the Ads side)
- ⚠️ Still TODO in code: fire `gtag('event', 'conversion', {send_to: 'AW-17995593741/<LABEL>'})`
  from the trial-completion screen (TrialGenerationPage / story-ready
  state). LABEL is visible in the Ads UI under Tools → Conversions →
  Trial story completed → Tag setup. Without this the conversion
  action exists but never fires.
**Supersedes:** the earlier "PMax campaigns capped at CHF 0.50 Target CPA"
entry below — that cap is now removed.
**Status:** ✅ active (set 2026-05-30).

### landmark_index broad coverage: all 1,439 Swiss cities (2026-06-01)
**Context:** The Wikipedia-geosearch indexer covered ~22 Swiss cities;
swiss-cities.json catalogues 100; Google Ads' geo-target catalog has
**1,439** Swiss CITY + MUNICIPALITY entries. Goal: every Swiss city
that exists in any of these catalogs should have at least one usable
overview photo in `landmark_index`, so future creative-gen and city-
landing-page features can refer to any city without "no photo
available" gaps.
**Decision:** Built `scripts/admin/broad-city-overviews.js`:
1. Pulls all CH-CITY + CH-MUNICIPALITY entries from Google Ads
   `geo_target_constant`.
2. For each, looks up the city's own Wikipedia page in its primary
   language (DE / FR / IT by canton).
3. Saves the lead `pageimages.original` photo as an entry named
   `<City> (Stadt|ville|città)` with `photo_type='distant'`, country
   = 'Switzerland'.
4. Zero Gemini Vision calls — overviews are definitionally `distant`,
   so the classification is hardcoded. **$0 cost.**
**Result:** Every Swiss city has a baseline aerial/overview photo
useable as a reference image for ad creative generation, city landing
pages, and story prompts.
**Trade-off:** Quality varies — some lead images are coats of arms or
maps rather than aerial shots (limitation of Wikipedia's pageimages).
Acceptable as a baseline; can be improved per-city later.
**Touched:**
- `scripts/admin/broad-city-overviews.js` — idempotent re-runnable
**Status:** ✅ active (run 2026-06-01).

### Photo-type classification: metadata-first, Read-tool second (2026-06-01)
**Context:** `photo_type` (distant/close/interior/view_from/bad) was
unset on 93% of landmark rows. The existing `classify-landmark-photos.js`
uses Gemini Vision (~$0.001/photo × 1,700 photos = ~$1.70). User
preference: avoid the dollar cost; use Claude's Read tool tokens
instead (which are budgeted differently).
**Decision:** Two-tier classifier `scripts/admin/classify-via-read.js`:
1. **Tier 1 — metadata heuristic (free, instant).** For each photo
   slot, fetch Wikimedia Commons extmetadata (ImageDescription,
   DateTimeOriginal, Categories). Regex-match against multi-language
   keyword sets:
     - `bad` (engraving, lithograph, painting, map, coat-of-arms,
       portrait, statue-detail) — auto-discarded
     - `distant` (aerial, panorama, Schrägluftbild, drone, skyline)
     - `interior` (Innenraum, Nave, Chor, Kreuzgang, crypt, altar)
     - `view_from` (Blick von, Aussicht von, vue depuis)
   Confidently classified rows are written immediately. Empirical
   filter rate: ~70-80% per sample.
2. **Tier 2 — Read tool for survivors.** Photos that don't match any
   pattern emit to `ambiguous-photos.json`. A separate pass downloads
   each image, opens it via Read, and writes a decision back to the
   JSON. `--tier2-apply` then writes decisions to DB.
**Result:** ~70-80% of photo_type classifications free at Tier 1; only
~150-300 photos (estimate) need eyes via Read at Tier 2. Zero Gemini
Vision spend.
**Touched:**
- `scripts/admin/classify-via-read.js` — both tiers in one file
**Status:** 🟡 in-progress (tier-1 tested on Baden, full run pending
broad-coverage completion).

### landmark_index iconic-fill + canonical-name rename (2026-06-01)
**Context:** The existing Wikipedia-geosearch indexer
(`server/lib/landmarkPhotos.js` → `indexLandmarksForCities`) systematically
missed or mis-named famous Swiss landmarks. Concretely:
- **Geosearch radius + score filters** dropped some icons that should
  have been the first hit (Grossmünster, Zytglogge, Spalentor, Jet d'eau,
  Käfigturm — none were in the index at all).
- **Cross-language storage** stored iconic landmarks under their non-local
  Wikipedia title (e.g. Berner Münster as "Collégiale Saint-Vincent de
  Berne", Bundeshaus as "Palais fédéral", Cathédrale de Lausanne as
  "Kathedrale Notre-Dame (Lausanne)"). The creative-generation script
  does ILIKE '%<name>%' lookups, so the canonical local name failed to
  match.
**Decision:** Built `scripts/admin/add-iconic-landmarks.js` — a targeted
fetcher that:
1. Looks up each iconic landmark by exact Wikipedia title in the
   appropriate language (DE for Zürich/Bern/Basel, FR for Genève/
   Lausanne) — bypasses geosearch entirely.
2. UPSERTs by either name OR wikidata_qid — catches existing rows under
   different local names.
3. **Renames non-canonical existing rows to the local-language form**
   (e.g. "Palais fédéral" → "Bundeshaus (Bern)"). Keeps the photo and
   wikidata_qid intact.
4. Patches missing nearest_city values.
**Result:** 6 new landmarks inserted, 11 renamed, 13 already-canonical
left alone. Every iconic landmark now findable by its canonical local
name across Zürich, Bern, Basel, Genève, Lausanne. Total Swiss landmark
coverage above tier-1 iconic threshold for these 5 cities.
**Touched:**
- `scripts/admin/add-iconic-landmarks.js` — re-runnable fetcher/renamer
- `landmark_index` table (production DB) — direct writes
**Re-evaluate trigger:** If we extend to more cities (Luzern, Lugano,
St. Gallen, Biel, etc.), add their iconic-list to the same script and
re-push. The script is idempotent.
**Status:** ✅ active.

### PMax tight cost control: Target CPA CHF 0.50 + budget CHF 1.50/day
**Context:** After uncapping PMax earlier today (removed Target CPA),
Baden paid CHF 4.09 for a single click. User confirmed they want
predictable low spend over volume — willing to accept near-zero
serving in exchange for a hard cost ceiling.
**Decision:** Apply both constraints to PMax-Baden/Winterthur/Aarau:
  - `target_cpa_micros = 500000` (CHF 0.50)
  - `budget.amount_micros = 1500000` (CHF 1.50/day)
**Expected outcome:** Campaigns serve very little or not at all
(current actual CPA is CHF 1.38–2.58, so asking for 0.50 means most
auctions won't be entered). Total daily spend ceiling ≈ CHF 4.50/day
across the three; actual likely far lower. Essentially 'paused with
optionality' — keeps the campaigns alive for when we relax constraints
again.
**Re-evaluate trigger:** If we want any volume, either raise target_cpa
(e.g. CHF 1.50–2.00) or remove it. User accepts the trade-off; in-house
priority is the trial-funnel landing pages, not paid acquisition volume.
**Supersedes:** today's earlier 'uncap PMax' decision (the conversion-
goal restructuring from that entry — PAGE_VIEW demoted, 'Trial story
completed' created — stays active).
**Status:** ✅ active (set 2026-05-31).

### 🗄 PMax campaigns capped at CHF 0.50 Target CPA (SUPERSEDED 2026-05-30)
> Superseded by "Conversion goal: demote PAGE_VIEW, add Trial story completed, uncap PMax" above. The CHF 0.50 Target CPA was throttling campaigns to near-zero impressions because actual CPA on real conversions was 2.8–5× higher. Kept here for history. (Note: re-applied 2026-05-31 with a tightened budget — see top of section.)
>
**Context:** Three PMax campaigns (Baden, Winterthur, Aarau) were running
on `MAXIMIZE_CONVERSIONS` with no per-conversion ceiling, paying actual
costs of CHF 1.38 / 2.00 / 2.58 per conversion. Roger wanted a hard cost
ceiling. PMax doesn't support per-click bid caps (Google product
limitation — only Search supports `cpc_bid_ceiling`).
**Decision:** Set `maximize_conversions.target_cpa_micros = 500000` on
all three PMax campaigns (= CHF 0.50 max per conversion). Search-Zurich
keeps its per-click cap of CHF 0.50.
**Rationale:** Explicit budget discipline matters more than maximum
volume at the current spend level (~CHF 12/day total). User accepts
that the algorithm will throttle clicks/impressions sharply to hit the
target — current CPA is 2.8–5× higher than the new target, so volume
will drop.
**Re-evaluate trigger:** if total conversions drop more than ~70%
after 2 weeks with no recovery, either raise the target (e.g. CHF 1.00)
or revert to uncapped MaxConversions.
**Touched:**
- Google Ads campaigns (no code changes) — set via inline node script
  using the google-ads-api SDK. Same script form could become
  `scripts/ads/set-target-cpa.js` if we change it again.
**Status:** ✅ active (set 2026-05-29).

### Sitelinks: 5 account-level + 1 per-city = 6 per campaign
**Context:** Google Ads recommends ≥6 sitelinks per campaign so ads can
serve in the top-of-page formats (higher CTR). MagicalStory had zero
sitelinks attached before 2026-05-29.
**Decision:** 5 generic sitelinks attached at the **customer (account)**
level via `CustomerAsset` → apply to every campaign. One additional
per-city sitelink attached at the **campaign** level via `CampaignAsset`
→ "Geschichten in {City}" pointing at `/stadt/{cityId}`.
**Rationale:** Account-level handles the bulk efficiently (5× CustomerAsset
records vs N campaigns × 5 = duplicated work). The per-city addition
delivers one locally-relevant link on each city campaign — better local
relevance than purely generic copy.
**The 5 account-level sitelinks** (all DE):
- "Zur Startseite" → `/`
- "Gratis testen" → `/try`
- "Geschenkideen" → `/geschenk`
- "Über 44 Themen entdecken" → `/themes`
- "Preise & Pakete" → `/pricing`
**Per-city:** "Geschichten in {City}" → `/stadt/{cityId}` for Aarau, Baden,
Winterthur, Zürich (matched to PMax-{City}-v1 / Search-Zurich-v1
campaigns; Zürich uses both 'Zurich' and 'Zürich' name patterns since
the campaign label is ASCII while the display label keeps the umlaut).
**Idempotency caveat:** Re-running `--push` creates new Asset records
each time. Run once. Future iterations on copy need a dedup pass that
lists existing `CustomerAsset` SITELINK rows and skips matching names.
**Touched:**
- `scripts/ads/create-sitelinks.js` — creates the assets + attaches them
**Status:** ✅ active (pushed 2026-05-29).

---

## Backlog (decisions noticed but not yet expanded)

These deserve an entry once someone has bandwidth — they're real design
choices buried in code or settings, not yet written up here:

- Trial cover generation moved from streaming `onTitle` to `onCoverScene`
  (richer structured data — see `server.js:3843`).
- `unified.js` `extractTitle` falls back to "legacy single-line" parsing
  when the structured `---TITLE---` block is absent — under what
  conditions does Sonnet emit the legacy form?
- Cascade face detection (Python anime detector + Haar) merge order and
  precedence rules in `server/lib/entityConsistency.js`.
- Why Grok is the avatar-face provider (switched from Gemini after
  `IMAGE_OTHER` refusals on adult-face photos — already noted in
  CLAUDE.md, expand here with the model-comparison data).

---

## Trial flow

### Trial skips the 2×4 standard sheet — uses preview avatar as standard
**Context:** Generating both standard and costumed 2×4 sheets adds ~30-40s
to the trial wait. The trial character is in `costumed` for nearly every
page of a 5-page story; the standard look only matters for the rare
non-costumed scene. The preview avatar (9:16 full-body watercolor portrait,
generated cheaply during the wizard) is good enough for that.
**Decision:** Trial `prepare-title` only adds the costumed entry to
`avatarRequirements`. Before calling `prepareStyledAvatars`, the standard
cache key is seeded with the preview avatar via `_seedStandardFromPreview()`.
Page rendering's `applyStyledAvatars` finds it there for standard-clothing
pages and never triggers a separate 2×4 standard generation. If no costume
is configured (unusual), we still fall back to generating the standard sheet.
**Rationale:** ~30-40s saved per trial — major UX win on a flow already
too slow. Quality loss is bounded: standard scenes are rare in trial, and
the preview avatar shows the same character in the same watercolor style.
**Touched:** `server/routes/trial.js` (`prepare-title` handler — `avatarRequirements`
and `_seedStandardFromPreview` call); `server/lib/styledAvatars.js`
(`_seedStandardFromPreview` helper, exported).
**Status:** ✅ active

### Trial DOES generate empty scenes (re-enabled after brief disable)
**Context:** Empty-scene generation for trial was disabled in commit
`05d4c221` to save ~25s on the 5-page wait. User feedback: the scene
quality wins outweigh the latency — page renders look noticeably better
when each one inherits a pre-rendered scene plate as background slot.
**Decision:** Trial re-enables empty-scene generation for all 5 pages
(server.js trial-mode `onVisualBible` block). Each empty scene is a ~5s
Grok call; total ~25s extra in the wait — accepted.
**Rationale:** Scene-anchored renders (`packReferences` uses the empty
scene as Slot 1) are visibly more consistent across pages than text-only
renders. The latency cost is recoverable elsewhere (skipping the 2×4
standard sheet saves ~30s, net positive).
**Touched:** `server.js` trial-mode `onVisualBible` block (~3942).
**Status:** ✅ active. KNOWN ISSUE: empty-scene rendering deviates too
much from the passed landmark photo — needs prompt review (tracked as
task #34).

### Trial uses age-tier phantom (child as fallback for unknown age)
**Context:** Phantom silhouette controls head-to-body ratio of the
generated 2×4 character. A generic adult-proportioned phantom leaks adult
proportions into kid characters. Age tiers (toddler / child / teen / adult)
shipped earlier. The trial form does NOT require age — `canProceed` only
checks name + gender + photo. When users skipped age, the chain was
`age='' → tier null → loadPhantom() falls back to phantom-watercolor.png
(adult-ish)`. Result: kid renders looked adult-ish.
**Decision:** `phantomTierForAge('')` returns `'child'` (not `null`). Any
unknown / unparseable age renders against `phantom-watercolor-child.png`.
**Rationale:** Product is overwhelmingly for kids. Adult-proportioned
default phantom is the wrong fallback; child is the right one. Users who
make an adult character must explicitly enter age 18+ to get the adult
phantom (acceptable friction for the rare case).
**Touched:** `server/lib/character2x4Sheet.js` (`phantomTierForAge`).
**Status:** ✅ active.

### Phantom face replaced with RGB axis-gizmo overlay
**Context:** The 2×4 character sheet generation uses a phantom (mannequin
in 4 angles × 2 rows of head/body) as a pose template. The phantom is
generated with "two small dots for eyes, a small line for a mouth"
(see `scripts/generate-phantom-age-tiers.js:89`) so Grok knows where the
face goes per cell. Problem: Grok **copies whatever it sees** on the
phantom's head into the rendered character. The eye-dots and
mouth-line leak into every render — the character's face structure ends
up reading as "phantom-face-with-skin-tone" instead of "the kid in the
source photo". Tried smooth/featureless heads, but Grok then renders
smooth/featureless faces ("the avatar gets a smooth oval face"). Tried
composite-source-face onto phantom, but that defeats the purpose since
the 2×4 IS the source for downstream composites. Tension: phantom MUST
have a face for orientation cue, but ANY face leaks.

**Decision:** Overlay a 3-axis RGB gizmo (red X, green Y, blue Z) on the
face region of each cell. The gizmo communicates orientation through
its OWN rotation per cell (front=0°, quarter=45°, profile=90°,
back-3/4=135°) but is unmistakably non-anatomical — Grok reads it as
"directional marker, not a face" so no face features leak into the
render. The phantom body (proportions, pose) is preserved untouched.

  Cell layout per angle:
  | Angle | Red (X) | Green (Y) | Blue (Z) |
  |---|---|---|---|
  | 0° front | → right | ↑ up | • dot (toward viewer) |
  | 45° quarter | ↗ up-right | ↑ up | ↘ down-right |
  | 90° profile | • faded dot (perpendicular) | ↑ up | → right |
  | 135° back-3/4 | ↖ up-left | ↑ up | ↗ up-right |

**Rationale:** Keeps the body+pose value the phantom provides without
the feature-leak cost. The gizmo "leak" is benign because the gizmo
doesn't resemble human anatomy — Grok renders the character from the
source face photo, gives the head the orientation indicated by the
gizmo, and discards the gizmo geometry. Build-time transformation
(scripts/generate-phantom-axes.js) keeps the original assets untouched
on disk for easy rollback.

**Touched:**
- `scripts/generate-phantom-axes.js` — generator that overlays gizmos
  onto each existing phantom PNG, outputs `*-axes.png` variants
- `server/assets/phantom-watercolor-{toddler,child,teen,adult,*}-axes.png`
- `server/lib/character2x4Sheet.js` — `loadPhantom()` reads the
  `-axes` variants

**Status:** ✅ active. Cross-character validation (Noah + Emma, all 4
  age tiers) showed clean faces with correct per-cell orientation and
  no gizmo geometry leaking into the renders.

### One trial story per user — no environment exceptions, no merges, no email reclaim
**Context:** During testing, multiple convenience features were added on
staging: cap bypass (let same trial user generate multiple stories),
email reclaim (free up the same email between trial runs), and merge into
existing real account (let an admin claim multiple trial runs into their
own account). The user rejected all of these.
**Decision:** Hard rule across all environments: `stories_generated < 1`
in `/api/trial/create-job`; no staging email reclaim in `/link-email` or
`/link-google`; no merge-into-existing-account path; no `_merge*` helper.
To re-test the trial flow, create a fresh trial account with a fresh
email each time.
**Rationale:** Product policy: trial is the user's one free shot at the
experience and the entire claim/conversion funnel is calibrated around
scarcity. Any "convenience" workaround distorts conversion numbers,
abuse-resistance tests, and the deferred-email helper's idempotency
guard — all assume one trial = one user.
**Touched:** `server/routes/trial.js` (`/create-job`, `/check-status`,
`/link-email`, `/link-google`); CLAUDE.md (rule).
**Status:** ✅ active.

### JSONB R2 sweep — every inline base64 leaves stories.data
**Context:** A 14-page repair-heavy Berger smoke (`job_1780141948847_xzk2o00ua`)
hit Postgres' 256 MB JSONB cap (`total size of jsonb object elements exceeds
the maximum of 268435455 bytes`). `extractInlineImagesToR2` had explicit
walkers for known image-bearing fields, but every new field added to the
data model was one more chance for base64 to leak. Profiling a 5-page 1-char
trial showed 11 MB of leaks across 74 fields the explicit walkers missed
(notably `styledAvatarGeneration[*].passes.pass{1,2}.imageData`,
`sceneImages[*].sceneCharacters[*].bodyNoBgUrl`,
`visualBible.locations[*].photoVariants[*].cachedPhotoData`,
`...sentToGrok.referenceImages[*].dataUri`). Multiply by 14 pages × 5 chars
× 4 repair passes → past the 256 MB cap.
**Decision:** Add a Phase 1.5 generic recursive sweep to `extractInlineImagesToR2`
that walks the entire data tree and queues every remaining base64 / data:image
string for R2 upload, replacing each field in-place with the R2 URL under
`stories/{id}/aux/{path}.jpg`. Per-field walkers stay (semantic R2 keys
under `/stories/{id}/page-{N}/...` are nicer for browsing) and a `queuedInputs`
Set prevents the sweep from re-queueing strings already targeted by the
explicit walkers (would race two `apply()` callbacks on the same field).
**Rationale:** The original per-field strip philosophy required adding a
new walker for every new image field — an unmaintainable allowlist that
silently regressed every time anyone added an image-bearing key. A generic
sweep + a `queuedInputs` dedup gives us **deny-by-default** for inline
base64 in JSONB without breaking the semantic R2 keys we still want for
audited fields. Nothing destructive: failed R2 uploads leave bytes in
place for the existing strip to drop (same behaviour as before).
**Touched:** `server/services/database.js` (`extractInlineImagesToR2`).
**Status:** ✅ active.

### Trial landmark photo variants — surface per-angle descriptions to Claude
**Context:** Every Baden trial picked "Holzbrücke (Baden)" and the renderer
always used variant 1 (an exterior far-away river shot), even when scenes
took place inside or on the bridge — Holzbrücke has 5 indexed variants
including 2 interior shots (variants 4-5). Two compounding bugs: (1) the
trial landmarks instruction at `storyHelpers.js:5388` listed only landmark
names with no photo-angle descriptions, so Claude had no signal to pick a
variant; (2) the trial prompt's `landmarkQuery` example was literally
`"Holzbrücke Baden"`, biasing Claude to pick it over higher-scored
candidates (Sankt-Nikolaus-Kapelle 135, Stadtpfarrkirche 135 both beat
Holzbrücke 134). Few-shot examples in prompts are sticky.
**Decision:** Carry the full `photoVariants` array (with per-variant
descriptions) through `storyIdeas.js` → trial landmarks instruction.
Emit a `PHOTO ANGLES` block per landmark when ≥2 variants exist, plus a
variant-syntax instruction (`[LOC###.N]`) so Claude can pick interior
vs exterior per scene. Remove the Holzbrücke example from the trial
prompt and replace with a generic "copy verbatim" instruction.
**Rationale:** The variant indexing + `getLandmarkPhotosForScene`
`[LOC###.N]` parser were already in place; the planner just never knew
about them. Full mode uses a second scene-expansion pass that loads
variant descriptions, but trial has no second pass — variant info must
land in the unified prompt or it never lands.
**Touched:** `server/routes/storyIdeas.js` (variant carry-through);
`server/lib/storyHelpers.js` (`buildTrialStoryPrompt` landmark
instruction); `prompts/story-trial.txt` (drop bias example).
**Status:** ✅ active.

### Trial scenes: character physical traits + VB-secondary descriptors
**Context:** Trial scene prose came out as bare action ("Lukas stands at
the wooden garden gate") with zero visual descriptors — Grok had to rely
entirely on the styled-avatar reference image for the uploaded main
character, and **invented secondary characters** (Mia, Noah, shopkeepers)
landed in the prompt as just a name. Grok reinvented their appearance
every page, breaking cross-page consistency. Two distinct leaks: (1)
`buildTrialStoryPrompt` emitted `name/age/gender/traits` but not
`character.physical` even though `trial.js:737-745` stamps Gemini-
extracted `hairColor/eyeColor/skinTone/detailedHairAnalysis` onto the
character row; (2) `buildImagePrompt`'s storybook path strips the full
VB text when `skipVisualBible: true` (the default for Grok — 8000-char
limit, VB grid sent as image instead), so secondary-character VB entries
with hair/face/clothing fields never reach the prompt.
**Decision:** Surface `character.physical` to Claude via the trial
CHARACTERS section (`hair: brown; eyes: blue; skin: fair; hair detail:
...`) so prose can weave it in. Separately, in `buildImagePrompt`,
inject a compact `**SECONDARY CHARACTERS IN THIS SCENE:**` block built
from `visualBible.secondaryCharacters` filtered by `.pages[]` —
preserves the Grok-skips-VB optimization for the bulk text while keeping
the per-scene-relevant secondaries (typically 1-3 per page) so invented
characters render consistently.
**Rationale:** Photos work for uploaded characters; descriptors work
for invented ones. We need both. Filtering by `pages[]` means each page
only carries ~50 chars per relevant secondary instead of the full cast
(would blow Grok's 7500-char effective limit on busy stories).
**Touched:** `server/lib/storyHelpers.js` (`buildTrialStoryPrompt`,
`buildImagePrompt`).
**Status:** ✅ active.

### Avatar eval: normalize inputs + use face crop + tighten scoring (F1/F2/F3)
**Context:** User flagged avatar evaluation scores as suspiciously high.
Three issues compounded: (F1) `evaluateAvatarFaceMatch` used a string
`.replace(/^data:image\/\w+;base64,/, '')` to peel data-URI prefixes
before sending to Gemini — a no-op for HTTPS R2 URLs (the common case
post-R2 migration), causing the URL string to be sent as "base64 image
bytes", Gemini returning 400, and the function silently returning null
(stale score persists, no retry fires). (F2) All 4 callsites passed
`referencePhoto` (the bg-removed body with clothing — face is ~5% of
pixels) as the face-match anchor instead of the dedicated `facePhoto`
(zoomed face crop the Python service produces). Dilute signal. (F3) The
prompt was lenient — Gemini was told to score eyes/nose/mouth/overall
structure but not face geometry (forehead height, cheekbone prominence,
jawline shape), so avatars with visibly different geometry could pass
with 7-8 if individual features happened to look similar.
**Decision:**
- **F1:** Normalize both `evaluateAvatarFaceMatch` args via
  `r2.bytesFromAnyImage()` (handles URL / data URI / raw base64
  uniformly), fail loudly on decode failure.
- **F2:** Prefer `facePhoto` / `faceRefPhoto` over `referencePhoto` at
  all 4 callsites (job + sync, initial + retry). Falls back to
  `referencePhoto` only when no dedicated face crop was uploaded.
- **F3:** Add `foreheadCheekJawline` as an explicit scored feature in
  `avatar-evaluation.txt`. Cross-style cap explicit: 8-10 requires ALL
  of faceShape + foreheadCheekJawline + eyes + nose + mouth to agree;
  one off → cap at 6; two off → cap at 4. Raise `MIN_BASE_AVATAR_SCORE`
  5→7 so genuinely-different-geometry sheets actually retry.
**Rationale:** The face photo IS sent to the evaluator (rules out the
"no face photo" hypothesis), but the wrong-shape input (F1) silently
broke it for URL inputs, the wrong-photo input (F2) starved Gemini of
signal even when decoding worked, and the lenient prompt (F3) let
genuine identity drift slip past. All three are independent root
causes with independent fixes.
**Touched:** `server/routes/avatars.js` (`evaluateAvatarFaceMatch` +
4 callsites + `MIN_BASE_AVATAR_SCORE`); `prompts/avatar-evaluation.txt`
(scoring rules + JSON schema).
**Status:** ✅ active.

## Performance

### Landing+nav static images shipped as WebP at display-resolution
**Context:** PageSpeed Insights flagged 871 KiB of unnecessary bytes on
the landing page, dominated by `logo-book.png` (664 KiB, an 868×864 PNG
rendered at 40px) plus oversized JPGs for the section illustrations,
hero thumbs, and video poster. Also: a 512×512 arrow icon rendered at
42px (`arrow-icon-1162.png`, 12 KiB), and the landing-characters image
had no `width`/`height` causing a 0.121 layout shift.
**Decision:**
- One-shot resize + WebP encode via `scripts/optimize-landing-images.js`
  (sharp). Each entry has an explicit target width — roughly 2× the
  measured display dimension. Originals get a `-orig.<ext>` backup the
  first run, so the script is idempotent (always re-encodes from the
  backup). Backups are gitignored.
- Consumers switched to `.webp`. Arrow icon stays PNG but in-place
  shrunk to 128×128 (12 KiB → 2 KiB).
- Every `<img>` got explicit `width` + `height` (CLS fix) plus
  `loading="lazy" decoding="async"` for below-fold images and
  `fetchPriority="high"` on the logo + first hero thumbs.
**Rationale:** WebP is supported by 97 %+ of browsers — no `<picture>`
fallback needed for a public landing page. The originals stay on disk
under `images/*-orig.*` so a one-line `git checkout` can roll back if a
browser issue surfaces. Display-2× resolution is the standard retina
buffer; going higher just wastes bytes the rendering layer doesn't use.
Total measured savings: 1,230 KiB → 339 KiB (−891 KiB, 72.4 %).
**Touched:** `scripts/optimize-landing-images.js` (new); 11 files in
`images/` (new `.webp` siblings + arrow-icon shrunk in place);
`client/src/pages/LandingPage.tsx` (7 imgs); `Navigation.tsx`,
`ClaimAccount.tsx`, `SharedStoryViewer.tsx`, `TrialGenerationPage.tsx`,
`TrialWizard.tsx` (logo references); `.gitignore` (backups).
**Status:** ✅ active.

---

## Covers get full page-style evaluation (semantic + 3-stage + placement)
**Context:** Cover images (title page, initial page, back cover) skipped semantic
eval, three-stage compliance, and the P1 visual-inventory pass — all gated to
`evaluationType === 'scene'` in `evaluateImageQuality`. Those passes carry the
standing-surface / implausible-placement check, so a title page with characters
"standing in the river" scored 86 and shipped; the single quality pass missed it.
The original rationale was that semantic eval compares an image against the page's
story prose, and a cover has no prose — but the physics/placement/figure checks
were bundled into the same scene-only gate even though they need no prose.
**Decision:**
- Covers now run all three fidelity passes. The semantic reference is the cover
  brief (`sceneHint` = `scene.outlineExtract`) in place of page prose.
- Covers are head-on portraits, so viewer-gaze and a flat (non-3D) title are
  intended, NOT defects. Two-part fix: (1) the outline's cover `GAZES AT` rule
  now sets every cover figure to gaze at `the viewer`, so a correctly rendered
  cover matches its brief; (2) a COVER note tells the fidelity + quality
  evaluators not to deduct for viewer-gaze or a flat title — while still flagging
  placement, garbled object text, and missing/extra/mismatched characters.
- Only the unified repair pipeline's eval was changed (the authoritative scorer
  that persists versions, picks best, and triggers cover regen). The in-loop
  generation-time eval for covers was deliberately left without fidelity passes
  to avoid extra cover regens on every story.
**Rationale:** Covers are the marketing image; an in-river or garbled-text cover
must be caught and regenerated like any bad page. Viewer-gaze leniency prevents
the new strictness from regenerating good covers for facing the camera.
**Touched:** `server/lib/images.js` (`evaluateImageQuality` gates + cover note),
`prompts/story-unified.txt` (cover GAZES AT rule).
**Status:** ✅ active.

---

## 2026-07-04 — Code-review cleanup: 18 fixes shipped, 6 structural refactors deferred

**Context:** The 2026-07-04 high-effort review (docs/review-2026-07-04.html) found
43 issues. 19 P0/P1 (security/billing/pipeline) shipped earlier. A follow-up pass
implemented the remaining contained findings.

**Decision:** Shipped 18 more to staging — DUP-1..7 (dedup: data-URI strip x56,
withRetry, image-metadata/costume-key helpers, grokAspect + rembg modules), SW-1..5
(collapse dead composite gate to single source `enableSceneComposite:false`; delete
dead storyAvatarGeneration.js + face-comparison code + phantomPoseRender flag),
SPD-1..6 (poll knownPages dedup, per-page rehydrate on repair endpoints,
structuredClone + parallel image inserts, parallel cover bbox, useMemo parse),
STR-6 (7 inline prompts → prompts/*.txt). Deferred 6 structural refactors
(STR-1 pipeline split, STR-2 images.js god-file split, STR-3 positional-args→object,
STR-4 25-endpoint ownership middleware, STR-5 StoryDisplay split, VAR-1 image-version
data-model unification) to individual staging-tested PRs.

**Rationale:** The 18 are behavior-preserving and provable by the generation
showcase. The 6 deferred touch god-files / 25 repair endpoints / persisted data that
one autonomous showcase cannot validate; bundling them would risk the safety gate.
Each has a concrete plan.

**Touched:** ~30 files across server/lib, server/routes, server.js, config/models.js,
client; new lib/grokAspect.js, lib/rembg.js, utils/imageMetadata.js, utils/costumeKey.js.
**Status:** ✅ active. Plans: docs/review-2026-07-04-structural-plan.md.

---

## 2026-07-05 — jsonb 256MB overflow on repair-heavy stories (finalize save)

**Context:** A staging showcase (comic, 14pp, 11/11/11 repairs) failed at finalize
with Postgres `total size of jsonb array elements exceeds the maximum of
268435455 bytes`. Root cause: `extractInlineImagesToR2` moves debug base64
(bboxOverlayImage, charRepair*, grids, grokRefImages…) to R2 and swaps in URLs,
but on an R2 upload failure it retains the base64. The safety-net
`stripInlineImagesFromStoryData` is an explicit allow-list that did NOT cover the
per-version `charRepairGrokRaw/BlendMask/Whiteout` fields, so those leaked and,
across many repaired versions, overflowed PG's 256MB jsonb cap. Pre-existing
(unrelated to the 2026-07-04 cleanup; discovered by its validation showcase).

**Decision:** (1) Added `charRepair*` to the version strip explicitly. (2) Added a
generic recursive base64 safety-net sweep at the end of
`stripInlineImagesFromStoryData` that drops ANY remaining inline base64 image
string, EXCEPT within `styledAvatars`/`costumed` subtrees (per-story data with no
other home). Guarantees the blob can never overflow from a debug field again,
regardless of R2 outages or newly-added image fields.

**Rationale:** Every inline payload here is redundant (source of truth is the
characters table / story_images / R2). Losing a diagnostic image on an R2 outage
is always better than failing the entire story save. Unit-tested: base64 dropped,
R2 URLs kept, styledAvatars preserved.

**Touched:** `server/services/database.js` (`stripInlineImagesFromStoryData`).
**Status:** ✅ active.

---

## 2026-07-05 — Search ads land on the HOMEPAGE — final, do not re-litigate

**Context:** June: 79 paid clicks → homepage, 0 reached /try (the /try page-view
conversion pixel fired zero times), 0 trials, 0 attributable books. Prior
history: ads pointed at /try, repointed to homepage 2026-06-14, question
re-raised 2026-07-05.
**Decision (user, explicit):** ads keep landing on the homepage. Permanently.
The optimization surface is the HOMEPAGE→/try path (CTA prominence, homepage
conversion), never the ad final URL.
**Touched:** none (status quo confirmed).
**Status:** ✅ final.

## 2026-07-09 — Storage & observability overhaul: what shipped, what's deferred, what's dead-by-decision

**Context:** Four-agent audit of image storage (R2 completeness), the version
viewer, prompt/output logging, and repair-method docs. Full findings in the
session; fixes shipped across `ba2d2f92..50d79c26`.

**Decisions:**
- **Dead code is MARKED, not deleted** (user decision): the mask-inpaint
  dispatcher (`inpaintWithMask` + 8 siblings in images.js), server
  `chooseRepairStrategy`, `MODEL_DEFAULTS.inpaintBackend`,
  `enableAutoRepair`, and the two unread `REPAIR_DEFAULTS` iterate
  thresholds all carry DEAD CODE/CONFIG banners. Do not document them as
  live; do not wire the thresholds in without recalibrating (their values
  disagree with the hardcoded gates in repairLogic.js).
- **Eval calls have a 120s timeout** (stuck-at-51% incident 2026-07-07):
  abort → withRetry → skip-eval-and-continue. A hung provider call can no
  longer freeze a job.
- **grokRefImages is the model-agnostic "refs sent" field**: all
  callGeminiAPIForImage/generateImageOnly branches stamp prompt + refs on
  their results (name kept for save-path + viewer compat).
- **Character source photos upload to R2 at write time**; the wizard's
  echoed base64 never overwrites a stored URL; the backfill script no
  longer self-blinds (marker doesn't exclude rows). Full prod backfill run
  2026-07-09: 31 rows, 77 MB reclaimed.
- **Cover retryHistory persists to story_retry_images under negative page
  numbers** (frontCover -1, initialPage -2, backCover -3).

**Deferred (deliberately, not forgotten):**
- `saveStoryData`/`upsertStory` ~150-line duplication merge — highest-risk
  write path; needs its own session with an end-to-end story-save
  validation run.
- Deleting the `/images` SLOW blob path — blocked: 11 prod stories (mostly
  Jan 2026) still have no story_images rows. Migrate them first (re-save
  through saveStoryData), then delete.
- R2 orphan cleanup on character delete + checkpoint cleanup on job
  failure — improvement, not selected in this round.
**Touched:** server/lib/images.js, sceneValidator.js, entityConsistency.js,
coverComposite.js, scoring.js, services/database.js, routes/regeneration.js,
routes/avatars.js, routes/characters.js, routes/stories.js, config/models.js,
server.js, client repairDefaults.ts, scripts/admin/backfill-character-photos.js,
docs/codebase-guide.md, docs/image-generation-methods.html.

## 2026-07-09 — Realistic style: redress pass instead of full styling skip

**Context:** For realistic, styled-avatar generation was skipped entirely
("photos are already realistic"). But the outline contract
(story-unified.txt: clothingRequirements.description "IS the outfit" and the
model MAY change garments/add accessories) is fulfilled by the styled-avatar
redress for every other style. Skipping it meant realistic scene refs (and
composite-cover cutouts, whose pass-1 prompt commands "keep clothing
exactly") wore the creation-time outfit while the prompt text said the story
outfit — the visual ref wins, so story outfits never rendered, and the
entity eval (which judges against clothingRequirements) flagged the
mismatch it couldn't fix.

**Decision (user, option A):** realistic keeps skipping STYLE transfer (the
2x4 sheet's Pass 2 already skips it) but redresses per category when the
resolved story outfit differs from the stored avatars.clothing — Pass 1
generates a realistic sheet in the requested outfit. Unchanged outfits (the
common case) generate nothing. server.js gates no longer exclude realistic;
prepareStyledAvatars decides per category. applyStyledAvatars applies
redressed avatars for realistic (cache misses are the normal case there —
logged quiet, not as ERROR).

**Also fixed:** getStyledAvatarForClothing's no-styled-avatars fallback
tried base 'standard' BEFORE the requested category (winter-page repairs and
entity grids got standard-clothing references); and when realistic has some
redressed categories, a non-redressed category now prefers its own base
avatar over a redressed standard.

**Touched:** server/lib/styledAvatars.js, server/lib/entityConsistency.js,
server.js (4 gates).

---

### Char-repair misregistration + blur guards (blended/cutout)

**Date:** 2026-07-09

**Context:** A prod page shipped with a blurred/"blended"-looking figure after
character repair. Two verified mechanisms in `repairCharacterMismatchWithGrok`:
(1) Grok redraws the page freehand and `resizeGrokToSceneDims` can center-crop
— the output sits a few px off the original, and the blend mask (feather ring
+ ORIGINAL-scene silhouette) is built in original coordinates, so old and new
content crossfade into a smeared figure; (2) blended mode signals "redraw
this" with a blur, and diffusion editors sometimes ENHANCE the blur instead
of replacing it — the exact failure that gave the cutout path its magenta
crosshatch, never ported to the blended path (sibling gap, still open —
switching blended to a shape-aware hatch needs scene-harness validation
before shipping).

**Decision:** three guards at the `repairCharacterMismatchWithGrok`
chokepoint (all callers inherit): (a) `estimateGlobalShift` — background-patch
SAD (±8 px, ≥3-patch consensus, low-variance patches skipped) measures Grok's
global drift; output is re-aligned via `shiftRawRegion` before any mask math
(blended + cutout); (b) blended's silhouette gate now uses old ∪ new — rembg
runs on Grok's repaint too, union-gated by area plausibility (⅓×–3×), so an
offset repaint is neither clipped by the old outline nor leaves old-figure
pixels standing; (c) sharpness gate — Laplacian edge-energy of the figure
bbox, repaired < 50% of original → repair rejected
(`rejectedReason: 'repaired_figure_blurred'`), original page kept. Plus one
eval bullet (image-evaluation.txt figure-completeness list): a whole figure
noticeably blurrier than the rest of the page → MAJOR `smeared_artifact`.
Gates fail open (guard error → repair accepted unchecked, warned) so rembg
or sharp failures never kill a repair that used to succeed.

**Rationale:** feathering smooths seams but cannot re-register shifted
content; the mask must match where the figure actually landed. Ratio-based
sharpness (not absolute) so soft art styles (watercolor) pass. Thresholds:
`REPAIR_SHARPNESS_REJECT_RATIO 0.5`, `REPAIR_SHARPNESS_MIN_ORIG 25`,
`MAX_SHIFT 8`, `MIN_VARIANCE 60`.

**Touched:** server/lib/images.js (helpers + blended + cutout branches),
prompts/image-evaluation.txt, docs/image-generation-methods.html.

## 2026-07-10 — /geschichten-aus town URLs removed from the sitemap

**Context:** Organic-decline investigation found 51 towns × 3 langs (153
URLs) submitted in the sitemap since 2026-03 that never had a client route
or prerendered page — every one served the generic SPA shell (soft-404 /
duplicate ballast). GSC data showed the only thing they attracted was
zero-intent trivia impressions.
**Decision:** de-sitemap (not build): /stadt/:city already covers city SEO
with real prerendered pages; a second thin city-page family would be
doorway-page territory. seoMeta route handlers kept (direct visits still
get correct meta). Re-add the sitemap loop only when the pages become real
(route + prerender + own content).
**Touched:** server/lib/seoMeta.js (generateSitemap).

## 2026-07-10 — Image versioning: pinned active versions + explicit DB index stamps

**Context:** Version-handling audit (write paths, read paths, git history)
found one recurring root cause behind years of "wrong version shows" bugs:
`recomputeAllActiveVersions` (score-based, runs inside EVERY save) fought
every path that sets an explicit active version. Style-transfer/scale-repair
set active then called saveStoryData — the recompute immediately reverted to
the best-scored older version (the new one is unscored, so it could NEVER win);
manual version picks survived only until the next save. Second cause: two
index allocators — `getNextVersionIndex` (DB MAX+1) vs `imageVersions.length-1`
— diverge on lazy-migrated stories, and `_alreadySaved` was honored for covers
but ignored by both scene save loops (double-write, possibly at a WRONG index,
overwriting an older version's bytes). Third: the blob `activeVersion` mirror
ran AFTER the `UPDATE stories SET data` on a clone, so it never persisted —
blob readers (client, entityConsistency) fell back to "latest" while serving
paths (PDF/print/share) resolve meta = best-score.

**Decision:**
- `image_version_meta[key]` gains `pinned: true`. Pinners (explicit user
  choice): manual active-image PUT, iterate, style-transfer, scale-repair,
  inpaint auto-repair, cover regen/iterate/edit. The recompute (and
  scripts/admin/recompute-active-versions.js) skips pinned keys but still
  mirrors the pinned choice onto the blob. A PLAIN `setActiveVersion` call
  replaces the meta entry and thereby CLEARS the pin — deliberate: pipeline +
  repair-workflow pick-best hand the page back to score-based selection.
- Version entries written by regen routes carry `dbVersionIndex` (the real DB
  version_index) + `_alreadySaved`. Save loops (scenes now too) skip
  `_alreadySaved` and write at `dbVersionIndex ?? arrayToDbIndex(i)`; all
  pickers/mappers (`getActiveIndexAfterPush`, recompute, rehydrate, GET
  merges) prefer the stamp over identity mapping.
- Both `length-1` allocation sites (iterate scene, auto-repair) now use
  `getNextVersionIndex`.
- Recompute moved BEFORE the blob UPDATE in `persistStoryToDatabase` and
  `saveScenePageData` so the `activeVersion` mirror actually persists.
- Stale-pointer fallback unified on v0 (serving parity): `/images` full mode
  no longer clamps to max. `resolveActiveVersionData` (entityConsistency)
  prefers numeric activeVersion, then ROOT imageData (= meta-active after
  rehydrate), and "latest" only as a last resort. GET slow path attaches
  meta-resolved activeVersion. `getActiveVersion` blob fallback checks numeric
  `activeVersion` before the legacy `isActive` boolean.
- `updateStoryDataOnly` deleted (zero callers; saved cover versions but not
  scenes, never recomputed).

**Rationale:** one selection rule needs one escape hatch, not seven endpoints
racing it. Score-based selection stays the default; a pin is the single,
explicit, durable way to override it. Explicit DB stamps make the blob↔DB
mapping self-describing instead of relying on identity that lazy migration
breaks.

**Touched:** server/services/database.js, server/lib/scoring.js,
server/lib/versionManager.js, server/lib/entityConsistency.js,
server/routes/regeneration.js, server/routes/stories.js,
server/routes/admin/database.js, scripts/admin/recompute-active-versions.js,
tests/unit/version-manager.test.ts, tests/unit/active-version-recompute.test.ts,
tests/manual/test-save-merge.js.

## 2026-07-11 — Rendered-text severity is graded: small in-world signage ok, large/wrong text catastrophic
**Context:** Commit 5792322e (2026-06-07) made every rendered-text leak flat
CRITICAL so the redo gate would fire ("Holzbank am Stadtturm" painted on a
bench shipped at 70 ≥ 60). Flat-CRITICAL over-penalised harmless in-world
signage (a shop sign, a book spine) the same as a garbled caption across the
sky.
**Decision:** Owner rule: "minor text on signs is acceptable, large wrong
text is catastrophic." Graded severities in `image-evaluation.txt`:
incidental small plausible in-world signage → not flagged (MINOR if
garbled); prominent/large text, wrong or garbled words,
captions/watermarks/story-text painted into the image → CATASTROPHIC. Same
grading applied to `character_marking` (avatar back-panel artifact):
obvious/prominent marking → CATASTROPHIC, subtle/ambiguous → CRITICAL. Cover
TEXT RULES block (`images.js` `evaluateImageQuality`): title
missing/misspelled → CATASTROPHIC (the title is the point of a cover); other
prominent unrequested text → MAJOR (inpaintable STRAY_TEXT path); the old
"Score MUST be 0" sentence dropped (the model's numeric score is
audit-only). The "so the redo gate fires" clauses were deleted — under the
math scale a CATASTROPHIC (−50) lands the page ≤ 50 < 60 and fires the redo
arithmetically; `decideRepairMethod` also routes any catastrophic-severity
issue to iterate (commit "catastrophic severity routes like critical").
**Rationale:** Grading restores the intended effect (real text leaks always
redo) without nuking pages for a legible shop sign that belongs in the
scene. Supersedes the flat-CRITICAL rule from 5792322e.
**Touched:**
- `prompts/image-evaluation.txt` — §3 rendered-text definition, STEP 0
  catastrophic trigger list, STEP 3 RENDERED TEXT + CHARACTER MARKING blocks
- `server/lib/images.js` — cover TEXT RULES injected block; TITLE_ERROR
  classifier matches CATASTROPHIC|CRITICAL (old stored evals)
**Status:** ✅ active (supersedes commit 5792322e's flat-CRITICAL rule).

## 2026-07-11 — Cover gaze is code-owned: `gazes at:` removed from cover hints, always the viewer
**Context:** The cover-hint per-character `gazes at:` field created a
three-way conflict (finding #21): the outline could aim a gaze at a prop
(`gazes at: ART005`), the composite POSES lines hardcoded "Eyes wide OPEN
looking straight at the viewer", and pass-2 said "do NOT redirect any gaze
toward the camera". The prompt rule already said every cover gaze must be
`the viewer` — a field whose only valid value is a constant is not data.
**Decision:** The field is removed from the cover-hint spec in
`story-unified.txt` (rule bullet, field shape, example, all template
lines); one scene-level sentence states covers are head-on portraits.
Rendering owns gaze: every cover consumer hardcodes "the viewer" /
"gazing at the viewer" and ignores any parsed `gazesAt` value. Parsers
(outlineParser/shared.js + unified.js) still ACCEPT `gazes at:` on
bullets — old stored stories and model habit — the value is simply unused
on covers. Scene-page gaze semantics (facing-vs-gaze rules,
interactions[]) are untouched.
**Rationale:** One owner per fact. Extends the logged viewer-gaze rule
from prompt-enforced to code-owned; the pass-2 "preserve gaze" line now
agrees (keep looking at the viewer) instead of contradicting.
**Touched:**
- `prompts/story-unified.txt` — cover section (rule deleted, shape/example/
  templates stripped, portrait sentence added)
- `server.js` — streaming cover prose composer (constant gaze)
- `server/lib/coverIterate.js` — buildCoverSceneFromHint (constant gaze,
  resolveGazeTarget removed)
- `server/lib/coverComposite.js` — STORY ACTION lines (holds only), pass-2
  synth prose (constant gaze), pass-2 PRESERVE line aligned
- `server/lib/compositeCastBuilder.js` — buildAction (constant gaze)
**Status:** ✅ active (extends "cover portraits: viewer-gaze not a defect").

## 2026-07-11 — Story clothingRequirements is the ONE canonical clothing source; entity eval was repainting story outfits back to stored
**Context:** Realistic showcase (staging, "Die rote Dose"): redress pass,
page prompts, and cover refs were all CORRECT (story outfits), but the
entity-consistency eval judged against the character-level stored
`avatars.clothing[category]` — its canonical came from
`buildCharacterDescriptionsForBbox`, which fed raw stored clothing into
`bboxDetection.characterDescriptions`. It flagged every page + cover as
`clothing_inconsistent`, issued fixInstructions like "change the bright
pink jacket to the dark blue butterfly jacket", the cover repair executed
one, and the scorer (same wrong canonical) ranked the reverted cover ABOVE
the correct v0 (73 vs 55). The July-8 fix (591b19a2) covered
evaluateImageBatch but not this sibling builder.
**Decision:** Every canonical clothing text resolves through
`buildClothingDescription` with the story's `clothingRequirements`
(signature → description → stored fallback), and every reader of
`clothingRequirements[name]` goes through the shared case-insensitive
`resolveCharacterReqs` (clothingCategories.js). Supporting fixes: cover
prompts now carry a per-character CLOTHING block (previously image-refs
only — no text anchor); redress name-miss logs ERROR instead of silently
skipping; `getStyledAvatarForClothing` normalizes its category at entry;
repair paths resolve the page's stored clothing before defaulting to
'standard'; `applyStyledAvatars` prefers the originally requested category
over a photo-fallback category; `primaryClothing` is computed (dominant
category) instead of hardcoded 'standard'.
**Rationale:** One source of truth per concept. Image refs and prompt text
previously desynchronized through independent fallback ladders; the eval
loop then actively reverted correct images because its reference text was
from a different (stale) source than the generation path.
**Touched:** `server/lib/clothingCategories.js` (resolveCharacterReqs,
resolvePageClothingCategory), `server/lib/storyHelpers.js`
(buildCharacterDescriptionsForBbox, getCharacterPhotoDetails,
buildCharacterReferenceList includeClothing), `server/lib/entityConsistency.js`
(buildClothingDescription, getStyledAvatarForClothing, repairSinglePage),
`server/lib/images.js` (quality-retry threading, char-fix category),
`server/lib/styledAvatars.js` (redress name guard, applyStyledAvatars),
`server/lib/coverIterate.js` + `server.js` (cover clothing text +
threading, primaryClothing), `server/routes/regeneration.js`.
**Status:** ✅ active.

## 2026-07-14 — Last clothing-default leak closed: vision analysis primed iterate rounds with the stored outfit
**Context:** Continuation of the 2026-07-11 sweep above — one leak site was
missed. On job_1783889777354 ("Grossvaters Kiste") P1, v0 rendered Hans
correctly in his story polo, but every iterate round (v2+) repainted him in
his base-character default (red plaid + suspenders); Emma the same (default
butterfly shirt instead of her story cotton top). The scene prose was NOT
dropping the outfit — it was being FED the wrong one. `formatCharacterContext`
(sceneValidator.js), which builds the character context that primes
`analyzeGeneratedImage` (the vision analysis feeding `previewFeedback.composition`
into scene iteration), read `char.avatars.clothing[category]` directly — the
stored default — instead of the story clothing. The vision model then described
the default outfit even though the image showed the correct one, and the iterate
adopted that description.
**Decision:** `formatCharacterContext` resolves clothing through the same
`buildClothingDescription(char, category, null, clothingRequirements)` every
other path uses (story `clothingRequirements` → `avatars` fallback). Swept all
remaining `avatars.clothing[category]` reads in `server/lib`; every other one
already prioritizes `clothingRequirements`, so this was the sole unguarded site.
Reverted the interim prose-mandate attempt (84790ac7) — it was built on the
false premise that the model was DROPPING correctly-supplied clothing, and its
"mandatory" banner wording violated the terse-prompt rule; the real input fix
makes it redundant.
**Rationale:** The stored per-character default must never enter a story — only
the per-story `clothingRequirements` is authoritative. A vision-analysis prompt
primed with the wrong outfit silently propagates it through the whole repair loop.
**Touched:** `server/lib/sceneValidator.js` (formatCharacterContext +
buildClothingDescription import), `server/lib/storyHelpers.js` (corrected the
buildImagePrompt comment), `prompts/scene-expansion.txt`,
`prompts/scene-iteration.txt`, `prompts/scene-iteration-free.txt` (reverted
prose mandate). The entity-eval costumed-promotion guard (943c0198 Part B) is a
separate, still-active fix.
**Status:** ✅ active.

## 2026-07-11 — SOLID-GROUND rule: one canonical wording per prompt layer
**Context:** "Characters stand on solid ground, never in water" lived in six
drifted formulations (3 cover templates, coverComposite pass-1 + its
PRESERVE carve-out + pass-2, coverIterate plate characterSpace).
**Decision:** Three canonical formulations, one per layer:
1. Cover templates (front-cover / initial-page-with-dedication /
   initial-page-no-dedication), identical bullet: "All characters stand
   firmly on solid ground — feet flat on a stable surface (floor, pavement,
   cobblestones, grass, path). Never standing in or on water, never
   floating, never mid-air; feet visible on the ground and level with each
   other."
2. Composite edit prompts: module const `SOLID_GROUND_REPAINT`
   (coverComposite.js) shared by pass-1 and pass-2; the PRESERVE carve-out
   references "per the SOLID GROUND rule above" instead of restating it.
3. Empty-scene plates (coverIterate characterSpace): band-level variant —
   plates prepare ground before figures exist, so it speaks about the
   bottom fifth of the frame, not about feet.
**Rationale:** Six drifted statements of one rule invite partial edits;
each layer genuinely needs different phrasing (generation bullet, edit
repaint instruction, plate preparation) but not six.
**Touched:** prompts/front-cover.txt, prompts/initial-page-*.txt,
server/lib/coverComposite.js, server/lib/coverIterate.js
**Status:** ✅ active. (Note: back-cover.txt has no solid-ground rule at
all — pre-existing gap, not added here.)

## 2026-07-11 — OPEN QUESTION: cover text baked into the image vs app-side overlay
**Context:** Cover titles / dedications / the back-cover URL are painted by
the image model (front-cover.txt TITLE block, composite textLine). Model
lettering is the top source of garbled cover text; an app-side overlay
(like the story-text overlay) would be pixel-perfect but loses the
hand-painted look and needs per-style font work.
**Decision:** OPEN — no implementation. Current state: baked-in. The
composite flow renders text exactly once (two-pass: pass-2 only; single
pass: pass-1 only, no pass-2), so no re-lettering pass exists.
**Rationale:** Product call (aesthetics vs reliability) — needs owner
input, not an engineering default.
**Touched:** (none — question only)
**Status:** 🗄 **superseded 2026-08-05** — see "Cover title: glyph-conditioned PAINT-IN, never
model-spelled" at the bottom of this file. The answer is neither option: app-side glyphs (correct
by construction) painted into the art by a masked edit pass, behind an OCR exact-match gate.

## 2026-07-12 — Text-usage accounting: chokepoint is the single source of truth
**Context:** Token/cost accounting undercounted Anthropic usage by ~3.5x per
story (and the Anthropic console showed ~12M tokens/week vs the pipeline's
logged ~0.7M). Root cause: every Claude/Gemini/xAI text call had to remember
to call the job's `addUsage()` closure, and most didn't — or only
conditionally, or into a `byFunction` bucket that had to be pre-declared or the
entry was silently dropped. Whole stages (scene expansion, phantom patch,
eval consolidation, VB dedup, and every unlabeled eval/repair Claude call) were
invisible.
**Decision:** The two text dispatchers `callTextModel` / `callTextModelStreaming`
are the ONLY place text usage is recorded. A new AsyncLocalStorage usage context
(`server/lib/usageContext.js`) holds the running job's sink; the chokepoint
records every call into it automatically. Guarantees: (1) no call escapes —
unlabeled calls land under `text_uncategorized`; (2) no double-count — a
dedup-by-usage-object-identity guard in `addUsage`, plus removal of the two
`phantom_patch` manual adds (that helper returns a COPY of the usage, the one
case identity-dedup can't catch); (3) clean breakdown — callers pass
`options.usageLabel`, and unknown labels auto-create their `byFunction` bucket
instead of being dropped. Concurrency-safe (per-job async context, mirrors the
styled-avatar cache scoping), no-op outside a job, never throws into the render.
**Rationale:** One chokepoint that can't be bypassed beats N scattered
conditional call sites. Verified on staging (job_1783832998294_vzhyem13c):
per-story Claude capture rose 88K → 313K; previously-invisible
`eval_consolidation` (100K) and `text_uncategorized` (140K) now appear; no
doubling.
**Touched:** `server/lib/usageContext.js` (new), `server/lib/textModels.js`
(chokepoint), `server.js` (both addUsage closures: sink + dynamic buckets +
dedup; removed phantom double-adds; usageLabels), `server/lib/phantomCharacters.js`,
`server/lib/feedbackConsolidator.js`, `server/lib/images.js`,
`server/lib/visualBible.js` (internal usageLabels).
**Follow-up:** `text_uncategorized` (~140K/story) bundles the remaining
unlabeled Claude eval/repair calls — label them individually if finer
attribution is wanted. The landmark-indexing batch calls Claude via
`callAnthropicAPI` directly (bypasses the dispatcher) but runs outside a job,
so it's out of scope for per-story accounting.
**Status:** ✅ active.

## 2026-07-13 — Generation and evaluation share ONE per-page clothing source
**Context:** On a costume-change page (job_1783889777354 P1: Noah has donned the
ninja suit, Emma is still in standard clothes holding hers), the pipeline
flip-flopped Emma's outfit between repair rounds — iterate rendered her standard
(correct), a later inpaint repainted her into ninja (wrong). Root: generation
and evaluation resolved her per-page clothing from DIFFERENT data.
- **Generation** learned clothing only from the free scene PROSE + avatar pixels;
  the canonical per-character clothing STRING computed in buildImagePrompt was
  logged and discarded (removed once to save Grok chars). The prose said Emma was
  "gripping a folded black ninja costume" (held, not worn) and never stated her
  worn standard outfit — so "ninja" was the only textual clothing token.
- **Evaluation** judged against characterClothing category → buildClothingDescription.
  Two evaluators diverged: the semantic-compliance eval reads the PROSE (misreads
  held-vs-worn), and entityConsistency.js collectEntityAppearances had a
  page-agnostic fallback that promoted ANY character with a costume anywhere in
  the story to `costumed` on EVERY page (Emma uses standard + costumed:ninja).
**Decision:** One canonical per-page, per-character clothing category
(`characterClothing[name]`) → `buildClothingDescription`/`clothingDescription`
feeds BOTH sides.
- (A) The worn outfit is ALWAYS supplied as input to the scene prose (each
  character's `Wearing:` line, resolved from the characterClothing category —
  verified: Emma page-1 got "light pink cotton top…"). The failure was the
  scene-expansion / scene-iteration model DROPPING it and narrating a HELD
  costume instead. Fixed at the source: scene-expansion.txt / scene-iteration.txt
  / scene-iteration-free.txt now mandate stating every character's WORN clothing
  in the prose and clarify that a costume held/found/nearby is NOT worn. (An
  earlier attempt injected a separate WORN CLOTHING block into the image prompt;
  reverted — it duplicated data already carried by the prose and lengthened it.)
- (B) entityConsistency.js collectEntityAppearances fallback only assumes
  `costumed` when the costume is the character's SOLE outfit across the story
  (no standard/winter/summer used); otherwise keeps the standard default. Emma →
  standard, Noah (costume-only) → costumed.
**Rationale:** generation and evaluation must be driven by the same clothing
field or they contradict and repair oscillates. clothingRequirements is
page-agnostic (lists every outfit a character wears anywhere) — never use it to
DECIDE a per-page category, only to describe one already chosen.
**Touched:** server/lib/storyHelpers.js (buildImagePrompt worn-clothing block),
server/lib/entityConsistency.js (costume-only fallback guard).
**Follow-up:** scene-expansion prose could also be tightened to always state
worn clothing + mark held items; and the >7500-char prompt truncation should
protect the WORN CLOTHING block over trailing prose.
**Status:** ✅ active.

## Char-repair figure mask: box-prompted SAM on a padded crop, not a whole-crop box (2026-07-15)
**Context:** The fullScene inpaint char-repair (`grok_inpaint`) built its magenta
crosshatch by cropping the scene tight to the figure box, then asking the
silhouette endpoint for `[0,0,cropW,cropH]` — the entire crop. On a loose box
that also spans a bright doorway/window (background figures standing near an
opening), both SAM and rembg segment that background object instead of the
figure, so the magenta landed on the background. Grok then repainted the
background (a no-op) and the target stayed unrepaired. Reproduced deterministically
on p4 of `job_1783981243217_bhub4d1ji` (Daniel, anime): magenta hatched the
covered-bridge doorway; SAM on `[0,0,cropW,cropH]` returned the doorway (62% fill),
SAM on the full image + Daniel's real box returned a clean Daniel silhouette.
**Decision:** (1) `figureMaskForHatch` crops with 50% padding around the figure box
and passes the REAL figure box mapped into crop pixel coords — the same pattern the
blended path (`fetchFigureMaskPng(cropForSilhouette, figureBoxInCrop)`) already used.
Both fullScene call sites (input hatch + feather fitness-check) go through it.
(2) Default `figureMaskBackend` flipped `rembg` → `mobilesam`: box-prompted SAM
isolates the single figure; rembg (salient-object, no box) cannot. rembg stays the
graceful fallback when SAM is unavailable/empty.
**Rationale:** Padded-crop + real-box gives the segmenter spatial context (verified to
isolate the figure) while keeping the rembg fallback correct (it runs on a
figure-centred crop, not the full scene where it would mask every figure). Chosen over
literal full-image + box specifically so the rembg fallback doesn't segment all figures.
**Touched:** `server/lib/images.js` (`figureMaskForHatch` in the useFullScene branch;
both hatch + feather call sites), `server/config/models.js` (`figureMaskBackend` default).
**Status:** ✅ active. Staging-first; prod default flip pending staging validation.

## Test Lab: is_test sandbox versions + explicit-template prompt overrides (2026-07-15)
**Context:** Prompt changes were validated on whatever single story was at hand —
no way to check a change across art styles/story types, and viewing other users'
stories required impersonation (2h token, lossy switch-back). Test generations
also polluted the story owner's version list.
**Decision:** (1) Plain admins may READ any story (`canReadAnyStory` in
stories.js) — write endpoints stay owner/impersonation-gated. (2) Test Lab
generations write `story_images` rows flagged `is_test` (+`experiment_id`);
every user-facing read filters `NOT is_test`, while `getNextVersionIndex`
deliberately counts test rows so promote = flip the flag with no re-index.
Promote appends a dbVersionIndex-stamped entry to the data blob and pins active.
(3) Prompt A/B overrides pass an explicit template into the builders
(`buildEmptyScenePrompt`/`buildEvaluationPrompt` `opts.template`,
`evaluateImageQuality` `evalOptions`, `evaluateSemanticFidelity` 5th param) —
never mutate `PROMPT_TEMPLATES` across an await; the only swap-based path
(`buildImagePrompt`) is synchronous, so no concurrent generation can observe it.
(4) Experiments run sequentially in-process, max 25 targets — bounded cost, no
queue infra; per-target results persist to `testlab_experiments.results`.
**Rationale:** Flag-on-rows reuses all existing versioning/R2/eval plumbing with
one column; a separate table would duplicate the byte-serving and promote paths.
Explicit-template params beat a global swap because prod generations share the
process.
**Touched:** migrations/008_testlab.sql, server/lib/testlab.js,
server/routes/admin/testlab.js, server/routes/stories.js, server/services/
database.js, server/services/prompts.js, server/lib/images.js,
server/lib/sceneValidator.js, client/src/pages/TestLab.tsx.
**Status:** ✅ active (staging-first; migration runs at boot).

## GroundingDINO uses a concise grounding prompt, not the image-gen description (2026-07-15)
**Context:** The GDINO figure-detection path fed each character `buildCharacterPhysicalDescription`
(+ `Wearing:` appended) — ~250 chars of face geometry (jawline/chin/nose-tip/cheekbones/lips) that
GDINO can't see in a render, filling its 256-token cap and truncating the one groundable token
(clothing colour). Measured across styles (staging, char-repair p4 investigation): verbose prompt
scored anime 0.445 / realistic 0.422, both with figure MISATTRIBUTION (one character's box collapsed
onto another's). A short "adult man with a beard wearing a green shirt" scored 0.86 on the same page.
**Decision:** New `buildGroundingPrompt(char)` (storyHelpers) emits a concise grounding prompt —
`a[n] {ageCategory} {genderTerm} with {hairColour} hair [and a beard] [glasses]` — carried as
`gdinoIdentity` through `buildCharacterDescriptionsForBbox`, then `buildExpectedCharactersForBbox`
appends the per-page clothing colour (short, capped) as `gdinoPrompt`. `detectFiguresWithGroundingDino`
prefers `c.gdinoPrompt` over the verbose `c.description` (falls back to it). The verbose description
stays the Gemini bbox prompt (Gemini reads face geometry fine).
**Rationale:** GDINO grounds on visually-locatable tokens, not fine facial features. Re-validated with
production wiring: anime 0.445→0.585, realistic 0.422→0.688, misattribution gone, all figures found.
Same-outfit same-age figures (e.g. two kids in identical kimonos) can still collapse in BATCHED
multi-figure detection; single-figure queries (char-repair) avoid it. Watercolour stays weak (painterly
render vs photo-trained backbone) — keep it on Gemini.
**Touched:** `server/lib/storyHelpers.js` (buildGroundingPrompt + gdinoIdentity + export),
`server/lib/images.js` (buildExpectedCharactersForBbox gdinoPrompt, detectFiguresWithGroundingDino
prompt source, export), `scripts/analysis/validate-gdino-figures.js` (harness).
**Status:** ✅ active (staging). Does NOT change the realistic-only detection gate — only improves the
prompt. Broadening the gate to anime/pixar is a separate future decision informed by this data.

## Correction (2026-07-15): watercolour is NOT weak once the prompt is concise
The entry above said "Watercolour stays weak … keep it on Gemini." Re-validation with the concise
`buildGroundingPrompt` disproved that: watercolour scored 0.632 (vs 0.34–0.50 with the verbose prompt),
comparable to anime (0.585) and realistic (0.688). The realistic-only gate is an artifact of the old
verbose prompt, not a real style boundary. Broadening GDINO to all styles is data-supported; the only
real cost is ~15s/figure CPU latency. Remaining soft spots (same-outfit kids, batched-attribution
collapse) are not style-specific. **Status:** ✅ correction active; gate still realistic-only in code
pending a broadening decision.

## GroundingDINO gate broadened from realistic-only to all figure-rendering styles (2026-07-15)
**Context:** GDINO detection was gated to `artStyle === 'realistic'` (73cf220f), set when the verbose
prompt made stylized styles look weak. Once the concise buildGroundingPrompt landed, re-validation
showed all three tested styles land together (realistic 0.69, anime 0.59, watercolor 0.63) — the gate
was an artifact of the bad prompt, not a style boundary.
**Decision:** New `MODEL_DEFAULTS.figureDetectionEligibleStyles` allow-list; the gate is now membership
in it. Enabled: realistic, anime, watercolor (tested) + steampunk, cyber, pixar (user-requested,
anime/3D-render family) + comic, cartoon, manga, concept, oil (same clothed-human clean render,
inferred). Excluded (stay on Gemini): chibi (super-deformed head/body), pixel (blocky low-res),
lowpoly (geometric faceted) — these break GDINO's human-figure assumption. Env override
FIGURE_DETECTION_STYLES=a,b,c.
**Rationale:** GDINO + concise prompt grounds on clothed-figure shape + clothing colour, which every
non-abstract style renders. Validated across the widest span (photo-realistic / cel-anime /
painterly-watercolor). comic..oil untested but structurally identical to what passed; chibi/pixel/lowpoly
genuinely differ. Still fails open (GDINO error → Gemini). Backend still env-gated to grounding-dino
(prod stays gemini).
**Touched:** `server/config/models.js` (figureDetectionEligibleStyles), `server/lib/images.js` (gate).
**Status:** ✅ active (staging). Latency unchanged (~15s/figure CPU) — only widens where GDINO may run.

## DINO goes generic: "person"/"face" prompts for geometry, identity resolved separately (2026-07-17)
**Context:** Even the concise identity prompt (age+gender+hair+clothing) produced bad production
boxes — Sarah's bodyBox collapsed to her head, Hans to a 0.046-height sliver, Noah lost entirely
(watercolor job_1784149662006). User insight: semantic vision (Gemini) trivially tells the young girl
from the old woman; the failure was always box GEOMETRY. Asking one text prompt to do detection AND
identity attribution is the design flaw.
**Decision:** Split the jobs. DINO gets generic prompts only: `"person"` for figure boxes (best +
candidates, NMS 0.5), `"face"` for face boxes (filter out person-sized leaks by IoU>0.5 vs person
boxes; keep box_threshold 0.20 — small-object face scores run 0.27–0.51). MobileSAM masks each person
box (box-only; face points optional via new `/figure-mask` points param but not needed when the box is
tight — and a bad point can drag the mask out of the box). Identity (which box is which character) is
a separate assignment step (Gemini face names / position prose), never a grounding-prompt job. DINO
`"face"` also replaces the Haar/anime cascade for face anchoring — it found a background elderly face
Haar missed and has no phantom problem after the size filter.
**Rationale:** Validated on 12 pages / 28 figures across watercolor, anime, realistic, comic (incl.
the exact production-failure pages): 100% figure recall, scores 0.59–0.73, zero head-only collapses;
Sarah's generic-prompt box matched ground truth within ~4px. Point-only SAM is unusable (control).
**Touched:** `photo_analyzer.py` (/figure-mask points/point_labels), `scripts/analysis/test-figure-cutouts.js`,
`scripts/analysis/test-sam-face-point.js` (validation harnesses). Commit 787e160f.
**Status:** ✅ WIRED TO PRODUCTION (6d6fb635, staging): detectFiguresWithGroundingDino now runs the generic design; overlay shows dashed DINO boxes, red face dots, yellow VB-object boxes, and a per-figure SAM cutout strip (masks travel non-enumerably, never into stories.data). Falls back to Gemini when persons < expected. Known limitation: German VB object labels ground weakly (English text encoder) — translate labels before grounding as a follow-up.

## Test Lab — full-coverage stages (2026-07-17)

**Context:** Coverage audit found Test Lab could re-run only 9 of 37 pipeline features; the whole repair loop, covers, and text zone had no isolated re-run path.

**Decision:** Every new stage wraps the exact core function the existing regeneration.js endpoints / repair pipeline already call — zero new pipeline logic. New stages: text_zone (ensureCalmZone), consolidate (consolidateEvaluation), inpaint (inpaintPage), iterate (iteratePageCore), repair_round (decideRepairMethod → inpaint/iterate/char-fix auto — one full automatic round on one page), edit_image (editImageWithPrompt), artifact_repair (gridBasedRepair), scale_repair (runScaleRepair), style_transfer (applyStyleTransfer), pick_best (report-only version ranking), scene_expansion + scene_description (LLM diff stages, sync template swap), avatar_eval (sheet evals standalone), cover (iterateCover with new explicit promptTemplateOverride option — never a PROMPT_TEMPLATES swap across await), style_check (checkStoryStyleConsistency, report-only). Cover/style_check are story-level targets ({storyId, coverType}); promote now supports cover types (pin via coverType key in image_version_meta). repairMode on char_repair was silently ignored before (no such option) — now mapped to useBlended/useCutout/useFullScene.

**Rationale:** One source of truth per repair method; Test Lab results stay representative of production behaviour (same fn, same params), and prompt A/B runs can't leak overrides into concurrent prod generations.

**Touched files:** server/lib/testlab.js, server/routes/admin/testlab.js, server/lib/coverIterate.js (promptTemplateOverride), client/src/pages/TestLab.tsx, client/src/services/testlabService.ts.

## Identity via Set-of-Mark (letter badges + Gemini recognition), layout matching demoted to fallback (2026-07-17)
**Context:** Generic DINO detection names figures by matching the scene plan (position prose + depth +
size + gender) to detected boxes. That cannot separate same-gender same-depth casts — three girls, two
women with no L/R prose — and fails silently (coin-flip). User insight: mark the figures A, B, C on the
image and ask Gemini who is who.
**Decision:** Primary identity is Set-of-Mark: letter badges drawn on each detected figure (below the
face), one gemini-2.5-flash call answers {"A": "<name>|unknown", ...} from age/gender/hair/clothing.
Gemini returns letters only — never coordinates — so its spatial sloppiness cannot corrupt the local
DINO/SAM geometry. Duplicate names or non-JSON → answer rejected. Fallback: the deterministic
layout+gender matching. diag.identity records method + raw answers.
**Rationale:** Splits the labor by proven strengths: DINO/SAM = exact geometry, semantically blind;
Gemini = strong recognition, spatially sloppy. Verified 8/8 correct on the two multi-adult test pages
incl. the page layout had coin-flipped. Costs one cheap Flash call per page (fraction of a cent, ~1-2s)
— affordable since these pages no longer make the expensive Gemini bbox call. Gotcha: gemini-2.5-flash
thinking ate small maxOutputTokens budgets → thinkingBudget 0, thought parts filtered, tolerant JSON
extraction.
**Touched:** `server/lib/images.js` (_somIdentifyFigures, Stage 4 restructure). Commit bbd1e55e.
**Status:** ✅ live on staging.

## Repaired versions are evaluated against their OWN scene contract (2026-07-18)
**Context:** Tell-story p2: the page text includes a third character, the outline plan dropped her, the
iterate rewrite (built from story text) re-included her — and the evaluator, reading the ORIGINAL page
metadata, flagged her as "extra character not in prompt or metadata", so round 3 inpaint REMOVED a
character the story text says is present. Root cause: iteratePageCore returns newScene/newSceneMetadata
but the pipeline dropped them — buildEvalInputs/buildEntityCheckData always judged round results against
orig.prompt/sceneMetadata/sceneCharacters. Sister defect: the eval flagged a character's canonical
glasses as "anachronistic for medieval Switzerland" (v0) and their ABSENCE as critical (v2) — whipsaw.
**Decision:** A version's prompt IS its evaluation contract. Iterate results carry newScene,
newSceneMetadata, newSceneCharacters onto the round entry and version record; buildEvalInputs and
buildEntityCheckData prefer the entry's own contract over the original page's; at final assembly the
PICKED version's contract (description/prompt/sceneMetadata/sceneCharacters) is promoted to scene level
so all later consumers judge the picked image against what was asked of it. Eval prompt: canonical
character features (glasses, hearing aids, braces) are identity, never anachronism.
**Touched:** `server/lib/images.js` (iteratePageCore return, round-entry fields, buildEvalInputs,
buildEntityCheckData, buildVersionEntry, final assembly), `prompts/image-evaluation.txt`.
**Status:** ✅ staging.
**Addendum (same day):** model-side detection proved input-dependent (~2/3 — it keyed off eval wording; 5/5 stable given identical input). Detection is now DETERMINISTIC CODE on the declared interactions (`detectDeclaredSpecConflicts` in feedbackConsolidator.js: body part committed in one interaction + targeted in another → spec_conflicts, merged with model findings). 3/3 identical routing verified. Also: iterate object additions are gated by an anchored allow-list (original metadata ∪ eval feedback ∪ page text — language-tolerant matching) after a rewrite swapped the scene vehicle for an unrelated statue.

## Scene-level scores are mirrors of the picked version — finalScore everywhere (2026-07-18)
**Context:** "One score" was unified at the VERSION level long ago (applyScore/computeFinalScore,
scoring.js) — but scene-level display fields never joined: the unified pipeline stamped
scene.qualityScore from best.score (a generation-time retry score on a different scale → junk like 0
next to a picked version scoring 50), scene.semanticScore from a legacy field, and scene.finalScore —
written at assembly — was silently DROPPED by the server.js whitelist mapping (predates the field), so
every stored scene had finalScore undefined. Five more legacy stamp sites in regeneration.js each wrote
their own notion of score into scene.qualityScore with no finalScore.
**Decision:** Scene-level score fields are MIRRORS of the picked/active version's canonical record,
never independently computed. Pipeline assembly: qualityScore = picked version's evalScore,
semanticScore from its semanticResult, finalScore via computeFinalScore. server.js whitelist carries
finalScore. All five regeneration.js stamp sites also stamp scene.finalScore; syncVersionToRoot mirrors
computeFinalScore(version). Readers (client StoryDisplay, database.js story_images writer) already
prefer finalScore with legacy fallback — no reader changes needed.
**Touched:** `server/lib/images.js` (final assembly), `server.js` (whitelist), `server/routes/regeneration.js` (5 sites).
**Status:** ✅ staging. Legacy qualityScore kept as fallback for old stories; new writes always carry finalScore.

## Spec-conflict pipeline: detect → declare → route → resolve, first attempt (2026-07-18)
**Context:** The Tell boat page proved a structural loop: the outline declared choreography that
double-books a body part (grip the rim with both hands + the other child reaches for/holds that hand),
renders always collapse to hand-holding, every eval blamed the render, iterate re-transcribed the same
spec from the story text, and after two failed iterates the anti-loop flip burned an inpaint. Nothing
ever said "the spec itself is the problem."
**Decision (four pieces, all lab-validated on the failing page):**
1. Consolidator: REQUIRED `spec_conflicts[]` output field — pairwise comparison of declared
   requirements (same body part in two, or almost-touching-without-contact), explicitly exempted from
   rule 1 (pass-through-only). Passive rules failed 6× — models decline "impossible" judgments and rule
   1 forbade the comparison; a mandatory schema field + mechanical question + exemption fires reliably.
2. Routing (code, not model): decideRepairMethod gate 0 — any spec_conflict → iterate, reason carries
   the conflict; repaint methods can never be chosen for a broken contract.
3. Iterate feedback leads with "SPEC CONFLICT — rewrite the interactions to resolve: A vs B".
4. scene-iteration.txt: a SPEC CONFLICT feedback line overrides the declared interactions — rewrite so
   each body part serves one purpose, keeping the story moment.
End-to-end result on the failing page: decision reason "spec conflict — scene rewrite required: the
same hand cannot be gripping the boat rim and be held at once"; the rewritten EXACT POSES kept Emma's
rim grip (the story beat) and dropped the competing hand claim.
**Also fixed (test-harness gaps this exposed):** storedEvalFromScene omitted threeStageResult; the lab
fresh-eval repair round skipped scoring-time consolidation — both made lab runs weaker than production
and masked working behavior.
**Touched:** `prompts/feedback-consolidator.txt`, `prompts/image-evaluation.txt`, `prompts/image-semantic.txt`,
`prompts/scene-iteration.txt`, `server/lib/repairLogic.js`, `server/lib/images.js` (previewFeedback),
`server/lib/testlab.js`, `scripts/analysis/test-spec-conflict-local.js`.
**Status:** ✅ staging.

## Test Lab must reuse production code — detection identity fix package (2026-07-18)
**Context:** Exp #68 (Qwen face repair, all 5 figures) failed on Roger and Lukas. Diagnosis: the Test
Lab's hand-rolled `buildExpectedCharacters` passed raw richDescription with the MODERN wardrobe baked
in ("gray hooded sweatshirt") on a medieval-costume page, so the SoM identity step (Gemini Flash,
letter badges, matches BY CLOTHING) tagged occluded Roger UNKNOWN; his variant then silently fell back
to a stale generation-time box that sat on another figure and the repair whited out the wrong person.
Lukas had faceBbox:null and the face repair silently downgraded to a whole-body whiteout with no pose
reference — Qwen re-imagined a studio catalogue shot. Production had already solved the clothing
problem (`buildExpectedCharactersForBbox` overrides Wearing: with resolved per-page clothing) — the
lab had drifted from it. Principle (user-set): **the Test Lab only assembles stored inputs; every
piece of pipeline logic must be an import from production. A parallel implementation is allowed only
when it IS the thing under test.**
**Decision (fix package, all local):**
1. testlab `buildExpectedCharacters` → thin wrapper over production `buildExpectedCharactersForBbox`
   (costume resolution, age-strip, VB-id skip, gdinoPrompt). Positions: sceneMetadata →
   extractSceneMetadata(prose) → outlineExtract characters (position incl. action).
2. SoM prompt (production `_somIdentifyFigures`): per-character "Expected position/action" hint from
   the scene plan ("center-right background being led away") — often the only usable cue for occluded
   figures. Hint only; identity cues stay primary (repairs sometimes run BECAUSE a figure is misplaced).
3. Chained fresh detection is AUTHORITATIVE in `resolveCharacterBox`: character missing → loud error,
   never the stored generation-time box (older, worse detector; mislabeled boxes repaint the wrong person).
4. Face repair with no faceBox: `recoverFaceBox` (new, images.js) crops the KNOWN body box, upscales,
   re-runs the GDINO 'face' prompt on the crop (small faces detect reliably zoomed), maps back to page
   coords. Still nothing → loud failure. NEVER a silent body-whiteout downgrade.
5. Lab eval stages prepend the production CHARACTER CLOTHING REFERENCE header (extracted as
   `buildEvalClothingHeader`) — raw-description evals scored systematically harsher than production
   and biased every A/B.
6. Lab char_repair passes production-parity inputs: clothing-scoped styled avatar
   (getStyledAvatarForClothing), resolved clothingDescription (clothingRequirements canonical),
   protectedFaces/protectedBodies for other named figures, sceneDescription, textPosition.
7. VB page-grid refs extracted to shared `buildPageCompositeRefs` (plate → drop vehicles/locations/
   landmarks; else drop locations) — used by the iterate path AND the lab image stage; regeneration.js
   + coverIterate.js still carry inline copies (follow-up).
8. samUnionBlend SAM round 2: same box padded 4% + interior seed points sampled from round 1's mask
   (erode, widest-run centers at 25/50/75% height) — the original box on a changed image can straddle
   background and SAM latched onto a mountain. NO re-run of DINO on the new image (it would chase a
   moved figure we must reject anyway).
**Deliberate parallel path (explicit decision):** the lab's engine-agnostic samUnionBlend replaces
production's composite for char_repair outputs — intentional while the union blend is the candidate
production blend; revisit when the production port lands.
**Touched:** `server/lib/images.js` (_somIdentifyFigures, recoverFaceBox, buildEvalClothingHeader,
buildPageCompositeRefs, exports), `server/lib/testlab.js` (buildExpectedCharacters, resolveCharacterBox,
runQwenInsertStage face gate, runCharRepairStage parity, evalSceneDescription, samUnionBlend round 2).
**Status:** local only — push freeze in effect (story in flight).

## Qwen face-repair blend — full architecture (2026-07-19/20)
**Context:** Wiring Qwen-Image-Edit face repair into the Test Lab blend surfaced a
long chain of edge-case failures on the hardest figure (Verena — profile, occluded,
silver hair, in a crowd). This entry records the SETTLED architecture and the
approaches rejected along the way, so none of it gets re-litigated.

### 1. Detection (WHERE is the figure)
- **Round 1 (original page):** the normal GroundingDINO → MobileSAM → Set-of-Mark
  identity chain, run ONCE on the full page. Gives each character a body box +
  face box. (DINO answers WHERE, Gemini SoM answers WHO — see "DINO goes generic".)
- **Round 2 (the repainted result):** RE-DETECT on the FULL PAGE, not the cutout.
  Composite Qwen's crop output back into the page, run DINO 'person' on the whole
  image, pick the person box whose area CONTAINS the target face-box centre, map it
  to crop coords. **Rejected:** DINO on the bare cutout — the cutout spans neighbours
  and DINO grabbed the biggest (the monk, not Verena) → SAM masked the wrong person →
  IoU 0% (exp #129). **Rejected:** "pick the largest person" fallback — same failure.
  If no person contains the face, keep the round-1 (copied) box rather than guess.

### 2. Head mask — "face merging" (figure ∩ face box)
- The head mask is **SAM(whole figure from the body box) ∩ the face box** — NOT a
  face-region segmentation. SAM segments a whole figure from its body box reliably;
  segmenting a profile/occluded FACE from a box+dots is fragile and over-segments
  (exp #123/#124: loose blob on the original, a balloon on the repaint, from the
  SAME prompt — SAM is cliff-edge sensitive to what sits under the prompt).
- Done for BOTH round 1 (original crop) and round 2 (candidate crop). The two head
  silhouettes are UNIONED (`max`) — every pixel in either is taken from the new
  image. IoU gate rejects a union whose masks barely overlap (figure moved).
- **Rejected:** face box + face dot + hair dot + hair box, unioned. A positive hair
  dot that lands in the background above the head makes SAM flood the whole
  background (exp #122: 11.9×/107× balloon). Dot placement tuning (raw-face anchor,
  hair-box-centre-nudged-to-face) helped but never made it robust — figure∩facebox
  replaced it entirely. The dot code remains only on the separate Grok blended path.

### 3. Colour correction (three parts, split by the MASK not brightness)
Qwen shifts the repainted figure's colour (measured: skin ΔL +14..+22, Δb +7..+16 —
lighten + warm). Classify figure vs background by the SAM MASK, never brightness
(Qwen lightens BOTH the background AND the face, so a luminance threshold
misclassifies lightened face as background — rejected, exp #127).
- **FACE (the new-figure mask + a 3px edge ring):** a UNIFORM mean shift — one
  constant LAB offset (mean original head − mean new head) applied to every face
  pixel, moving the tone toward the scene in ONE direction with no per-pixel
  distortion. **Rejected:** per-channel LAB histogram matching — it reshapes each
  channel's distribution and distorts the face; and **rejected:** the harmonic
  seam-close diffusing its border offset INTO the face interior (it altered the
  face — the face must not be touched by the border blend).
- **6px margin + red zone** (padded union minus the figure+edge — old figure was
  here but the new isn't, plus Qwen's light glow at the edge): a harmonic
  (Laplace) BACKGROUND fill — diffuse the real scene background from just outside
  the union INWARD through these pixels, STOPPING at the figure (the figure is
  excluded as a source). So the transition reveals correctly-coloured background,
  whatever its colour. The 3px ring protects the figure edge the margin exists to
  recapture (SAM masks can clip the figure edge). **Rejected:** blanket-filling the
  whole margin (erodes the figure edge), and near-white-only exclusion (only catches
  a WHITE fringe, keeps the old-figure edge).

### 4. Gates (fail safe, never ship a bad composite)
IoU < 0.55 → figure moved, reject. White-card gate (>22% of the paste near-white) →
Qwen painted the face on a panel, reject. Face repair REQUIRES MobileSAM (no rembg
whole-figure fallback — it whited a church tower). **Rejected:** a pre-clip round-2
mask-size ratio gate — it false-rejected a PERFECT repair whose round-2 SAM merely
over-segmented before the clip bounded it (exp #122).

**Touched:** `server/lib/testlab.js` (samUnionBlend, runQwenInsertStage face path,
fetchFigureHeadMask), `server/lib/images.js` (fetchFigureHeadMaskPng,
detectPersonBoxInCrop, correctColorShift {meanShift, borderMatch},
recoverFaceBox).
**Status:** staging (Test Lab). Production repairCharacterMismatch NOT yet ported.
**Known residual:** a faint light edge halo where the 3px protected ring keeps a
sliver of Qwen's glow — edge-matting limit, minor.

## VB-id sanitizer substitutes generic nouns — never drops lines (2026-07-19)

**Context:** The initial-page cover of a staging story shipped with an EMPTY
`**SCENE:**` section: the whole cover scene description is ONE line, the outline
declared `holds: ART001` without listing ART001 in `hint.objects` (holds ⊆ objects
is not enforced), `buildCoverSceneFromHint` only resolved ids present in
`hint.objects`, and `sanitizeVbIdsInPrompt` dropped the ENTIRE line containing the
orphan id — deleting every character position from the prompt. Result: shuffled
line-up + missing artifact, three repair rounds chasing "ART001" (Grok painted the
raw id as lettering on invented gadgets), evaluator rejected a CORRECT render
("blue backpack instead of the ART001 object") because it too only knew the id.

**Decision:**
1. `sanitizeVbIdsInPrompt` now substitutes a pool-generic noun for orphan ids
   (ART→object, CHR→person, ANI→animal, LOC→place, VEH→vehicle, CLO→outfit) and
   KEEPS the line. WARN unchanged. Dropping a line is never safe when prose is
   single-line.
2. `buildCoverSceneFromHint` resolves `holds` ids against the full VB pools
   (artifacts/animals/vehicles/clothing), independent of `hint.objects`.
3. `inpaintPage` runs `sanitizeVbIdsInPrompt` on the consolidated edit
   instruction (evals quote raw ids back verbatim).
4. `stripNames` (consolidated-plan safety net) handles bare-apostrophe
   possessives ("Hans'" — previously produced "the character' hands") and falls
   back to an age/gender descriptor instead of the anonymous "the character",
   which lost WHO should receive an object fix.

**Rationale:** an unresolved id must degrade to something harmless ("object"),
never delete layout information; every prompt path that can carry an id must
resolve it before an image model sees it.

**Touched:** `server/lib/storyHelpers.js` (sanitizeVbIdsInPrompt),
`server/lib/coverIterate.js` (buildCoverSceneFromHint),
`server/lib/images.js` (inpaintPage sanitize + stripNames).

## Entity check never reuses pre-step bbox on changed bytes (2026-07-19)

**Context:** figure crops in the character-consistency check misaligned — box of
version A cut from pixels of version B. `buildEvalInputs` had the
`isOriginalImage` guard (only forward `sharedBboxDetection` when
`entry.imageData === orig.imageData`) but sibling `buildEntityCheckData` did not,
so the post-repair round re-check cropped repaired pixels with v0 boxes
(`resolveActiveVersionData` prefers `sharedBboxDetection`, and present figures
suppress the fallback re-detect).

**Decision:** mirror the guard into `buildEntityCheckData`; repaired/iterated
entries carry `sharedBboxDetection: null` and the entity check re-detects on the
current pixels.

**Touched:** `server/lib/images.js` (buildEntityCheckData).

## Test Lab targets covers via negative page numbers (2026-07-19)

**Context:** figure-detection experiments (Gemini vs GroundingDINO/SAM) need to
run on cover images; `loadSceneContext`/`loadActivePageImage` only addressed
`sceneImages` pages.

**Decision:** pageNumber -1/-2/-3 = frontCover/initialPage/backCover (same
convention as refresh-bbox/repair). Cover prose is exposed as
`scene.sceneDescription`; image bytes load from `story_images`
(image_type=coverKey, page_number NULL, active-version meta keyed by coverKey).
`benchmark_scenes.page_number` already accepts negatives.

**Touched:** `server/lib/testlab.js` (COVER_KEY_BY_PAGE, loadSceneContext,
loadActivePageImage).

## Bbox↔bytes pairing invariant — sourceImageFp stamp (2026-07-19)

**Context:** stored figure detections kept being paired with image bytes from a
different version (entity re-check, char repair, refresh-bbox loadOnly, test
lab stored boxes) — box of version A cropping/repairing pixels of version B.
Point guards (isOriginalImage) existed in some siblings and not others.

**Decision:** structural invariant instead of per-site guards.
`detectAllBoundingBoxes` stamps every result with `sourceImageFp` (sha1-16 of
the exact imageData string); `detectionHistory` (the persisted shape) carries
the stamp. One shared predicate `bboxPairsWith(detection, imageData)` is
checked at EVERY consumer that pairs a stored detection with bytes:
enrichWithBoundingBoxes shared reuse, resolveActiveVersionData,
resolveCharBbox (tiers 1+2, callers pass currentImageData), char-repair
stored-box sources (scene bbox + entity-report appearances — appearances are
stamped at creation), refresh-bbox loadOnly, testlab resolveCharacterBox
stored path, entity cover path, final best-version bbox refresh. Mismatch →
the stored box is treated as absent and detection re-runs on the actual
pixels. Legacy detections without a stamp are trusted (fail-open) — they
predate the invariant; every new detection is stamped.

**Rationale:** boxes are only meaningful for the bytes they were computed on;
making the pairing verifiable at the producer kills the whole bug class
instead of patching each consumer as it's discovered.

**Touched:** `server/lib/images.js` (imageFingerprint, bboxPairsWith,
detectAllBoundingBoxes wrapper, detectionHistory, enrichWithBoundingBoxes,
resolveCharBbox + callers, final bbox refresh),
`server/lib/entityConsistency.js` (resolveActiveVersionData, appearance
stamping, cover path), `server/routes/regeneration.js` (char-repair sources,
refresh-bbox loadOnly), `server/lib/testlab.js` (resolveCharacterBox).

## Clothing backstop + EXPRESSIONS tail anchor (2026-07-19)

**Context:** Sonnet's scene prose is the only carrier of per-character clothing
(deliberate: no separate clothing block, "trust the prose"). On a staging story
it dropped the main character's outfit — in the unified pass AND both iterate
re-expansions. The image model then dressed her from her reference card
(coral-pink top + red rucksack = her CANONICAL clothingRequirements wardrobe),
and the evaluator — which judges clothing against the prompt — had no contract,
invented one ("no backpack"), and flagged the correct render for four repair
rounds. Separately: the unified spec's per-character `expression` field
("alarmed, mouth open, brows tight") was absent from the iterate templates'
metadata spec, and nothing re-anchored expressions at the prompt tail, so Grok
rendered default pleasant smiles on a stubborn-refusal page 3/4 times.

**Decision:**
1. buildImagePrompt backstop: when <2 of a character's wardrobe terms appear
   in the prose, append "X wears: <clothingRequirements description>" for just
   that character (complete prose ⇒ no duplication). Fixes generation AND
   gives the eval the correct contract in one move.
2. EXPRESSIONS tail block: buildExactPosesBlock now also emits per-character
   `expression` lines (foreground/midground only) after EXACT POSES — same
   tail-weighting rationale as poses.
3. scene-iteration.txt + scene-iteration-free.txt metadata specs now require
   `expression` for fg/mg characters (matching story-unified.txt). `depth`
   stays background-only per the existing rule.

**Touched:** `server/lib/storyHelpers.js` (buildImagePrompt clothing backstop,
buildExactPosesBlock expressions), `prompts/scene-iteration.txt`,
`prompts/scene-iteration-free.txt`.

## Avatars carry garments only — no carried accessories (2026-07-19)

**Context:** a demo character's uploaded photo showed a red rucksack; avatar
generation copied it into the standard avatar, the face-match eval's clothing
extraction wrote it into the wardrobe description, the outline copied it into
clothingRequirements — and the character wore a backpack in every scene,
including at the dinner table. Test Lab A/B/C (exps 146/147/149) proved the
sheet generator follows the TEXT description: stripping the accessory clause
alone produced a fully clean sheet; the reference photo's backpack does not
leak through on its own.

**Decision:** fix at the root (avatar creation) only — no code-side filter:
1. avatar-main-prompt.txt: never include carried items (backpack, bag,
   umbrella, toys), even if the input photo shows one.
2. avatar-evaluation.txt clothing extraction: describe garments only; omit
   carried/strapped-on accessories from the description.
Existing characters keep the accessory in their stored avatars.clothing until
their avatars are regenerated — accepted; regenerate on demand.

**Touched:** `prompts/avatar-main-prompt.txt`, `prompts/avatar-evaluation.txt`,
`server/lib/testlab.js` (avatar_realistic params.costumeDescription for the A/B).

## Detection SAM mask is computed once, shared by eval + repair (2026-07-21)

**Context:** GroundingDINO→MobileSAM detection already segments a
page-resolution silhouette per figure (rides on the detection result as the
non-enumerable `_gdinoMasks`, index-aligned with `figures[]`, deliberately never
persisted to `stories.data` to avoid JSONB bloat). But the two downstream
consumers ignored it: the character eval cropped each figure by its `bodyBox`
RECTANGLE (so the Gemini consistency evaluator saw neighbours + background inside
the crop), and character repair re-ran SAM (`/figure-mask`) from scratch to build
its blend gate on the same pixels detection had just segmented.

**Decision:** consumers READ the mask that already exists; recompute SAM only
where it is genuinely unreachable.
1. Eval: `collectEntityAppearances` attaches `_gdinoMasks[figIdx]` to the
   appearance (non-enumerable, like the source); `extractCropFromImage` gates the
   page pixels to the silhouette (`dest-in`) before cropping and flattens the
   crop onto white → the evaluator sees the figure isolated.
2. Repair: `resolveCharBbox` Tier 2 (already byte-guarded by `bboxPairsWith`)
   returns the figure's `bodyMask`; the blended silhouette gate reuses it for the
   ORIGINAL-figure mask instead of a fresh `/figure-mask` call.
3. Test Lab bbox stage surfaces `samApplied`/`maskVerdict` per figure.

**Deliberately partial / by design:**
- Masks are in-process only → reuse works within the generation job; reloaded-
  from-DB detections and old versions have no mask → eval falls back to the
  rectangle, repair to a fresh SAM call. Unavoidable data-availability fallback.
- Repair still runs SAM ONCE on Grok's OUTPUT figure (those pixels did not exist
  at detection time) and for face-mode head masks (`fetchFaceHeadMaskPng`). Only
  the first, body-mode, original-figure SAM call is eliminated.

**Touched:** `server/lib/entityConsistency.js` (appearance mask attach,
`extractCropFromImage` cutout), `server/lib/images.js` (`resolveCharBbox`
`bodyMask`, `executeCharFixAction` thread, silhouette-gate reuse in
`repairCharacterMismatchWithGrok`), `server/lib/testlab.js` (bbox verdict fields).

## AI-image failure-mode catalogue documented, mitigations deferred (2026-07-21)

**Context:** recurring physically implausible renders (slack ropes under
tension, cage bars in front of one limb and behind another, ascending stairs
substituted for descending). Internet research found no single canonical
taxonomy; PhyBench + forensic checklists + practitioner lists were synthesized
into `docs/image-failure-modes.md` (10 failure classes + mitigation playbook).

**Decision:** documentation only for now — NO hazard-list prompt rules and NO
new eval checks yet. When picked up: hazard list in scene expansion + matching
eval checks + Test Lab scene_variant validation, per the playbook in the doc.

**Touched:** `docs/image-failure-modes.md` (new), this entry.

## Character-repair merge — 5 methods → 3 axes, one gated spine (2026-07-26)

**Context:** character repair had five divergent paths — `grok_face_insert`,
`grok_blended` (face/body), `grok_cutout`, `grok_inpaint` (fullScene) and
`grok_blackout`, plus an ungated Gemini full-scene repaint. Only two
(face-insert + Test Lab's qwen insert) routed through the shared blend engine
`samUnionBlend` and its strong gates; the others each carried a private inline
blend and a partial gate set (sharpness on 2, leak-ratio on 1, none on the
blackout/Gemini verbatim paths). "Gate on one path, not the sibling" bugs
recurred, and the Test Lab re-blended prod output post-hoc so the lab never saw
what prod shipped.

**Decision:** collapse all paths into ONE unified spine
`server/lib/faceRepair.js` → `repairCharacterFace(scene, avatar, opts)` with
three axes — `regionSource` (box|cutout) · `treatment` (blur|crosshatch|whiteout)
· `model` (grok|qwen|gemini) — plus `faceOnly` and `requireMobilesam`. EVERY
combination now routes through `samUnionBlend` and faces the SAME gates
(style-match, IoU, white-card, coverage, requireMobilesam, sharpness), all
default ON and Test-Lab-tunable via `opts.gates.*`. The old `method` strings
are replaced by a stable descriptor `grok:cutout:whiteout:face`.

**Rationale / accepted tradeoff:** routing the legacy body blur/crosshatch
paths through `samUnionBlend` subjects them to the IoU (0.55) + white-card
(0.22) gates they never faced. Body repaints that legitimately shift the figure
may now be REJECTED (return null → "kept original") instead of shipping a
possibly-misaligned blend. This is more correct but a visible change; the gate
thresholds are `opts.gates`-tunable and must be calibrated on a staging Test Lab
A/B before this reaches prod defaults. `grok_blackout` and the ungated Gemini
repaint (the two no-gate verbatim paths) are deprecated — both now flow through
the gated crosshatch/spine.

**Known non-critical difference for the A/B:** the body path no longer reuses
the detection-time SAM `bodyMask` (`detectionBodyMask`) — the spine re-segments,
costing one extra `/figure-mask` call per body repair. Correctness unchanged.

**Touched:** `server/lib/faceRepair.js` (new spine + resolveRepairAxes /
legacyFlagsToAxes / applyGeometryGuards), `server/lib/samBlend.js` (tunable gate
params), `server/lib/images.js` (repairCharacterMismatchWithGrok → ~55-line
adapter, grokFaceInsertRepair + 4 inline branches + Gemini branch deleted,
executeCharFixAction axes), `server/lib/testlab.js` (runCharRepairStage → spine,
post-hoc re-blend deleted), `server/lib/repairLogic.js` (decideRepairMethod
emits repairParams), `server/routes/regeneration.js` (manual route axes),
`tests/manual/faceRepair-geometry.test.js` (new, 29 assertions),
`docs/face-repair-merge-design.md` (status).

## Face repair: colour matching ON by default, keyed by clip continuation (2026-07-29)

**Context:** the spine refactor defaulted `colorCorrect = !faceOnly`, which quietly
left the FACE path feather-only in BOTH production and the Test Lab. That leaves the
one colour defect that reads as a seam unfixed: the crop's bottom clip always cuts
through material that continues into the untouched body (a coat collar, or the neck's
own skin), and when the model's shade there differs from the body's, a visible colour
LINE appears at the seam. Feathering fixes geometry, not a tone step.

**Decision:** default `colorCorrect = true` for BOTH paths (face and body). The blend's
`garmentOnly` (default true) makes this safe and general: it tone-matches ONLY a material
that has a same-material border just OUTSIDE the paste — i.e. one that continues into the
body, giving a reference to match to. One rule, all three clip contents:
- **only clothing** → coat matched to the body coat;
- **clothing + skin** → both matched;
- **only skin** (clip cuts the neck) → neck skin matched to the body's neck; the face
  shifts with it as one uniform tone (correct — face and neck are the same skin; a benign
  mean shift, not a per-pixel distortion).
Materials with no continuation outside the patch (hair; the face when the clip is all
clothing) get ZERO shift and keep the model's rendering — identity is never repainted.
`bgBorderMatch` (default true) colour-matches the background pixels the paste introduces
— the red zone (old face wider than the new) and the 6px safety pad around the cut — to
the surrounding scene, so no halo. Body path is unchanged in effect (bodyColorMode still
true → figure histogram correction stays off, bg protection stays on).

`opts.colorCorrect` / `opts.garmentOnly` / `opts.bgBorderMatch` still override (Test Lab
A/B); only the default moved.

**Rejected:** correcting figure tone unconditionally (would repaint the face for no reason
in the only-clothing / clothing+skin cases).

**Known residual to eyeball on staging:** the only-skin clip case — K-means can split
lit/shadowed skin into separate clusters and shift only the one that meets the neck; the
soft colour-weighted blend smooths it, but check that case visually.

**Touched:** `server/lib/faceRepair.js` (colorCorrect default + garmentOnly/bgBorderMatch
passthrough + colorInfo in log/return).

**Follow-up cleanup (same day):** with colour matching now the single live path, the
dead branches were removed and the giant blend split (net −80 lines):
- `correctColorShift` is now unconditionally material-aware. Deleted the never-reached
  `meanShift` and per-channel histogram-LUT branches, the `_ccMatchLUT` /
  `_ccQuant` / `_ccBinCenter` / `_CC_RANGES` helpers, the `srcHist`/`refHist`
  accumulation, the `below threshold` early-return, and the `borderMatch` harmonic
  seam-close (`_closeSeamHarmonic`) — the sole caller always passed
  `colorAware:true, borderMatch:false`, so all of it was unreachable. Provably
  behaviour-preserving.
- The inline ~55-line background-matching block in `samUnionBlend` was extracted verbatim
  into a named `matchIntroducedBackground` helper (same file). NOT merged with the figure
  correction — they're distinct: the figure path clusters background only to EXCLUDE it
  (protect the garment match), this path clusters background to CORRECT introduced pixels.
  Pure extraction, behaviour identical.
**Cleanup touched:** `server/lib/images.js` (correctColorShift + dead helpers),
`server/lib/samBlend.js` (matchIntroducedBackground extraction).

## Multi-judge eval: bucket taxonomy + median jury + per-style stats (2026-07-30)

**Context:** the same image scored differently on repeated evals (a repair decision
could flip on noise). Root cause is not config — even at temperature 0 a hosted
API is non-deterministic (dynamic-batch reduction order), and a holistic 0-100
pointwise score is the noisiest judge design. Also, a single free-form `type` per
issue couldn't be aggregated, so "what goes wrong per style/genre" was unanswerable.

**Decision (all behind config, default-off — zero prod change until enabled):**
1. **Closed bucket taxonomy** (`server/lib/evalBuckets.js`): every issue maps to a
   fixed bucket (owner eval + repair route). Adds the missing `action_interaction`
   bucket (rope slack under tension, aim at wrong target, travel/facing away from a
   NAMED target) — added to `image-semantic.txt`. Unknown `type` → `other` (tracked).
2. **3-judge jury** (`server/lib/evalJudges.js`): Gemini (primary) + Grok
   (`grok-4-fast`) + Qwen (`qwen-vl` via OpenRouter), run on the SAME parts, gated by
   `EVAL_JUDGES` (default `gemini`). Merge = **pure median severity per bucket**;
   critical treated like any severity ([crit,major,major]→major, [crit,none,none]→
   dropped); median over {present,0} = 2-of-3 majority for binary buckets for free.
   Per-bucket agreement is kept as a confidence signal (low agreement = route to an
   extra pass). Judges that error / lack a key are skipped, never throw.
3. Merged buckets → `bucketsToIssues` → existing `scoring.js` (score math stays
   single-source). Wired into `evaluateImageQuality` before scoring.
4. **`eval_findings` table** + `recordEvalFindings`/`getEvalFindingsStats` +
   `scripts/admin/eval-findings-stats.js` — best-effort per-page bucket rows for
   `GROUP BY art_style|genre|…`. Records in single- AND multi-judge mode (needs
   `evalOptions.storyMeta`; `evaluateImageBatch` threads it — art_style flows now,
   storyId/genre/language populate once the batch caller passes them).

**Rejected:** the earlier plan's "lone CATASTROPHIC escalation" — owner chose pure
median for all severities (accepts a rare 1-of-3 real miss for far fewer false
alarms). Item "retire Gemini eval-bbox": already satisfied — detection is
DINO-first with Gemini as the cold-start fallback; the eval prompt emits typed
issues, not boxes.

**CALIBRATION CAVEAT:** bucketing de-duplicates (one severity per bucket vs summing
many issues) → changes score magnitude when the jury is on. The redo threshold MUST
be A/B-calibrated in the Test Lab before `EVAL_JUDGES` >1 drives prod decisions.

**Touched:** `server/lib/evalBuckets.js` (new), `server/lib/evalJudges.js` (new),
`server/lib/images.js` (jury merge + stats record in evaluateImageQuality;
evaluateImageBatch storyMeta), `prompts/image-semantic.txt` (action_interaction),
`server/services/database.js` (eval_findings table + funcs),
`scripts/admin/eval-findings-stats.js` (new), `tests/manual/evalBuckets.test.js` (new).

## Two rescue-path utility calls downgraded off Sonnet (2026-07-26)
**Context:** `sceneValidator.repairScene` (JSON scene-repair after a composition
check) and `rewriteBlockedScene` (safety rewrite of a scene the image model
refused) both called `callTextModel(..., null, ...)`, defaulting to the global
`claude-sonnet`. Neither writes story prose — one emits a small structured JSON
patch, the other paraphrases one scene sentence to dodge a safety filter. Sonnet
was overkill for both, and they sit on rescue paths that can fire several times
per story.
**Decision:** Route both through named, env-overridable config keys
(`MODEL_DEFAULTS.sceneValidationRepair`, `MODEL_DEFAULTS.sceneRewrite`) resolved
via `resolveSceneValidationModel()` / `resolveSceneRewriteModel()` (guardModel),
defaulting to **`qwen3-max`**. Passed as the explicit `modelOverride` arg so the
choice is visible at the call site, not a global default flip.
**Correction (same day):** first shipped these on `gemini-2.5-flash`; owner
corrected — "those have spatial reasoning, they probably need qwen max."
`scene_validation` repairs a scene DESCRIPTION from composition issues (left/right,
counts, who's where) — genuine spatial/compositional TEXT reasoning that
gemini-flash handles poorly. Moved to `qwen3-max`, the codebase's already-trusted
spatial reasoner (also `complianceModel`), newer AND cheaper than `qwen-max`
($0.78/$3.9 vs $1.6/$6.4) and still ~4× cheaper than Sonnet. `scene_rewrite` is
the lighter of the two (a safety paraphrase) but kept on the same model for
consistency; it's still cheap.
**Rationale:** qwen3-max reasons about spatial corrections far better than
gemini-flash while remaining well under Sonnet's cost — satisfying Pt 9's cost
intent without sacrificing the reasoning these rescue paths need. `guardModel`
falls back to `claude-sonnet` (NOT a weak model) when `OPENROUTER_API_KEY` is
unset, so a missing key degrades UP to the strong original, never down. All three
providers (anthropic/google/openrouter) handle the JSON `prefill: '{'` both
callers use — OpenRouter seeds an assistant turn + prepends. Env overrides
(`SCENE_VALIDATION_MODEL`, `SCENE_REWRITE_MODEL`) allow a no-deploy flip. Story
prose stages (idea/outline/storyText/sceneDescription) untouched — stay on Sonnet.
**Touched:** `server/config/models.js` (two keys + two resolvers),
`server/lib/sceneValidator.js` (resolveSceneValidationModel),
`server/lib/images.js` (resolveSceneRewriteModel).
**Status:** ✅ active

## Test Lab text-only harness — skipImages jobs complete, cross-model judge, 5 text criteria (2026-07-26)
**Context:** We want to iterate on story TEXT and run an outline single-vs-split A/B without paying
for image generation. A text-only pipeline already existed (`inputData.skipImages === true`), but
(a) the `skipImages` early-return in `processUnifiedStoryJob` only updated `progress` — it never
wrote `result_data` or set `status='completed'` (the normal completion write sits AFTER the
early-return), so text-only jobs hung at `status='processing'` until the status-poll watchdog killed
them as "stopped responding". This also broke the wizard's dev "text-only" button, which polls for
`completed`. And (b) there was no way to score the resulting text.
**Decision:**
1. **skipImages jobs now complete.** The branch writes a lightweight `result_data`
   (`title` + `pages[].text` + `pages[].sceneDescription`, no image bytes — there are none) and sets
   `status='completed'` via the SAME guarded write the normal path uses
   (`... WHERE id=$ AND status='processing' RETURNING id`), so a watchdog/cancel that already flipped
   the job isn't resurrected.
2. **Cross-model judge, default `gemini-2.5-flash`.** Story text is written by Claude; judging it
   with Claude would be self-grading (a model favours its own style). The judge defaults to a
   different provider (Gemini), overridable via `opts.judgeModel` / request body / `TEXT_JUDGE_MODEL`
   env. Robust JSON parse (regex-extract, validate each criterion ∈ [1,5], recompute `overall`
   server-side rather than trust the model's arithmetic).
3. **Five text-only criteria, picturability DELIBERATELY EXCLUDED.** coherence, ageAppropriateness,
   characterConsistency, emotionalArc, languageQuality. The owner was explicit: evaluate ONLY the
   text — do not add an "is this illustratable / visual" criterion, since the harness exists to judge
   writing in isolation from illustration.
4. **Two separate endpoints** (`/rerun-text` generates, `/judge-text` scores) so a slow judge never
   blocks generation and text can be re-judged without regenerating. `/rerun-text` accepts an
   `inputOverrides` shallow-merge object — the seam for the future outline A/B (swap a prompt-variant
   flag with no new endpoint).
**Rationale:** Root-cause fix (persist + complete) rather than a special-case status hack; the fix
also repairs the pre-existing wizard text-only path. Cross-model judging avoids self-grading bias at
near-zero cost (Gemini flash). Endpoint split keeps each unit cheap and idempotent-ish (re-judge is
free, reruns are explicit).
**Touched:** `server.js` (skipImages branch: persist result_data + complete),
`server/lib/textQualityJudge.js` (new judge lib), `prompts/story-text-quality-judge.txt` (new judge
prompt), `server/services/prompts.js` (register template key),
`server/routes/admin/jobs.js` (new `/rerun-text` + `/judge-text` endpoints, `initJobsRoutes` deps),
`server/routes/admin.js` (thread `processStoryJob` into jobs submodule),
`tests/manual/test-text-quality-judge.js` (unit test), `docs/codebase-guide.md`.
**Status:** ✅ local (worktree branch `testlab-textonly-harness`) — pending staging validation with a
live judge call + a real rerun.

---

## Pt 10 — separate STYLE-repair path, Gemini-vs-Grok A/B in the Test Lab (2026-07-26)
**Context:** The final style-consistency check "isn't working" (roadmap Pt 10). Three findings, verified:
(1A) `runFinalConsistencyChecks` (images.js) + `evaluateTextConsistency` (textModels.js) were imported
in server.js but **never called** — dead since import. (1B) The style audit that DOES run,
`checkStoryStyleConsistency` (styleConsistency.js, repair Step 5), is **detection-only** — it returns a
categorical verdict + `outliers[]` and nothing repaints them, so a page that flips art style is flagged
then shipped. (1C) `checkStyleMatch` (images.js) is a hard style gate ONLY in the Test Lab; no production
repair path calls it.
**Decision:**
1. **New dedicated style-repair path** `server/lib/styleRepair.js` — `repairPageStyle(pageImage,
   targetStyleRef, opts)` repaints a style-outlier page TOWARD the dominant cluster (style transfer,
   content/composition/characters preserved). It is **model-parameterized** (`opts.model` ∈
   {`gemini`,`grok`}) for the A/B. Dispatch REUSES the shared production edit dispatcher
   `editImageWithPrompt` (images.js) — model id `gemini-2.5-flash-image` routes to the Gemini edit path,
   `grok-imagine` to `editWithGrok`; no hand-rolled provider call, and Grok's input-aspect coercion is
   handled by editImageWithPrompt as usual. A deterministic `planStyleRepair(detection, storyData)` picks
   targets from the EXISTING `checkStoryStyleConsistency` output (reused, not re-detected). The path gates
   its OWN output with `checkStyleMatch` (before/after same-style scores + `passedGate`).
2. **Test Lab stage `style_repair`** (STORY_STAGES, target `{storyId}`): detect → plan → repaint each
   outlier with BOTH gemini and grok → surface side-by-side with style-match scores so a human picks the
   winning model. This is the A/B.
3. **[SUPERSEDED 2026-07-31 — see "Style-repair wired into production" entry below: the deferred hook is now LIVE, flag-gated, pages AND covers.]** **Test-Lab-FIRST — production wiring DEFERRED.** Nothing in the production auto-repair pipeline
   (`processUnifiedStoryJob` / repair round loop) calls `repairPageStyle`. The eventual hook point is the
   post-repair finalize, right after the Step-5 `checkStoryStyleConsistency` audit in
   `server/lib/images.js` (`runUnifiedRepairPipeline`, the styleConsistency Step-5 block at
   `checkStoryStyleConsistency(styleInput)`, ~line 8993 — marked with a `// PRODUCTION WIRING: deferred`
   comment) — where `styleConsistency.outliers` is produced but currently only surfaced for manual
   repair. A future decision (once the Lab A/B picks a model) turns that into `planStyleRepair(styleConsistency,
   styleInput)` → `repairPageStyle(model=<winner>)` per outlier → re-pick `finalBestPerPage`. Kept out now
   for low blast radius.
4. **Dead-code cleanup (Pt 10 1A).** Exhaustive grep confirmed zero call sites for `runFinalConsistencyChecks`
   and `evaluateTextConsistency` (+ their private helper chain `evaluateConsistencyAcrossImages` /
   `evaluateSingleBatch`, reachable only from the dead root). **Removed:** both server.js imports; the whole
   dead chain in images.js (−534 lines) + its two exports; `evaluateTextConsistency` in textModels.js + its
   export; the two now-orphaned prompt templates `final-consistency-check.txt` + `text-consistency-check.txt`
   and their `prompts.js` keys. `checkStoryStyleConsistency` and `checkStyleMatch` are LIVE and were NOT
   touched. `evaluateIncrementalConsistency` (live, called from the eval pipeline) was preserved.
**Rationale:** Owner decision 2026-07-25 ("create a separate style-repair path A/B-tested in the Lab with
Gemini and Grok"). Test-Lab-first keeps a behavior-changing image path out of production until the A/B
picks a model. Reuses the one shared edit dispatcher (no parallel provider code). Style descriptor is
generic (no story specifics). Deleting the confirmed-dead final-consistency code removes the "wired but
never fires" trap the roadmap named.
**A/B caveat (staging):** `editImageWithPrompt`'s grok arm silently falls back to Gemini on a Grok
failure/moderation block; a contaminated grok arm would show a Gemini-rendered result. The Test Lab log
capture surfaces the "falling back to Gemini" line so a reviewer can spot it — the stage does not
otherwise detect the fallback.
**Touched:** `server/lib/styleRepair.js` (new), `server/lib/testlab.js` (new `runStyleRepairStage` +
STORY_STAGES registration), `server/routes/admin/testlab.js` (story-level redo dispatch),
`server/lib/images.js` (−dead chain + exports), `server/lib/textModels.js` (−evaluateTextConsistency + export),
`server.js` (−2 dead imports), `server/services/prompts.js` (−2 dead template keys),
`prompts/final-consistency-check.txt` + `prompts/text-consistency-check.txt` (deleted),
`server/lib/issueExtractor.js` + `server/lib/gridBasedRepair.js` (stale JSDoc updated),
`tests/manual/test-style-repair.js` (unit test), `docs/image-routing.md`,
`docs/image-generation-methods.html`, `docs/prompt-inventory.md`.
**Status:** ✅ local (branch `pt10-style-repair-lab`) — unit-verified; PENDING staging Test Lab run of the
`style_repair` stage on a story with a known style outlier (live Gemini+Grok repaint + style-match gate).

## images.js dispatch de-dup — 3 shared helpers, entry functions left separate (2026-07-26)
**Context:** `server/lib/images.js` is the hottest path in the codebase (every page/cover/avatar
image flows through it) and has TWO large image-gen entry functions — `callGeminiAPIForImage`
(gen + eval, 17 positional params) and `generateImageOnly` (gen-only, options object, separate
`genonly_` cache namespace) — that dispatch to Grok/Gemini/Runware with duplicated inner logic.
Roadmap "images.js cluster" flagged 4 duplications (#1 gen-entry, #2 truncation, #3/#4 aspect,
#7 mask-fetcher). Cannot be runtime-tested here (no live API; native `sharp` absent), so the bar
was byte-faithful behavior-preserving extraction, not a rewrite.
**Decision:** Extract the DUPLICATED INNER LOGIC into pure shared helpers both entry functions
call; do NOT force-merge the two public entry functions (genuinely different responsibilities +
signatures). Three helpers added, all exported for unit testing:
- **`resolveOutputAspect(evaluationType, aspectRatioOverride)`** (#3/#4) — replaced 3 identical
  copies inside `callGeminiAPIForImage`. Returns the same string for every input combo.
- **`truncatePromptForModel(prompt, max, logLabel, modelName?)`** (#2) — unified 4 hand-rolled
  prompt-cap blocks (Grok + Gemini paths × both entry functions). Optional `modelName` reproduces
  the `for <model>` suffix that 3 sites logged and the gen-only Gemini site omitted; the
  Gemini-path `parts[0]` side effect stays at the call site via `result !== prompt`.
- **`extractDataImageUrls(characterPhotos)`** (#1) — unified 5 copies of the
  characterPhotos→data:image filter (4 Runware branches + the Grok avatar branch).
**Deliberately left separate (documented, not merged):**
- The two entry functions' bodies past the shared filters — eval vs gen-only, `genonly_` cache
  namespace, `padInputWithExtension`/`textAreaMask` packing, and return shapes genuinely differ.
- `generateImageOnly`'s aspect default (`CONFIG_DEFAULTS.pageAspect`, no evaluationType branch) and
  `editImageWithPrompt`'s (`measuredAspect || override || pageAspect`) — different expressions, not
  the resolveOutputAspect shape.
- The per-site truncation `max` (Grok 7500 vs Gemini/Runware 30000) — computed by each caller.
- **#7 mask-fetcher:** already centralized — the repair path routes through one injected
  `fetchFigureMaskPng`; the only other `/figure-mask` POST (`_mobilesamMaskFull`) is the detection
  path with a different contract (returns a binarized mask object, body `{image, box}` only, no
  rembg fallback). No merge; only the truly-identical plumbing (the base64 data-URI decode) is
  shared in spirit, not worth an indirection across the two differently-shaped callers.
**Rationale:** One implementation to fix instead of 2-5 copies (owner's actual concern), while
keeping blast radius controlled on an untestable hot path. No entry-function signature changed
(all callers align unchanged); helpers are pure and proven equivalent by a source-extraction unit
test (69 assertions, full truth tables + boundary lengths + exact log strings).
**Touched:** `server/lib/images.js` (3 helpers + call-site swaps + exports),
`tests/manual/test-images-dispatch-helpers.js` (new).
**Status:** ✅ local (branch `images-cluster-dedup`) — parse-checked + unit-verified; PENDING
staging smoke test (real Grok/Gemini/Runware page + cover + avatar generation, since no live API here).

## Dead post-repair verifier `verifyRepairImprovement` deleted, not wired (2026-07-26)
**Context:** `entityConsistency.js` carried a self-contained ~230-line cluster —
`verifyRepairImprovement` (a post-repair gate: border/background-stability check
+ a Gemini "is the AFTER crop actually closer to the reference than BEFORE, any
artifacts?" comparison) plus its private helpers `extractBorderRegions`,
`computeImageDifference` and the constants `VERIFICATION_MODEL` /
`MAX_BACKGROUND_DIFF`. It was exported but had ZERO call sites anywhere (verified
by exhaustive grep across server/ + client/) — wired-but-never-fires legacy from
an older repair architecture.
**Decision:** deleted the whole cluster (function + 4 self-contained helpers +
3 exports), rather than wiring it into the production repair path.
**Rationale:** (1) The face-repair merge (see the 5→3 spine entry above) already
enforces strong gates on every repair — IoU, white-card, style-match, coverage,
sharpness — in one shared spine; a second, separate, UNCALIBRATED gate
(`MAX_BACKGROUND_DIFF=30` was never tuned against real repairs) is exactly the
"incomplete gate bolted on the side" pattern we're trying to eliminate. (2)
Keeping dead, exported, uncalibrated gate code around invites a future caller to
wire it blind. (3) It's fully recoverable from git history. If a semantic
"did-the-repair-actually-improve" check is wanted, the correct shape is a
Test-Lab-first A/B stage (like the Pt 10 style-repair path), rebuilt with
calibrated thresholds — not this resurrected as-is.
**Touched:** `server/lib/entityConsistency.js` (−~233 lines: cluster + exports).
**Status:** ✅ active

## Lighting-aware garment HUE normalization runs BEFORE eval (2026-07-30)
**Context:** Clothing colour is specified only as TEXT ("red jacket"); each page's
image model re-interprets it independently, so the same jacket renders red on one
page and orange on another. Today the eval flags the drift and the pipeline does a
FULL figure redraw — hugely expensive for a mere hue shift, and the redraw can
introduce new drift. Owner: "cloth colour across images is not consistent … redraw
all seems expensive just to turn red to orange." Owner also flagged the trap: a red
jacket SHOULD look dim/cool at night and bright/warm at noon — a naive recolor that
forces every page to the avatar's colour would DESTROY legitimate scene lighting.
**Decision:** A new pre-eval pass `normalizeGarmentHue` (`server/lib/garmentHueNormalize.js`)
runs in `processUnifiedStoryJob` Phase 5b-hue — AFTER the shared bbox/SAM detection
(reusing its masks, no re-detect) and BEFORE the quality/semantic/entity SCORING —
so eval scores the already-corrected image and never triggers a redraw for a hue
drift. For each figure with a resolvable styled avatar (matched to THIS page's
clothing category, so a costume-change page uses the right avatar), it corrects the
garment hue toward the avatar's garment colour.
**How it preserves lighting (the crux):** illumination is a GLOBAL cast on the whole
page (sunset warms +a/+b, moonlight cools); intrinsic drift is LOCAL (only the
garment). We estimate the page's global cast (gray-world mean a*/b*), DISCOUNT it
before reading the garment hue, and compare to the avatar's discounted hue. We
correct ONLY the residual hue by ROTATING the (a*,b*) vector of the masked garment
pixels — a 2D rotation about the origin preserves L* (lightness = the lighting) and
chroma magnitude (saturation) EXACTLY; L* is never read or written. So a night
jacket stays night-lit but becomes the right red. A garment that only looks "orange"
because the whole page has a warm cast (same cast on the background) is NOT corrected
(that's global lighting, not drift).
**Gating (always-check, correct-outliers):** run on every figure; NO-OP below a
min hue drift (already correct); SKIP + defer to eval/repair above a max drift
(likely a garment-TYPE error, not a tint) or below a chroma floor (grey/neutral has
no hue); soft Gaussian selection window so only the drifted garment cluster rotates
(other garments/skin/hair/bg untouched). Zero model calls (pure sharp/CPU). Feature-
flagged `MODEL_DEFAULTS.garmentHueNormalize` (default on, env `GARMENT_HUE_NORMALIZE`)
so it flips off on staging without a deploy. Exposed as Test Lab stage `garment_hue`
(per-figure before/after crops + measured drift/cast).
**Rationale:** replaces an expensive, drift-prone full redraw with a free,
deterministic, lighting-preserving hue rotation for the colour-drift case, while
leaving the redraw path intact for garment-TYPE and non-colour issues (the max-drift
skip defers to it).
**Touched:** `server/lib/garmentHueNormalize.js` (new core + orchestration),
`server.js` (Phase 5b-hue), `server/config/models.js` (flag), `server/lib/testlab.js`
(`garment_hue` stage), `tests/manual/garmentHueNormalize.test.js` (24 assertions incl.
lightness-preserved + global-cast-not-corrected).
**Status:** ✅ active — pending a staging Test Lab eyeball that day/night lighting
survives on real pages.

### Full-chain wiring: normalize before EVERY eval, not just the first (2026-07-30)
**Context:** the pass above ran ONCE, in Phase 5b-hue, before the FIRST eval. But
`runUnifiedRepairPipeline` then REDRAWS pages over up to 3 repair rounds
(iterate / char-fix / inpaint), and those redrawn pages were never re-normalized —
so a repaired page could ship with reintroduced garment-colour drift, and a redraw's
own drift could even waste a repair round (the eval flags a hue shift the redraw just
introduced). Owner: "Implement full chain."
**Decision:** extracted a single shared driver `normalizeGarmentHueBatch(images, …)`
in `garmentHueNormalize.js`. Phase 5b-hue (server.js) now CALLS it (behaviour
unchanged — same avatar resolution, same re-stamp of `sharedBboxDetection.sourceImageFp`,
same flag, same logs). The repair loop calls it once per round at the seam AFTER a
round's repaired pages have image+detection but BEFORE `evaluateImageBatch` scores
them — mutating `roundSuccess[].imageData` in place so both the eval and the persisted
version row read the corrected bytes.
**Detection is reused, never forced:** the per-round pass normalizes only repaired
pages that already carry a fresh full-image detection. `iterate` returns one
(`result.bboxDetection`, plumbed onto the roundResult); `inpaint`/`char-fix` do NOT
produce a full-image detection, so those redraws are skipped in the per-round pass.
**Final-catch pass (closes that gap):** after the round loop, at the finalize stage
where `freshBboxMap` has already (re-)detected each picked-best (no extra detect),
a FINAL `normalizeGarmentHueBatch` runs on every REPAIRED page's best version
(`source !== 'original'`) using that detection — so a page whose final version came
from inpaint/char-fix is also corrected. It runs after scoring, like the other
post-repair recovery steps (calm-zone / text overlay), so the shipped bytes carry the
corrected colour. Net: EVERY shipped page's garment hue is normalized regardless of
which method produced it. Same `garmentHueNormalize` flag → flipping it off restores
today's exact behaviour (both the per-round and final passes are additive and guarded).
**Touched:** `server/lib/garmentHueNormalize.js` (`normalizeGarmentHueBatch` shared
driver), `server.js` (Phase 5b-hue refactored to call it), `server/lib/images.js`
(per-round call in `runUnifiedRepairPipeline`; iterate roundResult carries
`bboxDetection`), `tests/manual/garmentHueNormalizeBatch.test.js` (25 assertions:
skip-when-no-detection, resolver wiring, re-stamp-only-on-change, flag, count
aggregation).
**Status:** ✅ active — pending a staging Test Lab smoke of a story that goes through
repair rounds (confirm repaired pages are colour-normalized; flag-off = unchanged).

### The AVATAR side gets no illumination discount (2026-08-06)
**Context:** The first Test Lab measurement of the `garment_hue` stage on real
content (experiments #332/#333, 12 benchmark pages, 52 figures) corrected only
**3** figures, and those 3 were measured in a corrupted colour space. Skip reasons
clustered oddly: 7 "low chroma" on visibly vivid garments, and 9 "drift too large"
all falling in a narrow **141°–166°** band — near-antipodal, which is the signature
of a sign-flipped vector, not of wrong-outfit errors. The same character with the
same avatar measured `32.9°` on one page and `-95°/-102°/-118°` on three others.
**Decision:** Three changes to the deterministic core, plus the matching rule that
they require:
1. The avatar garment hue is read in **absolute LAB space — no cast discount**.
2. The page cast is estimated over the **background** (outside every figure mask),
   falling back to the whole frame when the background is under `minPagePixels`.
3. The sampling mask is the SAM silhouette when present, else the **torso band** of
   the bodyBox (`torsoBoxFromBody`), not the raw rectangle.
4. `sampleGarmentClusters` returns the top-K avatar hues and the page cluster is
   matched to the **nearest** one; the association threshold is `hueDriftMaxDeg`.
**Rationale:** `estimateCast` is an unmasked gray-world mean of a\*/b\*. On a page
that is a defensible illumination proxy — a full scene averages toward neutral. On a
**styled avatar sheet** it is not: the sheet is a tight crop of one figure on a plain
background, so the mean is dominated by the garment being measured. Discounting it
cancels the signal. Measured on a real sheet: a pink top yields cast `(6.9, 3.6)`,
and discounting collapses chroma `27.2 → 6.5` (under `chromaMin` 8 → "low chroma"
skip) and flips the hue `+0.8° → −161.5°` → bogus "drift too large". The avatar sheet
is a neutral-lit reference render; there is no scene illumination on it to remove.
Point 4 is **not optional given 1–3**: a character usually wears two coloured garments
(pink top + blue jeans), and once the page mask is tightened to the torso while the
avatar sheet still sees the whole outfit, dominant-vs-dominant comparison would invent
a ~180° drift and could drive a *wrong* rotation — worse than the inert behaviour it
replaced. Nearest-cluster matching removes the top-vs-trousers ambiguity entirely and
is avatar-sheet-layout-agnostic (1×4 full-body and 2×4 headshot+body grids both work).
**Measured effect** (same 12 pages, Test Lab #350): corrections **3 → 10**, false
"low chroma" **7 → 1** (the survivor is a genuinely grey outfit — grey overalls, correctly
skipped), bogus "drift too large" **9 → 6**. Verified visually: only the garment rotates;
backpack, jeans, skin, hair and background are untouched.
**Known residual:** on crowded pages a few figures still read a hue matching a
*neighbouring* figure's garment, which trips the drift-too-large guard. That is a
figure **detection / name-assignment** issue, not a colour one, and the guard
correctly refuses to rotate on it — do not "fix" it by widening `hueDriftMaxDeg`.
**Touched:** `server/lib/garmentHueNormalize.js` (`normalizeGarmentRaw` cast sources,
`sampleGarmentClusters`, `decideHueCorrection` nearest-cluster match, `torsoBoxFromBody`,
background `castMask` built once per page in `normalizeGarmentHue`),
`tests/manual/garmentHueNormalize.test.js` (TESTs 8–11 regression + CRLF-safe source
slicing), `tests/manual/garmentHueNormalizeBatch.test.js` (env-independent fp contract).
**Status:** ✅ active — committed, **not yet deployed**; Test Lab #350 was run with the
CLI runner against local code + the staging DB, so staging's server still runs the old
behaviour until this is pushed.

### Garment colour match needs a real MASK and a full L\*a\*b\* target (2026-08-06)
**Context:** Owner reported a shirt rendering ORANGE instead of yellow (story
`job_1786024729214_zrjgzqiey` p2, Lily) that garment-hue reported as "below
threshold (3.8°)". Investigating it invalidated two load-bearing assumptions of
the pass. **Validated end-to-end on that page; NOT yet wired into production.**
**Findings, each measured:**
1. **The garment was never identified — only guessed.** The pass samples a
   chroma-weighted hue histogram over a box and takes the modal hue; it never
   decides "this pixel is shirt". `isGarmentPixel` rejects skin and grey but NOT
   hair, so on a red-haired character the sheet's strongest cluster was her HAIR
   (32.6°); the orange shirt matched it at 3.8° and was blessed, while the real
   yellow shirt (106.3°) sat 70° away. Measurement and application shared one
   weak criterion, so neither could be trusted past a gentle nudge.
2. **Colour-space heuristics cannot recover it.** Two hand-rolled connected-region
   segmenters were tried and both failed on the same page: growing from the
   largest region found dark hair merged with shadow (12% of frame, shirt
   untouched), and seeding from the chest failed because her hair covers the
   chest. A washed-out garment's chroma overlaps JPEG chroma noise, so no
   threshold separates them.
3. **A text-prompted detector solves it directly.** GroundingDINO box
   (`"the shirt or top worn by the person"`, score 0.62–0.76, colour-agnostic)
   → MobileSAM mask gives an exact garment silhouette: hair strand over the
   shoulder cut out, arms/skin/table/book excluded, alpha edge free. Measured
   cost **15–40 s per figure** warm (DINO 12–32 s + SAM 3–7 s) plus an 84 s
   one-time model load. The earlier verdict that a large rotation "fundamentally
   cannot" work was a MASK failure, not a colour-space limit.
4. **Hue-only cannot reach yellow.** With the mask, rotating hue alone landed at
   102.9° against a 103.2° target — and still looked wrong, because
   `L*` was pinned at 43.4 while the avatar's yellow is L=70. Yellow is
   intrinsically light: with the avatar's exact a\*/b\*, L=45 is olive
   `rgb(109,111,0)` and L=75 is yellow `rgb(193,189,75)`. A mean L\*a\*b\*
   OFFSET (ΔL +26.6, Δa −39.2, Δb +21.2) inside the mask landed
   `rgb(178,172,63)` vs target `rgb(178,176,62)`, folds and highlights intact.
5. **The mask fixes the DIAGNOSIS too.** Rachel p5 measured 53.1° by the coarse
   sampler (→ 84° drift → "defer to repair") but **165.9°** under the mask, a
   real drift of only −28°. The pass was about to escalate a nearly-correct shirt.
**Decision (shape of the fix, not yet built):** garment mask from DINO+SAM;
target = the avatar garment's full L\*a\*b\* scaled by a scene-lighting factor
estimated from the page (NOT raw avatar L\*, which would flatten night scenes —
on this bright page the factor is ≈1, which is why a straight match looked
right); apply as a mean offset, not a replacement. The 45° drift cap exists only
to bound damage from a bad mask and can be raised once the mask is real.
**Supersedes** the "preserve L\* and chroma absolutely" principle in
`garmentHueNormalize.js` for the masked path — that rule assumed the rendered
lightness was correct lighting, and here the model simply drew a darker garment.
**Touched:** none yet in production. Demonstrated via the local `photo_analyzer`
service (`/detect-figures-text`, `/figure-mask`). Committed so far: the
hair-target guards (`a85dbce2b` — avatar torso band + `minTargetWeightFrac`),
which make the pass DEFER page 2 correctly instead of blessing it.
**Status:** 🟡 conditional — validated on one photorealistic page. GroundingDINO
is photo-trained; confirm a garment prompt on a painterly page before relying on
it for all styles.

### Garment colour drift is reported on its OWN channel, not as an issue (2026-08-06)
**Context:** Lily's top rendered orange instead of yellow on p2. The entity
consistency check DID catch it — grid cell B, "appears orange/yellowish ... the
expected clothing description specifies a 'yellow short-sleeved cotton top'" —
but rated it `minor`, worth 2 points of 100, so it never tripped the redo gate
(`scoring.js`: "minor wobbles shouldn't trip the redo gate"). The same class of
error was rated `major` twice in the SAME report (Rachel white-vs-sage,
Ethan teal-vs-sky-blue), so severity was the only thing that varied. Re-running
the unchanged prompt on the stored grid caught it 12/12 — detection is reliable,
severity is not.
**Decision:** do NOT raise the severity. A garment of the right shape in the
wrong colour now goes in a separate `garmentColourMismatches` array, never in
`issues`, carrying `{garment, expectedColour, observedColour, cells, pagesToFix}`.
It charges no severity points and cannot trigger a redraw.
**Rationale (owner):** bad colour is fixable MECHANICALLY — a masked L\*a\*b\*
match toward the canonical colour — so routing it through the issue path would
regenerate a whole character to change a shirt's hue, which is the expensive
wrong answer and churns everything else in the frame. Wrong garment KIND, cut or
category still belongs in `issues` as `clothing_inconsistent`; a cell can report
one of each. The eval already knows the expected colour from
`clothingRequirements`, so no new grid, no new model call, no DINO pass is
needed for DETECTION — the screening is already running and already free.
**Measured after the change** (stored Lily grid, production config, 5 runs):
colour mismatch on the new channel 5/5, leaked into `issues` 0/5, and the −15
that remains is the genuine shorts defect.
**Open:** the CONSUMER is not built. Nothing yet reads `garmentColourMismatches`
and applies the correction — see the DINO+SAM + full-L\*a\*b\* entry above for
the validated repair shape. Also open: crop extraction returned blank cells for
2 of Lily's 8 grid cells (p3, p7 — a hand and a book, no character) and one of
Rachel's, which produced a spurious `face_mismatch` **critical**.
**Touched:** `prompts/entity-consistency-check.txt` (new output field + a
"Garment Colour" section), `server/lib/entityConsistency.js`
(`evaluateEntityConsistency` parses and logs the channel, keeps it out of
`issues`).
**Status:** ✅ active for reporting — 🟡 no consumer yet.

## Image-first story prompt variant — one call, scenes authored before text (2026-07-30)

**Context:** roadmap §4 (image-first, owner strategic direction) + §5 (outline
prompt A/B). Most image failures originate in text dictating un-picturable
scenes. Owner decided the first experiment: keep ONE unified call, but reorder
its internal authoring so ALL scene designs are authored before any story
prose — three stages: story arc/outline first (plot structure + one beat per
page), then the full scene sequence designed for renderability and critiqued
as a set, then the full story text written last in one pass over the locked
scenes. Blocks, not interleaved (interleaving scene1/text1/scene2 reintroduces
text-driving-scenes).

**Decision:** variant template `prompts/story-unified-imagefirst.txt`, selected
only when `inputData.storyPromptVariant === 'imageFirst'` (seam in
`buildUnifiedStoryPrompt`, storyHelpers.js). Production default and trial flow
are untouched. The variant's OUTPUT format is byte-compatible with
story-unified.txt — same `---MARKER---` set, same relative order, same
per-page draft/patch syntax — because the parsers hard-bound sections
(draft = STORY DRAFT→ANALYSIS; FIXES REQUIRED→TITLE; patches after STORY
PAGES; cover hints→STORY PAGES). Only three NEW work sections are added,
all BEFORE `---STORY DRAFT---`: `---SCENE SEQUENCE---` (per-page designs,
`**Scene N**` headers — deliberately NOT `Draft N`/`--- Page N ---` shapes,
which draft/page regexes would swallow), `---SCENE SEQUENCE CRITIQUE---`
(scene-set critique: picturability, variety, cast rotation, visual arc;
labelled REVISIONS, never "FIXES REQUIRED" — the streaming parser locks onto
the FIRST occurrence of that phrase), and `---PAGE TEXTS---` (`**Text N**`
headers; the draft copies these texts verbatim so the parsed draft stays
canonical). The ANALYSIS gains the hard rule: text-vs-scene mismatch is
always a TEXT fix, never a SCENE/METADATA fix (checks 18 and 24c inverted;
mechanical metadata corrections still allowed).

**Rationale:** parsers win over elegance — reordering the emitted sections
would have required touching 4 parser files with regression risk across every
stored story; reordering only the authoring WORK sections gets the
image-first discipline with zero parser changes. Text duplication
(PAGE TEXTS → draft) costs ~1k words per 10 pages; duplicating the 250–350
word SCENE prose instead would have risked output-token limits on 30-page
stories, so scene designs are compact in SCENE SEQUENCE and expanded to full
prose once, in the draft, after all texts exist.

**Touched:** `prompts/story-unified-imagefirst.txt` (new),
`server/services/prompts.js` (template key `storyUnifiedImageFirst`),
`server/lib/storyHelpers.js` `buildUnifiedStoryPrompt` (variant seam),
`tests/manual/test-imagefirst-parser-compat.js` (37 checks: parser
equivalence original vs variant, streaming parser, marker diff, seam
default-untouched proof), `docs/prompt-inventory.md`, roadmap §4 status.

**Status:** 🧪 built, A/B pending — validate via the §7 text-only harness on
≥3 diverse stored stories (`POST /api/admin/jobs/:jobId/rerun-text` with
`{"inputOverrides":{"storyPromptVariant":"imageFirst"}}` vs without, judged
by `/judge-text`). The text harness measures TEXT quality only; the expected
image-side benefit needs a later full-pipeline run. Whether the model truly
obeys the authoring order cannot be verified without live calls.

## Eval reference photos hydrate from any source (R2 URLs included), not data-URIs only (2026-07-30)

**Context:** A staging cover eval flagged both main characters as
"not identified in QUALITY_FIGURES.matches[]" at CRITICAL (25-30 pts each),
tanking the cover and looping it through repair forever — every repaired
version re-evaluated through the same broken input. Traced chain:
post-save eval entry points (`/repair-workflow/re-evaluate`,
admin single-page eval, in-pipeline repair rounds via `allCharacterPhotos`)
pass character reference photos as `{name, photoUrl}` where `photoUrl` is an
R2 **https URL** — `stripInlineImagesFromStoryData` sweeps every inline byte
out of `stories.data`, and `avatars.styled` (the first-choice field at those
call sites) is never written anywhere, so the swept `photoUrl` is all there
is. `evaluateImageQuality`'s reference loop required
`photoUrl.startsWith('data:image')` and SILENTLY dropped everything else →
zero labeled REF_IMAGES reached the quality eval and the P1 visual
inventory → `matches[]` came back empty → the blind compliance stage
(presence-is-input) saw prompt-named characters with no matches entry and
emitted identity CRITICALs. Generation-time evals were unaffected (in-memory
data URIs), which is why scores looked fine until a post-save re-eval.

**Decision:** the reference loop resolves each photo via
`r2Lib.bytesFromAnyImage` (data URI fast path unchanged; https URLs fetched;
unsupported schemes / fetch failures logged and skipped per item), and logs a
loud warning whenever refs are dropped — including the explicit
"NO references: matches[] will be empty" case.

**Rationale:** identification is the input the whole downstream severity
model leans on; a silent ref drop converts a storage-format migration into
phantom character-absence findings. Fix at the single chokepoint loader so
every eval entry point (covers AND scenes) is repaired at once.

**Touched:** `server/lib/images.js` (`evaluateImageQuality` reference loop).

**Status:** ✅ active — staging check pending: re-run a cover re-evaluate on a
stored story and confirm the log shows labeled references added and
`matches[]` populated.

## Compliance judge can never emit CRITICAL for identity-absence — capped in code (2026-07-30)

**Context:** same incident. `prompts/image-prompt-compliance.txt` documented
"presence-is-input" but its STEP 4 still listed missing-character as a
CRITICAL, and the judge emitted CRITICAL "not identified in matches[]" even
while itself noting the figure was visually present — violating the
never-CRITICAL contract documented at `models.js` `complianceModel`. Each
such CRITICAL costs 30 pts in the merged recompute, enough to drive a
repair loop on its own whenever identification hiccups.

**Decision:** two layers. (1) Prompt: STEP 1 now says `missing_character` is
at most MAJOR, defines the empty/absent-`matches[]` case as an eval-input
deficiency ("pair by zone/appearance, never emit missing_character for a
character with any plausibly-matching figure"), the NEVER-CRITICAL list gains
an identity-absence entry, and STEP 4 moves missing-character from the
CRITICAL bucket to MAJOR. (2) Code: `capComplianceIdentitySeverity()`
(exported from `server/lib/images.js`, applied to every parsed compliance
result) deterministically downgrades CRITICAL/CATASTROPHIC findings of type
`missing_character` or with identity-absence wording ("not identified",
"matches[]", "no entry in matches", "absent from matches") to MAJOR and
stamps `severityCapped: 'identity-input'`.

**Rationale:** the compliance judge never sees the image — its "missing"
verdicts are inferences from the identification input, and the image-seeing
quality eval already owns true missing-character CRITICALs, so capping the
blind judge loses no real detection power. The code-side cap exists because
a prompt contract a model can disobey is not a guarantee; with the cap, this
failure class can degrade a score by at most 20 pts (MAJOR) and can no
longer sustain a repair loop by itself.

**Touched:** `prompts/image-prompt-compliance.txt`,
`server/lib/images.js` (`capComplianceIdentitySeverity` + call in
`evaluateThreeStage`),
`tests/manual/test-compliance-severity-cap.js` (16 checks: caps by type and
by wording, CATASTROPHIC included, real CRITICALs untouched, malformed
inputs tolerated).

**Status:** ✅ active.

## Back view: kept for its two cases; shared-action facing must be consistent (2026-07-31)
**Context:** A scene put two companions on the same path to the same destination —
one facing the camera studying a held object, the other back-view walking ahead.
Owner: back view stays for its two legitimate reasons — (1) crowded multi-character
compositions (a variety option) and (2) figures walking toward a background object
(recommended). "What is terrible is both go to the same place but one gets back
view." Also in that scene: camera-facing combined with a look-down task (reading),
and front-only helmet detail (visor) declared visible on a back-view figure — both
unrenderable by specification.
**Decision:** New shared rule at the four sibling sites (identical archetypal
wording, per validating-prompt-changes): characters sharing a destination/activity
get the SAME facing treatment (all back view toward a background target — never one
companion camera-facing while the rest walk away); a look-down task cannot combine
with `facing the camera`; front-only details are never described on back-view
figures. Sites: `prompts/story-unified.txt` + `prompts/story-unified-imagefirst.txt`
(scene-design rules), `prompts/scene-expansion.txt` (rule 8c), `prompts/
image-generation.txt` (companion clause). The deliberate back-view push itself
(Pt 12) is NOT reversed — the two legitimate cases stand.
**Touched:** the four prompt files above.
**Status:** ✅ active.

## Image-first prompt is the DEFAULT on staging (2026-07-31)
**Context:** The arc → scenes → text variant shipped flag-gated (default text-first)
for a harness A/B. Owner: "we have still not changed the outline prompt — I thought
you changed this" → wants the new order live for staging testing.
**Decision:** `buildUnifiedStoryPrompt` now DEFAULTS to `storyUnifiedImageFirst`;
`storyPromptVariant: 'textFirst'` (or env `STORY_PROMPT_VARIANT=textFirst`) selects
the legacy template — the A/B still runs both ways via rerun-text inputOverrides.
Master/prod inherits only when staging is promoted (normal approval flow). Output
format is parser-identical (37-check compat test), so the flip changes authoring
order only.
**Touched:** `server/lib/storyHelpers.js` (variant seam default).
**Status:** ✅ active on staging; watch the first live runs for order-obedience +
output-length headroom on 20+ page stories.

## Styled-avatar MUST guarantee: Pass-2 failure is never fatal + coverage backstop (2026-07-31)
**Context:** A live staging story (both primaries costumed on every page,
`standard.used=false`) shipped with the ADULT primary having NO styled avatar —
every page and eval silently fell back to the raw photo. Root cause chain: the
story pipeline's only costumed/styled generator is the 2×4 sheet
(`generateCharacter2x4Sheet` — Pass 1 identity anchor on **Grok**, Pass 2 style
transfer on **Gemini** by default, `avatarStyleTransferBackend='gemini'`). The
Pass-2 backend call was unprotected: one thrown Gemini call (e.g. IMAGE_OTHER
safety refusal on the photorealistic ADULT face in the Pass-1 sheet — the same
refusal class that forced clothing avatars to Grok) escaped the retry loop,
escaped `generateCharacter2x4Sheet`, and destroyed the perfectly good Pass-1
sheet. The costumed→standard emergency fallback in `prepareStyledAvatars` then
re-ran the SAME pipeline and died on the same refusal → zero avatars, no
surfaced warning. (The CLAUDE.md provider-table note "costumed avatars still
hit Gemini directly" is stale: `generateDynamicAvatar`'s direct-Gemini path is
only the `/generate-avatar-options` picker route, not the story pipeline.)
**Decision:** Three layers, root cause first:
(1) Per-attempt error containment — Pass-1 Grok call and Pass-2 backend call
each catch throws as a consumed attempt (`stage: 'gen-error'`) instead of
aborting the sheet.
(2) Alternate-engine retry — when EVERY Pass-2 attempt on the configured
backend throws, retry ONCE via the other backend (gemini↔grok,
`styleTransferGenerate(prompt, img, backendOverride)`); a weakly-stylised Grok
sheet beats no avatar. If that fails too, Pass 2 returns `imageData: null` and
the realistic Pass-1 sheet ships unstyled (existing seam). The **default**
Pass-2 backend stays Gemini — the 2026-07-19 all-5 A/B verdict ("Grok barely
stylises") is NOT re-litigated; Grok is the failure path, not the default.
(3) Hard coverage backstop — `ensureStyledAvatarCoverage` (styledAvatars.js)
runs at the end of `prepareStyledAvatars`: any required character with zero
styled avatars in any bucket is an ERROR state. The best available raw
reference (standard clothing avatar → bg-removed body photo → face photo, via
the pure `resolveGuaranteedReference` chain in `server/lib/avatarGuarantee.js`)
is seeded into the styled-avatar cache at 'standard' (same seam as
`_seedStandardFromPreview`; cache-only — `char.avatars.styledAvatars` is NOT
written so composite-cover cell extraction never mistakes a raw photo for a
2×4 sheet). Seeded keys are registered in `guaranteeSeededKeys`: they serve
reads but do NOT satisfy "already cached → skip" checks, so a later
`prepareStyledAvatars` call (coverage top-up) still retries the real
conversion; a successful conversion overwrites the seed. Failures are logged
as `[AVATAR] ❌ …` and surfaced in BOTH dev-panel logs
(generationLog `avatar_guarantee_fallback`/`avatar_guarantee_exhausted` +
styled-avatar audit entry). Realistic style only fires the backstop when a
costume was required (standard/winter/summer cache misses are normal there).
**Rationale:** the Pass-1 sheet is a complete identity anchor; losing it to a
style-transfer failure inverted the value order (style > identity). A primary
character without any identity reference must be impossible, and when only a
degraded reference is available that fact must be loud, not buried in debug
logs.
**Touched:** `server/lib/character2x4Sheet.js`, `server/lib/styledAvatars.js`,
`server/lib/avatarGuarantee.js` (new), `tests/manual/test-avatar-guarantee.js`
(28 checks: chain resolver + vm-sliced `runStyleTransferPass` alternate-backend
behaviour), `docs/image-generation-methods.html`, `docs/image-routing.md`.
**Status:** ✅ active; needs one live staging avatar run (adult + costumed
story) to confirm end-to-end.

### VB authoring: worn items live in one category; garments sized on-body; doffed pieces stated explicitly (2026-07-31)
**Context:** a staging story surfaced four Visual-Bible/metadata authoring
defects from the unified outline call: (1) the same worn garment emitted BOTH
as an `artifacts` (ART) entry and a `clothing` (CLO) entry — two competing
canonical descriptions, plus a stray standalone reference render (CLO entries
deliberately get no reference image, `visualBible.js` skips them because worn
items appear on the character avatars; the duplicate ART copy re-opened that
path); (2) the object size-calibration vocabulary ("fist-sized",
"forearm-length" — meant to stop prop over-scaling) applied to a worn garment,
contradicting the clothing spec's on-body length; (3) a scene depicting a
normally-worn costume piece removed and lying on the ground while the
character's `clothing` tag still implied the full outfit — the avatar
reference wears the piece, the scene doesn't, guaranteed mismatch; (4) CHR ids
in scene-metadata `objects[]` (checked, see below).
**Decision:** three rules added with identical wording to BOTH sibling
templates (`story-unified.txt` + `story-unified-imagefirst.txt`):
(1) VB Rules list: every physical item appears in exactly ONE category — worn
items go in `clothing` (+ wearer's `clothingRequirements`) only, `artifacts`
is for non-worn props;
(2) SCENE-prose size-anchor bullet: calibration terms are for props only;
garments are sized by where they fall on the body ("waist-length",
"knee-length", "falls to mid-back"), never by object calibration terms;
(3) SCENE-prose clothing block: a removed normally-worn item requires the
prose AND `sceneIntent` to state the character is WITHOUT it and where it
lies, plus an `interactions[]` entry for the item's location.
(4) NO rule for CHR ids in `objects[]`: verified intentionally consumed —
`server.js` (unified Phase 5a + trial stream) extracts CHR ids from
`objects[]` into `getElementReferenceImagesByIds` for VB-grid packing
(Set-deduplicated, no double-packing), and `storyHelpers.js` filters them out
of REQUIRED OBJECTS by design (see "Antagonists: outline declares them in
prose + objects[]" entry above). Template line "Every `objects[]` entry with a
CHR* ID must appear by name in the prose" stays authoritative.
**Rationale:** each duplicate/contradictory authoring artifact costs a wasted
reference render and puts eval+repair in double jeopardy chasing two specs of
the same item; the outline call is the single cheapest place to prevent all
three.
**Touched:** `prompts/story-unified.txt`, `prompts/story-unified-imagefirst.txt`
(identical additions; parser-compat test 38/38 green).
**Status:** ✅ active — pending the next staging story to confirm the model
follows the new rules.

## Image-first template de-duplicated: PAGE TEXTS + SCENE PLAN removed (2026-07-31)
**Context:** Owner review of a live image-first run: "the whole structure seems
shitty — what is redundant?" Audit confirmed: page text was emitted THREE times
(---PAGE TEXTS--- → verbatim copy into ---STORY DRAFT--- → ---STORY PAGES---
patches) and scene content in FIVE layers (PAGE BEATS → SCENE SEQUENCE →
SCENE PLAN → SCENE prose → sceneIntent). Grep-verified: NOTHING consumes
---PAGE TEXTS--- or ---SCENE PLAN--- — both were unparsed model workspace. The
verbatim-copy design also carried a drift failure mode (model paraphrases the
copy → the parsed draft diverges from the "canonical" unparsed text).
**Decision:** In `story-unified-imagefirst.txt`: (1) PAGE TEXTS deleted — story
text is written ONCE, per page, directly in the STORY DRAFT, which now carries
the former PAGE TEXTS rules (text narrates the locked Scene N; text bends, scenes
never). Arc → scenes → text order is preserved: the SCENE SEQUENCE + critique are
locked before the draft begins. (2) SCENE PLAN deleted — a vestigial one-line-per-
page summary of the SCENE SEQUENCE it sat next to; ANALYSIS check 16 now verifies
pages against the locked Scene N designs directly. Production template untouched
(its SCENE PLAN is its real planning layer). Parser-compat suite updated to
declare SCENE PLAN as a deliberate variant absence; 37 checks pass.
**Rationale:** ~2k fewer output tokens on a 10-pager (more on 30), truncation
risk down, copy-drift eliminated; the parsed STORY DRAFT is the single canonical
text.
**Touched:** `prompts/story-unified-imagefirst.txt`,
`tests/manual/test-imagefirst-parser-compat.js`.
**Status:** ✅ active.

## Cover prompt builder: hint-filtered elements, worn≠held, conditional group block, single full-bleed/no-text, age buckets, English-only (2026-07-31)
**Context:** Owner audit of a real emitted initial-page cover prompt found six
defects: (1) KEY STORY ELEMENTS dumped EVERY VB artifact (a prop the hint never
asked for got hallucinated into the render); (2) an item held per the hint's
`holds:` was ALSO described as worn in the CLOTHING block — the model got
"worn tied at the neck" and "held in the hand" for the same item; (3) the
initial-page "GROUP scene / MAIN CHARACTER in the CENTER / others arranged
AROUND" boilerplate rendered even for 1-2 characters, contradicting the hint's
explicit positions and inviting invented extra figures; (4) full-bleed/no-text
rules were stated 2-3× per prompt (opening paragraph + FRAMING section +
Notes); (5) character intros used numeric ages ("8-year-old male") though the
avatar + eval anchor to apparent-age buckets and scene prose forbids numerals;
(6) German leaked into the English image prompt — VB entity names ("holds the
<story-language artifact name>"), the invented location's bare German name, and
the hint's story-language `Mood:` phrase pasted verbatim.
**Decision:**
- `buildFullVisualBiblePrompt` takes `allowedElementIds` (cover hint `objects`
  ∪ every `holds:` id — holds ⊄ objects) and `excludeElementIds`; covers pass
  them at all three emission sites (coverIterate, server.js streaming, trial).
  No hint → legacy unfiltered dump. Artifact/vehicle lines lead with a generic
  English label + description, never the story-language VB name; animals keep
  their proper name (identity anchor, like characters).
- `applyCoverWornHeldDedupe` (coverIterate) resolves worn-vs-held
  deterministically: HELD per hint → the overlapping garment segment is
  dropped from that character's CLOTHING line (item appears once, in the holds
  prose); WORN by nobody-holds → artifact id is excluded from KEY STORY
  ELEMENTS (it lives in the CLOTHING block). Overlap = ≥2 shared significant
  tokens, or ≥1 token from the artifact NAME. Operates on clones — reference
  photo objects are never mutated.
- Initial-page templates now carry `{GROUP_COMPOSITION}`;
  `buildInitialPageComposition(count)` emits the group boilerplate only for
  3+ characters, and an exact-count "no invented figures" block for 1-2.
  Solid-ground / 2-hands / warm-atmosphere lines stay unconditional.
- All four cover templates state full-bleed ONCE: FRAMING section merged into
  the opening paragraph; initial-page-no-dedication's Notes merged into a
  single absolute no-text statement. `makeTextless` lookahead extended
  (`\n**` | `\n{` | end) since TITLE/TEXT is now the last **section**.
- `buildCoverSceneFromHint` uses apparent-age buckets via
  `extractCharacterVisualProfile` (same source as the scene path): "a young
  school age boy", never "8-year-old male".
- **Image-facing cover prompts are English-only regardless of story
  language.** Holds ids resolve to a short English descriptor built from the
  VB entry's description (fallback: sanitizer-style generic noun) — never the
  story-language name. The cover location's name is emitted only WITH its
  English features/colors/signatureElement inlined in parentheses. The hint's
  free-text `Mood:` is model-authored in the story language, so it is pasted
  verbatim ONLY when the story language is English and dropped otherwise
  (deterministic; templates carry their own atmosphere lines). Same gate in
  the composite pass-2 prose via `coverHint._language` +
  `_artifactDescsEn` stamped by `enrichCoverHintWithArtifacts`.
**Rationale:** stray objects cause "unrequested item" hallucinations; a
worn+held contradiction cannot be drawn; group boilerplate at 1-2 chars
invents strangers; duplicated rules dilute prompt weight; numeric ages fight
the bucket-anchored avatar/eval; foreign-language tokens degrade image-model
compliance and can be painted as lettering (settled direction: image-facing
text = English, per scene-iteration LANGUAGE RULES + VB-id sanitizer).
**Touched:** `server/lib/coverIterate.js`, `server/lib/visualBible.js`,
`server/lib/coverComposite.js`, `server/lib/storyHelpers.js` (export),
`server/services/prompts.js`, `server.js`, `server/routes/regeneration.js`,
`prompts/front-cover.txt`, `prompts/back-cover.txt`,
`prompts/initial-page-no-dedication.txt`,
`prompts/initial-page-with-dedication.txt`,
`tests/manual/test-cover-prompt-builder.js` (new, 40+ assertions).
**Status:** ✅ active.

## Page prompt builder: worn≠held guard, English-only entity refs, subordinated facing boilerplate, state-aware REQUIRED OBJECTS (2026-07-31)
**Context:** Owner audit of a real emitted PAGE prompt (German story) found the
page-side siblings of the cover-prompt defects fixed the same day: (a) the SAME
cape described as BOTH worn ("tied around his neck" — the CLOTHING wears-line
backstop pasted the worn CLO entry raw, internal name incl. the wearer
parenthetical) AND held ("held overhead in his hands" — scene prose): physically
impossible, the model paints two capes; (b) story-language VB names raw in the
English prompt (clothing/artifact names in REQUIRED OBJECTS + the wears-line,
location names in the vantage empty-scene LOCATION line, plus localized de/fr
REQUIRED OBJECTS headers — which also silently broke `parseVisualBibleObjects`,
it only matches the English header); (c) the composition boilerplate "faces
that action target — not the camera" contradicting scenes that explicitly
declare "facing the camera"; (d) REQUIRED OBJECTS descriptions saying "tied at
the neck" for items the scene holds/drapes.
**Decision:**
- **Worn-vs-held guard on the wears-line backstop**
  (`filterWornClothingAgainstScene`, storyHelpers): a garment segment the scene
  places off-body is dropped from the injected `- X wears:` line. Off-body =
  structured `interactions[]` (id match or token overlap) or a prose sentence
  (token overlap + non-worn placement wording). Placement lexicon: held/carried/
  waved/overhead/in hands, lying/crumpled/dropped/on the ground, removed/taken
  off are always off-body; draped/hangs/slung only when NOT anchored to a body
  part ("draped over his shoulders" stays worn). Token overlap rule = the cover
  dedupe's (≥2 shared significant tokens or ≥1 entry-NAME token), tokenizer
  shared via `significantEntityTokens` (moved to visualBible.js).
- **English-only entity refs at every page emission site**: REQUIRED OBJECTS
  header is always English; artifact/vehicle/clothing entries lead with the
  `englishEntityRef` description-derived ref (moved to visualBible.js, shared
  with covers), never the story-language VB name; animals keep proper names;
  internal entry names inside kept wears-line segments are swapped for the
  English ref and "(WearerName)" parentheticals removed. `sanitizeVbIdsInPrompt`
  (final chokepoint for pages AND cover composite) now resolves ART/VEH/CLO ids
  to English refs and LOC ids to name + inlined English visuals
  (`englishLocationRef`); CHR/ANI still resolve to given names. The
  `buildVisualBiblePrompt` fallback section and the vantage empty-scene
  `**LOCATION:**` line follow the same rule.
- **ROOT fix**: `story-unified.txt` + `story-unified-imagefirst.txt` VB rules
  now mandate ENGLISH `name` + `description` for artifacts, locations, vehicles,
  and clothing (characters/animals keep given names) — the code-side refs are
  the backstop for stories generated before the rule and for model slips.
- **Facing boilerplate subordinated** (`image-generation.txt`): "...faces that
  action target — not the camera, UNLESS the scene description explicitly
  declares a facing ... — the scene's declared facing always wins."
- **State-aware REQUIRED OBJECTS**: when the scene places an object off-body,
  the emitted description drops attachment clauses ("tied at the neck" —
  attachment verb + body part, via `stripWornStateFromDescription`) and the
  clothing "(worn by X)" suffix; the English lead ref is built from the
  stripped description so the clause can't re-enter via the lead. Worn pages
  keep clause + suffix unchanged.
- Known cross-language limit: token matching cannot bridge a German entry name
  against English prose — closed at the root by the English-VB rule; the
  structured-interactions id/overlap path still catches most cases meanwhile.
**Rationale:** a worn+held contradiction cannot be drawn (model paints the item
twice); story-language tokens degrade image-model compliance and get painted as
lettering (settled English-only direction); localized REQUIRED OBJECTS headers
break the expected-objects parser; unconditional facing boilerplate overrides
the scene's explicit facing declarations.
**Touched:** `server/lib/storyHelpers.js` (guards, REQUIRED OBJECTS emission,
wears-line backstop, sanitizeVbIdsInPrompt), `server/lib/visualBible.js`
(shared `englishEntityRef`/`englishLocationRef`/`significantEntityTokens`,
English-only `buildVisualBiblePrompt`), `server/lib/coverIterate.js` (delegates
to shared helpers), `server.js` (vantage LOCATION line),
`prompts/image-generation.txt`, `prompts/story-unified.txt`,
`prompts/story-unified-imagefirst.txt`,
`tests/manual/test-page-prompt-builder.js` (new, 45+ assertions),
`tests/manual/test-cover-sanitize.js` (updated to English-ref contract).
**Status:** ✅ active.

## Split outline review — Sonnet writes, Opus reviews (2026-07-31)

**Context:** testing-backlog #2 (cross-model review A/B) + owner: "the review of
the outline should be a different model. Let's first try opus." The unified
call previously wrote the draft AND critiqued itself (---ANALYSIS--- + FIXES
REQUIRED + ---STORY PAGES--- patches) in one Sonnet response; same-model
self-critique mostly produces agreement.

**Decision:** the self-critique is split out of the writer call. Both unified
templates now carry an `{ANALYSIS_INSTRUCTIONS}` placeholder in their
---ANALYSIS--- section; the analysis instruction bodies were extracted to
`prompts/outline-analysis-textfirst.txt` / `outline-analysis-imagefirst.txt`
(one source per variant, shared by both modes so self-critique and external
review can never drift). Modes, gated by `MODEL_DEFAULTS.splitOutlineReview`
(env `SPLIT_OUTLINE_REVIEW`, default **true**):
- **Single-call (OFF):** builder injects the full analysis body — byte-identical
  behavior to before.
- **Split (ON, default):** the writer (Sonnet, unchanged) gets a stub — emit
  `---ANALYSIS---` as "Reviewed externally.", no FIXES REQUIRED phrase, no patch
  blocks, but still the bare `---STORY PAGES---` marker so every parser boundary
  (draft ends at ANALYSIS, cover hints end at STORY PAGES) stays put. A second
  call by `MODEL_DEFAULTS.outlineReviewModel` (env `OUTLINE_REVIEW_MODEL`,
  default `claude-opus` → `claude-opus-5`, 32k out, $5/$25 pricing entries
  added) receives the writer's full output + the same analysis instructions via
  `prompts/outline-review.txt` and emits ---ANALYSIS--- + FIXES REQUIRED +
  ---STORY PAGES--- patches in the exact existing format. server.js appends the
  reviewer output to the writer output and the CONCATENATION flows through the
  unchanged UnifiedStoryParser/ProgressiveUnifiedParser. usageLabel
  `outline_review`; log line `[OUTLINE-REVIEW] model=…`.

**Streaming in split mode:** call 1 streams as today — title/clothing/VB/cover
hints (and thus early avatar styling + covers) still fire progressively. Page
emission WAITS for the reviewer: the FIXES REQUIRED list decides draft-final vs
patched, so the reviewer output is handed to the progressive parser in ONE
chunk after the review call completes (incremental feeding would let
`_ensurePatchedPageNumbers` lock onto a half-streamed FIXES list and ship
pages whose patch hadn't arrived). Cost: scene expansion starts one review-call
later than the old single-call STORY PAGES streaming.

**Failure containment:** reviewer output missing the ANALYSIS/FIXES REQUIRED
markers or call failure → 1 retry → proceed with the UNPATCHED draft + loud
`🚨 [OUTLINE-REVIEW]` warning + generationLog `outline_review_failed` event.
Review never blocks generation. Trial mode never reviews (its prompt has no
critique by design).

**Touched:** `prompts/story-unified.txt`, `prompts/story-unified-imagefirst.txt`
(ANALYSIS body → placeholder), `prompts/outline-analysis-textfirst.txt`,
`prompts/outline-analysis-imagefirst.txt`, `prompts/outline-review.txt` (new),
`server/services/prompts.js` (3 new template keys), `server/config/models.js`
(TEXT_MODELS `claude-opus`, MODEL_DEFAULTS `outlineReviewModel` +
`splitOutlineReview`, MODEL_PRICING `claude-opus-5`), `server/lib/storyHelpers.js`
(`SPLIT_REVIEW_ANALYSIS_STUB`, injection seam, `buildOutlineReviewPrompt`),
`server.js` (review call between call-1 completion and final parse),
`tests/manual/test-split-outline-review.js` (42 checks: concatenation ≡
single-call parse, progressive flow, zero-fix tolerance, failure path, builder
seam).

**Status:** 🧪 built, live A/B pending — measure via §7 text harness +
regeneration rate per testing-backlog #2 ("If Opus doesn't catch more, keep
Sonnet on both"). Flip back fleet-wide with `SPLIT_OUTLINE_REVIEW=false`.

## Scene consistency: mechanical validator in code, semantic judgment in the Opus review (2026-07-31)

**Context:** owner: "do we have enough focus on ensuring scenes are consistent?
that scene metadata matches the scene outline and that this is simple to
visualize." Metadata↔scene consistency was only prompt-checked (ANALYSIS
section D). Owner scope ruling on the split: semantic consistency is NOT
deterministic-checkable — e.g. text says two characters walk together but one
is authored facing the camera and one back view; inferring "these two share an
action" from prose is semantic judgment a string checker must not pretend to
make. Owner: "this is for Opus to review."

**Decision:** two layers with an explicit division of labor.
- **Code = MECHANICAL PARITY ONLY.** `server/lib/sceneConsistencyCheck.js`
  (pure string/set logic, no model calls) checks per page: (a) locked SCENE
  SEQUENCE `Cast:` lines vs METADATA `characters[]` (known-name matching),
  (b) METADATA characters[] vs SCENE-prose name mentions (both directions),
  (c) `interactions[]` character/object refs exist in characters[]/objects[]
  (objects may anchor in background/emptyScenePrompt/prose), (d) depth word in
  the `position` phrase vs the `depth` field, (e) sceneIntent names ⊆
  characters[]. NO facing logic, NO shared-action detection, NO pose
  plausibility — a closed mechanical issue-type whitelist is asserted in the
  unit test.
- **Opus review owns ALL semantic scene consistency.** `prompts/outline-review.txt`
  § SEMANTIC SCENE CONSISTENCY instructs the reviewer per page: shared-action
  facing coherence (companions in one activity/destination share a facing
  treatment), gaze–task contradictions, front-only details on back-view
  figures, worn-vs-held garment states matching the narrated state, and
  metadata semantically matching the locked scene design + page text. The
  validator's findings feed the reviewer as a REVIEW HINTS block (facts only);
  the semantic verdicts are the reviewer's.

**Visualization:** validator runs twice in server.js — pre-review on the draft
(hints) and post-parse on the final merged pages; the final run logs compact
`[SCENE-CONSISTENCY] P3: …` lines, writes a generationLog `scene_consistency`
event, and lands on `finalChecksReport.sceneConsistency`
({checkedAt, issueCount, pages:[{page, issues:[{type, detail}]}]}) so the dev
panel surfaces it alongside entity/style consistency.

**Touched:** `server/lib/sceneConsistencyCheck.js` (new), `server.js` (pre-review
hints + post-parse report), `prompts/outline-review.txt` (semantic section),
`tests/manual/test-scene-consistency-check.js` (22 checks: seeded mismatches →
exact issue types, clean page → none, mechanical-only whitelist).

**Status:** ✅ active (report-only — findings inform the review and the dev
panel; no automatic regeneration is driven off them yet).

## Cover-parity batch — six owner-directed fixes after the 2026-07-31 staging run

Overarching owner directive: **covers must be treated the same as normal pages.**
Six entries below (one per fix); branch `cover-parity-batch`.

### Opus outline review is persisted and visible (2026-07-31)
**Context:** the split outline review appended the reviewer output to the local
`unifiedResponse` for parsing, but the stored story blob wrote
`outline: unifiedResult.text` (writer-only) — so the dev outline view never
showed the Opus ANALYSIS, and nothing recorded who reviewed or how long it took.
**Decision:** `data.outline` (and the job resultData `outline`) now store the
full writer+reviewer CONCATENATION (`unifiedResponse`); a new
`storyData.outlineReview` field carries `{ model, modelId, durationMs,
fixCount, reviewChars, hintCount, reviewedAt }`; the generationLog
`outline_review` event now includes the reviewer's fix-line count (counted with
the same `Pages N,M:` line shape the progressive parser reads) + duration.
Verified the split executes in the NORMAL job path: the review block sits
inline in `processUnifiedStoryJob` (server.js), which `processStoryJob` calls
for every unified job — not only the rerun-text harness.
**Touched:** `server.js` (review block meta capture; storyData/resultData
outline + outlineReview).

### Image-first prompt authors ALL scene work scene-first — ---SCENE PAGES--- section (2026-07-31)
**Context:** owner: "would it not be more logical to do all scene stuff first."
The image-first template designed scenes before text but still AUTHORED the
full SCENE prose + METADATA JSON inside the STORY DRAFT blocks (i.e. during
the text pass). A verbatim-copy design (scenes authored early, then copied
into the draft) was explicitly banned by the owner.
**Decision:** `prompts/story-unified-imagefirst.txt` restructured: after the
SCENE SEQUENCE CRITIQUE locks the designs, a new `---SCENE PAGES---` section
authors the COMPLETE per-page illustration brief (`**Scene N**` + SCENE prose
+ METADATA JSON — expressions derived from the PAGE BEATS since no text exists
yet); `---STORY DRAFT---` then carries page TEXT only (no SCENE/METADATA
blocks, no duplication). PARSERS extended, guarded by response-format
detection: `extractDraftPagesFromText` (shared.js — used by BOTH
UnifiedStoryParser and ProgressiveUnifiedParser) merges
`extractScenePagesFromText` blocks into the draft map ONLY when the
`---SCENE PAGES---` marker is present; the original format parses
byte-identically (marker absent → zero-op). Draft-inline scene sections (model
duplicates despite instructions) win over the scene-section blocks (later-wins
patch philosophy); ---STORY PAGES--- patches still override both. Affect
translation (text ↔ authored expression) moved to the ANALYSIS
(outline-analysis-imagefirst.txt § 18b) as a mechanical SCENE,METADATA fix;
outline-review.txt told never to re-emit ---SCENE PAGES---.
**Touched:** `prompts/story-unified-imagefirst.txt`,
`prompts/outline-analysis-imagefirst.txt`, `prompts/outline-review.txt`,
`server/lib/outlineParser/shared.js` (`extractScenePagesFromText` + merge),
`tests/manual/test-imagefirst-parser-compat.js` (59 checks: original format
byte-identical, scene-first format parses to IDENTICAL pages/streaming
output, template marker diff).
**Status:** 🧪 built + unit-verified; needs a live staging story to confirm the
model follows the new emission shape.

### Detection is part of every image version (2026-07-31)
**Context:** owner decision — `bboxDetection` (+ overlay availability) must be
stamped onto EVERY stored image version at eval time, covers AND pages,
exactly like grokRefImages are stored per version. The cover dev-image path
already supported per-version detection (5d43e4c7) but never had data:
`iterateCover` dropped `imageResult.bboxDetection` from its return, so the
cover regen route's `iterResult.bboxDetection` read was always undefined; the
final-assembly fresh-bbox refresh landed only on the scene root, not on the
picked version; the manual page-regen version entry never stamped it.
**Decision:** one resolution rule, `detectionForVersion(v)` (images.js,
exported): version-stamped detection (computed on the version's own bytes)
wins → eval-time `evaluation.bboxDetection` → null. Used by the pipeline's
`buildVersionEntry` (+ `hasBboxOverlay` availability flag; overlay itself is
drawn on demand by the dev endpoint) and retryHistory. Stamp sites fixed:
fresh-bbox refresh now also stamps `best.bboxDetection`; `iterateCover`
forwards `bboxDetection`/`bboxOverlayImage` (composite path: honest null — no
eval ran); page-regen + cover-regen version entries stamp
`imageResult.bboxDetection`. Display backfill: ImageHistoryModal (version
viewer) shows a per-version detection summary; ObjectDetectionDisplay already
read the active version's own detection (5d43e4c7). Versions created without
any eval (scale-repair, style-transfer) stay honest-null — the refresh button
re-detects on demand.
**Touched:** `server/lib/images.js`, `server/lib/coverIterate.js`,
`server/routes/regeneration.js`,
`client/src/components/generation/story/ImageHistoryModal.tsx`,
`tests/manual/test-version-detection-and-cover-cast.js`.

### Cover reference packing: hint-listed characters are authoritative (2026-07-31)
**Context:** owner report — the title page sent only the main character's
avatar; the hint-listed second protagonist's avatar never went along, so the
model invented that face. Root cause: server.js's streaming title-page filter
dropped every non-"main" character even when the outline's cover hint
explicitly listed them (`hint.characterClothing`). Sibling paths had the same
bug shape: `iterateCover`'s back-cover drop and the test-models
cover-composite dispatch filtered hint-listed primaries too.
**Decision:** new single decision point `narrowCoverCastToMains(cast,
{castFromHint, mainIds})` (coverIterate.js): a HINT-derived cast passes
through untouched — every hint-listed character's styled avatar is packed;
the main-only narrowing applies ONLY to fallback-derived casts (scene-text
matching / all-characters distribution), where it still guards against
feeding the whole cast. Used by the streaming cover path (server.js), the
iterate back-cover drop, and the regeneration cover-composite dispatch.
`filterBackCoverToMainCharacters` unchanged for direct behavior, now called
through the gate.
**Touched:** `server/lib/coverIterate.js`, `server.js`,
`server/routes/regeneration.js`,
`tests/manual/test-version-detection-and-cover-cast.js`.

### Style audit covers all three covers (2026-07-31)
**Context:** `checkStoryStyleConsistency` graded only the front cover (+
pages); a style outlier on the initial page or back cover was invisible.
**Decision:** the audit input includes ALL THREE covers under the pipeline's
negative page convention (frontCover −1, initialPage −2, backCover −3);
the grid labels them "Front cover" / "Initial page" / "Back cover" and the
clustering prompt returns the same numbers. The Step-5 pipeline call feeds
the covers' PICKED-BEST pixels from `finalBestPerPage` (covers run through
the repair rounds as pages −1/−2/−3), falling back to the input storyData
covers. The ad-hoc `/style-check` endpoint passes full storyData and picks
the covers up automatically.
**Touched:** `server/lib/styleConsistency.js`, `server/lib/images.js` (Step 5
styleInput).

### Style-repair wired into production, flag-gated (2026-07-31 — supersedes Pt 10 "wiring deferred")
**Context:** owner expects criticized covers (and pages) to actually be
redone — the Pt 10 path was Test-Lab-only and the Step-5 audit was
detection-only.
**Decision:** the `// PRODUCTION WIRING` marker in `runUnifiedRepairPipeline`
Step 5 is live: when `MODEL_DEFAULTS.styleRepairProduction` (env
`STYLE_REPAIR_PRODUCTION`, default **true**) and the audit reports outliers,
`planStyleRepair(styleConsistency, styleInput)` →
`repairPageStyle(model per MODEL_DEFAULTS.styleRepairModel, env
STYLE_REPAIR_MODEL, default 'gemini')` runs ONE repaint per outlier — pages
AND covers. `planStyleRepair` now maps covers at −1/−2/−3 from
`storyData.coverImages` (supersedes its front-cover skip: covers are TEXTLESS
under appSideCoverType, typography is composited after the art, so a repaint
never touches title lettering); the anchor reference stays a real story page.
Each repaint is gated by `checkStyleMatch` inside `repairPageStyle` —
gate-fail discards the repaint (never stored: an inherited-score version
could win recompute later); gate-pass/gate-unavailable is pushed as a new
version through the normal plumbing (source `style-repair-{model}`, inherits
the picked best's evaluation + entity record, canonical applyScore stamp,
`styleRepair` debug bundle with before/after style-match) and re-points
`finalBestPerPage`, so the final-assembly fresh-bbox refresh re-detects on
the repainted bytes and covers flow back into `coverImages` via the existing
extraction. Usage tracked as `style_repair`. The Test Lab `style_repair`
stage remains the Gemini-vs-Grok A/B; flip the winner in via
`STYLE_REPAIR_MODEL`.
**Touched:** `server/config/models.js` (`styleRepairProduction`,
`styleRepairModel`), `server/lib/images.js` (Step 5 wiring),
`server/lib/styleRepair.js` (cover targets + wiring note),
`tests/manual/test-style-repair.js` (cover-target checks),
`docs/image-routing.md`, `docs/image-generation-methods.html`.
**Status:** 🧪 wired + unit-verified; needs a live staging run with a real
style outlier to validate the repaint→gate→version flow end to end.
---

## 2026-08-01 — Shared story viewer: iOS full-bleed safe-top fallback + `short:` landscape screen

**Context:** On iPhone, when the wizard auto-navigates (SPA) to the shared
viewer after generation, Safari can stay in its collapsed-chrome full-bleed
state: content extends under the status bar / Dynamic Island but
`env(safe-area-inset-top)` still reports 0 until an orientation change — the
header sat under the clock and taps didn't land ("rotate to landscape and
back fixes it"). Separately, phone-landscape stacked chrome (Safari tab bar +
our header + banner + pagination row) left a sliver for the book, and the
viewer's `isMobile` breakpoint (768) disagreed with BookViewer's (1024),
adding phantom `storyText` entries to the page counter on landscape phones
and iPad portrait.

**Decision:** (1) Viewer root is `fixed inset-x-0 bottom-0` with
`top: var(--impersonation-banner-h, 0px)` instead of `h-[100dvh]` in flow —
pinned to the viewport, immune to stale scroll offsets. (2)
`useIosSafeTopFallback`: on iPhone UA, when portrait and
`screen.height - innerHeight < 60` (collapsed chrome ≈ full-bleed; expanded
chrome leaves ~130px), pad the top with `max(env(safe-area-inset-top), 54px)`.
54px clears notch (47–50) and Dynamic Island (54–59) status bars; when env()
reports correctly, max() defers to it. Self-disables on rotation/resize.
(3) New Tailwind raw screen `short:` = `(orientation: landscape) and
(max-height: 520px)`: compact header, hide private-story banner, float the
page-counter row over the book, drop main padding. (4) Text-below reading
mode renders image 58% / text 42% side-by-side under the same media query.
(5) Viewer `isMobile` aligned to `< 1024` matching BookViewer.

**Rationale:** the env() misreport is a WebKit behavior we can't fix or force
out of (programmatic scroll doesn't re-expand collapsed chrome); a measured,
UA-gated fallback that max()es with env() is the only remedy that degrades
gracefully — worst case is ~30px of extra top padding in an already-degraded
state. Landscape stays a second-class citizen by design (portrait is the
product); the `short:` screen makes it usable without a dedicated layout.

**Touched:** `client/src/pages/SharedStoryViewer.tsx`,
`client/src/components/book/BookStoryPage.tsx`, `client/tailwind.config.js`.

---

## 2026-08-01 — Dev panel consolidation: version viewer is the ONLY per-image debug home

**Context:** Owner: "I thought you moved most things to the version viewer,
but now they are all back." The 2026-07-31 unification had only moved
per-version blocks; the page-level dev blocks (Scene Description, API
Prompt, Reference Photos, Quality Score, Object Detection) still rendered
inline under every image and cover in dev mode — perceived as regression,
plus they overflowed on phones.

**Decision (owner-selected via interview, "Everything incl. detection"):**
inline dev info blocks are REMOVED from page and cover cards (all 5 sites:
front/initial/back cover + both page render paths). ReferencePhotosDisplay
(page-level inputs: VB grid, landmarks, empty-scene/composite debug) and the
full ObjectDetectionDisplay (overlay + re-detect) now render inside the
version viewer ("Bild wählen") in a collapsed "Seiten-Debug" section via the
new `pageDebug` prop — they exist nowhere else. Scene Description / API
Prompt / Quality Score inline blocks were deleted outright (per-version
equivalents already in the viewer detail panel). Kept inline: action tools
(Iterate, char repair, Test Models, EvalTestingPanel) and the collapsed
Outline Extract / Scene Prompt / Semantic / Entity summaries.

**Also:** "Bild wählen" with a single version is dev-gated
(`showVersionPicker`: ≥2 for normal users, ≥1 in dev — dev needs the viewer
even at one version because it is the canonical debug home).

**Touched:** `client/src/components/generation/StoryDisplay.tsx`,
`client/src/components/generation/story/ImageHistoryModal.tsx`.

---

## 2026-08-01 — User-editable cover typography (title & dedication): font, effect, colour

**Context:** Editing the story title only updated `storyData.title` — the
title baked onto the cover image stayed stale. Owner also wants users to
choose colour, typography and effects for the title and the dedication text.

**Decision:** Built on the existing app-side typography system (covers are
textless art + composited text; `${key}Art` rows in story_images hold the
textless source per version). (1) `PUT /:id/title` now calls the new
`restampServedCover` — re-composites the active version from its art row
with the new title, no AI call; response carries the new render. (2) User
styling: optional `typographyStyle` stored on the cover object —
front `{ fontId, layout, color }`, dedication `{ font, color }` — honored by
`composeFrontTitle`/`composeDedication` (user colour keeps the 3D side +
outline derivation via `colorsFromFace`; auto palette logic untouched when
unset). `restampCover` reads the stored style, so ALL repaint/repair paths
keep the user's choice. (3) `PUT /:id/cover-typography` endpoint (sanitized
whitelists, `style:null` resets to auto, 409 for pre-typography stories with
no art layer). (4) Client: `CoverTextStylePanel` under the front cover and
the dedication page (user-facing, not dev-gated) — font select (9 title / 5
dedication fonts), effect select (arch/archdown/tilt/straight), colour
swatches + custom picker; each Apply restamps server-side (<1s) and the
updated cover is the preview. Back cover has no user styling (brand only).

**Touched:** `server/lib/coverTypography.js`, `server/routes/stories.js`,
`client/src/components/generation/story/CoverTextStylePanel.tsx` (new),
`client/src/components/generation/StoryDisplay.tsx`,
`client/src/pages/StoryWizard.tsx`, `client/src/services/storyService.ts`,
`tests/manual/test-cover-typography-style.js` (24 checks).

---

## 2026-08-01 — Old-story cover regen was serving TITLE-LESS covers; regen now upgrades them

**Context:** Editable cover text (restamp + typography picker) requires the
`${coverKey}Art` textless layer, which exists only for stories generated
after app-side cover typography shipped (2026-07-19). Worse: regenerating a
cover on an OLDER story rendered textless (current prompts are textless) but
iterateCover's restamp was gated on the Art row existing — so old stories
got covers with NO title at all on regen.

**Decision:** new iterateCover option `forceRestampWhenUnbaked`, set by the
two user-triggered post-generation routes (cover regen + cover iterate).
Safe because the input there is always a fresh textless render. The gate
stays off for the in-pipeline repair path (initial generation bakes later)
and Test Lab. Side effect = the upgrade path: the returned artImageData is
persisted as `${coverKey}Art` vN, so one cover regeneration converts a
pre-typography story to fully editable cover text.

**Touched:** `server/lib/coverIterate.js`, `server/routes/regeneration.js`.

---

## 2026-08-02 — DeepSeek V4 as a cheap reviewer candidate + Test Lab outline-review model comparison

**Context:** The split outline review (2026-07-31) runs a separate Call-2
reviewer, defaulting to Opus 5 ($5/$25 per 1M) — the most expensive text call
in the pipeline. We want to test whether a much cheaper model can review well
enough to replace Opus, but the lab had no way to run the review across models.

**Decision:** (a) Add DeepSeek V4 (`deepseek-v4-pro`, `deepseek-v4-flash`) to
`TEXT_MODELS` + `MODEL_PRICING` via the existing OpenRouter provider (no new
credentials; OpenRouter streaming already exists). 64K `maxOutputTokens` so the
32K review (and the 64K writer draft) aren't truncated. (b) New Test Lab
story-level stage `outline_review`: generates ONE critique-free writer draft
(split mode) from the story's reconstructed creation input, runs the
deterministic scene-consistency pre-check, then runs `buildOutlineReviewPrompt`
through every selected model on that SAME draft — one entry with per-model
review text, cost, tokens, timing, fix-line count, side by side. (c) New
`GET /api/admin/testlab/text-models` serves the model catalogue so the picker
is never a hardcoded frontend list. Production default reviewer stays
`claude-opus` — DeepSeek is testable/selectable, not the default, until an A/B
proves quality. Input is rebuilt from the permanent `stories.data` fields
(story_jobs is pruned ~1h after completion), so the stage works on any story.

**Touched:** `server/config/models.js` (V4 entries + pricing),
`server/lib/testlab.js` (`runOutlineReviewStage`, STORY_STAGES),
`server/routes/admin/testlab.js` (`/text-models`),
`client/src/services/testlabService.ts`, `client/src/pages/TestLab.tsx`,
`client/src/components/generation/ModelSelector.tsx` (V4 selectable for real runs),
`docs/ARCHITECTURE.html` (text row corrected to writer + separate review call).

---

## 2026-08-03 — Test Lab: split, repeated, and cross-model outline review + Qwen3-VL candidate

**Context:** Owner wants to (a) test cheaper/spatial models for image eval, (b) explore whether the outline review improves when run repeatedly (each pass fed the prior critique) and when successive passes use different models, and (c) split the single review into a text pass and a scene pass. All Lab-only for now.

**Decision:** `buildOutlineReviewPrompt(inputData, writerOutput, hints, opts)` gains `opts.aspect` ('both'|'text'|'scene') and `opts.priorReviews`. Aspect slices the analysis body (text = A/B/C/E, scene = D) and gates the reference blocks via `<!-- TEXT_REVIEW -->` / `<!-- SCENE_REVIEW -->` markers in outline-review.txt; `both` + no priors is byte-equivalent to before (production path untouched). The Test Lab `outline_review` stage gains `mode: compare|iterate`: compare = N models on one shared draft; iterate = rounds where each round's critique is fed forward (told to only add what's new), per-round model(s), optional per-round split, reporting fixes-per-round + a converged flag. Qwen3-VL (32B/235B) added to TEXT_MODELS as an image-eval candidate; the eval-stage vision swap is DEFERRED (evaluateImageQuality is Gemini-specific — prompt sanitization, response schema, and Qwen's bbox order [x0,y0,x1,y1] differs from Gemini's [y0,x0,y1,x1]; needs an adapter before it can score correctly).

**Touched:** `prompts/outline-review.txt`, `server/lib/storyHelpers.js` (buildOutlineReviewPrompt aspect/priorReviews + slicers), `server/lib/testlab.js` (runOutlineReviewStage compare/iterate), `server/config/models.js` (qwen3-vl entries + pricing), `client/src/pages/TestLab.tsx`, `client/src/services/testlabService.ts`, `tests/manual/test-split-outline-review.js` (+16 checks, 58 total).

---

## 2026-08-04 — Repair blend: garbage rescue deleted; blend/colour A/B replays a stored model output

**Context:** Exp #259 (char_repair, figure/body mode) left a large soft ghost where the
kneeling figure used to be: Grok re-posed the character to standing, so ~39k px of the old
silhouette fell in the RED ZONE (old mask minus new). Red-zone policy keeps the model's
pixels, and the background matcher only *shifts* their colour (texture preserved by design)
— so Grok's out-of-focus backdrop survived, tonally matched and still blurry. A second
finding: the run's "colour ON/OFF" A/B tested nothing. `colorCorrect` is only consulted in
FACE mode (`if (colorCorrect && !bodyColorMode)`); the variants set no `whiteoutTarget`, so
both sides ran figure mode with `bodyColorMode=true` and the branch never executed. The two
results differed only by model nondeterminism.

**Decision:** (1) The "garbage rescue" is DELETED — `harmonicBackgroundFill` and the
near-white(>235)/near-black(<22) special case in `matchIntroducedBackground` are gone.
Unfilled remnants are handled by feathering and the per-material background match like any
other introduced background pixel; there is no diffusion inpaint anywhere in the blend.
(2) Blend/colour comparisons no longer call an image model: `params.replayOf =
{experimentId, resultIndex}` resolves to the source run's params, its PINNED detection, and
its stored "model raw output" step, so variants differ ONLY by the blend knob. A crop-drift
gate (>1px vs the source crop) fails the run loudly rather than pasting a misaligned reuse.
Exposed as a "Replay blend" button on any result card that stored a raw output.

**Rationale:** The rescue only ever covered a hard-thresholded sliver (622 px of 39095 in
exp #259) while carrying a 400-iteration Laplace solve and its own failure mode (diffusing
scene colour into a region the model had painted correctly). Owner's call: feather it
properly instead of patching remnants. The replay harness exists because every previous
blend A/B was confounded — each side re-called Grok, so ~$0.04 bought two different images
and no isolated variable. Replay is $0 and byte-identical on the model side.

**Known consequence:** a near-white/near-black remnant inside the union interior is no longer
repainted — feathering only reaches the silhouette edge. Verified on a synthetic case: a
white bar in the red-zone interior survives (shifted 255→234 by the material match). Watch
for it if a model starts returning unfilled whiteouts again.

**Touched:** `server/lib/samBlend.js` (matchIntroducedBackground, samUnionBlend doc/log/step
labels), `server/lib/images.js` (harmonicBackgroundFill deleted + unexported),
`server/lib/testlab.js` (resolveReplayParams, runCharRepairStage/runQwenInsertStage hooks,
replay crop gate), `client/src/pages/TestLab.tsx` (BLEND_REPLAY_VARIANTS, replayBlend,
ResultCard "Replay blend").
**Status:** ✅ active (staging).

## 2026-08-04 — Railway memory: heap cap in start.sh, arena cap, staging self-shutdown
**Context:** The Railway bill was dominated by a single line — memory, billed per
resident MB per MINUTE, 24/7. This project's memory cost went $32.92 (May) →
$58.29 (June) → $91.08 (July). Measured over 2 weeks, production sat at
**p50 4.44 GB / p90 4.57 GB** while consuming only ~234 vCPU-min for the whole
month. Median ≈ 90th percentile means the memory was *retained, not used*: a
high-water-mark ratchet, not workload. Staging showed a healthy p50 1.23 GB with
spikes to 9.84 GB — healthy only because it redeploys constantly and each deploy
resets the heap.
**Decision:**
1. Set `--max-old-space-size=3072` **in `start.sh`**, not `package.json`. The
   Dockerfile `CMD` is `bash start.sh`, which runs `node server.js` directly —
   `npm start` is never invoked in the container, so the `--max-old-space-size=8192`
   that lived in `package.json` had **never** applied in production. Node was
   sizing its old-space from the container's large memory allowance instead.
2. `export MALLOC_ARENA_MAX=2` in `start.sh` for both processes.
3. The GroundingDINO idle reaper now calls `_release_memory()` (gc + `malloc_trim(0)`)
   instead of a bare `gc.collect()`.
4. Staging stops itself when provably idle, and only then.
**Rationale:** V8 only collects under heap pressure and never returns grown pages
to the OS, so an uncapped heap ratchets to the ceiling and we pay for the peak
around the clock. glibc compounds it: each malloc arena keeps its own free-list
and never releases it, and both processes here are heavy multi-threaded
allocators (libuv threadpool; torch/opencv). 3072 MB is ~2.5x the observed ~1.2 GB
idle working set — ample headroom for a story run while removing the runway the
ratchet was filling. **Do not lower it without re-measuring: an OOM here kills
in-flight story generation.**

For staging idle cost we deliberately did **not** use Railway's built-in app
sleeping. That decides on inbound HTTP alone and would sleep the container
mid-generation — story jobs run for many minutes in the background, and closing
the polling browser tab would kill a paid run. Instead the app shuts *itself*
down, because it is the only thing that knows whether work is in flight: it
requires no recent HTTP **and** no `story_jobs` in `('pending','processing')`
**and** no registered busy probe, after a 20-min boot grace. Triple-gated
(`STAGING_IDLE_SHUTDOWN=true` + `RAILWAY_ENVIRONMENT_NAME==='staging'` +
credentials present) so it can never fire in production. A probe that throws
counts as BUSY, never as idle.
**Touched:**
- `start.sh` (heap cap + `MALLOC_ARENA_MAX`; the real entrypoint)
- `package.json` (aligned `start` script; `staging:up|down|status`)
- `photo_analyzer.py` (`_gdino_idle_reaper` → `_release_memory()`)
- `server/lib/idleShutdown.js` (new — gates, busy probes, self-stop)
- `server.js` (activity middleware; `startIdleShutdown()` after listen)
- `scripts/admin/staging-power.js` (new — up/down/status, refuses to stop mid-job)
**Status:** ✅ active on staging (heap cap + arenas verified in the boot log:
`Node heap cap: 3072MB | MALLOC_ARENA_MAX=2`). Idle-shutdown ships inert until
`STAGING_IDLE_SHUTDOWN=true` and `RAILWAY_API_TOKEN` are set on the staging
service. Not yet on production — awaiting approval.

---

## 2026-08-04 — Blend feather: the ramp direction was eating the paste (featherMode / padMode)

**Context:** A figure repair on exp #259/#265 left the OLD figure's outline clearly
visible, and `featherPx: 14` sliced the top off the new figure's head (the ceiling
showed through his scalp). Cause is coverage, not blending. The alpha is built as
union dilated +6px (`padPx`), then eroded by `fpx` and blurred — the ramp is carved
INWARD. Measured on the real `samUnionBlend`, alpha just inside the old silhouette
edge: shipped f6 = 172/204/237, first fully-opaque 8px inside the union; f14 =
100/116/139, first fully-opaque 27px inside. So the paste does not cover the region
it is meant to replace, and the ORIGINAL — which in the old-only band IS the old
figure — shows through. The erosion (`blur σ=fpx, thr 200`) bites harder than the pad
(`σ=6/1.5, thr 16`) grows, so even "net 0" settings under-cover.

Erode-then-feather is correct where the union edge is a real content boundary and the
original just outside is untouched background — a face repair whose two masks agree.
It is wrong wherever the union edge is the OLD silhouette.

**Decision:** `featherMode` selects ramp placement — `'erode'` (inward, historical),
`'centered'` (blur only), `'outward'` (dilate then blur: alpha 255 across the ENTIRE
union, falloff beyond it where both sides are background). `padMode` selects pad scope
— `'union'` (historical) or `'newFigure'` (pad only the new figure's anti-aliased edge,
take the old-only boundary exactly). Defaults unchanged and byte-identical: `featherMode`
falls back to `'erode'`, or `'centered'` when `erodeFeather === false`. Threaded through
the Test Lab stage and the production face spine; both A/B-able via Replay blend.

**Measured:** f6 outward = 255 across the union (clean winner). f2 centered = covers.
f12 outward = 244-253 (the post-dilation blur pulls the interior down ~4px). f6 erode
(shipped) = 8px uncovered. f14 erode = 27px uncovered.

**Rejected:** `padMode:'newFigure'` as the halo fix. Removing the outward pad at the
old-only boundary also removes the room the ramp needs — measured 9px uncovered. The
halo (model's unfilled whiteout glow pasted into real background) and the coverage fix
are geometrically opposed at that edge; the glow has to be suppressed by COLOUR, not by
pulling the paste back. Open.

**Affects production face repair:** `faceRepair.js` passes `featherPx`/`erodeFeather`
undefined → feather 6 + erode → the same 8px uncovered ring. That is the
*"faint light edge halo … edge-matting limit, minor"* logged in the 2026-07-2x face
entry — misdiagnosed there. Default NOT changed yet; calibrate via Replay blend first.

**Touched:** `server/lib/samBlend.js` (featherMode/padMode, alpha step label states net
coverage), `server/lib/faceRepair.js`, `server/lib/testlab.js`,
`client/src/pages/TestLab.tsx` (BLEND_REPLAY_VARIANTS A-E).
**Status:** 🟡 conditional — knobs shipped, defaults unchanged pending an A/B.

## 2026-08-04 — Pushes are gated on the target environment being idle

**Context:** every push redeploys and restarts the container, and anything running
in-process dies with it. Two Test Lab outline-review experiments were destroyed this
way in one afternoon (#261, #264 — both left with zero results), by sessions that had
no way to know a run was in flight; five commits landed on `staging` from four
concurrent sessions that day. The same hazard is far more expensive on `master`, where
a deploy kills real users' paid story generations. The existing safeguard was a
CLAUDE.md sentence asking for approval, which nothing enforces.

**Decision:** a versioned `pre-push` hook blocks the push when the target environment
reports work in flight. `GET /api/health/busy` answers from the SAME busy probes the
idle-shutdown watcher uses (`server/lib/idleShutdown.js`), so "busy" has one definition
rather than two that drift. `refs/heads/staging` probes staging, `refs/heads/master`
probes production; every other ref is ungated (no deploy, no risk). Enabled per clone
with `git config core.hooksPath .githooks`; a single push escapes with `--no-verify`.

**Rationale for the failure semantics:** a stopped container is genuinely idle —
nothing can be running inside it — so connection-refused / DNS failure / Railway's
502-503 allow the push. A timeout, a 500, or an unparseable body is *not* proof of
idleness and blocks. HTTP 404 means the environment predates the gate; blocking there
would deadlock (the fix can only ship by pushing), so it warns loudly and allows.

**Also fixed here:** the `story-jobs` busy probe shipped hours earlier read
`r.rows[0].n`, but `dbQuery()` resolves to the ROWS ARRAY, not a pg result object. It
threw on every tick, and a throwing probe counts as busy — so staging's new idle
self-shutdown could never actually fire, and the feature was silently saving nothing.

**Touched:** `.githooks/pre-push` (new), `scripts/admin/check-push-idle.js` (new),
`tests/manual/test-push-idle-gate.js` (new, 17 checks), `server/lib/idleShutdown.js`
(`ensureDefaultProbes` + `busyReport` + testlab probe + the rows fix), `server.js`
(`/api/health/busy`), `CLAUDE.md`.
**Status:** ✅ kept.

---

## 2026-08-04 — Blend: `blendShape 'figure-exact'` — the correct paste construction (figure-repair default)

**Context:** Follow-up to today's featherMode entry. Web research (Laplacian/multi-band
blending, trimap matting, Poisson cloning) + the owner's own spec — "pad, colour-match the
padding, feather without touching the figure, old figure completely overwritten" — against
which the padded-union construction fails structurally: it dilates old ∪ new, so the pad
lands in REAL background at the old-only boundary and carries model pixels (whiteout glow)
outward = the white halo; and any inward ramp exposes the old figure.

**Decision:** `blendShape: 'figure-exact'` in `samUnionBlend`:
1. Paste region = **old ∪ dilate(new, 6px)** — full opacity across the ENTIRE old
   silhouette (nothing old can show through), pad only where it has a purpose (the new
   figure's anti-aliased edge). Nothing pasted beyond the old edge into background the
   original already renders.
2. **Content substitution**: outside the paste region the paste buffer := ORIGINAL, so the
   feather band blends original-with-original — the model is structurally unable to
   contribute any pixel beyond the region, however wide the feather.
3. Ramp forced **outward + one-sided**: after the Gaussian, alpha is clamped to 255 across
   the paste region (the blur tail otherwise bleeds ~10% inward → measured min alpha
   223-228 = faint old-figure ghost). The ramp exists only in the substituted band.

Verified on the real samUnionBlend (synthetic harness, glow band spilling past the old
edge): figure-exact f6/f12 = min alpha 255 over the old silhouette, byte-exact original
outside the old edge, figure interior deviation 0. Legacy padded-union: f6-erode fails
coverage (172) AND halo (194); f6-outward fixes coverage but leaks the glow (252).

**Default:** figure/body repairs in the insert pipeline (testlab runQwenInsertStage,
`!_faceMode`) now default to figure-exact — per "default to the proper fix". FACE mode and
production faceRepair.js keep 'padded-union' (masks nearly coincide; separately calibrated;
flip only after its own A/B). Blend rule stamp: `figure-exact-pad6`.

**Still open:** the red-zone INTERIOR (inside the old silhouette, beyond the new figure)
necessarily keeps model fill — if the model painted blur there, colour-matching preserves
it (texture-keeping is by design). That is an inpainting/IoU-rejection problem, not a
blending one. Multi-band blending remains unimplemented — likely unnecessary now that the
transition band is original-vs-original.

**Touched:** `server/lib/samBlend.js` (blendShape, content substitution, one-sided outward
clamp, dynamic blendRule, viz labels), `server/lib/testlab.js` (body-mode default),
`server/lib/faceRepair.js` (passthrough), `client/src/pages/TestLab.tsx` (replay variants
A-E vs legacy).
**Status:** ✅ active on the figure-repair insert path (staging); face default pending A/B.

---

## 2026-08-04 — figure-exact: local two-band background field + unknown-band matting (kills the white glow ring)

**Context:** Exp #267 (first figure-exact run on the #259 image): the ghost haze was gone
but a white outline ring hugged the figure, and the head appeared sliced at the eyes.
Diagnosis from intermediates: (a) the sliced head is NOT a blend bug — #259 result #1's raw
model output has no head above the eyes (Grok drew the figure taller than the crop; the head
is clipped by the canvas edge; result #2's roll has a complete head — replay that one). The
run passed the IoU gate at ~0.57 vs threshold 0.55 — the gate is the upstream lever.
(b) The white ring had TWO mechanisms: the figure k-means palette was sampled from
dilate(new,3), whose ring IS the glow — so "near-white" became a figure colour and every
glow pixel classified FIGURE → kept (bgPx was 0; the mean-shift never even ran on them).
And the mean shift itself cannot collapse flat glow (255→234, needed ~130).

**Decision (figure-exact only; legacy path byte-identical):**
1. **Positional classification** — zone pixels (red zone + pad ring beyond the 3px edge
   buffer) are background BY CONSTRUCTION (SAM says where the figure ends); no colour-based
   figure rescue there.
2. **Local two-band correction** — out = H + clamp(model − blur(model), ±30), where H is the
   original background diffused across the fill (sources = original outside the old
   silhouette and off the figure; the old figure is excluded as value AND source). Flat glow
   has no high band → becomes exactly the local scene colour; textured model fill keeps its
   texture. Replaces the per-material mean shift, uniformly — no white/black special-casing
   (this is NOT the deleted garbage rescue: no thresholds, one rule for all introduced bg).
3. **Unknown-band matting** — the newBin..newDil edge buffer holds both real anti-aliased
   figure pixels and glow hugging the silhouette. Split per pixel: figure palette from the
   ERODED figure interior (glow cannot be sampled into it), background reference = local H.
   Keep what reads figure, correct what reads local background. Glow beside a same-coloured
   garment stays — invisible by definition, the one case colour cannot split.

**Measured (synthetic harness, real samUnionBlend):** figure-exact f6/f12 now pass all four
properties — old-silhouette alpha 255, byte-exact original outside the old edge, figure
interior deviation 0, red-zone glow 171 → 30 (the texture clamp). Unknown band: 880px glow
corrected, figure edges kept. Legacy padded-union unchanged on every measurement.

**Touched:** `server/lib/samBlend.js` (matchIntroducedBackground localField/oldBin/newBin,
unknown band, H field; samUnionBlend threading).
**Status:** ✅ active on the figure-repair insert path (staging pending push — NOT pushed,
experiments in flight).

## 2026-08-04 — Analyzer memory: per-call cache clear now, model unload only when idle
**Context:** Staging reproduced the production plateau live: the Python analyzer
sat at 3813 MB and did not move for six minutes. Railway logs showed `/figure-mask`
climbing ~300 MB on EVERY call with identical 416x710 input —
`rss=2661 → 3019 → 3301 → 3633 MB` — and those lines print *after*
`_release_memory()` (gc.collect + malloc_trim(0)) has already run. Allocator
fragmentation would have been returned by the trim, so this was live references.
Separately, when the rembg idle reaper fired it returned **1036.7 MB in one step**
(3813.3 → 2776.6 MB) and stayed down, proving malloc_trim works at GB scale.
MobileSAM had no reaper at all, so its ~2.2 GB of retained memory was held until
the next restart.
**Decision:** Split the release by what it costs to redo.
1. **Per call, immediately** — `_free_sam_cache()` drops ultralytics' retained
   `results` / `batch` / `features` / `im` from the predictor. The model object
   stays loaded. Runs in both the success and error paths of `/figure-mask`.
2. **Only when idle** — the model itself is unloaded by `_idle_model_reaper`
   after `MOBILESAM_IDLE_UNLOAD_S` (900s), matching rembg and GroundingDINO.
3. `POST /release-memory` (proxied by admin-only `POST /api/health/release-memory`)
   forces a trim on demand, so reclaiming RAM no longer requires a redeploy —
   a redeploy restarts the container and destroys whatever you were measuring.
**Rationale:** The retained tensors are dead the moment the PNG is encoded —
`results`/`batch` are masks already serialised, and `features`/`im` are embeddings
for that one image, which the next (different) image recomputes anyway. So
clearing them per call costs zero recomputation. Unloading the *model* is a
different trade: mid-story that forces a ~570 MB reload on the very next page, so
it stays warm while work is flowing and is dropped only after real idleness.
The error path clears too because repair retries the same crop, so a run of 500s
stacked ~300 MB each — that was the worst leak observed.
Ultralytics internals vary by version, so the clear only touches attributes that
exist and logs failures instead of 500ing a repair.
**Touched:** `photo_analyzer.py` (`_free_sam_cache`, `_idle_model_reaper`
MobileSAM branch, `/release-memory`, `/figure-mask` both paths, `/health?probe=sam`),
`server/routes/health.js` (`/api/health/memory`, `/api/health/release-memory`).
**Status:** ✅ on staging. Production still unpatched — awaiting approval.

---

## 2026-08-04 — Red-zone fill source: the page's EMPTY SCENE (clean plate), tone-aligned

**Context:** Exp #268 confirmed the white ring is gone under figure-exact, but the old
figure's footprint rendered as a pale ghost blob — the colour-diffusion H field can only
produce smooth washes, never tiles/sunlight/texture. The pipeline already stores the real
answer: the page's empty scene (the style anchor the page was generated from — same room,
no figures). Measured alignment vs the final page background: ~13-22 mean |diff| per
channel (structurally aligned; regeneration tone drift only).

**Decision:** figure-exact red-zone fill uses the EMPTY SCENE crop as content. Tone drift is
corrected by diffusing the DIFFERENCE (original − plate), known at every valid background
pixel around the region, inward across the fill: H = plate + smooth alignment field. Plate
pixels are used as-is (no model texture on top — the plate has real texture). Fallback when
a story has no empty scene: the colour-diffusion wash. The plate crop is emitted as a step
("clean plate (empty scene crop)") and the fill source is logged either way.

**Verified (synthetic):** plate checker texture appears in the red zone (16-level swing,
structure preserved), tone aligned across a deliberate 12-unit drift, figure byte-untouched;
all four figure-exact properties still pass; legacy path unchanged.

**Touched:** `server/lib/samBlend.js` (cleanPlateBuf, plate fill + difference-field
alignment), `server/lib/testlab.js` (runQwenInsertStage loads + crops the empty scene,
plate step).
**Status:** ✅ active on the figure-repair insert path (staging).

## 2026-08-04 — Test Lab outline_review must stream: non-streaming hits undici's 300s headers timeout

**Context:** experiment #270 (compare, 4 reviewers) ran 15 minutes and returned zero
reviews. Railway logs give the exact shape: writer call starts 19:31:07, `fetch failed`
at 19:36:08, again at 19:41:09, again at 19:46:09 — three attempts of ~301s each, then
the target is recorded as failed. 301s is not the app's own AbortSignal (which computes
`max(300000, 180000 + 64*3000)` = 372s for a 64k-token call); it is **undici's default
`headersTimeout` of 300000 ms**. A non-streaming request receives no response headers
until the entire completion is written, so any draft that generates for more than five
minutes fails, and `withRetry` classifies `fetch failed` as retryable and burns it three
times. Experiment #258 only passed because its writer finished in 187s — this is a
cliff, not a slowdown, and the prompt in #270 was 95,664 chars.

**Decision:** `runOutlineReviewStage` uses `callTextModelStreaming` for both the writer
and the reviewer calls, matching what production already does for the same two calls
(`server.js` unified writer + review). Streaming receives headers immediately, so the
headers timeout never applies.

**OpenRouter closed the same day:** `callOpenRouterAPIStreaming` implements the SSE path
(OpenAI-compatible, mirroring the xAI one), so DeepSeek/Qwen/GLM/Kimi stream too — no
`undici` dependency needed. Two things that path must get right: only `delta.content` is
accumulated, because reasoning models also stream `delta.reasoning`, which the
non-streaming path never returned and which would corrupt every parsed response; and the
`: OPENROUTER PROCESSING` keep-alive comments reset the inactivity timer, so a slow model
still queued upstream is not killed at 120s.

**Measured** (exp #270's exact config, whole stage end to end, 528.2s): writer
claude-sonnet 346.2s / 58,895 chars; reviewers deepseek-v4-flash 68.3s (5 fixes,
$0.0034), deepseek-v4-pro 144.2s (58 fixes, $0.0214), qwen3-vl-235b 108.3s (7 fixes,
$0.0079), claude-sonnet 181.5s (15 fixes, $0.2197). All four had returned nothing before.

**Also fixed:** the streaming fallback called `callTextModel(prompt, maxTokens,
modelOverride)` without `options`, dropping `usageLabel` — every OpenRouter call routed
through the streaming entry point was recording its tokens unattributed.

**Touched:** `server/lib/testlab.js` (both calls in `runOutlineReviewStage`),
`server/lib/textModels.js` (`callOpenRouterAPIStreaming` + dispatcher case; fallback
passes `options`).
**Status:** ✅ kept — every provider streams.

---

## 2026-08-04 — figure-exact red zone: SEAMLESS-CLONE OFFSET (owner spec) — plate fill REVERTED

**Context:** The empty-scene plate fill (earlier today) was built without being asked and
the owner rejected it: the footprint must keep the MODEL's pixels ("it needs the pixels of
the new image — but colour adjusted; the one thing that should be adjusted is the border").
The diffusion wash was equally wrong (#268: old silhouette readable as a flat cream shape —
a wash cannot produce tiles/sunlight, and its boundary IS the old mask).

**Decision:** figure-exact correction = Poisson-style seamless clone, 0th order:
out = model + O. O = (original − model), known exactly at every valid-background pixel
(outside the old silhouette, off the figure), diffused across the zone with a SCREENED
solver (λ=0.012): O relaxes toward the robust per-material tone offset (median over the
sampling ring — glow cannot skew a median). Border: paste equals the original exactly, seam
impossible. Interior: model content and texture pass through with only the small tone
shift. Boundary anomalies (glow just outside the old edge, O≈−120) act locally (~10px)
instead of corrupting the interior (pure harmonic measured −50 on correct content).
Plate fill and H-field replacement DELETED (samBlend + testlab loader + step).

**Measured (synthetic):** border byte-exact; interior checker kept at tone (116-128 vs 92-97
corrupted under pure harmonic); glow rim fades 150→213 over 8px instead of a hard 250 band.
**Known limit (by construction):** a wide flat glow rim cannot be fully erased by a
border-only colour correction — it fades, it doesn't vanish. If the fade still reads as a
defect on real images, the lever is upstream (whiteout prompt / IoU gate), not the blend.

**Touched:** `server/lib/samBlend.js` (localField → screened offset field; plate/H deleted),
`server/lib/testlab.js` (plate loader deleted).
**Status:** ✅ active (staging pending push). Supersedes today's plate-fill entry.

---

## 2026-08-04 — Symmetric seam collar: the transition splits across BOTH sides of the old edge

**Context:** Owner correction: "both sides are Grok" — the page itself is model-generated
art, so the old-silhouette seam is a panorama stitch between EQUAL renders, not
truth-vs-guess. A one-sided inward fade concentrates the whole residual ramp inside and
leaves a derivative kink at the border.

**Decision:** figure-exact adds a ~5px SEAM COLLAR outside the old edge, inside the paste
region. Collar pixels join the offset diffusion as domain (not hard-pinned), INITIALIZED at
their exact per-pixel offset and leashed to it (λ_collar 0.25 vs interior λ 0.012): small
seam residuals split symmetrically across both sides (measured: no-glow seam = 127-137
across the whole transition, kink-free), while large corrections are never abandoned —
relaxing the collar freely was measured to re-expose glow at 235+. Content in the collar
cannot ghost: model + exact offset is byte-identical to the original, only the smooth
relaxed residual rides on top. Alpha-fade in both directions is impossible by geometry:
under the paste inside the old edge sits the OLD FIGURE (inward alpha mixes it back), and
outward alpha with raw model = the halo.

**Measured:** no-glow seam symmetric and kink-free; glow case: collar holds ≈130, rim fades
inside, interior keeps model content at tone; P1/P2/P3 all pass (P2 max 140); legacy path
byte-identical.

**Touched:** `server/lib/samBlend.js` (seamCollar construction, alpha1 extension, two-leash
screened diffusion).
**Status:** ✅ active (staging pending push).

---

## 2026-08-04 — Offset field: GLOBAL tone target — per-material screen target warped content (exp #271 C blob)

**Context:** #271 C showed a bright cream blob with a crisp contour + hard navy patch in the
old footprint — contrast that exists in NEITHER source (the raw model backdrop there is a
smooth warm floor with a soft shadow; verified against a naive rect-paste). Owner verdict:
implementation bug, correct method. ALSO found: #271's variant labels lie — the replay of
#268 result #1 (variant B) inherited featherMode 'outward' into every variant that didn't
override it, so "A: legacy f6 erode" actually ran padded-union+outward (its own step label
proves it: "ramp outward → net coverage 12px"). The praised "A" is the padded-union
OUTWARD construction.

**Mechanism (reproduced pre-fix vs fixed):** the screened diffusion's resting target was the
per-material median offset with HARD nearest-cluster assignment per pixel. Deep in the
footprint the screen dominates, so each pixel snaps to its material's median; where the
model's SMOOTH gradient crosses the cluster decision boundary the offset flips between
medians → a dip-and-rebound wave stamped into smooth content (synthetic, 2 materials: ±20
band at the boundary; the real page has 5 materials incl. sunbeam and shadow → plateaus =
posterized blobs). The fixed field (single GLOBAL median tone target) tracks the model's
structure exactly — monotonic, parallel to the source — with locality still carried by
diffusion from the exact border offsets.

**Decision:** localField screen target = ONE global median tone offset. Per-material
machinery removed from the offset field (stays in the legacy mean-shift path untouched).

**Trade-off accepted:** deep interior colour can sit further from the ORIGINAL's per-region
tone than the per-material version — irrelevant by the owner's contract: deep interior is
model content, not adjacent to any original; smoothness beats per-region tone accuracy.

**Touched:** `server/lib/samBlend.js` (globMed-only screen target).
**Status:** ✅ committed, pending deploy + replay verification on the real page.

## 2026-08-04 — Analyzer self-recycles: only process exit reclaims fragmentation
**Context:** After the reapers unload every model, the analyzer still held
1192 MB (fresh boot is 137 MB). A FORCED `malloc_trim(0)` with all models
unloaded moved it 1192.2 → 1192.9 MB — it reclaimed nothing. The residue is
fragmentation plus torch's own pools: glibc can only return a page when the
whole page is free, and after thousands of interleaved tensor allocations most
pages hold something live. Unloading models returns their weights (measured:
1037 MB rembg, 740 MB GroundingDINO); nothing in-process defragments the rest.
**Decision:** The analyzer exits itself when idle AND above `RECYCLE_RSS_MB`
(700), and `start.sh` supervises it back up. Gated on zero in-flight requests
and `RECYCLE_IDLE_S` (180s) of quiet, so it cannot land mid-story. A trim is
attempted first and the restart is skipped if that alone gets under the
threshold. `POST /release-memory?recycle=true` forces it, and refuses while
other requests are in flight.
**Rationale:** A story is NOT a subprocess — the job runs inside the long-lived
Node process and every analyzer call is HTTP to one Flask process that has been
up since boot. So story #1's fragmentation is still resident for story #500, and
no story boundary reclaims anything. Ending the process returns 100% to the OS,
and Railway bills that RSS every minute. A literal fork-per-inference would also
work and was rejected: each call would reload MobileSAM/GDINO (~570 MB, seconds)
inside the repair loop. Idle-gating puts the restart at the story boundary in
practice without cross-process coordination or any risk to a concurrent story.
**Gap, now CLOSED:** a request arriving during the ~10s restart got a connection
error. figure-mask falls back to Gemini, but `/remove-bg` and the photo-upload
path have no fallback, so a user would simply see their upload fail. Scheduling
alone can only shrink that window, never close it — a user can always arrive
mid-restart. Closed with two changes:
1. `server/lib/analyzerClient.js` — `analyzerFetch()` retries CONNECTION errors
   only (ECONNREFUSED/ECONNRESET/…), 3x at 4s, covering ~12s of downtime. HTTP
   500s are real answers and are deliberately NOT retried.
2. `ensureWarm()` preloads models when a user is active — on photo upload and at
   story creation, whose first minutes are Claude calls that never touch the
   analyzer. Warming also counts as a request, so the idle window cannot open
   while someone is using the app, and repair never pays the ~570MB MobileSAM
   load mid-loop.
**Touched (gap fix):** `server/lib/analyzerClient.js` (new), `server/lib/rembg.js`,
`server/routes/photos.js`, `server/routes/jobs.js`, `photo_analyzer.py` (`/warmup`).
**Touched:** `start.sh` (supervisor loop), `photo_analyzer.py`
(`_track_request_start/end`, `_recycle_watchdog`, `/release-memory?recycle=true`).
**Status:** ✅ staging.

---

## 2026-08-05 — figure-exact FINAL: two-band footprint (owner-verified goal: old outline invisible)

**Context:** Owner goal: "the outline where the old figure was must not be seen after a
successful repair — run experiments yourself and look." Root cause of every previous
residual: the model's own output CARRIES the old outline (Grok under-paints the whiteout
silhouette), so any keep-model-content rule reproduces the ghost (#274: A and C differed by
mean 2.0/channel — the blob is in the content, not the blend). The two-band idea from #268
was correct; its implementation failed twice (unconverged fine-grid Jacobi + cluster
seeding → flat wash blob).

**Decision — the footprint rule (localField):** out = LB + w·clamp(model − blur(model), ±40).
LB = original's low band with the old figure masked OUT of the blur (normalized masked
convolution — it cannot ghost), solved coarse-to-fine (8px grid, 400 iters, bilinear
upsample, 60 fine iters — CONVERGES across 100px+ regions). w fades model texture from 0 at
the old edge to 1 over ~8px (no texture step at the seam). Pad ring outside the old
silhouette takes the original exactly. Plus three mask fixes found by LOOKING at local
runs with real SAM masks:
1. Old mask dilated ~1.6σ into the footprint AND into alpha1 — the original's painted INK
   OUTLINE sits just outside SAM's fill mask and survived as a thin dark line tracing the
   old silhouette.
2. Figure buffer tightened to ~1.5px (newTight) — the 3px buffer preserved a pale strip of
   whiteout glow hugging the trouser edge.
3. Island filter keeps ALL union components intersecting the padded detection box in
   figure-exact — the old kneeling foot (severed by the wand in mask space) was dropped and
   survived as an orphan sandal on the floor.

**Verified:** 4 local experiments on the real page with real MobileSAM masks (local
photo_analyzer): head-clipped roll → clean footprint, no outline; full-head roll → complete
boy, no outline, no orphans. Synthetics: ghost blob erased (dev 3), texture survives, seam
step 8, outside untouched, figure byte-crisp; P1-P3 pass; legacy path byte-identical.
Superseded on the way: seamless-clone offset field + symmetric collar (removed — content
preservation preserves the ghost), plate fill (removed earlier).

**Touched:** `server/lib/samBlend.js` (localField rewrite, alpha1 old-dilation, island
keep-in-box).
**Status:** ✅ shipped as the figure-repair default.

---

## 2026-08-05 — Footprint texture confidence + local-reference edge band (exp #275 residuals)

**Context:** #275 C (first two-band run on staging) — owner flagged: (1) a CRISP dark line
where the old knees were, absent from the model output; (2) white glow pixels around the
head. (1) is a two-band artifact: the model's soft shadow is low-frequency in its body but
high-frequency at its EDGE — LB removed the body, the edge survived as an orphaned dark
stroke. (2) the edge band's figure test used a GLOBAL palette containing the white shirt,
so white glow matched "figure" everywhere on the silhouette.

**Decision:** (1) texture confidence — model high band is weighted by low-band agreement
(conf = 1 − |lowModel − LB|/35): where the model's low band was overruled, its edges die
with it. (2) edge band judged against the LOCAL figure colour (normalized masked blur of
the model over the eroded figure interior): glow beside brown hair is judged against hair,
not the shirt. Verified on the full-head roll (local, real SAM masks): knee stroke gone,
head halo 773→1992px corrected and visually near-gone; T1-T5 + legacy identity all pass.

**Known residuals (content ceiling, owner decision pending):** soft haze where the old
figure was (the field has no tile lines to offer) + the model's own shadow remnants. Options
on the table: empty-scene plate (rejected once), IoU gate raise (~0.65) to re-roll re-posed
outputs, or accept.

**Touched:** `server/lib/samBlend.js` (confidence weight, local-reference band).
**Status:** ✅ shipped.

---

## 2026-08-05 — Footprint: structure-confidence blend (owner catch: crisp curtain wiped to blur)

**Context:** Exp #276 B vs C (owner): left of the figure, legacy-B shows Grok's crisp painted
curtain continuation; figure-exact C shows one blur. Cause: the two-band rule replaces the
model's LOW band unconditionally — curtain folds/window shapes ARE low-frequency, so
legitimate content died with the ghost. Yesterday's low-band-agreement confidence gate made
it worse (crisp content disagrees with the field by construction).

**Decision:** per-pixel STRUCTURE confidence: m = smoothed local high-frequency energy of
the model (×edge fade). out = m·(model, broad-tone-aligned via blur σ20 of LB−lowModel) +
(1−m)·LB. Flatness is what separates under-painted whiteout from real content: flat ghost →
field; textured content → kept at ALL frequencies, tone-aligned only broadly. Replaces the
low-band-agreement gate and the ±40 texture clamp.

**Verified (synthetic):** flat ghost erased (dev 9) AND a striped "curtain" deep in the
footprint keeps full contrast (swing 62); seam 7, outside untouched, figure byte-crisp.
Lab verification: replay of the #274 r0 chain (next experiment) — per the new rule, all
real-image experiments run in the Test Lab, never as local scripts.

**Touched:** `server/lib/samBlend.js`.

---

## 2026-08-05 — Leg-gap glow specks: solve domain + band reference (exp #279 residual)

**Context:** Owner: white specks between the legs in #279 C. The gap between the trouser
legs is inside the OLD silhouette, and the newTight dilation bridges the thin slot. The
edge band's background reference there was the ORIGINAL — i.e. the old boy's dark torso —
so white glow read as "not background" and was kept. Additionally the LB field was never
solved in that slot (the solve domain excluded everything under newTight), so no valid
reference existed.

**Decision:** the LB solve domain is Fs = old ∧ ¬newBin (everything old that is not actual
figure — the field is DEFINED in thin gaps), while the paste domain stays F = old ∧
¬newTight. The edge band's background reference is LB whenever the pixel is inside the old
silhouette, the original otherwise — the original is never consulted where it depicts the
old figure.

**Verified (synthetic):** white glow in a 6px between-legs slot collapses (max channel 250 →
132) with legs byte-untouched; full battery (ghost, curtain crispness, seam, outside,
figure) all pass.

**Touched:** `server/lib/samBlend.js`.

---

## 2026-08-05 — White specks between the legs: MODEL content, not blend residue (verdict: not blend-fixable)

**Context:** Owner flagged white specks between the trouser legs (#279/#283 C). Traced
per-pixel: final = model byte-identical at every speck AND across the whole slot — the
bright strip is Grok's own lit rim along its inner-leg edge, against Grok's own slot
shading, present in the raw output. SAM's round-2 mask BRIDGES the slot (verified from the
cutout step), so the strip is deep inside "figure" where the blend keeps pixels by design.

**Measured separability — none:** speck strip local energy 37 (HIGHER than real edges),
shirt bright areas energy 6 with 1626 bright+flat px — every brightness/flatness rule that
removes the strip removes shirt/highlight content elsewhere. A deep-rim colour test (4px
into the mask) was implemented, benchmarked (zero effect on the real image — the strip is
~20px inside the bridged mask) and reverted.

**Decision:** not fixable in the blend without risking real figure content. Levers are
upstream: whiteout-prompt hardening ("paint the silhouette fully to its edge, no light rim"),
QC on the model output, or the IoU gate. Kept from this round: the Fs solve domain and the
band background-reference fix (correct on principle; synthetic leg-gap glow collapses when
SAM does NOT bridge the slot).

---

## 2026-08-05 — Elongated bright rim removal (owner correction: "the specs are ON the outline")

**Context:** Earlier verdict "not blend-fixable" was wrong in its conclusion. Colour
statistics genuinely cannot separate the specks (energy 37, brightness ≈ shirt) — but SHAPE
can, which is what the eye uses: rim residue is a thin ELONGATED strip along the figure's
content outline; legitimate bright details (buttons, hem highlights) are compact. Colour-vote
extensions were tried first and failed measurably (a 10px strip dominates its own σ10
reference — T7c).

**Decision:** inside old-silhouette figure territory, flag bright outliers vs their σ8
neighbourhood (min-channel +30), connect them, and remove ONLY components with ≥5:1
elongation and ≥12px — replaced by the reference field (now solved under bridged masks:
Fs = all old pixels). Compact components are never touched.

**Verified (synthetic):** 4×110 white strip inside a SAM-bridged slot removed (248→128); a
6×6 bright button 20px away byte-untouched; legs, ghost, curtain crispness, seam, figure
all pass.

**Touched:** `server/lib/samBlend.js`.

---

## 2026-08-05 — Production BODY repairs default to the figure-exact blend

**Context:** Owner: "this is hooked up to the story as well?" It was not — the calibrated
blend (figure-exact + two-band footprint + structure confidence + rim removal, Lab
#278-#288) was Test-Lab-default only; production `faceRepair.js` still defaulted every
repair to legacy padded-union.

**Decision:** `faceRepair.js` body repairs (faceOnly=false) now default
`blendShape:'figure-exact'`. Face repairs keep 'padded-union' until their own A/B (head
masks nearly coincide — the figure-exact benefits target the old-figure footprint, which a
face repair barely has). `opts.blendShape` overrides both ways, so the Test Lab can A/B
either.

**Touched:** `server/lib/faceRepair.js`.
**Status:** ✅ staging — a staging story run's automatic whole-figure char-repair now uses
the calibrated blend.

---

## 2026-08-05 — Lab: replay reduced to FINAL + RAW; Treatment dropdown exposed

**Context:** Owner: show the real result FIRST; drop the 5-variant calibration set; add a
RAW comparison ("the new input for the full union cropped on top, without any blending") so
the blend's contribution and the model's own defects separate visually. Also: the treatment
axis (whiteout / crosshatch / blur / cutout) was hidden — the Engine dropdown said "Grok
(blended)" but backend:'grok' actually routes to the whiteout-insert pipeline.

**Decision:** (1) Replay-blend runs TWO cards: "1: FINAL — production blend" then "2: RAW —
union paste, no blending" (`rawPaste:true` in samUnionBlend: same old∪new paste region,
model content hard, no colour work, no field, no feather, binary alpha). FINAL−RAW = the
blend's contribution; defects in both = model output. (2) char_repair form gains a
Treatment dropdown for Grok: Whiteout (insert, default) / Crosshatch (fullscene) / Blur
(blended) / Crop (cutout) — the legacy repairModes made explicit; the misleading "Grok
(blended)" label fixed.

**Touched:** `server/lib/samBlend.js` (rawPaste), `server/lib/testlab.js` (threading),
`client/src/pages/TestLab.tsx` (variants, Treatment dropdown).

---

## 2026-08-05 — Lab: Zoom (crop pad) exposed on the char-repair form

**Context:** Owner: "we also have 2 zooms — full image or the character cut out padded by
50%/100% — why is that not an option?" The knob existed (`params.cropPad`, default 0.35
whole-figure / 0.15 insert; `params.crop` for an explicit rect) but only via params JSON, so
the axis was invisible in the form.

**Decision:** Zoom dropdown — Default (tight, +35%) / Figure +50% / Figure +100% / Full page.
'full' sets `crop:{x:0,y:0,w:1,h:1}` (whole page to the model), a number sets `cropPad`.
Added `repairMode`, `cropPad`, `crop` to WIDGET_PARAM_KEYS and the re-run prefill so
"re-run with changed settings" restores Treatment and Zoom instead of dumping them into the
JSON box.

**Why it matters:** zoom is a real quality axis, not cosmetics — more context helps the model
match lighting/perspective but shrinks the figure's pixel budget; full-page keeps global
composition at the lowest figure resolution. Now A/B-able like any other knob.

**Touched:** `client/src/pages/TestLab.tsx`.

---

## 2026-08-05 — Lab: compare checkboxes silently discarded Engine/Treatment/Zoom; replay ignores model-facing knobs

**Context:** Exp #294 (owner): asked for crosshatch treatment + a wider crop, got whiteout at
the stored crop with colour ON/OFF variants. Two independent bugs, both silent.

**Bug 1 — compare branches discarded the form.** `start()` built variant lists with
hardcoded params and never merged the widget state, so ticking "Compare colour ON vs OFF"
(or "Compare ALL engines") threw away Engine / Treatment / Zoom / Repair without a word.
**Fix:** a `base` object (backend, whiteoutTarget, repairMode, cropPad|crop) is built once
and spread into EVERY variant; a compare checkbox now varies only its own axis. Compare-ALL
keeps its per-option treatment/engine but inherits the chosen Zoom.

**Bug 2 — re-running a replay keeps `replayOf`.** A replay reuses a stored model output, so
Treatment and Zoom (what the model SEES) cannot take effect; #294 inherited `replayOf` from
#292 via the params-JSON box and silently ignored both. **Fix:** if `replayOf` is set and a
model-facing knob is chosen, confirm — OK drops the replay and calls the model for real
(~$0.02/variant), Cancel clears Treatment/Zoom and keeps the free replay.

**Touched:** `client/src/pages/TestLab.tsx`.

## 2026-08-05 — Push gate must be enabled by npm install, with an ABSOLUTE hooksPath

**Context:** the pre-push idle gate shipped needing `git config core.hooksPath .githooks`
per clone. Test Lab experiment #297 was still killed mid-run by a push from a parallel
agent session. The endpoint was correct at the time (`/api/health/busy` →
`{busy:true, reasons:["testlab: 1 experiment(s) running"]}`); the hook simply never ran.

**Root cause:** `core.hooksPath` lives in the shared `.git/config`, so worktrees DO
inherit it — but the value was the RELATIVE path `.githooks`, and git resolves a relative
hooksPath per WORKING TREE. The agent worktrees under `.claude/worktrees/` are checked
out on branches older than the hook commit, so `.githooks/pre-push` does not exist there.
**Git skips a missing hook silently, exit 0** — no warning, no failure, push proceeds.

**Decision:** `scripts/admin/setup-git-hooks.js` sets `core.hooksPath` to the main
clone's ABSOLUTE path and is wired to package.json `prepare`, so `npm install` configures
it and no one has to be told. The hook resolves the gate script relative to ITSELF rather
than `git rev-parse --show-toplevel`, because an old-branch worktree has no
`scripts/admin/` either. The idempotency check compares the RAW stored value and rejects
a relative one — resolving it first would make the broken setting look correct.

**Verified:** from a worktree with no `.githooks` in its checkout, the hook now executes
and reports `✓ staging is idle`.

**Residual risk:** `--no-verify` still bypasses, and a clone that never runs `npm install`
is unprotected. Server-side enforcement would need to gate the DEPLOY rather than the
push; not built.

**Touched:** `scripts/admin/setup-git-hooks.js` (new), `.githooks/pre-push`,
`package.json`, `CLAUDE.md`.
**Status:** ✅ kept.

---

## 2026-08-05 — Lab: experiment-list size picker (20 / 50 / 100 / 200)

**Context:** The list loads the last 20 of the past 7 days — right default, but older runs
were unreachable from the UI. The server already accepted `?limit=` (cap 200) and `?all=1`;
the client never sent either.

**Decision:** "Show" picker in the Past-experiments header: last 20 / 50 (7 days) or last
100 / 200 (all time). ≥100 sends `all=1` so the 7-day window doesn't hide older runs.
`getExperiments()` takes `{limit, days, all}`.

**Touched:** `client/src/pages/TestLab.tsx`, `client/src/services/testlabService.ts`.

## 2026-08-05 — Cover title: glyph-conditioned PAINT-IN, never model-spelled (closes the 2026-07-11 open question)

**Context:** The app-side title lockup (`coverTypography.composeCover`) spells perfectly but
reads as a flat graphic pasted on the art. The obvious alternative — have the image model draw
the title — is what garbles letters, and the owner explicitly rejected "retry three times and
hope an eval catches the wrong letter". Web research (Aug 2026) put the ceiling for free text
generation at ~90-95% on short copy (Ideogram 4 best, GPT Image 2, Qwen-Image), with the failure
mode concentrated on umlauts/accents — i.e. ~1 in 10 German/French covers garbled, and single-letter
errors are exactly what a VLM judge misses.

**Decision:** The letters always come from a font file; the model only styles them.
Test Lab stage `cover_title_paintin`: composeCover renders the real-font title → pixel-diff vs the
textless plate yields the exact glyph mask → dilate (~1.2% of the short side) → crop the title region
+5% and send ONLY that crop to Qwen `qwen-image-edit@2511` ($0.008) with the story's ART_STYLES text →
mask-gated paste-back at exact coordinates → **OCR exact-match gate** (utility vision model,
temperature 0, "copy exactly, do not correct"; whitespace-collapsed, case-insensitive because several
title fonts are uppercase-only, DIACRITIC-SENSITIVE). Gate FAIL ⇒ keep the flat composite.

**Rationale:** This is the GlyphControl / AnyText / Glyph-ByT5 principle (pre-rendered glyphs as the
condition took design-image text rendering from <20% → ~90%) implemented on models we already pay for.
Qwen's single strongest documented capability is editing text *already present* in an image while
preserving font/size/style — it never has to invent a letterform. Crop-bounding is the rule already
established by the Qwen composite experiments (full-frame edits re-imagine the scene). Mask gating
makes the artwork outside the letters pixel-identical **by construction**, and the OCR gate is
deterministic rather than a judge, so a garbled title cannot ship — it is structurally excluded, not
merely made less likely.

**Rejected:** routing the title to Ideogram 4 / GPT Image 2 free generation — best integration when it
works, but ~90% first try, weakest exactly on our diacritics, and it still needs the same OCR gate plus
a fallback path. Re-test in this stage if paint-in disappoints.

**Touched:** `server/lib/testlab.js` (`runCoverTitlePaintinStage`, `transcribeTextInImage`,
`TITLE_PAINTIN_PROMPT`), `client/src/services/testlabService.ts`, `client/src/pages/TestLab.tsx`
(OCR-gate card block), `docs/cover-text-rendering-research.md`, `docs/image-routing.md`.

**Status:** 🟡 built, NOT yet run — no verdict on whether Qwen adds real medium inside a mask this thin.
Supersedes the 2026-07-11 "cover text baked vs overlay" open question: the answer is neither, it is
overlay-then-paint-in.

---

## 2026-08-05 — Repair prompt: visible in the Lab, and whole-figure gets the scene's expression/pose

**Context:** Owner on exp #302: "you are not showing the prompt — this must be added. Are we
telling the position and especially the emotion? We should." Both were real gaps:
- The card showed `promptUsed` only under "Show details", and the LEGACY treatments
  (crosshatch/blur) showed none at all — `runCharRepairStage` dropped the spine's
  `promptSent`.
- The Lab's whole-figure insert prompt carried clothing + style but NOT the scene's
  expression / pose / action / gaze / holding. `faceRepair.buildActionContext` builds exactly
  that from scene metadata and was used for FACE repairs only. #302's crosshatch returned a
  startled, blushing child for a scene whose metadata says smiling — the model had no state
  to preserve, so it invented one.

**Decision:** (1) prompt rendered at the TOP level of every result card (collapsed
`<details>`, char count in the summary). (2) `runCharRepairStage` forwards
`result.promptSent` → `promptUsed`. (3) whole-figure insert prompts append
`buildActionContext(...)` (exported from faceRepair) — the same state block the face path
gets. (4) the insert prompt also gained an explicit fill-to-edge clause ("Paint the
silhouette FULLY to its edge — no light rim, halo or unpainted border") against the
under-paint rim traced in #279–#288.

**Touched:** `server/lib/testlab.js`, `server/lib/faceRepair.js` (export),
`client/src/pages/TestLab.tsx`.

## 2026-08-05 — Age-marker ladder: 14 distinct buckets, each bounded on both sides

**Context:** an 8-year-old was described to the image model as "very young child
proportions about 4.5-5 heads tall, clearly shorter than school-age kids".

**Not a routing bug.** `physical.apparentAge` is deliberately primary over the stated
age — real 8-year-olds range from looking 6 to looking 10, and the photo is the better
guide to how the child should be drawn. `clampApparentAge()` (called from
`routes/avatars.js`) already bounds that read to ONE bucket from the stated age, the same
tolerance `image-evaluation.txt` applies ("a 7-year-old reading as 6 → NO deduction").
Lukas: stated 8 = `young-school-age`, photo = `kindergartner` = exactly one bucket. Legal.
An earlier attempt to make the stated age win was REVERTED — it would have discarded the
whole reason age comes from the picture.

**The defect was merged buckets.** One string served preschooler (≤4) AND kindergartner
(5-6): a 3-to-6 span phrased at the bottom of its own range. Because drift of one bucket
is allowed, a bucket phrased at its neighbour's age turns a legal drift into a
two-bucket error. Audit found three more instances: infant+toddler shared "baby
proportions" (so a preschooler reading one young became a BABY); young-school-age+
school-age shared one string (a 10-year-old described identically to a 7-year-old);
senior+elderly shared one string with NO head-height at all, despite the code's own note
that head-height is the strongest cue and models ignore adjectives. preteen (6) also
overlapped school-age (5.5-6), leaving no gap to render.

**Decision:** 14 distinct strings, monotonic, no ties below adult —
3.5-4 / 4 / 4.5 / 5 / 5.5 / 6 / 6.25 / 6.5 / 7 / 7.5-8 (adults) / 7.5. Every bucket names
BOTH neighbours ("clearly taller than X, not yet Y") so one step of drift cannot drag a
render to an extreme. Elderly keeps 7.5 heads rather than dipping: the head-to-body RATIO
does not shrink with age, so a lower number would ask for a smaller-headed figure —
reduced stature is expressed as posture instead.

**Verified** through `buildCharacterPromptBlock`: 14/14 unique, monotonic, every bucket
bounded both sides with a head-height anchor.

**Note:** the code landed inside commit `0258a3cb` (a concurrent session staged the whole
working tree), whose message does not mention any of this — hence this entry.

**Touched:** `server/lib/storyHelpers.js` (`getAgeMarkers`).
**Status:** ✅ kept. Affects production image generation for characters whose bucket was
previously merged.

## 2026-08-05 — Title paint-in: crop width is a CONTEXT lever; sets stay generic (no title_sets)

**Context:** Two owner interventions on the `cover_title_paintin` stage. (1) "Why such a narrow crop?
What I am not always happy with is the chosen colour — does sending more of the image allow a better
matching colour?" (2) A parallel rewrite of migration 010 generalises avatar sheet sets into a
stage-typed `testlab_sets` table, while a title-specific `title_sets` mechanism was being added.

**Decision:**
1. Crop width is treated as a **resolution-vs-context** lever, not a safety one. The tight 5% crop was
   inherited from the Qwen composite recipe (where full-frame edits re-imagine the scene), but the
   mask-gated paste-back already discards everything outside the glyph mask, so a wider crop cannot
   damage the artwork. `marginPct` default 0.05 → **0.12**; new `contextRef` (default ON) sends the
   FULL cover as a second reference for palette/lighting while the model still edits only the crop;
   new `recolor` (default OFF) lets the model pick a lettering colour that echoes an accent in the art.
2. **No `title_sets`.** Set plumbing is held entirely until the generic `testlab_sets` lands; title
   pinning will be a consumer of that, never a parallel mechanism. Migration 011 and the /title-sets
   routes + Title sets tab were reverted in `bacab129`.

**Rationale:** A crop that shows only the sky behind the title gives the model no way to know the
cover's accent colour lives in a coat further down — starving exactly the decision the owner is
unhappy with. Moving the colour choice to something that can see the whole picture is the direct fix;
keeping it behind a flag preserves the deterministic pick as the default until an A/B says otherwise.
On sets: two sets systems in one tree is the "parallel paths" failure the codebase rules forbid.

**Touched:** `server/lib/testlab.js` (TITLE_PAINTIN_BASE / _KEEP_COLOUR / _RECOLOUR / _CONTEXT,
`paintinSetup` result block), `client/src/pages/TestLab.tsx` ("What was sent to the model" card),
`client/src/services/testlabService.ts`, `docs/cover-text-rendering-research.md`.

**Status:** 🟡 built, still NOT run — no verdict yet on paint-in quality or on recolour.

---

## 2026-08-05 — BODY blur used the FACE/HEAD mask as SAM round 1 (exp #304)

**Context:** Owner on exp #304: "for the blurred version SAM round 1 is wrong — how can that
be? It is the same image as for the others." Correct: same page, same box, same detection.
`buildBlurTreatment` called `fetchFaceHeadMaskPng` unconditionally — the fetcher that places
face+hair dots and clips to a HEAD. On a whole-figure box it returns a head-shaped/partial
mask, and that mask IS the blend's `oldMaskPng` = SAM round 1. Measured consequence: red zone
51864px under blur vs 5032px under crosshatch on the SAME box; the blur path also blurred
only part of the figure, so the model saw a half-blurred body.

`buildBlurTreatment` already accepted `faceOnly` and never used it — the bug was latent from
the spine merge (the legacy blur path was face-only, so nothing exercised it until whole-figure
blur became reachable from the Lab's new Treatment dropdown).

**Decision:** body blur (`faceOnly=false`) uses `fetchFigureMaskPng` — the same plain figure
mask every other body path uses; face blur keeps the head mask. `fetchSilhouettePng` stays
the fallback for both.

**Touched:** `server/lib/faceRepair.js`.

---

## 2026-08-05 — Gate rejections must show WHY and WHAT (exp #306 blur)

**Context:** After the body-blur mask fix, the blur variant came back
`ok:false, error:"Character repair returned no image (blend_gate)"` with ZERO steps — no
treated input, no model output, no gate message. Undiagnosable: the spine HAS the reason
(`gateMessage`) and the images, `runCharRepairStage` threw them away.

**Decision:** on a null-image result the stage emits the treated input and the model's raw
output as steps ("model raw output (REJECTED)"), and throws with the gate message plus an
`err.partialResult` carrying steps / boxes / descriptor / rejectedReason / gateMessage /
promptUsed. The runner already merges `partialResult` into the stored entry, so a rejected
run now renders like any other card.

**Touched:** `server/lib/testlab.js`.

---

## 2026-08-05 — Rim removal confined to a 3px outline band; "sent to model" shows the real input

**Context:** Owner on exp #307: (a) pixels DEEP inside the new figure were being replaced —
"the replace white should only run on the very border, say 3px"; (b) the "sent to model"
step cannot be right because the model raw output is the full page while the step shows only
the crop.

**(a) Rim removal was scanning the whole figure.** The elongated-bright-rim rule ran over
every old-silhouette∩figure pixel, so an elongated highlight 20px inside the new figure (a
fold, a strap edge) could be flagged and overwritten by the field. Now the candidate set
excludes `erode(newBin, ~3px)` — the safely-interior region is untouchable, and the rule
only sees the outline band where rim residue actually lives. Verified: a deep elongated
highlight survives byte-exact (240→240) while the outline strip is still removed.

**(b) The step lied in box mode.** `regionSource:'box'` (crosshatch/blur) sends the model the
full treated SCENE and gets a full page back, but `blackoutImage` was always the treated
CROP — so the pair could not be compared. `sentToModelUri` now records exactly what was
transmitted (treated scene in box mode, treated crop in cutout mode) and that is what the
step shows.

**Touched:** `server/lib/samBlend.js`, `server/lib/faceRepair.js`.

---

## 2026-08-05 — Whole-figure treatment: crosshatch body + BLURRED FACE (owner decision)

**Context:** Owner, after the #315 3-way: "the character should be crosshatch … and the face
should be blurred." Evidence: crosshatch preserves the kneeling pose and yields the smallest
red zone (5,060px vs blur 16,182 vs whiteout 25,373), while whiteout loses the pose. But
through the hatch the OLD face stays legible and gets recreated — identity then comes from
the page instead of the avatar. A blur destroys the features while keeping head size/tilt,
so pose survives and identity must come from the reference.

**Decision:** `buildCrosshatchTreatment` composites a blurred head (radius ≈ 12% of face
width — heavier than the face-repair blur; features must not survive) over the hatched body
whenever a face box exists and `faceOnly=false`. Default ON (`opts.blurFace !== false`).
Production body repairs already resolve to crosshatch via `resolveRepairAxes`, so they
inherit this automatically. The Lab's Treatment default now maps whole-figure → crosshatch,
matching production — a Lab default that silently differed from prod is why #302/#304/#315
kept comparing the wrong thing; whiteout-insert stays selectable explicitly.

**Also added — identity-transfer test:** `params.referenceCharacter` repairs character A's
region using character B's avatar (both the insert and spine paths). If the output still
looks like A, identity is being copied from the page rather than the reference — the
sharpest available test of a treatment. Exposed as "Reference swap" in the form, with a
"Blur face over crosshatch" checkbox for the A/B.

**Touched:** `server/lib/faceRepair.js`, `server/lib/testlab.js`, `client/src/pages/TestLab.tsx`.

## 2026-08-05 — SAM masks must FILL their DINO box (≥25%) and the inside test is per-axis
**Context:** Staging story `job_1785767208189_x6lyay5fr` (ran 2026-08-03 15:04
CEST) shipped three broken pages. The GroundingDINO person boxes were correct on
all of them; the damage came from `_cleanMaskAndCheck`, which replaces the DINO
box with the bounds of the accepted MobileSAM mask. p2: Roger's `bodyBox`
collapsed onto a sliver of his vest fringe (1.7% of the box). p4: Lukas's
collapsed onto the pumpkin standing beside him (1.6%). Both were recorded as
`mask-ok`. p10's name swap followed from the same cause — the identity step
marks figures from those boxes. Story-wide, 41 of 69 figures got
`rejected-all-outside`: a box-prompted mask cannot land outside its own box
unless SAM is answering about different pixels. The analyzer fault behind it was
fixed the next day (`ff1ed9aa`, per-call SAM predictor/embedding clear, at a
3813 MB RSS plateau) — but the acceptance rule that let 1.6% coverage through is
independent of it, and Test Lab exp #314 confirms the same three pages now
detect cleanly (19/19 figures `mask-ok`, 62–99% coverage).
**Decision:** Two guards in `_cleanMaskAndCheck`:
1. `SAM_MIN_BOX_COVERAGE = 0.25` — the kept extent must fill ≥25% of the DINO
   box, else the mask is dropped wholesale and the tight DINO box is kept, with
   a new verdict `rejected-too-small`. Coverage is measured bbox-area-to-bbox-
   area (not silhouette pixels) so the number reads directly against the boxes
   in a lab detection entry, and it is persisted per figure as `maskCoverage`.
2. The inside-the-box tolerance is computed PER AXIS (`0.12 * width`,
   `0.12 * height`) instead of `0.12 * max(width, height)` for both.
`rejected-too-small` joins the `sam_mask_leak` story-log warning, so a page of
them is findable per-story instead of only in container logs.
**Rationale:** Falling back to the DINO box costs nothing — it is the pre-SAM
truth, just not silhouette-tight — so the floor can sit far below any real
silhouette and still never fire on good input (measured separation: 1.6–1.7%
bad vs 62–99% good). The per-axis fix is what actually admitted the pumpkin: a
tall narrow person box (253×733 px) got 88 px of horizontal slack from the long
axis instead of 30, wide enough to swallow a prop standing entirely beside the
figure. `tests/unit/sam-mask-guard.test.ts` pins both with the real geometry and
fails on the pre-fix logic.
**Not changed:** `fetchFigureMaskPng` (the repair-side `/figure-mask` path,
`images.js:~10750`) still accepts any mask with `fill_pixels > 0` with no
geometry check against the requested box — same defect class, different
trade-off (its fallback is rembg, or null for face repairs). Open.
**Touched:**
- `server/lib/images.js` (`SAM_MIN_BOX_COVERAGE`, `_cleanMaskAndCheck`, the
  Stage-2 verdict switch, `maskCoverage` on each figure)
- `server/lib/testlab.js` (`maskCoverage` in the bbox detection entry)
- `tests/unit/sam-mask-guard.test.ts`
**Status:** ✅ active

---

## 2026-08-05 — Two regressions from my own changes: swap ignored, stray SAM specks pasted

**1. The identity swap never swapped (exp #320 invalid).** `runCharRepairStage` resolves the
reference photo, then RE-RESOLVES a styled avatar via
`getStyledAvatarForClothing(character…)` where `character` was looked up by **charName**.
So `referenceCharacter:'Roger'` set `ref`, logged "IDENTITY SWAP", and was then overwritten
by Lukas's own styled avatar — the sent reference image (step v889) is Lukas's sheet. The
conclusion drawn from #320 ("identity comes from the page, not the reference") is
UNSUPPORTED and withdrawn. Fix: the character lookup follows `refName`.

**2. Stray SAM fragments outside the figure got pasted.** The figure-exact island filter was
changed (2026-08-05, orphan-sandal fix) to keep EVERY union component intersecting the
padded detection box. That also keeps small SAM specks near the box — owner: "the SAM mask
finds small areas outside the figure". Fix: a size gate — a kept component must be ≥0.8% of
the main silhouette (min 150px). Verified: a 100px speck drops, a 560px severed foot stays.

**Touched:** `server/lib/testlab.js`, `server/lib/samBlend.js`.

## 2026-08-05 — Text refinement runs in PARALLEL with image generation

**Context:** measured on a 10-page story — storyGen (writer + review + scene expansion)
5.5 min, **images 25.0 min**, covers 0.7 min, total 37.9 min. Images are 66% of wall
clock, and everything text-side is small next to them.

**Decision:** `text_refine` starts at `timing.pagesStart`, the moment scenes are locked,
and is joined after `images_complete`. On a normal run the await returns immediately
because refinement (~2-4 min) finished long before images (~25 min). A pass placed
*after* images would have added its full duration to the total; here it costs nothing.

**Why it is safe to overlap:** the refiner receives scene outlines READ-ONLY and rewrites
page prose only, never events. The illustrations are rendering from those same scenes, so
the two cannot contradict each other. This is the property the stage was designed around,
not one added afterwards.

**Both arrays are updated on join.** `allImages[].text` is a COPY of `scene.text` taken in
`preparePageData` while images were being prepared; mutating `expandedScenes` alone would
have persisted the pre-refinement prose. Verified by tracing `allImages[].text = pageData.scene.text`.

**Never blocks a story.** `startBackgroundRefine` resolves to `null` on any failure and
logs a warning; the original text stays. Verified: an unknown model returns null rather
than throwing. Disable with `TEXT_REFINE=false`; rounds via `TEXT_REFINE_ROUNDS`
(default 2).

**One implementation.** The loop lives in `server/lib/textRefine.js`; the Lab stage
delegates to it (its 123-line duplicate body was deleted). A Lab result is therefore
evidence about the code production runs, not about a copy.

**Touched:** `server/lib/textRefine.js` (new), `server/lib/testlab.js`, `server.js`.
**Status:** ✅ kept — staging only until a full generation is observed end to end.

---

## 2026-08-05 — Face blur: head silhouette only, hatch on top; swap also swaps the clothing

**Context:** Exp #326's "sent to model" step showed the face blur as a RECTANGLE covering the
head plus the wall and window behind it, painted OVER the crosshatch. Owner: "the blur should
only be for the SAM part not for the full box, and the crosshatch should be on top of the
blur". Separately: "neither changed the clothing" on the identity swap.

**Decisions:**
1. The blur is clipped to the SAM HEAD SILHOUETTE (`fetchFaceHeadMaskPng` on the face crop),
   never the box — a rectangle destroys background the model is required to preserve. If the
   head mask is unavailable the blur is SKIPPED rather than falling back to the box.
2. Composite order is blur UNDER, hatch OVER: the whole figure including the head carries the
   repaint marker, while the blur removes identity underneath it.
3. `clothingDescription` follows the REFERENCE character (`refName`), not the target. During a
   swap the prompt was still demanding the target's outfit — the model was explicitly told to
   paint Lukas's clothing onto Roger, so clothing could never change.

**Touched:** `server/lib/faceRepair.js`, `server/lib/testlab.js`.

---

## 2026-08-05 — Identity swap needs the PROMPT to name the reference; blur clipped to the figure silhouette

**Context (exp #329):** the swap sent Roger's avatar and Roger's clothing, and nothing
changed. The prompt was the reason: "REFERENCE PORTRAIT of **Lukas**", "paint one **Lukas**",
"Match **Lukas's** … clothing" — the target's name appears 6+ times, and the text beat the
image. Also the head blur still rendered as a grey rectangle: `fetchFaceHeadMaskPng` on the
face crop returned nearly the whole box.

**Decisions:**
1. `opts.promptName` — the identity the PROMPT names, separate from `charName` (the character
   who is in the scene). Every identity line in `buildPrompt` uses promptName; scene-state
   lookups (`buildActionContext`) stay on charName so pose/expression still come from the
   target's metadata. `referenceCharacter` now sets it, making a swap a REAL swap:
   avatar + clothing + name.
2. The face blur is clipped to the FIGURE silhouette already segmented for the hatch,
   restricted to the face box — literally "the SAM part". No fresh head-mask call, and no box
   fallback: without a silhouette the blur is skipped (a box blur destroys background).
3. `blurStrength`: 'strong' (default, r ≈ 12% of face width — features destroyed) or 'slight'
   (r ≈ 4.5% — shape and tone survive), for the A/B the owner asked for.

**Touched:** `server/lib/faceRepair.js`, `server/lib/testlab.js`.

---

## 2026-08-05 — The face blur never reached the model: chained resize().extract() threw, catch swallowed it

**Context:** Owner: "all your sent to model (whiteout/crosshatch) show no blur at all. Why?"
Correct — every #331 variant shipped an unblurred hatch. The reason was in `logWarnings`, not
`logLines`: `[FACE REPAIR] face blur over crosshatch failed (extract_area: bad extract area)
— hatch only`. Chaining `.resize(hatchW,hatchH).extract({...})` in ONE sharp pipeline throws;
the try/catch degraded to hatch-only and the run looked successful.

**Decision:** paste the silhouette (hatch coords) onto a crop-sized transparent canvas, THEN
extract the face box from that — no chained resize+extract. Verified on the real geometry
(crop 385x722, hatch inset, face box 222x276 at 74,57): silhouette alpha 248/255 (a real
silhouette, not a full box) and the clipped blur survives.

**Process note:** a swallowed exception that leaves a *plausible* output is the worst failure
mode in this pipeline — the Lab showed a healthy card, correct logs, and a wrong image. The
warning existed and I read the wrong field. Gate rejections and treatment fallbacks belong in
`logLines`, not only `logWarnings`.

**Touched:** `server/lib/faceRepair.js`.

---

## 2026-08-05 — Face-blur default = SLIGHT (owner, exp #335)

**Context:** With the blur finally reaching the model (#335), the owner compared strong
(r≈12% of face width) / slight (r≈4.5%) / none. Verdict: **slight**. Shape, tone and lighting
survive so the model can read pose and head orientation, while the identity information is
gone. Strong throws away pose cues the crosshatch is meant to preserve; none lets the old face
be recreated.

**Decision:** `blurStrength` defaults to `'slight'` for the crosshatch treatment; `'strong'`
stays available per-run. Production body repairs (crosshatch, blurFace on) inherit it.

**Touched:** `server/lib/faceRepair.js`.

## Avatar style transfer (pass-2) uses Grok, not Gemini (2026-08-06)

**Context:** Round-2 art/style transfer of the realistic 2×4 sheet had defaulted to
gemini-2.5-flash-image (from a 2026-07-19 A/B that actually ran on gemini-3-pro). Re-tested in the
Test Lab (exps #336 gemini-vs-grok, #341 Emma/grok, #344 Hans/grok, #339 prompt-strength A/B).

**Decision:** `MODEL_DEFAULTS.avatarStyleTransferBackend` = `grok` (was `gemini`). Also rewrote
`ART_STYLES.watercolor` (all variants) to a bolder, less photo-realistic descriptor.

**Rationale:** gemini-2.5-flash-image returns a near-photographic sheet regardless of how forcefully
the transfer prompt demands the style (prompt A/B moved it almost nothing) — the model, not the
prompt, is the ceiling. Grok stylises strongly and correctly (watercolour/pixar/anime) on both a
child (Emma) and an adult (Hans), with no content-moderation refusals on the adult (the original
reason gemini was chosen). Grok's occasional child moderation false-reject is covered by the
3-attempt retry in runStyleTransferPass. The styled-eval scores everything ~9 (validity/identity,
not degree), so it can't arbitrate this — visual A/B did. Old watercolour read "too realistic"
because the Inga Moore reference + photo-realism anchors dominated the wash cues.

**Touched:** `server/config/models.js` (avatarStyleTransferBackend), `server/lib/storyHelpers.js`
(ART_STYLES.watercolor), `server/lib/character2x4Sheet.js` (runStyleTransferPass backendOverride +
provider echo).

---

## Avatar sheet style transfer strips scene/environment from the style line (2026-08-06)

**Context:** After the grok flip, cyber avatars ("Lily and Ethan's Eight Travellers",
`job_1786024729214_zrjgzqiey`) came back with a full cyberpunk scene painted behind the figures
(rainy street, neon signs, fog). A reference sheet must be plain white so the figure can be cut out
and composited. Root cause: `buildStyleTransferPrompt` injected the *page* style descriptor via
`resolveStyleLineForSheet`, and the cyber descriptor is written as a scene ("neon reflections, rainy
streets, chrome surfaces … dark atmosphere with volumetric fog") — grok obeys those environment
words, overriding the "pure white background" line. The split eval never checked background, so it
false-passed (Lily/Ethan scored 9 with the scene present; only Rachel failed, for an unrelated body
reason — exp #364).

**Decision:** (1) `resolveArtStyleForSheet()` — the mirror of `resolveArtStyleForEmptyScene` — strips
environment/scene clauses from the style line for pass-2, keeping rendering technique, palette,
linework, faces; `resolveStyleLineForSheet` uses it. Clause-level, but sentences carrying a rule
(negation / "only on …" / parentheticals / em-dash asides) are kept verbatim so a rule can't be
inverted (steampunk's "gears never on faces" must not become "gears on faces"). (2)
`buildStyleTransferPrompt` explicitly forbids scenery (pure white, empty, style on the figure only).
(3) `sheet-row-bodies-eval` TASK 5 = plain-background check, folded into `finalScore` so a painted
background now fails the sheet.

**Rationale:** The descriptors conflate character-rendering style (wanted on the sheet) with
scene/atmosphere (wanted only on pages). Stripping at the resolver — same pattern the empty-scene
path already uses — fixes every scene-heavy style at once without touching page generation. Verified
in Test Lab (staging): eval-with-bg-check fails all 3 cyber sheets on background (#367); regenerated
cyber pass-2 with the stripped style line comes out plain white, bg=10, style intact (#368).

**Touched:** `server/lib/storyHelpers.js` (resolveArtStyleForSheet + export),
`server/lib/character2x4Sheet.js` (resolveStyleLineForSheet, buildStyleTransferPrompt),
`prompts/sheet-row-bodies-eval.txt` (TASK 5 background check).

---

## 2026-08-05 — Cutout repairs: register the candidate instead of rejecting it (exp #345)

**Context:** The cutout variant was rejected — "Painted figure barely overlaps the original
(mask IoU 53%)". Owner: "this is wrong, it fits more or less perfectly — you have a scaling
issue." Correct. The crop WAS preset-aligned (390x866 = 9:20 exactly, no stretch), but the
SAM masks show Grok drew the same person ~40px lower and slightly taller: without the
surrounding scene the model has no positional anchor, so it re-composes inside the frame.
The IoU gate exists to catch REAL pose changes and was firing on a registration error.

**Decision:** `registerCandidate` (on for `regionSource === 'cutout'`): measure both
silhouettes' bounding boxes, compute a UNIFORM scale + translation mapping the candidate's
figure onto the original's, warp the candidate, re-segment, and keep the registration ONLY if
IoU improves. Guard rails: uniform scale only (never distort), scale limited to 0.75-1.33,
and a genuinely re-posed figure still fails the gate.

**Verified:** synthetic 45px offset → registration dy=-47, scale 0.989, IoU 0.786 → 0.989
(passes). Genuine pose change (wide crouch → tall stand) → still rejected at IoU 21%.
Registration is emitted as a Lab step and returned on the blend result.

**Also confirmed for the record:** #345's two variants were `grok:box:crosshatch:body` and
`grok:cutout:crosshatch:body`, both with `crosshatch+faceblur (slight, r=5)` — the comparison
already isolated box vs cutout; no whiteout was involved.

**Touched:** `server/lib/samBlend.js`, `server/lib/faceRepair.js`.

---

## 2026-08-05 — Candidate registration is TRANSLATION ONLY (owner)

**Context:** Owner on the cutout fix: "no scaling, that is shit. You can move it but scaling
I would be careful."

**Decision:** registration slides the candidate only; `scale` is fixed at 1. Rationale: a
wrong scale factor resizes the FIGURE — a systematic distortion that is hard to see and
impossible to undo downstream — while a wrong translation only slides the paste and shows up
immediately in the IoU acceptance check. Verified: 45px offset → dx −2, dy −45, scale 1,
IoU 0.794 → 1.000.

**Also checked:** the poor-looking SAM round 2 in #355's cutout is NOT from registration —
registration was REJECTED in that run (IoU would have gone 0.686 → 0.664), so no warp was
applied. The round-2 cutout is a clean silhouette plus one small stray fragment.

**Touched:** `server/lib/samBlend.js`.

---

## 2026-08-05 — Repair prompt: {charName} was sent UNSUBSTITUTED; appearance added; character facts consolidated

**Context:** Owner asked what the prompt actually carries. Reading the stored prompt from
exp #360 exposed three things:

1. **`{charName}` was shipped literally.** Grok received "REFERENCE PORTRAIT of {charName}",
   "paint one {charName}". My own regression: `buildPrompt` renamed the variable to
   `identityName`, so the template's `{charName}` placeholder no longer had a matching key
   and `fillTemplate` left it raw. The model was told a clothing colour and a pose but never
   WHO to paint — which is the likeliest reason the cutout runs came back as "the old image,
   cleaned up, shirt still green". Fixed: templates are filled with `charName: identityName`
   (alias kept), so a swap still names the reference character.
2. **No appearance description at all** on the crosshatch/blur path. The stored
   per-character description (face, hair, build — the same text the detector matches on)
   existed but was never passed. Now sent as `characterDescription` (following `refName`) and
   rendered as `{appearanceContext}`; clothing is stripped from it since `clothingContext`
   from the story's clothing requirements is authoritative.
3. **Character facts were scattered** — name in the task line, "match X's face" mid-prompt,
   clothing appended after the background rule, state after that. Owner: put everything about
   the character together. The template now ends with one block:
   `--- {charName} — everything to match ---` + face/hair source + appearance + clothing +
   scene state. Generic instructions stay above it.

**Touched:** `prompts/character-repair-cutout.txt`, `server/lib/faceRepair.js`,
`server/lib/testlab.js`.

---

## 2026-08-05 — Registration aligns on the BACKGROUND, and rejects when the scene itself moved

**Context:** Owner: "can you do the IoU on the rest of the image, not on the character we
repair — if you can align it so the background matches we can use it, otherwise reject
outright." Correct, and it fixes two observed failures: the figure is exactly what CHANGED,
so aligning on its silhouette is circular; and round-2 SAM sometimes grabs a neighbour's shoe
(exp #360), which then drags the whole paste sideways.

**Decision:** `registerCandidate` now scores alignment on BACKGROUND pixels only — everything
outside both silhouettes, dilated 3px so the figure's soft edge never enters the score. A
coarse-to-fine search over dx/dy (±12% of the crop) and a small scale set picks the minimum
mean |grey diff|. Outcomes: background already aligned → no shift; a real offset → shift
applied and re-segmented; residual still above 26 grey levels after the best alignment →
the candidate is REJECTED ("model redrew the SCENE, not just the figure").

**Verified:** background aligned + figure moved → no shift applied (the frame is fine);
whole canvas shifted → detected and corrected (bg mismatch 25.6 → 1.6); scene genuinely
redrawn → rejected at 77.3.

**Open (owner-reported, not yet fixed):** SAM sometimes omits the HAND from the figure mask,
so the old hand survives next to the new figure and reads as an artifact.

**Touched:** `server/lib/samBlend.js`.

---

## 2026-08-05 — Replay for the crosshatch/blur spine + gate rejections carry their images

**Context:** Owner: "can you just redo the shift using same images?" Two blockers: Replay
only worked on the whiteout INSERT path (`reuseModelOutput` was read in runQwenInsertStage
only), so any crosshatch/blur re-run rolled fresh Grok output and mixed model variance into
every blend comparison. And a blend-gate rejection returned no images at all, so the Lab card
showed a single step (exp #362's cutout).

**Decisions:** (1) `opts.reuseCandidate` in `repairCharacterFace` skips the model call and
blends a stored output — registration, gates and paste are deterministic, so a blend change
can be tested at $0 against identical pixels. `runCharRepairStage` resolves
`params.reuseModelOutput` (tl_step index or data URI) into it, so `replayOf` now works for
every treatment. (2) The blend-gate rejection returns `blackoutImage`, `grokRawResult` and
`promptSent`, so a rejected run renders like any other card.

**Measured on the rerun (#362):** with `{charName}` substituted and the appearance text
present, the FULL-PAGE repair succeeded; the CUTOUT was rejected by the new background test —
"background still differs by 35.0 grey levels after best alignment (dx −21, dy −47, scale
0.94)". That is the gate doing its job: in cutout mode Grok re-renders the whole crop rather
than editing it. Whether 26 is the right rejection threshold for watercolour re-rendering is
now measurable deterministically via replay.

**Touched:** `server/lib/faceRepair.js`, `server/lib/testlab.js`.

---

## 2026-08-05 — Round-2 SAM adopted other characters; occluder subtract now applies there too

**Context:** Owner on exp #362: "something with SAM 2 is still not good … we once made SAM of
all characters and removed the other characters. Now it gets a lot of Sarah included."
Correct, and the asymmetry is real: the crosshatch builder subtracts every protected
character's silhouette when building the TARGET mask, so **round 1 is clean** — but **round 2**
is segmented straight off the model output with no such treatment, and SAM returns a
neighbour's sleeve/shoe as part of the figure. Round 2 feeds the union, the red zone and the
paste, so those fragments become part of the repair.

**Decision:** `protectedBoxesInCrop` is threaded into `samUnionBlend`, and after round 2 is
fetched each protected character's silhouette is segmented from the CANDIDATE and
dest-out-subtracted from the round-2 mask — the same operation the hatch already does, with
the same revert guard (a subtraction that removes >70% of the target is a label mismatch and
is reverted). The cleaned mask is emitted as its own step.

**Also added (owner request):** after a successful repair, a per-figure diagnostic — one SAM
silhouette per detected character segmented from the FINAL image, labelled, with the repaired
one marked. It is the direct way to see whether a repair damaged or absorbed a neighbour.
Diagnostic only; never gates anything.

**Touched:** `server/lib/samBlend.js`, `server/lib/faceRepair.js`, `server/lib/testlab.js`.

---

## 2026-08-06 — Production repairs had no appearance text (audit of a live staging story)

**Context:** Owner asked whether character repair ran on staging story
`job_1786024729214_zrjgzqiey`. It did — `char-fix` on 4 of 14 pages (p2 Lily, p5 Margaret,
p6 Lily, p9 Lily), and the stored prompts confirm today's template fixes ARE live in
production: `{charName}` is substituted and the closing "everything to match" block is
present.

**But the appearance slot was empty.** `characterDescription` was wired into the TEST LAB
stage only; the production pipeline call (`images.js` char-fix round) passed
issueDescription / clothingDescription / photoType / sceneDescription and no appearance
text — so every live repair identified the character by name, clothing and avatar alone.
Fixed: the production call now resolves the stored per-character description
(`bboxDetection.characterDescriptions[charName]`, falling back to the character record) and
passes it.

**Repair-quality note from the same audit** (evaluator scores, before → after char-fix):
p2 30 → 35, p5 40 → 40, p6 50 → **30**, p9 60 → **50**. Two of four rounds made the page
score WORSE, and both were pages where the pre-repair score was already the highest in the
chain. Worth investigating whether char-fix should be skipped when the current best version
already scores above some threshold.

**Touched:** `server/lib/images.js`.

---

## 2026-08-06 — Why the face blur failed on ONE page: crosshatch never used the retrying mask fetcher

**Context:** Owner: the blur works on most pages but not on p5 of story
`job_1786024729214_zrjgzqiey` (job ran 13:58–14:58 UTC, so the blur code — live since
08-05 23:55 — was definitely deployed).

**Root cause:** `buildCrosshatchTreatment` RECEIVES `maskFetch` (the retrying,
requireMobilesam-honouring fetcher every other treatment uses) and never calls it — it used
`fetchFigureMaskPng` directly, with no retry. One transient MobileSAM miss therefore leaves
`sil = null`, which silently degrades to a RECTANGULAR hatch AND skips the face blur (the
blur is clipped to that silhouette). Per-page, non-deterministic, exactly matching "works on
most pages, failed on this one". Production stored nothing about it because the only signal
was a `log.warn`.

**Fixes:** (1) crosshatch uses `maskFetch` (retries) and logs loudly when the silhouette is
still missing. (2) `treatmentInfo` — `{treatment, regionSource, faceOnly, faceBlur:{applied,
strength, radius | reason}, hatchClipped}` — is returned by the spine and persisted into
`retryHistory` by the production char-fix, so every future repair records whether the blur
ran and, if not, why.

**Note on the same page:** the photorealism is NOT from the repair — page 5's v0 (pre-repair)
is already photoreal while the avatar is a correctly stylised "cyber" sheet, so the style
break happened at page generation. The visible vertical seam through Margaret's cardigan in
v1 is a separate paste defect, still open.

**Touched:** `server/lib/faceRepair.js`, `server/lib/images.js`.

---

## 2026-08-06 — Why the Lab rejected and production didn't; and why round-2 SAM is poor

**Q1 — different verdicts.** The gates ARE on in production (all default true; the production
call sends no overrides), so it ran the same IoU gate and PASSED — that roll of Grok happened
to align above 0.55 while the Lab's roll didn't. Not a config difference. BUT the
background-alignment gate added earlier only ran when `registerCandidate` was set, i.e.
CUTOUT only — so box-mode production repairs (the default) had no background check at all.
That is the gate that catches "model redrew/misplaced the scene", which is exactly the p5
failure. **Now enabled for every repair:** in cutout mode it also shifts the candidate; in box
mode it purely gates (the model edits in place, so a background that still mismatches after
best alignment means the scene was redrawn → reject).

**Q2 — why round 2 is much worse than round 1.** They are not comparable operations:

| | round 1 (original) | round 2 (model output) |
|---|---|---|
| image | the real page | the model's render |
| framing | tight hatch crop (bbox+12%) | blend crop |
| other characters | occluder-subtracted | none until today's fix |
| seed points | — | taken from ROUND 1's mask |

The seeds are the main defect: they are interior points of the OLD figure, applied to the
NEW image. The model almost always draws the figure a few percent narrower or shifted, so a
seed can land on background or on a NEIGHBOUR — and SAM then grows THAT region. This is the
mechanism behind "round 2 returned someone else's shoe/sleeve". **Fix:** seeds are now taken
from a hard-eroded (6σ) round-1 mask, so a seed must sit deep inside the area both figures
share; combined with today's occluder subtraction on round 2.

**Touched:** `server/lib/faceRepair.js`, `server/lib/samBlend.js`.

---

## 2026-08-06 — Art-style collapse: the plate is the style anchor, and "consistency" canonised the drift

**Context:** Owner on story `job_1786024729214_zrjgzqiey` (artStyle `cyber`): "page 5 why is this
photo realistic, it should be cyberpunk — I do not believe we passed the correct avatars."

**The avatars were correct.** All five styled 2×4 sheets were genuinely cyberpunk (Pass-2 Grok
style transfer, finalScore 9). The three references actually sent for p5 were the empty-scene
plate + two correctly-stylised character cards. Page 5's v0 (pre-repair) is already photoreal, so
the char-fix is not the cause either. Decisive counter-evidence for any avatar theory: the SAME
illustrated Lily card produced an illustrated p1 and a fully photoreal p4.

**It is book-wide, not page 5.** Photoreal: p4, p5, p6, p11, p14. Illustrated: p1, p7. The
requested style survives only as neon set-dressing on some pages.

**Root cause (two layers).**
1. Every empty-scene plate renders photorealistically despite carrying the identical ART STYLE
   block (verified on the p1 kitchen, p4 car and p5 bridge plates). In `empty-scene.txt` the style
   sat LAST, after a long block instructing the model to match a real-world landmark photograph —
   which primes photography. The plate is then reference #1 for the page, and
   `image-generation.txt` told the model to "copy its setting, architecture, geography, and
   lighting" with no style qualifier. Grok harmonises the stylised character cards down to the
   plate's rendering. It is non-deterministic, which is why it reads as a per-page avatar bug.
2. Nothing measured style adherence. `emptySceneQc` is null on all 14 pages; neither
   `image-evaluation.txt` nor `image-semantic.txt` scores it.

**The feedback loop made it worse.** `checkStoryStyleConsistency` is deliberately RELATIVE
("is this consistent with the rest?"). With the majority collapsed, it declared the dominant style
to be "soft, painterly, natural colour palettes, realistic characters", flagged the two
correctly-stylised comic pages (3 and 10) as the outliers, and production style-repair repainted
p3 toward the photorealism (`bestSource: style-repair-gemini`). The evaluator pushed the same way:
p5's three-stage compliance raised a CRITICAL "anachronistic neon lights, inconsistent with an
1815 historical bridge" and prescribed "remove the neon strips; brighten to natural sunlight" —
judging the art style against real-world plausibility.

**Decision:**
1. `empty-scene.txt` — ART STYLE moves to the TOP (single site; the trailing duplicate is
   removed), plus a line binding the backdrop to the style. The landmark-photo block now says to
   take geometry from the photo and explicitly not its rendering.
2. `image-generation.txt` — reference #1 supplies setting/architecture/geography/light DIRECTION;
   "take its layout, not its rendering", and the ART STYLE governs how everything is drawn.
3. Relative style consistency is KEPT as-is; an ABSOLUTE check rides alongside it.
   `checkStoryStyleConsistency` now resolves the commissioned style from `storyData.artStyle` and
   returns `styleMatch.verdict`. When the dominant cluster is a different MEDIUM, production
   style-repair is SKIPPED — a wrong anchor spreads the drift instead of fixing it. Outliers are
   still surfaced. Rationale: no anchor beats a wrong anchor; this does not re-litigate the
   relative design, it guards its failure mode.
4. Evaluators: art-style elements are never anachronism / setting-mismatch / wrong-lighting
   findings, and must never be prescribed for removal (`image-prompt-compliance.txt`,
   `image-evaluation.txt`).

**Measured afterwards on a 5-book corpus** (cyber / watercolor / oil / comic / manga, style check
re-run against stored pages). Three corrections came out of it, all applied:
1. **The boolean was far too strict.** `dominantMatches` read false on 4 of the 5 books —
   including two the auditor itself called "consistent" — because the model scores style fidelity
   pedantically ("lacks the named artist's brushwork", "shading is subtly digital rather than
   strictly flat"). Gating repair on that would have disabled style-repair for almost every story.
   Replaced with a three-level `styleMatch.verdict` (`matches` / `drifted` / `wrong_medium`);
   only `wrong_medium` — a wholesale medium change — blocks. Re-measured: 2 matches, 2 drifted,
   1 wrong_medium, and that one has zero outliers so nothing is blocked in practice.
2. **The check ran at Gemini's default temperature** — the only judgment call in the repo that
   still did. Two identical runs over the same 14 pages returned dominant clusters of 7 and 13
   pages (7 outliers vs 1), making both the outlier list and the style verdict a coin flip. Now
   pinned to `EVAL_TEMPERATURE` (0), same knob the image evaluator uses; consecutive runs then
   agreed.
3. **The audit is NOT a reliable detector for this failure mode.** Once pinned, it clusters the
   photoreal pages together WITH the cyberpunk ones and calls the book "consistent"/"matches" —
   at 256px grid thumbnails, photoreal and illustrated figures are not reliably separable. An
   earlier unpinned run had split them correctly, which was luck, not signal. So the absolute
   check is a backstop for gross medium changes, not the fix. The fix is generation-side (1) and
   (2) above.

**Status:** 🟡 on staging. The evaluator/audit changes are measured. The two GENERATION changes —
the plate and the reference-#1 clause, which are the actual root cause — are still UNVALIDATED:
they only show up in freshly generated plates, so they need an `empty_scene` Test Lab run across
≥3 art styles before master.

**Touched:** `prompts/empty-scene.txt`, `prompts/image-generation.txt`,
`prompts/image-prompt-compliance.txt`, `prompts/image-evaluation.txt`,
`server/lib/styleConsistency.js`, `server/lib/images.js`.

---

## 2026-08-06 — Page 13 scored 0: not a scoring bug, but the diagnostics were dropped at save

**Context:** Same story, p13 `finalScore: 0` with all five versions reading eval===penalty
(40/40, 30/30, 10/10, 40/40, 35/35) — which looks like the entity penalty being clamped to the
score.

**It is not.** `applyScore` (scoring.js) derives `evalScore = finalScore + entityPenalty`, and
`finalScore` is clamped at 0. Once a version bottoms out, evalScore necessarily reads back as
exactly the entity penalty. p13 genuinely failed every round (deductions ≥ 100 each time), so all
five versions tie at 0 and version selection has no signal left to pick on.

**The real defect** is that `applyScore` writes `rawScore` (un-clamped, "how far below zero") and
`entityPenaltyRaw` (pre-cap) specifically to disambiguate this state — and the version persist
mapping in `images.js` is an explicit allowlist that never copied either one. Both were dropped
before the story was saved, so the exact signal designed for this case is absent from the DB.
Fixed: both fields are now persisted.

**Still open:** nothing breaks the all-zero tie when every version fails. Worth deciding whether
the picker should fall back to `rawScore` ordering.

**Touched:** `server/lib/images.js`.

---

## 2026-08-06 — The coherence gate was write-only: STEP 0 CATASTROPHIC could never trigger a redo

**Context:** Owner, on the reference-card frame leak (a green cross-shaped frame on p6, thick
blue/red borders on p7 of `job_1786024729214_zrjgzqiey`): "why does the evaluator not catch it and
we just redo?"

**It half-caught it, and could not have acted on it either way.**
1. On p7 the evaluator DID see it — it emitted `composition/MINOR: "Scene includes thick blue/red
   decorative borders and a separate small framed planetary image"`. `image-evaluation.txt` STEP 0
   lists a full-perimeter frame as an explicit CATASTROPHIC trigger, but the model reported the
   same defect down in STEP 4 as a minor composition nitpick. p7 then scored 68 — the highest page
   in the book — and shipped as `original` with no repair.
2. On p6 the frame was not mentioned at all.
3. Decisively: `coherence_gate` — the `{applied, reason}` field STEP 0 asks for on EVERY page — has
   **zero readers anywhere in the codebase**. Grep returns exactly one hit: the line in the prompt
   that requests it. The model emits it (it is visible inside the stored raw reasoning JSON), and
   it is dropped. The gate that exists specifically to force a from-scratch redo instead of an
   inpaint has never been able to force anything.

**Decision:**
1. Parse `coherence_gate`. When `applied === true`, express it as a CATASTROPHIC entry in
   `fixableIssues` — it does NOT get its own repair path, because catastrophic severity already
   routes to regenerate (`repairLogic`: catastrophic visual/semantic → iterate). One route, not a
   parallel one. If the model applied the gate but severitied the same defect lower in STEP 4, the
   gate wins; that mismatch is exactly the p7 failure.
2. Persist `coherenceGate` on the version so "why was this page redone / not redone" is answerable
   from the stored story rather than only from live logs.
3. Prompt: the frame trigger now covers blank margins insetting the artwork and frames of any
   colour/thickness/shape, and explicitly forbids downgrading one to a composition nitpick.

**NOT fixed — the underlying leak.** Grok is copying the reference card's coloured frame and white
padding into the scene as geometry. The frame is the card↔character binding (it replaced name
captions, which leaked child names onto pages) and `frameCharacterImage` already carries scars from
two earlier leak fixes. Changing it to corner ticks or a swatch needs a Test Lab A/B on identity
binding first — not a blind edit. This entry makes the detection catch it in the meantime.

**Touched:** `server/lib/images.js`, `prompts/image-evaluation.txt`.

---

## 2026-08-06 — Round-2 SAM catastrophic failure: no seed point ever landed on the HEAD

**Context:** Owner: "SAM round 2 fails catastrophically." Exp #381's round-2 mask is the
cardigan and trousers only — no head, no arms, ragged holes. Verified NOT a regression from
the seed-erosion change: the same page before that change (#365) produced an identical mask.

**Root cause:** `_interiorSeedPoints` samples rows at 25% / 50% / 75% of the mask height. On a
FULL-BODY mask those are chest, waist and thighs — **nothing anchors the head**. Round 1 does
not depend on seeds (it segments the original via the hatch crop) so it is unaffected; round 2
does. On this page Margaret's grey hair sits against a dark bridge, so with only garment seeds
SAM grew the bright cardigan + trousers and stopped at the collar. The model output itself was
fine (a clean, well-lit render) and the DINO boxes were correct — the failure is entirely in
how round 2 was prompted.

**Fixes:** (1) seed rows are now 0.12 / 0.3 / 0.55 / 0.8 — 0.12 puts a point on the head
(verified on a synthetic head+body mask). (2) A new step, "SAM round 2 PROMPT: box (yellow) +
N seed point(s) (red)", draws exactly what round 2 was told, on the candidate. Round 1 has had
such a view for months; round 2 never did, which is why a mis-seeded prompt was invisible.

**Knock-on:** this also inflates the IoU gate's false rejections — a mask missing the head
cannot overlap the round-1 silhouette well. Margaret's 46% → 50% recomputation was done with
the broken seeds still in place, so the true IoU should be re-measured after this fix.

**Touched:** `server/lib/samBlend.js`.

---

## 2026-08-06 — Round-2 head seed comes from DINO's FACE BOX, not a height fraction

**Context:** Owner: "where do you get the seeds from? DINO provides this, no?" Correct, and it
exposes the real flaw. DINO provides BOXES (body + face — the red dots in the detection
visualisation ARE its face points). The round-2 seed POINTS, however, were entirely our own
invention: `_interiorSeedPoints` picks the widest interior run of ROUND-1's mask at fixed
height fractions. Round 2 never consulted DINO's face box at all — so we were guessing at a
head anchor we already had as evidence.

**Decision:** `faceBoxInCrop` (DINO's face box mapped to crop pixels) is threaded into
`samUnionBlend`, and its centre is prepended as the first round-2 seed point. The height
fractions (now 0.12/0.3/0.55/0.8) remain only as the fallback for figures with no face box.

**Why it matters:** the catastrophic round-2 mask (cardigan + trousers, no head) happened
because every synthesised seed landed on garment. A detector-provided face point anchors the
head directly, independent of how the model redrew the figure.

**Touched:** `server/lib/samBlend.js`, `server/lib/faceRepair.js`.

## Cyber (and any "setting" art style) must name a figure MEDIUM, not just a scene (2026-08-06)

**Context:** A cyber-style story (`job_1786024729214_zrjgzqiey`) rendered its pages + covers
photorealistically — "nothing like the references." The cyber descriptor was written as a SCENE
("neon reflections, rainy streets, chrome surfaces, volumetric fog") and never said how to render
the FIGURES. Grok (and Gemini) treat "cyberpunk" as a genre/setting, not a medium — and cyberpunk
art is photoreal-friendly — so the model kept its photoreal prior and added neon set-dressing.
Contrast: watercolor/anime/pixar "work" because they name an inherently non-photographic MEDIUM.
Audit result: cyber was the only broken style; steampunk already leads with "graphic novel
illustration" and renders illustrated; every other style is medium-named. Model swap is NOT the
fix — Gemini refused the cover outright (IMAGE_OTHER on photoreal adult faces) and also missed the
scene; the fix is the descriptor.

**Decision:** Rewrote `ART_STYLES.cyber` to lead with a figure medium — "cyberpunk anime
illustration, every figure cel-shaded anime, never photographic" — and deliver cyberpunk through
**neon signs mounted on the scene's own fixtures** (roadside posts, billboards, walls; glowing
shapes only, no readable text) + neon palette/tech accents, while explicitly preserving the story's
own time of day/weather ("never switch daytime to night, never add rain"). Iterated v1→v5 in the
Test Lab: v1 anime-only (no cyber on daytime scenes), v2 full-atmosphere (hijacked daytime scenes
to night-neon + garbled signage), v3 palette-only (too faint), v4 signs (worked on built scenes,
bare on open roads), v5 signs-on-fixtures (neon signage even on the countryside road, daytime kept)
— owner-approved.

**Rationale:** A single descriptor can't make a bright-daytime pastoral scene strongly cyberpunk
without contradicting it, so the levers are: (a) name the medium so figures stop being photos, and
(b) carry the cyber cue on neon SIGNAGE, which reads in daylight and hangs on fixtures the scene
already has — unlike night/rain, which fight a daytime scene. "No readable text" avoids garbled
neon lettering (the page prompt forbids text anyway).

**Touched:** `server/lib/storyHelpers.js` (ART_STYLES.cyber). Supporting lab plumbing so a model
override actually switches providers: `server/lib/images.js` (`_dispatchImageGeneration` now derives
the backend from `imageModelOverride` — a model-only override previously stayed on the default
backend and silently rendered on Grok, so model-only A/Bs compared a model against itself),
`server/lib/testlab.js` (cover + image stages forward `params.imageModel`).

**Status:** ✅ active (staging). Same "name the medium" fix likely needed for any future
setting-named style; steampunk already complies.

---

## 2026-08-06 — Character segmentation identical in BOTH SAM rounds (box + detector face point)

**Context:** Owner: "implement B and make sure it is same everywhere … I mean the character
detection must be the same everywhere. The face detection can be different." The IoU gate
compares round-1 and round-2 masks directly, so if the two rounds are prompted differently
the gate measures a difference in PROCEDURE, not in the figure.

**What was asymmetric:** round 1 (crosshatch builder) prompted SAM with the figure box and
NO points; round 2 used the box grown 4% plus up to 6 points — one from the detector's face
box and up to five synthesised from round-1's own shape at fixed height fractions. Those
synthesised points are guesses from the OLD figure applied to the NEW image; they can land on
background or a neighbour, and they are what produced the headless "cardigan only" mask.

**Decision — one construction for the character in both rounds:** figure box + exactly ONE
point at the centre of the detector's face box. Detector evidence only; nothing invented.
`r2Prompt` defaults to `'face'` in both `samBlend` and `faceRepair`, and round 1 now passes
the same point (mapped into hatch coordinates). `'box'` (no points) and `'seeds'` (the old
synthesised set) remain selectable for A/B only.

**Evidence:** exp #392 ran all three modes on IDENTICAL stored pixels — box-only, face-point,
and synthetic seeds all passed the gate once the head was anchored, so the guessing adds risk
without adding capability.

**Still asymmetric (documented, not fixed):** round 1 segments the hatch crop (figure box
+12%) while round 2 segments the blend crop, so the two rounds still see slightly different
framings. Face-only repairs keep their own head-mask path with face+hair dots — per the
owner, face detection may differ.

**Touched:** `server/lib/samBlend.js`, `server/lib/faceRepair.js`.

---

## 2026-08-06 — Scores were too harsh: 76% of deductions were one evaluator's unilateral opinion

**Context:** Owner: "many images look good but score 0". Audited all 14 pages of
`job_1786024729214_zrjgzqiey` — 278 deductions, 4121 penalty points, 14 versions at exactly 0.

**Scoring is `max(0, 100 − Σ severity points)`, uncapped.** That model is fine — 7 MINORs is −14,
as it should be. The defect is severity ASSIGNMENT, not the scale, so no cap was added.

**Where the deductions come from:** the consolidator authors 219 of 278 (79%). Its distribution is
catastrophic 2 / critical 47 / **major 133** / moderate 28 / **minor 9** — MINOR is 4.1%. The raw
buckets barely participate (quality 4, semantic 1, compliance 0), since the deduped list replaces
them by construction.

**Four mechanisms, all fixed here:**
1. **The merge rule could only ratchet up.** `feedback-consolidator.txt` said "when evaluators
   disagreed, take the highest" — a pure max. Measured: **208 of 272 issues (76%) were flagged by
   exactly ONE evaluator** and still charged at that evaluator's full severity. Now consensus-based:
   2+ evaluators → keep the highest; single-source → capped at MODERATE.
2. **Two of the three inputs had no low tier to contribute.** `image-semantic.txt` had no MINOR
   level at all (floor MODERATE) and compliance defaults to MODERATE
   (`feedbackConsolidator.js:343`), so max-of-three was structurally biased upward. MINOR added to
   the semantic rubric.
3. **MINOR was unreachable by definition** — "cosmetic: slight colour drift, tiny anatomy quirk,
   faint texture artifact". Small PROMPT deviations (a prop resting in a different orientation, an
   arm at a different angle, one hand where two were described, a garment sub-detail) had no MINOR
   home, so they landed MODERATE minimum and ratcheted to MAJOR. Observed: "notebook standing
   upright on its spine instead of lying flat" charged CRITICAL, the same 25 points as a missing
   character. Definition widened to name that class.
4. **Three inconsistent deduction tables.** Pipeline applies −50/−25/−15/−5/−2; semantic was told
   CRITICAL −30 / MAJOR −20 / MODERATE −10; the consolidator CRITICAL −30 / MAJOR −15 / MODERATE
   −7. Each model calibrated severity against a scale that was not the one applied. All unified to
   the pipeline's table.

Also tightened dedupe to group by CAUSE not wording — one atmosphere described from several angles
was billed three times (45 points for one defect on p1), and one staging fault shared by four
figures was billed four times (60 points on p13).

**Modelled effect** (re-scoring the stored issues with the consensus cap alone, nothing else):
page-best 30→50, 40→70, 48→76, 55→65, 60→80, 60→75, 68→88, 25→65, 55→75, 70→70, 40→60, 70→70,
0→33, 75→85. Mean page-best **50 → 69**, which lands in the intended "ships as-is" band the
consolidator prompt already documents (70+). The widened MINOR tier and the dedupe fix are not in
that model and should add more.

**Note on the consolidator's own score:** `final_score` is audit-only — the pipeline scores from
`deduped_issues`. It is not the lenient number one might assume: across 48 versions it averaged 10
points BELOW the pipeline. Its "be tolerant of small things" paragraph is attached to a number
nobody reads.

**Status:** 🟡 prompt-only changes, staging. The modelled table is arithmetic on stored issues, NOT
a live run — a real story must be generated before trusting the calibration.

**Touched:** `prompts/feedback-consolidator.txt`, `prompts/image-semantic.txt`.

---

## 2026-08-06 — Wardrobe tax: the garment NAME was dropped, not the structural clause

**Context:** "Lily's shorts lack the square bib panel with shoulder straps" was charged MAJOR on
nearly every page and version of `job_1786024729214_zrjgzqiey` — 505 points, 12.3% of all deduction
weight — and no repair ever cleared it.

**Not a new problem, and NOT a reason to reverse the existing rule.** Commit `516efb97e`
(2026-06-10) established with local Grok evidence that a terse "denim dungaree shorts" renders as
plain shorts and that spelling out the parts is what makes it render correctly. That rule stands.

**What actually went wrong:** the writer kept the structural clause but dropped the garment noun.
The rule's own correct example is "denim **dungaree** shorts — square bib panel…"; the story
emitted "light denim **shorts** — square bib panel over the chest held by two shoulder straps".
The image model renders the head noun (plain shorts) and the evaluator reads the clause, so the
garment is reported wrong on every page forever. Proof the spec is the defect rather than the
render: on p9 `char-fix-round-3` the deduction inverts — "shorts depicted WITH bib panel and
shoulder straps instead of plain shorts". The same detail is penalised in both directions.

**Decision:** strengthen the EXISTING rule rather than replace it — the garment name must stay in
front of the parts. (A first attempt at a "one garment = one unambiguous noun phrase" rule was
written and then removed: it would have banned exactly the pattern `516efb97e` proved necessary.)

**Touched:** `prompts/story-unified.txt`, `prompts/story-unified-imagefirst.txt`.

---

## 2026-08-06 — Admin surfaces show the un-clamped score (−10 vs −140), not 0

**Context:** Owner, after the scoring audit: "change so negative scores are shown to admin. Don't
cap them all at 0. Show -10 or -140."

**Most of the feature already existed and was dead end-to-end.** `applyScore` has always written
`version.rawScore = 100 − Σ deductions` un-clamped, with a comment saying it exists so several
0-scored versions can be told apart. `ImageHistoryModal` already rendered `0% (−140)` in three
places via a `versionRawScore` helper. It never appeared because the value never survived the trip:
`rawScore` was missing from the version persist allowlist in `images.js` (fixed earlier today), and
BOTH story response builders in `routes/stories.js` construct version objects field-by-field and
never included it. A stamped field, a client helper and three render sites, joined by nothing.

**Decision:**
1. `scoring.computeRawScore(version)` is the single reader: prefers the stamped `rawScore`, else
   recomputes from the stored `deductions`. The fallback matters — it makes every EXISTING story
   display correctly instead of only stories generated from now on. Note it uses the CAPPED entity
   penalty, so it can differ from a naive sum of raw severity points.
2. Both `/routes/stories.js` version builders emit it.
3. `versionDisplayScore(v, allowNegative)` in `client/src/utils/versionScore.ts` is the display
   reader. Readers keep the clamped score; developer mode passes `allowNegative` and prints the
   negative as THE score (`−140%`), replacing the old `0% (−140)` form.

**Landmine documented, not fixed:** `rawScore` is overloaded. On the re-eval endpoints
(`routes/regeneration.js`) it is the evaluator's 0–10 VISUAL score, a different quantity from the
version's un-clamped total. The display helpers only consult it when negative — which a 0–10 score
never is — so a mistaken call degrades to the clamped score rather than printing nonsense. Typed
and commented in `ScoredVersionLike`.

**Verified** against the 14 zero-scored versions of `job_1786024729214_zrjgzqiey`: they resolve to
−5, −15, −15, −17, −25, −27, −30, −35, −75, −105, −115, −125 and one true 0 — previously all "0%".

**Not changed:** `RepairWorkflowPanel`'s "Final: N%" still prints the clamped server value; showing
negatives there needs the re-eval endpoints to return an un-clamped total.

**Touched:** `server/lib/scoring.js`, `server/routes/stories.js`,
`client/src/utils/versionScore.ts`, `client/src/components/generation/story/ImageHistoryModal.tsx`.

---

## 2026-08-07 — Consolidator is A/B-able in the Test Lab; cyber scoring sets loaded

**Context:** The 2026-08-06 scoring calibration shipped as PROMPT rules and did NOT take effect —
measured on `job_1786053708336_8cdsca519` (ran 22:01–22:35 UTC, every change live): 46 of 60
single-source consolidated issues were still above MODERATE, versus 78% on the story before the
change. Owner's call: don't patch it blind in code, load the story into the Lab and experiment
with different prompts and models.

**Why the prompt rule probably lost:** the consolidator runs on the configured eval model and the
compliance stage on qwen — a conditional instruction ("keep the highest only when two or more
evaluators flagged it, else cap at MODERATE") is exactly what a mid-tier model drops. That is a
hypothesis to TEST in the Lab, not an established fact.

**The `consolidate` stage had no knobs at all** — no prompt override, no model override — despite
authoring ~79% of every page's deductions. `quality_eval` already had `complianceModel` /
`compliancePrompt` (added for the "over-strict CRITICAL" problem); the consolidator had nothing.

**Decision:**
1. `consolidateFeedback` accepts `promptOverride` (the inner call already had `modelOverride`);
   `consolidateEvaluation` accepts and forwards BOTH. Shipped pipeline passes neither, so
   production behaviour is unchanged.
2. `runConsolidateStage` maps Lab `promptOverride` → rules and `params.model` → model, and returns
   `severityMix` + `singleSourceAboveModerate` + `issueCount` so a comparison is readable without
   opening every issue.
3. `consolidate` registered in `STAGE_TEMPLATE_KEYS` (prefills `feedback-consolidator.txt`) and
   flipped to `overridable: true` in the client mirror.
4. Params-JSON placeholders name real model ids for `consolidate` and `quality_eval`.

**Sets loaded** (both on `job_1786053708336_8cdsca519`, 9 pages each — deliberately spanning the
range so a laxer rule cannot be declared a win by only looking at the bad pages):
- **#5 `consolidate`** — "cyber scoring — consolidator A/B"
- **#6 `quality_eval`** — "cyber scoring — quality+compliance A/B"
- Members: p11 (scored 5, good page), p1 (0), p10 (15), p5 (36), p14 (53), p8 (60), and controls
  p2 (100), p7 (100), p6 (95). **The controls are the point** — the failure mode of a lenient rule
  is inflating genuinely broken pages, which is invisible if only low scorers are in the set.

**Touched:** `server/lib/feedbackConsolidator.js`, `server/lib/testlab.js`,
`server/routes/admin/testlab.js`, `client/src/services/testlabService.ts`,
`client/src/pages/TestLab.tsx`.

---

## 2026-08-07 — "Deducted for neon we asked for": measured in the Lab. The judges run hot.

**Context:** Owner: "how would you fix the art issue that we get deduction for neon that we
request. Take the pages, rerun them to see if it is consistent and try with improved prompt."
Six pages of `job_1786053708336_8cdsca519` (p1, p3, p10, p11, p14 + p2 as a 100-scoring control),
stage `quality_eval` (runs the visual evaluator AND the stage-2 compliance evaluator).

**Finding 1 — the deduction is NOT consistent. Two identical baseline runs, same images, same
prompts, same models:**

| page | A run1 | A run2 | B run1 | B run2 |
|---|---|---|---|---|
| p1  | 1 | 1 | **0** | **0** |
| p3  | 1 | 0 | **0** | **0** |
| p10 | 2 | 1 | **0** | **0** |
| p11 | 2 | 2 | 3 | 2 |
| p14 | 4 | 0 | 2 | 0 |
| p2 (control) | 0 | 0 | 0 | 0 |
| **total** | **10** | **4** | **5** | **2** |

Baseline found 10 neon issues in one run and 4 in the next. p14 went 4 → 0. Any single-run prompt
comparison in this pipeline is therefore worthless on its own.

**Finding 2 — root cause of the variance: the judges are not temperature-pinned.**
`images.js:1594` pins the Gemini visual eval to `EVAL_TEMPERATURE` (0). But the compliance and
semantic evaluators — which author most issues — go through `textModels.js`, where the Gemini paths
hardcode **temperature 0.7** (lines 432, 561, no caller override) and the OpenRouter/qwen streaming
path sets **no temperature at all**, taking the provider default (~1.0). The story-style audit had
the same defect and was pinned on 08-06; the same fix was never applied to the evaluators. This is
a prerequisite for any further prompt tuning here.

**Finding 3 — the improved prompt works on the class that is genuinely wrong.** A
"STYLE ELEMENTS ARE PART OF THE SPEC" block (patterned on this file's existing "PRESENCE IS AN
INPUT" rule) added near the top of BOTH the compliance and visual evaluator templates: elements the
ART STYLE block names are required and absent from the scene description by design, so they must
never be reported as unrequested / "not described" / extra / cluttering / anachronistic /
inconsistent with era, location or time of day.

It reproducibly removed the false class — p1 ("kitchen contains neon fixtures not mentioned in
prompt"), p3 ("neon installations contradict the prompt"), p10 ("extraneous neon signs clutter the
riverbank") all went 1–2 findings → **0 in both variant runs**.

It deliberately KEEPS three real defect classes, and all survived: a required prop replaced by a
style element (p11, river-stone planet markers replaced by neon symbols), style signage carrying
readable letters when the descriptor allows shapes only (p11, "R/S/E"), and a named garment
restyled by the palette (p14, glowing circuit pattern on a specified T-shirt).

**Control check:** p2 scored 100 / 95 / 100 / 60. The 60 is NOT the style block — it is two MAJOR
footwear findings ("missing white canvas plimsolls") on a page where the children are bent over a
table and their feet are out of frame. Separate eval noise, and arguably already covered by
image-evaluation.txt's occluded-accessory rule.

**Experiments:** #397, #399 (baseline), #400, #401 (variant) — prompt overrides stored on the rows,
reviewable in `/admin/test-lab`.

**Status:** 🟡 variant NOT shipped — it lives on the experiment rows only. Pin the eval temperature
first; a hot judge makes the next comparison as unreliable as this one nearly was.

**Touched:** `scripts/admin/testlab-run.js` (`--compliance-prompt`, `--compliance-model`,
`--model` flags — quality_eval runs two templates and only one was reachable from the CLI).

---

## 2026-08-07 — Eval judges pinned to temperature 0; style block shipped; scene prose may not ban rendering

Follow-up to the neon experiments (#397/#399 baseline vs #400/#401 variant). Owner picked all
three actions.

**1. The judges are pinned.** `EVAL_TEMPERATURE` (default 0) moves to `server/config/models.js` as
the single source of truth; `images.js` imports it instead of defining its own copy. Applied to
every judging call that was previously hot:
- compliance / three-stage (`images.js`, qwen via OpenRouter — the OpenRouter body set NO
  temperature at all, so it ran at the provider default ~1.0),
- the feedback consolidator (same dispatcher),
- `sceneValidator.js` — `describeImage`, `analyzeGeneratedImage`, `validateComposition` (no
  generationConfig at all) and `evaluateSemanticFidelity` (was 0.3).

`textModels.js` now honours `options.temperature` on the Gemini streaming, Gemini non-streaming and
OpenRouter paths, defaulting to today's 0.7 / provider default. **Story generation is deliberately
untouched** — only callers that are judging rather than writing opt in. Caught while implementing:
`callGeminiTextAPIStreaming` had no `options` parameter, so the passthrough would have thrown at
runtime; signature and its one call site fixed.

**2. Style block shipped** into `image-prompt-compliance.txt` and `image-evaluation.txt` verbatim as
tested in #400/#401.

**3. Scene prose may not ban rendering.** Page 11 read "Wide shot, clear depth layers, no glowing
objects or text" while its own ART STYLE block required neon signage — the page contradicted itself
and the evaluator was right to flag it either way. The Art Director never sees the art style, and
the template's own example ends "no other figures in the room", so it generalised the pattern from
props to rendering. New rule: exclusions may only rule out PEOPLE or PROPS, never how the picture is
drawn. Added to all THREE sites that emit scene prose — `scene-expansion.txt` (the fallback) plus
`story-unified.txt` and `story-unified-imagefirst.txt` (the main writers, which produce most pages).

**Status:** 🟡 staging. The variant measured 0 false neon findings on p1/p3/p10 across both runs, but
that was against an unpinned judge. The clean re-measurement (baseline vs variant on a pinned judge)
has NOT been run — worth doing before master, and it also re-tests whether the 08-06 consensus-cap
rule was genuinely ignored or merely lost in the noise.

**Touched:** `server/config/models.js`, `server/lib/textModels.js`, `server/lib/images.js`,
`server/lib/feedbackConsolidator.js`, `server/lib/sceneValidator.js`,
`prompts/image-evaluation.txt`, `prompts/image-prompt-compliance.txt`,
`prompts/scene-expansion.txt`, `prompts/story-unified.txt`,
`prompts/story-unified-imagefirst.txt`.

---

## Iterate's vision analysis gets the PER-PAGE outfit, never the story-level blob (2026-08-07)

**Context:** Staging story `job_1786053708336_8cdsca519` p10 — a summer story — was regenerated by
iterate with Noah in a "dark green T-Rex hoodie, dark grey sweatpants, blue velcro sneakers" and
Daniel in a "dark blue long-sleeve button-up shirt, light brown chinos". Both strings are the
characters' `avatars.clothing.standard` entries **verbatim**, i.e. wardrobe from an unrelated
earlier story. The story's own data was correct throughout: `clothingRequirements.{Noah,Daniel}.summer`
populated, `pageClothing[10] = {Noah:'summer', Daniel:'summer'}`, and the rewrite's own metadata
even recorded `"clothing": "summer"` for both — only the PROSE was wrong.

Chain: `iteratePageCore` passed the story-level `clothingRequirements` to `analyzeGeneratedImage`
→ `formatCharacterContext` (`sceneValidator.js:305`) reads `clothingRequirements[name]._currentClothing`,
which only the PER-PAGE view carries → absent → defaulted to `'standard'` →
`clothingRequirements[name].standard` is `{used:false}` with no description →
`buildClothingDescription` fell through to `avatars.clothing.standard` → the vision analysis was
told "Currently wearing: <hoodie>" → that text is `previewFeedback.composition` → the scene
rewriter copied the outfit into the new prose → the image model rendered it. The entity check then
flagged the hoodie as a *major* inconsistency (see the sibling entry on entity-penalty attribution).

**Decision:** `iteratePageCore` builds the per-page view with `buildSceneClothingRequirements(cast,
perCharClothing, clothingRequirements)` and passes THAT, plus only the page's own cast, to
`analyzeGeneratedImage`. **A default clothing category is forbidden in this path (owner, 2026-08-07)
— it throws.** Four doors were closed: `formatCharacterContext` throws when `_currentClothing` is
missing and when the resolved category has no description (no `'unknown clothing'` placeholder
either); `iteratePageCore` throws when the page cast has no per-page category (which
`buildSceneClothingRequirements` would otherwise stamp `'standard'`), when `expectedClothing` has no
source, and when the post-rewrite `clothingCategory` has none.

**Rationale:** a guessed category is not a safe default — it is the *mechanism* of the bug. A
category the story doesn't use has no description, so `buildClothingDescription` falls through to
the character-level `avatars.clothing`, i.e. an outfit from an unrelated story, and that text is
then stated as fact to the vision model. Failing the iterate loudly costs one repair attempt;
guessing ships a wrong outfit and then charges the entity penalty to whichever version survives.
`buildSceneClothingRequirements` is the existing single source of truth for "what is
each character wearing on THIS page" (page generation and scale-repair already use it) — iterate was
the one repair path that skipped it. Fixing the resolver's default instead would have hidden the
real defect: the caller was handing over the wrong object. Passing only the page's cast keeps an
absent character's outfit from being offered to the vision model as something to attach to a figure.

**Touched:** `server/lib/images.js` (iteratePageCore step 1), `server/lib/sceneValidator.js`
(formatCharacterContext).

**Status:** ✅ active, verified end to end. Lab experiment **#410** (`iterate` on p10 of
`job_1786053708336_8cdsca519`, staging) rendered Noah in the sky-blue polo + olive shorts + white
Velcro trainers and Daniel in the mid-grey shirt + navy chino shorts + brown sandals — the story's
own summer outfits, in the prose, the image prompt's per-character `wears:` lines, and the pixels.
Daniel also came back an ADULT: the analysis now carries his real age (38) because only the page's
cast is passed with correct per-page clothing, so the rewriter no longer inherits the evaluator's
"kindergartner" wording. Non-clothing defects persist in that render and are tracked separately
(Daniel rendered mid-ground rather than tiny — the "a sixth Noah's height" phrasing survives; a
duplicated NEPTUNE stone with Venus/Earth transposed; residual `cyber`-style neon signage).

---

## 2026-08-07 — E1/E2: temperature is NOT the noise source; the model is NOT why the consensus rule failed

Two experiments run in the Lab on `job_1786053708336_8cdsca519`. Both returned negative results
that overturned a working assumption, which is why they were worth the ~10 minutes.

**E1 — pinning temperature did NOT make the judges deterministic.** Experiments #403/#404: same six
pages, same prompts, temperature pinned to 0 across compliance, semantic, the consolidator and all
four sceneValidator judges. Result: **0 of 6 pages produced an identical issue set.** p1 4→7 issues,
p2 3→1 (final 70→95), p3 2→3 (60→30), p14 5→3.

One cause found and fixed: the three-stage **stage-1 vision inventory** — the blind free-text image
description every compliance finding is derived from — was still at `temperature: 0.3`. If that
description varies, findings vary regardless of how deterministic the judges are. Now pinned.
Remaining suspects, untested: OpenRouter routes to different providers per call
(`fastProviderOrder`), and Gemini is not bit-deterministic at temperature 0 either. **Do not assume
determinism is achievable here** — the practical answer is to compare over repeats, not to trust a
single run. The pin is still worth keeping (it removes one of several sources) but it did not buy
what was expected.

**E2 — the consolidator model is not why the 08-06 consensus rule was ignored.** Experiments
#405/#407/#408/#409: identical stored eval as input (the consolidate stage replays it, so upstream
noise is excluded), shipped rules unchanged, only the model varied.

| model | issues | crit | major | mod | minor | single-source above MODERATE |
|---|---|---|---|---|---|---|
| qwen-plus (current default) | 20 | 7 | 10 | 2 | 1 | 6 |
| qwen3-max | 20 | 8 | 7 | 2 | 3 | 4 |
| claude-sonnet | 20 | 8 | 7 | 2 | 3 | 4 |
| gemini-2.5-flash | 0 | — | — | — | — | 0 (**errored — returns an empty plan on every page**) |

Claude Sonnet finds the same 20 issues, MORE criticals, and still leaves 4 single-source findings
above MODERATE. The hypothesis "a mid-tier model drops the conditional instruction" is **disproved**;
upgrading the model buys nothing here. Note also that `gemini-2.5-flash` fails as a consolidator and
would silently zero every deduction — never configure it for this call.

**Decision: NO code cap. Owner call, 2026-08-07 — do not re-add it.**
A `capSingleSourceSeverity()` backstop was written and then REVERTED at the owner's instruction.
Modelled effect before reverting (kept only as a record of what was on the table): cyber story
page-best mean 63.6 → 73.6, earlier story 49.7 → 68.7, its 0-scoring page rising to 33.

Rationale for the reversal is the owner's to state, but the standing constraint is clear: severity
policy lives in the consolidator prompt, and the pipeline does not silently rewrite what an
evaluator returned. A future session that rediscovers the 78%-single-source statistic must NOT
"fix" it in code — that path has been tried and rejected. Options that remain open: prompt
iteration in the Lab (sets #5/#6 are loaded for exactly this), changing what the evaluators are
asked to emit, or accepting the current calibration.

**Kept from this commit:** the stage-1 vision temperature pin only.

**Touched:** `server/lib/images.js` (stage-1 vision pin). The consolidator is unchanged.

---

## No default clothing category anywhere — resolve canonically or refuse (2026-08-07)

**Context:** the iterate outfit leak above was not one bad line. `|| 'standard'` appeared at ~20
sites as the tail of every clothing-category resolution. The pattern is uniformly wrong for the same
reason: `'standard'` is a category most stories never use, so it has no per-story description, so
`buildClothingDescription` falls through to the character-level `avatars.clothing.standard` — an
outfit from an unrelated earlier story. A "safe default" therefore silently sources wardrobe from
another book. Owner ruling: **"Fallback to default clothing is forbidden. Rather fail loudly."**

**Decision:** every clothing-category resolution either resolves from a canonical source (per-page
`perCharClothing` → `resolvePageClothingCategory` → the story's `primaryClothing` → a
`costumed.used` story's sole outfit) or refuses. Refusal takes the form that loses least work:

| refusal | sites |
| --- | --- |
| **throw** — a wrong outfit would be rendered | `storyHelpers.buildSceneClothingRequirements`, `sceneValidator.formatCharacterContext`, `iteratePageCore` (expectedClothing, post-rewrite category, empty clothing map), `coverIterate`, `compositeCastBuilder` (both cover sites) |
| **error result / HTTP 422** — caller can report it | char-fix in the unified pipeline, `entityConsistency.repairSinglePage`, `regeneration.js` (regen scene, cover + page reference photos, both char-repair paths) |
| **log.error + skip this character** — cosmetic pass, story survives | garment-hue + garment-colour avatar resolution (3 sites), inpaint's missing-character avatar reference, entity-grid crop collection, `styledAvatars.ensureStyledAvatarCoverage`, `testlab` avatar lookups, `stories.js` reference-photo rebuild |
| **propagate null** — "unknown", never "standard" | `outlineParser/unified.js` (the origin of every category), the page-level `clothing` label into the entity check, the entity-grid cell label (sends `'unknown'`, which the judge has no expectations for) |

Untouched on purpose: `r2.js` filename sanitisation (`'standard'` is a path segment, not an outfit)
and every `languageLevel || 'standard'` (unrelated meaning of the same word).

**Rationale:** a guessed category is not a degraded-but-usable answer — it is a confident wrong one,
and it enters the pipeline as fact (prompt text, reference image, colour target, or judge label).
The four refusal modes exist so the cost matches the stake: a cosmetic hue pass skips one character,
a render that would bake in the wrong outfit stops.

**Touched:** `server/lib/images.js`, `server/lib/sceneValidator.js`, `server/lib/entityConsistency.js`,
`server/lib/storyHelpers.js`, `server/lib/coverIterate.js`, `server/lib/compositeCastBuilder.js`,
`server/lib/styledAvatars.js`, `server/lib/testlab.js`, `server/lib/outlineParser/unified.js`,
`server/routes/regeneration.js`, `server/routes/stories.js`.

**Status:** 🟡 staging pending. Syntax-checked; the refusal paths are by construction unreachable on
data that carries per-page clothing (verified on `job_1786053708336_8cdsca519`), but a story with a
genuine data gap will now fail where it previously shipped a wrong outfit — that is the intent, and
it needs a full generation run to confirm nothing legitimate trips it.

## MobileSAM figure-mask must be serialized — concurrency race, not memory (2026-08-08)

**Context:** A cyber-anime story (`job_1786053708336`) logged `SAM mask entirely outside the DINO box`
on ~10/14 pages, so every figure fell back to its raw box and masked character-repair was effectively
off. First-guess causes (a coordinate transposition, then memory pressure) were both **wrong**: the
stored boxes were correct once read as the app's Gemini y-first convention, and there was **no OOM**
in the run (no kill, no allocation error; idle RSS ~132 MB). A fresh single-request GDINO+SAM replay
on the same pages produced 10/10 clean masks. The differentiator is concurrency: the analyzer serves
via **waitress with 24 threads in one process**, and MobileSAM was the one heavy model whose inference
was neither locked server-side nor routed through Node's `withAnalyzerSlot` (rembg, GroundingDINO, and
the *other* figure-mask caller all are). ultralytics' SAM predictor stashes the run's image / prompts /
results on one shared object (see `_free_sam_cache`), so parallel repair-phase mask calls interleaved
and returned masks for the wrong image.

**Decision:** Serialize all MobileSAM access. Added `_mobilesam_lock` guarding load, inference,
per-call cache-clear, and idle-unload in `photo_analyzer.py`; the mask is copied off the predictor to a
plain numpy array inside the lock and the rest of the endpoint runs lock-free on that copy. Node-side,
`_mobilesamMaskFull` now goes through `withAnalyzerSlot` like every other analyzer call, bounding the
in-flight queue. Separately — keep the models warm for the WHOLE story instead of reloading them cold at repair. A
story warms the analyzer at story-start, but the models aren't needed until the repair phase 20-30 min
later, and the text+image phase makes zero analyzer calls, so the 15-min idle model-reaper unloaded
them and repair hit them cold. Fix: the idle model-reaper now skips while the warm-hold is active
(`now < _recycle_hold_until`), and `RECYCLE_WARM_HOLD_S` is bumped 900→2400 s so one story-start
`/warmup` keeps every model resident for a full story; the pipeline also fires
`ensureWarm('repair-phase', {force:true})` to refresh the hold for anything longer. The hold lapses
between stories, so idle reclaim (models + self-recycle) still happens — memory is only held while a
story is actually running, which is exactly the owner's rule (optimize for speed, reclaim when idle).

**Rationale:** The failure was correctness under concurrency, so the fix is a lock, not memory
management. Memory was explicitly NOT the problem — the self-recycle already reclaims between stories
(idle RSS is tiny) and there was no OOM; per owner direction we optimize for speed and only reclaim
when idle, so NO mid-story recycling was added. Serializing SAM costs throughput (one inference at a
time) but the calls contended on the CPU quota anyway; correctness wins.

**Touched:** `photo_analyzer.py` (`_mobilesam_lock` + guarded load/inference/cache/unload; idle
model-reaper respects the warm-hold; `RECYCLE_WARM_HOLD_S` 900→2400),
`server/lib/images.js` (`_mobilesamMaskFull` via `withAnalyzerSlot`),
`server/lib/analyzerClient.js` (`ensureWarm` force option), `server.js` (repair-phase warm).

**Status:** ✅ shipped to staging — needs a real multi-figure story run to confirm the masks land under
concurrency (staging-only path; prod uses the Gemini bbox but DOES use MobileSAM for repair masks, so
the lock + warm help prod too).
