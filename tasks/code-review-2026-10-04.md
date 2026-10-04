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
- [x] 4 Payments/credits/print + 5 combined (17 confirmed, 3 plausible, 3 rejected → code-review-2026-10/4-5-payments-auth-trial.md) — routes/print, config/credits, referral, Stripe webhook (server.js)
- [x] 5 Auth / trial / sharing (see 4) — routes/trial, routes/sharing, auth middleware
- [x] 6 Other routes (15 confirmed, 3 plausible, 3 rejected → code-review-2026-10/6-other-routes.md)
- [ ] 7 Client (wizard, story display, repair hook)
- [ ] 8 Test Lab (server/lib/testlab.js + client service)
- [ ] 9 Prompts — generator↔critic consistency

## Fixes (owner: "fix all the issues", 2026-10-04)
Owner decisions: auth merge-safe + token-version revoke; share key = cover preview only; caps + length
limits; NO FALLBACKS everywhere (Turnstile fails closed). One Sonnet agent at a time, local commits only.
- [x] F1 Credits/jobs (e70eb94e1, c3158bcb8) — B1/B2/B3 (area 2), R1/R2/R3/M1 (area 6), P5, A3
- [x] F2 Payments (f911fba0b, 3effe601a, 6de97de14, 262c58788; OWNER: add async_payment_succeeded/failed to Stripe webhook events) — P1, P2, P3, P4, P7, P8, P9, P10
- [x] F3 Auth/sharing/story routes (3d740b9d5, 1394fe35c, a8447530f; migration 044 token_version) — S1, S5, M2, V1(4-5), S2, S4, S6, R7, R8, R9/R12, R10, R11, X1
- [x] F4 Trial + limits (e5323f57a, c3fc0278b, 3c64c98c8; trust proxy 2 hops) — T1, T2, T3, T4, R4, V4, V5, V2(4-5)
- [x] F5 Avatars/character writes (59f9048e2, 7d808489f; sync avatar branch deleted; modifyCharactersRow helper) — V1, V2, V3, V6 (area 6), A4 (area 1), T5
- [x] F6 Story pipeline (ee60dea83..e37033ec7) — A1, A2, C1, C2, C3, C4, C6, C8, C9, B1, B2, B3, B4 (area 1)
- [x] F7 Images + repair (1986c0961..d558a57bc) — A1, A2, A4-A6, A8, A10, A11, C1, C3, C4, C5, D1-D4, B4, B5 (area 2)
- [x] F8 Eval + scoring (702a3bfdd, 3afb7b596, 313cae148) — A1-A5, B1-B7 (area 3)
