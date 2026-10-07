# Trial story quality review + full-story ports — 2026-10-07

**Owner ask:** "send agents to review any trial stories of last 2 weeks. We have changed main story a lot. But how is
quality of trials. Can we use any of the improvements from full story for trial? No increase in time for trial."

**Constraint of this session:** cloud container, no DB / admin token / API keys — the stored trial stories themselves
could NOT be pulled. The review is built from every trial run recorded in the repo (tasks/, verify.json, bugs.json,
decisions.md, prod-review) plus a code-level divergence map of the trial vs the full (beats) pipeline.

## 1. Trial runs on record, 2026-09-21 → 2026-10-04

| Date | Job | Env | Observed | Source |
|---|---|---|---|---|
| 09-21 | job_1789944735873_vmbd0or30 | prod | age-4 band OK; 0/6 pages open on a name | verify.json trial-prompt-parity |
| 09-21 | job_1789975900382_dyc1g7wue | prod | p4/p5 rendered with no scene prose + no cast (prompt shrink); back cover from empty hint | bugs.json trial-page-prompt-drops-scene-and-cast-blocks (fixed 865f983f7) |
| 09-23 | job_1790169018278_n57xpnufo | prod | front cover = edit of the raw landmark photo, two strangers painted in | bugs.json (fixed 8c1a6b4b3) |
| 09-24 | job_1790256136168_pbxibjv0r | prod | age-1 routine book fits the band | verify.json age-band-1 |
| 09-24 | job_1790282439176_ppgelxibt | prod | p2/p4 draw a middle-aged man instead of the 5-yr-old | bugs.json (fixed 63ed8628b) |
| 09-27 | job_1790496731630_m9pp92go3 | prod | age-1: text turns costume into a "mission"; drawn walking; sheet bare arms / bare-chested infant cell | verify.json trial-sheet-season + age-band-1 FAILED |
| 09-29/30 | job_1790769860433_2bhhj0pyi (LUNA) | prod | costume never rendered (name case "Luna" vs "LUNA"); wand continuity broken; text 6 / images 4 | prod-review-2026-10-04.md; bugs.json (fixed 4d8cce94e) |
| 10-04 | job_1791114188734_cwyvu3y8p / job_1791130829297_qfrcuuf2m | staging | gate runs: run 1 lost story on reload (fixed 5933f5926), run 2 all pass, complete ~218 s | trial-story-gate-2026-10-04.md |

No trial run after 2026-09-30 is recorded in the repo. Prod trials after that date are only in the DB.

## 2. Quality verdict (from stored evidence)

Trial quality lags the full story mainly because the trial has **no safety net** (skipQualityEval, no repair, no
refine) and its writer prompt had drifted from the beats writer. Recurring classes: wrong character rendering
(age/costume/missing hero), avatar-sheet coverage defects, cover defects, text–image mismatch that ships unreviewed,
age-band text fit. Most single bugs above are fixed; the structural gap (writer rules + image rules) is what this
session ported.

## 3. Ported this session (no extra call, no extra pass)

- [x] Trial writer gets the beats writer's shared prose rules: PERIL_CEILING, no em/en-dash, page continuity,
      neighbour-phrase, no abbreviation, arc-questions-answered, title rule + title criteria; stale 5-page arithmetic
      → page-count-derived; effort parity. +~400 input tokens (≈4 %), output contract unchanged.
      → 645cf7fc, verify `trial-writer-shared-prose-rules`
- [x] Trial page grid = production `buildPageVbGrid` (cap 4, plate-borne/aboard filters). Same image-call count.
      → e4f6ccb1, verify `trial-page-grid-production-selector`
- [x] Photo glasses / recorded features / hair analysis reach the trial character (fields were already in the
      one analysis call, dropped on the way). → 898de113, verify `trial-photo-glasses-and-features`
- [ ] Trial writer image rules (population enum, costume-body, footing, eyes-open, contact rules) — in progress,
      see section 6.

## 4. Not ported — would add time (out of scope under the owner constraint)

Arc / OWED list / typed plan, any audit, proofread, refine, lector, title lector, page eval, repair, sheet judges,
brief re-ask, the beats writer's two-step ANALYSIS block (delays page 1 streaming).

## 5. Owner decisions surfaced (not decided here)

1. **Reading level instead of flat 100–140 words/page** — the full story uses LANGUAGE_LEVELS standard (40–150 words,
   varied pacing). Porting likely makes the trial *faster* (shorter output) but changes page look on the /try page.
2. **Time savings available for quality budget** (timing analysis, stored evidence only):
   - Jev landmark probe + scoring runs SEQUENTIALLY before the writer (up to the 20 s probe timeout,
     storyJobPipeline.js ~681) — could move to the prewarm like `prepare-idea-landmarks`.
   - Back cover starts only after the parse and waits for landmarks + ref sheets (storyJobPipeline.js ~1470); the
     prod "repair" window 155–216 s is actually this cover wait (no repair runs in trial).
3. **Order-flow SKU fallback**: gelato.js ~323 still falls back to GELATO_PHOTOBOOK_UID when no product matches
   (the admin PDF route now fails loudly instead).
4. **Deferred trial hint fields** (sentence-length output per page): sceneIntent (the THIS IMAGE DEPICTS line is blank
   on every trial page), looksAt, creatures[]; trial cover code-owned fields (shot/gaze/weather) and a back cover
   with the story's main location.

## 6. Validation status

All changes: unit tests + rung-1 prompt builds (de/fr/en) only. No trial run (no credentials / paid mandate in
this session). The three verify.json entries above are pending a human check on the next trial run:
`node scripts/admin/trial-showcase.js --dry-run` → owner-approved run → `node scripts/admin/verify-run.js <storyId> --write`.

To review the last 2 weeks of prod trials with credentials:
`node scripts/analysis/fetch-story-data.js --recent 30`, filter `stories.data->>'trialMode'='true'` since 2026-09-23,
then per story `node scripts/admin/verify-run.js <id> --env=prod --write` and `node scripts/admin/verify-review.js <id> --env=prod`;
`node scripts/analysis/shipped-defects.js --prod --days=14`.
