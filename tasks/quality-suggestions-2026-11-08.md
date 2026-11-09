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
- 2026-11-08, test G: real planner (Haiku 5.5 + luna check) in the Lab, exps 1838/1839, USD 0.98; scored in evals/runs/2026-11-08_quality-tests-G/.
  - A shipped vs B new quota:
    - hero-moment pages without the hero 14 → 7 (key pages 7 → 3);
    - people-free pages 9 → 1 (short books 8 → 0);
    - friends without a focal page 2 → 1;
    - must-fix 7 → 3 (same counter).
  - Regressions in 3 books: a friend's or adult's deed left unstaged (1tmyzh1do Polina, 79n8x82wd Henri), and an invented deed (k3c6 Marc).
  - Remaining pattern: an adult's or friend's "alone" deed page is cut out of the hero's own moment (7 pages).
  - Verdict: GO, with that gap as the next fix.
- [ ] Next fix: an adult's or friend's deed page must not take the main character's own moment (7 of 12 books affected after test G) → this file, test G
- Owner 2026-11-08: fix the adult/friend deed-page pattern first. Plan: free stand-in A/B on the same 12 books (test H) → build → one real planner Lab run (about USD 1) → production push asked separately.
- 2026-11-08, test H (stand-in, not blind, USD 0; evals/runs/2026-11-08_quality-tests-H/):
  - Root cause: the lead-page rule + one sentence per page. A supporting deed inside the hero's or another's sentence gets carved out, moved or invented; the noFocalFix text pushes re-plans the same way; Jev's decideGroupCuts dropped the main character on essb p3.
  - A (real test G) vs B (stand-in): hero-moment pages without the hero 7 → 0; deeds dropped/moved/invented 5 → 0. Real-model expectation about 7 → 3-4.
  - The 7-part change text is in the agent report.
  - Part 2 (two characters given one deed together may share a focal page) changes the owner's 2026-10-06 lead-page rule and needs the owner's yes.
  - Open, unlisted: k3c6, characters off-stage until the last sentence cannot reach the 3-page floor (arc vs page floor).
- Owner 2026-11-08 on the 2026-10-06 lead-page rule ("two characters never share a focal page"): "of course. Review this rule it sounds stupid."
  - Reviewed: its Revisit-if is met (the planner loses the hero's moments and invents deeds).
  - It is being replaced by DEED_SOURCE_RULE: a character's own page shows the deed the story gives them, on the page that tells it; joint deeds share; the hero is in frame when it is their moment.
  - A Sonnet build agent is on it, with a decisions entry that replaces the 10-06/10-07 entries. Next: staging deploy, then the planner Lab A/B on the same 12 books (about USD 1).
- 2026-11-08: deed-source rule BUILT (not pushed; docs/decisions.md "Deed-source rule replaces the lead-page rule"). LEAD_RULE deleted; MAIN_IN_FRAME_CLAUSE, DEED_SOURCE_RULE, MAIN_MOMENT_RULE, Q12 findings, noFocalFix, main exemption in alsoOnConflicts / castTablePromises, decideGroupCuts keeps the needed main character. Free replays: main character's "also on" pages kept 3 of 12 books (rejected 12 -> 9), counters otherwise unchanged; essbvehs8 p3 cut no longer removes Emma. Next: staging deploy, then the Lab planner A/B on the same 12 books (about USD 1).
- Owner 2026-11-08 on the final review: "An own review before pictures. But still have OPUS recheck the final logic. So that opus can decide, can I change the text or do I have to change the image, to make sense. The number one point of last review should be to catch such inconsistencies." Test with Opus agents in the console, not paid calls ("you have opus agents it should give same results").
  - Plan, test I: (1) an agent writes the B review prompt (CONSISTENCY as the first question; the smallest fix TEXT or IMG; "absent by design" never covers the main character or a figure whose act is the page event) and builds blind book packets; (2) two blind Opus agents answer A (today's prompt) and B; (3) grading.
  - The TEXT route already exists: storyJobPipeline.js ~5930 → runPostAuditTextRound.
  - Owner addition: the final review also answers "would a five-year-old enjoy it" and "would a parent buy it". Today this exists only in the idea prompts (generate-story-idea*.txt, "WHAT MAKES A PARENT BUY IT"). B adds typed VERDICT[ENJOY]/VERDICT[BUY] lines from one shared constant, with page fixes for WEAK/NO.
- 2026-11-08, test G2: deed-source rule (c3590467b) with the real planner, exp 1840, USD 1.07, scored in quality-tests-G/*-1840.*. A = exps 1838/1839.
  - Better: hero moment without the hero 7 → 3 (all 7 carved pages fixed); hero-absent pages 24 → 14.
  - Worse:
    - friends without a focal page 1 → 8;
    - must-fix 3 → 11;
    - deeds dropped 2 → 8;
    - a new climax page without Janna (0j933 p9).
  - Cause: Haiku reads the main-in-frame clause as "drop the adult's own beat", and "joint deeds share" clashes with the counter's focal definition.
  - Verdict: NO-GO. Staging currently runs it; production does not.
- Owner 2026-11-08: narrow the deed rule. Keep: the hero is never cut; moved or invented deeds are flagged. Make sure a friend's own deed is never removed.
  - Sequence: free stand-in test J → build → one more real planner run (about USD 1).
  - Burn-loop: this is the 2nd paid attempt at the deed fix; if it fails, stop and fall back to the run-1 page rules.
- 2026-11-08, test J: narrowed deed rule (stand-in, partly blind, USD 0; evals/runs/2026-11-08_quality-tests-J/).
  - Causes of the 8 drops: three sentences of c3590467b (the "never carved out ... take another action" tail, "the second takes another action", and "joint deeds share" used as an escape), plus a counter (isFocalPage) that never counts the last page as focal.
  - Results:

    | | A | 1840 | J |
    |---|---|---|---|
    | hero moment without the hero | 7 | 3 | 0 |
    | deeds dropped | 2 | 8 | 2 |
    | friends without a focal page | 1 | 8 | 0 |
    | must-fix | 3 | 7 | 4 (patched counter) |

  - Expected real: hero 1-3, drops 2-5.
  - GO. A Sonnet build agent is on it.
- 2026-11-08, test I: blind A/B of the final Opus review (Opus agent stand-ins, 16 staging books, USD 0; evals/runs/2026-11-08_quality-tests-I/).
  - Picture faults: A 3/12, B 4/12. Text-logic faults: A 0/18, B 2 + 1 partial.
  - B's CONSISTENCY question: 24 new findings, 13 real, 1 false alarm. TEXT routes 0 → 10.
  - Repair load +38% (MAJOR+ 2.6 → 3.6 per book).
  - The narrowed absent rule added nothing.
  - VERDICT ENJOY/BUY does not discriminate (16/16 and 15/16 YES, Janna originals included).
  - Verdict: conditional GO on CONSISTENCY, with fixes: MAJOR weighting for Q1 only; one line per inconsistency; route TEXT when the pictures agree. NO-GO on the VERDICT lines as written (rewording proposed: tie them to the faults, WEAK as the default).
  - Still missed by both arms: who removes the obstacle, stakes, who-knows-what (arc stage); b13 p9 wrong girl; the main character absent on her action pages.
  - Owner 2026-11-08 on the verdicts: "it does not really matter, the question is what does it change, we do not use the rating for anything. Maybe ask the question different: what would you want different if you were a 5 year old kid. What would you want different if you were a parent. Or is there any show-stopper with the story for a 5 year old."
    → Prompt D: drop the ENJOY/BUY ratings. Ask (1) as a five-year-old, what would you want different; (2) as a parent; (3) any show-stopper for a five-year-old. Every answer becomes a normal FAULT line with a fix (TEXT or IMG); show-stoppers are CRITICAL.
    → Retest free with blind Opus agents on the same 16 books after the C grading.
- 2026-11-08, test G3: narrowed deed rule (f40226f46), real planner exp 1841, USD 0.96.

  | | A | 1840 | 1841 |
  |---|---|---|---|
  | hero moment without the main | 7 | 3 | 2 |
  | deeds dropped | 2 | 8 | 9 |
  | friends without a focal page | 1 | 4 | 2 |
  | must-fix | 3 | 7 | 6 |
  | invented | 1 | 1 | 2 |

  - 6 of the 8 1840 drops were fixed, but 7 new ones appeared.
  - NO-GO. Burn-loop: two paid attempts failed, so stop. No third run without the owner.
  - Staging runs f40226f46 now; production has none of the planner changes.
- 2026-11-09: owner chose "Revert to quota tiers".
  - Commit 6d6c90d17 reverts c3590467b and f40226f46; staging is deployed.
  - Kept: Jev's group cut never removes a needed main character (tests/unit/jev-main-needed-keep-2026-11-08.test.ts).
  - Decision entry: decisions.md 2026-11-09.
- 2026-11-09, test I arm C graded:
  - Consistency finds 18 real against 13 in B. 0% false.
  - Routing sensible on 22 of 22.
  - Recall drops: book13 p9 missed, about 28 per-page picture faults that B had.
  - ENJOY/BUY verdicts do not separate weak books from good ones (BUY WEAK on 16 of 16), so they are dropped.
- Arm D (scripts/build-prompt-d.js, prompt-D.txt):
  - C without the verdicts.
  - Adds the questions CHILD ("what would you want different"), PARENT and SHOW-STOPPER (CRITICAL). Each answer is a fault line.
  - IMG faults get one line per picture.
  - Two blind Opus stand-ins are running, USD 0.
- 2026-11-09, test I arm D graded (stand-in, USD 0):
  - 93 lines: 82 real, 10 arguable, 1 false.
  - Consistency: 26 real, 0 false.
  - Picture recall against B: lost ~20 (C lost ~28).
  - Listener questions 8–10: only 2 lines, 0 show-stoppers. The book13 price, the friend-made ending, p9, book04 p11 and book07 p13 are still missed by every arm.
  - Likely cause: "Where no change to one page would fix it, leave it out" lets whole-book gaps drop.
  - Grader's edit: put a whole-book gap on the page where the danger or the character first appears.
  - Next: a real-Opus check, edited D vs A on book13/05/06/04/07, about USD 1.5, owner's yes needed.
  - The friend-made ending is an arc-stage fault (suggestion #6), not a review fix.
- 2026-11-09, arm D2 (whole-book gaps go on the page where the danger or character first appears), stand-ins, USD 0:
  - Totals: 111 lines (D 93); text fixes 19 (D 8); 0 CRITICAL.
  - Price-of-failing lines now in 5 books: 01, 03, 06, 09, 13.
  - Book13: price at p5, friends react to the unicorn at p9, and the empty-square p9 picture is caught. Each is missed by A/B/C/D.
  - Book15: a water-safety line.
  - Still missed: friends end the problem in book13 (arc stage).
  - Not yet graded line by line for false alarms.
- 2026-11-09, real-Opus check, exps 1842 (A, today's prompt) and 1843 (D3), books 13/06/04/15/09. USD 2.48, over the USD 2 cap (estimate was 1.5).
  - D3 is INVALID: the per-book placeholders were not filled for the Lab override. MAIN_CHARACTERS, LOGIC_* and BUY_CRITERION were stripped, so D3 ran without its logic rules, main-character list or child-question lens. The stand-in packets had them pre-filled by build-packets.js; my runner did not.
  - Arm A is valid: its template has none of those placeholders. Its warnings come from D3's concurrent run; the Lab log capture is time-windowed, a small Lab issue.
  - A gave 0 TEXT lines on all 5 books, the same as the stand-in arm A.
  - Rerun of D3 only, with per-book pre-filled overrides (5 experiments): about USD 1.30. Waiting for the owner.
- 2026-11-09, real-Opus D3 rerun, filled per book: exps 1844 (book13), 1845 (book06), 1846 (book15). Cost USD 0.80, cap 1.50.
  - The real-Opus check cost USD 3.28 in total, including the invalid 1843.

  | | A, text | D3, text | D3 text catches | lost against A |
  |---|---|---|---|---|
  | book13 | 0 | 2 | friends react to the unicorn (T2) | p9 empty-square ring |
  | book06 | 0 | 2 | price of failing (T6), walk back to the farm | none |
  | book15 | 0 | 4 | Serena, Mamma p9 and p25, p24 who-is-present | p9 grotto coherence, p1 heights |

  - Not caught by real D3: the book13 price of failing (the stand-ins did catch it).
  - No noise lines: no natel, no "shorten", no invented lore.
  - The Lab genericity warning ("The main character is: Janna") comes from the per-book pre-fill. In production the name comes from the placeholder.
- 2026-11-09: D3 built in 0d3a10bbe (bookAuditStoryFill; mainCharactersText and logicReadQuestions single-sourced). 896 test files pass; fill replay ALL OK on books 13/06/15.
- 2026-11-09, replay of the real post-audit text round (runPostAuditTextRound) with D3's TEXT faults, staging key. USD 0.20; check total USD 3.48. Script: evals/runs/2026-11-09_post-audit-text-replay.
  - Rubi: both fixes applied (price of failing p5, walk back to the farm p10).
    - p5 now reads clumsily: two «...», dachte Janna sentences in a row.
  - Laternen (stored text is verse): both fixes were made, but the refiner recomposed the couplets (64%/65% of words changed). The edit cap threw both pages back, so 0 fixes shipped, and only a warn was logged. This is pre-existing (any TEXT fix on a verse page), but D3 sends more TEXT fixes, so it matters more now. Owner decision needed.
- 2026-11-09: owner reversed the 30% edit cap: "Why not rewrite the whole page ... raise limit. But add some retest if major change was done." a64e99992 (not pushed yet): no size reject; a page over 30% triggers one whole-book logic read on the post-audit round.
- Replay on the new code, USD 0.26 (check total USD 3.74). v2-*.json; v1/ holds the capped run.
  - Laternen: both fixes ship (68% / 63%). The retest ran: 8 MINOR, 0 MAJOR, no fix round.
    - Defect: the stored book is PROSE, but its topic is "educational / rhyming", so isVerseStory is true and the refiner turned p2 and p9 into verse inside a prose book. This is a legacy story made before verse; any old book with that topic is at risk.
  - Rubi: both fixes ship (31% / 42%). The retest ran: 3 MINOR.
    - Defect: the refiner INVENTED "seine Herde" (a herd; the story has none) on p5 and p10, and added «Danke, Rubi» unasked. The capped v1 run made the minimal fix. The logic read does not catch inventions.
- 2026-11-09: c9048214e added three things (not pushed):
  - NO_NEW_ELEMENT_RULE, shared by book-audit, the logic read and text-refine;
  - an ADDED question in the retest;
  - a typed textForm field (isVerseStory throws for a rhyming-topic record without it).
- Replay v3, USD 0.14 (check total USD 3.88):
  - All 4 fixes ship and are minimal: no herd, no unrequested line, and the Laternen prose stays prose. No page went over 30%, so the retest (and ADDED) did not fire; ADDED is unmeasured live.
- Staging backfill NOT run (the classifier blocked the DB write; it needs the owner):
  - prose: job_1793964466256_1tmyzh1do;
  - verse: job_1794128424739_0j933o99i5u.
- Production also needs a counted backfill before any prod push (decisions.md 2026-11-09).
