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
