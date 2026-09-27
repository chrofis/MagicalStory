# Jev decision layer — build plan (2026-09-27)

Owner approval 2026-09-27 (AskUserQuestion, framed as reversals of the SETTLED lines below):
wire the Jev decision layer into the beats pipeline — Jev decides, code verifies and writes,
the LLM only executes. Measured basis: docs/decisions.md 2026-09-27 "Jev as the plan's
DECISION layer" and "Jev picks the shot, code holds the budget".

Architecture: ONE module `server/lib/jevDecisions.js` (call helper = `jevAudit.callJev`,
bounded pool, cost via `providerUsage.openRouterUsage` + `direct_cost` into the job's usage
sink under `jev_decisions`, latency per call), every decision stored in `stories.data.jevDecisions`
(per page) so a run can be replayed. NO FALLBACKS: a Jev failure after bounded retries of
transient HTTP errors (the evals' own retry: 429/5xx/network, 3 attempts) throws
`JevDecisionError` and the story fails loudly — the re-plan's catch-all "first division ships"
rethrows it.

Where each decision runs (the text does not exist until after the scene review, and the Visual
Bible is authored by the Art Director in the same call as the briefs):

| Decision | When | State | Written by code into |
|---|---|---|---|
| group-page ranking + who to cut (Part 2) | inside `runReplanRounds`, each round whose check carries GROUP_PAGES_OVER_BUDGET | arc + plan (page marked) | the who column of the cut pages; the re-planner rewrites only instant + after |
| shot (Part 1) | after the re-plan, on the shipped division (head count = the shipped check's `present`) | arc + stripped plan (page marked) | field 0 of every plan line |
| timeOfDay, indoor (+ weather advisory) (Part 4) | start of `runArtDirector` | arc + plan (page marked) | a FIXED line under each PLAN the AD copies; pinned into the brief after the AD and after the review |
| VB membership per page (Part 3), aboard, population per location (Part 4) | end of `runArtDirector` (needs the AD's bible) | arc + plan + element / location | brief `objects[]` (non-LOC), `aboard`, `population`; the element's bible `pages`; review told via `jev_fixed_field` findings; re-pinned after the review |

## Settled lines / decisions this reverses (owner sign-off 2026-09-27)
- [x] SETTLED "VB element budget … PROMPT rule … do not re-add a code enforcer" → code keeps the top-P elements within `VB_ELEMENT_BUDGET`.
- [x] SETTLED "A page's time of day and weather are its brief's fields" + "`population` is read only from the brief" → the field principle stays, the AUTHOR of timeOfDay / population / aboard / cited elements moves to Jev + code (weather stays with the AD, Jev advisory).
- [x] SETTLED "Eval judges run at temperature 0" → cannot hold for Jev (no temperature knob); replaced by measured flip rates and 3-call averaging on the cut decisions.
- [x] The planner authors shot words (story-beats.txt item 5 + SHOT_DISTRIBUTION; planCounters shot counters; plan-check Q14) → code writes the shot word.
- [x] planCounters 8c / memory "AD trims cast by design" / "which of them keep their group is the story's call, so the re-plan chooses" → Jev + code choose.
- [x] decisions.md superseding entries written as each part lands; SETTLED lines updated.

## Part 1 — SHOTS
- [x] jevDecisions: A1 questions verbatim from eval-jev-shot-budget.js (SHOTS definitions + OTS_NO_CONTACT_RULE), `pageState`, `assign()`/`hungarian`/`budgetOf`/`violations` MOVED into the module; the eval script imports them (one copy).
- [x] `runReplanRounds` returns the check of the division that ships; `decideShots` reads its `castPerPage` (planCounters `present`); no roster → throw.
- [x] Code writes field 0 (`applyShots`); pagePlan rebuilt; prod + Lab beats_replan call the same `finalizePlanShots`.
- [x] Planner: field 0 is the literal placeholder `SHOT` (one constant); item 5, SHOT_DISTRIBUTION, the camera-position / OTS / low-angle / "looks INTO it" / close-up-waist sentences removed.
- [x] Delete SHOT_VARIETY, SHOT_MEDIUM_WIDE_EXCESS, SHOT_*_COUNT, SHOT_NO_CAMERA_POSITION, SHOT_CLOSEUP_BELOW_WAIST, CONSECUTIVE_SAME_SHOT_CAST counters, their exempt/must-fix entries, plan-check Q14, shotDistributionPhrase / SHOT_FLOOR_CODE; focal "close-up named first" clause (no shot exists at check time).
- [x] Kept where still needed: OTS contact, close-up below waist, low angle over a child — in the A1 definitions and the AD / iterate templates (unchanged).
- [x] Tests; replay on stored books: 0 violations, clean assignment.

## Part 2 — CAST CUTS ON GROUP PAGES
- [x] `decideGroupCuts`: TOGETHER ranking (keep top `budget`), NEEDED per character (3 calls averaged), cut < 0.5, restore highest-P for: obstacle holder, main character / central figure on their focal pages, coverage floor; then trim to ≤ 3 lowest-P non-mandatory; unsatisfiable → page keeps its group, reported.
- [x] runReplanRounds: the GROUP finding is replaced by one CAST CUT instruction per page; code writes the who column after the reply; a returned instant / after naming a removed character → that page REJECTED (error logged, standing page kept, finding survives); code cuts are declared removals for castLostByReplan / review.
- [x] RE-DIVIDE text: the who column of a CAST CUT page is code's; rewrite only instant + after.
- [x] Tests; replay dka3jpog9: budget met, coverage intact.

## Part 3 — VB CITATIONS PER PAGE
- [x] `decideVbMembership` per page: creatures 0.7, vehicles 0.5, secondaries 0.5, objects 0.7 binding (0.5–0.7 kept only when the AD cited it — the measured band); clothing untouched (wearer, code).
- [x] Code: known ids only, dotted state for the page, budget top-P, writes `objects[]` + element `pages` + transcript sync; `jev_fixed_field` findings to the review; re-pin after the review.
- [x] plan_cast_uncited: delete if superseded.
- [x] Replay: dka3jpog9 p11 cites Sura.

## Part 4 — LIGHT + PLACE
- [x] `decideLight` (1 call per page: TIME choice, WEATHER choice advisory, INDOOR noul), enums, monotonic time (clock never runs backwards except across a new day — code rule stated in the module).
- [x] FIXED line into the AD plan blocks (both AD templates + per-page fallback); pinned after AD + review; weather `none` iff indoor.
- [x] `decideAboard` per page × vehicle (0.5); `decidePopulation` per location (PUBLIC/CROWD → code map).
- [x] Critics (semantic DECLARED LIGHT, plate LIGHT, population N-09) read the pinned brief fields — verify no change needed.
- [x] Replay: fog/night fields on the dragon book.

## Part 5 — GAZE (looksAt) — added mid-task by the coordinator (relayed owner approval 2026-09-27)
Measured e3c329da1 ("Gaze, depth, story relevance asked as fit", scripts/analysis/eval-jev-extra-fields.js): G2 128/139 vs AD 111/139.
- [x] Candidates in code (the eval's `gazeCandidates`): the other characters on the page, the VB elements the page cites (no clothing), creatures the plan line names and the page does not cite, `away`; + clothing an interaction row acts on (build note). No page text exists when the AD runs, so "objects the page text names" cannot be built at this stage.
- [x] One CHOICE per character ("In the instant of the page to judge, what are <X>'s eyes and hands on?"), one call per page, 3 calls with the choice probabilities averaged.
- [x] Code writes `looksAt`; pinned after the AD and the review; depth + storyRelevant stay with the AD.
- [x] Replay vs the jev-extra-fields-v1 reading labels; tests; decisions + SETTLED entry.

## Cross-cutting
- [x] Trial path: unchanged (trials run the unified pipeline, no plan) — decisions.md.
- [x] Lab parity: beats_replan / beats_scenes / scene_review_replay call the same functions; tests.
- [x] Jev failure rate measured on the replays; production risk flagged.
- [ ] Lab runs ≤ CHF 1.00 total; staging idle before each launch.
- [ ] FINAL: one full staging story (rerun-story-on-staging vnx5l8iy7 --regenerate-idea), verify-run --pull/--write, review page, per-page pixel review, compare dka3jpog9.

## Review (2026-09-27)
- Parts 1-2 pushed to staging (cb6a76538) and validated: replays (shots 0.935 / 0 violations; cuts 5/5 budget, 7/7) + Lab 1577 on the dragon book (budget met, p11 → Sura, 0 shot violations, $0.106).
- Parts 3-5 committed locally (334a49aef), replays done (creatures 31/31, objects recall 0.81 < AD 0.87, aboard 9/10, population 13/13, time 0.79 vs AD, gaze 124/139 vs AD 109/139). The staging push was REFUSED by a permission check — not deployed, so no Lab beats_scenes run and no full story run yet.
- Open: push Parts 3-5 (owner), Lab beats_scenes on dka3jpog9, the full staging story, verify-run --write.
