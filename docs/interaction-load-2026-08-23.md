# Interaction load vs image outcome — measured, 2026-08-23

**Status:** measured finding, no behaviour changed yet. Nothing here is a decision;
if any of it changes the pipeline, that change gets its own `docs/decisions.md` entry
citing this file.

## What was measured

Two completed production stories, read from `stories.data` (no regeneration, no paid calls):

| story | job id | pages |
|---|---|---|
| Levin und der kleine Drache | `job_1787436913379_mfedxinwqd` | 18 |
| Kapitänin Fiona und die Goldene Möwe | `job_1787423677246_r9llf5yi9` | 16 |

34 pages, 60 rows in `sceneMetadata.interactions`. A row counts as **failed** when the
semantic evaluator raised an `action_interaction` or `wrong_interaction` finding naming
that character on that page (`semanticResult.semanticIssues`).

Reproduce: `node scripts/analysis/interaction-load.js` (writes `pages.json` + an HTML
gallery of every page with its rows and images).

## Headline

`action_interaction` is not one failure among many — it is 36 of the 68 semantic findings
across both books. The single strongest predictor of a page failing is:

> **number of DISTINCT pose instructions × whether any of them puts a character's hands
> on an external fixed object.**

Cast size drops out entirely once that is controlled for.

## The interaction table

Interaction rows hand-classified into five groups; per-row flag rate:

| group | what it asks for | rows | flagged | rate |
|---|---|---|---|---|
| HANDS_ON | hands on an object (tiller, hull, door, rigging, an animal) | 16 | 14 | **88%** |
| GESTURE | point, reach, shout, hand held out | 10 | 6 | 60% |
| GROUP | one row fusing 2–4 characters | 5 | 3 | 60% |
| POSTURE | stands / sits / crouches / walks, placed somewhere | 18 | 4 | 22% |
| GAZE | looks at, watches, stares toward | 11 | 2 | 18% |

The two HANDS_ON rows that survived are both a character holding something they already
carry ("one hand resting flat on the earth", "holds the shovel across her body"). All 14
failures are hands on an **external fixed object**.

## The interaction is multiplicative, not additive

Page-level average semantic score:

| | 1 distinct instruction | 2 | 3 | 4 |
|---|---|---|---|---|
| **no hands-on** | 70 (n=9) | 74 (n=6) | 70 (n=2) | 40 (n=1) |
| **hands-on** | 47 (n=3) | **18 (n=7)** | 38 (n=2) | 30 (n=1) |

Without a hands-on row, adding instructions costs nothing. With one, the second
instruction collapses the page. Neither factor alone explains it.

## Cast size is not the driver — shared instructions are

| people given a pose line | distinct instructions | n | avg sem | pages ≤50 |
|---|---|---|---|---|
| 4 | 1 (all the same) | 2 | **70** | 0/2 |
| 4 | 3 | 1 | 80 | 0/1 |
| 4 | 4 (each different) | 2 | **35** | 2/2 |
| 5 | 2 | 2 | 40 | 1/2 |
| 1 | 1 | 10 | 63 | 4/10 |
| 2 | 2 | 11 | 45 | 6/11 |

Four people all told the same thing is one of the safest page shapes in either book. Four
people each told something different is one of the worst. Same cast size.

Splitting "N rows of the same TYPE" from "N rows of DIFFERENT types" gives 41 vs 41 — the
type label does not matter, the count of distinct instruction sentences does. Two people
both told "presses palms flat against the hull" (Fiona p8) still failed: same type, two
separate lines.

## Hypotheses tested and NOT supported

- **Posture stacking.** 0 posture rows → 53, 1 → 44, 2 → 78, 3 → 50. No trend.
- **One character can carry fewer instructions.** cast 1 × 1 int = 68 (n=6),
  cast 1 × 2 int = 78 (n=2). No penalty visible.
- **Mandating an interaction ("essential") causes the failure.** Raw rates look decisive
  (essential+storyRelevant 60% flagged vs low 13%) but it is a total confound: all 16
  HANDS_ON, all 10 GESTURE and all 5 GROUP rows are essential/normal, zero are `low`.
  In POSTURE — the only group with both — essential is 25% and low is 20%. No difference.
  **Untestable from stored data; needs a Test Lab A/B.**

## Mechanism: what the pipeline actually does with these rows

`buildExactPosesBlock()` — `server/lib/promptBuilders.js:3400`:

- `priority` only **sorts** the block. `essential`, `normal` and `low` all emit the same
  imperative bullet `- Name: does X`. Nothing marks a row optional, so "the model could
  pick 1 of 5 suggestions" is not a behaviour that currently exists.
- A fused row ("A + B + C") is **split into one line per character** with the shared
  `where`. So the fused-row advantage is not fewer lines — it is that everyone receives
  the *same* line.
- Characters with no interaction get a filler line
  (`- Name: looking off into the scene, not at the viewer`).

## Rules that already exist in the Art Director template and were violated

**The live template for both stories is `prompts/scene-expansion-all.txt`** (beats pipeline
expands all scenes in one call, commit `d39f47beb`) — verified by matching the stored
`sceneDescriptionPrompt` against both files. `prompts/scene-expansion.txt` carries the same
four rules at different line numbers; any edit must patch both.

| line (`-all`) | rule | observed |
|---|---|---|
| 166 | `where` names the object as the contact action — **"No body-part positioning, no pose detail."** | Every failing row is body-part positioning ("presses both palms flat against the hull", "pushes both hands flat against the hatchling's back"). |
| 168 | Shared objects → ONE entry, names joined with ` + ` | Fiona p8: two characters pushing the same hull emitted as two entries. sem 0. |
| 174 | **"A vehicle under way MUST have exactly one character actively operating it — declare that operation as an essential interaction."** | Puts a hands-on-external-object pose line on every page where the boat is moving. The operator row appears on p5/p6/p7/p16 and **failed 4/4.** |
| 176 | Cap 1–6 entries, 0–2 `storyRelevant` | Respected — but the cap counts *entries*, not distinct pose lines, which is the axis that predicts failure. |

**The vehicle rule was deliberately adopted and benchmark-validated** (`51ab02ebd`,
Test Lab exp 63: operator present 3/3 on the vehicle page, 4/4 non-vehicle pages clean of
vehicle language). It solves a real defect — a vehicle under way with nobody at the helm.
Removing it outright would regress that. Note also that the Art Director did **not** obey
the `essential` half of the rule: all four operator rows were emitted as `normal`. Since
`priority` only sorts the EXACT POSES block, that made no difference downstream — the
failure comes from the pose line existing at all, not from its priority.

## Second, independent finding: semantic failure does not trigger a redo

`scoreThreshold: 50` (`server/config/models.js:711`) gates redos on `finalScore`, which is
`100 − Σ SEVERITY_POINTS` over *consolidated* deductions. The consolidator merges the
evaluators' findings, so a page can fail semantics outright and land above the gate.

Fiona p5: semantic 0, six raw findings → 1 critical + 2 major consolidated → **finalScore
60**, shipped on the first try.

**9 of 34 pages had semantic ≤50 and were never regenerated:** Drache p11/p12/p13,
Fiona p3/p4/p5/p6/p7/p11. Two of them scored a flat 0.

## Beats-review already catches these pages and nothing happens

`prompts/story-beats-review.txt:45` ("Illustratable") lists exactly these shapes —
*"synchronized hands of two characters on one object"* — and the reviewer named them
correctly in both runs:

> Drache: *"Page 16 is a hard two-on-one tangle (both brothers' hands on the dragon)."*
> Fiona: *"Page 5 is an acrobatic mid-vault. Page 8 packs stuck / indecision / shout /
> find oars / walk free."*

Every page it named is in the failure list. The instruction "rewrite those into their
nearest simple tableau" was not executed — the review is diagnostically accurate and
behaviourally inert.

## Attempted fix — Test Lab exp 815, INCONCLUSIVE (2026-08-23)

Four changes to both Art Director templates (commit `7393ef1f7`), A/B'd on staging against
the Fiona story: arm A = the deployed template, arm B = the edited one via `promptOverride`.
13 targets ran (2 blocked by `IMAGE_OTHER`, 1 lost when the run was killed).

| | A (deployed) | B (edited) |
|---|---|---|
| interaction rows | 27 | 27 |
| rows with body-part detail | 15 | **10** |
| rows with a contact verb | 18 | **14** |
| rows marked `essential` | 19 | 17 |
| fused multi-character rows | 0 | **0** |
| mean semantic | 57 | 52 |

**Verdict: the briefs change, the images do not.** Body-part detail drops by a third but 10
violations remain; the shared-object fusion rule produced zero fused entries in either arm and
is inert; mean semantic is flat (B wins 5 of 11) and the three controls split 1–2, so there is
no evidence it protects good pages either. Do not promote to master on this evidence.

**The dominant lesson is variance, not the verdict.** Arm A scored 100 on p7 and 0 on p12 —
pages that scored 20 and 60 in production under the *same* template. Run-to-run noise in the
generator and evaluator is larger than the effect being measured. Any future prompt A/B on this
path needs repeats per page; single-page before/after comparisons here measure nothing.

Not tested: the Drache story's three hands-on pages (that story is not on staging).

## Caveats

- Two stories. Several cells are n=1 or n=2 and are marked as such; the HANDS_ON result
  (16 rows, 88%) and the hands-on × instruction-count interaction are the only cells with
  enough rows to lean on.
- Group labels are hand-assigned by reading each `where` sentence. A first pass used a
  regex over `where` and produced false positives ("holds Lorena's gaze" counted as
  contact, and it scored 100). The hand-labelled version is what is reported here.
  These labels are an analysis aid only — nothing in the pipeline classifies rows this
  way, and per the owner's scoring rule it must not.
