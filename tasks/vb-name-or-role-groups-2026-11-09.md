# Visual Bible: name or role, and one entry for a group (2026-11-09)

Owner decisions (2026-11-09, AskUserQuestion):
- ONE `name` field for secondary characters and animals: the story's own name if it gives one ("Bob", "Bello"), otherwise the role the plan uses ("shopkeeper", "dog", "bog monster"). One look word only to tell apart two of the same role.
- A group the story never tells apart ("three monsters", "two guards") is ONE entry with a `count`, one look, one reference cell.

Why: prod job_1794231161354_l3n2o3afm. The bible schema forces `"name": "[Name]"`, so "three monsters" became Grumbo / Plodd / Squelch in three colours. The Jev citation question asked about "Grumbo" (never on the page): 0.22-0.47 on the monster pages, bar 0.7, so no page got a reference cell; the pages drew their own green monsters; the review's repair could not match them; the words-only redraw (Lab 1849) drew the bible's three colours again.

Consumer map: Explore agent report, 2026-11-09 (summarised below by step).

## Steps

- [ ] 1. Generator rule. `prompts/visual-bible.txt` :135/:151 schema, :52 (properName exception for CHR/ANI), :54, :75 (every figure, group rule), :79 (group exception to "beings of one kind written against each other"). Same in `prompts/story-trial-arc.txt` :47/:65/:68. `name` is stored WITHOUT an article; with no story name it is an English role noun (it is copied into English image prompts: promptBuilders sanitizeVbIdsInPrompt, REQUIRED OBJECTS lead).
- [ ] 2. Matching tolerates articles and plurals, in ONE place: `castResolver.canonicalName` (drop leading the/a/an/der/die/das/le/la/les…, singularise for comparison) and every exact-match site switched to it: jevDecisions:1148 (isNameMentioned plan line — the Grumbo bug), sceneBriefCheck:230 plan_cast_uncited, :811, briefChecks namesInBrief/whoColumnDropped, images.js declaredSetNameIds, sceneMetadata figure names, entityConsistency:2045, bboxDetection alias maps, repairLogic findVbFigure, iterateBeat figurePool.
- [ ] 3. Wording: Jev vbQuestion / stateQuestion / rideQuestion read "the bog monster" without "X, the X"; a group reads "the bog monsters (3, all alike)". referenceSheets:571 never makes "the the". jevBriefFields emotion label for a group.
- [ ] 4. `count` field (sweeping-shape-changes skill): VB parse copy sites visualBible.js:1327, 1346, 1626, 2484 and routes/stories.js:1193. Reference cell draws ONE member.
- [ ] 5. Group in the page: REQUIRED OBJECTS "**bog monster** (animal) ×3, all alike"; REQUIRED_CAST_LEAD "exactly one of each" exception; creature_crowd/wildlife wording; planner cast cap counts a group as its size (story-beats.txt:45).
- [ ] 6. Critics in step with the generator (syncing-generator-and-critic skill): image-evaluation D-03 duplicate_character exempts members of a counted group; evalPipeline castPeopleCount / derivePresenceFinding / EXPECTED CAST count use `count`; absenceCheck duplicate cap; entityConsistency one crop per group member.
- [ ] 7. Tests: unit for canonicalName, each switched match site, the group wording, the parse keeping `count`, the critic exemption.
- [ ] 8. Validation on STORED data (iron rule, >= 20 cases):
  - free: replay the Jev citation question text over stored stories with a renamed creature/role (question built from the new name) — Jev calls are fractions of a cent (~USD 0.01 total);
  - paid: re-run the Visual Bible writer (Lab story_bible / visual-bible replay) on >= 20 stored stories with unnamed figures and count invented names and split groups before vs after. Price to be stated before the run (estimate USD 1-2).
- [ ] 9. decisions.md entry (Replaces: none known; check SETTLED.md for name rules), BACKLOG line ticked, sibling check, staging push.

## Out of scope here (own bug entries)
- Busy-place population ignores night/the moment, and the redraw pin restores it over "remove the onlookers" (p4-p7 `ambient`, LOC004 publicP 0.82).
- A redraw instruction loses to the bible description (Lab 1849).

## Review
(to fill after the work)
