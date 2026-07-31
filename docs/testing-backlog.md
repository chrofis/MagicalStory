# Pipeline Testing Backlog — Experiments to Run

> Status: **candidate experiments, none implemented yet.** Each item is a
> hypothesis with a measurement, not a decision. Log the verdict (✅/❌/🟡) in
> `docs/decisions.md` (or the matching memory file) once run, and delete the
> entry here.
>
> Seeded 2026-07-21 from an external model's pipeline review. The raw list was
> **curated, not pasted** — items already shipped were dropped, and one item
> was *inverted* because it contradicts a rule this codebase already learned
> the hard way (see "Rejected as written" below).

Run order (highest leverage first): **review-prompt rewrite → cross-model
review A/B → acceptance-gate extension → enum scene descriptors → batch/cache
for the offline eval path.**

---

## 1. Rewrite the self-critique into per-page failure-mode verdicts

**Hypothesis:** The current self-critique (in `prompts/story-unified.txt`,
draft → self-critique → patch) asks a soft "is this good?" question. Replacing
it with per-page verdicts against *named* failure modes catches more real
defects.

**What to try:** For each page, force a yes/no on concrete questions instead of
a holistic score:
- Is this beat renderable as **one frozen instant** (not a sequence)?
- Does the emotion **follow from the prior line**?
- Is the **dialect/register consistent** with the rest of the book?
- Is exactly one clear "picture moment" present? (If none → structural flag.)

**Measure:** Regeneration/patch rate and downstream image-eval scores across a
fixed set of ~50 books, old prompt vs new. Do this **before** touching models —
a better prompt on the same model may be the whole win.

**Note:** This is the prerequisite for #2 — fix the review *question* before
changing the reviewer.

---

## 2. Cross-model review A/B — Sonnet writes, Opus reviews

**Hypothesis:** Same-model self-critique mostly produces agreement (the current
setup is Sonnet critiquing Sonnet). A *different* model reviewing catches
absences the writer is blind to. Review is the high-leverage call: small token
volume, touches 100% of output, and "noticing what's absent" is the harder
judgment where the stronger reviewer should pay off.

**What to try:** Sonnet 5 drafts → **Opus 5** runs the (rewritten, #1) review
pass → Sonnet patches.

**Measure:** 50 books each way (Sonnet-reviews vs Opus-reviews), compare
regeneration rate and eval scores. **If Opus doesn't catch more, keep Sonnet on
both** — don't pay Opus rates for a null result.

**Explicitly rule out:** Opus-writes / Sonnet-reviews. Prose quality is not the
bottleneck on 15-page books, and Opus's long-horizon-coherence edge doesn't
bind at this length; spending it on writing is the wrong allocation.

---

## 3. Extend the acceptance gate — count / position / location, with fallback

**Already exists:** the pipeline runs quality + semantic + entity-consistency
eval and auto-repairs low-scoring pages (Gemini `fix_targets` bboxes). So
"point Gemini at your own output" is **done** — this item is only the *new*
parts layered on top.

**What to try (new):**
1. Turn the existing detection into a hard **acceptance gate**: correct
   character *count*, roughly correct frame positions, correct location →
   pass/fail number, not a judgment call.
2. On fail → regenerate, then **fall back to a simpler shot** (fewer figures /
   wider framing / less interaction) rather than retrying the same hard
   composition forever.
3. **Track pass rate per scene archetype** and prune the archetypes that
   chronically fail. This is the piece that turns quality into a ratcheting
   number.

**Measure:** Per-archetype pass rate before/after the simpler-shot fallback;
total regeneration cost per book.

---

## 4. Controlled-vocabulary (enum) scene descriptors

**Hypothesis:** Free-text emotion/pose descriptors ("wistful") don't render;
nameable visible cues do. This is the *same* mechanism already documented in
`docs/image-failure-modes.md` ("name the visible cue, not the intent") — extend
it from hazards to routine descriptors.

**What to try:** Emit closed enums from scene-expansion instead of prose for the
render-critical fields: `gaze: up-left`, `brows: raised-inner`, `shot: ...`.
Pair with a **closed shot vocabulary** — a verified set of `location × camera
setup` primitives the story *composes from*, so coherence is true by
construction rather than hoped for.

**Measure:** Test Lab `scene_variant` — one field migrated to enum per
experiment on benchmark pages; compare eval scores vs the free-text baseline.

---

## 5. Palette-locked consistency

**Hypothesis:** Locking the palette as explicit **hex** values (rather than
adjectives) tightens cross-page colour consistency. Complements what already
exists (per-location empty-scene plates reused across pages; VB-grid / avatar
reference-sheet conditioning).

**What to try:** Carry a per-story hex palette into the image prompt; A/B
against the current adjective-based colour guidance.

**Measure:** Entity-consistency / colour-drift eval across pages of the same
book.

---

## 6. Batch API + prompt caching for the OFFLINE path only

**Hypothesis:** The eval, bulk-regeneration, dialect-variant, and demo-book
paths are latency-tolerant and can take the 50%-off Batch API plus a
`cache_control` breakpoint after the story body (re-reads drop to ~10% of input
price; 1-hour cache pairs well with batch).

**Scope guard:** **Not** the live customer generation path — batch latency
kills the interactive experience unless the product moves to "we'll email it".
Keep this to offline/admin flows.

**Measure:** $/book on the eval + demo pipelines; confirm no correctness
regression from batching.

---

## 7. Competitive-analysis follow-ups (2026-07-30 — see docs/competitive-analysis-2026-07.md)

Ranked upgrade experiments from the 10-feature SOTA benchmark (8 best-in-class, 2 competitive).
Full evidence + sources in the analysis doc; each is a Test Lab experiment, not a blind change.

1. **Avatar identity engine A/B: Gemini 3.x image ("Nano Banana 2") vs Grok** — closes the
   Pt-1 competitive gap. 2026 head-to-heads show Gemini leading face fidelity + reference
   adherence. Re-test the IMAGE_OTHER adult-face refusals (they predate the 3.x line);
   keep Grok as refusal fallback. Log verdict in image-routing.md.
2. **Layflat hardcover tier (~CHF 59-69)** — closes the Pt-9 gap (Oscar proves $59.99
   layflat demand; our book-spread layout showcases it). Gelato catalog first, else Peecho.
3. **Trial story as persistent watermarked share link** (recoverable via deferred email) —
   category's strongest conversion lever + viral loop.
4. **On-demand landmark acquisition** (Places/Wikimedia fetch for unindexed locations) —
   "your actual neighborhood, in art"; pre-empts Nano Banana landmark commoditization.
5. **SAM 3.1 concept/exemplar prompting** for repair masks (vs box-prompted MobileSAM) —
   cleaner occlusion/multi-instance masks → higher IoU-gate pass rate.
6. **Local illuminant estimation for garment-hue normalizer** — cast from an annulus around
   each figure instead of whole-frame gray-world (mixed-light scenes).
7. **Judge-ensemble disagreement gate** — second-opinion VLM before spending a repair round.
   NOTE: staging already has default-off multi-judge jury commits (b90a3761/d5e43080) — align.
8. **Embedding identity score** (CLIP/ArcFace cosine vs VB reference) as deterministic
   pre-filter + per-entity consistency KPI.
9. **Typographic art direction** (auto font pairing, drop caps, palette-tinted panels).
10. **Production text-quality judge gate** (currently Test Lab only) + market the machinery.

## 8. Scene-prose length A/B: 250-350 words vs ~150-word cap (owner: "the scene still seems super complicated")

Every METADATA field is pipeline-consumed (verified 2026-07-31: sceneIntent/interactions/
emptyScenePrompt/framingPattern/textPosition/characterClothing each feed 2-3 files), and the
SCENE prose IS the image prompt — so the LAYERS stay. The one debatable knob is prose LENGTH:
the 250-350-word requirement predates the logged "concise prompts render better" verdict
(watercolour finding, decisions.md 2026-07-15). A/B via Test Lab on 3+ stored stories:
current length vs a ~150-word cap (traits stay verbatim; trim setting/atmosphere elaboration),
scored on image quality evals + repair rounds. If concise wins, cut the requirement in both
unified templates.

## Rejected as written (do NOT implement literally)

**"Explicit per-scene exclusion list in the prompt"** (readable text, fine hand
manipulation, mirrors, counting, >3 characters, …).

The *intent* is right, but injecting a "don't draw X" list into the generation
prompt **inverts a rule this codebase already learned**: naming a forbidden
object *attracts* it (`docs/image-failure-modes.md` class 9, "no X ATTRACTS X";
also the CLAUDE.md prompt-genericity rule). A negative list fed to the image
model makes the excluded things *more* likely to appear.

**Correct framing:** use the exclusion list **upstream**, to drive scene
*selection and simplification* (pick a beat that doesn't require a mirror /
readable text / 5 characters / counted objects), **never** as negative prompt
text handed to the generator. If a page has no picturable moment that avoids the
hazards, that's the structural signal to re-beat the page (ties into #3's
simpler-shot fallback and #1's "one picturable moment" check).

---

## Confirmations (no action — recorded so they aren't re-litigated)

- **Architecture is right as-is.** One Sonnet call producing story text +
  scene JSON is the current design and should stay — every narrative judgment
  (which moment is the picture, shot type, who's present, the emotional beat)
  is co-located with the prose making those decisions. Splitting adds a lossy
  re-interpretation step.
- **Cheap Chinese text models: skip** for the writing/review path — marginal
  savings, real risk to Swiss-German quality. Consistent with the existing
  "check tested models before recommending" rule.

## Unverified claims — confirm before acting

- External review asserted **Sonnet 5 pricing moves $2/$10 → $3/$15 on Sep 1**.
  Treat as unconfirmed; verify against Anthropic's current pricing before using
  it in any budget model. Recorded here only as a flag, not as fact.
