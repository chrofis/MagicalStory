# Quality / cost suggestions from the Janna books review (2026-11-08)

Owner picked all 10 (2026-11-08). The review is in the session scratchpad (quality-review.html). Facts come from
the three Janna books plus the verse Laternen run (staging job_1794128424739_0j933o99i5u).
Testing rule (owner 2026-11-08: "Test everything first", "Always A/B test with existing stories to prove a change is better"): for every suggestion, A (current) vs B (proposed) on the SAME >=20 stored stories, per story plus the rate. Free replays/stand-ins first; paid only with a price and a yes. Nothing is built until B wins.

Order: #1+#3 -> #4+#5 -> #6,#7,#10 -> #2,#8,#9 (at most 2 agents at a time).

- [ ] 1. The hero is drawn on every page where the text is about her. The people-free page and the solo-friend pages never take the hero's acting pages. A missing-name finding from the plan check is no longer dropped (planCounters.js:996-1011). Test: counters over >=30 stored plans, rate of hero-missing acting pages before and after.
- [ ] 2. A stronger model for the page plan (Sonnet instead of Haiku, about USD +0.08). Test: stand-in plans on 20 stored arcs, then a Lab beats stage on 10 stories (about USD 1, ask first).
- [ ] 3. One strong story-logic read of the FINAL text (who removes the obstacle, stakes, who-knows-what, continuity, early/late contradictions, friends unkind for no reason), then one fix round. Test: positives = the 3 Janna books + 9 Laternen hand-fixed faults; negatives = 20 clean stored stories. Recall and false-alarm rate, stand-ins first.
- [ ] 4. The book review judges pictures against the final page TEXT; "absent by design" does not cover the hero or acting figures; hidden features and height order are checked. Test: replay on 3 Janna + 17 clean books (about USD 3, ask first).
- [ ] 5. Book review 3 rounds -> 2 (saves about USD 0.25 per book). Test: stored final-check reports, how often round 3 found something new and how often round-2 repairs were kept.
- [ ] 6. The arc must not give the ending to the friends (EVERY_CHILD_ACTS_RULE; a second retell round when the panel finds "a friend resolves it"). Test: 44 labelled stored arcs, stand-ins.
- [ ] 7. Stakes and motives count as owed for the text checkers (LOAD_BEARING_RULE / buildOwedFacts; same rule as the writer's MUST SAY). Test: 20 stored texts, with and without the stakes said.
- [ ] 8. Fewer text passes: measure what each of the 5 passes fixes or breaks. Test: stored pass reports over 20 runs.
- [ ] 9. Drop calls whose findings never survive (per panelist, brief re-ask). Test: survival share from the stored reports.
- [ ] 10. One source for the height order, on every page with 2+ children; the eval stops saying "never deduct for height order". Test: rebuild image prompts for 20 stored multi-child stories, count missing or contradicting orders.

## Results
(filled in as each test reports)
- 2026-11-08, test B (stored data, USD 0; evals/runs/2026-11-08_quality-tests-B/REPORT.md):
  - #5 NO-GO: round 2 removes about 0.9 faults per story for about USD 0.35. Idea: a confirm-only final review.
  - #8 NO-GO on cutting passes: the audits barely overlap; refine is the source of faults.
  - #9 NO-GO on panel and brief re-ask (both change results); GO (small) on capping the plan re-plan at one round.
  - #10 NO-GO on photo-age order: it fixes the 28% contradiction but writes the wrong Janna order. Owner decision open at customer-height-edits-2026-11-06.md:77.
- 2026-11-08, test C, #3 (stand-in, USD 0; evals/runs/2026-11-08_quality-tests-C/REPORT.md):
  - Recall on 18 known faults: B 6 caught + 5 partial, A 0 + 2. On 22 negatives B found 13 real faults (23%) at 11% false alarm.
  - B misses the obstacle and stakes faults (0 of 6) and rates the known faults MINOR.
  - Next step: a paid real-model A/B, about $3 Opus or $1.6 Sonnet, owner to approve.
- 2026-11-08, test D, #4 (stand-in, USD 0; evals/runs/2026-11-08_quality-tests-D/REPORT.md):
  - B as written is NO-GO: 6 + 2 of 11 known faults vs A 3 + 1, but 84% of flags on clean books are not real.
  - The hidden-feature and height questions add nothing.
  - A narrowed actors rule (touches, holds or does the main event) showed 0 false alarms on re-grading. A paid A/B would cost about USD 8.80; owner to approve.
- 2026-11-08, test A (stand-ins, USD 0; evals/runs/2026-11-08_quality-tests-A/REPORT.md):
  - #1: the hero is missing from her own moment in 58% of stories; 20 of 23 such pages are quota pages. GO on keeping plan-check claims that name the main character (3-4 of 5 right). The hero rule needs a quota change (owner).
  - #2: Sonnet planner lowers key-page misses from 4 to 1 but not the total. NO-GO for now.
  - #6: the proposed wording is worse (2/8 vs 6/8). NO-GO.
  - #7: already shipped; stand-in A/B confirms (stakes recall 0 → 6/10, motives 0 → 8/9).

## Owner decisions 2026-11-08 (after the tests)
- Build (a) keep plan-check claims that name the main character, and (b) cap the re-plan at one round: approved; a Sonnet code agent is on it.
- Paid real-model A/B of the text logic read (#3) and the narrowed picture-vs-text check (#4), on Opus and Sonnet: approved, hard cap USD 20, running in the Test Lab.
  - Owner, later: "No less stories, try to get under 10.-". Total cap CHF 10 ≈ USD 11 across all paid tests (USD 9.50 for the text/picture test, about 1.20 for the planner test). Keep the full book sets.
- Page quotas, test both changes A/B on stored plans:
  - The people-free page goes in longer books only; in short books it is optional or dropped. Owner: "4 char and 10 pages leaves no space for empty page sometimes."
  - A friend's solo picture may include the hero when the friend acts for her.
  - Cut-off to measure: the page count, plus pages per cast member.
- [x] (a) + (b) built in 3f81cbb55. 4 new unit tests plus 99 plan tests pass. Stored replay: main-character claims now kept on 7 pages in 5 stories (4 unique), USD 0. Not pushed. Open: typedPlan.js:384 has its own 2-round re-plan for code findings; untouched, no evidence yet.
- 2026-11-08, test F, page quotas (stand-in, not blind, USD 0; evals/runs/2026-11-08_quality-tests-F/):
  - Cut-off: people-free page REQUIRED at 18+ pages and pages ≥ 4 × cast, OPTIONAL at 14-17 pages, NONE under 14.
  - Under 18 pages, 8 of 10 people-free pages took the hero's moment.
  - A/B on 12 arcs:
    - hero-moment pages without the hero: 14 shipped (A) vs 0 (B), key pages 7 vs 0;
    - people-free page on someone's moment: 9/9 vs 0/1;
    - must-fix findings: 15 vs 6.
  - The focal counter must also count a friend page with the hero in frame (else 16 friends lack a focal page).
  - The draft change and its siblings are in the agent's report (typed plan, plan-check Q6, reviewPlanChanges, beatsPipeline:958).
  - Next: confirm with the production planner in the Lab (B prompt override; counters in the wrapper script) before building.
- 2026-11-08, test E, paid real-model Lab (evals/runs/2026-11-08_quality-tests-E/REPORT.md; exps 1817-1837). Spent USD 11.30, over the new cap: the cap arrived after the Opus picture arms had finished; the Sonnet picture arms were aborted at USD 0.61.
  - #3 text logic read, 16 staging books:
    - Sonnet: 3 of the 6 known faults still in the text, 9 of 10 negative faults, 6% false alarms, USD 0.12 per book (about 0.04 text-only).
    - Opus: about the same recall, USD 0.21 per book.
    - Known faults still rate mostly MINOR.
    - GO for Sonnet, once severity is calibrated and a text-only route is built. NO-GO for Opus on cost.
  - #4 narrowed picture rule, Opus, 12 books: no extra recall (1 of 3 = A), more arguable flags, and a route-tag bug in the B prompt. NO-GO. Sonnet not run.
- Owner 2026-11-08 after test E:
  - Planner Lab test approved (about USD 1.20; today's total about 12.50).
  - Logic read: build a text-only Sonnet read, tune what counts as MAJOR, test free on stored books with stand-ins, then ask before one cheap real-model check.
  - The build waits for the quota agent: both may touch beatsPipeline.js, and only one code agent works per area.
- 2026-11-08: the quota tiers + friend focal rule are built (cc47ffdd9). Full unit suite passes; free replay: must-fix 15 → 7.
  - The staging push was blocked by the sibling gate (typedPlan.js keeps the old focal rule); an agent is syncing it.
  - The 4 prod-only books were copied to staging for the planner Lab test (ve47ncy55, wpz3fzwyy, 6429d0n83, 79n8x82wd).
  - The text-only logic read is being built by a Sonnet agent.
- 2026-11-08: pushed to staging (8bf3253ba). The sibling vouch commit explains why the flagged sets need no change. Next: the Lab beats_replan planFresh on the 12 stored stories (B), compared with the stored plans (A). Approved at about USD 1.20.
- 2026-11-08: text-only logic read built (bc38138de, not pushed).
  - Runs after the lector; Sonnet 5.5, text only; one fix round on MAJOR through runPostAuditTextRound. Trial excluded (decisions.md).
  - New writer rule FRIEND_REASON_RULE shared with the read.
  - Units: 9928 pass.
  - Stand-in A/B, 16 books: 0 false alarms, 9 of 9 MAJORs real (Lab Sonnet: 2 of 16 real faults MAJOR). Recall can't be judged (the stand-in is weaker and not blind on the positives).
  - Pending: real-model check, about USD 1 for 16 books, owner to approve. The push waits until Lab 1839 finishes.
