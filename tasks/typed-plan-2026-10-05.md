# Typed page plan — Lab experiment (2026-10-05)

Owner-approved design, **Lab only, production unchanged**. Cap CHF 1.00 for the whole experiment.
Question: does a plan whose lines carry a picture TYPE (landscape / object / face / medium / group), with
the book's targets given up front and counted in code, beat today's plan -> check -> replan flow?

## Design (as approved)
1. **Plan** — one claude-sonnet-5-5 call, `prompts/story-beats.txt` filled in a typed variant behind the Lab
   param (`typedPlan`), not a copy. Line: `type — who (names only | nobody) — moment — after`.
   Targets up front, from code constants: face close-ups >= 1; landscape-or-object pages >= 1 (ideally mixed);
   no neighbours with the same type + cast; each listed character >= `castCoverage().appearances.min` pages
   (+ a focal page when `focalEach`); main character >= ceil(P/2); group pages <= `groupPageBudget().max`;
   pages with no commissioned character <= 1. CAST block kept.
2. **Code counts every target** (`planCounters.typedPlanCounters`): who parsed in code (collectives rejected
   loudly), type <-> cast consistency (landscape = nobody, object = nobody|one, face = 1, medium 1-3, group 4+).
3. **Jev per page, ONE question per call**: simplicity ("one action, one place") + the plan-check questions that
   are about the picture, each converted to a per-page noul. Jev also picks the shot WITHIN the type
   (`TYPE_SHOTS`); the old shot quotas became the planner targets.
4. **Targeted replan** — only pages Jev scores poorly or that break a code target, with their exact reasons, ONE
   sonnet-5-5 call returning only those lines; code + Jev recount; a page is kept only if it fixes something and
   breaks nothing. One round, then ship with a warning. Existing merge / duplicate / page-count guards reused
   (extracted to `server/lib/planGuards.js`, called by `runReplanRounds` too).
5. **Lab** — `typedPlan: true` on the `beats_replan` stage (+ `planFresh`, `measureStored` for the arms).

## Plan-check questions -> Jev (kept = about the picture)
Kept: Q1 felt moment (face pages), Q3 third character (3-figure pages), Q5 instant is an action, Q6 weight of a
people-free page (arc state), Q9 deed+effect together, Q10 two heights, Q11 obstacle held by an unnamed
character, Q17 whole cast one shared action (existing eval, AUC 0.95, threshold 0.5).
Dropped (story/text, not the picture): Q2 naming (spoken), Q4 most wanted picture per act (cross-act, arc
sentences), Q7 plants/payoffs, Q8 ending event, Q12 each character's own action (code: coverage + focal),
Q13 order, Q15 opening (covered by Q5 on page 1), Q16 ending cast (code: CAST block), Q18 story logic.

## Arms x stories
Arms: 0 stored shipped plan (free) · 1 today's prompt+flow on claude-sonnet-5-5 · 2 typed design.
Stories (staging): atbttop6w, 50osg2osm, dka3jpog9, z3fw660ie, optional ypl33vk8u (only if the cap allows).
Metrics (code + Jev, same for every arm): type/shot distribution, neighbouring same shot, face close-ups,
landscape/object pages, close-ups on >1 figure, Jev simplicity distribution + per-question flags, per-character
coverage, main share, group budget, no-commissioned pages, pages replanned, cost, wall time. Luna plan_check run
ADVISORY on arm 2 to list the story-level findings the typed flow would lose.

## Checklist
- [ ] worktree typed-plan from origin/staging
- [ ] TYPE_SHOTS + typed assign (no quotas, per-page allow) in shotVocabulary / jevDecisions
- [ ] typedPlanFills in buildBeatsPrompt (`typedPlan`) + `{TYPED_TARGETS}` slot in story-beats.txt
- [ ] planCounters.typedPlanCounters + shared target counting (arms 0/1/2)
- [ ] server/lib/typedPlan.js: Jev questions, judge, typed shots, targeted replan, acceptance
- [ ] planGuards.js extracted from runReplanRounds
- [ ] Lab params in runBeatsReplanStage; client TestLab mirror if a stage id is added (none planned)
- [ ] unit tests, sibling registry set, prompt inventory
- [ ] push to staging (hook, wait for idle), confirm /api/health
- [ ] run arms 0/1/2 on 4 stories (5th if cap allows); record Lab ids
- [ ] decisions.md "measured, not adopted" + evals/results/results.jsonl + BACKLOG tick
- [ ] report
