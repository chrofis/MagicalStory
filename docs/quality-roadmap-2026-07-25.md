# Pipeline Quality Roadmap — 2026-07-25

> Captures the product owner's concerns (2026-07-25) as tracked themes, each
> grounded in code investigation, cross-referenced to the full review in
> `docs/review-2026-07-25-full-code-review.md`. Every theme has: **Concern** (in
> the owner's framing) · **Findings** (code evidence) · **Action** (fix now / A-B
> test / spec / needs-decision) · **Status**.
>
> Legend: 🔴 confirmed broken · 🟡 partial / incomplete · 🟢 works · ❓ under
> investigation · 🧪 experiment to run · 📐 design/spec · ✅ fixed on staging

Investigation is running in parallel across 4 areas (secondary-char avatars,
final style check + orientation, prompt×model×cost, image-pipeline completeness).
Sections marked ❓ are filled in as those land.

---

## 1. Quality scoring & image versions (owner: "most issues are here")

**Concern:** scoring and the versioning of images is where most problems live.

**Findings (from review, being consolidated by the completeness sweep):**
- Version-index vs array-index confusion in ≥6 sites — evals/bbox stamped onto
  the wrong version on lazy-migrated stories (`regeneration.js`); the client
  active-version badge compares raw array index against a sparse `versionIndex`
  (`ImageHistoryModal.tsx`, `StoryDisplay.tsx`). Some fixed on staging, some not.
- Falsy-zero severity bugs: `critical: 0` treated as `minor` in dedup
  (`issueExtractor.js`), `minSeverityToFix:'critical'` behaving as `'major'`
  (`images.js`).
- Prompt↔code rubric mismatch: the eval prompts teach a deduction table
  (30/20/10, 30/15/7/2) that disagrees with the code's `SEVERITY_POINTS`
  (50/25/15/5/2). The redo gate (60) is single-sourced and coherent; the models
  are just being taught a different rubric than the one that charges them.
- Non-atomic version allocation (`getNextVersionIndex` MAX+1 + `ON CONFLICT DO
  UPDATE`) can overwrite an image on concurrent same-page mutation.

**Findings — the SCORING side is actually well-consolidated now (good news):**
- `applyScore`/`stampScores` is the **single canonical writer** of
  `finalScore`/`deductions` per version (`images.js:9062-9090`); un-evaluated
  versions correctly get `finalScore=null`; scene-level score mirrors the picked
  version via `computeFinalScore(best)` and uses `best.evalScore` not the
  generation-time `best.score` (an old bug, now fixed). Eval is **fail-CLOSED**
  (returns null, treated as `evalWasBlocked`, re-evaluated) — not fail-open.
- Residual scoring↔version bugs still live at HEAD: **(a)** scene-level
  `bboxDetection` can lag the picked version's pixels when `freshBboxMap` misses
  the page (`images.js:9235`) — per-version bbox is fine, only the flattened
  mirror; **(b)** the early-Grok branch returns a proportion-blind score (tied to
  §3's STEP-2C gate — now FIXED); **(c)** the client version-index↔array-index
  confusion (sparse `versionIndex` vs raw array index in `ImageHistoryModal.tsx` /
  `StoryDisplay.tsx`) — this is the biggest remaining one, needs a single shared
  resolver `findIndex(v => v.versionIndex === active)`.

**Action:** the server scoring is solid; the remaining work is (1) the client
version-index normalization (shared resolver), (2) drop-or-recompute the
scene-level bbox mirror. Both contained; version normalization touches UI display
so wants a visual check.

**Status:** 🟢 server scoring consolidated; 🟡 client version-index + bbox mirror pending.

### 1a. Scores floor at 0 — "often 3 images have 0"
- **Answer:** the score CANNOT go negative — clamped to `[0,100]` server-side
  (`scoring.js:224`) and client-side (`versionScore.ts`). A version scores
  `100 − Σ deductions`; once deductions pass 100 it pins to 0, so several failing
  versions all read 0 and become indistinguishable. Selection is NOT broken
  (`pickBestVersionIndex` tiebreaks on the un-clamped deduction total), only the
  displayed number is uninformative.
- **✅ A (shipped):** `applyScore` now stores an un-clamped `version.rawScore`
  (`100 − Σ deductions`, can go negative); the dev-mode version badges + detail
  panel show it in parentheses when the score floors at 0 (e.g. `0% (−140)`), so
  three 0-scored versions are distinguishable. Legacy versions (pre-deploy) lack
  the field and just show `0%`.
- **🧪 B (documented — needs decision):** if pages *routinely* exceed 100
  deductions, the likelier cause is the eval **over-penalizing** — flooding false
  CRITICALs (25 pts each; the model-cost audit flagged that some eval models do
  exactly this). With critical 25 / major 15 + entity cap 40, ~3–4 false
  criticals floor an otherwise-fine image. **Investigation:** measure the
  false-CRITICAL rate per eval stage on a sample of stories (the rawScore
  distribution now makes this visible — how far below 0 do "bad" pages land?),
  then either tighten the eval prompts (fewer spurious criticals) or re-weight
  `SEVERITY_POINTS`. Behavior-changing (shifts scores + repair frequency) → run
  as a Test Lab experiment with the §6 rubric, not a blind change. Ties to the
  §1 rubric-calibration item (prompts teach a harsher table than intended).

---

## 2. Colour shifting (owner: "recently had issues")

**Concern:** a recent colour-shift regression.

**Findings — colour correction is SINGLE-SOURCE (good), no duplicate impl:**
`correctColorShift` (`images.js:10618`) is the one canonical function, run in
production from `samBlend.js:374` (`colorAware:true, borderMatch:false,
garmentOnly:true`). Guards mostly present: empty-mask return, per-material offset
cap (`maxOffsetDeltaE=30`), border-refine ≤20%-of-mean cap, background-palette
rejection. No second colour implementation exists. So a *recent regression* is
most likely one of these residual gaps, NOT a rogue second path:
- **colorAware bypasses the overall-mean `minDeltaE` floor** (deliberate,
  `images.js:10645-10649`) — so on the production blend a tiny real shift still
  runs a full k-means recolor with no floor protecting it.
- **`bgCent` needs ≥90 background points** (`images.js:10697`); on small crops
  the background-rejection arm drops out and the tight `SAME2=36` gate is the
  only protection → over-correction risk on small figures.
- Seam-close (`_closeSeamHarmonic`) is OFF in prod blend (`borderMatch:false`).

**Action:** add a minimum-sample floor to the colorAware per-material shift (skip
a "material" matched by too few pixels — the earlier review's speckled-fringe
concern) and a small-crop guard when `bgCent` is empty. **Behavior-affecting on
image output → wants a visual before/after, so proposed not auto-shipped.**

**Status:** 🟢 single-source confirmed; 🟡 two residual guard gaps to add (need visual check).

---

## 3. Multiple implementations of one feature (owner's core frustration)

**Concern:** "the pipeline often has 2-5 different versions of one feature
implemented, but we then only improve ONE path. Or introduce gates that are not
complete. And instead of fixing properly, fallbacks are created."

**Findings — three consolidated inventories (full detail in the review report):**

**Duplicated feature paths (still drifting at HEAD):**
- Two image-generation entry functions (`callGeminiAPIForImage`@4704 vs
  `generateImageOnly`@5523) each re-implement the whole provider dispatch ladder
  — eval-gate improvements to one don't reach the other.
- `padToGeminiRatio`/`removePadding` implemented TWICE with different math
  (`repairGrid.js` pads solid white/black vs `entityConsistency.js` pads mirror).
- Face-repair: 5 coexisting modes + `grokFaceInsertRepair` (SAM-union) with a
  legacy fall-through; a SECOND inline union blend in
  `repairCharacterMismatchWithGrok`@11822 that does NOT use the shared
  `samUnionBlend`.
- Cover logic scattered: **VB-id sanitization in 4 places with OPPOSITE fail
  semantics** (composite fails OPEN → can paint a literal `ART###`); title/text
  rule in 3 incompatible formulations; aspect hardcoded `3:4` in composite vs
  `MODEL_DEFAULTS.coverAspect`.

**Incomplete gates (one path enforces, sibling skips):** style-match
(`checkStyleMatch` — testlab only, absent in prod face repair); IoU<0.55 +
white-card (samBlend path only; legacy inline union uses a weak area-ratio);
whiteout over-coverage (testlab only); `requireMobilesam` (round-1 only, round-2
silently allows rembg); **composite covers bypass ALL eval and return
`score:null`** so auto-repair can't confirm improvement; cascade depth Signal A
(prod detection only). ✅ **STEP-2C proportion check — FIXED this pass** (was OFF
on the production `grok` default while siblings ran it).

**Fallbacks masking root bugs:** ⚠️ **`evaluateEntityConsistency` fails OPEN in 3
places** (`entityConsistency.js:2025/2117/2158`) — missing template / parse error
/ any Gemini error returns `consistent:true`, **silently disabling repair for the
whole story** (highest-impact fail-open). Face-insert → legacy blur+rect blend on
ANY failure (masks SAM-down / gate-reject / style-drift). `styleHint` defaults to
hardcoded **watercolor** (an `oil` story missing `styleHint` renders watercolor).
Composite → direct silent fallback; composite repaints ship **titleless**. A full
repair-verification trio (`verifyRepairImprovement`) exists but is **dead** — live
repairs hardcode `verification:{improved:true}`. Also: `regeneration.js:5904`
artifact-repair calls `gridBasedRepair` with the wrong signature → **always
throws** (that endpoint's grid path is dead).

**Action / strategy:** the durable fix is to make production CALL the shared
functions (samBlend, `sanitizeVbIdsInPrompt`, `coverTextFor`, one dispatcher, one
pad helper) instead of parallel copies — then every fix lands everywhere. The
highest-value *correctness* fix is the entity fail-open (flip to fail-closed /
surface "unresolved"), but it changes repair-trigger behavior on flaky evals →
owner sign-off, not a blind flip.

**Status:** 🟡 inventoried; consolidation UNDERWAY (owner green-lit "all such paths
must be merged", 2026-07-25).

**Merge queue (8 duplicated-path clusters):**
- ✅ STEP-2C gate completion (shipped)
- ✅ Entity fail-open ×5 → fail-closed + retry (shipped)
- 🔧 Face repair 5→3 params — agent implementing full Stages 1–5 + geometry unit
  tests (worktree; owner accepted the IoU-gate tradeoff)
- 🔧 #5 Gemini pad helpers (repairGrid vs entityConsistency) → one `geminiPad.js`
  (agent, behavior-preserving via padMode param)
- 🔧 #6 Cover logic (VB-id sanitize ×4 fail-open → fail-closed; cover-text ×3;
  aspect hardcode → coverAspect) (agent)
- ⏳ #1 image-gen entry (`callGeminiAPIForImage` vs `generateImageOnly`),
  #2 Grok truncation, #3 aspect-resolve ×4, #4 aspect-snap ×4, #7 mask-fetcher —
  all `images.js`; QUEUED behind face-repair (same file), done sequentially on top.
- ⏳ dead `verifyRepairImprovement` trio — decide wire-or-delete.

All agent work commits to worktrees and is NOT auto-promoted — each diff +
faithfulness list reviewed before it goes to staging; each needs a Test Lab / staging
eyeball for pixel-level equivalence.

---

## 4. Image-first generation (owner: strategic direction) 📐

**Concern:** "we should focus image first — this is the challenge. Simpler to
write a story around it."

**Design (proposed, for discussion):** invert the current text→image order for
(at least) an experimental mode:
1. From the character set + theme, generate a small set of **strong scene
   concepts as images first** (the hard part — composition, cast, a clear
   picturable moment), evaluated for quality/consistency before any prose.
2. Then write the **story text around the chosen images** — the narrative adapts
   to what renders well, instead of forcing the image to match arbitrary prose
   (which is where most image failures originate: un-picturable beats, too many
   characters, impossible interactions).

**Why it should help:** most image-failure modes (facing-away, crowd
degradation, impossible z-order, un-renderable beats) come from the text
dictating a scene the model can't draw. Image-first removes that constraint.

**Cost/complexity:** large — it restructures the pipeline. Best validated as a
Test Lab experiment on a few stories before committing. Ties into §5 (the outline
prompt does too much) and the testing-backlog acceptance-gate idea.

**Status:** ⏭️ SKIPPED by owner 2026-07-25 ("too big to do through mobile").
Design retained as the north-star for when it's revisited.

---

## 5. Outline prompt does too much — A/B test story quality 🧪

**Concern:** "our outline prompt has a lot of tasks. I want to A/B test if this
harms story quality."

**Findings:** ❓ (the model-cost agent is enumerating every task `story-unified.txt`
asks Claude to do in one call). The single unified call currently produces
outline + character arcs + plot structure + visual bible + per-page text +
per-page scene hints + cover hints + title candidates + clothing requirements +
a self-critique/patch loop — a very dense prompt.

**Findings:** the single unified Sonnet call performs **~26 distinct tasks** (full
enumerated checklist in the audit — dialect, character declaration + inventing
secondaries, category guidelines, scene plan, plot structure, per-character arcs,
supporting arcs, per-page text, do-not-write enforcement, per-page scene prose +
metadata JSON, full draft, 5-axis self-critique, revise, Visual Bible JSON,
landmark handling, vantages, 4 cover specs, marker formatting). Cost is
~$0.40–0.60/story and it is the single most expensive call — but judgment-locked
(Haiku already rejected for the adjacent scene-description task).

**Experiment (📐 spec):** compare **A = current single dense call** vs **B = split**
— narrative draft + critique + revise in call 1; Visual Bible + covers + arcs
metadata in call 2 (grounded on the finished text). Measure with the §6 criteria.
Depends on §7 (text-only rerun). The lever here is task-density, NOT the model.

**Status:** 🧪 LIVE — experiment defined; blocked on §7 (text-only rerun harness).
(Not skipped — earlier "skip 5" referred to rubric criterion 5, not this point.)

---

## 6. Story-quality criteria (owner: "define 3-8 criteria so we can rate") 📐

**Rubric — 5 criteria, TEXT-ONLY.** The judge evaluates the story *text* only —
NO picturability / image concerns (owner, 2026-07-25: "I want to evaluate only
the text"). Picturability belongs to the image pipeline (scene-expansion +
acceptance gate), NOT the text score. Each rated 1-5 by an LLM judge; cross-model
(written by Sonnet, judged by a different model per the testing-backlog
cross-model-review item), applied per story:

1. **Coherence & structure** — clear beginning/middle/end; each page follows from
   the last; no plot holes or dropped threads.
2. **Age-appropriateness & readability** — vocabulary, sentence length and
   concepts match the target reading level; dialect/register consistent.
3. **Character consistency** — each character's voice, traits and relationships
   stay consistent; the child protagonist is central and active.
4. **Emotional arc** — a felt emotional journey (tension → resolution); the
   emotion on each page follows from the prior line, not asserted.
5. **Language quality & delight** — natural prose, age-right humour/wonder, no
   translation artifacts; a satisfying, memorable ending.

Each criterion: 1 (fails) – 5 (excellent), with a one-line justification. Store
per-story so the outline A/B (§5), model-downgrade experiments (§9) and the
§1a-B calibration are measurable.

**Status:** ✅ CONFIRMED by owner 2026-07-25 — these 5 text-only criteria
(picturability dropped; it's an image-pipeline concern, scored separately). Ready
to wire the judge once the harness (§7) is built.

---

## 7. Test Lab: rerun same inputs, text-only 📐

**Concern:** "in the Test Lab it should be possible to rerun the same story
inputs but only generate story text."

**Findings — feasible with a small hook; the plumbing already exists:**
- The text-only pipeline already exists via the dev `skipImages` flag: threaded
  into `processUnifiedStoryJob` with a clean early-return seam AFTER text + scene
  expansion, BEFORE covers/page images (`server.js:4929-4953` returns
  `{title, pages(image:null), visualBible, tokenUsage}`). Today only the wizard
  triggers it (`StoryWizard.tsx:5785`).
- Test Lab today is per-stage regression tooling on *existing* stories
  (`testlab.js:2608-2654`) — no full-story-text regenerate stage exists.
- **Original inputs live in `story_jobs.input_data`** (authoritative, not
  `stories.data`).

**Minimal implementation (Option A, ~1 route, no `server.js` changes):** new
admin route in `server/routes/admin/testlab.js` that (1) loads the source story's
`input_data` from `story_jobs`, (2) sets `input_data.skipImages = true`,
(3) inserts a new `story_jobs` row + calls `deps.processStoryJob(jobId)` — the
exact pattern already at `jobs.js:358,397`. Then run the §6 rubric on the output.
**One thing to confirm first:** whether `stories` carries a `job_id` back to its
originating job row (raw inputs are definitely in `story_jobs.input_data`; only
the story→job linkage needs verifying).

**Action:** build Option A + wire the §6 rubric scoring. This is the harness for
§5 and §9 experiments.

**Status:** 📐 spec — feasible, minimal; autonomous-buildable once story→job
linkage is confirmed (candidate for a follow-up once the owner confirms §6 rubric).

---

## 8. Secondary characters with no avatar look like the primary (owner) 🔴

**Concern:** "sometimes secondary characters have no avatar. If only described by
text they end up looking the same as [the primary] avatar sent to the image
model."

**Findings — REPRODUCED, mechanism fully explained:**
- Two disjoint pools: primaries (`inputData.characters`, get avatars) vs
  `visualBible.secondaryCharacters` (get an image only if a *reference* is
  generated). Reference generation is gated by `minAppearances` **default 2**
  (`visualBible.js:1712-1722`) — that's the "sometimes": a secondary on **one
  page** (or dropped by the trial `maxElements` cap) never gets a reference.
- Per-page reference selection resolves `sceneCharacters` against
  `inputData.characters` **only** (`server.js:5100`), so a secondary never
  produces a colour-framed identity card. The VB-grid path drops ref-less
  secondaries via `hasRef` (`visualBible.js:1876,1882`). Net: the secondary
  contributes **zero image slots**.
- The collision: `packReferences` then sends Grok only the **primary's**
  face/body as the sole human reference, and the "REFERENCE CARD COLOURS" block
  is built strictly from primaries (`storyHelpers.js:4625-4636`). Grok's edit
  endpoint is heavily anchored to its input images → it paints the secondary
  borrowing the primary's face. The secondary's real identity survives only as
  prose, which loses to the image reference.
- Clothing fallback (`getStyledAvatarForClothing`) is NOT the culprit — identity
  is lost before any avatar-resolution runs. Affects BOTH providers (Gemini
  consumes the same `characterPhotos`), so the fix belongs at the
  reference-selection layer, not a provider branch.

**Action / fix options (agent-ranked):**
1. **Root cause:** lower/remove `minAppearances` for `secondaryCharacters`
   specifically so any named secondary gets a generated reference → flows into a
   VB cell → Grok gets an independent face. *Cost:* extra reference generation
   per story (owner cost/latency call — flagged, not auto-shipped).
2. On-demand secondary avatar + own framed card (most correct, higher effort).
3. **Backstop (cheap, no new images):** when a named secondary has no reference
   card, append its full physical description to the prompt tail + an explicit
   line that the primary's card applies to the primary ONLY and the secondary
   must be rendered with a distinct face/build (`storyHelpers.js:4625-4649`).

**Status:** 🔴 confirmed. **OWNER DECISION 2026-07-25: "Every character must be in
the visual bible."** → the structural root fix: unify the two disjoint character
pools (primaries in `inputData.characters` + secondaries in
`visualBible.secondaryCharacters`) so EVERY named character is a first-class VB
entity with its own physical identity, and every VB character gets a reference
image (remove/lower the `minAppearances` gate for characters) so none inherits
another's face. Per-page reference packing then pulls each character's own
reference. Cost of generating secondary references is accepted. QUEUED (touches
visualBible/storyHelpers/images reference-packing → after the face-repair merge).

---

## 9. Cheaper models / merge / split prompts 🧪

**Concern:** "review all prompts and which models we use — can we use cheaper
models? Can we merge or split prompts to improve quality?"

**Findings — audit complete.**

**Must STAY premium (verdicts already logged — do NOT re-litigate):** unified
story (Sonnet, narrative quality); quality-eval + bbox + entity checks
(gemini-2.5-flash — lite tried & rejected for missing small targets, 2.0-flash
can't bbox); Stage-2 compliance (qwen3-max — qwen-plus/haiku/deepseek/kimi all
flooded false CRITICALs). **Already cheap:** all page/cover/repair/avatar images
on Grok $0.02; scene-iterate + consolidation on qwen-plus; avatar style-transfer
on flash ($0.04, down from pro $0.15); face-crop validate on flash-lite.

**Top downgrade candidates (new, low-risk):**
1. **`text_check` (Sonnet, up to 16K out, 1×/story)** — mechanical proofreading,
   ~5× cheaper on flash/haiku. BUT ⚠️ see §10: the style-check agent found
   `evaluateTextConsistency` is **imported-but-never-called** (dead), while the
   cost agent assumed it runs — **reconcile whether it fires at all** before
   spending effort; if dead, delete it (it duplicates the unified self-critique).
2. **`story_ideas` (Sonnet, 2×/story)** — short creative blurbs; grok-4-fast is
   15–30× cheaper. A/B for conversion (idea text drives which story users pick).
3. **`scene_validation` + `scene_rewrite`** — pass `null` override so they
   silently ride the Sonnet default (`sceneValidator.js:644`, `images.js:4673`);
   parse/rewrite utilities → set an explicit cheap override (qwen-plus/haiku).
   **Lowest-risk, autonomous-safe candidate.**

**Merge/eliminate:** `text-consistency-check` largely duplicates the unified
prompt's own ANALYSIS→REVISE self-critique (`story-unified.txt:447-552`) — drop
or downgrade (ties to #1). Scene expansion is ALREADY merged into the unified
call (`unifiedSceneProse:true`). Keep the 3-stage image eval split (deliberate,
logged in decisions.md).

**Action:** #3 is autonomous-safe (explicit cheap override on two utility calls);
#1 needs the dead-code reconciliation first; #2 needs a conversion A/B.

**Status:** 🟢 audit done. **OWNER DECISION 2026-07-25: DOWNGRADE** the two silent-
Sonnet utility calls (scene_validation `sceneValidator.js:644`, scene_rewrite
`images.js:4673`) → explicit cheap-model override. QUEUED (touches images.js →
after the face-repair merge). #1 (text_check) + #2 (story_ideas) still pending.

---

## 10. Final style/consistency check "not working" 🔴

**Concern:** "the style consistency check at the end is not working, in my eyes."

**Findings — BROKEN, three distinct problems (owner is right):**
- **1A — dead code.** `runFinalConsistencyChecks` (`images.js:15672`) and
  `evaluateTextConsistency` (`textModels.js:1039`) are **imported** (`server.js:105,152`)
  but **never called** — grep finds only the definitions. The character/text
  final-consistency prompts (`final-consistency-check.txt`, `text-consistency-check.txt`)
  never run in production. Classic "wired-but-never-fires."
- **1B — the style audit that DOES run is detection-only.**
  `checkStoryStyleConsistency` (`styleConsistency.js:108`) runs as Step 5 of the
  repair pipeline (`images.js:8971`), clusters pages by style, returns a
  **categorical** `verdict` (`consistent`/`mixed`/`fragmented`) + `outliers[]` —
  **no numeric score**, so there's nothing to threshold. The result is attached
  to `finalChecksReport.styleConsistency` (`server.js:6692`) and **nothing reads
  it** — the code comment says it's surfaced "for **manual repair**"
  (`images.js:8965`; `regeneration.js:1535` "Detection only — no auto-repair").
  A page that flips art style is correctly flagged `outliers=[4]` and then
  shipped anyway.
- **1C — production has no style GATE on repairs.** `checkStyleMatch`
  (`images.js:16964`) is a hard gate ONLY in Test Lab (`testlab.js:2295-2318`,
  "Style drift → Redo"). The production char-fix / inpaint / iterate paths
  (`images.js:8115`, round loop `8480-8579`) never call it — a Grok/Qwen repair
  that repaints a face in flat-vector inside a watercolor scene ships.

**Action — OWNER DECISION 2026-07-25:** *"Create a separate repair path for style
that can be A/B tested in the Lab using Gemini and Grok."*
→ Build a NEW dedicated **style-consistency repair path** (distinct from
character/entity repair): identify style-outlier pages (from the existing
`checkStoryStyleConsistency` Step-5 detection) and repair them toward the
dominant style cluster. Expose it as a **Test Lab stage** that A/B's **Gemini vs
Grok** as the style-repair model. **Test-Lab-first** — not wired into the
production auto-pipeline yet, so it's low-risk to build; production wiring is a
later decision once the Lab A/B picks the better model/approach. (Also clean up
the dead `runFinalConsistencyChecks`/`evaluateTextConsistency` imports while
there.)

**Status:** 🔴 confirmed broken → 🧪 build the separate Lab-A/B style-repair path.
QUEUED (new module + testlab stage → after the face-repair merge).

---

## 11. Known AI-image limitations we don't avoid ❓

**Concern:** "we have known AI image limitations that we don't always avoid."

**Findings:** `docs/image-failure-modes.md` already catalogues 10 classes
(force/tension, z-order, canonical-view bias, hands, repeating structures,
optics, liquids, contact/support, counting/negation, crowd degradation) with a
mitigation playbook — but status is explicitly **"reference only, not
implemented yet."** So the catalogue exists; the mitigations don't.

**Action:** promote the highest-frequency classes (facing-away/canonical-view,
crowd degradation, hands-doing-things, counting) into (a) scene-expansion hazard
phrasing and (b) matching eval checks, validated one hazard at a time via Test
Lab. This is already the deferred plan in `image-failure-modes.md` — the roadmap
just prioritizes starting it.

**Status:** 🟡 catalogued, not implemented.

---

## 12. Scene-first, then per-figure correction; no facing-away (owner) 🔴📐

**Concern:** "with image evaluation — we now have a good way of changing
individual characters. So we must FIRST perfect entire scenes and THEN get
individual figures correct. And not have them facing away."

**Findings — owner is right on all three sub-points:**
- **Facing-away is actively ENCOURAGED by the prompts, not just tolerated.**
  `image-generation.txt:12` ("faces that action target — NOT the camera … faces
  away from camera with back or side visible"); `scene-expansion.txt:34` (rule
  11b forces `back view`); `storyHelpers.js:5019-5022` explicitly aims "to break
  the model's default look-at-camera pose." There is **no rule that a named lead's
  face must be visible.**
- **Eval only penalizes facing RELATIVE to the declared pose**, never absolute
  face-visibility (`image-evaluation.txt:267`); mirror/gaze-toward-viewer are
  explicitly never deducted (`:55`, `image-semantic.txt:44`); entity-consistency
  **exempts** back-turned figures (`entityConsistency.js:220`,
  `entity-consistency-check.txt:54`). So if scene-expansion declared `back view`
  (which the prompts push), a faceless hero passes every evaluator.
- **Repair is per-page interleaved, NOT global scene-first-then-figures.** One
  round loop (`maxPasses:3`, `images.js:8354`); each round every bad page picks a
  method (`repairLogic.js:179-283`). Scene-vs-figure ordering exists only *within
  a page*, and even there char-fix (step 3) outranks inpaint (step 4). Across the
  story, page 2 gets char-fix while page 5 gets iterate in the same round — no
  phase boundary.
- **char-fix cannot fix an away-facing figure.** It inpaints a front-facing
  avatar into a face bbox (`images.js:8161-8235`); a turned head has no face to
  swap and the front avatar is geometrically incoherent. A back-turned hero is
  neither detected (above) nor fixable by the per-figure tool.

**Design / action (📐, concrete):**
1. Add an **absolute face-visibility check for named leads** (quality or semantic
   eval, or a dedicated pass): a designated protagonist on a page with no visible
   face — where the beat didn't require concealment — is flagged, independent of
   declared pose.
2. **Rebalance the away-facing generation bias** (`image-generation.txt:12`,
   `buildExactPosesBlock`): "face visible unless the beat demands otherwise."
   (Prompt change → validate + owner input; it's currently a deliberate choice.)
3. **Phase boundary in `runUnifiedRepairPipeline`:** run whole-scene passes
   (iterate/inpaint) to convergence FIRST, then enter char-fix passes — and route
   a "facing-away lead" to `iterate` (scene re-stage), never `char-fix`.

**Status:** 🔴 confirmed → ⏸️ **HELD by owner 2026-07-25.** Design retained above;
revisit (likely bundled with the image-first direction §4). No implementation now.

---

## Cross-cutting theme

Points 1, 2, 3, 10, 12 share one root cause the owner named directly:
**parallel implementations + incomplete gates + fallbacks-as-fixes.** The single
most valuable structural investment is collapsing the testlab/production
duplication so there is ONE blend path, ONE colour path, ONE scoring/version
resolver, ONE scene-then-figure repair order — then every fix lands everywhere.

---

## Prioritized action list

### ✅ Shipped this pass (autonomous, low-risk, verified by syntax)
- **STEP-2C proportion gate completion** (`images.js:4891`) — was OFF on the
  production `grok` default; added the missing `sceneCharacters` arg so the
  head-to-body check runs like its siblings. Pure gate-completion.

### 🔴 Correctness bugs — recommend fixing next (need owner OK; they change behavior)
1. **Entity check fail-open ×3** (`entityConsistency.js:2025/2117/2158`) — flip to
   fail-closed / surface "unresolved" so a broken evaluator can't silently
   disable repair for a whole story. *(risk: repair-trigger behavior on flaky
   evals — mitigate by only failing closed on parse/template errors, not
   transient timeouts.)*
2. **Wire the final style check** (§10) — feed Step-5 `styleConsistency.outliers`
   back through iterate before finalize; add `checkStyleMatch` as a production
   gate on char-fix/inpaint/iterate. *(this is "the style check isn't working".)*
3. **Titleless composite covers + composite covers return `score:null`** —
   restamp on composite repaint; run eval on the composite path.
4. **Secondary-character identity** (§8) — the cheap prompt-tail backstop (#3) is
   autonomous-safe pending prompt validation; the root-cause reference generation
   (#1) is a cost decision.
5. **`styleHint` watercolor default** (`coverComposite.js:515`) — derive from
   `artStyle` instead of defaulting an `oil` story to watercolor.

### 🧪 Experiments (need §6 rubric + §7 harness first)
- Outline single-vs-split A/B (§5); model downgrades for `story_ideas` / util
  calls (§9); image-first prototype (§4); AI-image-limitation mitigations one at
  a time (§11).

### 📐 Design/behavior changes (need owner direction)
- Scene-first-then-figure repair ordering + facing-away → scene redo (§12);
  rebalance the away-facing generation bias (§12 #2); colour min-sample guard
  (§2, wants a visual before/after).

### 🏗 Structural (largest leverage, largest effort)
- Collapse duplicated paths to single sources: one image-gen dispatcher, one
  `padToGeminiRatio`, one blend (`samUnionBlend` everywhere), one cover
  text/VB-id/aspect source. This is what makes "we only improved one path" stop
  happening.

**Autonomous fixes are deliberately conservative** — the owner's core frustration
is half-done gates and unvalidated changes, so everything that alters image
output or repair-trigger behavior is proposed (with exact file:line + fix) rather
than shipped blind, since this environment can't runtime- or visually-test the
pipeline.
