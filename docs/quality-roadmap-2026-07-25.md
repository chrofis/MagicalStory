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

**Experiment (📐 spec):** compare **A = current single dense call** vs **B = split**
(e.g. story text + arcs in one call; visual bible + scene hints in a second
grounded on the finished text). Measure with the story-quality criteria below.
This depends on the Test Lab text-only rerun (§7).

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

**Findings:** ❓ (the model-cost agent is checking whether a text-only path
already exists — there is a `skipImages` developer flag in the pipeline, so the
plumbing may be most of the way there). Minimal implementation sketch pending
that finding.

**Action:** add a Test Lab control that re-runs a saved story's exact inputs
through story generation with images/covers/repair skipped, emitting the story
text + the §6 rubric scores. This is the harness for §5 and §9 experiments.

**Status:** 📐 spec; feasibility ❓ pending.

---

## 8. Secondary characters with no avatar look like the primary (owner) ❓🔴

**Concern:** "sometimes secondary characters have no avatar. If only described by
text they end up looking the same as [the primary] avatar sent to the image
model."

**Findings:** ❓ (dedicated bug-trace agent running: how text-only secondary
characters flow into reference packing, and why they inherit the primary's face).

**Action:** ❓ then fix at the identified point — likely either (a) always give
every named character at least a lightweight avatar/reference, or (b) ensure a
text-only character's distinct physical description reaches the model AND that no
other character's reference is (mis)associated with them.

**Status:** ❓ under investigation; expected 🔴 confirmed.

---

## 9. Cheaper models / merge / split prompts 🧪

**Concern:** "review all prompts and which models we use — can we use cheaper
models? Can we merge or split prompts to improve quality?"

**Findings:** ❓ (prompt×model×cost table + ranked downgrade candidates from the
model-cost agent). Guardrails from memory: `gemini-2.5-flash` is required for
quality eval/bbox (lite misses small targets — already a logged verdict); don't
re-litigate rejected tech.

**Action:** ❓ downgrade the low-risk utility/formatting stages; keep judgment
stages premium; run merge/split as measured experiments (§5/§6/§7).

**Status:** 🧪 audit pending.

---

## 10. Final style/consistency check "not working" ❓

**Concern:** "the style consistency check at the end is not working, in my eyes."

**Findings:** ❓ (verification agent: is `runFinalConsistencyChecks` even called
in production, and if so is its score gated/acted-upon or just displayed?). Review
hint: the production face-insert path has NO style gate while testlab does.

**Action:** ❓ wire it / gate it / fix the threshold depending on the finding.

**Status:** ❓ under investigation.

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

## 12. Scene-first, then per-figure correction; no facing-away (owner) ❓📐

**Concern:** "with image evaluation — we now have a good way of changing
individual characters. So we must FIRST perfect entire scenes and THEN get
individual figures correct. And not have them facing away."

**Findings:** ❓ (orientation + repair-ordering agent: current pass order, whether
scene-quality is fixed before per-character repair, and whether facing-away is
detectable/repairable — face-swap repair is useless on a turned-away head).

**Design (📐, pending the finding):** enforce an explicit ordering in
`runUnifiedRepairPipeline`: **(1)** whole-scene composition/quality gate (right
cast count, right location, one clear moment, all focal faces visible / not
facing away) → regenerate the whole scene if it fails; **(2)** only once the
scene is structurally right, run per-character face/figure repair. A facing-away
focal character is a **scene-level** failure (redo the scene), not a per-figure
fix. Add a "focal faces visible" check to the scene gate.

**Status:** ❓ current ordering under investigation; 📐 target ordering drafted.

---

## Cross-cutting theme

Points 1, 2, 3, 10, 12 share one root cause the owner named directly:
**parallel implementations + incomplete gates + fallbacks-as-fixes.** The single
most valuable structural investment is collapsing the testlab/production
duplication so there is ONE blend path, ONE colour path, ONE scoring/version
resolver, ONE scene-then-figure repair order — then every fix lands everywhere.
The completeness sweep (in flight) turns this into a concrete work-list.
