# Area 8 + 9a — Test Lab and image prompt fitting (review 2026-10-04)

Files covered: `server/routes/admin/testlab.js`, `server/lib/testlab.js` (run loop, log capture, quality_eval stage), `server/lib/idleShutdown.js` (busy probes), `server/lib/analyzerClient.js`, `server/lib/images.js` 1-1280 (`shrinkPromptForModel`), `server/lib/pageRenderCall.js`, `server/lib/sceneShorten.js`, the page-prompt call sites in `server/routes/regeneration.js` and `storyJobPipeline.js`.
Finders: 2 × Sonnet (Test Lab; prompt shrink + pageRenderCall). Verifier: Opus, against HEAD 645cb5082, plus read-only staging DB checks.

## Confirmed

### S1 The user-facing "regenerate image" route builds its page prompt outside `makePageImagePrompt`
Severity: major (production, user-facing, paid with credits).
Where: `server/routes/regeneration.js:766` (route `POST /:id/regenerate/image/:pageNum`, line 468; render at ~827). The same bare call is also used for dev tools at :1211, :1236 (Test Models) and :2122 (Style Lab).
What fails: the route calls `buildImagePrompt(expandedDescription, storyData, sceneCharacters, visualBible, pageNumber, referencePhotos)` with no options. Its render model is `MODEL_DEFAULTS.pageRenderImage`, which is `grok-imagine-2` (`server/config/runtime.js:106`). So a regenerated page sends the Visual Bible prose that the story run deliberately drops for Grok (`skipVisualBible`), making the prompt longer and more likely to be cut by the shrinker. It also passes no `vbRefElementIds` while it attaches a `visualBibleGrid`, so the REQUIRED OBJECTS block never names the grid images that ride with the call (`promptBuilders.js:5086-5092`: "without it no image reference is claimed"). The grid itself is built differently as well: `getElementReferenceImagesForPage(…, 6)` plus secondary landmarks, where the run selects at most 4 cells and keeps landmark photos out of the grid (bugs.json entry at line 237).
Evidence: client caller `client/src/services/storyService.ts:1048` (`regenerateImage`); `regeneration.js` is not a member of the sibling set `page-prompt-one-construction` (`scripts/admin/sibling-registry.json:1010`), whose reason says "a path that builds a page prompt another way joins this set or is deleted". Not in BACKLOG or the other 2026-10 review files.
Fix direction: build the prompt and grid through `pageRenderCall` (`selectPageElementRefs`, `makePageImagePrompt`, `pageRenderOptions`) and add `regeneration.js` to the sibling set.

### L2 Redo of a set-run result or a version-pinned result re-measures a different case
Severity: major (Lab measurement; latent so far).
Where: `server/routes/admin/testlab.js:970-985` (page-stage redo branch); set run stores real params only on `targets[]._params` (`:515-522`).
What fails: the page-stage redo rebuilds `target = { storyId, pageNumber }` and `params = exp.params`. For a set run `exp.params` is just `{autoEval: true}`; the member's own params (`_params`) are not snapshotted on the entry, so a redo runs the stage with the set's params gone. A pinned target's `versionIndex` is also dropped, and `runStageOnTarget` reads the pin from `target.versionIndex` (`server/lib/testlab.js` `ctx.versionIndex = pinnedVersionIndex(target.versionIndex)`), so the redo judges the active version instead of the pinned one. Using `entry.versionIndex` would not help either: the result's own `versionIndex` overwrites the target's when the entry is spread.
Evidence: staging has 163 set runs and 106 set members with non-empty params; 0 redos so far on set runs or on pinned targets, so no stored result is wrong yet. The same class of bug (a dropped pin) was fixed once on the create route (bugs.json line 290, comment at `:713-716`).
Fix direction: snapshot the unit's full `unitParams` and the original target (with `versionIndex`) on each entry in `executeExperiment`, and have the redo read those.

### L1 Redos are invisible to the push gate, idle shutdown and the analyzer session count
Severity: moderate (Lab only; a deploy or staging sleep can kill a redo in flight).
Where: `server/routes/admin/testlab.js:922-1024` (`redosInFlight` is an in-process counter); `server/lib/idleShutdown.js:85-127` (the testlab probe counts only `status = 'running'` rows).
What fails: a redo on a completed experiment runs in the background for minutes (image gen, eval), but the row stays `completed`, so `/api/health/busy`, `check-push-idle.js` and idle shutdown all report idle, and a push or staging sleep restarts the container mid-redo. The entry is then never appended. A redo also never calls `sessionBegin`, so its analyzer calls run sessionless: workers start cold and are reaped right after each call, or when another session ends.
Evidence: the only probes are `story-jobs` and `testlab` (`registerBusyProbe` calls at `idleShutdown.js:69,85`); `check-push-idle.js:83` reads only `/api/health/busy`. `sessionBegin` is called only for experiments, avatar jobs and presence. This is the incident class the gate exists for (2026-08-05, experiments 1160/1163).
Fix direction: register a `testlab-redo` busy probe on `redosInFlight > 0`, and bracket `executeRedo` with `sessionBegin`/`sessionEnd`.

### L6 Per-stage log capture drops late warnings and errors, against its own comment
Severity: minor (Lab debugging aid).
Where: `server/lib/testlab.js:10450-10455`.
What fails: the comment says "warn/error stored in full, info capped", but the listener stops at 400 lines for every level. On a chatty stage, the warning or error that explains a failure comes last and is the line that gets lost. Concurrent runs mixing lines into each other's capture is acknowledged in the comment as acceptable, so that part is by design.
Fix direction: cap only info/debug lines and always keep warn/error.

### L5 Set runs leave `target_count` at 0
Severity: minor (cosmetic list count).
Where: `server/routes/admin/testlab.js:517-522` (the INSERT omits `target_count`; the create route sets it at `:768`).
What fails: the experiment list shows `results/0` for every set run (`client/src/pages/TestLab.tsx:1389`).
Evidence: staging has 163 of 163 set-run rows with `target_count = 0` and non-empty `targets`. The finder's second claim, base64 in set-run targets because the set route skips `offloadJsonbImages`, is real in code (results are still offloaded by `appendEntry`), but staging has 0 such rows and 0 set members with inline images.
Fix direction: set `target_count` in the set-run INSERT and run the targets through `offloadJsonbImages` the way the create route does.

### L4 quality_eval stamps the model it asked for, not the model that answered
Severity: minor (Lab record; can mislabel an A/B).
Where: `server/lib/testlab.js:1304`.
What fails: `modelId: params.model || MODEL_DEFAULTS.qualityEval`, under a comment that says "What RAN, not what was asked". The evaluator falls back to gemini-2.5-flash or Grok vision on errors and safety blocks (`evalPipeline.js` P1/P2 fallback branches, which do update their local `modelId`). With no override, the inventory runs on `MODEL_DEFAULTS.inventoryModel` (Qwen3-VL on staging), not `qualityEval` (`evalPipeline.js:2952`). The evaluator returns `modelId` on its result (`evalPipeline.js:3933`); the stage ignores it.
Fix direction: record `result.modelId` and the inventory's served model.

### S3 The byte-tightening loop can repeat the "one LLM try" scene shorten up to 4 times
Severity: minor (cost and nondeterminism on rare over-cap pages).
Where: `server/lib/images.js` `shrinkPromptForModel` (~1161-1176) → `shrinkToCharBudget` → `sceneShorten.shortenSceneToFit` (`sceneShorten.js:137`, 20-char margin).
What fails: each pass restarts from the original prompt with a smaller char budget and calls the LLM shorten again. The margin is 20 chars, but the cap has been in UTF-8 bytes since today, and a German or French prompt's non-ASCII overshoot can exceed 20. That pushes the prompt to a second pass, which means a second LLM call with a different rewrite and a second `prompt_shrink` event for one render. This contradicts the owner rule "one LLM try" (2026-09-30).
Evidence: code path is certain. How often it happens is unmeasured, because the byte cap and the raised cap landed today and there are no stored events yet.
Fix direction: compute the byte budget once up front (bytes minus the non-ASCII excess of the fixed blocks), or let later passes cut sentences only.

### L7 Set run claims its capacity slot after awaits
Severity: minor.
Where: `server/routes/admin/testlab.js:503-517`.
What fails: the capacity check runs first, then two DB awaits, then `runningExperiments++`. Two quick set runs can both pass the check, giving MAX+1 concurrent experiments. The create route fixed exactly this race (comment at `:687-689`); the set route did not get the same fix.
Fix direction: increment immediately after the check, as the create route does.

### S2 Trial streaming builds its page prompt directly (drift risk only)
Severity: minor (no behaviour difference today).
Where: `storyJobPipeline.js:1347`.
What fails: it calls `buildImagePrompt` with `skipVisualBible` and `vbRefElementIds` by hand. That matches `makePageImagePrompt` today, but it is a second construction inside a member file of `page-prompt-one-construction`, and the gate's anchor check won't catch it. The next option added to the closure will miss trial pages.
Fix direction: call `pageRender.makePageImagePrompt(...)(ids)`.

### S4 Stale 7,900 cap text and dead cap fallbacks
Severity: minor (cosmetic, plus a NO-FALLBACKS breach).
Where: `server/lib/images.js:798`, `:902` (present-tense "Grok: 7,900"); `:1547` `|| 7500`; `:1749` `|| 30000` for an unknown model key.
What fails: comments state a cap that `models.js:1127-1209` no longer has. The `|| 30000` default means an unknown model key skips fitting silently instead of failing. The other cited lines (images.js:1152, 2418, 2501; image-generation-methods.html:672; prompt-inventory.md:160) are dated historical measurements, not stale claims.
Fix direction: fix the two comments, and throw when `maxPromptLength` is missing.

## Plausible

(none)

## Rejected

- L3 — DUPLICATE of `tasks/BACKLOG.md:647` ("A running experiment cannot be cancelled"). The extra point, that `params.variants` is uncapped (25 targets × N variants), is real (`testlab.js:610-633`) and belongs in that backlog item as a sub-point, not as a separate finding.
