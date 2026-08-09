# Image scoring, repair and selection — complete review

Written 2026-08-09 against `server/lib/scoring.js`, `server/lib/repairLogic.js`,
`server/lib/images.js`, `server/lib/clothingCheck.js`.

The owner's specification, in full:

> We generate an image, we score it. If bad we redo. We score the new one and
> take the better one.

That is four operations. This document lists everything that currently exists,
says which of the four it serves, and names what can go.

---

## 1. The model, as it now stands

**One image, one score.** `finalScore = 100 − Σ SEVERITY_POINTS` over the
deduplicated defect list. No floor (negative means the evaluators charged more
than 100 points). No second scale, no clamped twin, no model-reported number.

```
catastrophic −50   critical −25   major −15   moderate −5   minor −2
```

Four evaluators produce defects; none produces a score:

| evaluator | prompt | scope |
|---|---|---|
| visual | `image-evaluation.txt` | always |
| semantic | `image-semantic.txt` | scenes always; covers when a fidelity reference exists |
| compliance (three-stage) | `image-prompt-compliance.txt` | scenes and covers |
| entity | `entityConsistency.js` | scenes only, penalty capped at 40 |

---

## 2. `scoring.js` — every function

After this review's deletions: **669 lines, 12 exports** (was 800 / 18).

### Live

| function | role |
|---|---|
| `applyScore(version, {evalResult, entityResult, consolidatedPlan})` | **The only writer.** Stamps `finalScore`, `deductions`, `scoreBreakdown`, `evalScore`, `entityPenalty`, `scoreSource`. |
| `computeFinalScore(version)` | **The only reader.** `finalScore`, then legacy fallbacks for old rows. |
| `pickBestVersionIndex(versions, {tieBreak})` | Highest score wins. Unscored logs an error and cannot win. |
| `composeDeductions` | Normalises the four evaluators' issues into one shape. |
| `computeMathFinalScore` | `100 − Σ points`. |
| `capEntityPenalty` | Caps entity at 40; halves it when all issues are non-actionable. |
| `versionDeductionTotal` | Tiebreak input only. |
| `recomputeActiveVersion` / `recomputeAllActiveVersions` | Re-point the stored active version after a write. Respect a user pin. |
| `shouldRedo` / `SCORE_THRESHOLDS` | The redo gate. |
| `normalizeIssues`, `sumDeductionPoints`, `_buildBreakdownFromEvalResult`, `significantWords` | Internal helpers. |

### Deleted in this review

`logScoreModelSummary`, `buildScoreBreakdown`, `composeEvalScore`,
`composeFinalScore`, `setVersionScores`, `applyScoreBreakdown` — six functions,
**131 lines**, all with zero callers outside the module and only calling each
other inside it. They were the remains of a second scoring model that was never
plumbed in.

### Deleted earlier the same day

- `mathFinalScore` — assigned to `finalScore` on the very next line.
- version-level `rawScore` — the unclamped twin of a clamped score; the clamp is gone.
- `promptFinalScore` — written in 8 places, read in **zero**.
- `blendVisualScore` — let the model's own number pull a score back **up**
  (`max(computed, model − 3)`), so an image the model liked outranked its own
  defect list.
- `computeRawScore`, `versionRawScore`, `versionDisplayScore` (client).

---

## 3. Three ways "take the better one" was not happening

All three fixed 2026-08-09, all three found on `job_1786235099497_ytd5c7eek`.

**Self-appointment.** Two repair paths pushed a version and then wrote
themselves in as the winner, never consulting the score:

```js
versions.push(newVersion);
finalBestPerPage.set(pageNumber, newVersion);   // text-space repair
finalBestPerPage.set(target.page, newVersion);  // style repair
```

**Walkover.** `pickBestVersionIndex` silently skipped versions with no score,
and the pipeline deliberately stores some originals unscored ("eval only runs
on the promoted image"). A repair did not have to win — it won because what it
replaced had no number to lose with. Observed: p8 shipped **38** over an
original scoring **58**; p13 shipped **−145** over **−70**.

**Blind repair.** `decideRepairMethod(pageNumber, latestEval || {}, ...)`. With
an empty evaluation every gate is a numeric comparison — `visualScore < 50`,
`semanticScore < 30` — and `undefined < 50` is false, so all gates fall through
and a method is chosen from nothing.

**The threshold that hid it.** The pass that scored unscored versions ran only
when the best score was already below 60. Above that line the unscored original
stayed unscored and silently unbeatable. The threshold is gone: if an image is
a candidate it is scored, and if it is not scored it is not a candidate.

---

## 4. The repair decision — `repairLogic.js` (312 lines)

`decideRepairMethod(pageNumber, evaluator, entityReport)` returns one method.
In precedence order:

1. `spec_conflicts` present → **iterate** (no render can fix a broken contract)
2. `visualScore < 50` → **iterate**
3. `semanticScore < 30` → **iterate** (wrong scene)
4. any CATASTROPHIC finding → **iterate** (this is what routes nudity to a full regen)
5. otherwise → inpaint / char-fix / skip by issue shape

**Simplification available:** rules 2 and 3 are numeric gates on subscores that
no longer come from a model — both are now derived from the same defect list
that rule 4 reads. Rules 2–4 could collapse into one severity test.

---

## 5. What still stands between here and "simple"

Ordered by how much complexity each removes.

1. **`images.js` is 15,337 lines.** Generation, evaluation, repair, selection,
   covers, compositing, bbox, style repair and text-space repair in one file.
   Everything above was hard to find for this reason alone. Splitting it is the
   single biggest simplification available.
2. **`evaluateImageQuality` takes 10 positional parameters**, the tenth being an
   options bag. `callGeminiAPIForImage` takes 17. Threading anything new through
   them is why the clothing contract had to be built inside the function.
3. **Three severity tables** exist on purpose (`SEVERITY_POINTS`,
   `RANK_SEVERITY_WEIGHT`, and the 0–10 `SEVERITY_PENALTY` in `images.js`). The
   0–10 one survives only because `qualityScore` and the repair gates still speak
   that scale. Retiring the 0–10 scale would remove a table and a conversion.
4. **`rawScore` still means two things** — on evaluation results it is the 0–10
   visual score. Rename to `visualScore10`.
5. **`scoreModel: 'prompt'`** in `models.js` is inert and its value is a lie.
6. **The clothing backstop gate counts words, not garments** —
   `hits.size < 2` at `storyHelpers.js:4944`. On page 10 of the last run it
   scored 9 hits from a hat and the words `across`, `folded`, `sides`, `left`,
   `fold`, concluded the child was dressed, and let a prompt with no bottom
   garment reach the image model. `clothingCheck.js` already has `splitSlots()`
   and `slotStated()` that do this properly.

---

## 6. The pipeline, end to end

```
generate ──> evaluate (4 evaluators -> defects) ──> applyScore -> finalScore
                                                          │
                                              finalScore < 60?
                                                          │
                                    decideRepairMethod ──> iterate | inpaint | char-fix
                                                          │
                                          generate repair ──> evaluate ──> applyScore
                                                          │
                                          pickBestVersionIndex -> highest wins
```

Repair rounds: **1 on staging, 3 on production** (`REPAIR_DEFAULTS.maxPasses`,
keyed on `RAILWAY_ENVIRONMENT_NAME`).

---

## 7. Simplification backlog after the split (2026-08-09)

State at time of writing: `images.js` 15,334 → 8,861; seven modules extracted;
five stale-import bugs found by destructure audit and fixed (`5ee87e072`).
Everything below is KNOWN, DELIBERATE residue — parked for the post-showcase
round, not forgotten.

### A. Core loop and the god-file (biggest payoff)

1. **Hoist the ten closures in `runUnifiedRepairPipeline`** into named step
   functions taking an explicit context (evaluate, consolidate, iterate,
   inpaint, charFix, selectBest, rescue, textSpace, styleAudit, finalize).
   The move made the loop findable; this makes it readable. Deferred so a
   behaviour change could not hide inside the 2,246-line move diff.
2. **Break the generation↔evaluation cycle.** `callGeminiAPIForImage` calls
   `evaluateImageQuality` internally (2 sites). Generation should generate and
   return; the CALLER evaluates. This cycle is the reason all five lazy-require
   accessors exist — remove the cycle and they all become plain imports.
3. **`evaluateImageQuality` (1,058 lines, 10 positional params).** Split into
   evaluator dispatch / parse / record; replace the parameter list with one
   options object. The clothing contract had to be built INSIDE it precisely
   because threading an 11th parameter was untenable.
4. **`generateImageWithQualityRetry` (761 lines)** — same treatment; the
   second-widest fan-out in the file.
5. After 2–4, the remaining `images.js` clusters (dispatch, evaluation, bbox)
   separate cleanly; the file should land well under 4k lines.
6. **`inpaintPage` (461 lines)** has one caller (the pipeline). Move next to
   its caller or into `imageInpainting.js` once the cycle is broken.

### B. Scoring residue

7. **Three severity tables.** `SEVERITY_POINTS` is canonical. The 0-10
   `SEVERITY_PENALTY` survives only because the repair gates' visual/semantic
   subscores speak 0-10 (gates measured as load-bearing — 81/520 fire alone —
   so retire the SCALE by deriving the subscores from SEVERITY_POINTS, not by
   deleting the gates). `RANK_SEVERITY_WEIGHT` is the tiebreak, documented.
8. **Five deduction buckets.** `consolidated` vs raw quality/semantic/compliance
   already caused one bad measurement (the 4-of-5 bucket error corrected in
   `c2da7262a`). Either always consolidate, or store one flat `issues[]` with a
   source tag. One shape, one query.
9. **`evalScore`** = finalScore + entityPenalty — a derived field readers could
   compute. `scoreBreakdown` and `deductions` are two representations of the
   same issues. Candidates to collapse after the UI's reads are audited.
10. **Version-object weight**: retryHistory, entityHistory, grokRefImages,
    thinkingText, compositeDebug… audit which fields the dev panel actually
    reads and stop persisting the rest.

### C. Small and mechanical

11. `IMAGE_MODELS` imported unused in `repairPipeline.js`.
12. `detectGrokBorder` moved with compositing but has zero callers — delete.
13. `resolveOutputAspect`, `truncatePromptForModel`, `extractDataImageUrls`,
    `detectionForVersion` are exported for tests only — mark or move to a
    test-support module.

### D. Clothing / prose checks

14. **Two thresholds for "is this character dressed"** — the reviewer tolerates
    partial omission (measured: faulting partials fired on stories scoring
    74/84), the prompt-check demands top+bottom+footwear. Intentional, but the
    asymmetry lives in two files; keep both callers on `missingGarments` and
    document the divergence in ONE place.
15. **`characterProse()` depends on the `Name — … —` format.** If the writer's
    format drifts, the check silently falls back to whole-page prose — the very
    cross-character contamination it was built to fix. Consider a loud fallback.
16. **Verify the writer fix**: re-run the sweep from `eea385113`; the 61.5%
    outfit-omission rate must drop sharply. The next showcase produces the data.

### E. Process

17. **The destructure audit must outlive this session.** Five real bugs came
    from parallel-agent commits invalidating a completed repoint sweep. The
    audit script (~40 lines) should become a unit test that requires each
    lib module and verifies every cross-module destructure resolves — cheap,
    and it turns the shared-tree hazard into a red test instead of a runtime
    TypeError.
