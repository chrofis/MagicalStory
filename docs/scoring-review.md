# Image scoring — complete review (2026-08-08)

Owner's position: *"there should be only one score per image — how difficult can this be."*

**Short answer: there IS one canonical score per image version — `version.finalScore`,
written by the single writer `applyScore()` in `server/lib/scoring.js`. The problem is not
that the model has many scores; it is that (a) several call sites still compute their own
number on a *different scale* and write it into the same field names, and (b) the
scene/cover *root* objects mirror the version's score under legacy field names whose
meaning no longer matches their name.**

---

## 0. The reported evidence, corrected

The review was commissioned on the theory that story `job_1786147254924_8nuyywjii`
(staging, 10 pages) had an entirely absent repair stage caused by version objects lacking
scores. **That theory is wrong on both counts.** The DB and the Railway log say:

* `imageVersions[]` entries **do** carry canonical scores. They carry `finalScore`,
  `rawScore`, `deductions`, `scoreBreakdown`, `scoreModel:'math'`. They do **not** carry
  `qualityScore` — because `qualityScore` was deliberately retired as a version field
  (`images.js` `stampScores` comment: *"Legacy fields (qualityScore, semanticScore,
  threeStageScore, rawQualityScore) are no longer written"*). `v.qualityScore ===
  undefined` is the intended shape, not a gap.
* The repair loop **did** fire, and correctly:

  ```
  🔄 [UNIFIED PIPELINE] Round 1: 13 bad pages → 12 iterate, 0 inpaint, 1 char-fix
  ✅ [UNIFIED PIPELINE] Round 1: 4/13 repaired in 85.8s
  ```

  `decideRepairMethod` read visual=0 / semantic=0 and chose `iterate` for 12 of 13.
  Nothing was skipped for want of a score.
* The 9 missing repairs were **execution** failures, not decision failures, and they were
  already logged at ERROR:

  ```
  ❌ [UNIFIED PIPELINE] Round 1 iterate failed for page 3:
     [CLOTHING] Hans: no per-page clothing category and the story is not costumed.
     Refusing to default to 'standard'.
  ```

  That is the `07e50a829` / `a1f85aa1b` "no default clothing category — throw instead of
  guessing" rule firing inside `iteratePage`. **This is a clothing-resolution bug, not a
  scoring bug, and it is the actual cause of "the repair stage did nothing".** It is out
  of scope for this review — see *Needs a decision*, item D1.
* The run also had `maxRepairPasses: 1`, so there was no round 2 to recover.

So: no silent skip occurred *on this run*. But the silent-skip **path is real** and was
found by code inspection — see §3. It has simply not been the thing that bit yet.

---

## 1. Field map

Scale legend: **[100]** = the canonical 0–100 deductions scale (`100 − Σ SEVERITY_POINTS`);
**[10]** = raw evaluator/LLM 0–10 scale; **[10→100]** = multiplied by 10 at a boundary.

| Field | Written where | Read where | Scale | Canonical? |
|---|---|---|---|---|
| `finalScore` (version) | `scoring.js:300` (`applyScore` — the ONE writer) | `scoring.js:411` (`computeFinalScore`), `pickBestVersionIndex`, `repairLogic.js:46`, `images.js` round loop, `client/utils/versionScore.ts` | [100] | **YES — this is the score** |
| `rawScore` (version) | `scoring.js:305` | `computeRawScore`, admin/dev surfaces | [100] un-clamped, may be negative | yes (diagnostic twin of finalScore) |
| `deductions` | `scoring.js:297` | `sumDeductionPoints`, `computeRawScore` | [100] | yes (the evidence behind finalScore) |
| `scoreBreakdown.{visual,semantic,threeStage,entity}` | `scoring.js:316` | `repairLogic.js:187-195` (repair gates), dev panel | [100] | yes (per-evaluator detail) |
| `evalScore` | `scoring.js:327` = `finalScore + entityPenalty` | `scoring.js:413`, `images.js:9572` | [100] | derived, no independent truth |
| `entityPenalty` / `entityPenaltyRaw` | `scoring.js:325-326` via `capEntityPenalty` | breakdown display, `computeFinalScore` legacy branch | [100], capped at 40 | yes |
| `mathFinalScore` / `promptFinalScore` | `scoring.js:293,299` | **nothing branches on them** | [100] | audit only, by design |
| `scoreModel` / `scoreSource` | `scoring.js:306-308` | logs, dev panel | — | audit only |
| `qualityScore` (version) | **no longer written** | legacy fallback in `computeFinalScore:421`, `repairLogic.js:189` | [100] | legacy read-only |
| `qualityScore` (scene/cover root) | `images.js:9572` = `best.evalScore`; `regeneration.js` re-evaluate | `repairLogic.js:189`, client panels | [100] | **MIRROR — misnamed, see §2.1** |
| `finalScore` (scene root) | `images.js:9573` = `computeFinalScore(best)` | client, `stories.js` | [100] | mirror, correct |
| `semanticScore` (scene root) | `images.js:9575` | `repairLogic.js:194`, client | [100] (source `sceneValidator.js:853` `score*10`) | mirror |
| `rawQualityScore` | `stories.js`, `regeneration.js:4009` | `repairLogic.js:190`, `ImageHistoryModal` | [100] | legacy |
| `visualScore` / `imageScore` / `semanticPenalty` | `images.js` round loop + eval internals | round loop, repair gates | [100] | transient, loop-local |
| `SEVERITY_PENALTY` (`images.js:1934`) | — | feeds `qualityScore` via `rawScore*10` | **[10→100]** | legacy 0–10 blend, deliberate |
| `rawScore` (**evaluator**, `images.js:1203`, `sceneValidator.js:854`) | eval endpoints | client via `regeneration.js:4047` | **[10]** | **NAME COLLISION — see §2.4** |
| `finalScore` / `cleanScore` (`character2x4Sheet.js`, `avatars.js`) | avatar sheet evals | `valid: finalScore >= 6` | **[10]** | different namespace entirely |

Three deliberate severity→number tables coexist and are documented as intentional at
`scoring.js:86-97`: `SEVERITY_POINTS` (the score), `RANK_SEVERITY_WEIGHT` (the pick-best
tiebreak), `SEVERITY_PENALTY` (the legacy 0–10 audit blend). Those three are **not** the
problem. The undocumented *fourth* and *fifth* copies were.

---

## 2. Divergences found

### 2.1 The scene root's `qualityScore` is not a quality score — FIXED (documented, not renamed)
`images.js:9572` writes `qualityScore: best?.evalScore`. `evalScore` is
`finalScore + entityPenalty` — i.e. the score *after* quality, semantic and compliance
deductions. A field named "quality score" holds a post-deduction composite.

This is exactly the "two scores" the owner sees: page 3 of the beats story shows
`qualityScore: 30` at the scene root while the version's actual visual sub-score
(`scoreBreakdown.visual.score`) is `0`. Both numbers are "correct" for what they measure;
one of them is named wrong. **Renaming is a shape change → decision D2.**

### 2.2 `regeneration.js` re-evaluate had a whole parallel scoring model — FIXED
`regeneration.js:3958-3973` carried its own entity table `{critical:30, major:20, else:10}`
— a *fourth* scale, contradicting `SEVERITY_POINTS` (25/15/5/2) — applied **no**
`capEntityPenalty`, and wrote the result into `scene.qualityScore` / `scene.finalScore` /
`pages[n].score`, **while `stampCanonicalScore` on the very next lines separately recomputed
the same version through `applyScore`.** Two writers, two scales, one object. Re-evaluating
a page silently moved it onto a scale nothing else used.

### 2.3 The surviving `max(0, imageScore − entity)` recompute — FIXED
`images.js:7891` (`baseFinalScore`) was the last survivor of the pattern whose own comment
at `images.js:8490` says it *"disagreed with the persisted score"*. It wrote an
evaluator-scale number into `finalScore`, which `applyScore` then usually — but not always —
overwrote with the math-scale number. Versions without an `.evaluation` (pre-scale-repair
v0, non-winner text-space candidates) skip that stamp and kept the wrong-scale value.

### 2.4 `rawScore` is two different fields sharing one name — NOT fixed (D3)
Version-level `rawScore` = un-clamped `100 − Σ deductions` (may be negative).
Evaluator-level `rawScore` = the raw **0–10** model score (`images.js:1203`,
`sceneValidator.js:854`), returned to the client at `regeneration.js:4047/4229/4284`.
`computeRawScore` trusts `version.rawScore` blindly. Today this is contained only by the
client convention "consult rawScore only when negative" (`client/utils/versionScore.ts:17`).

### 2.5 Client mirrors drifted — FIXED
`useRepairWorkflow.ts` `ENTITY_PENALTIES` hand-copied a *subset* of `SEVERITY_POINTS`:
`catastrophic` (50) and `moderate` (5) were missing and fell through `?? minor` to **2**.
It also applied no 40-point cap, so the panel could show a −70 deduction the server never
charged. Same subsetting bug existed server-side in `images.js` `ENTITY_PENALTIES`
(`moderate` displayed as −0 while the score charged −5) — also fixed.

### 2.6 Client and server disagree on the iterate gate — NOT fixed (D4)
Server gate (`repairLogic.js:209-213`): `visual < 50`, `semantic < 30`, hardcoded.
Client gate (`client/src/config/repairDefaults.ts:10-11` → `useRepairWorkflow.ts:1137`):
`qualityScore < 20`, `semantic < 30`. `server/config/models.js:607-612` already flags its
own `qualityThresholdForIterate: 20` as DEAD CONFIG *and* notes the values DISAGREE — but
the client ships and uses them. Manual repair and pipeline repair therefore apply
different catastrophic thresholds to the same image.

---

## 3. The silent-skip path (real, now loud) — FIXED

Two places treated "no readable score" as "nothing to do":

1. **`images.js` round loop.** The guard was `if (bestSoFar && bestSoFar.score != null)`.
   `.score` is the *legacy* evaluator mirror (`ev.score ?? ev.qualityScore`), null whenever
   the eval failed or returned an unexpected shape. A page failing that guard was dropped
   from `roundEvalPages` **before `findBadPages` ever saw it** — which made
   `findBadPages`' own `evaluated === false → mark bad for redo` branch
   (`repairLogic.js:40`) *unreachable from the pipeline*. A page whose evaluation errored
   shipped as-is, with no line in the log.

2. **`repairLogic.decideRepairMethod`.** `?? 100` on both score reads means a page with no
   score data is treated as a **perfect 100** and returns `skip` — silently. That default
   is defensible (an un-evaluated page must not trip the catastrophic gate on a phantom 0)
   but it must never be silent.

Both now emit an ERROR naming the page. The round loop additionally enters unscoreable
pages into `roundEvalPages` as `evaluated:false`, so `findBadPages` redoes them instead of
dropping them.

---

## 4. Covers vs pages

**Same** in every important respect: same evaluator (`evaluateImageQuality` with
`evaluationType:'cover'`), same three-stage compliance eval, same `applyScore` writer, same
`pickBestVersionIndex` / `recomputeActiveVersion`, same `dbIndexFor`/`arrayIndexForDb`
persistence, and covers ride the **same** repair round loop as `-1/-2/-3`. Cover versions
carry the full canonical field set. Verified against the DB: cover versions have
`finalScore`, `rawScore`, `deductions`, `scoreBreakdown`, `scoreModel:'math'`.

**Divergences:**

| # | Divergence | Status |
|---|---|---|
| C1 | Cover **root** never received `finalScore` — `server.js` cover-extraction whitelist copied `qualityScore` but not `finalScore`, so every stored cover root had `finalScore: undefined` (confirmed in DB) and `database.js:1898` fell back to `qualityScore`. Scenes got it at `server.js:6797`. | **FIXED** |
| C2 | `getActiveVersion(id, pageNumber)` called with the **negative page number** for covers at `regeneration.js:3866, 4008` (and `3760, 4153, 4840`). Active-version keys for covers are `'frontCover'`/`'initialPage'`/`'backCover'`, so the lookup never matched and fell through to `0` — **every cover re-evaluation read and re-stamped v0, not the active version.** | **FIXED at the two re-evaluate sites** (3760/4153/4840 remain — D5) |
| C3 | Same sites indexed `imageVersions[dbIdx]` directly instead of via `arrayIndexForDb`. | **FIXED at the same two sites** |
| C4 | Composite covers return `score: null` (`coverIterate.js:865-885`, no quality eval at all) → unscoreable by `pickBestVersionIndex` → worked around with a hard `pinned:true` (`regeneration.js:2431`), which permanently disables `recomputeActiveVersion` for that cover. | **NOT fixed — D6** |
| C5 | Semantic eval is conditional for covers (`images.js:1348`, needs `sceneHint`) but unconditional for scenes. | By design; header doc corrected |
| C6 | `PROMPT_TEMPLATES.coverImageEvaluation` is *displayed* in dev mode (`regeneration.js:4186`) but **never executed** — the real eval always uses `imageEvaluation` (`images.js:1387`). | **NOT fixed — D7** |
| C7 | `saveScenePageData` recomputes active version for scenes only (`database.js:2085`); no cover equivalent. | **NOT fixed — D8** |
| C8 | Char-fix is scene-only (`repairLogic.js:232`). | Intentional, documented |
| C9 | `scoring.js` header claimed covers get no semantic/three-stage eval. Both claims were false. | **FIXED (doc)** |

---

## 5. Recent commits — did any of them cause this?

`git log --oneline -30` reviewed. **None introduced the divergences; two masked symptoms.**

* `7e4700f36 feat(admin): show the un-clamped score instead of flooring every failure at 0`
  — added `rawScore`/`computeRawScore`. **Reduced** masking (that's why we can see −115 on
  page 3 instead of a flat 0). Did add the `rawScore` name collision surface (§2.4).
* `7f51cae44 fix(covers): stamping the title no longer wipes the version's score` — a real
  score-loss bug on covers, already fixed.
* `0312533c3 revert(scoring): drop the code-side consensus cap — owner decision` and
  `a8cd04ed6 fix(scoring): enforce the consensus cap in code` — a cap added then reverted
  by owner decision. Not implicated.
* `a1f85aa1b fix(iterate): no default clothing category — throw instead of guessing` and
  `07e50a829 fix(clothing): no default category anywhere` — **these are what actually broke
  the run above.** They correctly refuse to guess, but `iteratePage` has no per-page
  clothing for a non-costumed story, so every iterate throws. Scoring is innocent.
* `a0a…/e05d…/8921115e9` beats commits — beats replaces the **writer** stage only
  (`beatsPipeline.js`, `server.js:2894`). The image pipeline is shared verbatim. Confirmed
  empirically: a beats story and a unified story produce identical version score shapes.

---

## 6. What was fixed

| # | Fix | File |
|---|---|---|
| F1 | Round loop gates on the **canonical** `computeFinalScore`, not the legacy `.score` mirror; unscoreable pages enter `roundEvalPages` as `evaluated:false` (so `findBadPages` redoes them) and log an ERROR naming the page | `server/lib/images.js` |
| F2 | `decideRepairMethod` logs an ERROR naming the page when no visual score is readable, instead of silently defaulting to a perfect 100 | `server/lib/repairLogic.js` |
| F3 | `decideRepairMethod` and `findBadPages` now judge the **same** object — the enriched `roundEvalPages` entry carrying the version's `scoreBreakdown` — instead of the bare evaluation | `server/lib/images.js` |
| F4 | Removed the last inline `max(0, score − entity)` recompute; `applyScore` is the only writer of `finalScore` | `server/lib/images.js` |
| F5 | Re-evaluate endpoint uses `SEVERITY_POINTS` + `capEntityPenalty` instead of its own uncapped 30/20/10 table | `server/routes/regeneration.js` |
| F6 | Re-evaluate mirrors `scene.qualityScore`/`scene.finalScore` from the stamped version (same rule as the generation pipeline) instead of writing its own `adjustedScore` | `server/routes/regeneration.js` |
| F7 | Cover re-evaluate resolves its active version by **cover key** + `arrayIndexForDb` (was reading/stamping v0 every time) | `server/routes/regeneration.js` |
| F8 | Cover root receives `finalScore`, matching scenes | `server.js` |
| F9 | `ENTITY_PENALTIES` uses `SEVERITY_POINTS` wholesale — no more hand-copied subset dropping `moderate`/`catastrophic` | `server/lib/images.js` |
| F10 | Client `ENTITY_PENALTIES` gains `catastrophic`/`moderate` and applies the 40-point cap | `client/src/hooks/useRepairWorkflow.ts` |
| F11 | `scoring.js` header corrected (covers DO get three-stage; cover divergences catalogued) | `server/lib/scoring.js` |

---

## 7. Needs the owner's decision

Prioritised. None of these were changed, because each alters behaviour or data shape.

* **D1 (highest — this is the live bug).** `iteratePage` throws
  `[CLOTHING] X: no per-page clothing category and the story is not costumed` for every
  page of a non-costumed story, so **the entire iterate repair method is currently dead on
  such stories** (9/13 repairs lost on `job_1786147254924_8nuyywjii`). Options: resolve the
  category from the story's `clothingRequirements` the way the char-fix path does; or let
  iterate proceed without an avatar reference when no category exists. Both change repair
  behaviour → your call.
* **D2.** Rename the scene/cover root `qualityScore`. It holds `evalScore`, not a quality
  score, and it is what `repairLogic.js:189` falls back to as "visual". A rename is a
  storage shape change across ~40 write sites and the client — the `sweeping-shape-changes`
  playbook applies.
* **D3.** Resolve the `rawScore` name collision (version 0–100 un-clamped vs evaluator
  0–10). Suggest renaming the evaluator one to `evaluatorRawScore10`.
* **D4.** Unify the iterate gate. Client uses `quality < 20`, server uses `visual < 50`.
  `models.js` already marks its copies DEAD CONFIG and notes they disagree. Picking either
  number changes repair behaviour.
* **D5.** Three more cover `getActiveVersion(id, negativePageNumber)` sites remain
  (`regeneration.js:3760, 4153, 4840`). Fixing them changes which version inpaint/repair
  acts on for covers — correct, but a behaviour change on live repair paths.
* **D6.** Composite covers skip quality eval entirely and are pinned to dodge
  `pickBestVersionIndex`. Either score them or make "unscoreable but preferred" a
  first-class concept rather than a pin.
* **D7.** `coverImageEvaluation` prompt template is shown in dev mode but never executed.
  Delete the template, or actually route covers to it.
* **D8.** `saveScenePageData` has no cover branch for `recomputeActiveVersion`.

---

## 8. Verdict on "one score per image"

**Reachable, and mostly already true.** `version.finalScore` is the one score;
`applyScore` is the one writer; `computeFinalScore` is the one reader. After the fixes
above, no production path computes a competing number.

What still produces *apparently* two scores is naming, not arithmetic: the scene root
exposes `qualityScore` (= `evalScore`, post-deduction) next to `finalScore` (= post-entity),
and the UI shows both. Collapsing that to a single displayed number is **D2** — a rename
plus a UI change, not a scoring change.
