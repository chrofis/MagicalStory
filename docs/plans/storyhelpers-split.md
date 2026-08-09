# storyHelpers.js Split — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.
> Review checkpoint after every wave. Commits allowed; **NO PUSHES** — owner pushes.
> Do NOT start while another structural batch is undeployed/unvalidated.

**Goal:** break `server/lib/storyHelpers.js` (7,256 lines, 110 top-level functions) into domain modules so parallel agents stop colliding in it and sessions stop reading 7k lines to edit 20 — with **zero behavior change and zero importer churn**.

**The load-bearing decision — facade, not sweep:** 42 files require `storyHelpers`. We do NOT touch them. `storyHelpers.js` becomes a re-export facade (`module.exports = { ...require('./promptBuilders'), ...require('./sceneMetadata'), ... }`); every existing import keeps working byte-identically. Importers migrate to direct requires opportunistically later (or never). This turns a 42-file sweeping-shape-change into a 4-file move.

**Rules (non-negotiable):**
- **Verbatim moves only.** No renames, no signature changes, no "while I'm here" cleanups, no reformatting — `git diff --color-moved` must show pure moves. Refactoring inside functions is a separate future task.
- One wave per commit; each wave independently verified and revertable.
- Circular-require check every wave: `images.js ↔ storyHelpers` interdependence is known; if a moved function needs something from another bucket, use a lazy `require()` inside the function (existing repo pattern) rather than a top-level import — and note it in the commit.
- Module-load verification must use `node --check` + targeted stub execution — full `require()` of pipeline modules hangs on open handles (known; do not "fix" that here).

## Target modules (buckets)

| New module | Contents (representatives — Task 1 completes the list) |
|---|---|
| `server/lib/promptBuilders.js` | `buildImagePrompt`, cover/empty-scene/scene-review/scene-expansion prompt builders (`buildSceneReviewPrompt`, `buildSceneExpansionAllPrompt`, …), text-area instruction |
| `server/lib/sceneMetadata.js` | `extractSceneMetadata`, `parseProseMetadataFormat`, position handling (`normalizePositionToLCR`, `POSITION_ABBREVIATIONS`), page/marker parsers |
| `server/lib/clothingResolve.js` | `resolveCharacterReqs`, `buildClothingDescription`, `buildAvailableAvatarsForPrompt`, avatar category resolution |
| stays in facade | anything used by 2+ buckets internally, tiny glue, and the re-exports |

## Tasks

1. **Inventory (read-only).** Bucket all 110 functions + module-level constants; map the internal call graph (who calls whom across buckets); list every function's external callers (grep, context-read — names are overloaded per sweeping-shape-changes). Output: a table in this plan file, committed, reviewed by owner before any move. Flag any function whose bucket is ambiguous.
2. **Wave 1 — `clothingResolve.js`** (smallest, hottest: two workstreams touched it in one day). Move, facade re-export, verify, commit.
3. **Wave 2 — `sceneMetadata.js`.** Parsers are regression-sensitive: before/after stub run on ≥3 stored stories' raw outlines (scratch script, staging DB read-only) proving identical parse output (deep-equal). Commit.
4. **Wave 3 — `promptBuilders.js`** (largest). Before/after prompt-render comparison on ≥3 stored stories (same technique the beat-fed-review validation used): built prompts must be byte-identical. Commit.
5. **Facade shrink + docs.** storyHelpers.js is now re-exports + residue (target: <500 lines). Update CLAUDE.md key-files table + decisions.md entry (facade rationale, importer-migration policy: opportunistic, never bulk). Commit.

## Verification per wave (all of)
- `node --check` on every touched file.
- Stub-execute at least one moved function per bucket with real fixture data (smoke-testing-before-push).
- `node scripts/admin/check-settled.js` green.
- `git diff --color-moved=zebra` eyeballed: moves only.
- After all waves: one cheap validation story (rung 3, 4-page smoke — owner approval for the paid run) and compare its `story_metrics` row against the pre-split baseline — the stats framework is the regression detector: same scores/counters/churn ⇒ split changed nothing.

## Out of scope (future phase docs, do not do now)
- `server.js` job-pipeline extraction (phase 2 — own plan, higher risk: boot order, completion hooks).
- `images.js` continuation (stays opportunistic per existing pattern).
- Migrating the 42 importers to direct requires.
- Any behavior change whatsoever.

## Task 1 — Completed inventory (2026-08-09)

All 110 top-level functions + 22 module-level constants, bucketed. Cross-bucket edges are
**real code references** (comment/string mentions stripped — the naive grep graph had ~12
comment-only false edges, e.g. `buildSceneExpansionPrompt -> getCharacterPhotoDetails`).

**Bucketing decisions beyond the plan's representatives** (flagged, none stopped the waves):
- `resolveCharacterReqs` / `buildClothingDescription` named in the plan table do NOT live in
  storyHelpers.js (they are in `clothingCategories.js` / `entityConsistency.js`) — the
  clothingResolve bucket is the clothing/avatar helpers actually present here.
- `getCharacterPhotoDetails` + `getCharacterPhotos` + `prefetchAvatarBytesForCharacters` +
  `applyReferenceMode` + private `getImagesModule` cache → **clothingResolve** (avatar/photo
  category resolution; only real internal deps are formatClothingObject + getImagesModule,
  both in-bucket).
- Review/beats parsers (`parseRefinedText`, `parseBeats`, `parseClothingReview`) stay with
  their prompt builders in **promptBuilders** (tightly coupled to those prompt formats),
  not sceneMetadata.
- Prompt-support config/data (teaching guides, historical locations/objects, ART_STYLES,
  LANGUAGE_LEVELS, age-category cluster, character-description builders) → **promptBuilders**;
  their only internal consumers are prompt builders, and this is what gets the facade <500.
- Facade keeps: `getLandmarkPhotosForPage/Scene` (async photo IO used by images.js),
  `calculateStoryPageCount`, `getHeadBodyRatio`, the require block, and the re-export block.

Legend: **Internal refs** = real references to other storyHelpers top-level names;
**Cross-bucket** = subset landing in a different bucket (needs top-level acyclic import or
lazy require); **External** = files under server/scripts/tests matching the name (names are
overloaded — treat as candidates, facade re-export covers all of them regardless).

| Name | Kind | Lines (pre-split) | Bucket | Exported | Internal refs | Cross-bucket | External refs |
|---|---|---|---|---|---|---|---|
| `imagesModule` | const | 21–21 | clothingResolve | no | — | — | — |
| `getImagesModule` | function | 22–44 | clothingResolve | no | imagesModule | — | — |
| `wrapUserInput` | function | 45–56 | promptBuilders | yes | — | — | 1 files: code-review-fixes.test.ts |
| `getPhysicalFromChar` | function | 57–65 | promptBuilders | no | — | — | — |
| `formatClothingObject` | function | 66–95 | clothingResolve | no | — | — | — |
| `stripAgeWords` | function | 96–138 | promptBuilders | yes | — | — | — |
| `getAgeMarkers` | function | 139–193 | promptBuilders | no | — | — | — |
| `getGenderTerm` | function | 194–234 | promptBuilders | no | — | — | — |
| `buildHairDescription` | function | 235–339 | promptBuilders | yes | — | — | 8 files: characterPhysical.js, entityConsistency.js, sceneValidator.js, styledAvatars.js, visualBible.js, … |
| `extractJsonFromText` | function | 340–453 | sceneMetadata | yes | — | — | 10 files: replay-consolidator.js, coverTitlePaint.js, entityConsistency.js, feedbackConsolidator.js, imageInpainting.js, … |
| `sanitizeInteractions` | function | 454–504 | sceneMetadata | no | — | — | — |
| `parseProseMetadataFormat` | function | 505–548 | sceneMetadata | yes | extractJsonFromText | — | 1 files: images.js |
| `POSITION_ABBREVIATIONS` | const | 549–566 | sceneMetadata | yes | — | — | — |
| `expandPositionAbbreviations` | function | 567–600 | sceneMetadata | yes | POSITION_ABBREVIATIONS | — | 1 files: sceneValidator.js |
| `stripEntityIds` | function | 601–630 | sceneMetadata | yes | — | — | 1 files: sceneValidator.js |
| `formatHoldingForPrompt` | function | 631–645 | sceneMetadata | no | stripEntityIds | — | — |
| `buildTextFromJson` | function | 646–722 | sceneMetadata | no | expandPositionAbbreviations, stripEntityIds, formatHoldingForPrompt | — | — |
| `stripSceneMetadata` | function | 723–819 | sceneMetadata | yes | extractJsonFromText, parseProseMetadataFormat, stripEntityIds, buildTextFromJson | — | 2 files: images.js, regeneration.js |
| `parseCharacterDescriptions` | function | 820–945 | sceneMetadata | yes | — | — | 1 files: images.js |
| `buildCharacterDescriptionsForBbox` | function | 946–1017 | promptBuilders | yes | buildCharacterPhysicalDescription, buildGroundingPrompt | — | 5 files: som-elim-test.js, test-gdino-production-path.js, validate-gdino-figures.js, images.js, regeneration.js |
| `enforceSpreadTextPosition` | function | 1018–1055 | sceneMetadata | yes | — | — | 3 files: pdf.js, sharing.js, stories.js |
| `mirrorLeftRight` | function | 1056–1113 | sceneMetadata | yes | — | — | — |
| `buildTextZoneInstruction` | function | 1114–1154 | promptBuilders | yes | — | — | 2 files: images.js, testlab.js |
| `buildEraGuard` | function | 1155–1180 | promptBuilders | yes | — | — | 2 files: images.js, testlab.js |
| `buildLandmarkFidelityBlock` | function | 1181–1228 | promptBuilders | yes | — | — | 3 files: coverIterate.js, images.js, testlab.js |
| `applyReferenceMode` | function | 1229–1299 | clothingResolve | yes | — | — | 2 files: images.js, regeneration.js |
| `extractSceneMetadata` | function | 1300–1666 | sceneMetadata | yes | extractJsonFromText, sanitizeInteractions, parseProseMetadataFormat | — | 14 files: beatsPipeline.js, coverIterate.js, entityConsistency.js, faceRepair.js, feedbackConsolidator.js, … |
| `getAgeCategory` | function | 1667–1689 | promptBuilders | yes | — | — | 1 files: avatars.js |
| `getAgeCategoryLabel` | function | 1690–1711 | promptBuilders | yes | — | — | — |
| `AGE_CATEGORY_ORDER` | const | 1712–1733 | promptBuilders | yes | — | — | — |
| `getAgeCategoryIndex` | function | 1734–1757 | promptBuilders | yes | AGE_CATEGORY_ORDER | — | — |
| `clampApparentAge` | function | 1758–1805 | promptBuilders | yes | getAgeCategory, AGE_CATEGORY_ORDER, getAgeCategoryIndex | — | 1 files: avatars.js |
| `parseTeachingGuideFile` | function | 1806–1849 | promptBuilders | no | — | — | — |
| `PROMPTS_DIR` | const | 1850–1850 | promptBuilders | no | — | — | 1 files: check-prompt-genericity.js |
| `EDUCATIONAL_GUIDES` | const | 1851–1851 | promptBuilders | no | parseTeachingGuideFile, PROMPTS_DIR | — | — |
| `LIFE_CHALLENGE_GUIDES` | const | 1852–1852 | promptBuilders | no | parseTeachingGuideFile, PROMPTS_DIR | — | — |
| `ADVENTURE_GUIDES` | const | 1853–1853 | promptBuilders | no | parseTeachingGuideFile, PROMPTS_DIR | — | — |
| `HISTORICAL_GUIDES` | const | 1854–1854 | promptBuilders | no | parseTeachingGuideFile, PROMPTS_DIR | — | — |
| `SWISS_SAGEN_GUIDES` | const | 1855–1862 | promptBuilders | no | parseTeachingGuideFile, PROMPTS_DIR | — | — |
| `getTeachingGuide` | function | 1863–1883 | promptBuilders | yes | EDUCATIONAL_GUIDES, LIFE_CHALLENGE_GUIDES, ADVENTURE_GUIDES, HISTORICAL_GUIDES, SWISS_SAGEN_GUIDES | — | 1 files: storyIdeas.js |
| `HISTORICAL_LOCATIONS_FILE` | const | 1884–1884 | promptBuilders | no | — | — | — |
| `historicalLocationsCache` | const | 1885–1891 | promptBuilders | no | — | — | — |
| `preloadHistoricalLocations` | function | 1892–1958 | promptBuilders | yes | historicalLocationsCache | — | — |
| `loadHistoricalLocationsDatabank` | function | 1959–1989 | promptBuilders | no | HISTORICAL_LOCATIONS_FILE, historicalLocationsCache | — | — |
| `getHistoricalLocations` | function | 1990–2056 | promptBuilders | yes | loadHistoricalLocationsDatabank, locationNameToDbKey | — | 1 files: visualBible.js |
| `locationNameToDbKey` | function | 2057–2076 | promptBuilders | no | — | — | 1 files: visualBible.js |
| `historicalObjectsCache` | const | 2077–2078 | promptBuilders | no | — | — | — |
| `preloadHistoricalObjects` | function | 2079–2119 | promptBuilders | yes | historicalObjectsCache | — | — |
| `getHistoricalObjects` | function | 2120–2143 | promptBuilders | yes | historicalObjectsCache | — | — |
| `getAdventureGuide` | function | 2144–2155 | promptBuilders | yes | ADVENTURE_GUIDES | — | 1 files: storyIdeas.js |
| `getSceneComplexityGuide` | function | 2156–2190 | promptBuilders | yes | — | — | 1 files: storyIdeas.js |
| `ART_STYLES` | const | 2191–2224 | promptBuilders | yes | — | — | 7 files: testlab-run.js, character2x4Sheet.js, coverTitlePaint.js, faceRepair.js, testlab.js, … |
| `WORLD_ART_STYLES` | const | 2225–2237 | promptBuilders | yes | — | — | — |
| `buildStyleWardrobeBlock` | function | 2238–2255 | promptBuilders | yes | WORLD_ART_STYLES | — | — |
| `resolveArtStyle` | function | 2256–2275 | promptBuilders | yes | ART_STYLES | — | 8 files: character2x4Sheet.js, coverComposite.js, coverIterate.js, images.js, styleConsistency.js, … |
| `resolveArtStyleForEmptyScene` | function | 2276–2315 | promptBuilders | yes | resolveArtStyle | — | 3 files: coverIterate.js, images.js, testlab.js |
| `resolveArtStyleForSheet` | function | 2316–2355 | promptBuilders | yes | resolveArtStyle | — | 1 files: character2x4Sheet.js |
| `LANGUAGE_LEVELS` | const | 2356–2386 | promptBuilders | yes | — | — | — |
| `getReadingLevel` | function | 2387–2396 | promptBuilders | yes | LANGUAGE_LEVELS | — | — |
| `getTokensPerPage` | function | 2397–2415 | promptBuilders | yes | LANGUAGE_LEVELS | — | — |
| `calculateStoryPageCount` | function | 2416–2435 | facade | yes | — | — | — |
| `getCharactersInScene` | function | 2436–2528 | sceneMetadata | yes | extractSceneMetadata | — | 4 files: entityConsistency.js, images.js, styledAvatars.js, regeneration.js |
| `getCharacterPhotos` | function | 2529–2594 | clothingResolve | yes | — | — | — |
| `parseClothingCategory` | function | 2595–2676 | clothingResolve | yes | extractSceneMetadata | extractSceneMetadata | 5 files: test-models.js, coverIterate.js, images.js, styledAvatars.js, regeneration.js |
| `parseCharacterClothing` | function | 2677–2707 | clothingResolve | yes | extractSceneMetadata | extractSceneMetadata | 2 files: repairPipeline.js, styledAvatars.js |
| `parseSceneHintMetadata` | function | 2708–2794 | sceneMetadata | yes | — | — | — |
| `prefetchAvatarBytesForCharacters` | function | 2795–2805 | clothingResolve | yes | — | — | — |
| `getCharacterPhotoDetails` | function | 2806–3159 | clothingResolve | yes | getImagesModule, formatClothingObject | — | 4 files: coverIterate.js, images.js, styledAvatars.js, regeneration.js |
| `NONE_WORDS` | const | 3160–3160 | promptBuilders | no | — | — | — |
| `isNone` | const | 3161–3172 | promptBuilders | no | NONE_WORDS | — | — |
| `extractCharacterVisualProfile` | function | 3173–3225 | promptBuilders | yes | getPhysicalFromChar, getAgeMarkers, getGenderTerm, buildHairDescription, getAgeCategory | — | 1 files: coverIterate.js |
| `buildLabeledPhysicalParts` | function | 3226–3296 | promptBuilders | no | stripAgeWords, isNone | — | — |
| `buildSceneClothingRequirements` | function | 3297–3344 | clothingResolve | yes | — | — | 2 files: images.js, sceneValidator.js |
| `resolveClothingForPage` | function | 3345–3377 | clothingResolve | yes | formatClothingObject | — | 1 files: regeneration.js |
| `buildCharacterPhysicalDescription` | function | 3378–3420 | promptBuilders | yes | stripAgeWords, isNone, extractCharacterVisualProfile | — | 7 files: replay-consolidator.js, validate-gdino-figures.js, entityConsistency.js, feedbackConsolidator.js, images.js, … |
| `buildGroundingPrompt` | function | 3421–3445 | promptBuilders | yes | isNone, extractCharacterVisualProfile | — | 2 files: models.js, images.js |
| `estimateHeightFromAgeGender` | function | 3446–3525 | promptBuilders | no | getPhysicalFromChar | — | — |
| `buildCharacterDescriptionForExpansion` | function | 3526–3552 | promptBuilders | no | buildCharacterPromptBlock | — | — |
| `buildCharacterPromptBlock` | function | 3553–3591 | promptBuilders | yes | extractCharacterVisualProfile, buildLabeledPhysicalParts, buildCharacterPhysicalDescription | — | — |
| `buildRelativeHeightDescription` | function | 3592–3662 | promptBuilders | yes | estimateHeightFromAgeGender | — | — |
| `buildCharacterRestriction` | function | 3663–3667 | promptBuilders | yes | — | — | 2 files: coverIterate.js, regeneration.js |
| `buildCharacterReferenceList` | function | 3668–3710 | promptBuilders | yes | buildRelativeHeightDescription | — | 3 files: coverIterate.js, regeneration.js, test-char-builders-snapshot.js |
| `parseStoryPages` | function | 3711–3746 | sceneMetadata | yes | — | — | 5 files: gelato.js, pdf.js, print.js, sharing.js, stories.js |
| `parseSceneDescriptions` | function | 3747–3785 | sceneMetadata | yes | — | — | — |
| `extractShortSceneDescriptions` | function | 3786–3795 | sceneMetadata | yes | — | — | — |
| `extractCoverScenes` | function | 3796–3807 | sceneMetadata | yes | — | — | 2 files: legacy.js, regeneration.js |
| `extractPageClothing` | function | 3808–3819 | sceneMetadata | yes | — | — | 1 files: legacy.js |
| `buildBasePrompt` | function | 3820–3886 | promptBuilders | yes | getReadingLevel | — | — |
| `buildAvailableAvatarsForPrompt` | function | 3887–3955 | clothingResolve | yes | — | — | 5 files: test-models.js, beatsPipeline.js, images.js, testlab.js, regeneration.js |
| `buildRecurringElementsText` | function | 3956–4042 | promptBuilders | no | — | — | — |
| `buildSceneExpansionAllPrompt` | function | 4043–4098 | promptBuilders | yes | resolveClothingForPage, buildCharacterDescriptionForExpansion, buildRelativeHeightDescription, buildAvailableAvatarsForPrompt, buildRecurringElementsText | resolveClothingForPage, buildAvailableAvatarsForPrompt | 2 files: beatsPipeline.js, testlab.js |
| `buildSceneExpansionPrompt` | function | 4099–4310 | promptBuilders | yes | buildCharacterDescriptionForExpansion, buildRelativeHeightDescription, buildRecurringElementsText, buildSceneDescriptionPrompt | — | 5 files: test-models.js, test-scene-expansion.js, beatsPipeline.js, testlab.js, test-char-builders-snapshot.js |
| `buildSceneDescriptionPrompt` | function | 4311–4718 | promptBuilders | yes | parseSceneHintMetadata, resolveClothingForPage, buildCharacterDescriptionForExpansion, buildAvailableAvatarsForPrompt | parseSceneHintMetadata, resolveClothingForPage, buildAvailableAvatarsForPrompt | 4 files: test-models.js, images.js, testlab.js, regeneration.js |
| `NON_WORN_STRONG_RE` | const | 4719–4721 | promptBuilders | no | — | — | — |
| `NON_WORN_WEAK_RE` | const | 4722–4722 | promptBuilders | no | — | — | — |
| `BODY_ANCHORED_DRAPE_RE` | const | 4723–4724 | promptBuilders | no | — | — | — |
| `textDeclaresNonWornPlacement` | function | 4725–4743 | promptBuilders | yes | NON_WORN_STRONG_RE, NON_WORN_WEAK_RE, BODY_ANCHORED_DRAPE_RE | — | 1 files: test-page-prompt-builder.js |
| `sceneDeclaresNonWornState` | function | 4744–4780 | promptBuilders | yes | textDeclaresNonWornPlacement | — | 1 files: test-page-prompt-builder.js |
| `WORN_ATTACHMENT_CLAUSE_RE` | const | 4781–4787 | promptBuilders | no | — | — | — |
| `stripWornStateFromDescription` | function | 4788–4817 | promptBuilders | yes | WORN_ATTACHMENT_CLAUSE_RE | — | 1 files: test-page-prompt-builder.js |
| `buildImagePrompt` | function | 4818–5275 | promptBuilders | yes | parseProseMetadataFormat, stripSceneMetadata, enforceSpreadTextPosition, buildTextZoneInstruction, buildEraGuard, extractSceneMetadata, resolveArtStyle, extractCharacterVisualProfile, buildRelativeHeightDescription, sceneDeclaresNonWornState, stripWornStateFromDescription, sanitizeVbIdsInPrompt, buildExactPosesBlock | parseProseMetadataFormat, stripSceneMetadata, enforceSpreadTextPosition, extractSceneMetadata | 10 files: test-scene.js, characterFrames.js, clothingCheck.js, coverIterate.js, grok.js, … |
| `sanitizeVbIdsInPrompt` | function | 5276–5354 | promptBuilders | yes | — | — | 7 files: coverComposite.js, coverIterate.js, coverKeys.js, images.js, visualBible.js, … |
| `buildExactPosesBlock` | function | 5355–5473 | promptBuilders | no | — | — | — |
| `SPLIT_REVIEW_ANALYSIS_STUB` | const | 5474–5503 | promptBuilders | no | — | — | 1 files: test-split-outline-review.js |
| `sliceAnalysisAspect` | function | 5504–5533 | promptBuilders | no | — | — | — |
| `stripReviewAspectMarkers` | function | 5534–5548 | promptBuilders | no | — | — | — |
| `buildOutlineReviewPrompt` | function | 5549–5681 | promptBuilders | yes | buildCharacterPromptBlock, sliceAnalysisAspect, stripReviewAspectMarkers | — | 2 files: testlab.js, test-split-outline-review.js |
| `buildTextRefinePrompt` | function | 5682–5797 | promptBuilders | yes | wrapUserInput, getReadingLevel, sliceAnalysisAspect, buildDoNotWriteSection | — | 1 files: textRefine.js |
| `parseRefinedText` | function | 5798–5845 | promptBuilders | yes | — | — | 5 files: beatsPipeline.js, testlab.js, textRefine.js, prompts.js, test-text-refine-parse.js |
| `buildStoryContextFields` | function | 5846–5896 | promptBuilders | no | wrapUserInput, getReadingLevel | — | — |
| `buildBeatsPrompt` | function | 5897–5906 | promptBuilders | yes | buildStoryContextFields | — | 2 files: beatsPipeline.js, testlab.js |
| `buildBeatsReviewPrompt` | function | 5907–5927 | promptBuilders | yes | buildStoryContextFields | — | 2 files: beatsPipeline.js, testlab.js |
| `buildClothingReviewPrompt` | function | 5928–5956 | promptBuilders | yes | buildStyleWardrobeBlock, buildStoryContextFields | — | 2 files: beatsPipeline.js, testlab.js |
| `parseClothingReview` | function | 5957–6001 | promptBuilders | yes | — | — | 2 files: beatsPipeline.js, testlab.js |
| `parseBeats` | function | 6002–6035 | promptBuilders | yes | — | — | 2 files: beatsPipeline.js, testlab.js |
| `buildSceneReviewPrompt` | function | 6036–6068 | promptBuilders | yes | buildStoryContextFields | — | 2 files: beatsPipeline.js, testlab.js |
| `buildDoNotWriteSection` | function | 6069–6090 | promptBuilders | yes | — | — | — |
| `buildStoryTextFromBeatsPrompt` | function | 6091–6127 | promptBuilders | yes | buildStoryContextFields, buildDoNotWriteSection | — | 1 files: beatsPipeline.js |
| `buildStoryBibleFromBeatsPrompt` | function | 6128–6162 | promptBuilders | yes | buildStyleWardrobeBlock, buildCharacterPromptBlock, buildStoryContextFields, buildAvailableLandmarksSection | — | 2 files: beatsPipeline.js, testlab.js |
| `buildUnifiedStoryPrompt` | function | 6163–6513 | promptBuilders | yes | wrapUserInput, getTeachingGuide, getHistoricalLocations, getHistoricalObjects, getReadingLevel, buildCharacterPromptBlock, SPLIT_REVIEW_ANALYSIS_STUB, buildAvailableLandmarksSection | — | 3 files: testlab.js, test-imagefirst-parser-compat.js, test-split-outline-review.js |
| `buildTrialStoryPrompt` | function | 6514–6639 | promptBuilders | yes | wrapUserInput | — | — |
| `getLandmarkPhotosForPage` | function | 6640–6667 | facade | yes | — | — | 1 files: visualBible.js |
| `getLandmarkPhotosForScene` | function | 6668–6786 | facade | yes | — | — | 4 files: coverIterate.js, images.js, visualBible.js, regeneration.js |
| `buildAvailableLandmarksSection` | function | 6787–6846 | promptBuilders | yes | — | — | — |
| `getPrimaryVantageForPage` | function | 6847–6919 | sceneMetadata | yes | — | — | — |
| `groupPagesByVantage` | function | 6920–6945 | sceneMetadata | yes | getPrimaryVantageForPage | — | — |
| `normalizePositionToLCR` | function | 6946–6966 | sceneMetadata | yes | — | — | 2 files: figureDetection.js, images.js |
| `buildPreviousScenesContext` | function | 6967–6990 | promptBuilders | yes | — | — | 1 files: regeneration.js |
| `convertClothingToCurrentFormat` | function | 6991–7034 | clothingResolve | yes | — | — | 3 files: coverIterate.js, images.js, regeneration.js |
| `getPageText` | function | 7035–7073 | sceneMetadata | yes | — | — | 6 files: test-models.js, images.js, testlab.js, regeneration.js, sharing.js, … |
| `updatePageText` | function | 7074–7102 | sceneMetadata | yes | — | — | 1 files: stories.js |
| `getHeadBodyRatio` | function | 7103–7113 | facade | yes | — | — | 2 files: images.js, styledAvatars.js |
