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

**Action:** ❓ full consolidated inventory from the completeness sweep, then a
prioritized fix pass. The version-index↔array-index normalization deserves a
single shared resolver used everywhere (`findIndex(v => v.versionIndex === active)`).

**Status:** 🟡 several fixed on staging; systemic version-index normalization pending.

---

## 2. Colour shifting (owner: "recently had issues")

**Concern:** a recent colour-shift regression.

**Findings:** ❓ (colour-path map from the completeness sweep). Known from review:
`samBlend` bg-material offset has no minimum-sample guard (a 3-pixel "material"
gets a full LAB shift → speckled fringe); `bgBorderMatch` defaults ON in
production while the face-insert path is documented "FEATHER-ONLY, colorCorrect
false" — so production runs a colour knob it doesn't think it runs. Multiple
colour ops (`correctColorShift`, `samBlend`, `colorAware`, `harmonicBackgroundFill`)
with different guard levels.

**Action:** ❓ identify the most likely recent-regression culprit, add the
missing min-sample guard, reconcile which colour ops run in production vs testlab.

**Status:** ❓ under investigation.

---

## 3. Multiple implementations of one feature (owner's core frustration)

**Concern:** "the pipeline often has 2-5 different versions of one feature
implemented, but we then only improve ONE path. Or introduce gates that are not
complete. And instead of fixing properly, fallbacks are created."

**Did the review cover this?** Partially — it surfaced many instances (testlab↔
production blend has 7 near-copy blocks; production face-repair lacks the style
gate + erode-then-feather + lossless-PNG that testlab has; Runware branches
diverge) but was not *organized* around this theme. The completeness sweep (in
flight) produces three dedicated inventories: **duplicated paths**, **incomplete
gates**, **fallback-instead-of-fix**.

**Action:** ❓ then a consolidation strategy — the recurring root cause is that
testlab and production reimplement the same blend/repair steps. The durable fix
is to make production CALL the same functions testlab does (single source), not
maintain parallel copies. The `fixing-sibling-paths` skill exists precisely
because this recurs.

**Status:** ❓ inventories pending; consolidation is the highest-leverage structural work.

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

**Status:** 📐 spec — needs owner go-ahead + a Test Lab prototype.

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

**Status:** 🧪 experiment defined; blocked on §7 (text-only rerun) + §6 (criteria).

---

## 6. Story-quality criteria (owner: "define 3-8 criteria so we can rate") 📐

**Proposed rubric (6 criteria, each rated 1-5 by an LLM judge + optionally a
human).** Cross-model: written by Sonnet, judged by a different model (per the
testing-backlog cross-model-review item), applied per story:

1. **Coherence & structure** — clear beginning/middle/end; each page follows from
   the last; no plot holes or dropped threads.
2. **Age-appropriateness & readability** — vocabulary, sentence length and
   concepts match the target reading level; dialect/register consistent.
3. **Character consistency** — each character's voice, traits and relationships
   stay consistent; the child protagonist is central and active.
4. **Emotional arc** — a felt emotional journey (tension → resolution); the
   emotion on each page follows from the prior line, not asserted.
5. **Picturability** — every page contains exactly one clear, renderable "picture
   moment" (one frozen instant, ≤3 focal characters, no un-drawable action). This
   criterion doubles as the bridge to the image pipeline.
6. **Language quality & delight** — natural prose, age-right humour/wonder, no
   translation artifacts; a satisfying, memorable ending.

Each criterion: 1 (fails) – 5 (excellent), with a one-line justification. Store
per-story so A/B runs (§5) and model-downgrade experiments (§9) are measurable.
Keep it to these 6 unless the owner wants to add/drop — the point is a stable
number to compare against, not a perfect taxonomy.

**Status:** 📐 proposed — owner to confirm the criteria before we wire the judge.

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

**Status:** 🔴 confirmed. #1 needs an owner cost decision; #3 is autonomous-safe
(prompt-builder, no cost change) — candidate for this pass, pending prompt validation.

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

**Status:** 🟢 audit done; #3 shippable, #1/#2 need a decision/A-B.

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

**Action (concrete, owner to pick scope):**
1. Wire Step-5 `styleConsistency.outliers` into the repair loop — feed those
   pages back through `iterate` before finalizing (or block "done" + enqueue an
   auto-redo). This is the smallest change that makes the existing check *do*
   something.
2. Add `checkStyleMatch` as a production gate on char-fix/inpaint/iterate outputs
   (reuse the Test Lab gate) so a style-flipped repair is rejected.
3. Decide: delete the dead `runFinalConsistencyChecks`/`evaluateTextConsistency`
   or actually invoke them (they overlap Step 5 + text-consistency — likely
   delete text-consistency-in-pipeline unless you want a text pass).

**Status:** 🔴 confirmed broken. All three fixes change generation/repair behavior
→ owner decision on scope before shipping (no blind pipeline-behavior changes).

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

**Status:** 🔴 confirmed. Fixes change generation/repair behavior → owner scope
decision; all three are exactly what the owner asked for, so likely go-ahead.

---

## Cross-cutting theme

Points 1, 2, 3, 10, 12 share one root cause the owner named directly:
**parallel implementations + incomplete gates + fallbacks-as-fixes.** The single
most valuable structural investment is collapsing the testlab/production
duplication so there is ONE blend path, ONE colour path, ONE scoring/version
resolver, ONE scene-then-figure repair order — then every fix lands everywhere.
The completeness sweep (in flight) turns this into a concrete work-list.
