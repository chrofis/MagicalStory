# Cover vs Page Image Path — Complete Difference Inventory (2026-08-10)

Groundwork for unifying covers into the page pipeline: one generation entry, one shared
eval/detection, one repair path, with cover-specific behavior expressed as per-page flags
(e.g. `stampTitle`), not a separate code path. `generateImageWithQualityRetry`
(server/lib/images.js:7531) is slated for elimination.

All line numbers refer to the `staging` working tree as of 2026-08-10.

---

## (A) Side-by-side lifecycle table

| Stage | PAGE (unified pipeline) | COVER (frontCover / initialPage / backCover) |
|---|---|---|
| **Trigger** | Phase 5a loop over `pageDataArray`, server.js:6034-6347 | Streaming, per-cover promise as soon as avatars are ready: `startCoverGeneration(coverType, hint)` server.js:5003-5033; body ~server.js:3500-3999. Legacy non-streaming fallback ~server.js:4304 |
| **Scene source** | Scene expansion (Art Director, `scene-expansion.txt`) → prose + METADATA JSON | No LLM call: `buildCoverSceneFromHint(hint, …)` composes prose deterministically from the outline's structured coverHint (server.js:3807-3820). Hint key for front cover is `titlePage` (server.js:5010, 3963) |
| **Cast selection** | Outline/scene metadata per page | Dedicated logic: hint.characterClothing authoritative, scene-text fallback, main-only narrowing for titlePage fallback casts, non-mains split half/half between initialPage and backCover, hard cap 5 (server.js:3644-3764) |
| **Prompt template** | `image-generation.txt` via `buildImagePrompt` | `front-cover.txt` / `back-cover.txt` / `initial-page-with-dedication.txt` / `initial-page-no-dedication.txt` (server.js:3859-3900); `*Textless` variants synthesized at load time by regex-stripping the TITLE/TEXT block (server/services/prompts.js:153-166), selected when `MODEL_DEFAULTS.appSideCoverType` (models.js:473, default true) |
| **VB-id sanitize** | Inside `buildImagePrompt` | Separate chokepoint call `sanitizeVbIdsInPrompt(coverPrompt, …, -1/-2/-3)` (server.js:3907-3911); iterate path repeats it (coverIterate.js:669) |
| **References** | `decidePageRoute` + `applyReferenceMode` (server.js:6104-6119); refs = styled avatars + landmark photos + VB grid + empty-scene background + textAreaMask | `buildCoverReferences` (coverIterate.js:987, called server.js:3927-3944): landmarks + VB grid + optional empty-scene plate. Cell-crop refs always pose `front` (server.js:3774-3781). No textAreaMask ever |
| **Model routing** | Per-page `decidePageRoute` (imageRouter.js) — direct vs composite vs phantom, complexity-based model | Cover complexity forced `'simple'` (server.js:3828); model = `MODEL_DEFAULTS.coverImage` = `grok-imagine` (models.js:218) or sceneRouting override (server.js:3830-3851) |
| **Generation entry** | `generateImageOnly` (images.js:5043) — **generation only, no eval** | `generateImageWithQualityRetry(…, 'cover', …)` (server.js:3953) — generation **+ inline eval + bbox + optional retry/repair** in one call |
| **Aspect** | `inputData.layout.imageAspect \|\| MODEL_DEFAULTS.pageAspect` (server.js:6124) | `MODEL_DEFAULTS.coverAspect` resolved inside `callGeminiAPIForImage` by `evaluationType === 'cover'` (images.js:4200-4202). Both currently `IMAGE_ASPECTS.A4` (models.js:411-412) — the *mechanism* differs, the value doesn't |
| **Gen-time extras** | Scale-repair pass when outline declared depth=background (server.js:6149+, pages only); trial streaming image reuse (server.js:6071-6096) | Safety-block scene rewrite hook (dead — `callTextModel` passed null), cover TITLE_ERROR retry gate, composite dispatch (see §6) |
| **Detection** | Phase 5b-pre shared detection, once per image, WITH expected characters/objects/context (server.js:6614-6647) | At gen time inside quality-retry with **zero expected characters** (covers have no METADATA block → `expectedCharacterPositions` = {} at images.js:7888-7897) → patched post-hoc by `detectBboxOnCovers` (server.js:355-439, called at 6948, skipped in trial) |
| **Eval** | None at generation; pipeline Step 1 `evaluateImageBatch` + semantic + three-stage + entity (repairPipeline.js:524-541) | **Twice**: once inline at generation (quality-retry → `callGeminiAPIForImage` → `evaluateImageQuality`), once again in pipeline Step 1 after being pushed as pseudo-page with `evaluationType: 'cover'` (server.js:6416-6434) |
| **Repair** | Pipeline rounds: iterate (`iteratePageCore`), inpaint, char-fix, calm-zone recovery | Same rounds but: iterate branches to `iterateCover` (repairPipeline.js:1075-1091); char-fix refused (`'char-fix not applicable to covers'`, repairPipeline.js:1221-1225); inpaint uses the textless `${key}Art` bytes + restamp after (repairPipeline.js:1140-1195); no calm-zone phase (no textPosition) |
| **Typography/text** | Calm-zone gate + white wash + textPosition/textRect persisted (server.js:6451-6457, 6589-6593) | App-side title/dedication/branding baked post-persist by `bakeCoverTypographyPostPersist` (server.js:7404, coverTypography.js:543); restamp on every later repaint (`restampCover`, coverIterate.js:904-923) |
| **Persistence** | `sceneImages[]` array; story_images `image_type='scene'`, `page_number` set (database.js:648) | `coverImages{}` object; story_images `image_type='frontCover'/'initialPage'/'backCover'` (+ `…Art` textless twins), `page_number IS NULL` (database.js:650, 2540); pipeline results copied back by field whitelist (server.js:6835-6868) |
| **Version meta** | `image_version_meta` key = page number string; `dbIndexFor(version, i, 'scene')` (database.js:1842, 2737) | key = coverType string; `dbIndexFor(version, i, coverType)` (database.js:1940, 2738, 3088) |
| **PDF** | sceneImages pages + text overlay | coverImages consumed directly for cover spread + interior initial page (pdf.js:310-358, 889-935) |

---

## (B) Exhaustive difference list (file:line)

### B1. Generation

1. **Entry function**: pages `generateImageOnly` (images.js:5043, pure gen, cached under `genonly_` namespace); covers `generateImageWithQualityRetry` (server.js:3953; images.js:7531) which bundles gen + eval + bbox + retry.
2. **Prompt templates**: pages `image-generation.txt` via `buildImagePrompt`; covers four templates + synthesized textless variants (server.js:3859-3900; prompts.js:153-166).
3. **Scene expansion**: pages get an LLM Art-Director expansion; covers deliberately do NOT (JS templating from structured hint, server.js:3807-3820 — decision comment in place).
4. **Cast selection**: cover-only rules (hint-authoritative cast, `narrowCoverCastToMains` for fallback title covers server.js:3674-3684, non-main half-split server.js:3738-3760, MAX 5 cap server.js:3729-3737). Pages take the scene's cast as-is.
5. **Route dispatcher**: pages go through `decidePageRoute` (server.js:6104-6106) + `applyReferenceMode` (6112-6119); covers hardcode complexity `'simple'` (server.js:3828) and have their own routing ladder (3830-3851). Covers never see phantom-pose or per-page composite routing; pages never see cover-composite.
6. **Model default**: `MODEL_DEFAULTS.coverImage` (models.js:218) vs `pageImage`/`simplePageImage`/`complexPageImage`; the quality-retry dispatch default is also keyed on evaluationType (images.js:4680).
7. **Aspect mechanism**: pages pass aspect explicitly (server.js:6124); covers rely on `evaluationType === 'cover' → MODEL_DEFAULTS.coverAspect` deep inside `callGeminiAPIForImage` (images.js:4200-4202). Values are currently identical (models.js:411-412). Iterate-cover measures the SOURCE image aspect and overrides when editing (coverIterate.js:760-777) — pages preserve `imageAspect` via storyData instead (server.js:6684, regeneration.js:750).
8. **textAreaMask / empty-scene**: pages attach a text-zone mask when text is overlaid (server.js:6131-6137); covers never do. Both can use an empty-scene background plate (covers via `buildCoverReferences`, server.js:3927-3944).
9. **Avatar cell refs**: covers always use pose `'front'`, no flip (server.js:3774-3781); pages use per-scene pose metadata.
10. **Scale-repair**: unconditional gen-time Grok pass for pages with background-depth characters (server.js:6149+; version surfacing repairPipeline.js:873-948). Covers never get it.
11. **Trial mode**: pages can reuse streaming trial images (server.js:6071-6096); covers get a default hint when Claude emits none (server.js:5013-5029) and skip bbox detection when `skipQualityEval` (server.js:6946).
12. **Progressive checkpoints**: covers save `partial_cover` checkpoints with `qualityScore` from the gen-time eval (server.js:3962-3977). Pages have per-page progress/heartbeat instead (server.js:6048-6062).

### B2. Eval + detection

13. **When eval runs**: pages — only in pipeline Step 1 (`evaluateImageBatch`, repairPipeline.js:524-529); covers — inline at generation (quality-retry per attempt) AND again in pipeline Step 1. The gen-time cover eval is fully redundant with the pipeline eval except for driving the (usually disabled) retry loop and the `partial_cover` checkpoint score.
14. **Detection with characters**: pages get shared detection with `expectedCharacters` from `sceneCharacters` + objects + scene context (server.js:6620-6636). Covers' gen-time detection runs with zero expected characters because `buildCharacterDescriptionsForBbox` keys off `sceneMetadata.characterPositions`, which covers don't have (images.js:7888-7897) — the exact defect `detectBboxOnCovers` (server.js:355-439) papers over post-hoc (guard at 369-379 recognizes the characterless stamp and re-detects with `referencePhotos` names).
15. **evaluationType 'cover' eval additions** (images.js:1344-1441): cover eval note (viewer gaze + flat title allowed, 1348); semantic fidelity reference = cover brief (`sceneHint`) instead of story prose (1349-1350); ART STYLE block stripped from the eval prompt (1434); TEXT RULES block with expected-text extraction from both `MUST include…` and `Paint "…"` phrasings (1418-1441); letter-by-letter re-read instruction (1440).
16. **Text-issue classification**: cover-only `textIssue` classifier (~images.js:1696, consumed at 2080-2094); `TITLE_ERROR` blocks the accept path and forces regen, `STRAY_TEXT` routes to inpaint (images.js:7753-7771, 8239).
17. **Text requirements injected into the pseudo-page's sceneDescription** at pipeline entry (server.js:6374-6404): appSideCoverType → "never flag missing/present title" note; else per-key exact-text requirements (title / dedication / magicalstory.ch). This is prompt-string surgery on `coverEvalPrompt`, not a structured flag.
18. **Eval inputs for covers in pipeline**: `evaluationType` forwarded from the raw image (repairPipeline.js:434; images.js:5580); `sceneHint = scene.outlineExtract` = cover description (server.js:6432); `text: ''` (6418). Entity-check per-char clothing falls back to referencePhotos because covers lack prose metadata (repairPipeline.js:453-461).
19. **Dead code**: `buildCoverSceneImages` (server.js:298-345, covers as pages `totalPages+offset`) has **no callers** — superseded by the -1/-2/-3 pseudo-page mechanism.

### B3. Repair

20. **Pseudo-page mapping**: `COVER_PAGE_MAP = { frontCover: -1, initialPage: -2, backCover: -3 }` (server.js:6358); duplicated as `COVER_PAGE_BY_KEY` (styleRepair.js:152) and `COVER_PAGE_NUMBERS` (coverKeys.js:18) — three frozen copies of the same map.
21. **Iterate branch**: `executeIterateAction` forks on `pageNumber < 0` → `iterateCover` (repairPipeline.js:1075-1091) vs `iteratePageCore`. `iterateCover` (coverIterate.js:~340-950) re-implements cast selection, clothing resolution (throws on missing category, coverIterate.js:445-449), annotation stripping (416-427), fresh-avatar merge (459-463), aspect measurement, composite gating, and restamp — a parallel universe to iterate-page.
22. **Composite**: cover-only render method (`coverComposite.js`, 2-pass Grok, header lines 1-44), reachable via the `composite` option on quality-retry (`_maybeGenerateComposite`, images.js:7468-7514) — gate: `MODEL_DEFAULTS.compositeCovers && figures > 5` or explicit override (coverIterate.js:799-807). Composite results skip quality eval entirely (score null, images.js:7501; coverIterate.js:865-886) and skip restamp (title baked in-pass).
23. **Char-fix**: explicitly refused for covers (repairPipeline.js:1221-1225).
24. **Inpaint**: covers rehydrate the textless `${key}Art` row as inpaint input and restamp afterwards (repairPipeline.js:1140-1195); pages inpaint served bytes directly.
25. **Calm-zone / text-space**: pages only — gate at generation (server.js:6451-6457) and post-repair recovery Step 4 (repairPipeline.js:2104+). Covers have no textPosition (never set for negative pages).
26. **Style-consistency audit**: covers included as pages (owner directive, repairPipeline.js:2320-2341), with fallback to storyData covers.
27. **Copy-back**: pipeline results for negative pages are copied to `coverImages[key]` by an explicit field whitelist and filtered out of `allImages` (server.js:6835-6868). Whitelists rot: `finalScore` was silently dropped until patched (comment at 6842-6847). Version copy-back is conditional (6857-6860).

### B4. Post-processing

28. **Typography**: covers only — `bakeCoverTypographyPostPersist` after `upsertStory` (server.js:7404-7405; coverTypography.js:543), `composeCover`/`restampCover` on every later repaint (coverIterate.js:904-923 with `forceRestampWhenUnbaked` for pre-typography stories, coverIterate.js:370-379; repairPipeline.js:1185-1193). Restamp gated on the `${key}Art` row existing (coverIterate.js:905-911).
29. **Text overlay**: pages only — textPosition/textRect/textCoverageReport persisted (server.js:6589-6593, 6812-6822).
30. **PDF/print**: covers read from `coverImages` for the cover spread + initial interior page (pdf.js:310-358, 889-935); `COVER_A4_TYPES` set in database.js:2540 treats cover + Art types specially.

### B5. Persistence

31. **Container shape**: `sceneImages[]` (array, pageNumber-keyed) vs `coverImages{}` (object, 3 fixed keys + top-level mirror fields like qualityScore/finalScore/bboxDetection).
32. **story_images keys**: scene rows `('scene', page_number, version_index)` (unique index database.js:648); cover rows `(coverType, NULL, version_index)` (database.js:650) plus `frontCoverArt`/`initialPageArt`/`backCoverArt` textless twins (database.js:2540, coverIterate.js:908).
33. **image_version_meta keys**: `page_key` = page number string for scenes, coverType string for covers (database.js:2737-2738, 3023-3024); `dbIndexFor(version, i, type)` takes the type explicitly (database.js:1842 vs 1940, 3048 vs 3088).
34. **Cover version arrays**: covers use `c.versions` in some paths and `imageVersions` in others (server.js:7658-7661 reads `versions`; copy-back writes `imageVersions` at 6859) — two spellings live simultaneously.

### B6. `generateImageWithQualityRetry` anatomy (images.js:7531-8287)

What it does, and where the unified pipeline already has it:

| Responsibility | Lines | Already in unified pipeline? |
|---|---|---|
| Prompt capture chokepoint | 7535 | No — must move to `generateImageOnly` / the shared gen entry |
| Composite dispatch | 7619-7622, 7468-7514 | No — cover-only; becomes a route/flag |
| Generation (via `callGeminiAPIForImage` incl. inline eval + semantic + three-stage) | 7657 | Gen: `generateImageOnly`; eval: `evaluateImageBatch` (Step 1) — **duplicated** |
| Usage tracking (cover_images/page_images buckets) | 7664-7673 | Pages track at call site (server.js:6141-6146) |
| Safety-block scene rewrite via `callTextModel` | 7682-7723 | **Effectively dead**: every remaining caller passes `callTextModel = null` (server.js:3953; coverIterate.js:855; images.js:7013; regeneration.js:752). `generateImageOnly`'s Gemini branch has its own 3-level sanitize loop (images.js:5160-5162) |
| Retry loop | 7590, 7642 | `MAX_ATTEMPTS = 1` unless `options.enableQualityRetry === true` (default **false**, 7589) — no production caller sets it, so the loop is vestigial |
| Cover TITLE_ERROR gate | 7758-7771, 8239 | No — becomes an eval-driven repair trigger in the pipeline |
| Incremental consistency | 7819-7868 | Scene-only, `incrConfig.enabled` never set by production callers — dead |
| Bbox enrich + overlay per attempt | 7881-7941 | Phase 5b-pre + round detects (server.js:6614; repairPipeline round pre-detect) — **duplicated**, and worse (no expected characters for covers) |
| Auto-repair (grid / grok text edit) + re-eval | 8006-8235 | `enableAutoRepair` default false for all production callers — pipeline rounds own repair |
| retryHistory bookkeeping | 7635, 7773-7791 | Pipeline versions + `buildVersionEntry` own history |

**Callers** (all must be migrated before deletion):
- server.js:3953 — initial cover generation (`'cover'`).
- coverIterate.js:854 — `iterateCover` (pipeline cover-iterate + user cover regen + Test Lab), incl. composite option.
- images.js:7012 — `iteratePageCore` non-iterative-placement branch (`'scene'`), i.e. **every page iterate** also flows through it today.
- regeneration.js:751 — user-triggered page regen (`'scene'`).
- testlab.js:3288 — mirrors the call shape (comment only, but Lab parity must be re-checked).

---

## (C) Semantic vs incidental differences

### SEMANTIC — must survive as per-page flags/fields
- `promptTemplate`: cover key → front/back/initial(±dedication) template vs `image-generation.txt` (flag: `template` or `kind`).
- `stampTitle` / app-side typography: textless render + post-persist bake + restamp-on-repaint + `${key}Art` twin row.
- Cover eval additions: allowed-text rules, viewer-gaze/flat-title allowance, brief-as-semantic-reference, TITLE_ERROR severity (flag: `evalProfile: 'cover'` — keep, but as data on the page record, which `evaluationType` already is).
- `noTextZone`: no textAreaMask, no calm-zone phase, no textPosition (already implicit via negative pageNumber; make explicit flag).
- `aspect`: cover pages carry `coverAspect` (flag: per-page `imageAspect`, mechanism pages already have — server.js:6684).
- Cast/composition rules: deterministic hint→scene composer, max-5 cap, front-pose cell refs, no depth/perspective (these live upstream of generation and can stay cover-specific *data producers* feeding the same pipeline shape).
- `compositeEligible` + composite inputs: cover render method for >5 figures (flag: route option, as `_maybeGenerateComposite` docs already frame it).
- Char-fix exclusion for covers (flag: `allowCharFix: false` — or revisit; currently a hard refusal).
- Clothing: covers resolve via coverHint.characterClothing with no-default throw (coverIterate.js:445-449).
- Persistence identity: coverType-keyed story_images rows + `coverImages{}` API shape (can stay at the storage boundary).

### INCIDENTAL — pure drift, delete with quality-retry
- Gen-time eval + gen-time bbox detection for covers (duplicated by pipeline Step 1 / Phase 5b-pre; detection is characterless → strictly worse). `detectBboxOnCovers` (server.js:355-439) exists ONLY to patch this — delete both.
- The retry loop itself (`MAX_ATTEMPTS` effectively 1 everywhere).
- Safety-block scene rewrite (`callTextModel` always null) and incremental consistency (never enabled).
- Internal auto-repair (grid / grok text edit) — pipeline rounds own repair.
- `coverEvalPrompt` string surgery at pipeline entry (server.js:6374-6404) — becomes structured fields (`expectedText`, `textMode`) on the pseudo-page instead of prompt-appended sentences.
- Aspect-by-evaluationType deep in `callGeminiAPIForImage` (images.js:4200-4202) — replace with the explicit `aspectRatio` option pages already pass.
- Copy-back field whitelist (server.js:6835-6868) — if covers were pipeline pages end-to-end, the whitelist (and its finalScore-class bugs) disappears.
- Dead `buildCoverSceneImages` (server.js:298-345).
- Triplicated cover-page maps (server.js:6358, styleRepair.js:152, coverKeys.js:18) → one import from coverKeys.
- `versions` vs `imageVersions` dual spelling on cover objects.

---

## (D) Proposed unification design

Target: covers are pages `-1/-2/-3` from birth. One record shape (`rawImages` entry) with
`{ pageNumber, kind: 'scene'|'frontCover'|…, template, imageAspect, stampTitle, expectedText,
allowCharFix, compositeEligible, … }`. One generation entry (`generateImageOnly` + route
dispatcher), one shared detection (Phase 5b-pre), one eval (`evaluateImageBatch`), one repair
pipeline, cover-specific steps gated by flags.

Refactor steps, in order:

1. **Kill the dead weight** (blast radius: none).
   Delete `buildCoverSceneImages` (server.js:298-345); collapse the three cover-page maps onto
   `coverKeys.COVER_PAGE_NUMBERS`; unify `versions`→`imageVersions` spelling at the two read sites.
2. **Make cover generation eval-free** (blast radius: server.js cover block + checkpoints).
   Replace the server.js:3953 call with `generateImageOnly` (pass `aspectRatio:
   MODEL_DEFAULTS.coverAspect`, template-built prompt, coverRefs). Move the prompt-capture line
   into `generateImageOnly`. Drop the gen-time score from the `partial_cover` checkpoint (UI shows
   the image; score arrives with pipeline eval). Covers now enter the pipeline exactly like pages:
   image bytes + metadata, no eval yet.
3. **Give cover pseudo-pages real structured metadata** (blast radius: server.js:6358-6438 + eval).
   Build the -1/-2/-3 rawImages entries with `sceneCharacters` (already done), a synthetic
   `sceneMetadata` (characterPositions from the hint, objects from hint.objects) and structured
   `expectedText`/`textMode` fields instead of appending TEXT REQUIREMENT sentences to
   `sceneDescription`. Teach `evaluateImageQuality`'s cover branch to read `expectedText` from
   evalOptions rather than regexing the prompt (images.js:1418-1431). Shared Phase 5b-pre detection
   then runs WITH expected characters → delete `detectBboxOnCovers` entirely.
4. **Fold `iterateCover` and `iteratePageCore` generation onto one gen call** (blast radius:
   repairPipeline iterate action, cover regen routes, Test Lab cover stages).
   `executeIterateAction` keeps cover-specific *producers* (template selection, cast/clothing
   resolution, composite inputs, aspect measurement) but funnels into the same
   `generateImageOnly`-based gen used by page iterate; composite dispatch becomes a standalone
   helper called by the route decision (it already is `_maybeGenerateComposite` — move it out of
   quality-retry unchanged). Restamp stays as a post-step keyed on `stampTitle`.
5. **Migrate the two page-side quality-retry callers** (blast radius: iterate + regen endpoints).
   `iteratePageCore` (images.js:7012) and regeneration.js:751 switch to `generateImageOnly` +
   explicit `evaluateImageQuality`/`enrichWithBoundingBoxes` calls (or, better, return ungraded
   bytes and let the caller run the shared eval — regen route already has `stampCanonicalScore`).
   Preserve the returned shape (`score`, `retryHistory`, `bboxDetection`, `grokRefImages`) or
   update the consumers (regeneration.js:765-844 reads most fields).
6. **Delete `generateImageWithQualityRetry`** (+ `_maybeGenerateComposite` relocation, + the now
   unreferenced incremental-consistency / rewriteBlockedScene / internal auto-repair blocks if no
   other callers remain). Update testlab.js:3288 comment/stage and docs
   (`docs/image-generation-methods.html`, `docs/image-routing.md`).
7. **(Optional, later) storage unification**: keep story_images coverType rows and `coverImages{}`
   API shape as a boundary adapter; do NOT migrate DB keys in this pass (client, PDF, sharing,
   admin all read `coverImages`).

Per-step verification: steps 2-3 are provable on a 4-page smoke-account run (covers get pipeline
scores + detections with named figures); steps 4-6 need the cover regen / iterate endpoints and one
Test Lab cover stage exercised.

## (E) Risks / open questions

- **Checkpoint UX**: `partial_cover` currently carries a gen-time score (server.js:3968). Removing
  gen-time eval delays "cover looks bad" detection to the pipeline — acceptable (pages already work
  this way), but the progressive UI must tolerate score-less covers.
- **TITLE_ERROR regen**: today a catastrophic title misprint forces regeneration *inside* the gen
  call (when retries enabled) and blocks the accept path (images.js:8239). In the unified design it
  must map to a pipeline action (iterate) via severity — verify the CATASTROPHIC text severity
  (images.js:1440) actually drives the method chooser to iterate, not inpaint.
  With appSideCoverType=true (default), title errors are near-moot (art is textless), but Mode A
  (painted text) still exists.
- **Composite contract**: composite results carry `score: null` and skip restamp/eval
  (coverIterate.js:865-886). The pipeline scores every version; decide whether composite covers
  keep their eval exemption (flag `skipEval`) or finally get scored like everything else.
- **iterateCover consumers outside the pipeline**: user-facing cover regen/edit routes and Test Lab
  pass options (`forceRestampWhenUnbaked`, `compositeCovers`, `promptTemplateOverride`) — the flag
  surface must survive the fold-in.
- **Aspect drift**: removing the `evaluationType→coverAspect` fallback (images.js:4200-4202)
  requires EVERY cover call site to pass aspect explicitly; miss one and covers silently render at
  pageAspect (currently identical values would mask the bug — add an assert or keep the values
  coupled deliberately).
- **Entity check on negative pages**: verify `runEntityConsistencyChecks` and cascade face merge
  handle -1/-2/-3 correctly once covers stop carrying the gen-time bbox stamp (they already flow
  through Step 1 today, so risk is low but should be smoke-checked).
- **Trial mode**: trial skips quality eval and cover detection (server.js:6946, skipQualityEval
  branch at 6443/6459); the unified path must keep covers cheap in trial (no eval, no detection).
- **Usage buckets**: `cover_images`/`cover_quality` vs `page_images`/`page_quality` accounting is
  keyed on evaluationType inside quality-retry (images.js:7668-7671); the call-site tracking that
  replaces it must keep the same bucket names or storyMetrics/log-analyzer breaks.
- **Open question**: should cover generation move INTO Phase 5a (same Promise.all) instead of the
  streaming early-start? Early start overlaps covers with text-phase latency; unifying the loop
  would simplify `coverAwaitPromise` plumbing (server.js:6359-6439) but delays cover availability
  for progressive display. Recommend: keep early start, keep the join point, just make the joined
  records first-class pages.
