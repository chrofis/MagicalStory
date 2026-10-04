# Area 1 — Story pipeline (review 2026-10-04)
Files: storyJobPipeline.js, beatsPipeline.js, promptBuilders.js, sceneMetadata, textRefine, textModels, visualBible, clothingResolve, storyHelpers. Finders: 3 × Sonnet; verifier: Opus.

Stored-data checks used below (read-only, last 30-60 days): prod 33 / staging 106 stories with a generation log, 17 / 40 stories with scene briefs, 7 / 35 lector rounds.

## Confirmed

### C2 OpenRouter judges ignore temperature 0 (the 2026-08-07 pin landed on the wrong function)
Severity: major.
Where: server/lib/textModels.js:1099-1116 (OpenRouter streaming body, no `temperature`); :846-850 (xAI non-streaming, same); :925 (xAI streaming, the only OpenAI-style body that honours it).
Failure: the default compliance judge (`qwen3-max`) and the default feedback consolidator (`qwen-plus`) both go through OpenRouter, pass `temperature: EVAL_TEMPERATURE` (0), and the request is sent without it, so the provider default (about 1.0) applies. Eval findings and repair decisions on every production story are therefore not reproducible, which breaks a SETTLED verdict ("Eval judges run at temperature 0, always", docs/SETTLED.md:19).
Evidence: commit 96187ce8a said "honours options.temperature on the Gemini and OpenRouter paths", but its hunk sits in `callXaiAPIStreaming` (git show 96187ce8a — the patch follows the `api.x.ai` fetch). `callOpenRouterAPI` delegates to `callOpenRouterAPIStreaming`, whose body has no temperature key. The 2026-09-08 entry (decisions.md:41788) blamed "the OpenRouter upstream is not deterministic" at temperature 0; the calls were never at 0. Models: models.js:589 `complianceModel: 'qwen3-max'` and :580 `evalModel: 'qwen-plus'`, both `provider: 'openrouter'`.
Fix direction: add `...(options.temperature != null ? { temperature } : {})` to the OpenRouter body and the xAI non-streaming body, plus a unit test that pins the request body for every provider.

### B1 The iterate (rewrite) templates lack the shared-grip rule their checker enforces
Severity: major (default repair path; frequency not measured).
Where: prompts/scene-iteration.txt and prompts/scene-iteration-free.txt have no `{SHARED_GRIP}` or `{TRUE_RELATIVE_SIZE}`; the first-author templates do (scene-expansion.txt:224, scene-briefs-all.txt:246; filled at promptBuilders.js:3192/3670). iterateBeat.js:520 counts `interaction_object_shared_hands` as an INTRODUCED fault for rewrites, and images.js:~4837 feeds it to a paid corrective re-ask.
Failure: when a render is repaired, the rewriter is never told "one object takes one pair of hands", so it can write the joint grip, the checker flags it, and a second paid call (or a shipped WARN) follows. Worse, scene-iteration-free.txt:175 check 13 tells the rewriter to "define each character's grip point" when 2+ characters hold one object, which is the opposite of the rule.
Evidence: the sibling set `art-director-vs-iterate` (scripts/admin/sibling-registry.json:521) lists `{EYES_OPEN}`, `{CONTACT_VERB}` and others as anchors but not `{SHARED_GRIP}`, and its anchorsNote names no deliberate exemption for it.
Fix direction: fill `SHARED_GRIP` in the iterate builder, add the placeholder to both iterate templates and to the parity anchors, and delete free-mode check 13.

### A2 A page the text writer omits is dropped and the book ships short
Severity: minor by frequency (0 hits in 60 days), user-visible when it fires.
Where: server/lib/beatsPipeline.js:3214-3218 (attempt 2 accepts a parse with `missing` pages), :3129-3132 (warn only), :3249-3252 (`Page N has no text — dropped`); storyJobPipeline.js:3128-3130 only warns on `storyPages.length !== sceneCount`.
Failure: if the writer leaves out a page on both attempts, the page and its already-paid brief disappear and the user gets, for example, 13 pages instead of 14 at full price, with only a log warning. The planner omission at beatsPipeline.js:2640 has the same shape.
Evidence: code path as above. `beats_text_incomplete` / `beats_plan_incomplete` fired 0 times in prod and staging over 60 days, so this is latent.
Fix direction: re-ask the writer for the missing page numbers only (the corrective pattern used elsewhere), and fail the job loudly if they are still missing.

### A1 A failed arc machine keeps the discarded arc's cast state
Severity: minor (rare: `beats_arc_failed` 0 hits in 60 days).
Where: beatsPipeline.js:2252-2288 set `challengeTakenIds`, `arcInventedNames/Limit`, `arcPremiseNames`, `arcCentralFigure` from the created arc; the catch at :2594-2602 resets only `approvedArc`, `arcWeakPoints`, `arcHints`, `arcStoryLogic`.
Failure: if the arc stage throws after the create (for example in a re-tell round), the planner writes without an arc but is still told the old central figure (:2613), the plan counters check invented-figure and central-figure rules against an arc nobody sees (:2692-2696, :814), the Art Director and covers use that central figure (:3047, :1675), and the next book's challenge memory stores tags from the discarded arc (:3461).
Evidence: the variables listed; no reset in the catch.
Fix direction: reset every arc-derived variable in the catch (or keep the created arc when only a later round fails).

### C1 `cachePrefix` (the consolidator's rules) is dropped on Gemini and xAI
Severity: minor (default `qwen-plus` is OpenRouter and works; reachable through the Lab and env overrides).
Where: textModels.js `callGeminiTextAPI` (674-788) and `callXaiAPI` (818-880) never read `options.cachePrefix`; only Anthropic (262-275) and OpenRouter streaming (1040) do. The only caller, feedbackConsolidator.js:798-803, puts the whole rules template in `cachePrefix`.
Failure: running the consolidator on a Google or xAI model (Lab `consolidate` stage `params.model`, testlab.js ~4899, or `EVAL_MODEL`) sends only the per-page input with no instructions, so any bake-off of those models is invalid.
Fix direction: prepend `cachePrefix` in the dispatcher (`callTextModel`) for providers without prompt caching, so no provider can drop it.

### C3 `parseClothingCategory` defaults to 'standard', defeating the owner's no-default guards
Severity: minor.
Where: server/lib/clothingResolve.js:283-299 (keyword found, no value nearby → `'standard'`); callers images.js:5215, regeneration.js:693/697, coverIterate.js:887 put `|| primaryClothing` and a throw after it.
Failure: when a page has no stored per-character clothing, the parse runs first; a brief that contains the word "clothing" but no value returns `'standard'`, so the story's `primaryClothing` and the "refusing to default to standard" throw are never reached and the page can be redrawn in an outfit the story never uses.
Evidence: replaying the parser over stored briefs: 10 of 567 staging pages hit the default branch; step 0 never fires because `extractSceneMetadata` returns `clothing: null` (sceneMetadata.js:1184). Pages with no stored pageClothing: 7/158 prod, 38/567 staging, so both conditions together are rare.
Fix direction: return null instead of `'standard'` in the no-value branch.

### A3 An error after a user cancel turns 'cancelled' into 'failed' and sends failure emails
Severity: minor.
Where: storyJobPipeline.js:7540-7543 (inner catch) and ~8160-8166 (outer catch) update `status='failed'` with no `status <> 'cancelled'` guard; the outer catch then saves a [PARTIAL] story and sends the admin alert and user failure email.
Failure: the cancel endpoint (routes/jobs.js:812) does not abort in-flight calls, so a real error before the next `checkCancellation()` overwrites the user's cancel. The user who cancelled gets a "your story failed" email and a partial story. Refund is safe (atomic claim). The completion write is already guarded (:7299); the failure writes are not.
Fix direction: add `AND status <> 'cancelled'` to both failure UPDATEs and skip partial-save and emails when no row changed.

### A4 Lost update on the characters row when saving styled avatars
Severity: minor.
Where: storyJobPipeline.js:7019-7046: SELECT `data`, await `offloadCharacterImages` (R2 uploads), then UPDATE the whole `data`.
Failure: a character edit saved by the user (or by a second story of the same user) during the upload window is overwritten.
Fix direction: write only the styled-avatar path (`jsonb_set`) or re-read inside a transaction with `FOR UPDATE` after the upload.

### C6 Gemini-text fallback books the wrong model and loses usage
Severity: minor (the fallback itself is deliberate — decisions.md 2026-09-18 "The Grok vision fallback names a model xAI still serves"; the backlog records 0 fires).
Where: textModels.js:750-776 and the chokepoint at :1368.
Failure: when Gemini blocks and Grok answers, `callTextModel` records usage under `model.modelId` (Gemini), not the returned Grok id, so Grok tokens are priced as Gemini. On the flash-lite path, `usage` is the first (blocked) call's usage (const at ~:731); the second call's tokens are lost. The Grok retry also drops `temperature`/`system` options.
Fix direction: record with `result.modelId || model.modelId`, and recompute usage from the retry response.

### B3 With no main character declared, the focus is also listed as "everyone else"
Severity: minor (the wizard requires a main; reachable from payloads without `mainCharacters`/`isMain`).
Where: promptBuilders.js:6533-6534: `focus = mains[0] || chars[0]`, but `others = chars.filter(c => !mains.includes(c))` still contains `chars[0]`; :7052 then writes "Everyone else — A, B — carries no arc" with the focus character in the list.
Fix direction: exclude `focus` from `others`.

### B4 Four prompt builders fall back to hardcoded prompts when a template is missing
Severity: minor (dead while the template files ship; breaks the NO FALLBACKS rule).
Where: promptBuilders.js:3543-3546 (scene expansion silently returns the iteration prompt), :4238, :5491, :12350 (trial story: a 4-line generic prompt). Their siblings throw instead (services/prompts.js:673, :860, :940).
Fix direction: throw, like the siblings.

### B2 The Lab's scene-expansion stages build a self-contradictory prompt
Severity: minor (Lab only; the legacy call at storyJobPipeline.js:1077 is unreachable while `unifiedSceneProse: true`, models.js:878).
Where: testlab.js:5799, :5865, :5954 call `buildSceneExpansionPrompt` without `jevBackup` or `story`. promptBuilders.js:3667 `shotRuleFills({ fixedShot: undefined === false })` gives free-shot rules, while :3690 `fixedFieldsRule(undefined)` gives the JEV fixed-field rule. The season comes from today (logged at error level by `pageSeasonLabel`).
Failure: Lab experiments on these stages do not measure what production sends (production passes `jevBackup` at beatsPipeline.js:1610).
Fix direction: pass `jevBackup` and `story` from the Lab context, or make `jevBackup` a required argument.

### C8 Name scan misses names that start or end with a non-ASCII letter
Severity: minor (step 2 only, after metadata and markdown parsing found nothing).
Where: sceneMetadata.js:1630-1633 uses `\b`, which is ASCII-only in JS, so "Zoé" or "Émile" never match; the sibling at :1472 uses `\p{L}`.
Fix direction: use the same Unicode-aware boundary as the sibling.

### C9 Entity tokenizer splits words on ß, â, ô, û, ë, ï, œ
Severity: minor (low impact; both sides are split the same way, and Swiss texts use ss).
Where: visualBible.js:1833 `[^a-zäöüéèêàçñ]+`.
Failure: "bâton" becomes "ton", which can cause false worn/held matches.
Fix direction: split on `[^\p{L}]+` with the `u` flag.

## Plausible (needs a data check or run to settle)

### C4 A bare lector correction that starts with « is cut short
Severity: major if it fires (corrupts printed text in de-CH/fr stories); no occurrence found.
Where: textRefine.js:778-785 `quotedSpan` treats a leading `«` as a quote delimiter and cuts at the last `»`; classifyLectorLine :822-827.
Failure: `PAGE 3: '«Komm», sagte er.' → «Komm!», sagte er.` parses the correction as `Komm!`, and `applyLectorFindings` replaces the whole quoted span with it. The page loses its guillemets and ", sagte er.".
Evidence so far: 25 stored staging lector findings (0 on prod) show no guillemet loss or truncation. The comment at :788 says one model left corrections bare on every line, so the input shape is realistic.
What would settle it: a unit test with that line (deterministic), plus a scan of `rawResponse` in stored lector rounds for bare right-hand sides that start with a quote character. Fix direction: treat «/„ as delimiters only when the matching close is the last character of that side.

## Rejected
- A5 — deliberate: checkpoint base64 is the declared exception (docs/decisions.md:57811, docs/r2-storage.md:150, dbHousekeeping.js:112).
- B5 — refuted: cover-composition.txt has both `### front` and `### back` sections, and a missing section logs at error level; unreachable with the shipped template.
- B6 — refuted for real traffic: the client art-style ids (constants/artStyles.ts) match the 14 server `ART_STYLES` keys exactly; only a hand-crafted request reaches the Pixar default (an input-validation question, not a pipeline bug).
- B7 — refuted: all 54 historical topic ids in client/src/constants/storyTypes.ts have a guide in prompts/historical-guides.txt; swiss-stories guides are built from docs (`buildSwissStoryGuide`).
- B8 — deliberate: the sentinels are the designed "never block a story on the arc step" degrade (beatsPipeline.js:2594 comment) and an explicit empty-VB instruction. The stale state that path leaves behind is A1.
- C5 — duplicate: tasks/BACKLOG.md:1352 ("The diff pass omits the length_fix pass's rewrites"). Still open; `length_fix` fired 0 times in 48 stored refine reports.
- C7 — refuted: the double-booking is prevented by the `__accounted` idempotency guard in addUsage (storyJobPipeline.js:554-560; same usage object reference). Merging on an LLM error keeps the status quo of two entries that already share one id.
