# Prompt Inventory — every template, its consumer, and its pipeline stage

> Complete inventory of all files in `prompts/` plus the hardcoded prompt builders that
> live in JS. Generated from a full-code audit on 2026-07-17. **Keep this file updated
> when adding/removing/renaming a prompt template** — it is the single source of truth;
> CLAUDE.md only lists the most-touched templates.

Three loading mechanisms feed these templates:

1. **`server/services/prompts.js` → `loadPromptTemplates()`** — builds `PROMPT_TEMPLATES{}`
   from a ~50-entry `FILES` list. Derived keys: `sceneDescriptions` (alias of
   `sceneIteration`), `frontCoverTextless`, `backCoverTextless`.
2. **`server/lib/images.js` `LOCAL_PROMPTS{}`** — direct `fs.readFileSync` at module load
   (bbox-refine-overlay, iterative-placement-pass1/2, character-repair-gemini,
   character-repair-grok-fullscene, inpaint-grok-regions, style-transfer).
3. **Direct reads in feature modules** — the `*-guides.txt`, `art-styles.txt`,
   `generate-story-idea*`, `story-idea-requirements-*`, `grid-repair.txt`.

## Story text & ideas

| Template | Consumer | Stage |
|---|---|---|
| story-unified.txt | storyHelpers.js `buildUnifiedStoryPrompt` | Unified story call (outline + VB + text + hints) |
| story-unified-imagefirst.txt | storyHelpers.js `buildUnifiedStoryPrompt` (when `inputData.storyPromptVariant === 'imageFirst'`) | Image-first variant of the unified call — authoring order arc → scene designs → ALL scene authoring (`---SCENE PAGES---`: SCENE prose + METADATA per page) → text-only STORY DRAFT. Parsers detect the `---SCENE PAGES---` marker (scene-first format); original format parses byte-identically (2026-07-31 restructure) |
| outline-analysis-textfirst.txt | storyHelpers.js `buildUnifiedStoryPrompt` + `buildOutlineReviewPrompt` | ANALYSIS instruction body for story-unified.txt (`{ANALYSIS_INSTRUCTIONS}` placeholder). Single-call mode injects it into the writer prompt; split mode injects it into the reviewer prompt instead |
| outline-analysis-imagefirst.txt | storyHelpers.js `buildUnifiedStoryPrompt` + `buildOutlineReviewPrompt` | ANALYSIS instruction body for story-unified-imagefirst.txt — same dual use as above |
| outline-review.txt | storyHelpers.js `buildOutlineReviewPrompt`; server.js split-review seam | External outline review (split mode, default ON): Opus receives the writer's full output + the same analysis instructions + REVIEW HINTS (deterministic scene-consistency findings) and emits ANALYSIS + FIXES REQUIRED + STORY PAGES patches; owns all SEMANTIC scene-consistency judgment (decisions.md 2026-07-31) |
| story-beats.txt | storyHelpers.js `buildBeatsPrompt` | Beats-first pipeline step 1 (`pipelineMode: 'beats'`) + Test Lab `beats_scenes`: per-page BEAT + one-line SCENE |
| story-beats-review.txt | storyHelpers.js `buildBeatsReviewPrompt` | Beats-first step 2: structural review, rewrites only faulted pages |
| story-arc-audit.txt | storyHelpers.js `buildArcAuditPrompt` | Blind arc audit: commission + arc only, exhaustive fault list for the reviewer ledger |
| story-beats-audit.txt | storyHelpers.js `buildBeatsAuditPrompt` | Blind beats audit: page plan + beats only |
| story-text-audit.txt | storyHelpers.js `buildTextAuditPrompt` | Blind text audit: back cover + pages + DEPICTS-only picture info |
| story-text-proofread.txt | `storyTextProofread` | textRefine.js re-audit step | Sentence-level proofread of the FINAL text (article/gender, quote nesting, spelling, self-contradiction, non-words); findings merge into the corrective round |
| book-audit.txt | bookAudit.js `auditStoryBook` (via `PROMPT_TEMPLATES.bookAudit`) | Final-book audit — the reader's-eye pass. Runs after covers, before persist: each page's TEXT then its SHIPPED IMAGE, interleaved as vision parts in reading order, ~6 pages per Gemini flash call. Emits `FAULT[IMG]:` / `FAULT[TEXT]:` routed by which artefact would fix it. Word/picture BALANCE is never a fault |
| story-child-critic.txt | storyHelpers.js `buildChildCriticPrompt` | Child critic of the arc, in PARALLEL with story-arc-audit: role-plays the youngest main character's age, retells the arc, then emits `FAULT[CHILD]:` lines for comprehension/boredom/fear only. Its faults join the same arc-review ledger |
| title-judge.txt | storyHelpers.js `buildTitleJudgePrompt`; storyJobPipeline.js (final title selection) | Picks the shipped title from `titleCandidates` (adventure/bond over vehicle, no spoiler, sayable at the age). Non-blocking — failure keeps the deterministic hash pick |
| scene-review.txt | storyHelpers.js `buildSceneReviewPrompt` | Beats-first step 4: ONE review over ALL scene briefs (repetition, arc, continuity) |
| clothing-review.txt | storyHelpers.js `buildClothingReviewPrompt` | Beats-first step 3b: wardrobe review over the bible's clothing contract, BEFORE the styled-avatar kickoff. Emits `---ANALYSIS---` + `---CLOTHING---`, parsed by `parseClothingReview` |
| story-text-from-beats.txt | storyHelpers.js `buildStoryTextFromBeatsPrompt` | Beats-first step 5: page TEXT written from the locked beats. Emits `---TITLE---` + `---ANALYSIS---` + `---STORY TEXT---` so `parseRefinedText` reads it |
| text-refine.txt | storyHelpers.js `buildTextRefinePrompt` | Post-image text refinement (both pipelines) |
| story-trial.txt | storyHelpers.js `buildTrialStoryPrompt` | Trial story call |
| trial-idea.txt | trial.js `POST /generate-ideas-stream` | Trial idea generation |
| toddler-mode.txt | promptBuilders.js `buildToddlerModeSection` → `{TODDLER_MODE}` in story-trial, story-beats, trial-idea, generate-story-idea(s) | Content rules when the oldest MAIN character is ≤ 3; empty at every other age |
| generate-story-ideas.txt | storyIdeas.js `buildIdeasPromptContext` | Wizard story ideas (multi) |
| generate-story-idea-single.txt | storyIdeas.js `buildIdeasPromptContext` | Wizard story idea (single) |
| story-idea-requirements-adventure-1/-2.txt | storyIdeas.js `buildIdeasPromptContext` | Idea requirements (adventure) |
| story-idea-requirements-historical-1/-2.txt | storyIdeas.js `buildIdeasPromptContext` | Idea requirements (historical) |
| adventure-guides.txt | storyHelpers.js `parseTeachingGuideFile` | Teaching guide injected into story call |
| educational-guides.txt | storyHelpers.js `parseTeachingGuideFile` | Teaching guide |
| life-challenge-guides.txt | storyHelpers.js `parseTeachingGuideFile` | Teaching guide (SEL/therapeutic) |
| historical-guides.txt | storyHelpers.js; historicalEvents.js; trialCostumes.js | Teaching guide + historical locations |
| swiss-sagen-guides.txt | storyHelpers.js; storyIdeas.js | Teaching guide (Swiss legends) |
| ~~text-consistency-check.txt~~ | — | **DELETED 2026-07-26** — `evaluateTextConsistency` was dead (imported, never called); removed in the Pt 10 cleanup (decisions.md) |

## Scene expansion

| Template | Consumer | Stage |
|---|---|---|
| scene-expansion.txt | storyHelpers.js `buildSceneExpansionPrompt` | Art Director: outline hint → illustration brief |
| scene-iteration.txt | storyHelpers.js `buildSceneDescriptionPrompt` (via `sceneDescriptions` alias) | Scene re-description on iterate |
| scene-iteration-free.txt | storyHelpers.js `buildSceneDescriptionPrompt` | Free-form scene iteration |
| scene-repair.txt | sceneValidator.js `repairScene` | Scene-description repair |
| rewrite-blocked-scene.txt | images.js `rewriteBlockedScene` | Rewrite scene after provider safety block |

## Empty scenes & page images

| Template | Consumer | Stage |
|---|---|---|
| empty-scene.txt | prompts.js `buildEmptyScenePrompt` (→ images.js, server.js, coverIterate.js) | Background-only scene generation |
| image-generation.txt | storyHelpers.js `buildImagePrompt`; testlab.js | Page illustration prompt (single unified template) |
| image-system-instruction.txt | images.js (~212) | System instruction for image calls |
| art-styles.txt | styledAvatars.js `loadArtStylePrompts`; avatars.js | Art-style descriptor per style. ⚠ duplicated hardcoded copies exist in sceneComposite.js (~893) and character2x4Sheet.js (~395) — keep aligned |
| iterative-placement-pass1.txt | images.js `generateWithIterativePlacement` (LOCAL_PROMPTS) | Iterative placement pass 1 (dev/test-models path) |
| iterative-placement-pass2.txt | images.js `generateWithIterativePlacement` | Iterative placement pass 2 |
| illustration-edit.txt | images.js `editImageWithPrompt` | Targeted illustration edit |

## Evaluation

> **SIZE WARNING (measured 2026-08-08, re-measured 2026-08-09).** These templates grow into
> incident logs — a paragraph per false positive somebody once hit. `image-evaluation.txt` had
> reached **36,321 chars / 406 lines**, with 129 bullet rules and 119 instances of "never / do
> not deduct"; filled for one page that was **46,019 chars ≈ 11,500 tokens**, and a 10-page
> story spent **862,221 input tokens across 109 eval calls — ~86k input tokens PER PAGE**.
> The 2026-08-09 overhaul restructured it into four sections (A never-deduct N-01…N-15,
> B severity, C defects D-01…D-28, D output) and cut it to **18,511 chars / 180 lines** — 49%
> smaller. Rules inside these templates are demonstrably not applied reliably ("missing
> glasses" came back MAJOR five times in one story despite a rule capping it), and two
> identical runs at temperature 0 produced 0 of 6 identical issue sets. Treat length as a
> defect: see `docs/decisions.md` 2026-08-08 "Eval prompts are too long".
>
> **A lean rewrite is not automatically better.** The first lean overhaul measured *worse*
> (21.3 → 7.5/16.5) and was reverted before the owner overrode and shipped the current one.
> Measure over a corpus, never on the page that motivated the change.
>
> **RULE when an eval misfires: do not append another carve-out paragraph.** First check whether
> a rule for it already exists and is being ignored. If it does, the fix is consolidation or
> removal, not addition — adding text to a template this size measurably buys nothing and makes
> the next person's rule less likely to be read. Prefer deleting or merging over appending.

Sizes measured 2026-08-09.

| Template | chars | lines | Consumer | Stage |
|---|---|---|---|---|
| image-evaluation.txt | 18,511 | 180 | images.js `evaluateImageQuality`; regeneration.js evaluate-single | Quality eval (fix_targets need gemini-2.5-flash) |
| image-semantic.txt | 16,061 | 151 | images.js `evaluateThreeStage`; sceneValidator.js `evaluateSemanticFidelity` | Semantic fidelity eval |
| image-vision-inventory.txt | 2,039 | 32 | images.js `evaluateThreeStage` | Three-stage eval: vision inventory |
| image-prompt-compliance.txt | 15,268 | 155 | images.js `evaluateThreeStage` | Three-stage eval: prompt compliance (never sees the image) |
| image-visual-inventory.txt | 5,377 | 138 | images.js `runVisualInventory`; regeneration.js | Visual inventory pass |
| image-inspection.txt | 2,457 | 52 | images.js `inspectImageForErrors` | Image error inspection |
| generated-image-analysis.txt | 1,106 | 39 | sceneValidator.js `analyzeGeneratedImage` | Generated-image analysis |
| feedback-consolidator.txt | 17,739 | 167 | feedbackConsolidator.js `consolidateFeedback` | Merges all four evaluators into `deduped_issues[]` — **this list is what scoring charges** |
| repair-verification.txt | 1,799 | 48 | repairVerification.js `verifyRepairWithGemini` | Verifies a repair changed the target region |
| story-text-quality-judge.txt | 2,880 | 48 | textQualityJudge.js `judgeStoryText` | Test Lab text-only harness: scores story TEXT on 5 criteria (cross-model judge) |
| story-scorecard-judge.txt | 2,398 | 50 | testlab.js `runStoryScorecardStage` / storyScorecard.js | Test Lab `story_scorecard` stage: LLM judge rates 4 final artifacts (beats/scene/text/VB) on a 4×5 rubric for model comparison |
| story-retell-judge.txt | 1,263 | 20 | storyScorecard.js evaluator `4.4` (`storyRetellJudge`) / testlab.js `scoreArtifactsWithJudge` | Evaluator 4.4 "child listener": role-plays the target-age child, retells the finished text, then scores ONE artifact (storyText) on comprehension/stake/resolution/engagement. Own rubric (RETELL_RUBRIC) — never comparable with 4.1-4.3 |

## Bounding boxes

| Template | Consumer | Stage |
|---|---|---|
| bounding-box-detection.txt | images.js `detectAllBoundingBoxes` | Pass-1 bbox detection (Gemini path) |
| bbox-refine.txt | regeneration.js refresh-bbox handler | Bbox refinement (2-pass) |
| bbox-refine-overlay.txt | images.js `detectAllBoundingBoxes` (LOCAL_PROMPTS) | Bbox refine with overlay |
| sub-region-detection.txt | images.js `detectSubRegion` | Sub-region detection |

## Entity consistency & visual bible

| Template | Consumer | Stage |
|---|---|---|
| entity-consistency-check.txt | entityConsistency.js `evaluateEntityConsistency` | Cross-page entity consistency eval |
| entity-single-page-repair.txt | entityConsistency.js `repairSinglePage` | Single-page entity repair |
| incremental-consistency-check.txt | images.js `evaluateIncrementalConsistency` | Incremental consistency |
| ~~final-consistency-check.txt~~ | — | **DELETED 2026-07-26** — `runFinalConsistencyChecks`/`evaluateSingleBatch` chain was dead (imported, never called); removed in the Pt 10 cleanup (decisions.md) |
| visual-bible-analysis.txt | visualBible.js `analyzeVisualBibleElements` | VB element analysis |
| reference-sheet.txt | images.js `buildReferenceSheetPrompt` | Element reference sheet generation |

## Repair (image)

| Template | Consumer | Stage |
|---|---|---|
| character-repair-cutout.txt | images.js `repairCharacterMismatchWithGrok` | Grok cutout repair |
| character-repair-blended.txt | images.js `repairCharacterMismatchWithGrok` | Grok blended repair |
| `repair-naturalness.txt` | faceRepair.js checkRepairNaturalness | post-repair figure-integrity check: MATCH/EDGES observations -> enum; clearly off rejects the repaint |
| character-repair-body-blended.txt | images.js `repairCharacterMismatchWithGrok` | Grok body-blended repair |
| character-repair-inpaint.txt | images.js `repairCharacterMismatchWithGrok` | Char repair via inpaint |
| character-repair-grok-fullscene.txt | images.js `repairCharacterMismatchWithGrok` (LOCAL_PROMPTS) | Full-scene Grok repair |
| character-repair-gemini.txt | images.js `repairCharacterMismatch` (LOCAL_PROMPTS) | Gemini-backend char repair |
| inpainting.txt | images.js `inpaintWithMask` | Mask inpainting (Runware) — **DEAD CHAIN**, no live caller |
| inpaint-grok-regions.txt | images.js `inpaintWithGrokBackend` (LOCAL_PROMPTS) | Grok region inpainting — **DEAD CHAIN**. The LIVE `inpaint` repair method is `inpaintPage` → `editImageWithPrompt` (whole-image edit, no mask) |
| grid-repair.txt | repairGrid.js | Grid-based repair (legacy) |
| text-space-repair.txt | textSpaceRepair.js `ensureCalmZone` | Text calm-zone repair |
| style-transfer.txt | images.js `applyStyleTransfer` (LOCAL_PROMPTS) | Style transfer repair |

## Covers

| Template | Consumer | Stage |
|---|---|---|
| cover-composition.txt | promptBuilders.js `buildCoverPrompt` (`coverComposition`) | Cover-only composition bullets (front / initialPage / back), injected into image-generation.txt. RETIRED 2026-08-26: front-cover.txt, back-cover.txt, initial-page-with-dedication.txt, initial-page-no-dedication.txt and the derived textless variants — a cover is now built from the SAME image-generation template as a page, plus the typography pass. |

Note: `PROMPT_TEMPLATES.coverImageEvaluation` is referenced in regeneration.js but the file
was deliberately deleted — callers guard and fall back to `imageEvaluation`. By design.

## Avatars

| Template | Consumer | Stage |
|---|---|---|
| avatar-main-prompt.txt | avatars.js | Gemini avatar generation |
| avatar-system-instruction.txt | avatars.js | Avatar system instruction |
| avatar-retry-prompt.txt | avatars.js `POST /generate-clothing-avatars` | Avatar retry |
| avatar-ace-prompt.txt | avatars.js | Runware ACE++ avatars (route exists; ACE++ has no prod pipeline caller) |
| avatar-evaluation.txt | avatars.js `evaluateAvatarFaceMatch` | Avatar face-match eval |
| character-analysis.txt | avatars.js `extractTraitsWithGemini` | Photo trait extraction |
| sheet-2x4-evaluation.txt | character2x4Sheet.js `evaluateSheetWithGemini` | 2×4 sheet eval (pass 1) |
| sheet-2x4-style-eval.txt | character2x4Sheet.js `evaluateStyledSheetWithGemini` | 2×4 styled sheet eval (pass 2) |
| styled-costumed-avatar.txt | **DEAD in prod** — loaded but only tests/manual + scripts use it; superseded by hardcoded 2×4 sheet pipeline | — |
| styled-costumed-avatar-2x4.txt | **Never loaded** — scripts/test-costumed-2x4.js only | — |

## Hardcoded prompts (NOT in prompts/ — live in JS)

These act like templates but can only be edited in code:

| Location | What it builds |
|---|---|
| `character2x4Sheet.js` `buildPrompt()` | **Pass-1 realistic 2×4 character-sheet prompt** (the live costumed-avatar generator) |
| `character2x4Sheet.js` `buildStyleTransferPrompt(artStyle)` | **Pass-2 style-transfer prompt** |
| `avatars.js` `getClothingStylePrompt(category, isFemale)` | Clothing-style fragments |
| `grok.js` (~313) | Magenta-padding outpaint instruction prefix |
| `coverIterate.js` (`feedbackParts`, ~331) | Cover feedback block + visual-bible prose assembly |
| `sceneComposite.js` (~893), `character2x4Sheet.js` (~395) | Duplicated art-style descriptor tables — comments require alignment with `prompts/art-styles.txt` |
| `sceneComposite.js` `buildPopulatedPlatePrompt` | Coloured-silhouette plate for the page composite (hardcoded, not a template) |
| `sceneComposite.js` `buildDepopulatePrompt` | Removes the silhouettes to leave a clean background plate (hardcoded) |
| `sceneComposite.js` `buildBlendEditPrompt` | The composite BLEND prompt: goal + scene overview + cast (clothing/action) + interactions + emotions from metadata. **Never the page prompt** — that relocates characters (decisions.md 2026-08-15). Built from `buildBlendMetadata` (hardcoded) |
