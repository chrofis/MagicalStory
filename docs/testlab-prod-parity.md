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
- `tests/unit/lab-prod-call-parity.test.ts`: image, char_repair, the edit_image plate derive
  and (batch 2) empty_scene, quality_eval, semantic_eval, consolidate and inpaint, built from
  the same stored fixture, compared with production's builders, and a source scan that the run
  still calls them.
- `tests/unit/testlab-prod-prompt-parity.test.ts`: the prompt inputs.
- `tests/unit/lab-plate-qc-always.test.ts`: plate QC.
- Sibling sets `lab-vs-prod-page-render`, `lab-vs-prod-char-fix`, `lab-vs-prod-plate`,
  `lab-vs-prod-page-eval` and `lab-vs-prod-eval` in `scripts/admin/sibling-registry.json` block a
  push that moves one side only.

Audit date: 2026-09-27 (staging `c76dac6fc`). Every B/C divergence still open has a line in
`tasks/BACKLOG.md` under "Test Lab ↔ production parity (2026-09-27)".

## Page stages

| stage | production function(s) | class | open divergences (no params) |
|---|---|---|---|
| image | Phase 5a page render (`storyJobPipeline.js`) via `pageRenderCall.js`: `selectPageElementRefs`, `keepPageGridElements`, `pageRenderModel`, `makePageImagePrompt`, `pageTextAreaMask`, `pageRenderOptions`, plus `decidePageRoute` and `applyReferenceMode` | **A** (2026-09-27) | Reconstructed from stored data: the plate is the stored `empty_scene` row, the references are the stored `referencePhotos`, and the route overrides (`inputData.composite`) are not stored. The run's trial path and the page-retry path (`storyJobPipeline.js` "retrying once") build their own calls. |
| empty_scene | the run's plates, moved verbatim into `server/lib/platePipeline.js`: `renderVantagePlates` (Phase 5a-pre-vantage: canvas from the representative page, QC + one fed-back retry, the derive for an angled / re-lit page) and `renderPagePlate` (Phase 5a-pre: the page's own plate with the `pageTextAreaMask` mask, QC + retry) | **A** (2026-09-27) | `pageDataArray` is rebuilt from the stored pages with the run's builders, and which plate a page gets is decided by the run's rules (vantage group, route cast=0 skip). Only the target page's derive is made. Not stored, so defaults stand in: `modelOverrides` and the route overrides. A page whose brief was rewritten after its plate was rendered (a repair re-brief) replays against the rewritten brief: the stored `sceneMetadata` is the final one (staging `job_1790446348343_z3fw660ie` p7). |
| edit_image | plate derive (`storyJobPipeline.js` Phase 5a-pre-vantage) via `editImageWithPrompt(…, emptyScenePlateModel, [], artStyle, layoutAspect, {plateDerive})`; page edit via `editImageWithPrompt` | **A** for the derive call (aspect fixed 2026-09-27) | The instruction is the Lab's (`params.instruction`), not `buildPlateDeriveInstruction`. The QC option set is the fixture page's, not the representative page's (see judge_fixture). |
| char_repair | repair round `executeCharFixAction` (`repairPipeline.js`) via `charFixCall.buildCharFixCall` → `images.repairCharacterMismatch` → face-integrity gate; cover restamp `coverEvalLayer.restampRepairedCover` | **A** (2026-09-27) | The decision comes from the stored entity report (`charFixEntityFindings`), and `bestEval` from the stored detection, with a fresh detection (`detectPageForRepair`) when that detection does not locate the character. The result is saved as a Lab version (the one intended difference). The manual route (`regeneration.js` character-repair) still builds its own inputs. |
| inpaint | the repair round's `executeInpaintAction`: `repairPipeline.buildInpaintCall` (extracted) → `images.inpaintPage`, then the cover restamp | **A** (2026-09-27) | The served version's stored evaluation and the plan it was scored with (`consolidatedPlan` on the version record); a supplied `params.evaluation` without a plan is consolidated first, as the run consolidates every evaluation when it lands. `judgedPrompt` / `requiredTexts` are not stored on a version and are rebuilt by the eval's own builders (`testlab.labStoredPageEval`). The page's detection is its first (v0) one, as in the run. |
| iterate | `images.iteratePage` / `iterateFullStoryCover` | B | Not re-audited in this pass. |
| quality_eval / semantic_eval / eval_variance | the repair round's `evaluateImageBatch` on `repairPipeline.buildEvalInput` (exported), the batch's per-page call `images.batchEvalQualityCall` (extracted), and inside `evaluateImageQuality` the judges' inputs `evalPipeline.prepareEvalJudgeInputs` + `semanticFidelityOptions` (extracted) | **A** (2026-09-27) | Reconstructed from stored data (`testlab.labEvalCall`): the run's `rawImages` record of the page, and the judged version's own stored record (description, prompt, cast, metadata, detection) as a repair round's entry. quality_eval runs the whole batch (empty-inventory cap, detection enrichment, identity reconcile). eval_variance repeats the batch's evaluateImageQuality call and scores the findings itself, so the batch's post-eval steps are not repeated. semantic_eval runs the semantic judge alone on the inputs `evaluateImageQuality` gives it. `recordStats: false` keeps Lab evals out of `eval_finding_stats`. Not stored: `modelOverrides` (`coverTitleMode`). |
| entity | `runEntityConsistencyChecks` | B | Not re-audited in this pass. |
| bbox | `detectAllBoundingBoxes` (`storyJobPipeline.js` / `repairPipeline.js`) | B+C | The Lab builds its own cast (`buildExpectedCharacters`), not the identity cast / `buildPageCast`. No `expectedObjects`, context capped at 2000 characters, own retry loop. |
| identity_second_opinion | `reconcileIdentityWithSecondWitness` in `evaluateImageBatch` | B | No arbiter and no `alsoRename`; the evaluator side is rebuilt from stored matches. |
| garment_colour_fix | `runGarmentRecolour` → `fixFigureGarmentColour` | B+C | Loops over every figure instead of the entity mismatches. Own category source, no identity cross-check. |
| text_zone | `textSpaceRepair.ensureCalmZone` (initial render and post-repair) | B | No `visualBible`, no `visualBibleGrid`, the mask is recomputed, the plate is the v0 row, and the P1/P2 gates are not applied (details in the audit notes). |
| consolidate | `consolidateEvaluation` with `repairPipeline.consolidationInputs` (extracted from `consolidatePageEval`) | **A** (2026-09-27) | The served version's evaluation, the page's entity issues from the stored final entity report (the run consolidates with the round's report), the version's stored reader findings and brief. `round` is 0. |
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
| beats_replan | Step 2 of `generateStoryViaBeats`, moved verbatim into `beatsPipeline.makePlanReader`, `planCheckInputs`, `createPlanCheckRunner`, `recheckRecord` and `runReplanRounds` | **A** (2026-09-27) | Rebuilt from stored data: the first division is the run's stored `plannerReply` read by the run's reader, its CAST table parsed by the run's parser, and the arc's invented / commissioned figures read off the stored STORY LOGIC (`arcReviewReport.logic`). Not stored, so defaults stand in: `modelOverrides` (the plan and check models). A story stored before `plannerReply` (2026-09-23) replays its `briefsIn` with no CAST table. The Lab adds its compliance reading of round 1 (research). |
| arc_panel_replay | arc panel + re-tell | B | No `availableLandmarks`. The re-tell draws fresh challenges. Page count and `creatorCall` retry differ. |
| scene_review_replay | Step 4 of `generateStoryViaBeats`, moved verbatim into `beatsPipeline.runSceneReview` (clothing and brief checks, the review, the worn-state round, `keepDeclaredLight` / worn-row carry-forward, the truncation guard, the cast-removal restore, bible corrections, the post-review re-checks) | **A** (2026-09-27) | Rebuilt from stored data: the briefs as sent (`sceneReviewReport.briefsIn`, covers included), the shipped division (`beatsReviewReport.pagePlan`) plus the cover beats, and the bible the reviewer was handed — persisted as `sceneReviewReport.visualBibleIn` since 2026-09-27 when the review corrected it. Approximate for OLD stories: a story whose review corrected the bible before that date replays against the corrected bible; a story without `briefsIn` replays its final briefs; `bibleSections` (the transcript) is not replayed. Not stored: `modelOverrides.sceneReviewModel`. |
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
