# Arc creation, logic first — plan (2026-09-24)

Owner decision 2026-09-24. D1-D7 answered by the owner on 2026-09-24 (D1=A, D2 follows A, D3
band-scaled via `arcChainRange`, D4 log only, D5=a, D6 voice line to STYLE_RULEBOOK, D7 move).
BUILT on `staging` 2026-09-24 (not pushed); see the implementation outline and the review at the end.

Target shape:
1. ONE arc (ARC 1 / ARC 2 and the "Stronger:" commitment line go away).
2. Before the numbered sentences, a short **STORY LOGIC** block: want and stakes, the opposition,
   the facts the plot runs on, the chain (5-6 because/but links, the last one saying why the
   solution works now and did not before).
3. The self-critique checks LOGIC first. The model does no counting.
4. The rulebook shrinks to what shapes the logic. Every cut rule is placed downstream (file:line)
   or dropped, with the reason.
5. The re-telling updates the logic block FIRST, then the sentences. No new reviewer, no extra round.

Line numbers are from `staging` at `183e26651`.

---

## Open owner decisions (answer before implementation)

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Where does the invented-figure count come from once the critique stops listing figures? | **A.** The FACTS section of the logic block lists every named figure the plot runs on, each tagged `(commissioned)` or `(new)`. This is the fact list the owner already asked for ("each figure's abilities and limits"), not a count; code counts the `(new)` tags against `arcInventedAllowance` and keeps the one forced re-telling round. **B.** The arc lists no figures. `planCounters` counts `cast.invented` from the plan-check roster. The forced arc round is deleted, and an overrun becomes a plan finding that re-planning cannot fix (re-planning cannot remove a figure that spans several pages, see memory `project_invented_cast_enumeration`). | **A.** B also loses the premise-figure names that `commissionedCast` needs (see D2). |
| D2 | Premise figures (a pet or sibling named in the premise or in saved details) | Under A: the `(commissioned)` tag on a figure outside the character list replaces `Premise figures:`. Under B: a new source is needed, because the plan roster cannot tell commissioned from invented. | Follows D1. |
| D3 | Event budget | The chain IS the event budget. Code computes the chain length per band from the existing `EVENT_BUDGETS` table (`promptBuilders.js:8160`) and fills it into the chain line ("3-4 links" for a toddler book, "5-6" for the journey band). The model counts nothing, and code re-counts the links it wrote. The owner's fixed "5-6" is the journey-band value. | Band-scaled. A fixed 5-6 links would force 5 events into a routine or quest book, whose band allows 1 (see decisions.md 2026-09-07 "RULES OF THE TELLING are band-conditional"). |
| D4 | Chain or arc length out of range | Log it (`arc_chain_out_of_range` / `arc_length_out_of_range`), or force the same one extra round the invented overcount forces. | Log only. Nothing here is a reader-visible defect. |
| D5 | Does the STORY LOGIC block travel downstream (planner, text writer, text audit, refine)? | **a.** It is stored in `arcReviewReport` only, and `finalArc` keeps its current shape. **b.** It is also forwarded to the text writer, which would get the motives and facts in one place. | **a** for this change. **b** changes 5 downstream templates and belongs in its own experiment. |
| D6 | Distinctive voice (TELLING rule "Each named character speaks with a distinctive voice") | Drop it from the arc: a factual-register arc cannot carry voice. **Nothing downstream carries it today** (`story-text-from-beats.txt` has no voice rule). | Drop it from the arc, and separately ask whether to add one line to `STYLE_RULEBOOK` (`promptBuilders.js:9035`). |
| D7 | `SIZE_LOOK_RULE` in the arc | Keep it in TELLING (decisions.md 2026-09-23 put it there on evidence), or move the positive half ("a size the plot turns on is a fact") into the FACTS spec and let the plan (`story-beats.txt:58`) and prose (`STYLE_RULEBOOK`, `promptBuilders.js:9040`) carry the comparison ban. | Move. This partly reverses the 2026-09-23 entry, see (g). |

---

## (a) Every consumer of the arc-create output and format

Consumers: **72 files**: 9 arc-family prompts plus 5 downstream readers of `finalArc`, 12 server
modules, 5 client files, 5 scripts or registries, 30 unit tests, 6 Lab fixtures. Grouped by what breaks:

### A1. Generator and critic prompts (change)
- `prompts/arc-create.txt` (38 lines): the TASK section (l.28-38) is replaced; see (e).
- `prompts/arc-retell.txt` (51 lines): output list l.41-51 gains `STORY LOGIC:` first and loses the two figure-spec bullets (l.42-43, D1).
- `prompts/arc-panel.txt` (33 lines): see (c).
- `prompts/arc-hints.txt` (19 lines): receives the logic block; see (c).

### A2. Lab-only arc prompts (read the arc; check, probably unchanged)
- `prompts/arc-amend.txt`, `prompts/arc-amend-judge.txt`: read `FINAL_ARC` only (`buildArcAmendPrompt`, `promptBuilders.js:~9435`). Unaffected under D5a.
- `prompts/story-arc-review.txt` (`buildArcReviewPrompt`, `promptBuilders.js:10090`): the non-arc STORY_SHAPE plus `ARC_PLACE_RULE`. Unaffected.
- `prompts/story-arc-audit.txt` (`testlab.js:3682`): reads an arc. Unaffected.
- `prompts/story-arc-judge.txt`: the Lab judge. Its BRIEF context is `storyScorecard.buildBriefContext`, which appends STORY_SHAPE + AGE_MODE + **ARC BUDGETS** (`storyScorecard.js:278-290`). Once the arc is no longer given the event and action budgets, the `fit` dimension still grades against them. Change the context to the same sections the new arc gets (see A5).

### A3. Downstream readers of `finalArc` (shape must NOT change under D5a)
`story-beats.txt` `{FINAL_ARC}` plus `{ACT_SPANS}`; `plan-check.txt` `{FINAL_ARC}` plus `{ACT_SPANS}`;
`story-text-from-beats.txt` `{STORY_ARC}`; `story-text-audit.txt`; `text-refine.txt`.
`arcActSpans` (`promptBuilders.js:8457`) reads the highest `^\d+[.)]` in `finalArc`. **Contract:**
the logic block never enters `finalArc`, and its chain links are dash lines, never numbered. Otherwise
the act spans and `critiqueMaxSeverity` read them. `finalArc` keeps its `Challenges taken:` tail
(`parseArcRetell`), which cross-story challenge memory reads.

### A4. Builders, constants, parsers — `server/lib/promptBuilders.js`
- `buildArcCreatePrompt` 9321, `buildArcRetellPrompt` ~9379, `buildArcPanelPrompt` ~9342, `buildArcHintsPrompt` ~9408.
- `buildTellingRulesSection` 9186, a 32-line block; see (b).
- `buildArcBudgetSection` 8259, `EVENT_BUDGETS` 8160, `INVENTED_FIGURE_BASE` ~8180, `arcInventedAllowance` 8237, `arcLengthRange` 8124, `twoThreadsAllowed` ~8252.
- `arcCritiqueSpec` 9281. It is **replaced**; see (e).
- `PREMISE_FIGURES_SPEC` / `INVENTED_FIGURES_SPEC` 9117-9118 and `COMMISSIONED_CAST_DEF` 9108. Retired or reshaped per D1.
- `ARC_ENTRANCE_RULE` 9129, `ARC_GIVEN_RULE`, `ARC_SENSE_RULE`, `ARC_PLACE_RULE` 9142, `EVERY_CHILD_ACTS_RULE` 9155, `CENTRAL_FIGURE_DEF` 9165: kept as the one-string generator/critic pairs.
- `parseArcCreate` 9560 **throws on a missing "Stronger:" and a missing "ARC 2:"**. Rewrite it for one arc: `STORY LOGIC:` then `ARC:` then `CRITIQUE:`. It still throws on a missing arc, and the caller keeps its one re-create.
- `parseArcRetell` 9599: add `logic` (the `STORY LOGIC:` head block). `INVENTED_BLOCK_STOP` 9481 gains `STORY LOGIC`, and loses `ARC\s*\d` once no numbered-arc marker is emitted.
- `parseFigureList` / `parsePremiseFigures` / `parseInventedFigures` / `isNegativeFigureAnswer`: replaced by one `parseLogicFigures` under D1-A, which reuses the negative-answer handling; under D1-B they are deleted.
- `critiqueMaxSeverity`: kept. The critique keeps its numbered, severity-tagged `Faults:`.
- `buildStoryShapeSection` 6490 `{arc:true}` is **shared with the trial writer** (`buildTrialStoryPrompt`, 10897) and with `storyScorecard`. Do not edit the arc variant; the arc keeps it whole (see b).
- `buildAgeModeSection` 6328 is shared with beats (8045), trial (10898) and trial ideas (11320). The arc switches to the existing `bandView: 'premise'` (`BAND_VIEW_KEEPS`, 6162). No band file changes.
- `storyHelpers.js:21,542-551`: re-exports. Add the new names and drop the deleted ones.

### A5. Pipeline and counters
- `server/lib/beatsPipeline.js`: imports 94-102; `fixingBelowMajor` 187 (kept, since it reads numbered critique faults); the arc machine 947-1260: create parse 1004-1016; `gl.info('arc_create', … committed: commit.n, stronger: …)` 1017; invented re-count and forced round 1036-1040 and 1116-1137; `arcPremiseNames` → `commissionedCast` 1339; `runPlanCounters({ declaredInvented, inventedAllowance })` 1437; `arcReviewReport` 1223-1246 (`committedArc`, `committed`, `discarded` go; `logic` and `createLogic` come in).
- `server/lib/planCounters.js`: `runPlanCounters` 590; `ARC_INVENTED_UNDECLARED` / `ARC_INVENTED_OVER_ALLOWANCE` 843-892; ranking 1154-1176. Under D1-A the declared list comes from the logic block, with no other change. Under D1-B `declaredInvented` is null and the effective count is `cast.invented` alone.
- `server/lib/castCoverage.js:112-135` `commissionedCast(inputData, suppliedNames)`: the supplied names come from the logic block's `(commissioned)` figures (D1-A).
- `server/config/models.js:393-441`: `arcRounds`, `arcRoundsMax`, `arcForceRoundOnInventedOvercount` (stays under D1-A, deleted under D1-B), `arcCreateEffort 'max'`, `arcRetellEffort 'medium'`.
- `server/lib/storyScorecard.js:278-290`: the judge context. Swap `buildArcBudgetSection` for whatever sections the new arc is given.
- `server/lib/textRefine.js:486`: comment only (cites `buildArcBudgetSection`).
- `storyJobPipeline.js` 3770/3773/4140/6899/7664: reads `finalArc` and `arcHints` and persists the report. Unchanged under D5a.
- `server/routes/stories.js:407`: returns `arcReviewReport` whole. Unchanged.
- `server/lib/beatsReplayInputs.js:66,87`: reads `finalArc` and `arcHints`. Unchanged.

### A6. Test Lab
- `testlab.js` `runArcEffortStage` 8343: calls `parseArcCreate` and reads `commit.arc` / `commit.committed` (8447, 8490). The `promptFrom` path splits `buildArcCreatePrompt` on a sentinel (8397-8405), so old experiments' prompts stop matching and it throws. That failure is correct.
- `runArcPanelReplayStage` 8866: needs a stored `arcReviewReport.committed`. The new report keeps a `committed` block (logic block, arc and critique) so replay still works on new stories. Old stories keep their old block.
- `runArcRoundsStage` 8654 (`buildArcCreatePrompt` at 8720) and `runArcAmendStage` 8546: read the arc only.
- Client mirror `client/src/services/testlabService.ts:578-599` (`arc_rounds`, `arc_amend`, `arc_effort`, `arc_panel_replay`): the labels only; `arc_effort`'s label names `promptFrom`. Add the two new params from (f).

### A7. Client (dev panel)
- `client/src/types/story.ts:1094-1119` `ArcReviewReport`: drop `committedArc`/`discarded`, add `logic`, and update the `create` comment ("both arcs").
- `client/src/components/generation/StoryDisplay.tsx:3053-3110`: the "Committed arc (Arc N)", "Discarded arc" and "Raw creation (both arcs, both critiques)" blocks. Replace them with "Story logic" and "Raw creation".
- `client/src/pages/StoryWizard.tsx:420,1164,4341,4930` and `client/src/services/storyService.ts:149,426`: pass-through only.

### A8. Scripts and registry
- `scripts/admin/verify-checks.js:373,405,747`: read `rounds[].panel` and `finalArc`, and name `.create`. Wording only.
- `scripts/analysis/dump-beats-prompt.js`, `scripts/analysis/verify-toddler-carry.js`, `scripts/analysis/fetch-story-data.js`: read `finalArc` or report presence. Unchanged.
- `scripts/admin/sibling-registry.json`, sets touched: `arc-generator-vs-critic` (reason text: lenses CAST/ACTION leave, LOGIC joins); `commissioned-cast-arc-vs-plan-counters` (reason text: the lists move into the logic block); `character-source-claim` (arc-create/retell/panel/hints members; no change in the source claim); `arc-hint-handoff` (only if D5b); `beats-planner-vs-plan-check` (if plan-check Q12 gains the central figure, d4).
- `node scripts/admin/check-sibling-paths.js --list` was run for this plan. The relevant sets are listed above. None blocks the planned change, but every commit that touches an arc prompt must move its partner in the same commit (gate 9).

### A9. Tests pinning the format (30 unit files, ~all need edits)
`age-band`, `arc-creator-effort` (fixture `ARC 1:` / `Stronger: Arc 1`), `arc-critique-spec-and-shape`,
`arc-invented-figures`, `arc-landmark-three-consumers`, `arc-peril-single-ceiling`,
`arc-prompt-audit-2026-09-23`, `arc-reader-age-agreement`, `beats-category-guidance`,
`beats-dropped-fill-keys`, `beats-premise-world-only`, `beats-replan-change-review`,
`beats-replan-shipped-report`, `built-prompt-values`, `challenge-variety-selection`,
`character-source-precedence`, `character-source-rule-reach`, `commissioned-figure-definition`,
`coping-strategy-and-page-openings`, `invented-allowance-counts-the-book`,
`iterate-rewrite-keeps-the-brief`, `landmark-offer-hygiene`, `page-plan-audit-2026-09-23`,
`place-inside-outside-rules`, `plan-counters`, `risk-framing-rule-reach`, `size-look-rule`,
`spread-values-reach-their-template`, `text-judges-no-commission`, `trial-idea-variety`.
Lab fixtures that keep the old format as evidence (do not edit): `tests/manual/arc-effort/*.json|txt`.
Rule for the rewrite: pin the behaviour (a parser reads one arc; a rule reaches its generator and
its critic; no count reaches the critique), never the wording.

### A10. Docs and memory
`docs/decisions.md` (new superseding entries, see g), `docs/prompt-inventory.md` (arc-create
description), memory `project_invented_cast_enumeration.md` (the enumeration moves or dies).

---

## (b) Rule-by-rule table: the current arc-create prompt

Source: the BUILT prompt of staging `job_1790277448294_5herh01j7`
(`stories.data.arcReviewReport.createPrompt`, 35,864 chars; line numbers `P:<n>` refer to that
dump), plus the template and the builders. Verdicts: **KEEP**, **MOVE → where it already lives**,
**CODE**, **DROP**.

### Header, commission, context
| Rule | P: | Verdict | Reason / where |
|---|---|---|---|
| Goal line (suspense, coherent, figures a child likes) | 1 | KEEP | the target |
| Work in English; book language | 1 | KEEP | mechanics |
| Reading level line | 3 | KEEP (context) | one line; the complexity it implies is in the chain length |
| Characters line | 4 | KEEP | |
| THE COMMISSION block (binding / not binding / stakes are drama) | 6-25 | KEEP | the commission |
| CHARACTER_SOURCE_RULE + CHARACTER DETAILS | 27-58 | KEEP | the facts section draws abilities and limits from here |
| TOPIC GUIDE | 60-105 | KEEP | material. Its "give each dragon a scale" line (P:100) fights D7; out of scope, and noted in the guides backlog |
| REAL LANDMARKS header + vantage rules | 107-165 | KEEP | the commission's world; the planner inherits the arc's landmark choice (`story-beats.txt:69`); the panel LANDMARK lens grades it |
| CHALLENGE IDEAS + [C###] tag rule | 174-202 | KEEP | the draw; `Challenges taken:` tags feed challenge memory |

### STORY SHAPE (`buildStoryShapeSection` arc variant, shared with trial: unchanged)
| Rule | P: | Verdict | Reason |
|---|---|---|---|
| Main characters share challenges, ending theirs, one carries the change | 168 | KEEP | want and resolution |
| "Build the story on three or four challenges" | 169 | KEEP | band-computed already; the chain length (D3) must agree with it. Implementation check: one number source |
| Everyone else carries no arc + EVERY_CHILD_ACTS_RULE | 170 | KEEP (generator half) | commission. The critique check leaves: **plan-check Q12** (`plan-check.txt:46`) and the planner's `{CAST_COVERAGE}` (`story-beats.txt:67`, `castCoverage.castActionRule` 82) already enforce it, and the re-plan can add an action |
| Simplest level: challenges solved by trying/asking/noticing | 171 | KEEP | an ability limit, a fact |
| CAUSAL_COHERENCE_RULE (6484) | 172 | KEEP | the cause, the core of the logic |

### AGE MODE: the mini hero's journey (band file, `age-band-*.txt`)
Switch the arc to `bandView: 'premise'` (premise + mechanics). The planner still gets the full
`writer` view (`buildBeatsPrompt`, `promptBuilders.js:8045`).
| Rule | P: | Verdict | Reason / where |
|---|---|---|---|
| Header, reader line | 204-206 | KEEP | premise |
| The full shape (ordinary → call → … → home) | 208-210 | KEEP | premise:subject, the spine of the chain |
| A real low point is required ([[craft]]) | 212-214 | KEEP, stated in the CHAIN spec | the owner lists "the low point and turn". The premise view drops [[craft]], so the chain line carries it (band-conditional: the simple bands get "nothing gets worse"). Plan page: `story-beats.txt:72` |
| The hero's own idea turns it | 216-218 | KEEP | agency, the turn |
| It resolves | 220-221 | KEEP | resolution |
| A real antagonist, with a reason | 223-224 | KEEP | opposition |
| Twist / sidekick / setup pays off ([[craft]]) | 224-225 | DROP from arc | craft; plant/payoff stays via the critique question and panel ORPHAN, and plan-check Q7 (`plan-check.txt:37`) |
| Competence | 227-228 | KEEP (merged into cause) | |
| The stake is the main character's own | 230-233 | KEEP | stakes |
| Humour and mild peril | 235-236 | DROP from arc | peril ceiling = the no-death rule (kept); humour is text's (`story-text-from-beats.txt:56` "its feeling and its suspense") |
| Ending: come back changed ([[craft]]) | 238 | DROP (covered) | "It resolves … come home changed" (kept) says it |
| AGE_OWNS_PROPS_RULE (6326) | 240 | KEEP | stakes; also reaches the planner via AGE_MODE |

### BUDGETS (`buildArcBudgetSection`, 8259): the whole section leaves the prompt
| Rule | P: | Verdict | Reason / where |
|---|---|---|---|
| At most N events, one obstacle chain | 243 | CODE, as the chain length (D3) | the link count is a shape the model fills, not a total it certifies |
| Simple bands: extra pages = more of the same | (band) | KEEP in the chain line for simple bands | it is their logic shape |
| One telling carries one new fact | 244 | DROP | pacing of the telling, not logic. Nothing downstream carries it: see risk R6 |
| One main action per page (at most two) | 245 | MOVE → `story-beats.txt:55` "One action per page. {DEED_AND_EFFECT_DEF}", plan-check Q9 (`plan-check.txt:40`), word counter `buildWordBudgetFindings` (`textRefine.js:502`) | the arc has no pages; see risk R3 |
| Read aloud: one question open, one thread, every turn traceable | 246 | KEEP (in the chain spec) | logic complexity |
| Invented named figures: room for N + justification line | 247 | D1-A: KEEP one sentence "room for N new named figures"; the count is CODE | the allowance is a design constraint; the tally is arithmetic |
| What counts / not counted / can't drop by un-naming | 248-250 | D1-A: KEEP as the tag definition in FACTS; D1-B: DROP (`planCounters.js:843-892` counts from the roster) | |

### RULES OF THE TELLING (`buildTellingRulesSection`, 9186): 32 lines
| # | Rule (short) | P: | Verdict | Reason / where |
|---|---|---|---|---|
| T1 | Factual register | 253 | KEEP | the arc's format |
| T2 | therefore/but, never "and then" | 254 | KEEP → becomes the CHAIN spec | logic |
| T3 | Name feelings at each turn | 255 | MOVE → `story-text-from-beats.txt:56` ("gives each page its feeling") and :22 | feeling is telling, not logic |
| T4 | Each character's nature causes or solves a problem | 256 | KEEP (in FACTS: abilities) | logic |
| T5 | Wants from the start; changed at end; one visible change | 257 | KEEP (WANT + resolution) | |
| T5b | "Early on, a character says aloud what must happen and why" | 257 | MOVE → `story-text-from-beats.txt:51` (stake stated plainly, early and later), `story-beats.txt:75` | telling |
| T6 | Cost / escalation / low point (or repetition for simple bands) | 258 | KEEP (CHAIN spec) | low point and turn |
| T7 | Children resolve it; adults comfort/permit/watch | 259 | KEEP | agency and safety |
| T8 | Life-skill strategy works and is acted, not stated (gated) | — | KEEP | the commission's payload; no other beats stage carries it (decisions.md 2026-09-14) |
| T9 | Challenges belong to the story; youngest's reach | 260 | KEEP (youngest's reach → FACTS limits) | ability limits |
| T10 | Coverage by deeds inside the same event | 261 | DROP | existed to stop event inflation; with no event count its reason is gone. Coverage: `story-beats.txt:67` `{CAST_COVERAGE}` |
| T11 | Opposition wants something, presses to the end, present at the turn, does not yield | 262 | KEEP (OPPOSITION) | |
| T12 | Reasons grounded, not announced | 263 | KEEP | logic |
| T13 | A speaking figure never records backstory in writing | 264 | DROP (merged into T12 and panel DEVICE) | a special case of "a sign stated to license a turn is not a reason" |
| T14 | Obstacle exists for its own reasons; no puzzle door | 265 | KEEP (the world's rule) | |
| T15 | Rival's thread ends with the rival present; appears once more | 266 | KEEP first half (merged into T11); DROP "at least once more" | a count; "presses to the end" covers it |
| T16 | Nothing could lead to death | 267 | KEEP | safety (owner list) |
| T17 | RISK_FRAMING_RULE (8992) | 268 | KEEP | safety. Only the arc and the trial carry it |
| T18 | ANIMAL_FATE_RULE (8990) | 269 | KEEP | safety; `trial-idea-variety.test.ts` pins its arc reach |
| T19 | Ends safe and together; promised container opens; portal returns | 270 | KEEP | resolution; promises kept |
| T20 | Ending is the page remembered; no moral; settle props before last page | 271 | MOVE → `STYLE_RULEBOOK` last-page line (`promptBuilders.js:9041`), `ENDING_EVENT_DEF` (`story-beats.txt:78`, plan-check Q8) | page craft |
| T21 | Close every thread; the resolver has an origin; a singled-out figure has a reason | 272 | KEEP → last CHAIN link ("why it works now") | logic |
| T22 | Fewest characters; merge roles | 273 | KEEP | cast logic, and what replaces cast counting in the prompt |
| T23 | Together on one path / two threads from 6 | 274 | KEEP | structure |
| T24 | Enter in ones or twos; own line on first appearance | 275 | MOVE → `story-beats.txt:76` + plan-check Q2 (`NAMING_DEF`, 8442), cast ceiling `story-beats.txt:44`, Q3 | entrance staging |
| T25 | ARC_ENTRANCE_RULE | 276 | KEEP | a stated cause puts a figure there (panel ENTRANCE) |
| T26 | ARC_GIVEN_RULE | 277 | KEEP | facts before use (panel ASSUMED) |
| T27 | ARC_SENSE_RULE | 278 | KEEP | the logic check itself (panel SENSE) |
| T28 | ARC_PLACE_RULE | 279 | KEEP | world consistency (decisions.md 2026-09-24, l.432) |
| T29 | SIZE_LOOK_RULE + commission sizes kept | 280 | D7: MOVE the positive half into FACTS; the comparison ban already lives at `story-beats.txt:58` and `STYLE_RULEBOOK` 9040 | |
| T30 | Distinctive voice | 281 | DROP (D6) | a factual-register arc cannot carry it; **no downstream carrier** |
| T31 | Travelling animal named by the children, keeps the name | 282 | DROP | naming staging; `story-text-from-beats.txt:56` ("names given and heard"), plan Q2 naming |
| T32 | Commission names stand; invented vessel/place names fresh, distinct | 283 | KEEP first half (commission); DROP the vessel half | the vessel clash is cosmetic and rare; no downstream carrier (noted) |
| T33 | Time-of-day deadline: start at an hour the book can cross | 284 | KEEP (WANT: deadline) | logic |
| T34 | Central figure acts in every third | 285 | KEEP "acts, never cargo" + FACTS line naming it; "every third" → CODE (d4) | the per-third tally is a count |

### Critique spec (`arcCritiqueSpec`, 9281): replaced
| Item | P: | Verdict | Where |
|---|---|---|---|
| Premise figures list | 294 | D1 (moves to FACTS tags or drops) | |
| Invented figures list + Allowed/Written | 296 | CODE | d3 |
| Checks: Events | 299 | CODE (chain links) | d2 |
| Checks: Surplus facts | 300 | DROP | R6 |
| Checks: Invented figures | 301 | CODE | d3 |
| Checks: Central figure per third | 302 | CODE + plan-check | d4 |
| Checks: Each child's action | 303 | MOVE → plan-check Q12 (`plan-check.txt:46`) | already there |
| Checks: Commission honored | 304 | KEEP (non-counting) | commission |
| Q1 where the story loses them | 307 | KEEP | |
| Q2 each thing follows | 308 | KEEP (absorbed into LOGIC) | |
| Q3 open question, outcome in doubt | 309 | KEEP | stakes |
| Q4 figures liked, rooted for, told apart | 310 | KEEP | character truth (decisions.md 2026-08-30 refinement 3) |
| Q5 theme richness | 311 | KEEP | commission |
| Q6 plant/payoff both ways | 312 | KEEP | logic |
| Faults: 3-6, tagged CRITICAL/MAJOR/MINOR, archetype list | 314 | KEEP (list trimmed to logic + character truth) | parser contract: `critiqueMaxSeverity`, `fixingBelowMajor` |
| "No final version — stop after second critique" + "Stronger:" | 316-318 | DROP | one arc |

**Size of the cut:** from ~35.9k to an estimated ~24-26k chars on this commission. The commission,
guide, landmarks and draw (~22k) are untouched. Budgets (−2.0k), TELLING (−2.4k of 5.1k),
critique counts and figure specs (−2.3k) and the hero's journey craft lines (−0.8k) go.

---

## (c) Generator-critic sync

### Panel lenses (`arc-panel.txt`, 12 today)
| Lens | Verdict | Reason |
|---|---|---|
| **LOGIC (new, first)** | ADD | Read the STORY LOGIC block against the sentences. Does a figure act against its stated want, reason or ability? Does any "why don't they just…" survive? Does a fact contradict an earlier one? Does the last chain link say why the solution works now? Is a fact the plot needs missing from the block? The generator half is the critique's LOGIC check (e). ONE constant `ARC_LOGIC_CHECK` filled into both |
| ENTRANCE | KEEP | ARC_ENTRANCE_RULE stays in TELLING |
| ASSUMED | KEEP | ARC_GIVEN_RULE |
| DEVICE | KEEP | T12 grounded reasons (absorbs T13) |
| CAUSE | KEEP | CAUSAL_COHERENCE_RULE |
| CLAIM | KEEP | a logic question |
| REPLACEABLE | KEEP | a logic question |
| SENSE | KEEP | ARC_SENSE_RULE (the rule text unchanged) |
| PLACE | KEEP | ARC_PLACE_RULE |
| CAST | REMOVE | a count. D1-A: code counts the FACTS tags; the lens text also carried the counting definition the generator no longer gets. Drop `INVENTED_ALLOWANCE` and `COMMISSIONED_CAST_DEF` from `buildArcPanelPrompt` |
| ACTION | REMOVE | a per-child tally; plan-check Q12. The generator keeps EVERY_CHILD_ACTS_RULE (a generator rule without a critic lens is allowed; the reverse is not) |
| LANDMARK | KEEP | the commission's world |
| ORPHAN | KEEP | plant/payoff |
The "ask all twelve" count becomes "all eleven". The panel's `COMMITTED_ARC` becomes the logic
block, the arc and the critique (no Stronger line). The SOLUTION spec gains: "a solution that changes a fact
names the line of the story logic it changes".

### Re-tell (`arc-retell.txt`)
- Output order: `STORY LOGIC:` (updated FIRST) → `Fixing:` → `Keeping:` → `Challenges taken:` → `Used:` → `FINAL ARC:` → `CRITIQUE:`.
- New task clause: "Update the story logic first: every fix that adds, removes or changes a fact, a motive or a link does it there, and the sentences are then told from the updated block. A sentence never carries a fact the block contradicts."
- "all the rules of the telling" → "all the rules above". The same `{TELLING_RULES}` (trimmed), `{STORY_SHAPE}`, `{AGE_MODE}` (premise view) and new `{ARC_LOGIC_SPEC}` as create.
- `{ARC_BUDGETS}` leaves both templates. `{PREMISE_FIGURES_SPEC}` / `{INVENTED_FIGURES_SPEC}` leave (D1-A: the tags live in `{ARC_LOGIC_SPEC}`).
- The critique spec is the same constant with `retell: true` ("faults that remain").
- Unchanged: the change-size rule, the suspense rule, "a why fault is answered from character first", Keeping and the landmark clause.

### Hints (`arc-hints.txt`)
- Fill `{STORY_LOGIC}` beside `{FINAL_ARC}` and add: "A change never contradicts the story logic; where it must, it names the fact it changes." It is a critic in `arc-generator-vs-critic`, and a hint that breaks a stated fact would reach the planner (`arc-hint-handoff`).

### Judges
- `story-arc-judge.txt` context (`storyScorecard.js:278-290`): drop `buildArcBudgetSection`, so the `fit` dim is judged against what the arc was asked for. The dims themselves already grade logic (sense, blockers, grounding).

---

## (d) What code counts instead of the model

| # | Count | Source | Where | Result |
|---|---|---|---|---|
| d1 | Arc sentences vs `arcLengthRange` | `finalArc` numbered lines (same regex as `arcActSpans`) | `beatsPipeline.js`, after `parseArcCreate` / `parseArcRetell` | `gl.warn('arc_length_out_of_range')`, and in `arcReviewReport.counts` (D4) |
| d2 | Chain links vs band range (from `EVENT_BUDGETS`) | the `Chain:` dash lines of the logic block (`parseStoryLogic`) | same place; the range is computed once by a new `arcChainRange(inputData, pages)` in promptBuilders, which the prompt line also reads | warn (D4) |
| d3 | Invented figures vs `arcInventedAllowance` | D1-A: the `(new)` tags in the FACTS figure lines. D1-B: the plan roster `cast.invented` | D1-A: the existing re-count + forced-round block (`beatsPipeline.js:1116-1137`), fed from the new parser; `declaredInvented` + premise names go on to `runPlanCounters` / `commissionedCast` unchanged. D1-B: delete that block and `arcForceRoundOnInventedOvercount`; `planCounters.js:843-892` uses `cast.invented` alone | forced round (A) / plan finding (B) |
| d4 | Central figure present in each third of the pages | the name from the FACTS `Central figure:` line (or `none`); presence from the plan-check roster `people` per page | `planCounters.js`, new counter `CENTRAL_FIGURE_ABSENT_THIRD` (thirds of the page count). Plan-check Q12 gains an `ACTION <central figure>` line (`plan-check.txt:46`, filled through `castActionRule`), so "acts, not carried" is judged on pages. The planner states the same rule (`beats-planner-vs-plan-check` set) | a must-fix plan finding; the re-plan can re-stage a page with the figure |
| d5 | Each child's action | already counted: plan-check Q12 `ACTION` lines + `{CAST_COVERAGE}` | nothing to add | — |
| d6 | Actions per page / words per page | already counted: plan-check Q9, `buildWordBudgetFindings` (`textRefine.js:502`) | nothing to add | — |
| d7 | Critique severity | `critiqueMaxSeverity` / `fixingBelowMajor` on numbered `Faults:` | unchanged | early stop unchanged |

Every count reads a list the model wrote as content (sentences, links, tagged figures, roster).
None scans prose for meaning (SETTLED "Classification is the PROMPT's job").

---

## (e) New arc-create prompt skeleton

Headings in build order, with one line each. Generic wording; the exact text is written at implementation.

1. **Intro**: plan a {PAGE_COUNT}-page book; goal line; work in English; the book language.
2. **Reading level / Characters**: as today.
3. **THE COMMISSION**: `{STORY_BRIEF}`, unchanged.
4. **CHARACTER DETAILS**: `{CHARACTER_SOURCE_RULE}` + `{CHARACTER_DETAILS}`; abilities and limits come from here.
5. **TOPIC GUIDE / REAL LANDMARKS / CHALLENGE IDEAS**: unchanged sections.
6. **STORY SHAPE**: the unchanged `{STORY_SHAPE}` arc variant.
7. **AGE MODE**: `{AGE_MODE}` in the premise view: the shape, agency, resolution, the opposition with a reason, whose stake it is, and the age that owns the props.
8. **THE RULES OF THE LOGIC**: the trimmed `{TELLING_RULES}`: factual register; cause; nature causes or solves; want and change; the children resolve it; the opposition presses with its own want; grounded reasons; obstacles from the world; the entrance, given, sense and place rules; fewest figures; together or two threads; the deadline hour; the central figure acts; commission names stand; life-skill strategy (gated). Safety: no death, risk framing, animal fate, safe and together at the end.
9. **YOUR TASK**: write ONE arc, in this order:
   - **STORY LOGIC:** (dash lines, never numbered)
     - *Want and stakes*: what the heroes want, what is lost if they fail, the deadline.
     - *Opposition*: who or what stands in the way, what they want and why, what they know.
     - *Facts*: each named figure on one line, `- <name> (commissioned|new) — can …; cannot …`; the central figure named, or `none`; the world's rule the plot runs on (what keeps a thing alive or open); a size only where the plot turns on it, as a fact. "Room for {N} new named figures."
     - *Chain*: {CHAIN_LENGTH} links, each "because …" or "but …", call to ending; the band's low point (or the repetition shape for simple bands) and the turn; the last link says why the solution works now and did not before.
   - **ARC:** {ARC_LENGTH} numbered sentences, told from the block.
   - **CRITIQUE:** `{ARC_CRITIQUE_SPEC}`:
     - *Logic:* every sentence against the block. Name each sentence where a figure acts against its stated want, reason or ability, where a "why don't they just…" is left open, or where a fact contradicts an earlier one. `none` if clean.
     - *Commission honored:* one line.
     - *Questions:* the reader questions (lose them / open question / liked and told apart / theme / plant-payoff), answered as {READER}.
     - *Faults:* 3-6 numbered faults, tagged [CRITICAL]/[MAJOR]/[MINOR]; logic faults first; no counts, no page numbers.
10. Nothing after the critique.

The retell (`arc-retell.txt`) uses the same sections 1-8, then COMMITTED ARC + PANEL SOLUTIONS, then
the output list in (c).

---

## (f) Test plan: Lab validation (cap: **$8 total**)

Run **after** implementation is on staging; the new parser is required. Deploy check first: poll
`/api/health` for the commit SHA (memory `feedback_verify_deploy_before_validation`).

**Commissions (staging stories with stored `arcReviewReport`):**
| Story | Shape | Why |
|---|---|---|
| `job_1790277448294_5herh01j7` | adventure/dragon, 1st-grade, 18 p, 4 boys aged 5/3/3/3, de-ch | the owner's commission; central figure; each-child-acts; tries-or-journey band |
| `job_1790107559778_fcmlfa8kn` | life-challenge/screen-time, advanced, 10 p, ages 14/12/7, de-ch | life-skill payload (T8); no creature; standard budgets; the inside/outside case (ARC_PLACE_RULE origin) |
| `job_1789420511893_zly5rcdej` | adventure/pirate, standard, 16 p, 5 cast incl. 3 adults (4/7/38/36/68), de | adults in the cast (T7 adult rule); premise figures; a rival/opposition shape |

**Stage and config:** `arc_effort`, one experiment per story, production settings:
```json
{ "stage": "pipeline", "model": "claude-opus", "createEffort": "max", "retellEfforts": "medium",
  "judgeModels": "claude-sonnet,grok-4.6", "challengesFromStory": true, "baselineFromStory": true }
```
Two small Lab additions, built with the implementation:
- `challengesFromStory`: lift the `# CHALLENGE IDEAS` section out of the stored `arcReviewReport.createPrompt` and pass it as `challengeIdeas`, so the new arc sees the SAME draw the old one did. Without it the draw differs and the comparison has two variables. (`promptFrom` cannot serve: its template-prefix check fails by design once the template changes.)
- `baselineFromStory`: score the stored `arcReviewReport.finalArc` (and the committed create arc) with the same judges and the same judge context, so old and new get one ruler.

**How the old arcs are retrieved:** staging `stories.data->'arcReviewReport'` for each story:
`create` (both arcs + critiques), `committed` + `committedArc`, `discarded`, `finalArc`, `critique`,
`rounds[].panel[].text` (what the panel caught), `rounds[].finalArc`. Dump them with the one-liner
pattern (memory `reference_db_direct_access`) into the scratchpad before the runs.

**Read, per story (owner-facing, side by side):**
1. The logic block: are want, stakes, deadline, opposition motive and the "why now" link present and true to the arc?
2. The critique's LOGIC line vs the panel's findings: how many panel findings the creator's own logic check already caught (old: panel finds that the creator missed).
3. Judge mean, new vs baseline, same judges (noise band ±0.3 from Lab #1375/#1416).
4. The code counts (d1-d4): chain links, sentence count, `(new)` figures vs allowance.
5. Cost and visible tokens of the create arm (old create at max: $1.37 on #1375).
6. Regressions to look for: a lost low point, an adult solving it, the life-skill payload gone, sizes as comparisons, a toddler-band chain of 5+ links.

**Budget:** per story ≈ create at max $1.0-1.4 + panel $0.10 + retell at medium $0.20-0.30 + judges
(3 arcs × 2) ≈ $0.10 → **≈ $1.5-1.9**; three stories **≈ $4.5-5.7**. Headroom stays under $8.
**Burn-loop stop:** if the first story's create fails to parse on both attempts, stop. No second
story until the parser or prompt is fixed on stored output (rung 1: replay the parser over the
stored raw reply, free).

Rung 0 before any paid call (free): run the new parser over the Lab reply fixtures and a
hand-written sample; build the new prompt for all three stories and `diff` it against the stored
`createPrompt` to confirm the cuts are exactly the ones in (b).

After the runs: `docs/decisions.md` entry citing the three experiment ids; `tasks/verify.json`
entry (claim: "one logic-first arc holds judge score and catches its own logic faults", runShape
arc_effort pipeline ×3, check: judge mean ≥ baseline − 0.3 on 2 of 3 and the panel-caught-only
count falls).

---

## (g) Risks, and what this reverses

**docs/SETTLED.md: no conflict.** It holds no line on the arc, its budgets, the figure lists or
the two-arc commit (`grep -n arc docs/SETTLED.md` matches only unrelated words), and
`scripts/admin/check-settled.js` guards no arc string. No reversal protocol is triggered. The
decisions.md entries below still need superseding entries (CLAUDE.md "Log every architectural
decision").

**docs/decisions.md entries this reverses or amends:**
- R1 **2026-08-30 "The arc stage is the ARC MACHINE"** (l.31614): "Two arcs + forced commitment make the self-critique material instead of ceremonial." Reversed by owner order. The risk it named (a ceremonial self-critique) is answered by the LOGIC check against a written block; test (f) item 2 measures it.
- R2 **2026-09-05 "Arc budgets are computed, not asked for"** (l.35518): "the critique counts events vs the budget (exceeding = MAJOR, cut whole events never compress)". Reversed; the event budget becomes the code-computed chain length (D3).
- R3 **2026-09-07 "The arc budgets ACTIONS, not just events"** (l.39240): "Nothing in the pipeline counted the unit that costs words." The action shape leaves the arc. The page plan counts actions per picture (Q9) and the word counter per page, but that entry notes that `story-beats` one-action rules "constrain the **picture** only; the beat keeps every action". **Live risk**: an arc sentence dense with actions can still overload a page's text. Watch the word-budget findings on the first real run; if they rise, the page-plan stage takes the action shape (owner item 3: "or moves to the page-plan stage").
- R4 **2026-09-09 "The arc ENUMERATES the figures it invented; code re-counts the list and may force one more round"** (l.40370). D1-A amends it (the enumeration moves from the critique into FACTS, and the code re-count and forced round stay); D1-B reverses it.
- R5 **2026-09-05 "Arc critique gains agency, fidelity, theme and plant/payoff dimensions"** (l.35521): "central figure acts in every third (passive stretch = MAJOR)". The per-third check moves to code and the plan (d4); fidelity, theme and plant/payoff stay.
- R6 **Surplus-facts check** (code comment `promptBuilders.js:~8290`, job_1789147573901: backstory packed into one speech). Dropped from the arc; nothing downstream checks it. Watch it on the dragon rerun; if it recurs, it belongs as a plan-check question.
- R7 **2026-09-23 "Sizes and looks leave the arc and the plan: one SIZE_LOOK_RULE for arc, plan and prose"** (l.59004): "ONE string, in `{TELLING_RULES}` (arc-create and arc-retell)". D7-move partially reverses the arc reach; the plan and prose halves stay. The owner may prefer KEEP.
- R8 **2026-09-19 critique-spec design** (code record, `promptBuilders.js:9250-9280`): "The counts now report in their own block and the budget belongs to story faults alone". Superseded; the counts block is gone and the 3-6 fault budget stays.
- Kept, no conflict: 2026-09-07 "RULES OF THE TELLING are band-conditional" (the simple-band variants stay); 2026-09-14 life-skill strategy in the arc (T8 kept); 2026-09-24 inside/outside (T28 kept); 2026-08-30 refinements 1-3 (Fixing/Keeping, severity tags, character-truth faults stay); 2026-09-23 arc create `max` / retell `medium` (unchanged).

**Other risks:**
- **Trial sibling:** `buildStoryShapeSection({arc:true})` and `buildAgeModeSection` are shared with the trial writer. The plan leaves both builders untouched (the arc passes `bandView:'premise'`). Gate 9 will still ask; `Siblings-Checked:` must say why the trial is unaffected.
- **Old stored stories** keep `committedArc` / `discarded` / two-arc `create`. The dev panel and `arc_panel_replay` must read both shapes. This is not a fallback: the data is stored in the old shape and cannot be migrated, so it is a named read-compat constraint (CLAUDE.md "NO FALLBACKS" exception).
- **Numbered lines leaking:** a numbered chain in the logic block would be read by `arcActSpans` and `critiqueMaxSeverity`. The contract is dash lines only, pinned by a parser test.
- **Cost:** one arc at `max` spends thinking on one story instead of two. Expect the create cost to fall; test (f) item 5 measures it.
- **Loss of choice:** two arcs gave a fallback candidate when one was weak. With one arc, the panel + re-tell is the only correction, so round 1 must be sound. This is the main quality risk, and test (f) exists to measure it.

---

## Implementation outline (after D1-D7 are answered; not started)

- [x] Parser + builder: `parseArcCreate` (one arc), `parseStoryLogic`, `parseArcRetell` (+logic), `arcChainRange`, new `arcCritiqueSpec`, trimmed `buildTellingRulesSection`, `ARC_LOGIC_CHECK` constant; delete `buildArcBudgetSection` from the arc builders (keep `arcInventedAllowance`, `EVENT_BUDGETS`).
- [x] Templates: arc-create, arc-retell, arc-panel, arc-hints (one commit, gate 9 sets `arc-generator-vs-critic`, `character-source-claim`, `commissioned-cast-arc-vs-plan-counters`).
- [x] beatsPipeline: create parse, report fields, d1/d2 warnings, d3 per D1.
- [x] planCounters + plan-check Q12 (d4), `beats-planner-vs-plan-check` sync.
- [x] storyScorecard judge context; Lab `challengesFromStory` / `baselineFromStory` + client label.
- [x] Client dev panel + `ArcReviewReport` type (reads both shapes).
- [x] Rewrite the 30 unit tests (behaviour, not wording); full suite green.
- [x] Rung 0 (free): new create/retell/panel/hints prompts built from the stored inputs of job_1790277448294_5herh01j7, no unfilled placeholder; parser run on hand-written replies.
- [ ] Staging deploy → Lab (f) under the $8 cap → owner reads side by side (`tasks/verify.json` `arc-logic-first`).
- [x] decisions.md superseding entries R1-R8; prompt-inventory; registry reason texts; memory `project_invented_cast_enumeration`.

---

## Review (2026-09-24, implementation)

Built as planned, with these calls the plan left open:
- **Chain length** = the band event range + 1 (the last "why it works now" link). Journey at 18
  pages gives 5-6, the owner's anchor; a flat-budget toddler band gives 2 (the plan's "3-4 for a
  toddler book" example does not follow from `EVENT_BUDGETS` and was not used).
- **Parse strictness:** `parseStoryLogic` throws on no heading, no tagged figure line, no
  "Central figure:" line, or no chain link. A numbered chain link is still counted (the block never
  enters `finalArc`, so it cannot reach `arcActSpans`).
- **Central figure names:** the arc gives one or two names ("the egg / Kachel"); presence per third is
  read from the plan check's roster people/things/covers, a name matching whole or as whole words
  inside an entry, never the reverse.
- **"therefore or but"** moved from the rules into the ARC line of the template and the chain spec.
- **Old stored stories** (two-arc `committed`, `committedArc`, `discarded`) are read by the dev panel
  and by the Lab (`storedCommittedArc`) as a named read-compat constraint; the pipeline writes only
  the new shape.
- **Sizes (rung 0, dragon run 7 inputs):** create 35,864 → 31,317 chars like for like (23,022 + the
  8,295-char landmark block the story row does not store), retell fixed text 29,178 → 24,995,
  panel fixed text 9,010 → 8,553, hints +1.8k (the logic block).
