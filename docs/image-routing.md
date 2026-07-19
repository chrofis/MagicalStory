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

### Direct vs Composite cover — by FIGURE COUNT × STYLE (🟡 PROVISIONAL, user 2026-07-19, not yet lab-verified)
- **1-2 figures → direct only.** Composite adds no value; extra cost + drift risk.
- **3+ figures → try composite** — but the threshold shifts with style:
  - **Comic / cartoon / abstract avatar styles** → direct tolerates **3, even 4** figures.
  - **Realistic / painterly styles** → even **3** is challenging for direct; composite often needed.
- **Status: intuition, not tested.** The experiment to validate it = a 5-figure composite cover with the new Gemini-Pixar avatars vs the direct 5-figure cover. Blocked on two enablers (see Open below).

---

## Test Lab stage map (route BACK here to re-test, don't re-script)

`image`, `empty_scene`, `quality_eval`, `semantic_eval`, `bbox`, `char_repair`, `entity`, `text_zone`, `consolidate`, `inpaint`, `iterate`, `repair_round`, `edit_image`, `artifact_repair`, `scale_repair`, `style_transfer`, `pick_best`, `scene_expansion`, `scene_expansion_ab`, `scene_variant`, `scene_description`, `rewrite_blocked`, `repair_verify`, `qwen_insert`, `avatar_realistic`, `avatar_style`, `avatar_eval`, `cover`, `style_check`.

Targets: page stages `{storyId, pageNumber}`; avatar stages `{storyId, character}`; story-level `{storyId}` (+ `coverType` for `cover`).

---

## Open experiments / gaps (to close, not re-derive)

- **Composite cover with new Pixar avatars — UNTESTED.** The `cover` stage now accepts `params.composite=true` (added 2026-07-19). Remaining enabler: the story's characters must be re-avatared through the new Grok-R1→Gemini-R2 pipeline (showcase avatars are old all-Grok) so the composite pulls the good Pixar cutouts. Then run 5-figure composite vs direct to validate the figure×style rule. UI toggle in the Test Lab client (`params.composite`) still to be exposed.
- **Direct-vs-composite thresholds are intuition only** — pin per style with lab runs (comic@4, realistic@3).
