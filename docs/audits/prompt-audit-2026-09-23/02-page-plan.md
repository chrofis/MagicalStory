# 02 PAGE PLAN — judge findings (job_1790100385959_1nitlympp, "Das Ei im Laub", built at b03c64b0)

## Status 2026-09-23

Checked against staging `31fd7db0c` (after the evening fix round). FIXED = the commit that fixes it; OPEN = no fix yet, no ruling needed to start; OWNER CALL = touches a decision, a SETTLED line or has options the owner picks. Stale-doc and registry items listed at the end of each file were corrected in `a25ecb865` unless listed below.

- FIXED: W1 "(none" commissioned character — `86d6ff4a7`. W10 over-the-shoulder on a contact page was already fixed before the audit (`be213ec9a` / `50e150c21`).
- FIXED (page-plan audit commit `094052d45`, decisions.md "Page plan after prompt audit 02"): W2 the check reads the hints and Q13 asks page order / hint placement (the sentence anchors are the arc stage's, `f25a51f3f`); W3 (a) a noted finding cannot change a kept page (last page, WANTED, ACTION, only focal page) — review rule `protected`, and the one-level rule keeps the level the page's event happens on; W5 keep list in RE-DIVIDE, review rules `focal` / `action`, the previous round's refusals sent back; W6 roster `unlisted` → `CAST_NOT_IN_WHO_COLUMN`; W7 counters read `commissionedCast` and the one-string unnamed exemption `UNNAMED_FIGURE_EXEMPT` (the saved-details pet is the arc stage's `COMMISSIONED_CAST_DEF`); W8 acts are sentence thirds in code (`arcActSpans`) with WANTED lines; W9 tightened in the prompt only (deed made visible is the deed; a page named once); BLOAT the divider gets only the arc's landmarks (planner 31.0k → 24.9k); plan_recheck prompt, planner and re-plan raw replies stored. Every-child coverage (owner, `4b708f0cd` + this commit): `castCoverage()` / Q12.
- OPEN: W11 filler pages and the replan breaking a shot floor (no shot-change verb in the CHANGES vocabulary), W12 landmark vantage unchecked, W13 Q2 recall. Validation call: Q13 did not flag the old unanchored hint on p14 — re-check on the next run with anchored hints.
- OWNER CALL: W3 (b) TWO_HEIGHTS exemption for a flight (changes the 2026-09-10 Q10 ruling), W4 round 1 exempt from the discard test (doc gap or bug), W9 Q9 split and dropping advisory Q9 lines from the replan (2026-09-09 ruling), Q13 rank (added as noted).
- OWNER DECIDED 2026-09-23: two rules — every child acts in the arc; every child appears in enough images (target 3-4, scaled) with their action staged as a picture; affects the NO_FOCAL / UNDER_COVERED counters behind W5.

---

Stage group: beats_plan (sonnet-4-6) → plan_check (gpt-5.6-luna-pro) + planCounters → beats_replan r1 (sonnet-4-6) → plan_recheck (same builder, replanned PAGE_PLAN; rebuilt from `buildPlanCheckPrompt` promptBuilders.js:8922 + prompts/plan-check.txt — identical text to 03-plan_check.PROMPT.txt except the 18 plan lines, which equal `finalPagePlan` in 07). Only one re-plan round ran (round 1 did not converge → no round 2, beatsPipeline.js:1723-1735).

HEAD = 28 commits past b03c64b0. Relevant changes since: OTS_NO_CONTACT_RULE into story-beats.txt (be213ec9a / 50e150c21), aerial floor retired (147ce6a96). Nothing else in story-beats.txt / plan-check.txt / planCounters.js / the replan section changed. Each finding says whether HEAD already fixes it.

## Net outcome of the stage (what shipped, rawOutline lines 48-53, 93-108)

The book shipped the ROUND-1 re-plan, which by the pipeline's own count is WORSE than the first division, and which has no picture for three of the story's key moments:
- The nest / "you can be the warm wall" (arc sentence 16): the hero's own idea that turns the story. No page. Old p17 was overwritten with the hatching and its material went nowhere.
- Turi flying off with Flämmli (arc 18, the parting): no page. p18 now shows only Levin talking to Max and Kiaan.
- The huddle against Turi (arc 16/17): shown only on p14, which is BEFORE the egg is found on p15 (see W2).
- Julian, a co-lead, is off every page from 15 to 18. That includes the hatching, whose instant is about "Julian's sleeve".

---

## CONFIRMED BY THIS RUN'S OUTPUT (ranked)

### W1 [CRITICAL, code; not fixed at HEAD]: the premise-figure parser turns "(none — …" into a commissioned character called "(none"
- Arc create reply (01-arc/02-arc_create.RESPONSE.txt:27,82): `- (none — the premise supplies no named figure beyond Levin, Julian, Max, Kiaan)`.
- `parseFigureList` (promptBuilders.js ~8738-8756) splits on ` — ` → `"(none"`. `isNegativeFigureAnswer` strips a trailing parenthetical only when it is CLOSED, so `(none` gets through. Reproduced at HEAD without a paid call: `parsePremiseFigures(...)` → `{"names":["(none"]}`.
- Effect: `commissionedNames` (beatsPipeline.js:1277) contains "(none". Every check then raises `PLAN[NO_FOCAL_PAGE]: (none never has a focal page` and `PLAN[UNDER_COVERED_CHARACTER]: (none is in frame on 0 page(s)` (05 json, lines 8-9, and again in the recheck). These are two of the five MUST-FIX lines sent to the re-planner (06 prompt:271-272), and they count toward convergence. They can never be cleared, so the convergence test (`replanRoundConverged`) is biased against every round. This is a sibling of the 2026-09-17 fix for `- none (…)`, which handled only the closed-paren form. It belongs in tasks/bugs.json.

### W2 [MAJOR, prompt]: a hint was placed against the story's causal order and nothing checks page order
- Hint (01 prompt:39): "Let Julian eat one cooled Marroni **in the huddle before the shell knocks**".
- Plan p14: "Julian … eats it **in the huddle against Turi's warm side** while the others wait". This sits between the low point (p13) and the finding of the egg (p15). The huddle only exists after the nest (arc 16).
- The planner is told "Each page follows causally from the one before it" (story-beats.txt Requirements, first line). plan-check.txt has no order or causality question: the 2026-09-01 decision took STORY causality out of the beats layer. This fault, though, is made BY the division (a hint put on the wrong page), not by the arc. Neither the check nor the recheck saw it, and it shipped. The judge is also never shown the ARC_HINTS block, so it cannot tell that p14 is a hint whose anchor ("before the shell knocks") says where it belongs.
- Improve (generic): give plan-check one question: "Name every page whose instant stages a moment the story reaches only in a later sentence, or that depends on a thing a later page creates." Pass the hint block to the checker labelled "changes the division was asked to apply", so it can check where each hint was placed.

### W3 [MAJOR, prompt+code]: the re-planner acted on ADVISORY Q10 and deleted the ending's own event; the ALSO NOTED list has no protection
- 06 prompt:295 (ALSO NOTED): `CHECK[10]: Page 18: Turi is airborne while the boys remain below.`
- Re-plan (07:44-49): "Page 18: cast out Turi, Flämmli, Julian — CHECK[10] …". The departure flight, which is the parting the planner's own `ENDING_EVENT_DEF` names, is gone. The recheck then raises `8. Page 18 does not stage the ending's own event: Turi's goodbye flight` and `4. The ending's most wanted picture is Turi carrying Flämmli away` (08:36,55). No round 2 runs to answer them.
- Why it happened: Q10 is advisory by decision (docs/decisions.md 2026-09-10 "Two named characters at two heights", reason: "a forced repair has destroyed pages"). The replan prompt still hands every noted line over as something the planner may act on, with only "where a must-fix and a noted one pull opposite ways, the must-fix wins" (06:241). No must-fix line existed yet for the ending, so nothing protected it. `REPLAN_FINDING_DIRECTION` (planCounters.js:1077) has no entry for CHECK 4/8/10, so the removal was never reviewed by direction.
- Contradiction inside the planner prompt: "One level per picture … Two such characters do not share a frame" (01:206) against "the last page stages that event" (01:235) and "the arriving creature is in frame as itself" (01:217), when the event IS a flight or a landing next to the cast. The same TWO_HEIGHTS_DEF sits in both templates, so the generator and the critic agree with each other, and both are over-broad. p6 was also flagged for a dragon on a LOW wall above a sitting child (03 reply:39).
- Improve: (a) the replan section says: "A noted finding is answered only where the answer removes no event the story's sentences stage and no page's last event." (b) TWO_HEIGHTS_DEF exempts the page whose event IS the arrival or departure by air ("the flier's take-off or landing is one level with the ground it leaves"). (b) changes the settled Q10 rule, so it needs the SETTLED protocol and owner sign-off. It is not in SETTLED.md, but it is a decisions.md rule.

### W4 [MAJOR, code/decision mismatch; FIXED 2026-09-24 — replanRoundRegressed, see docs/decisions.md]: round 1 is kept even when it makes things worse
- `if (stillConverging.length >= bestMustFix && round > 1)` (beatsPipeline.js:1702): round 1 can never be discarded.
- This run, cast/focal must-fix before → after: 5 → 7. Before: NO_COMMISSIONED p13, NO_FOCAL Kiaan, NO_FOCAL "(none", UNDER_COVERED "(none", Q4 p17. After: NO_COMMISSIONED p13+17, NO_FOCAL Max, the two "(none" lines, Q4×2, Q8. The worse division shipped.
- docs/decisions.md 2026-09-20 ("convergence test counts CAST/FOCAL…") says "a round that raises the cast/focal count is discarded". The code exempts round 1 and no document explains why. It is either a doc gap or a bug. Ask the owner which.

### W5 [MAJOR, prompt]: the replan fixes by swapping, so every fix breaks something else
- NO_FOCAL Kiaan: answered by taking p5, Max's only focal page, away from him (07:8-12). The recheck then raises NO_FOCAL Max. Nia's introduction goes with it, so Nia's first appearance becomes p12 (recheck Q2, 08:30), and Max's naming is lost (recheck Q2 p4).
- Q4 p17 "hatching only stated afterward": answered by overwriting the nest page with the hatching. The nest, the hero's turn, is lost (recheck Q4 "middle's most wanted … shelter … no page", 08:35).
- The replan rule protects only "a character the division would leave with fewer than two pages" (06:244). It does not protect another character's only focal page, or the page a Q4/Q8 picture already sits on.
- Improve: add to the replan's "stay" list: "a character's only focal page, and any page whose instant is an event the story's sentences stage and no other page shows." Better: send the check's own Q4 answers (the three wanted pictures and their pages) into the replan as fixed points.

### W6 [MAJOR, generator↔critic gap]: the rule "the who column is the complete cast" is never checked, because the roster reads the who column only
- Planner rule (01:203): "Every person the instant stages … belongs in that field, or is not written into the instant at all."
- plan-check roster (03:61): "Read the WHO COLUMN ALONE: a figure named only in the instant … is not in frame". So a figure named in the instant but missing from the who column is invisible to every check.
- Violations in this run, none flagged:
  - Round-1 p5: `close-up — Max — … one hand on Nia's back, the dog's nose pressed to the large scale`. Nia is not in the who column.
  - Shipped p17: `Turi, Flämmli — … sneezes a small warm spark toward Julian's sleeve`. Julian is not listed.
  - p14: `Julian — … against Turi's warm side while the others wait`. Turi and "the others" are not listed.
- Improve: plan-check gets a question: "Name every page whose instant names a character (or their body part or garment) that the who column does not carry." This fits the 2026-09-20 who-column decision: the roster stays who-column-only, and this is a separate question.

### W7 [MAJOR, counter vs arc rule; not fixed]: invented-cast counters charge a profile pet and an unnamed parent against the allowance
- The arc budget rule (01-arc/01-arc_create.PROMPT.txt:250) says: "Not counted: anyone the commission named, including any animal or companion it supplied; … a figure given no name and referred to only by what it is." The arc applied it: "(Nia is supplied by the commissioned cast and is not counted; the mother dragon is unnamed.)" (02-arc_create.RESPONSE.txt:86).
- planCounters.js:834-857 charged both anyway: `ARC_INVENTED_UNDECLARED: their mother, Nia` and `ARC_INVENTED_OVER_ALLOWANCE: 4 … against 2`. Nia is in Max's saved profile ("Seine Hündin heisst Nia", 01:78). `commissionedNames` = `inputData.characters` + premise figures only (beatsPipeline.js:1277), so pets named in a profile are never counted as commissioned. "their mother" is an unnamed figure. Result: the re-planner removed the mother from p1, citing OVER_ALLOWANCE (07:4). That edit was harmless, but its reasoning was false.
- No sibling set in scripts/admin/sibling-registry.json pairs the arc counting rule with the plan counter. Add one.

### W8 [MAJOR, judge]: Q4 "most wanted picture" answers differ between the two calls, and it is a MUST-FIX check
- Check (03 reply:27): "the **middle's** most wanted picture, Flämmli hatching". The hatching is arc sentence 17 of 18, so it belongs to the ending, not the middle.
- Recheck on a plan where p1-16 are mostly unchanged (08:35-36): middle = the shelter, ending = the flight.
- Q4 is in `REPLAN_MUST_FIX_CHECKS {4,8}`, so an unstable answer drives forced edits. In this run it caused the nest-page overwrite (W5).
- Improve: Q4 answers each act with the arc SENTENCE NUMBER as well as the page, and the acts are fixed in code by sentence thirds (1-6, 7-12, 13-18 here). The model then only has to pick the picture inside each act.

### W9 [MINOR-MAJOR, judge noise]: Q9 fires on most of the book and nobody acts on it
- Round 1: 9 of 18 model findings are Q9. Recheck: 17 of 31. Examples: "Turi's puff and its useless smoky result together" (p7). The smoke IS the puff made visible, and the planner rule says "name its visible result instead" (01:207). Also "Julian pressing the bag … and the bag's resulting placement" (p8).
- The same page moves between Q9's two halves from one call to the next. p8 is "true-after repeats instant" in round 1 and "deed and effect together" in the recheck.
- By decision Q9 is advisory (2026-09-09 "Plan-check Q9 … stays advisory"). The replanner changed no Q9 page, yet the lines take 9 of 17 ALSO NOTED rows (≈1.1k of the 2.1k chars) in the replan prompt.
- Improve: split Q9 into 9a (deed + effect) and 9b (the fourth field states no change). 9a exempts an effect that is the deed's own visible form (smoke from a puff, steam thinning under the hands). The replan prompt could drop advisory Q9 lines from the replan section, or cap them. Changing what the planner sees is a decision for the owner.

### W10 [MINOR, prompt; FIXED at HEAD]: over-the-shoulder on a contact page
- p10: "over-the-shoulder — … one hand pressed to Turi's warm flank". This is the failure `OTS_NO_CONTACT_RULE` now forbids (story-beats.txt:36 `{OTS_NO_CONTACT}`, commit be213ec9a; shotVocabulary.js names this job).

### W11 [MINOR, prompt; partly fixed at HEAD]: the shot floors pushed the planner into filler pages, and the replan broke a floor
- p2 (ultra-wide walk up the hill): its after-field is "the Lindenhof is established as the place", which records no change. That is filler by the planner's own rule (01:196). Neither judge call flagged it under Q9-b, though both flagged p3.
- p3 (peopleless egg) is shot as a low-angle on a thing lying on the ground. The planner took two pages for arc sentence 2 and none for the hatching, which requirement line 230 names as the model peopleless subject.
- p12's aerial came from the floor. That floor is retired at HEAD (147ce6a96).
- The replan's p6 edit ("action out over-the-shoulder shot", 07:16; the CHANGES vocabulary has no shot-change verb, 06:308) left 1 OTS page against a floor of 2. The result was `SHOT_OTS_COUNT` after the recheck, shipped unfixed.
- "3 pages in total leave eye level" (01:194) reads as an exact count. The planner took 5. No counter caps it, and "keep the angled pages few" is all that is left.

### W12 [MINOR, prompt]: landmark vantage rule broken, and not checked
- The planner is told a hilltop skyline is not available unless a photo shows it (01:145). p2 has "the old rooftops of Zurich spread behind them" and p18 has "the Lindenhof rooftops of Zurich behind them". Lindenhof's photos are a medium town-square view and a riverside promenade. Nothing checks this: plan-check has no landmark question, and the judge is never shown the landmark photos.

### W13 [MINOR, judge recall]: Q2 misses in round 1
- Round-1 p4 stages Max and Kiaan (lifting) before any naming. Round-1 p5 names neither ("Nia and the scale are introduced"). Q2 said nothing. The recheck flagged the same p4, which the replan had not touched (08:29).
- Kiaan's replanned p5 after-field says "Kiaan is named", but the instant stages no naming. The planner puts the entrance in the after-field.

---

## MISSING (stage needs it / generator↔critic)

- **The critic never sees the hints.** ARC_HINTS goes into story-beats.txt but not plan-check.txt. Where a hint landed (W2) cannot be checked.
- **Unchecked creator rules** (the planner is told, no counter or Q checks): complete cast in the who column (W6); causal order of pages (W2); landmark vantage (W12); "a close-up is never the ground at the feet"; "never an exact count above two"; "never a pointing gesture"; "a deadline scored mid-book twice" (the deadline "warm before dark" is scored on p7/p9 only by implication); "the stake said aloud lands early, spoken". Several of these were cut from the checker on purpose (2026-09-01, 2026-09-03). The list of which ones are deliberately unchecked lives only across many decision entries. No single table exists.
- **Deductions the creator was not told:** none found. The shared DEFs keep Q2/Q8/Q9/Q10 aligned (sibling set `beats-planner-vs-plan-check`). Q6 (peopleless nomination) and Q11 (obstacles) have planner counterparts.
- **The replan does not get the check's Q4 answers** (which pictures and pages are the wanted ones), so it cannot protect them (W5).
- **Refusals are not sent back.** The code refused the re-planner's p13/p14 moves (07 changeRefusals: `direction`, `balance`) and restored the pages silently. MUST-FIX `NO_COMMISSIONED_ON_PAGE p13` therefore went unanswered, with no second chance inside the round.

## BLOAT (chars ≈)

Planner prompt 31.0k, replan 40.5k:
- **Input:** REAL LANDMARKS block ≈ 8.3k. This is a divide-only stage, and the arc had already chosen 2 landmarks (Lindenhof, Bahnhofstrasse), so the other 18 entries and their DESCRIPTIONs are unused. Its instruction text ("build at least two of them in, woven into the story's action … incorporate it authentically into your story") is an AUTHOR instruction that contradicts "divide it, never retell or repair it" (01:5). Keeping only the arc-named landmarks plus the vantage rule would save ≈7k.
- **Instruction:** the age-band hero's-journey block ≈ 2.4k of author permissions ("A real antagonist is allowed", "Humour and mild peril"). This is already recorded as PARKED (decisions.md 2026-09-19 "the beats planner receives 2,031 chars of author permissions"), still unresolved. The run shows no harm from it.
- **Input:** Strengths/Flaws adjective lists (≈1.4k of the 2.4k CHARACTER DETAILS). Division needs age, gender, pets and relationships. That is a judgement only, and the text writer needs the full lists anyway.
- **Replan:** the whole planner prompt (≈31k) is repeated, plus ALSO NOTED ≈2.1k, of which Q9 ≈1.1k is never acted on (W9).
- **Judge:** efficient at 15.4k, mostly the arc and the plan. The blank line between Q8 and Q9 and the "eleven points" count are cosmetic.

## IMPROVE (generic, summary)
1. Fix the parser to treat an unclosed "(none" as a negative answer: strip everything from the first `(` or dash before the sentinel test. Log it in bugs.json.
2. `commissionedNames` also takes pets and companions named in character profiles, and the counter follows the arc's "unnamed figure is not counted" rule. Add a sibling set for arc-budget ↔ planCounters.
3. Replan "stay" list: the ending event page, a character's only focal page, and the Q4 pictures. Noted findings may never remove an arc event.
4. plan-check gains an order/cast-completeness question, and sees the hint block.
5. Q4 acts anchored to arc sentence ranges in code.
6. Q9 split into a/b, with the visible-form-of-the-deed exemption.
7. Decide whether round 1 should face the same discard test as later rounds (W4).

## BLIND / WITHHOLDING

| Stage | Shown | Not shown | Documented? |
|---|---|---|---|
| beats_plan | final arc, challenges, hints, world-only premise, character details, landmarks, age mode, shot floors | the storyDetails premise text (`worldOnly: true`, story-beats.txt:11 "names and world reference only") | Heading only. No decisions.md entry found for withholding storyDetails from the planner. |
| plan_check | final arc + challenges, the plan, commissioned NAMES | hints, character details (ages, pets: why Nia's entrance/ownership can't be judged), landmarks/photos, shot floors, counter findings | Counter findings: yes (decisions.md 2026-09-19 "plan checker is not shown the counter findings"). Hints, character details, landmarks: **no entry**. |
| beats_replan | everything the planner saw + its own plan + MUST FIX / ALSO NOTED | the check's Q4 answers, the roster, the code's refusals of its own changes | Refusal non-feedback not documented as a choice. |
| plan_recheck | same as plan_check with replanned lines | the replan's declared changes and refusals | **Prompt not stored** (only reply + findings). The 2026-09-19 entry "beats report keeps the planner prompt and the checker's reply" covers the first check's prompt, not the recheck's. The recheck prompt is reconstructable (same builder), but a stored `recheck.prompt` would remove the guesswork. |

**Stale or missing docs**
- docs/prompt-inventory.md:33 describes plan-check.txt as judging "emotional highlights, entrances, 3+-cast justifications". It now has 11 questions plus ROSTER, OBSTACLES and PEOPLELESS output blocks. Stale.
- decisions.md 2026-09-20 convergence entry says a round that raises cast/focal is discarded, but code exempts round 1 (W4).
- planCounters.js:815-822 comment says `ARC_INVENTED_*` is not must-fix because "a re-plan may not remove a character". The replan did remove the mother, citing that finding. The comment half-acknowledges the 2026-09-18 change. Worth re-reading for accuracy.
- docs/SETTLED.md has no page-plan / plan-check lines. Nothing to reverse there. W3(b) and W9 touch decisions.md rulings (Q10 2026-09-10, Q9 2026-09-09) and need owner sign-off.
