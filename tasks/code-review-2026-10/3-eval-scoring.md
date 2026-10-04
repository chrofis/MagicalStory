# Area 3 — Eval + scoring (review 2026-10-04)
Files: evalPipeline (+ images.js eval range), scoring, entityConsistency, textRegion. Finders: 2 × Sonnet; verifier: Opus.

None of the confirmed items is already in `tasks/BACKLOG.md`, `tasks/bugs.json`, `docs/decisions.md` or `docs/SETTLED.md`. (bugs.json:497 is a different, already fixed bug: zero semantic coverage on whole stories.) textRegion.js: both finders found it clean, and I did not re-review it.

## Confirmed

### A1 A failed semantic judge counts as a clean pass
Severity: moderate. Default path, rare, and it does happen in stored data.
`server/lib/sceneValidator.js:943/951/1021/1031/1052/1055` returns `{score:null, semanticIssues:[], error}` when parsing fails, on an API error, or when the Grok fallback fails. `server/lib/evalPipeline.js:3711-3745` merges that as zero penalty. Nothing reads `semanticResult.error`, and no `notEvaluated` record is written; the only record is for the no-reference case at :2572. The page's `semanticScore` is null, and `repairLogic.js:865-878` reads null as `?? 100`. So a page whose scene judge never ran is scored, ranked and routed exactly like a page the judge cleared. A wrong-scene page then skips the "iterate" route and ships unrepaired.
Evidence: a read-only DB check over the last 120 days found `semanticResult.error` set on 2 of 507 prod pages and 4 of 1260 staging pages. Each of those pages was silently scored as semantically clean.
Fix direction: when `semanticResult.error` is set, write `notEvaluated.record('semantic_fidelity', 'judge_failed', error)`, the same contract the compliance judge already follows. Whether that page should also be re-judged is the owner's call.

### B1 A crash of the whole entity check reports `overallConsistent: true`, and the caller's fail-closed handler never fires
Severity: moderate. Reporting only; no wrong repair.
At `server/lib/entityConsistency.js:1754-1758`, the top-level `catch` only sets `report.error` and then returns the report. `overallConsistent` was set to true at :863 and stays true. The summary stays `''` when the throw comes before the summary is built. The function therefore never rejects. That makes the deliberate fail-closed `.catch` at `repairPipeline.js:799-824` unreachable dead code; it was written because "a crash of the WHOLE check shipped the book with a report claiming every entity matched". The per-round caller at `repairPipeline.js:2713-2750` merges the half-built report as a success. Nothing in server or client reads `report.error`. Penalties are unaffected, because no issues means no charge either way. But the stored report and the dev panel show a verified-consistent book that was never checked, which is the exact failure the caller comment describes.
Evidence: code read. The DB check found no stored reports with `finalChecksReport.entity.error`, so this has not been seen in the wild.
Fix direction: rethrow from the top-level catch, or set `overallConsistent:false, evalFailed:true` there to match the caller's fail-closed shape. Pick one owner of the fail-closed logic.

### B3 A per-grid judge failure loses `evalFailed`, and a later round merge then turns it into a clean result
Severity: moderate. Reporting and metrics only.
When Gemini fails, `evaluateEntityConsistency` returns `evalFailed:true, consistent:false` (:3237-3245). Two places drop that flag:
- The `byClothing` record at :1380-1396 copies `consistent`, `score` and `issues`, but not `evalFailed`.
- The multi-grid merge at :1301-1313 spreads only `gridResults[0].evalResult`.

`report.characters[x].evalFailed` is therefore set only when a whole character throws (:1337). As a result, `failedCount` in the summary (:1735) and the Lab's `evalFailures` (`testlab.js:2521`) both stay 0 during a Gemini outage. It gets worse after repair rounds. `mergeEntityIssues` (`repairPipeline.js:283-293`) recomputes `overallConsistent = total === 0 && !merged.evalFailed`, and per character `overallConsistent: issues.length === 0`. A grid that failed and found zero issues therefore becomes "consistent" in the merged report. This is exactly what that function's own comment says must not happen. Until such a merge, the initial report does stay `overallConsistent:false`, through `consistent:false`.
Fix direction: carry `evalFailed` onto `byClothing[...]` and the character entry, and OR it across the grids of a multi-grid merge.

### B2 A failed meta read makes the recompute overwrite every user pin
Severity: minor, because it needs a transient DB error. It breaks the pinning contract and the no-fallback rule.
In `server/lib/scoring.js:1184-1195`, if `getActiveVersionMeta` throws, the error is swallowed with the comment "Non-fatal: without meta we recompute everything (pre-pin behaviour)". `versionMeta` becomes `{}`, so `metaEntry` is `null`, which is not `undefined`. The `meta?.pinned` guard at :1146-1148 then never trips, and `setActiveVersion` overwrites every pinned page and cover with the score-best version, with no log line. The user's manual version picks are silently reverted.
Fix direction: let the error propagate, or skip the recompute for that story and log an error. Never recompute without the pin map.

### A5 An early `return null` from the quality eval wastes the semantic and inventory calls already launched
Severity: minor. Money on the failure path only.
The semantic judge (:2577) and the blind inventory (:2626) start before the quality call. The early returns at `evalPipeline.js:2926-2933` (references not attached), :3005 (HTTP error), :3084-3099 (Grok fallback failed) and :3125-3140 (MAX_TOKENS / no text) leave those paid calls running unawaited, and their results are discarded. The caller's re-eval then pays for both again. Both functions catch internally, so there is no unhandled-rejection crash. The three-stage figure promise would hang, but that judge is off by default (SETTLED).
Fix direction: start the side calls after the reference-attach check, and/or await or settle them before returning null.

### B4 A character whose crops all fail to extract disappears from the entity report
Severity: minor.
`extractEntityCrops` swallows each per-page failure (:2528-2530). When fewer than `minRequired` crops survive, the task returns `null` (:1109-1113). Phase 3 skips nulls (:1329), and the cleanup at :1591-1596 deletes any character with no `byClothing` entry. Groups below `minRequired` appearances are already filtered when tasks are built, so reaching this point means extraction failed. The character is then not marked `evalFailed` and has no `notEvaluated`. The summary reads "All N entities are consistent", where N silently excludes it.
Fix direction: return `{error: 'crop extraction failed (k/n)'}` so the existing fail-closed branch at :1333 records it.

### B5 A judge reply in the wrong shape defaults to consistent and is not retried
Severity: minor.
At `entityConsistency.js:3217-3220`, `consistent: parsed.consistent ?? true, score: parsed.score ?? 10`. Any reply that parses as JSON but lacks the fields counts as a clean pass with no issues. Examples are an array, `{}`, or an error object. The retry loop at :3118 retries only replies that do not parse at all. The comment directly above it says this check must never fail open.
Fix direction: treat a parsed object with no `consistent` boolean as an unparseable reply, so it is retried and then fails closed.

### A2 The Grok fallback quality verdict is labelled and priced as Gemini
Severity: minor. Rare path: Gemini blocks twice.
At `evalPipeline.js:2726`, `let modelId` carries the comment "may be reassigned to fallback model", but the Grok branch at :3067-3099 never reassigns it. The result at :3937 reports `modelId: 'gemini-…'`, so those tokens are booked and priced at Gemini rates, and the provenance of that score is wrong.
Fix direction: set `modelId = grokFallbackId` when `data = grokData`.

### A3 Cover `textIssue` is derived by regex over the finding text, and nothing uses it
Severity: minor. Dead code, but it breaks the project rule that classification belongs to the prompt.
`evalPipeline.js:3468-3488` sorts cover findings into TITLE_ERROR or STRAY_TEXT. It does so with `TEXT_RE`, where the `\bsign` pattern also matches "significant", and with `issuesSummary.includes('text')`, which also matches "texture". The comment claims TITLE_ERROR forces a full regeneration. In fact nothing branches on `textIssue`: it is only passed through at `images.js:2164/2181/3331` and `routes/stories.js:935`. Behaviour is unaffected, but the comment is false and the code is the kind of prose matching that CLAUDE.md forbids.
Fix direction: delete it. If cover title routing is ever wanted, use the `rendered_text` type plus severity, with no prose matching.

### B7 `repairSinglePage` builds a prompt from `entity-single-page-repair.txt` that is never sent
Severity: minor. Dead code that misleads anyone editing the template.
`entityConsistency.js:3665-3681` builds `prompt`, falling back to `buildFallbackSinglePagePrompt` at :3831. The actual repair call, `repairCharacterMismatch` at ~:3715, builds its own prompt. Edits to that template, or to the fallback builder, therefore have no effect.
Fix direction: delete the unused prompt, the fallback builder and the template load, after checking that no other code loads the template.

## Plausible (needs a data check or run to settle)

### A4 A defect report with `figures` but no `fixable_issues` array scores 100
Severity: minor.
At `evalPipeline.js:3205-3231`, `isDefectReport` accepts a reply that has only `figures`, `verdict` or `coherence_gate`. When `fixable_issues` is absent, `parseFixableIssues` (:1687) returns `[]`, so the score is a clean 100 with no `notEvaluated` record. The prompt asks for the key, so this needs the model to drop it.
To settle: count stored `qualityRawOutput` values that contain `"figures"` but not `"fixable_issues"`.

### B6 Pages with no named figure re-run bbox detection on every entity pass
Severity: minor. Cost and latency.
At `entityConsistency.js:1943-1946`, re-detection runs whenever `identifiedCount === 0`, even when the cached detection came from an earlier detection on the same image (`img.bboxDetection = detection`, :2083). A page whose expected figures never get a name pays for detection again on every pass. Repair rounds only re-check repaired pages, which limits how often this repeats.
To settle: count "Running fallback bbox detection" log lines per page per story in a Railway log. If any page shows more than one, this is confirmed.

## Rejected
None outright. Several findings were inflated, and I corrected them above:
- B3 was not "silent clean on outage" in the initial report: `consistent:false` still makes it fail closed there. The clean result appears only through the round merge.
- A5 does not crash: both side calls catch internally, and the hanging promise only matters with the compliance judge, which is off by default.
- B1/B3 were rated "major" by the finder. They do not change penalties or repairs, so they are reporting-integrity bugs, not damage to the user's book.
