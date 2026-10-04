# Whole-codebase code review — 2026-10-04

Owner ask: smart, budget-controlled, stoppable review. Report only — no fixes without owner pick.
Shape per area: 3 Sonnet finders (file slices; lenses: correctness, money/security, silent
fallbacks + one-sided sibling fixes) → 1 Opus verifier that tries to refute each finding
against the code. Results land in `tasks/code-review-2026-10/<area>.md` as each area finishes.
Pace: 3 areas, then pause for owner. Prior reviews passed to finders as known-findings:
tasks/fault-hunt-2026-09-02.md, tasks/pipeline-review-2026-09-20.md,
tasks/writer-prompt-audit-2026-09-20.md, docs/review-2026-07-25-full-code-review.md, tasks/bugs.json.

## Areas (riskiest first)
- [x] 1 Story pipeline (14 confirmed, 1 plausible, 7 rejected → code-review-2026-10/1-story-pipeline.md) — storyJobPipeline, beatsPipeline, promptBuilders, sceneMetadata, textRefine, textModels, visualBible, clothingResolve, storyHelpers
- [x] 2 Images + repair (18 confirmed, 3 plausible, 5 rejected → code-review-2026-10/2-images-repair.md) — images, grok, coverIterate, wornItems, routes/regeneration, repairPipeline, repairLogic, sceneComposite, bboxDetection, figureDetection, storyAvatars, character2x4Sheet
- [x] 3 Eval + scoring (10 confirmed, 2 plausible → code-review-2026-10/3-eval-scoring.md) — evalPipeline, scoring, entityConsistency, textRegion
- [ ] 4 Payments/credits/print — routes/print, config/credits, referral, Stripe webhook (server.js)
- [ ] 5 Auth / trial / sharing — routes/trial, routes/sharing, auth middleware
- [ ] 6 Other routes + services
- [ ] 7 Client (wizard, story display, repair hook)
- [ ] 8 Test Lab (server/lib/testlab.js + client service)
- [ ] 9 Prompts — generator↔critic consistency
