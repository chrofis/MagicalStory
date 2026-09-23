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
   (bbox-refine-overlay, iterative-placement-pass1/2, inpaint-grok-regions,
   style-transfer).
3. **Direct reads in feature modules** — the `*-guides.txt`, `art-styles.txt`,
   `generate-story-idea*`, `story-idea-requirements-*`, `grid-repair.txt`.

**Maintainer notes are a `#!` block (2026-09-21).** A template may open with notes for whoever
edits it — which pipeline sends it, what parses its output. Write them as consecutive lines
starting with `#!` at the very top of the file, ended by a blank line: `loadPromptTemplates()`
strips that block so it never reaches the model. A bare `#` heading is prompt structure and is
left alone. (`docs/decisions.md`, 2026-09-21.)


## Story text & ideas

| Template | Consumer | Stage |
|---|---|---|
| outline-analysis-imagefirst.txt | promptBuilders.js `buildOutlineReviewPrompt` | ANALYSIS instruction body for the split outline reviewer — its ONE consumer since 2026-09-21. `buildTextRefinePrompt` sliced its criteria out of it until then (A7); the refiner now carries its own, in text-refine.txt. Fed the deleted unified writers too until 2026-09-15 |
| outline-review.txt | storyHelpers.js `buildOutlineReviewPrompt`; server.js split-review seam | External outline review (split mode, default ON): Opus receives the writer's full output + the same analysis instructions + REVIEW HINTS (deterministic scene-consistency findings) and emits ANALYSIS + FIXES REQUIRED + STORY PAGES patches; owns all SEMANTIC scene-consistency judgment (decisions.md 2026-07-31) |
| story-beats.txt | storyHelpers.js `buildBeatsPrompt` | Beats-first pipeline step 1 (`pipelineMode: 'beats'`) + Test Lab `beats_scenes`: the PAGE PLAN, one plan line per page (no beat prose since 2026-09-02) |
| plan-check.txt | storyHelpers.js `buildPlanCheckPrompt` | Beats-first step 2: the ONE model call over a page division — emotional highlights, entrances, 3+-cast justifications. Counters (server/lib/planCounters.js) do the arithmetic |
| arc-create.txt | promptBuilders.js `buildArcCreatePrompt` | Arc machine step 1 (beats pipeline, 2026-08-30): the creator writes TWO arcs, each with a blunt numbered self-critique, and commits to one ("Stronger: Arc N") |
| arc-panel.txt | promptBuilders.js `buildArcPanelPrompt` | Arc machine step 2: each panel model (arcPanelModels) proposes EXACTLY ONE solution on the committed arc + critique; advisory, parallel. Carries `{AVAILABLE_LANDMARKS_SECTION}` since 2026-09-21 so the critic sees the list the creator got |
| arc-retell.txt | promptBuilders.js `buildArcRetellPrompt` | Arc machine step 3: the SAME creator re-tells the story whole (FINAL ARC + Challenges taken + Used + fresh CRITIQUE); the critique feeds story-beats.txt `{ARC_WEAK_POINTS}`. Carries `{AVAILABLE_LANDMARKS_SECTION}` since 2026-09-21 |
| arc-hints.txt | promptBuilders.js `buildArcHintsPrompt`; called from beatsPipeline.js (`usageLabel: 'arc_hints'`, model `MODEL_DEFAULTS.arcHintsModel` = grok-4.6) | Arc machine step 4, the GROK HINT PASS (owner 2026-09-01): ONE outside look at the approved arc, emitting `ISSUE: … → CHANGE: …` lines parsed by `parseArcHints`. Never another re-telling round — the hints travel forward into story-beats.txt and story-text-from-beats.txt as `{ARC_HINTS}`. Advisory: any failure clears the hints and the run proceeds |
| story-arc-review.txt | promptBuilders.js `buildArcReviewPrompt`; testlab.js `runArcRoundsStage` | Lab-only arc review round: the arc plus optional audit findings in, a revised arc out (`parseArcReview`). The production arc stage is the arc machine (arc-create / arc-panel / arc-retell / arc-hints) |
| challenge-catalogue.txt | read directly (`fs`) by promptBuilders.js `buildChallengeIdeasSection`, storyIdeas.js `buildIdeasPromptContext`, testlab.js | A DATA file, not an instruction template: the obstacle catalogue, sampled at random per run (~5x oversupplied, filtered by age band / peril / category cap) so the same brief rerun does not reach for the model's default obstacle. Column 5 holds the age bands |
| premise-shapes.txt | read directly (`fs`) by storyIdeas.js `loadPremiseShapes` / `pickPremiseShapes` → `{PREMISE_SHAPE}` (generate-story-idea-single.txt) and `{PREMISE_SHAPE_1}` / `{PREMISE_SHAPE_2}` (generate-story-ideas.txt) | A DATA file, not an instruction template: twelve premise shapes (`id\|name\|definition\|min age`). One shape per idea arm, picked in code — deterministic from the same seed `buildVariantInstructions` uses, never the same shape on both arms, never one above the youngest character's age, and the two-mains shape withheld from a one-main cast. Added 2026-09-21 (round 8 of the story-idea rating series) |
| pattern-seeds.txt | read directly (`fs`) by `server/lib/patternSeeds.js` `loadPatternSeeds` / `pickPatternSeeds` → `{PATTERN_SEED}` (generate-story-idea-single.txt) and `{PATTERN_SEED_1}` / `{PATTERN_SEED_2}` (generate-story-ideas.txt) | A DATA file, not an instruction template: ten pattern books for a main character aged two or under (`id\|name\|pattern\|variation\|the one that resists\|refrain`). One seed per idea arm, picked in code with the same determinism as the premise shapes, never the same seed on both arms. World-neutral: the world seed supplies the creature, this file the mechanism. Fills the SAME template slot as `{PREMISE_SHAPE}` — exactly one of the two is ever non-empty. Added 2026-09-21 (round 23) |
| do-not-write-list.txt | promptBuilders.js `buildDoNotWriteSection` → `{DO_NOT_WRITE_LIST}` | The ONE banned-category list every narrative prompt carries. Owns the list outright since 2026-09-03 — it was previously sliced back out of the unified writer template at runtime, so deleting that dead template would have stripped the list from production silently |
| story-arc-audit.txt | storyHelpers.js `buildArcAuditPrompt` | Blind arc audit: commission + arc only, exhaustive fault list for the reviewer ledger. Lab only since 2026-08-30 — the production arc stage is the arc machine |
| story-text-audit.txt | storyHelpers.js `buildTextAuditPrompt` | ARC-INFORMED text audit, first of the two parallel audits: back cover + the final ARC + the page plan + pages + DEPICTS-only picture info |
| story-text-audit-blind.txt | storyHelpers.js `buildTextAuditBlindPrompt` | BLIND text audit, second of the two parallel audits (owner 2026-09-03): the page text and nothing else, five reader-side questions (CONFUSION, CONTRADICTION, IDLE, TRANSITION, PAYOFF), same `FAULT[...]` line format so the two lists merge in code |
| story-text-proofread.txt | storyHelpers.js `buildTextProofreadPrompt` | THE LECTOR, last step of the text chain: objective language faults in the final text, emitted as `PAGE n: '<quoted>' → '<corrected>'` lines. The corrections are applied IN CODE (`applyLectorFindings` in textRefine.js) — no apply model call; a finding whose quote is not verbatim on its page is dropped, which is the hallucination guard. The separate apply pass (story-text-lector-apply.txt) was deleted 2026-09-03 |
| story-text-diff.txt | storyHelpers.js `buildTextDiffPrompt` | THE DIFF PASS, between the repair and the lector (2026-09-06): only the pages the repair rewrote, each as BEFORE and AFTER, judged solely on what the rewrite damaged. SAME output contract as the lector (`PAGE n: '<quoted>' -> '<corrected>'`), parsed and applied by the SAME code (`parseLectorFindings` / `applyLectorFindings`). Model `MODEL_DEFAULTS.textDiffModel` = gpt-5.6-luna-pro — measured 2/2 against gemini's 0/2 on this task, the reverse of the cold read; see docs/decisions.md |
| book-audit.txt | bookAudit.js `auditStoryBook` (via `PROMPT_TEMPLATES.bookAudit`) | Final-book audit — the reader's-eye pass. Runs after covers, before persist: each page's TEXT then its SHIPPED IMAGE, interleaved as vision parts in reading order, ~6 pages per Gemini flash call. Emits `FAULT[IMG]:` / `FAULT[TEXT]:` routed by which artefact would fix it. Word/picture BALANCE is never a fault |
| story-child-critic.txt | storyHelpers.js `buildChildCriticPrompt` | Child critic of the arc, in PARALLEL with story-arc-audit: role-plays the youngest main character's age, retells the arc, then emits `FAULT[CHILD]:` lines for comprehension/boredom/fear only. Lab only since 2026-08-30 — the production arc stage is the arc machine |
| scene-review.txt | storyHelpers.js `buildSceneReviewPrompt` | Beats-first step 4: ONE review over ALL scene briefs (repetition, arc, continuity) |
| scene-hazard-audit.txt | testlab.js `runSceneHazardCountStage` (via `PROMPT_TEMPLATES.sceneHazardAudit`) | Lab-only measurement for the hazard-reduction loop: counts render hazards per page across a book's briefs (or beat SCENE lines) in 12 stable classes (CROWD, MULTIACT, GAZE, CONTACT, FORCE, ELEV, UNHELD, NEG, SCALE, TEMPORAL, LOC, SHOT); emits `HAZARD[<CLASS>]: p<N>` lines + `HAZARDS: <count>`. Report-only, nothing in the pipeline consumes it |
| story-bible-from-beats.txt | promptBuilders.js `buildStoryBibleFromBeatsPrompt` | Beats-first step 3: the WARDROBE contract and nothing else. Emits `---CLOTHING REQUIREMENTS---`. The Visual Bible and the cover scene hints moved OUT to scene-expansion-all.txt on 2026-09-11 (owner); clothing stayed because the styled avatars start the moment this call returns |
| scene-expansion-all.txt | promptBuilders.js `buildSceneExpansionAllPrompt` | Beats-first step 4, ONE call over ALL pages: `---VISUAL BIBLE---` + `---COVER SCENE HINTS---` ahead of page 1, then a brief per page. One author owns what is in each picture and what each thing looks like, so no page can cite an id nobody declared. Parsed by `extractBibleSections(raw, AD_BIBLE_MARKERS)` + `parseRefinedText(raw, pages, 'SCENES')` |
| clothing-review.txt | storyHelpers.js `buildClothingReviewPrompt` | Beats-first step 3b: wardrobe review over the bible's clothing contract, BEFORE the styled-avatar kickoff. Emits `---ANALYSIS---` + `---CLOTHING---`, parsed by `parseClothingReview` |
| story-text-from-beats.txt | storyHelpers.js `buildStoryTextFromBeatsPrompt` | Beats-first step 5: page TEXT written from the FINAL ARC + the locked plan lines. Emits `---TITLE---` + `---ANALYSIS---` + `---STORY TEXT---` so `parseRefinedText` reads it |
| text-refine.txt | storyHelpers.js `buildTextRefinePrompt` | Post-image text refinement (both pipelines). Carries its OWN review criteria (sections A-E) since 2026-09-21; rewrites are scoped to the pages AUDIT FINDINGS names |
| story-trial.txt | storyHelpers.js `buildTrialStoryPrompt` | Trial story call |
| vb-label-repair.txt | (new) Visual Bible label repair | One fed-back round to fix Visual Bible label faults |
| trial-idea.txt | trial.js `POST /generate-ideas-stream` | Trial idea generation |
| — | — | **Bible `text` field, AUTHORING contract (2026-09-21):** story-trial.txt, scene-expansion-all.txt and scene-review.txt all carry `{REQUIRED_TEXT_AUTHORING}` — the ONE `REQUIRED_TEXT_AUTHORING_RULE` from `server/lib/requiredText.js` saying WHEN an element declares `text` (and when it must not). scene-expansion-all's `text` schema note now allows a run of letters or digits, story-trial's artifacts schema gained `text`, and scene-review gained check 9g `[required_text_undeclared]` with a `# VISUAL BIBLE — DECLARED TEXT` block and a `text` lane in `applyReviewBibleCorrections` |
| — | — | **`emotion` field, ONE list on both sides (2026-09-23):** the four brief-authoring templates (scene-expansion.txt, scene-expansion-all.txt, scene-iteration.txt, scene-iteration-free.txt) get `characters[].emotion` through `{EXPRESSION_FIELD}` (`EXPRESSION_FIELD_RULE`), and image-inventory-unified.txt gets `figures[].emotion` through `{EMOTION_ENUM}`, filled at template load (prompts.js). Both read `EMOTION_ENUM_PHRASE` from `server/lib/emotionVocabulary.js`; `emotionCheck.js` compares them in code. image-semantic.txt no longer judges emotion |
| — | — | **Bible `label` field (2026-09-13):** story-trial.txt and scene-expansion-all.txt both author a `label` beside each element's `id` — the one English name every prompt uses for that element |
| age-band-routine.txt | promptBuilders.js `buildAgeModeSection` → `{AGE_MODE}` in arc-create, arc-retell, story-arc-review, story-beats, story-trial, trial-idea, generate-story-idea(s) | Plot shape when the oldest MAIN character is 0–1: a day's rhythm, no plot, naming and repetition |
| age-band-quest.txt | as above (`{AGE_MODE}`) | Oldest MAIN aged 2: one tiny goal, one search place per page, a repeated phrase, cosy close |
| age-band-tries.txt | as above (`{AGE_MODE}`) | Oldest MAIN aged 3: one problem, try-fail / try-fail / try-succeed by the child's own doing |
| age-band-fear-choice.txt | as above (`{AGE_MODE}`) | Oldest MAIN aged 4: something scary faced, resolved by the hero's brave, clever or kind choice |
| age-band-journey.txt | as above (`{AGE_MODE}`) | Oldest MAIN aged 5: mini hero's journey with a required low point the hero's own idea turns |
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
| scene-expansion.txt | storyHelpers.js `buildSceneExpansionPrompt` | Art Director: outline hint → illustration brief. METADATA carries `wornItems[]` (per-page worn/off state for `wornAs` elements) |
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
| image-inventory-unified.txt | 6,644 | 81 | evalPipeline.js (unified visual inventory) | Per-figure inventory the blind compliance judge consumes; its `emotion` / `gaze` / `lettering` also feed the code checks (emotionCheck.js, gazeCheck.js, letteringCheck.js). `{EMOTION_ENUM}` filled at load |
| cover-evaluation-notes.txt | 1,353 | 17 | evalPipeline.js `evaluateImageQuality` (cover path) | Cover-only preamble: COVER_NOTE / TEXT_NOTE_APP_OVERLAY / TEXT_RULES. Extracted from JS string literals 2026-09-15 |
| empty-scene-qc.txt | 2,889 | 18 | evalPipeline.js `buildEmptySceneQcPrompt` | Plate judge: BODY / ERA_CHECK / PLACEMENTS_CHECK. Extracted from JS string literals 2026-09-15 |
| image-visual-inventory.txt | 5,377 | 138 | images.js `runVisualInventory`; regeneration.js | Visual inventory pass |
| image-inspection.txt | 2,457 | 52 | images.js `inspectImageForErrors` | Image error inspection |
| generated-image-analysis.txt | 1,106 | 39 | sceneValidator.js `analyzeGeneratedImage` | Generated-image analysis |
| feedback-consolidator.txt | 17,739 | 167 | feedbackConsolidator.js `consolidateFeedback` | Merges all four evaluators into `deduped_issues[]` — **this list is what scoring charges** |
| repair-verification.txt | 1,799 | 48 | repairVerification.js `verifyRepairWithGemini` | Verifies a repair changed the target region |
| story-text-quality-judge.txt | 2,880 | 48 | textQualityJudge.js `judgeStoryText` | Test Lab text-only harness: scores story TEXT on 5 criteria (cross-model judge) |
| story-scorecard-judge.txt | 2,398 | 50 | testlab.js `runStoryScorecardStage` / storyScorecard.js | Test Lab `story_scorecard` stage: LLM judge rates 4 final artifacts (beats/scene/text/VB) on a 4×5 rubric for model comparison |
| story-retell-judge.txt | 1,263 | 20 | storyScorecard.js evaluator `4.4` (`storyRetellJudge`) / testlab.js `scoreArtifactsWithJudge` | Evaluator 4.4 "child listener": role-plays the target-age child, retells the finished text, then scores ONE artifact (storyText) on comprehension/stake/resolution/engagement. Own rubric (RETELL_RUBRIC) — never comparable with 4.1-4.3 |
| story-scorecard-judge-v1_1.txt | 2,927 | 41 | storyScorecard.js `EVALUATORS['1.1']` (`storyScorecardJudgeV1_1`) | Scorecard evaluator generation 1.1, "legacy harsh" — RUBRIC_V1, judge model chosen per run |
| story-scorecard-judge-v1_2.txt | 3,622 | 46 | storyScorecard.js `EVALUATORS['1.2']` (`storyScorecardJudgeV1_2`) | Scorecard evaluator generation 1.2, "legacy 10-dim beats" — RUBRIC_V3 |
| story-scorecard-judge-v2.txt | 3,622 | 46 | storyScorecard.js `EVALUATORS['2.1'/'2.2'/'2.3']` (`storyScorecardJudgeV2`) | Scorecard generation 2 — one template, three judge models (sonnet / grok / gemini). Brief-BLIND, which is why 3.x exists |
| story-scorecard-judge-v3.txt | 3,932 | 48 | storyScorecard.js `EVALUATORS['3.1'/'3.2'/'3.3']` (`storyScorecardJudgeV3`) | Scorecard generation 3 = premise-aware. A new generation rather than an edit to 2.x: changing what a judge sees changes every score, so 2.x rows stay comparable among themselves |
| story-scorecard-judge-v4.txt | 5,541 | 56 | storyScorecard.js `EVALUATORS['4.x']` (`storyScorecardJudgeV4`) | Scorecard generation 4 = shape-aware. Generation 4 also carries the separate "child listener" evaluator 4.4 (story-retell-judge.txt above) |
| story-arc-judge.txt | 5,155 | 46 | testlab.js `runArcRoundsStage`; rubric `ARC_RUBRIC` in storyScorecard.js | Arc-only judge for the Lab's arc-rounds stage: scores ONE arc across 14 dimensions (shape, attempts, lost, agency, ensemble, change, blockers, grounding, fit, focus, entrances, difficulty, sense, engaging). The rubric lives in storyScorecard.js, not in the template |

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
| reference-sheet.txt | referenceSheets.js `buildReferenceSheetPrompt` | Element reference sheet generation. Cell lines open with a kind sentence (`elementKindSentence`, name + type as prose); `{TEXT_RULE}` is the blanket no-lettering line, swapped for a quoted-words-only line on a solo cell whose entry carries `text` (rendered on `MODEL_DEFAULTS.vbTextCellModel`) |
| sheet-cell-identification.txt | referenceSheets.js `identifySheetCells` | Maps labelled sheet cells to requested elements when the model's drawn grid does not match the requested cell count |

## Repair (image)

| Template | Consumer | Stage |
|---|---|---|
| character-repair-cutout.txt | images.js `repairCharacterMismatchWithGrok` | Grok cutout repair |
| character-repair-blended.txt | images.js `repairCharacterMismatchWithGrok` | Grok blended repair |
| `repair-naturalness.txt` | faceRepair.js checkRepairNaturalness | post-repair figure-integrity check: MATCH/EDGES observations -> enum; clearly off rejects the repaint |
| `repair-face-check.txt` | repairPipeline.js char-fix gate | post-repair comparative face check: original + repaired in, {intact,confidence,reason} out; not intact refuses the repair |
| character-repair-body-blended.txt | images.js `repairCharacterMismatchWithGrok` | Grok body-blended repair |
| character-repair-inpaint.txt | faceRepair.js `buildPrompt` (crosshatch + box) | Full-scene (box-mode) char repair |
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
| sheet-row-heads-eval.txt | character2x4Sheet.js `evaluateSheetRow(row, 'heads')` (`sheetRowHeadsEval`) | SPLIT sheet eval, call 1 of 3 — STRUCTURE of the heads row (heads-only / angles / clean), judged on the crop ALONE. No reference images by design: with the photo in context the judge answered "is the head visible" from the reference and scored a headless crop 8 |
| sheet-row-bodies-eval.txt | character2x4Sheet.js `evaluateSheetRow(row, 'bodies')` (`sheetRowBodiesEval`) | SPLIT sheet eval, call 2 of 3 — STRUCTURE of the bodies row (head-to-toe / angles / outfit / proportions), crop alone. Fills `{REQUESTED_OUTFIT}` + `{REQUESTED_COSTUME}` + `{CHARACTER_AGE}` (the declared age TASK 4 scores proportions against) |
| sheet-row-identity-eval.txt | character2x4Sheet.js `evaluateIdentity` (`sheetRowIdentityEval`) | SPLIT sheet eval, call 3 of 3 — IDENTITY, the only one that sees the reference faces (source photo + avatar faces) and only against the HEADS crop. `CHARACTER_AGE` is substituted in code, not via fillTemplate. Shared by production `generateCharacter2x4Sheet` and the Lab through `evaluateSheetSplit` |
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
| `figureDetection.js` `_somIdentifyFigures()` | Set-of-Mark who-is-who: badged page + sanitised identity lines. Asked twice — the primary detection pass and, from a later tier, the second witness (`secondOpinionIdentity`) |
| `figureDetection.js` `arbitrateIdentity()` | **Identity ARBITER** — the only call allowed to overrule the detector's figure names. Page + a tight crop per contested figure + the candidate names' clothing contract and reference faces; deliberately NOT the SoM question the other two voters already answered, and it is never told who claimed what. Model: `MODEL_DEFAULTS.identityArbiter` (decisions.md 2026-09-21, detector-is-master) |
| `premiseWorld.js` `detectPremiseNamedWorld()` | YES/NO utility-model classification: does the premise name its own world/location (other than the reader's home town)? Fallback rung only — structured wizard signals (`ideaWorld`, `selectedIndex`) are consulted first (decisions.md 2026-08-31, named location binding) |


**Deleted 2026-09-15** (unreachable — beats replaced the unified writer for every full story, and the trial writes its own single call): `story-unified.txt`, `story-unified-imagefirst.txt`, `outline-analysis-textfirst.txt`, and the `buildUnifiedStoryPrompt` builder. See `docs/decisions.md`.
