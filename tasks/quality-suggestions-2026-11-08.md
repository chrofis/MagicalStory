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
