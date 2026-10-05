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
- [x] 7 Client (14 confirmed, 3 plausible, 2 rejected → code-review-2026-10/7-client.md) — A: StoryWizard, CharacterForm, characterService, trial pages; B: StoryDisplay, RepairWorkflowPanel, useRepairWorkflow, storyService, SharedStoryViewer, BookBuilder, MyStories
- [x] 8 Test Lab (+9a prompt fit: 10 confirmed, 1 dup → code-review-2026-10/8-9a-testlab-promptfit.md) — server/lib/testlab.js, routes/admin/testlab.js, client TestLab.tsx + testlabService
- [x] 9 Prompts (9b: 7 confirmed, 3 rejected → code-review-2026-10/9b-generator-critic.md) generator↔critic + images.js 1-1280 prompt-shrink code (unread by areas 1-6)

## Fixes (owner: "fix all the issues", 2026-10-04)
Owner decisions: auth merge-safe + token-version revoke; share key = cover preview only; caps + length
limits; NO FALLBACKS everywhere (Turnstile fails closed). One Sonnet agent at a time, local commits only.
- [x] F1 Credits/jobs (e70eb94e1, c3158bcb8) — B1/B2/B3 (area 2), R1/R2/R3/M1 (area 6), P5, A3
- [x] F2 Payments (f911fba0b, 3effe601a, 6de97de14, 262c58788; Stripe live + sandbox webhooks carry all 4 checkout.session events, owner 2026-10-04) — P1, P2, P3, P4, P7, P8, P9, P10
- [x] F3 Auth/sharing/story routes (3d740b9d5, 1394fe35c, a8447530f; migration 044 token_version) — S1, S5, M2, V1(4-5), S2, S4, S6, R7, R8, R9/R12, R10, R11, X1
- [x] F4 Trial + limits (e5323f57a, c3fc0278b, 3c64c98c8; trust proxy 2 hops) — T1, T2, T3, T4, R4, V4, V5, V2(4-5)
- [x] F5 Avatars/character writes (59f9048e2, 7d808489f; sync avatar branch deleted; modifyCharactersRow helper) — V1, V2, V3, V6 (area 6), A4 (area 1), T5
- [x] F6 Story pipeline (ee60dea83..e37033ec7) — A1, A2, C1, C2, C3, C4, C6, C8, C9, B1, B2, B3, B4 (area 1)
- [x] F7 Images + repair (1986c0961..d558a57bc) — A1, A2, A4-A6, A8, A10, A11, C1, C3, C4, C5, D1-D4, B4, B5 (area 2)
- [x] F8 Eval + scoring (702a3bfdd, 3afb7b596, 313cae148) — A1-A5, B1-B7 (area 3)

## Fixes round 2 (areas 7-9; owner 2026-10-05: open Nochmal to customers, SEVERITIES list wins, fix all)
- [x] F9 Client wizard + trial (12ad105e4, 9d24efe71; decisions entry for W5 photo-fallback removal still owed) — W1-W10, D7
- [x] F10 Client display + Nochmal for customers (client commit + server gate commit) — D1 (server gate + client), D2, D3, D4, D5, D6
- [x] F11 Server (L4, L6 still open: testlab.js had foreign edits) — S1-S4 (regenerate via makePageImagePrompt), L1, L2, L4-L7, G1, G2, G7, G8, G10

## Round 3 — texts in all languages + page layout (owner 2026-10-05)
- [x] T-de German texts (Swiss ss/«», grammar, du/Sie, leaks, factual consistency)
- [x] T-gaps translation completeness (missing keys, fall-through ternaries, untranslated copies, raw English errors, emails/PDF/SEO)
- [x] T-fr French texts
- [x] T-it Italian texts (+ English source texts)
- [x] L-layout staging screenshots at 390 / 768 / 1440 px of the main routes
  → findings in tasks/code-review-2026-10/10-texts-layout.md; owner decisions pending before fixes

## Fixes round 3 (owner 2026-10-05: trial minutes / book ~1 h; address Ennetbaden; visitor language wins; legal Sie, rest du; defaults US English, French vous + standard typography, DB prices)
- [x] F12 Facts (all languages) + German texts (eb758f398, f1bbff744; Sie left in 7 modals → F14; owner: print size, shipping countries, max characters)
- [x] F15 Layout + translation gaps + localised error codes (87ea09f6c + 4; leftovers: L-4 comparisonData per-language us/them, L-11, L-14, L-15, G-7, L-12 hero image = owner)
- [x] F13 French texts (1eca0e3ab, 14a13f259; owner/migration: relationship + trait labels keyed by French text)
- [x] F14 Italian + English texts + leftovers (edceddf41, bb47d65c6)
