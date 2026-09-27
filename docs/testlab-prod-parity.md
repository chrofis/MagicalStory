# Test Lab ↔ production: which production code each stage runs

Owner directive, 2026-09-27: **"The Lab must use 100% identical code to production."**
With no `params`, a stage must make the call production makes for the same stored page.
`params.*` knobs are explicit A/B overrides on top of that and nothing else (deliberate
knobs that change behaviour are indexed in `docs/lab-divergences.md`).

Classes:
- **A**: calls the production function with production-built inputs.
- **B**: calls the production function, but builds some inputs differently.
- **C**: re-implements production logic in its own code.
- **R**: research-only (no production counterpart).

Parity tests:
- `tests/unit/lab-prod-call-parity.test.ts`: image, char_repair and the edit_image plate derive,
  built from the same stored fixture, compared with production's builders, and a source scan
  that the run still calls them.
- `tests/unit/testlab-prod-prompt-parity.test.ts`: the prompt inputs.
- `tests/unit/lab-plate-qc-always.test.ts`: plate QC.
- Sibling sets `lab-vs-prod-page-render` and `lab-vs-prod-char-fix` in
  `scripts/admin/sibling-registry.json` block a push that moves one side only.

Audit date: 2026-09-27 (staging `c76dac6fc`). Every B/C divergence still open has a line in
`tasks/BACKLOG.md` under "Test Lab ↔ production parity (2026-09-27)".

## Page stages

| stage | production function(s) | class | open divergences (no params) |
|---|---|---|---|
| image | Phase 5a page render (`storyJobPipeline.js`) via `pageRenderCall.js`: `selectPageElementRefs`, `keepPageGridElements`, `pageRenderModel`, `makePageImagePrompt`, `pageTextAreaMask`, `pageRenderOptions`, plus `decidePageRoute` and `applyReferenceMode` | **A** (2026-09-27) | Reconstructed from stored data: the plate is the stored `empty_scene` row, the references are the stored `referencePhotos`, and the route overrides (`inputData.composite`) are not stored. The run's trial path and the page-retry path (`storyJobPipeline.js` "retrying once") build their own calls. |
| empty_scene | per-page plate (`storyJobPipeline.js` Phase 5a-pre): `buildEmptyScenePrompt`, `emptyScenePlateRouting`, `buildEmptySceneVbGrid`, `validateEmptyScene` | B | The mask comes from `getTextAreaMask(ctx.textPosition)`, not from `pageTextAreaMask`. There is no QC retry loop (report-only). A vantage page's plate is rendered from its own plate text, not the representative page's. |
| edit_image | plate derive (`storyJobPipeline.js` Phase 5a-pre-vantage) via `editImageWithPrompt(…, emptyScenePlateModel, [], artStyle, layoutAspect, {plateDerive})`; page edit via `editImageWithPrompt` | **A** for the derive call (aspect fixed 2026-09-27) | The instruction is the Lab's (`params.instruction`), not `buildPlateDeriveInstruction`. The QC option set is the fixture page's, not the representative page's (see judge_fixture). |
| char_repair | repair round `executeCharFixAction` (`repairPipeline.js`) via `charFixCall.buildCharFixCall` → `images.repairCharacterMismatch` → face-integrity gate; cover restamp `coverEvalLayer.restampRepairedCover` | **A** (2026-09-27) | The decision comes from the stored entity report (`charFixEntityFindings`), and `bestEval` from the stored detection, with a fresh detection (`detectPageForRepair`) when that detection does not locate the character. The result is saved as a Lab version (the one intended difference). The manual route (`regeneration.js` character-repair) still builds its own inputs. |
| inpaint | `images.inpaintPage` with the consolidated plan | B | The consolidator is given `entityIssues: []`, no `sceneClothing` and no `readerFindings`. The eval is `storedEvalFromScene` (no `requiredTexts`). |
| iterate | `images.iteratePage` / `iterateFullStoryCover` | B | Not re-audited in this pass. |
| quality_eval / semantic_eval / eval_variance | `evaluateImageQuality` via `evaluateImageBatch` (`buildEvalInputs`) | B | `pagePrompt` is missing, so the REQUIRED OBJECTS list falls back to `objects[]`. The whole-cast reference photos (`composeEvalReferencePhotos`) are not merged. `storyData` is `{characters}` only. The scene hint does not come from `resolveEvalSceneHint`. The post-eval batch steps (the 40 cap on an empty inventory, identity reconcile) are not run. |
| entity | `runEntityConsistencyChecks` | B | Not re-audited in this pass. |
| bbox | `detectAllBoundingBoxes` (`storyJobPipeline.js` / `repairPipeline.js`) | B+C | The Lab builds its own cast (`buildExpectedCharacters`), not the identity cast / `buildPageCast`. No `expectedObjects`, context capped at 2000 characters, own retry loop. |
| identity_second_opinion | `reconcileIdentityWithSecondWitness` in `evaluateImageBatch` | B | No arbiter and no `alsoRename`; the evaluator side is rebuilt from stored matches. |
| garment_colour_fix | `runGarmentRecolour` → `fixFigureGarmentColour` | B+C | Loops over every figure instead of the entity mismatches. Own category source, no identity cross-check. |
| text_zone | `textSpaceRepair.ensureCalmZone` (initial render and post-repair) | B | No `visualBible`, no `visualBibleGrid`, the mask is recomputed, the plate is the v0 row, and the P1/P2 gates are not applied (details in the audit notes). |
| consolidate | `consolidateEvaluation` via `consolidatePageEval` | B | Same inputs as inpaint above; `round: 0`. |
| scene_composite | `generateSceneComposite` (dormant in production) | B | `figureMethod` paste vs inPlace, `phantomPoseRender` false vs true, sends a `pagePrompt`, text caps. |
| repair_round | `decideRepairMethod` + round dispatch | B+C | No `characters` / `failedMethods`; dispatches to the Lab stages. |
| artifact_repair / repair_verify | `gridBasedRepair` / `verifyRepairWithGemini` | no live production path | The production route `POST artifact-repair` throws "outputDir is required" (reported, not fixed). |
| scale_repair / style_transfer | admin routes only | B | Missing plate, background descriptions and style / `targetModel` options. |
| pick_best | `pickBestVersionIndex` | B | Tie-break is `'latest'`; the pipeline uses `'earliest'`. |
| scene_expansion / _ab / scene_variant | beats all-pages Art Director (`buildSceneExpansionAllPrompt`); per-page only as fallback | B | Per-page builder, wrong model (global `TEXT_MODEL`), no plan line, no `story` / `clothingRequirements` / `maxCharactersPerScene`. |
| scene_description | `/regenerate/scene-description` | B | No `previousScenes`; clothing hard-coded to 'standard'; model fallback. |
| rewrite_blocked | `rewriteBlockedScene` | C | Rebuilds the template itself and uses the wrong model. |
| qwen_insert / empty_scene_adherence / inventory_ab | none | R | |

## Story-level stages

| stage | production function(s) | class | open divergences |
|---|---|---|---|
| beats_scenes | `generateStoryViaBeats` (planner, all-pages Art Director, review) | B+C | Scene-review model is `outlineReviewModel`, not `sceneReviewModel`. No clothing findings. `checkBriefs` runs without `planLine` / `textZoneRules`. No `availableLandmarks` for the planner. The bible is the raw parse (no label round, age clamp or wardrobe corrections). The recovery loop and merge are re-implemented. |
| beats_replan | Step-2 plan check + re-plan rounds | B+C | `castTable` is dropped. The page plan is rebuilt instead of taken from the parsed `plannerReply`. No invented / commissioned figures, no `peoplelessPick`, no `availableLandmarks`. One round only. |
| arc_panel_replay | arc panel + re-tell | B | No `availableLandmarks`. The re-tell draws fresh challenges. Page count and `creatorCall` retry differ. |
| scene_review_replay | scene review (`beatsPipeline.js` ~2949) | B | Reviews the FINAL briefs, not `sceneReviewReport.briefsIn`. No covers. Clothing-check inputs come from the stored record. No truncation guard. No `keepDeclaredLight`. |
| judge_fixture (plate_qc) | `validateEmptyScene` with `pageQcOpts` / `derivedQcOpts` | C | The derived-plate option set uses the fixture page's structures, era, light and shot; production uses the base plate's and the representative page's. `outlinePlate` is `''`. |
| cover | `iterateFullStoryCover` (page path) / `iterateCover` (trial) | A / B | Trial path: `forceRestampWhenUnbaked` is not passed; `compositeCovers` defaults to off. |
| style_check | `checkStoryStyleConsistency` | A (admin route) | Pipeline input is `buildStyleAuditInput`. |
| book_audit | `auditStoryBook` | B | Page-level fields instead of the picked version's; no covers. |
| text_refine / audit_replay | `refineStoryText` | B | Refines the shipped text, not the writer draft, unless `fromWriterText` is set. `audit_replay`'s `promptOverride` has no effect. |
| story_bible_replay / story_text_replay / clothing_review | `beatsPipeline.js` bible / text / clothing-review calls | B(+C) | Pre-replan beats. Stored `modelOverrides` are ignored. clothing_review reviews the post-review contract and has its own apply loop. |
| writer_compare | the beats builders | B+C | The text arm always throws (`parseRefinedText` is given a number). |
| arc_effort | arc create / panel / re-tell | B+C | Effort defaults, no retry, one round. |
| trial_idea_variety / trial_challenge_draw | trial idea route / trial writer | B+C | Character and location inputs are reconstructed. |
| vb_element_cell | `generateReferenceSheet` | C | One element alone, not batched. |
| cover_title_paintin | `paintCoverTitle` (only in `mode:'plate'`) | C by default | |
| avatar_realistic / avatar_style / avatar_eval | `generateCharacter2x4Sheet` passes | B | Uses the user's current character record, a derived outfit, and no `costumeName`. |
| arc_rounds, arc_amend, scene_hazard_count, story_scorecard, score_rejudge | none | R | |

## Cross-cutting gaps that a fix needs stored data for

- **`availableLandmarks` is not persisted** (`storyJobPipeline.js` resolves it at job start with
  `shuffle: true`), so every writer-prompt replay drops the landmark section. Persisting it on
  `stories.data` is a schema-shaped change and is listed in the backlog.
- **`modelOverrides` are not persisted**, so a replay always resolves the default models.
- **The pre-review visual bible is not persisted**, so `scene_review_replay` can only review
  against the final bible.
