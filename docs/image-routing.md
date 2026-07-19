# Image Generation Routing Hub

**The single decision map: for a given image task, which method/model to use, what the verdict was, and which Test Lab stage re-tests it — so we stop re-deriving and flipping back and forth.**

- **Read this before any image-gen routing decision** (which model, direct vs composite, which pass).
- **Update this after every experiment**: add the verdict + link the Test Lab stage that reproduces it.
- Deep verdict detail lives in memory `project_image_model_tests.md`; entry-function inventory in `docs/image-generation-methods.html`; Grok-vs-Gemini prose in `docs/codebase-guide.md`. This file is the **router** that points at them.

Test Lab: `/admin/test-lab`. Stages run via `server/lib/testlab.js` `STAGE_RUNNERS` / `AVATAR_STAGES` / `STORY_STAGES`. Recipe to add a stage: `reference_testlab_howto` memory.

---

## Decision matrix

| Task | Method / Model | When | Verdict | Test Lab stage | Ref |
|---|---|---|---|---|---|
| **Page (scene) image** | Grok `grok-imagine` (default) | Always default | ✅ $0.02, half of Gemini, "good enough" storybook | `image` | image_model_tests |
| Page — strict cross-page style | Gemini `2.5-flash-image` backend override | Story needs uniform style across 10-15 pages | ✅ better consistency, 2× cost | `image` (model override) | image_model_tests |
| **Avatar Round 1** (realistic anchor) | **Grok** STANDARD | Always | ✅ preserves hair length + outfit; Gemini drifts identity (bob, invented skirt) | `avatar_realistic` | image_model_tests 2026-07-19 |
| **Avatar Round 2** (art/style transfer) | **Gemini** `gemini-3-pro-image-preview` | Always (shipped 2026-07-19) | ✅ real Pixar 3D; Grok barely stylises. `avatarStyleTransferBackend='gemini'` | `avatar_style` | image_model_tests 2026-07-19 |
| Avatar sheet eval | Gemini `2.5-flash` (`sheet-2x4-style-eval.txt`) | After each Round-2 attempt | ✅ 6 checks incl. `bodyFaceScore` (body-cell faces) → redo on fail | `avatar_eval` | this repo |
| **Cover — direct** | `iterateCover` normal path (Grok/Gemini per `coverImage`) | **1-2 figures** (see rule below) | ✅ current default (`compositeCovers` gates composite) | `cover` (⚠️ hardcodes `compositeCovers:false`) | image_routing |
| **Cover — composite** | `generateCoverViaComposite` (cutouts + plate + 2-pass edit) | **3+ figures**, style-dependent (rule below) | 🟡 PROVISIONAL — recently fixed eval/title drift; not yet re-tested with new Pixar avatars | `cover` with `params.composite=true` | scene_composite_killed, cover_vbid_leak |
| Cover typography (title/Widmung/brand) | `coverTypography.composeCover` baked into served version | `appSideCoverType=true` (default) | ✅ baked into every version (2026-07-19) | via `cover` | image_routing |
| **Face repair** | **Qwen** `qwen-image-edit@2511` (Runware) + SAM head mask | Face mismatch | ✅ $0.008, union-hard-pad6 blend | `char_repair` / `qwen_insert` / `repair_verify` | image_model_tests SETTLED |
| **Full-character repair** | **Grok** (crosshatch/blended) | Whole-figure mismatch | ✅ "grok makes better images" for full figures | `char_repair` | image_model_tests SETTLED |
| Figure detection / masks | GroundingDINO → MobileSAM (local) or Gemini bbox | Detection for repair/composite | ✅ box-prompted MobileSAM winner; full-identity text 5/5 | `bbox` | image_model_tests, local_grounded_sam_detection |
| Quality eval (bbox fix_targets) | Gemini `2.5-flash` | Page quality | ✅ required for spatial fix_targets | `quality_eval` | CLAUDE.md |
| Prompt-compliance eval | qwen `qwen3-max` | Stage-2 compliance | ✅ presence-is-input, never-CRITICAL gate | `quality_eval` | project_unified_call |
| **Scene composite** (non-cover) | — | — | ❌ **KILLED** 2026-05-16 (style drift, label leak) — don't re-enable without gate | — | scene_composite_killed |

---

## Routing rules

### Gemini vs Grok — by edit MAGNITUDE (user, 2026-07-19)
- **Big transform** (style transfer, full re-render, "make this Pixar") → **Gemini**. It renders real style; Grok under-stylises.
- **Small/precise tweak** (nudge, minor colour, targeted repair) → **Grok** (or Qwen for masked). Gemini is **lazy** on tiny edits — returns the input essentially unchanged.
- This is what the old "Gemini returns source unchanged" note actually meant: magnitude-dependent, not universal.

### Direct vs Composite cover — by FIGURE COUNT (✅ SETTLED, user decision 2026-07-19)
- **≤ 5 figures → DIRECT.** Direct renders up to 5 people fine (Pixar @5 verified end-to-end). Composite adds no value at these counts — it's slower, needs the analyzer, and looks more "assembled".
- **> 5 figures → composite.** Only crowded covers justify the cutout+plate path.
- **Wired** in `coverIterate.js`: the default `compositeCovers` flag now gates on `coverFigureCount > 5`; an explicit `options.compositeCovers === true` (Test Lab) still forces composite for testing.
- (Older style-nuanced draft — comic@4, realistic@3 — is SUPERSEDED by the flat >5 rule per the user.)
  - **Realistic / painterly styles** → even **3** is challenging for direct; composite often needed.
- **⚠️ GATING FACT (2026-07-19): the composite cover path requires a LANDMARK photo.** `generateCoverViaComposite` builds its background plate from a landmark; with no landmark, `coverIterate` logs "no landmark photo for composite path — using normal generation" and **silently falls back to DIRECT** (coverIterate.js ~466). So for landmark-less stories (e.g. first-kindergarten), `compositeCovers:true` never engages — the rule is moot, it's always direct. Composite also needs the Python analyzer (port 5000) up for figure detection/cutouts (cascade-detect); it was down in local runs (`fetch failed`).
- **CORRECTION:** earlier "Pixar direct ≥ composite @5" and this oil run's "composite" were BOTH the landmark-less fallback — i.e. two DIRECT generations, not a real composite comparison. **Composite vs direct is still UNTESTED.** To test it properly: use a story WITH a landmark (e.g. Wilhelm Tell oil, rotation entry 4) AND the Python analyzer running.
- **What IS confirmed (2026-07-19):** with the new Grok-R1→Gemini-R2 avatars, **direct covers with 5 figures are excellent in both Pixar and oil** (all 5 recognizable, style-faithful). So for landmark-less multi-figure covers, direct is the working path today. Harness: `scripts/analysis/cover-composite-vs-direct.js`, `scripts/analysis/oil-experiment.js`.
- **✅ REAL oil composite achieved (2026-07-19)** by calling `generateCoverViaComposite` directly with a BORROWED background plate (an `empty_scene` from any story) as `landmarkBuf` — bypasses the landmark requirement. All 5 oil figures came out identity-LOCKED to their avatars (Emma's butterfly shirt, Noah's green hoodie, Hans present), genuine oil brushwork, on the borrowed background. Harness: `scripts/analysis/oil-composite-real.js`. **Two prerequisites, both mandatory:**
  1. **Python analyzer (port 5000) MUST be up** — `rembg` (`/remove-bg`) cuts each figure out. Down → chroma-key fallback → garbage cutouts on painterly sheets → Grok's repose pass REGENERATES generic figures (loses avatar identity/clothing, dropped a character). This is the #1 composite prerequisite.
  2. **Pass `styleHint` for the target style** — `generateCoverViaComposite`'s `styleHint` DEFAULTS to watercolor (coverComposite.js:513); passing `artStyle:'oil'` alone renders watercolor. Always pass a matching `styleHint`.
- **Composite vs direct (oil, both correct):** composite locks each figure to its exact avatar (tightest identity); direct is a more cohesive single render but identity comes from refs (can drift). ⇒ composite's real edge = strict per-figure identity, at the cost of the analyzer dependency + a more "assembled" look.
- **New avatar creation across styles — ✅ verified:** oil Round-2 (Gemini) scored 5/5 valid at final=9 first attempt (style/identity/bodyFace/clean all 9); painterly brushwork, faces present in body cells. Same pipeline, `artStyle='oil'`.

### Composite cover — figure ORIENTATION (✅ SETTLED, 2026-07-19)
The composite's all-frontal lineup reads flatter than a direct render because the cutout is always the body-front cell (Panel 5) **and** the repose prompt squares the centre to camera + forces every gaze at the viewer. Two levers tested (harness `scripts/analysis/cover-orient-ab.js`, `generateCoverViaComposite({orient})`, 5 oil figures, grid `scratchpad/cover-orient-ab.html`):
- **`turned-prompt` ✅ WINNER (recommended default).** Keeps the faithful front cutout; the repose prompt turns flanking shoulders ~30° toward the group and relaxes the forced eyes-at-viewer into a natural mix (outer figures glance inward). Candid family-photo feel, real depth, **no identity drift**. Grok reposes body rotation reliably when instructed (`feedback_grok_inpaint_capability`).
- **`turned-source` ❌ REJECTED.** Swapping outer cutouts to the 45° Panel-6 cell caused **clothing identity drift** (Noah's plain olive hoodie → camouflage) — the turned cell is a lower-fidelity clothing render and Grok amplifies it. Small orientation gain, not worth the identity risk.
- **`both` ❌** inherits the turned-source drift.
- **`frontal`** = old prod behaviour (flat lineup), kept as the control / fallback.
- Lever lives in `coverComposite.js generateCoverViaComposite({orient})`, threaded through `coverIterate.js` (`options.orient`) and the Test Lab `cover` stage (`params.orient`). Reverses the earlier "every cover figure faces the reader" decision (coverComposite.js ~720) **for outer figures only** — the centre still favours the viewer.
- **Feet-crop regression (fixed 2026-07-19):** first turn-prompt pass cropped the CENTRAL cluster at the shins (turn + "pulling close" made Grok redraw them larger/lower, feet off the bottom edge; once pass-1 crops, the cutout can't recover shoes). Fixed with a per-pose `feetClause` ("keep the whole figure head-to-feet at the same scale, both feet + footwear visible, never crop at ankles/shins/knees, do not enlarge past the bottom edge") appended to every POSE line — universal (all modes). Re-run: all five shod and full-length in both turn variants.

### Avatar 2×4 LAYOUT validation — split-figure defect (2026-07-19)
Grok Round-1 sometimes renders ONE figure split across the mid-row divider (top = head+torso, bottom = lower body) instead of 4 head-cells + 4 body-cells. If it ships, the composite extracts cell 5 as a **headless lower body** → broken cover.
- **Detection:** `quickLayoutCheck` (deterministic gutter-uniformity, `character2x4Sheet.js`) catches it — Emma's split anchor scored 41.5%/57.8% gutter uniformity (< 60% ⇒ fail). Production's `generateCharacter2x4Sheet` runs it + the Gemini Pass-1 eval + **up to 3 retries**; verified live — Emma retried (attempt 1 split → attempt 3 clean) then oil-stylised valid.
- **⚠️ `quickLayoutCheck` is WHITE-BACKGROUND / REALISTIC-sheet only.** It measures gutter *whiteness*, so painterly/textured styles (oil, watercolor) FALSE-POSITIVE even when the layout is correct (verified: Sarah 25.3% + Noah 57.4% oil sheets were structurally fine but flagged). Documented as "over-eager" in `character2x4Sheet.js` (comment ~672, why the Pass1→Pass2 gate was removed 2026-05-17). **Do NOT wire it as a hard gate on Pass-2 / styled sheets.**
- **Pass-2 has no deterministic layout guard** — only the Gemini styled-sheet eval, which validates layout *preservation* (styled vs anchor), not *correctness*; a bad anchor passes as "faithfully preserved." So the guarantee lives at Round 1 (validate the anchor), not Round 2.
- **RULE for experiment harnesses:** never reuse a raw one-shot `editWithGrok` anchor — run Round 1 through `generateCharacter2x4Sheet` (validated + retry) or gate the anchor on `quickLayoutCheck`, or you test on broken sheets (this is why the Pixar/oil A/B harness produced a split Emma).

---

## Test Lab stage map (route BACK here to re-test, don't re-script)

`image`, `empty_scene`, `quality_eval`, `semantic_eval`, `bbox`, `char_repair`, `entity`, `text_zone`, `consolidate`, `inpaint`, `iterate`, `repair_round`, `edit_image`, `artifact_repair`, `scale_repair`, `style_transfer`, `pick_best`, `scene_expansion`, `scene_expansion_ab`, `scene_variant`, `scene_description`, `rewrite_blocked`, `repair_verify`, `qwen_insert`, `avatar_realistic`, `avatar_style`, `avatar_eval`, `cover`, `style_check`.

Targets: page stages `{storyId, pageNumber}`; avatar stages `{storyId, character}`; story-level `{storyId}` (+ `coverType` for `cover`).

---

## Open experiments / gaps (to close, not re-derive)

- **Composite cover with new Pixar avatars — UNTESTED.** The `cover` stage now accepts `params.composite=true` (added 2026-07-19). Remaining enabler: the story's characters must be re-avatared through the new Grok-R1→Gemini-R2 pipeline (showcase avatars are old all-Grok) so the composite pulls the good Pixar cutouts. Then run 5-figure composite vs direct to validate the figure×style rule. UI toggle in the Test Lab client (`params.composite`) still to be exposed.
- **Direct-vs-composite thresholds are intuition only** — pin per style with lab runs (comic@4, realistic@3).
