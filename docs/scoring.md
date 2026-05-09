# Image scoring & version selection

Single source of truth for how every page or cover image is scored, when
a version is replaced, and which version becomes "active" for the user.

## The scoring chain

Every image goes through up to four evaluators. Their scores are combined
into one canonical `finalScore`.

| Evaluator | Range | Runs on | Penalises |
|---|---|---|---|
| **visual** | 0–100 | scenes + covers | composition, lighting, anatomy, text rendering (covers) |
| **semantic** | 0–100 | scenes only (covers have no story text) | story-text fidelity |
| **threeStage** | 0–100 | scenes only | vision inventory + Sonnet compliance |
| **entity** | penalty 0–∞ | scenes only | per-character consistency across pages |

The composition rule:

```
evalScore  = MIN(visual, semantic, threeStage)   // worst wins
finalScore = MAX(0, evalScore − entity.penalty)
```

Covers naturally collapse to `finalScore = visual` because semantic /
threeStage are `null` and entity penalty is 0.

## Per-version data shape

Every entry in `imageVersions[]` (scenes and covers alike) carries:

```js
{
  versionIndex,
  imageData,              // R2 URL post-Phase-2
  modelId, prompt, ...    // generation metadata

  // Canonical score fields — ALL written by lib/scoring.js helpers,
  // never inline in routes:
  scoreBreakdown: {
    visual:     { score, reasoning, issues: [...] },
    semantic:   { score, issues: [...] } | null,
    threeStage: { score, issues: [...] } | null,
    entity:     { penalty, issues: [...] },
  },
  evalScore,              // composeEvalScore(scoreBreakdown)
  entityPenalty,          // breakdown.entity.penalty
  finalScore,             // composeFinalScore(scoreBreakdown)

  // Audit-only:
  rawQualityScore,        // pure Gemini visual, before any merge
}
```

`finalScore` is the **only** number that decides redo gating, version
picking, and what the user sees. Everything else is breakdown for
diagnostics.

## Active version

`image_version_meta.{pageNumber|coverType}.activeVersion` is a CACHE,
not a source of truth. It is recomputed on every save by
`recomputeAllActiveVersions()`:

1. For each scene + cover with at least one scored version,
2. `pickBestVersionIndex(versions)` — `argmax(finalScore)`, ties broken by
   later index wins (newer typically incorporates later repairs),
3. Persisted via `setActiveVersion()`.

Routes that push a new version still call `setActiveVersion(latestIdx)`
for *immediate* UI feedback, but the canonical recompute that runs at
end-of-save corrects it after evaluation lands.

## Manual repair workflow vs automatic pipeline

Same scoring rules, same picker. Both paths terminate in
`saveStoryData` / `upsertStory` / `saveScenePageData`, all of which call
`recomputeAllActiveVersions()` before returning. There is no separate
"manual pick best" step — the pick is implicit in every save.

The user-facing `RepairWorkflowPanel` "Run Full Workflow" button still
exists for re-evaluating + reissuing redos, but the pick-best step it
calls now reads from the same code path as the unified pipeline.

## Module layout

```
server/lib/scoring.js          Pure helpers + DB-side recompute
server/lib/repairLogic.js      findBadPages — uses computeFinalScore
server/lib/images.js           evaluateImageQuality — emits scoreBreakdown
server/routes/regeneration.js  Endpoints call recomputeActive… after save
server/services/database.js    saveStoryData/saveScenePageData/upsertStory hook
tests/unit/scoring.test.js     Pure-function unit tests (21 cases)
docs/scoring.md                This file
```

## Threshold tuning

Defaults in `server/config/models.js → REPAIR_DEFAULTS`:

```js
scoreThreshold: 60   // pages below this finalScore get a redo
issueThreshold: 5    // ≥ this many fixableIssues triggers redo even at high score
maxPasses: 3
maxCharRepairPages: 3
```

Defaults inside `lib/scoring.js → SCORE_THRESHOLDS` mirror those values
and act as the fallback when the config block is missing.

## Testing

`tests/unit/scoring.test.js` — pure-function unit tests:

- Modern shape, intermediate shape, legacy shape compute equivalent
  finalScores.
- Cover-style breakdown collapses to visual.
- Scene-style breakdown picks `MIN(visual, semantic, threeStage)`.
- Entity penalty subtracts from MIN.
- `pickBestVersionIndex` returns -1 for un-scored arrays.
- The exact production v3 scenario (q80/p60 vs q50/p30 tie at finalScore=20)
  picks v2 (later index), not v3 (the unevaluated last-pushed).

Run:

```bash
node tests/unit/scoring.test.js
```

Integration test (manual): create a story, force three iterations on a
cover so `imageVersions.length === 4`, then check `image_version_meta`
matches `pickBestVersionIndex(imageVersions)`.

## Adding a new evaluator

1. Run it inside `evaluateImageQuality` (`server/lib/images.js`).
2. Pass its `{ score, issues }` into `buildScoreBreakdown({ ..., yourField })`.
3. Decide whether it contributes to `evalScore` (joins `MIN`) or to a
   penalty (subtracted after `MIN`). Edit `composeEvalScore` /
   `composeFinalScore` once. No other code changes needed.

The breakdown is shipped to the dev panel verbatim, so the new component
shows up in the per-version diagnostic UI without further plumbing.

## Migration & legacy data

Stories generated before this module existed have versions with `score`
or `qualityScore` fields, no breakdown. `computeFinalScore()` falls back
through the legacy chain:

```
finalScore  →  evalScore − entityPenalty  →  score − entityPenalty  →  qualityScore − entityPenalty
```

Same chain everywhere. The next time those stories are saved, the
recompute hook stamps the canonical fields on every version.
