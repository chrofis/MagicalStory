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
| story-trial.txt | storyHelpers.js `buildTrialStoryPrompt` | Trial story call |
| trial-idea.txt | trial.js `POST /generate-ideas-stream` | Trial idea generation |
| generate-story-ideas.txt | storyIdeas.js `buildIdeasPromptContext` | Wizard story ideas (multi) |
| generate-story-idea-single.txt | storyIdeas.js `buildIdeasPromptContext` | Wizard story idea (single) |
| story-idea-requirements-adventure-1/-2.txt | storyIdeas.js `buildIdeasPromptContext` | Idea requirements (adventure) |
| story-idea-requirements-historical-1/-2.txt | storyIdeas.js `buildIdeasPromptContext` | Idea requirements (historical) |
| adventure-guides.txt | storyHelpers.js `parseTeachingGuideFile` | Teaching guide injected into story call |
| educational-guides.txt | storyHelpers.js `parseTeachingGuideFile` | Teaching guide |
| life-challenge-guides.txt | storyHelpers.js `parseTeachingGuideFile` | Teaching guide (SEL/therapeutic) |
| historical-guides.txt | storyHelpers.js; historicalEvents.js; trialCostumes.js | Teaching guide + historical locations |
| swiss-sagen-guides.txt | storyHelpers.js; storyIdeas.js | Teaching guide (Swiss legends) |
| text-consistency-check.txt | textModels.js `evaluateTextConsistency` | **DEAD in prod** — imported in server.js but never called |

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

| Template | Consumer | Stage |
|---|---|---|
| image-evaluation.txt | images.js `evaluateImageQuality`; regeneration.js evaluate-single | Quality eval (fix_targets need gemini-2.5-flash) |
| image-semantic.txt | images.js `evaluateThreeStage`; sceneValidator.js `evaluateSemanticFidelity` | Semantic fidelity eval |
| image-vision-inventory.txt | images.js `evaluateThreeStage` | Three-stage eval: vision inventory |
| image-prompt-compliance.txt | images.js `evaluateThreeStage` | Three-stage eval: prompt compliance |
| image-visual-inventory.txt | images.js `runVisualInventory`; regeneration.js | Visual inventory pass |
| image-inspection.txt | images.js `inspectImageForErrors` | Image error inspection |
| generated-image-analysis.txt | sceneValidator.js `analyzeGeneratedImage` | Generated-image analysis |
| feedback-consolidator.txt | feedbackConsolidator.js `consolidateFeedback` | Consolidates eval + entity issues into per-page fix plan |
| repair-verification.txt | repairVerification.js `verifyRepairWithGemini` | Verifies a repair changed the target region |

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
| final-consistency-check.txt | images.js `evaluateSingleBatch` | Final consistency batch |
| visual-bible-analysis.txt | visualBible.js `analyzeVisualBibleElements` | VB element analysis |
| reference-sheet.txt | images.js `buildReferenceSheetPrompt` | Element reference sheet generation |

## Repair (image)

| Template | Consumer | Stage |
|---|---|---|
| character-repair-cutout.txt | images.js `repairCharacterMismatchWithGrok` | Grok cutout repair |
| character-repair-blended.txt | images.js `repairCharacterMismatchWithGrok` | Grok blended repair |
| character-repair-body-blended.txt | images.js `repairCharacterMismatchWithGrok` | Grok body-blended repair |
| character-repair-inpaint.txt | images.js `repairCharacterMismatchWithGrok` | Char repair via inpaint |
| character-repair-grok-fullscene.txt | images.js `repairCharacterMismatchWithGrok` (LOCAL_PROMPTS) | Full-scene Grok repair |
| character-repair-gemini.txt | images.js `repairCharacterMismatch` (LOCAL_PROMPTS) | Gemini-backend char repair |
| inpainting.txt | images.js `inpaintWithMask` | Mask inpainting (Runware) |
| inpaint-grok-regions.txt | images.js `inpaintWithGrokBackend` (LOCAL_PROMPTS) | Grok region inpainting |
| grid-repair.txt | repairGrid.js | Grid-based repair (legacy) |
| text-space-repair.txt | textSpaceRepair.js `ensureCalmZone` | Text calm-zone repair |
| style-transfer.txt | images.js `applyStyleTransfer` (LOCAL_PROMPTS) | Style transfer repair |

## Covers

| Template | Consumer | Stage |
|---|---|---|
| front-cover.txt | coverIterate.js (`frontCover` / derived `frontCoverTextless`) | Front cover |
| back-cover.txt | coverIterate.js (`backCover` / derived `backCoverTextless`) | Back cover |
| initial-page-with-dedication.txt | coverIterate.js | Initial page (dedication) |
| initial-page-no-dedication.txt | coverIterate.js | Initial page (no dedication) |

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
