# Jev first, then no scene review — build plan (2026-09-28)

**Owner decision (2026-09-28):** "Jev first, then remove the scene review."

**STATUS (2026-09-28): the new path is built and tested, and rung 1 has been run. WAITING on the
owner's Q9 answer (table below) before the review is deleted and before rung 2.**

Built (see decisions.md 2026-09-28 "Jev first, then no scene review"):
- [x] Two Art Director calls: `prompts/visual-bible.txt` + `prompts/scene-briefs-all.txt`, one fills
      object (`artDirectorFills`); `scene-expansion-all.txt` / `buildSceneExpansionAllPrompt` deleted.
- [x] Jev between them (`server/lib/jevBriefFields.js`: `decideBriefFields`, `pageLocations`,
      `pinDecidedFields`); FIXED block (`jevDecisions.fixedBlock`); location cite by code (Q8).
- [x] Shot rules per path (`promptBuilders.shotRuleFills`) and the vantage-holds-the-fixed-shot rule.
- [x] Code checks + one batched re-ask on the AD model (`server/lib/briefChecks.js`,
      `prompts/brief-reask.txt`); strict verdict, who-column refusal, pin, carry-forward guards.
- [x] `vb_id_label_mismatch` (authored path and iterate path); `outfit_missing` sent to the re-ask (Q7).
- [x] Bug `clothing-review-none-body-erases-outfit` fixed (d1ed5efca) + guard `beats_outfit_absent`.
- [x] Iterate re-pin (Q6); `jevFixed` stored per page.
- [x] Backup path: call 2 with the pre-Jev wording, same checks + re-ask, no review.
- [x] Lab `beats_scenes` = production (`runArtDirector` + `runBriefChecks`); sibling set
      `lab-vs-prod-brief-checks`; registry sets moved to the new templates.
- [x] Client: dev-mode "Brief checks + re-ask" panel (StoryDisplay), Lab panel (TestLab).
- [x] Tests: new `brief-checks-reask`, `jev-first-shot-rules`, `clothing-review-none-body`; 40+
      tests moved to the new builders; full unit suite green apart from the pre-existing
      `no-output-caps` failure (BACKLOG).
- [x] decisions.md entry, SETTLED factual refresh (lines 46, 66, 67), prompt-inventory, verify
      entry `jev-first-briefs`, BACKLOG ticks.
- [ ] NOT DONE, waits for Q9: delete `runSceneReview`, `scene-review.txt`, the review prompt builder,
      `sceneReviewModel`, the `scene_review_replay` Lab stage, the review sibling sets; re-point the six
      verify entries that name the review.
- [ ] NOT DONE, waits for the Q9 report: rung 2 (Lab `beats_scenes` on the dragon book, to images, cap
      CHF 1.00).

## Rung 1 results (2026-09-28, `scripts/analysis/replay-jev-first-briefs.js`)

- **Jev before the briefs vs after** (3 Jev stories, 147 Jev calls): cited elements 26/26 pages;
  looks 17/20 (the 3 differences are the 2026-09-28 look fix, e.g. dragon p3 now grey); population
  24/25; gaze 41/42 → Q5 holds, gaze is decided before the briefs. Dragon p5 sits in no location's
  `pages` in the AD's bible (logged `beats_jev_page_unlocated`; the AD writes its LOC there).
- **New checks:** `vb_id_label_mismatch` 3/3 true (the ar4u7qry3 covers), 0 false on 360 briefs.
  `outfit_missing` 4 fires on 251 briefs, all real omissions → sent to the re-ask.
- **Prompts** build from stored inputs with no unfilled placeholder: dragon call 1 45.6k chars,
  call 2 100.6k (bible 24.4k) vs the stored single call 119.9k.
- **Re-ask volume** on stored pre-review briefs (written before the FIXED block): 193 of 251 pages
  flagged over 15 stories; the 5 newest stories 8-12 pages each. Top types: light_undeclared 134
  (older stories only), interaction_multiple_actions 64, removal_unstated 56, vb_page_uncited 20.
  Expect a re-ask on nearly every story carrying about half the book — rung 2 measures the real rate
  on briefs written with the FIXED block.

### Q9 table — what each scene-review check did (15 latest staging stories with a stored review, 3 on the Jev path)

"Named" = pages the check's tagged analysis line listed; "rewritten" = of those, pages the review
rewrote; "alone" = pages only this tag named (so the rewrite is attributable to it). This counts what
the review ACTED on, not whether the rewrite was right (the 3 Jev stories: 2 harmful removals, 4 new
faults — see Why).

| check | stories naming pages | pages named | named & rewritten | named by this tag alone | …and rewritten |
|---|---|---|---|---|---|
| interaction_multiple_actions (code check exists) | 15 | 66 | 65 | 10 | 10 |
| element_uncited | 13 | 61 | 56 | 6 | 6 |
| negation_named | 10 | 31 | 29 | 7 | 6 |
| gaze_budget | 12 | 40 | 38 | 4 | 4 |
| character_fields | 11 | 28 | 28 | 3 | 3 |
| clothing_mechanical (code check → re-ask) | 4 | 28 | 28 | 3 | 3 |
| population_contradicted (code check → re-ask) | 4 | 12 | 12 | 3 | 3 |
| clothing_incomplete | 7 | 31 | 31 | 2 | 2 |
| cast_not_in_plan | 6 | 23 | 22 | 2 | 2 |
| closeup_below_waist | 8 | 11 | 11 | 2 | 2 |
| facing_not_per_character | 9 | 17 | 16 | 1 | 1 |
| page_repetition | 5 | 14 | 10 | 2 | 1 |
| themed_setting_bare | 3 | 7 | 7 | 1 | 1 |
| scene_intent | 6 | 18 | 18 | 0 | 0 |
| gaze_missing | 8 | 17 | 17 | 0 | 0 |
| critique_in_brief | 3 | 20 | 17 | 0 | 0 |
| force_at_rest | 9 | 16 | 16 | 0 | 0 |
| continuity | 6 | 18 | 15 | 0 | 0 |
| landmark_photo_mismatch | 2 | 17 | 14 | 0 | 0 |
| depth_unearned | 7 | 13 | 13 | 0 | 0 |
| contact_not_pose | 8 | 15 | 13 | 0 | 0 |
| cast_over_cap | 5 | 12 | 12 | 0 | 0 |
| drawability | 5 | 13 | 12 | 0 | 0 |
| element_stranded | 3 | 13 | 12 | 0 | 0 |
| light_fields | 1 | 12 | 11 | 0 | 0 |
| vb_state_range | 7 | 13 | 10 | 1 | 0 |
| plate_contains_effect | 6 | 12 | 10 | 1 | 0 |
| footing | 1 | 9 | 8 | 0 | 0 |
| prop_unheld | 4 | 10 | 8 | 1 | 0 |
| scale_unanchored | 6 | 8 | 8 | 0 | 0 |
| elevation_unsupported | 4 | 8 | 7 | 0 | 0 |
| closeup_environment | 6 | 8 | 7 | 1 | 0 |
| era_landmark_named | 3 | 9 | 7 | 0 | 0 |
| group_staging | 3 | 5 | 4 | 0 | 0 |
| cast_crowded | 3 | 7 | 3 | 1 | 0 |
| extras_undescribed | 2 | 3 | 3 | 0 | 0 |
| visual_arc | 1 | 1 | 1 | 0 | 0 |
| clothing_owner | 1 | 1 | 1 | 0 | 0 |
| result_not_at_contact | 1 | 1 | 1 | 0 | 0 |
| required_text_undeclared | 0 | 0 | 0 | 0 | 0 |

Bible corrections the review applied over the 15 stories: 9 (8 state-page ranges — Jev owns those
now — and 1 landmark photo). Declared cast removals: 8.

**Owner answers (2026-09-28, AskUserQuestion, relayed by the coordinator):**
- Q1 = A (two-phase AD: VB call → Jev → briefs call). Q-split = two template files.
- Q2/Q3: the re-ask uses the AD model (gemini-3.1-pro), in one batched call, at most one round.
  The iterate corrector stays as it is.
- Q4–Q8 = the recommendations:
  - strict acceptance plus the who-column refusal;
  - gaze decided before the briefs if the rung-1 agreement holds;
  - iterate re-pin of all fields on strict iterate, all but the shot on free iterate;
  - the wardrobe root-cause fix for "Wearing: NONE", plus the input guard, plus `outfit_missing`
    after its precision is measured (the bug goes into bugs.json when confirmed and is fixed in
    the same push);
  - code writes the location id from the VB vantage pages.
- Q9 = measure first. Rung 1 counts, for each lost review check, what it actually changed on stored
  stories. Then STOP and report that table. **The review is not deleted until the owner has answered
  Q9.** Rung 2 (Lab dragon, cap CHF 1.00) also waits for that report.

## Why (measured, not assumed)

Today Jev's per-page brief decisions (shot, VB citations + look, aboard, population, gaze; light is
already decided before) run AFTER the Art Director (AD) has written the briefs
(`beatsPipeline.applyJevBriefDecisions`, called at the end of `runArtDirector`). The scene review
(`prompts/scene-review.txt`, DeepSeek, `runSceneReview`) then mostly exists to write those fields
into the prose, and code re-pins the fields after it (`pinJevFixedFields`, `repinJevStatePages`).

Measured on 3 Jev stories (staging `job_1790529840433_ar4u7qry3`, `job_1790536739048_ruynosw80`,
`job_1790539784661_6mjcny1c7`) + Lab 1579:
- The review wrote the pinned fields into the prose on only **10/24** page-instances.
- Code re-pinned fields after the review on **5 pages** (+7 in Lab 1579).
- The review made **2 harmful removals** (dragon p2/p7, Mama; bug `scene-review-removes-who-column-cast`)
  and **4 new faults** (`plan_cast_uncited` / `vb_page_uncited` introduced on ar4u7qry3 p3 and dragon p7).
- Its only real catches were **2 kinds that code can detect**:
  1. "<name> … wearing no clothing" (ar4u7qry3 Noah, 3 pages). Root cause is upstream: the AD's
     CHARACTER DETAILS read `Noah … Wearing: NONE`, so the wardrobe gave him no outfit.
  2. A VB id in the prose whose label names a different element (ar4u7qry3 covers -1/-2/-3:
     `ART002 (black Piratentuch)`, while the clothing check names ART004 as the Piratentuch).
- Cost: ~1.5% of a story. Time: **53–73 s on the critical path** (AD 104–240 s before it).
- On the dragon book, code changed **17 of 18** briefs after the AD (`beats_jev_brief_fields`).
  Deciding after the AD and then fixing the prose is the wrong order.

Scripts and dumps from this measurement are in the session scratchpad (`d1.js`, `a1.js`,
`job_*.json`). Step 2a moves the replay into `scripts/analysis/` so it is kept.

## Target design

1. Jev decides every page field BEFORE the AD writes the briefs.
2. The AD gets those fields as fixed facts. It writes the prose, plus the fields it still owns:
   `characters[]` rows (depth, expression, perspective), `interactions[]`, `wornItems[]`,
   `weather`, `sceneIntent`, `textPosition`, the Visual Bible (VB) entries, looks and vantages.
3. Code checks every brief: the existing `sceneBriefCheck` REVIEWABLE types, the clothing check's
   sendable types, and two new checks.
4. Only pages with findings go back to the AD, once. The re-ask is bounded and logged.
5. The scene review is DELETED: code, prompt, worn-state round, Lab stage, sibling sets and verify
   entries. There is no fallback to it.

### The hard dependency: the Visual Bible

Jev's citations, look choices, `aboard`, population per location and gaze candidates all need the VB.
Today the VB is written by the same AD call as the briefs (decisions.md 2026-09-11 "The Art
Director authors the Visual Bible, ahead of the page briefs"). **Open choice Q1 below**; the
recommendation is **A, a two-phase AD**.

| Option | How | For | Against |
|---|---|---|---|
| **A. Two-phase AD (recommended)** | Call 1 writes the VB only (the current `---VISUAL BIBLE---` section, same rules, same model). Then code adopts it and Jev decides. Call 2 writes the page + cover briefs, with the VB and the fixed fields as input. | One VB author, and the "declare first, then cite" order stays. Every Jev decision sees the final VB. The landmark-shortfall abort fires after call 1, before the briefs are paid for (closes BACKLOG "early abort now costs a scene-expansion call"). Call 2's reply is smaller, so less truncation risk. | One more AD-sized input (~25k tokens) and one more round trip (est. +20–60 s). Partly replaces the 2026-09-11 entry (the VB still comes from the AD, but in its own call). |
| B. VB call in parallel with the wardrobe call | Same split, but call 1 starts alongside the stage-3 wardrobe call | Close to zero extra wall-clock time | The VB is written without the outfit text, which the AD prompt passes on purpose, so more wardrobe-vs-bible conflicts. Needs a larger restructure of stage 3. |
| C. Keep one call; decide after; code check + re-ask for changed fields | Today's order without the review | No split | Not "Jev first". On the dragon book 17/18 pages change, so the "re-ask" would redo the whole book. Rejected, listed for completeness. |
| D. Hybrid: decide the VB-free fields first (shot and light already are), the VB-bound ones after | One call | No split | The VB-bound fields (cites, looks, population, aboard, gaze) are exactly the ones the review was rendering. Same problem as C. |

## Ordering of calls (option A)

- [ ] 1. Plan → re-plan → `finalizePlanShots` (unchanged; shots in field 0).
- [ ] 2. `decideLight` (unchanged; it needs no VB and may run in parallel with call 1).
- [ ] 3. **AD call 1: Visual Bible.** New template (Q-split below) built from the VB half of
      `scene-expansion-all.txt`. Inputs: arc, plan lines **with their fixed shots**, CHARACTER
      DETAILS, clothing, landmarks. New rule: each vantage's `shot` must hold every fixed shot of its
      pages (this also fixes the `shot_off_plate` BACKLOG item "eye-level page grouped into an
      angled vantage"). The two-attempt retry and "JSON.parse is the completeness test" move with it.
- [ ] 4. Code adoption, moved from `runArtDirector` without changes: label round, invented-child age
      clamp, transcript sync, landmark link + variants, wardrobe-vs-bible corrections,
      `onVisualBible` (the landmark-shortfall abort).
- [ ] 5. **Jev brief decisions**, in one step: `decideVbAndAboard` (adCited = the VB's own `pages`
      claims, the AD's draft, used only for the 0.5–0.7 band), `decideStates` (looks),
      `decidePopulation` (the location per page comes from the VB's location/vantage `pages`, not
      from a brief), `decideGaze` (roster = the shipped check's who column `present` + the cited
      secondaries; candidates = the others on the page, the cites, the creatures the plan line names,
      `away`). Then `applyVbPages` rewrites the VB page tables from the cites, before call 2.
- [ ] 6. **AD call 2: page + cover briefs.** Each story page gets a code-built **FIXED block** under
      its PLAN line (this extends `jevDecisions.fixedLine`): shot; timeOfDay/indoors; cites, each as
      `id (label, look)`; the location/vantage id; aboard; population; looksAt per character. The AD
      copies them into METADATA and writes prose that shows them. Covers keep their code-written
      beats and AD-authored fields (Jev does not decide covers).
- [ ] 7. `pinBrief` on every Jev page. It should do nothing when the AD obeyed. Any difference is
      restored and logged as `beats_jev_field_disobeyed` (warn, per page + field). This replaces the
      `jev_fixed_field` review finding; the count measures how well the AD follows the FIXED block.
- [ ] 8. **Code checks** (list below) over all briefs, covers included.
- [ ] 9. **One re-ask** of the flagged pages (policy below), then the same checks again.
      Survivors ship flagged.
- [ ] 10. VB element-budget report, cover split and page text: unchanged. `refreshPlanShot` stays
      (backup path) but does nothing on Jev pages.

## What the AD prompt keeps and loses

Split `scene-expansion-all.txt` into two templates (Q-split). The per-page `scene-expansion.txt` is
the fallback for pages call 2 leaves out, and the unified path's fallback in server.js. It gets the
same FIXED block through `expandOnePage`.

**Keeps:** every per-page and cross-page staging rule (they now have no critic, see risks), the VB
authoring rules (call 1), metadata fields the AD still authors, text-zone rules, covers.

**Loses or rewords on the Jev path** (the backup keeps today's wording through the existing
`jevBackup` switch, `fixedFieldsRule(jevBackup)`):
- [ ] `JEV_FIXED_FIELDS_RULE`: rewrite it as "the FIXED block is decided; copy it, show it in the
      prose, never change it". Delete the "staging draft" framing and the review sentence.
- [ ] `GAP_ACTION_FRAMING_RULE` (promptBuilders.js:9416): it says to *set* `shot`. Jev wording: the
      fixed shot chooses the framing (over-the-shoulder page → the acting figure is the near crop;
      any other shot → the side-on framing).
- [ ] `CLOSEUP_KEPT_RULE` (shotVocabulary.js:547) and field rule line 388 ("a plan line whose point
      is below the waist is a `medium` shot"): Jev wording is "a close-up stays a close-up; stage the
      moment waist-up". The waist rule stays inside Jev's SHOTS fit definitions, which is where the
      choice is made.
- [ ] `GROUP_STAGING_RULE` (shotVocabulary.js:821): drop "in a wider shot" on the Jev path, because
      the Jev assignment already enforces `GROUP_WIDER_SHOTS`. Keep "one depth / back view, never
      facing the viewer".
- [ ] Field rule "`shot` … Decide it once … a framing the vantage's plate can hold": on the Jev path,
      the vantage is written to hold the fixed shot (call 1 rule above).
- [ ] C2 (time of day) and the `objects[]` / `pages` / `looksAt` / `population` / `aboard` authoring
      rules: on Jev story pages they become "as fixed". They stay as authoring rules for covers and
      the backup path.
- [ ] Review checks 6d, 7b and 10 go away with the review.
- [ ] `OTS_NEAR_FIGURE_RULE` stays. It is about staging inside the fixed shot.

## Code checks

- [ ] **Existing `sceneBriefCheck` REVIEWABLE types:** their findings go to the re-ask. On Jev pages,
      `plan_cast_uncited`, `vb_state_contradicted` and `vb_state_no_base` stay withheld and logged
      (today's `JEV_OWNED` set, moved out of `runSceneReview`). On the backup path they go to the
      re-ask like every other type.
- [ ] **Clothing check:** `removal_unstated` goes to the re-ask. This replaces review check 0 and the
      separate worn-state round. The `wornStateUnresolved` flag and the "defaults to worn" rule are
      kept for survivors.
- [ ] **New check 1, outfit absent (Q7).** The upstream cause first: find out why the wardrobe
      returned `Wearing: NONE` for a commissioned character on ar4u7qry3. If it is a clear bug, it
      goes into `tasks/bugs.json` when implementation starts. That is not done in this plan commit,
      because an open bug blocks every push. Then:
      (a) an input guard before call 1: a character in any who column with no outfit is logged as an
          error and fixed at the wardrobe step, never handed on;
      (b) a brief-side critic: make `clothingCheck`'s existing `outfit_missing` sendable, but only
          after measuring its precision on stored briefs (free). Otherwise write a new structural
          type.
      Regression fixture: the ar4u7qry3 inputs.
- [ ] **New check 2, `vb_id_label_mismatch`.** For each VB id written in the prose with a label next
      to it (`ID (label)` / `label (ID)`), compare the label with that entry's authored `label` /
      name using the resolver's existing token-overlap match (`isSameFigureName` / the 2026-09-08
      token-overlap rule). Never use a new vocabulary. A mismatch becomes a finding, and the fix goes
      to the re-ask. Fixture: ar4u7qry3 covers -1..-3. It reads only structured ids and bible
      entries, so it is not the forbidden "prose pattern → meaning" kind.
- [ ] Both new types: added to `REVIEWABLE`, rendered by `renderFindingsBlock`, unit-tested
      (positive, negative, and the stored fixture), and registered as generator↔critic sibling sets.
      The generator is the AD rule that already says "ids from the VB / every character dressed".

## Re-ask policy (bounded, logged)

- [ ] ONE round, never a second one. This follows the owner's 2026-09-11 "no second review round"
      ruling (a second round broke even).
- [ ] One batched call for all flagged pages (Q3). Payload: the call-2 prompt as context, each
      flagged page's brief, and its findings, built with `briefCorrection.renderCorrectionRequest`.
      `assertCorrectorSeesText` is checked for every flagged page. The reply comes back as
      `## Page N` blocks, parsed by the same parser.
- [ ] Verdict per page through `briefCorrection.correctFindings` / `judgeCorrection`, acceptance
      `strict` (Q4): a page is taken when it resolves at least one finding. It is **refused** when it
      drops a who-column name (reuse `sceneReviewGuard.whoColumnRemovals` / `diffCastRemovals` as
      recheck findings) or moves a pinned field; pinned fields are re-pinned anyway.
      `keepDeclaredWornRows` and `keepDeclaredLight` are applied to every re-asked page, as on the
      review merge.
- [ ] Model: Q2.
- [ ] Logs: `beats_brief_reask` (info: pages, types, model, tokens, time), `beats_brief_reask_verdict`
      (per page: taken/refused + reason), `beats_brief_unfixed` / `beats_brief_introduced` (warn),
      `beats_brief_reask_failed` (a provider error or truncation means the pre-re-ask briefs ship
      flagged; the story never fails on this).
- [ ] Stored as `stories.data.briefCheckReport` = {findingsBefore, reask {prompt, model, usage,
      durationMs, pages, verdicts}, findingsAfter, introduced, survived, jevDisobeyed, wornUnresolved,
      briefsIn}. The old stored `sceneReviewReport` rows stay readable for display only (stored-data
      constraint). New code never writes that key.

## What is deleted (no fallback)

- [ ] `runSceneReview` and its helpers used only by the review: the review merge, REMOVED CAST
      parsing, `applyReviewBibleCorrections` + `bibleCorrectionsMissingFromTranscript` (the VB
      correction channel), the worn-state round, `pinJevFixedFields` / `repinJevStatePages` after the
      review (the pin moves to step 7 and the re-ask), `fixedFieldFinding` / `jev_fixed_field`.
      Before each deletion, check `git log` and decisions.md, and list what each deletion supersedes
      in the decisions entry.
- [ ] `prompts/scene-review.txt`, `buildSceneReviewPrompt`, the `sceneReviewModel` config
      (`models.js:484`), and the `SCENE_REVIEW_MODEL` link in `briefCorrectionModel`'s env chain
      (`models.js:577`).
- [ ] Lab: the `scene_review_replay` stage (server runner, `STAGE_RUNNERS`,
      `client/src/services/testlabService.ts`, `ScorecardsPanel.tsx`), and the review arm inside
      `beats_scenes`. Old experiment rows still display.
- [ ] Sibling registry: delete `lab-vs-prod-scene-review`. Remove `prompts/scene-review.txt` from
      every generator-vs-critic set (at least lines 251, 263, 278, 643 of the registry). A set whose
      only critic was the review keeps its generator members and records the critic loss in its
      reason. Add a new set `lab-vs-prod-brief-checks` for the check + re-ask function.
- [ ] `tasks/verify.json`: re-point or retire the 6 entries that mention the review
      (`creature-part-in-who-column`, `vb-element-overflow-remeasure`,
      `facing-per-character-remeasure` (failed), `group-staging-check` (failed),
      `jev-decision-layer-wired`, `jev-picks-state-look`). The 2 failed ones are about review checks
      that no longer exist. Each gets a closing note naming this change, and a BACKLOG line if the
      defect it measured still needs a critic.
- [ ] Client: the dev-mode review diff panel (`StoryDisplay.tsx`) becomes a "brief checks + re-ask"
      panel over `briefCheckReport`. Old stories keep rendering their stored `sceneReviewReport`.
- [ ] Readers to update: `storyMetrics.churnFromReport`, `storyScorecard`,
      `beatsReplayInputs`, `routes/stories.js`, `storyJobPipeline.js` persistence,
      `client/src/types/story.ts`, `storyService.ts`, `StoryWizard.tsx`. Run the sweeping-shape-changes
      checklist. The four `scripts/analysis/_tmp_check5-7.js` / `_tmp_prepost.js` scripts that
      reference the review are TRACKED (git ls-files). Leave them alone, since the diagnostics
      rule says they are a research asset. Only note that they no longer run against new stories.
- [ ] **Semantic critic coverage lost** (the ~35 tagged checks). Their generator rules stay in the AD
      prompt. Step 2a counts, from the stored analyses of the last ~15 staging beats stories, which
      tags ever led to a rewrite or a VB correction. The owner sees that list (Q9) before the
      deletion commit.

## Jev-outage backup (path A, owner exception)

What the backup does without the review:
- [ ] Probe down at `start`: the planner writes the shots and light is not decided (as today). VB call
      1 is unchanged, because it has no Jev dependency. Call 2 is built with `jevBackup: true`: the AD
      authors shot (placeholder case), light, cites, population, aboard and gaze under today's pre-Jev
      wording. **No review.** Code checks and the one re-ask run exactly as on the Jev path. The
      Jev-owned types are not withheld. `vb_state_*` findings cannot be fixed by a brief re-ask (they
      ask for VB page edits); on the backup path `applyBriefUsage` rebuilds the page tables from the
      briefs' cites, and any `vb_state_*` that survives ships flagged and logged.
- [ ] A Jev failure at step 5 (after call 1, before call 2) switches `brief_fields` → call 2 gets the
      backup wording. This is simpler than today: no Jev call runs after the briefs exist, so no
      half-pinned records have to be cleared.
- [ ] State it in the decisions entry: the backup also loses the review's semantic checks. It is
      today's pre-layer AD + code checks + one re-ask.
- [ ] `tests/unit/jev-outage-backup.test.ts`: the three cases updated (probe down, mid-story loss at
      step 5, Jev live), asserting no review call and one re-ask call when checks flag.

## Iterate rewrites (BACKLOG line 675, included)

- [ ] Persist each page's `jevFixed` on the scene (one source; today it lives only in
      `beatsPipeline`, and `stories.data.jevDecisions` holds only the raw decisions).
- [ ] `iteratePageCore` runs `pinBrief` over the rewrite with the page's `jevFixed` (Q6) and logs
      `iterate_jev_field_restored`. The existing iterate correction loop (`correctFindings`) is
      unchanged.
- [ ] Before building: a free replay over stored iterate rounds of Jev stories, to check whether a
      rewrite actually changed a pinned field (the BACKLOG line says this is unverified).

## Lab parity

- [ ] New production functions: `runVisualBibleCall` (call 1 + adoption), `decideBriefFields`
      (step 5, an extended `applyJevBriefDecisions` that runs before call 2), `runPageBriefs` (call 2
      + fallback), `runBriefChecks` (steps 7–9). `runArtDirector` becomes the composition of the first
      three. The Lab `beats_scenes` stage calls exactly these functions with its knobs
      (`labCallOptions`, `onCall`, `expandPages`).
- [ ] `tests/unit/lab-prod-call-parity.test.ts` pins both call chains. `beats_replan` is unchanged.

## Tests (serial; never `node -e` require beatsPipeline)

- [ ] Unit: the FIXED block builder (every field, covers get none, backup gets none); the call-1 /
      call-2 parsers (VB missing, a page missing, the retry, the per-page fallback carries the FIXED
      block); step 5 on a VB-only input (adCited from the VB `pages`, population from vantage
      `pages`, gaze roster from the who column); `pinBrief` disobeyed logging; both new checks with
      stored fixtures; the re-ask (strict verdicts, the who-column refusal, pinned-field restore,
      failure ships flagged, exactly one round); the iterate re-pin.
- [ ] Rewrite or delete the 39 test files that reference the review. A test is deleted only when the
      behaviour it pins is deleted, with the reason in the commit. Never weaken a test to make it pass.
- [ ] Sibling gate (`check-sibling-paths.js --list`) and the settled gate (`check-settled.js`) must
      be clean.
- [ ] Full unit suite, serially, before push.

## Validation ladder (report which rung each commit used)

- [ ] **Rung 1, free/cents replay over stored plans and briefs** (latest ~15 staging beats stories,
      including the 3 Jev stories and dka3jpog9):
  - [ ] Rate at which the new checks fire, and their precision (ar4u7qry3 must flag both kinds;
        count false positives elsewhere).
  - [ ] Re-ask volume: run the check suite over stored `briefsIn` to get the flagged pages per story.
        This is the expected re-ask size and time.
  - [ ] Jev before briefs vs after: `decideVbAndAboard` with adCited from the stored pre-review VB
        `pages` vs from the brief cites; population from vantage pages vs the brief LOC; gaze without
        interaction objects vs the stored post-brief gaze. Agreement per field, cost a few cents of Jev.
        A field that disagrees materially goes back to the owner (Q5).
  - [ ] Build the call-1 and call-2 prompts from stored inputs: sizes, no unfilled placeholders, the
        FIXED block per page.
  - [ ] Count review channels across the ~15 stories: rewrites per tag, `bibleCorrections.applied`,
        and landmark photo corrections (Q9 evidence).
- [ ] **Rung 2, one Lab `beats_scenes` run on the dragon book** (`job_1790539784661_6mjcny1c7`, stored
      plan), carried through to images. **Hard cap CHF 1.00** (AD side ≈ Lab 1585's $0.36 + the
      call-1 input + the re-ask; pages rendered through the `image` stage's `sceneDescriptionOverride`
      within what is left). Caveat to resolve first: the `image` stage uses the stored story's VB
      reference cells, and a new VB from call 1 may carry different ids and looks. Either choose
      pages whose elements keep their ids, or add a `fromExperiment` source for the brief + VB (a
      small Lab change, production code untouched). Look at every rendered image. Burn-loop rule: two
      failed paid attempts → stop and report.
- [ ] **Rung 3 decision:** after rung 2, ask the owner whether a 4-page smoke run on
      `demo-b-hnecf@magicalstory.ch` is wanted. Never run it without that yes. Every run ends with
      `node scripts/admin/verify-run.js <storyId> --write` and a commit of `tasks/verify.json`.
- [ ] New verify entry `jev-first-briefs` (claim: FIXED fields obeyed or restored, no review call,
      re-ask ≤ 1 round, both new checks live).

## Cost and latency expectations (to be measured in rung 2, not promised)

- Removed: the review (~1.5% of story cost, 53–73 s) and the worn-state round when it fired.
- Added: call 1 (one more AD-sized input of ~25k tokens; the VB output was already being paid for
  inside today's single call), and the re-ask when anything is flagged (the call-2 context +
  the flagged pages' output). On stored data, covers get a `cover_location_repeated` finding in
  every story, so a re-ask will probably fire on most runs.
- Jev step 5: ~20–60 calls, 1–3 s, under $0.01 (measured today: 19/18/59 calls, 1.2–2.6 s).
- Wall clock: about the same as today (call-1 overhead +20–60 s, review −53–73 s, re-ask +30–60 s
  when it fires). The gain is correctness, not speed. Rung 2 gives the real numbers; the dollar cost
  comes from the Lab's measured usage, not a price table.

## Risks

- **Critic loss.** The review's prose-level checks (drawability, gaze budget, contact, facing,
  extras, clothing owner/completeness, negation, scale, elevation, landmark photo 10ab,
  plate-contains-effect 10a, required text 9g, era) go with no replacement. The evidence behind this
  is 3 stories + 1 Lab run; step 2a widens it to ~15. SETTLED line 45 (the composite rarely fires
  "because 6c makes a writer earn the depth") may stop holding. Watch `background` depth
  declarations after the change.
- The AD may not follow the FIXED block. The pin restores it and the count is logged, but prose
  written against a field it did not copy still disagrees with it. `beats_jev_field_disobeyed`
  measures this.
- Gaze decided before interactions exist can lose "interaction object" targets (Q5).
- Element-stranding (review 9e / AD rule C7) now depends on Jev citing the stranded element.
- Two calls: call 2 has to cite ids exactly as call 1 wrote them (`object_id_unresolved` catches a
  miss).
- Backup drift (accepted by the owner, 2026-09-27) grows, because the backup now also goes without
  the review.
- Re-pinning on iterate could undo a legitimate repair reframe (Q6).
- Memory: tests run serially, no heavy local compute.

## Decision records to write when the work lands

- [ ] decisions.md entry "Jev first, then no scene review". It replaces, in part: 2026-09-11 "The AD
      authors the VB ahead of the briefs" (now its own call); 2026-08-08 "findings go to the scene
      review, and nowhere else"; 2026-08-11 advisory ruling (the authored path's acceptance becomes
      strict); 2026-09-13 REMOVED CAST channel; 2026-09-14 review VB-correction channel; 2026-09-27
      Parts 3–5 "the review renders"; 2026-09-28 who-column refusal (moves to the re-ask). Each with
      the measured evidence.
- [ ] SETTLED.md: factual refresh of lines 45 and 67 (review references). Owner sign-off; not a
      reversal of their verdicts.
- [ ] docs/prompt-inventory.md, docs/codebase-guide.md, `CLAUDE.md` pipeline step list, BACKLOG
      lines closed or re-pointed (97, 98, 100, 112, 672, 675, 678, 679, 684, 1246, 1268, 1310, 1326,
      1724), and the memory note `project_jev_decision_model.md`.

## OPEN CHOICES (owner, before Step 2)

- **Q1 — VB dependency:** A two-phase AD (**recommended**) / B VB call parallel to the wardrobe /
  C one call + decide after + re-ask / D hybrid. See the table.
- **Q-split — templates for option A:** split `scene-expansion-all.txt` into `visual-bible.txt`
  (call 1) + `scene-briefs-all.txt` (call 2) (**recommended**: one file per call, clean inventory) /
  or keep one file with two marked sections filled per call.
- **Q2 — re-ask model:** the AD's model, gemini-3.1-pro, as the owner phrased it ("re-asked to the
  AD") (**recommended** for the authored path) / `briefCorrectionModel` (DeepSeek, shared with the
  iterate path; the one-corrector rule of 2026-09-17). If A: should the iterate path's corrector
  follow, or do the two paths keep different correctors?
- **Q3 — re-ask shape:** one batched call for all flagged pages with the full call-2 context
  (**recommended**: cross-page view, one round trip) / per-page parallel calls on the per-page
  template (cheaper input each, loses the cross-page view).
- **Q4 — acceptance:** strict per page, refusing a who-column drop (**recommended**, the iterate
  rule) / advisory (the old review ruling).
- **Q5 — gaze timing:** before call 2, without interaction objects as candidates (**recommended if
  rung-1 agreement ≥ the stored post-brief gaze**) / after call 2, on the finished brief, with a
  re-ask to show it.
- **Q6 — iterate re-pin:** pin every Jev field on strict iterate, and on free iterate pin everything
  except `shot` (**recommended**: free iterate exists to reframe) / pin everything on both / pin
  nothing.
- **Q7 — "no clothing":** fix the wardrobe root cause + an input guard + `outfit_missing` as the
  critic (**recommended**) / a brief-side check only.
- **Q8 — location cite:** code writes each page's LOC/vantage id from the VB's vantage `pages`
  (**recommended**; the vantage choice stays the AD's, made in call 1) / the AD keeps writing it in
  call 2.
- **Q9 — critic loss sign-off:** after rung 1 counts what the review's semantic checks changed on
  ~15 stories, the owner confirms the deletion of each class. Or names any that should come back as
  a code check or a Jev question (e.g. landmark photo 10ab as a Jev noul over the photo description
  vs the plate text).
