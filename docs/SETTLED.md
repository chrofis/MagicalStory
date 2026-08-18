# Settled Verdicts

The one-page index of decisions that keep getting re-litigated. `docs/decisions.md` is the
archive (full Context/Decision/Rationale); this file is what a session actually reads before
editing prompts, eval rules, model routing, or pipeline behavior.

**Reversal protocol — reversing any line below requires ALL of:**
1. Explicit user sign-off (AskUserQuestion, framed as a reversal of a settled verdict).
2. Evidence: a Test Lab experiment ID, or ≥3 pages/stories showing the current rule failing.
   One motivating page is never sufficient.
3. A superseding entry in `docs/decisions.md` citing that evidence and linking the old entry.
4. Updating the line here.

Machine-checkable lines are enforced by `scripts/admin/check-settled.js` (runs in the pre-push hook).

## Prompts & evaluation

- **Text-overlay zone is CALM, never dark.** No "for white text" / dark-band language anywhere in prompts. *(guarded)*
- **Eval judges run at temperature 0, always.** Non-zero made tuning non-reproducible for months.
- **Pose mirrors (left/right body-part swaps) never deduct** in semantic eval.
- **Positions are relational** ("behind Roger", "on the boat"), not left/right-grid, except cross-page continuity / text-zone / ultra-wide needs.
- **Prompts are generic — no test-story names, characters, or settings.** Archetypes only. *(guarded)*
- **The "no hats" rules are gone** (2026-08-09) — do not reintroduce. *(guarded)*
- **Neon/saturation is never a deduction when the art style asks for it**; the style rule is style-conditional and passed per call.
- **Swiss orthography in every German string: ss never ß**; «guillemets» tight, no space before !?:; *(guarded)*
- **SOLID-GROUND rule: one canonical wording per prompt layer.**
- **Severity/deduction philosophy changes go to decisions.md** — flip-flops happen because the previous rationale wasn't findable.
- **Classification is the PROMPT's job; code may only change a severity.** Never pattern-match a finding's
  description text to decide what it MEANS (is this clothing? a mirror? an accessory?). Recognising "clothing"
  in prose does not generalise to complex stories — it works on the sample you tuned it against and fails on
  the next book. The sanctioned shape: the evaluator emits a **type** from the closed list, and code adjusts
  what that type may **cost** (`ZERO_POINT_TYPES`, `MAX_SEVERITY_TYPES` in `scoring.js`). A left/right regex
  guard was built and removed the same day, 2026-08-09; the prompt-side fix alone produced zero mirror findings.
- **Ask before coding an eval rule.** Prompt-vs-code is the owner's call, not an implementation detail —
  propose the shape first, then build.

## Pipeline & models

- **The 2026-05 scene composite is DEAD** (hardcoded kill-switch in server.js). Don't propose re-enabling THAT path — route-level composite for every page — without fixing style-drift, label leakage, aspect coercion AND an end-to-end gate.
- **The page composite IS enabled — for foreground+background scenes only** (owner, 2026-08-15). Grok gets depth wrong on those pages, and a scale-repair pass normally does not fix it: measured, scale repair fired on 42 pages in 30 days and left no artefact on any of them. The composite still has known issues — chiefly that the blend can relocate a character when the interaction text implies a different pose (Lab 727) — **but it is better than scale repair, which is the bar it has to clear.** Different entry point from the killed one (`storyJobPipeline` → `generateSceneComposite`, on the `needsScaleRepair` trigger); the kill-switch is untouched; two aborts keep the original render when detection or depth look wrong. Don't propose going back to scale repair without new evidence. Full rationale + Lab 653–727: decisions.md 2026-08-15.
- **The composite is INSURANCE, and firing rarely is the intended state** (owner, 2026-08-18). Measured over four stories after `scene-review` check 6c went in: **2 qualifying pages out of 52** — most stories now declare no `background` character at all, because 6c makes a writer earn the depth before declaring it. The owner's verdict: *"composite is mostly shit, so good that we do not run it often — but some pages might need it, so we still have it."* Two things follow: **don't widen the trigger** to make it run more, and **don't delete it as dead code** because it rarely fires. Both would be wrong for the same reason.
- **FLUX Dev/Schnell: rejected for page images.**
- **Avatar passes 1 AND 2 default to Grok.** Gemini refuses realistic adult faces; the 2026-07-19 "Gemini stylises better" verdict was reversed 2026-08-06.
- **The unified writer call is NOT overloaded** — measured; don't split it without new measurements.
- **Beats is the pipeline, in every environment** — the value is a code constant in
  `server/config/runtime.js`, no longer a `PIPELINE_MODE` env var (2026-08-17). It decides which
  prompt file is live. Trials are always `unified` (speed); `inputData.pipelineMode` still overrides per job.
- **Grok inpaint handles structural changes** (pose, gaze, body rotation) — don't route facing-direction issues to iterate.
- **Repaired versions are evaluated against their OWN scene contract; finalScore is the one score everywhere.**
- **Cover gaze is code-owned: always at the viewer**; `gazes at:` is banned from cover hints.
- **Cover title text is painted in (plate/strip pass), never model-spelled.**
- **Test Lab sets are generic, never per-stage** (a parallel title_sets mechanism was reverted).

## Data & infrastructure

- **No image bytes in JSONB — R2 only**, URL in `stories.data`. IRON RULE.
- **Clothing canonical source is the outline's `clothingRequirements`** (per story, per page) — never raw `avatars.clothing`.
- **DDL only via new `migrations/00N_*.sql`** — every other init path is dead.
- **Checkpoints are deliberately KEPT** — never propose deleting them.
- **Search ads land on the HOMEPAGE** — final, do not re-litigate.
- **Prod deploys: staging-first, per-push approval, pushes gated on an idle target environment.**
- **Timestamps shown to the owner: Swiss local (`… CH`) ONLY, via `scripts/lib/chTime.js` — UTC never shown, no hand arithmetic.** Settled 2026-08-09; supersedes UTC-only (May 2026), which superseded dual-labeling. Naive pg TIMESTAMP columns must be rehomed with `fromPgNaive()` before formatting.
