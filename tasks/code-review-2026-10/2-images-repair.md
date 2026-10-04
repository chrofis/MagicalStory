# Area 2 — Images + repair (review 2026-10-04)

Files: images, grok, coverIterate, wornItems, routes/regeneration, repairPipeline, repairLogic, sceneComposite, bboxDetection, figureDetection, storyAvatars, character2x4Sheet. Finders: 4 × Sonnet; verifier: Opus.
Not fully read: images.js 1-1280 (prompt-shrink code) and 2859-3379 (eval) by finder A; repairPipeline/repairLogic only by finder D, not by B. The verifier read only the cited regions.

Read-only DB checks used (prod + staging): the credit_transactions ledger, figure-detection diagnostics, stored `perspective` strings, version `scoreSource`, and the active-version state of user edits.

## Confirmed

### B3 Paid scene "regenerate" and "edit" versions are not pinned, so the book can keep showing the old image
Severity: major (user pays, then gets the old picture back).
Where: routes/regeneration.js:1019-1023 (regenerate/image) and 3653-3662 (edit/image). Both save the new version and leave the choice of active version to `recomputeActiveVersion` (best score wins, tie goes to the earliest).
Failure: the client shows the new image right away (StoryWizard.tsx:5052). Reloads, the PDF, print and share links resolve the active version from `image_version_meta`. When the new version scores lower than an older one, those keep showing the old image, even though the user was charged 2 credits.
Evidence: the sibling cover regen, cover edit, iterate, scale-repair and style-transfer routes all pass `{ pinned: true }`. decisions.md:22154 states that "every interactive flow (manual pick, iterate, regen, style-transfer) PINS its choice". Prod data over 400 days: of 19 pages whose newest version is a user `edit`, 9 are not the active version and none is pinned. For `regeneration` it is 1 of 2.
Fix: call `setActiveVersion(id, page, newIdx, { pinned: true })` after the save on both routes, as cover regen does.

### C1 Removing a duplicate mask shifts indices, so later figures get the wrong name
Severity: major (silent identity error; the detector is the identity master).
Where: figureDetection.js:1995-2002 (`dets.splice(i, 1)`), then 2128-2130 (`nameByDet.get(j)`) and 2157 (`occludedByIdx`). `nameByDet` and `occludedByIdx` are keyed by the original `persons` index.
Failure: when two masks cover the same figure, one det is spliced out. Every figure after it then reads the name of the next person, or `UNKNOWN`. Character repair, the entity check and figure crops then work on the wrong person. The `occludedBy` lists are also off by one.
Evidence: the hazard is described at figureDetection.js:1394 and decisions.md:7003, but it was only worked around for the second-opinion path ("keying off the figures"). The primary path still indexes by the shifted `j`. Over the last 150 stories, the splice fired on 3 of 267 prod pages and 23 of 1,186 staging pages that carry GDINO diagnostics. It only mis-names a figure when the dropped det is not the last one.
Fix: carry each det's original person index (`d.personIdx`) and look names and occluders up by that index, not by array position.

### B1/B2 Three credit deductions skip `RETURNING`: a ledger row is written even when nothing was charged
Severity: minor (latent; no case found in the data).
Where: regeneration.js:6557 (character repair), 2612 (cover iterate) and 2977 (page iterate). Each runs `UPDATE ... AND credits >= $1` with no `RETURNING`, then always inserts a `credit_transactions` row with `balance_after = staleSnapshot - cost`.
Failure: concurrent requests, or a balance change during a long render, give a free render plus a ledger row with a false or negative balance. Character repair is worse. Its pre-check (5493) only checks the cost of one page, but it charges `pages × 2`. A direct API call with several pages or `autoSelect` therefore gets a free multi-page repair. The UI sends one page per call for normal users (StoryWizard.tsx:5418), and the multi-page panel is developer mode only.
Evidence: this is a partial fix of review-2026-07-04 BILL-1. Its sibling at regeneration.js:1030-1045 does it right. In prod and staging, `credit_transactions` has 0 rows with a negative `balance_after` other than -1.
Fix: copy the BILL-1 pattern (`RETURNING credits`, ledger row only on success) to all three sites, and make the character-repair pre-check cover the requested page count.

### A2 Iterating a trial back cover renders on the edit tier, not the cover tier
Severity: minor (trial stories only, back cover only).
Where: coverIterate.js:1369. `imageModelOverride: titleModeInfo.bakedModel || imageModel || null`. The route passes `imageModel || null` (regeneration.js:2434), and `bakedModel` is set for the front cover only (coverTypography.js:49).
Failure: an iterated trial back cover falls back to `generateImageOnly`'s default `MODEL_DEFAULTS.pageImage` (`grok-imagine`, the edit tier) instead of `coverImage` (`grok-imagine-2`). The version is still recorded as `coverImageModelId = MODEL_DEFAULTS.coverImage` (2457). `iterateCover` is reached only when `coverIteratePath` returns 'trial' (coverBeats.js:195-199).
Fix: pass `imageModel || MODEL_DEFAULTS.coverImage` at 2434, as the regenerate route at 3261 already does.

### C3 The iterate path has its own copy of the cell-crop loop, which drops the close-up head crop
Severity: minor.
Where: images.js:5237-5290 is an inline copy of `applyStoryCellRefs` (storyAvatars.js:300+). It is live, because `useStorySheetCells` defaults to true (images.js:4366).
Failure: on a close-up page (`shot === 'close-up'`), an iterate sends the full-body stacked cell. The pipeline and regenerate send the head-only crop (`headOnly`, storyAvatars.js:343), and the comment there says the full body pulls the render toward full-figure poses. The copy also skips missing sheets silently with `continue`, where the shared function warns loudly.
Fix: call `applyStoryCellRefs(referencePhotos, storyData.characterAvatars, metaChars, { closeUp, wornResolved })` and delete the copy. Add the pair to the sibling registry.

### C4 The mask depth-order tie-break computes the area of an index, which gives NaN
Severity: minor.
Where: figureDetection.js:668. `return _boxAreaPx(a) - _boxAreaPx(b);`, where `a` and `b` are indices, not boxes.
Failure: the comparator returns NaN, which `sort` treats as 0. For same-height boxes where neither contains the other, the intended smaller-box-in-front rule never applies, and detection order decides who wins the contested pixels.
Fix: `_boxAreaPx(boxesPx[a]) - _boxAreaPx(boxesPx[b])`.

### D1 The POST-REPAIR-TEXT calm-zone re-render can never win
Severity: minor (it runs only on `textInImage` stories, which are developer-override only since 2026-09-05, per runtime.js:180-185).
Where: repairPipeline.js:3146-3181. The new version copies `best.evaluation`, which carries `evalImageFp` for best's bytes (images.js:3289). `applyScore` copies that fingerprint (scoring.js:725), and `pickBestVersionIndex` then refuses the score because the hash does not match (scoring.js:1078-1084).
Failure: the paid re-render is always logged as "bytes do not match the evaluated fingerprint" and the old version ships.
Fix: re-evaluate the recovered image, or at least do not carry the predecessor's fingerprint. A score inherited from different bytes is exactly what the guard exists to stop.

### A1 A failed primary Grok call makes a second Grok call, with reduced packing, before Gemini
Severity: minor.
Where: images.js:1548-1556, 1721 and 1760-1800. When the primary Grok call fails, `modelId = imageModelOverride || defaultModel`. That resolves to a Grok model (`pageImage` = `grok-imagine`), so the model-routed Grok branch makes another paid Grok call. It packs refs without `textAreaMask`, `maxSlots` or `vbColumnFraction`.
Failure: the logs say "falling back to Gemini", but Grok is actually called again. Gemini runs only after the second Grok failure. In production the dropped options matter only for overlay layouts (`textAreaMask`). In the Lab, an arm with `maxRefSlots` or `vbColumnFraction` silently loses its variable on that retry.
Evidence: decisions.md:33487 notes that the routed branch is reachable only as a fallback. The 2026-09-24 entry keeps the Grok→Gemini fallback but says nothing about a second Grok attempt.
Fix: once the primary Grok call has failed, skip the model-routed Grok branch and go straight to Gemini, or ask the owner whether one Grok retry is wanted.

### A8 The sanitised Grok edit retry drops every reference but the source image
Severity: minor (only after a moderation block or HTTP 400).
Where: images.js:5982 vs 6025. The first attempt sends `[imageData, ...referenceImages]`. The retry sends `[imageData]`.
Failure: a retried edit loses its character and VB references, so identity can drift. The trigger `message.includes('400')` also matches any 400, not only moderation. The "Grok max 3 refs" slice at 5982 is out of date, because the API cap is now 5 (memory: Grok 2.0 state).
Fix: retry with the same `allRefs` and the current cap, and match the moderation error specifically.

### A11 Image cache keys leave out the model, aspect and backend
Severity: minor (Lab).
Where: images.js:1838 (`callGeminiAPIForImage`, which has no `skipCache` option at all) and 2304. The key covers only prompt, photos, `seq`, page and `bg`.
Failure: Lab ref-sheet renders (testlab.js:9049) with the same prompt on two models in one process get the first model's cached image for the second arm. The cached `modelId` reveals it. Production regenerate and iterate paths pass `skipCache: true`, and the production `referenceSheets` calls rarely repeat a prompt.
Fix: add the model, aspect and backend to `generateImageCacheKey`.

### C5 One analyzer failure locks a sheet into the fixed-math crop for the life of the process
Severity: minor.
Where: sceneComposite.js:1016-1028. A rejected `/split-reference-sheet` call caches `null` under the sheet key. The sibling `sheetBytes` (1005-1013) deliberately never caches a failure.
Failure: after one transient analyzer error, every later crop of that sheet uses the fixed grid until LRU eviction.
Fix: delete the key on failure, as `sheetBytes` does.

### D3 When page-eval consolidation fails, the version is scored on raw, undeduplicated issues
Severity: minor (a documented degrade; rare).
Where: repairPipeline.js:1004-1011 and 2764-2772, then scoring.js:708-714.
Failure: a page whose consolidation failed is scored on duplicate raw issues and competes with versions scored on consolidated issues, so the comparison is on two scales.
Evidence: over 30 days, 1 of 188 prod versions and 13 of 917 staging versions have `scoreSource: 'raw'`.
Fix: under the NO FALLBACKS rule, treat a failed consolidation as a failed evaluation (unscored, `evaluated: false`) instead of scoring raw. The owner should decide this.

### B4 `re-evaluate` accepts duplicate and unbounded page lists with no rate limit and no charge
Severity: minor (owner-scoped; needs a crafted API call).
Where: regeneration.js:4104-4157. There is no `imageRegenerationLimiter`, `pageNumbers` is not deduplicated or capped, and evaluation runs under `pLimit(100)`.
Failure: `[1,1,1,…]` runs one paid Gemini eval per entry on the caller's own story. `consistency-check` (5204) has no limiter either.
Fix: deduplicate, cap at the story's page count, and add the limiter.

### A4 / A5 / A6 / A10 Silent degrades (NO FALLBACKS rule)
Severity: minor.
- A4, grok.js:1287 and 1528: a character whose avatar bytes fail to load, or a failed VB slot compose, is dropped with only a warning, and the render goes ahead without that reference.
- A5, coverIterate.js:867 (and regeneration.js:2449): a missing cover description becomes "A beautiful illustrated cover page." Trial path only.
- A6, coverIterate.js:923-929: when `coverHints` names nobody who matches, the result is an empty cast, with no throw like the page path's (images.js:4507). Trial path only.
- A10, wornItems.js:1812: a bare `catch` returns the story-level outfit. This hides code bugs, not only unparsable briefs.

Fix: make each of these throw, or record a generation event, instead of continuing.

## Plausible (needs a data check or run to settle)

### D4 If the round's quality eval rejects, the round's paid repairs are dropped without a trace
Where: repairPipeline.js:2753-2758. A rejected `evaluateImageBatch` sets `roundEvals = []`, so no version is pushed and no `failedRepairs` stamp is written. The next round may pay for the same method again. A rejected entity check leaves a stale `currentEntityReport` that gets charged to the new versions.
Settle: count "Round N: Quality eval failed" in generation logs. `evaluateImageBatch` probably handles per-page errors internally, so a whole-batch rejection may never happen.

### D2 The regression detectors read a different score than the picker
Where: repairPipeline.js:176-235. The detectors read `evaluation.score ?? score ?? qualityScore`. The picker uses `computeFinalScore`, which includes the entity penalty and consolidation.
Failure: the inpaint↔iterate flip and the both-strategies bail can disagree with what the picker ships, which can lead to another paid round of the same strategy.
Settle: replay both functions over stored repair `imageVersions` with `computeFinalScore`, and count the decisions that change.

### B5 The background `saveStoryData` after a long `re-evaluate` writes the whole blob from a stale snapshot
Where: regeneration.js:4423 (also 5343 and 5459). `persistStoryToDatabase` overwrites `stories.data` in full (database.js:2427-2434). Any repair saved through `saveScenePageData` during the eval loses its blob metadata.
This is the same class as the fixed `cover-save-clobbers-scene-page` entry in tasks/bugs.json. The UI runs the panel's steps one after another and it is developer mode only, so it needs concurrent requests to bite.
Settle: a repro with two parallel requests on staging, or a check of whether any route can run concurrently with `re-evaluate`.

## Rejected
- A3: a cover with no landmark rendering without a plate matches the page rule. Plate-or-fail applies only to landmark pages (images.js:4245, decisions.md:3099), and coverIterate.js:1960 enforces it for landmark covers. Deliberate.
- A7: blackout with no fix targets has nothing to black out, so using the original is correct. A sharp-metadata failure on a valid stored image is not a realistic path.
- A9: `objects` is a flat array of VB id strings (scene-expansion.txt:155), so the `[^\]]*` match cannot truncate it.
- C2: assigning a generic face/hand/clothing issue that names nobody to the first identified figure (or the largest) is documented in code as the last resort (bboxDetection.js:2118-2128). Named-but-undetected characters are explicitly left as text only. Deliberate, and no wrong-repair evidence was given.
- C6: across 201 stored `perspective` strings (prod + staging, recent stories), the regex matched only real back or facing-away views. There were 0 false positives such as "looking back toward the camera".
