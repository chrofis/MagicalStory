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
| **Empty-scene plate + scene art-style** | Generate DIRECT in-style from TEXT (`empty-scene.txt` + FULL `resolveArtStyle`, NOT the sheet/empty-scene-stripped variants on the main path), Grok `grok-imagine` edit with a landmark GEOMETRY ref only — NO style reference image | Every page's background plate (Phase 5a-pre) | ✅ 2026-08-09: this is already the shipped path and it is correct. A/B (3 Swiss landmarks × watercolor·comic·cyber·steampunk·pixar) confirms **prompt-only wins; a style REFERENCE image is REJECTED**: a char-sheet anchor under-stylises, a *scene* anchor LEAKS its own buildings into the target (Kapellbrücke morphed into the anchor's chalet village), a content-free *texture swatch* is a no-op that biases wet media toward photographic. From-scratch text-gen is LOOSER / more painterly than edit-on-a-photoreal-base (which drags toward realism). Plates themselves are excellent — the "some pages look off" impression is the FACES on the composited page, not the background. Nothing to port. | `empty_scene` | this experiment 2026-08-09 |
| **Any style that renders photographic when it shouldn't** (concept, oil — the painterly styles closest to photography) | Fix the DESCRIPTOR: name the CAMERA's fingerprints, not "photorealistic" | A commissioned painted style ships as photographs | ✅ 2026-08-16/17: shared `NOT_A_PHOTOGRAPH` constant in `ART_STYLES` — "painted by hand, never captured by a camera: no bokeh, no lens flare, no photo grain, no skin pores, no camera-real fabric; depth from atmospheric haze not optical blur; visible brushwork on every surface, faces included". Denying "photorealistic" alone does NOT work, and a negation needs a positive target to paint instead. Lead with the MEDIUM: "realistic proportions" early in a descriptor reads as "make it photographic" (that one phrase shipped a whole concept-art book as photographs). Measured on the worst pages: oil 2/2 painted, concept 3/4 then 2/2. Residual drift is per-roll variance on real-world subject matter, and now shows up as painted ENVIRONMENTS with photographic FACES (open). All 14 descriptors compressed to 386-755 chars, same shape (medium → faces → shared AGE_LINE / NOT_A_PHOTOGRAPH). | `image` | decisions.md 2026-08-16, 2026-08-17 ×2 |
| **Cyber / any "setting"-named art style** | Fix the DESCRIPTOR, not the model | Style renders photoreal despite the style prompt | ✅ 2026-08-06: cyber rewritten to name a figure MEDIUM ("cyberpunk anime, cel-shaded, never photographic") + carry cyber on neon SIGNS mounted on the scene's own fixtures, keep the story's time-of-day (no night/rain). Model swap ❌ (Gemini returned `IMAGE_OTHER`, its safety refusal, on that cover — a content-combination block, not an age rule). Steampunk already complies; audit other setting-named styles the same way. | `image` / `cover` (model override) | decisions.md 2026-08-06 |
| **Avatar Round 1** (realistic anchor) | **Grok** STANDARD | Always | ✅ preserves hair length + outfit; Gemini drifts identity (bob, invented skirt) | `avatar_realistic` | image_model_tests 2026-07-19· ⚠ 2026-07-30 competitive analysis: Gemini 3.x image ("Nano Banana 2") now leads identity-preservation in public head-to-heads — A/B QUEUED (testing-backlog #7.1) before any switch; Grok verdict stands until then |
| **Avatar Round 2** (art/style transfer) | **Grok** (default `avatarStyleTransferBackend='grok'`; Gemini optional alt via `AVATAR_STYLE_BACKEND=gemini`, model `AVATAR_STYLE_MODEL`) | Always | ✅ **Grok is the default (reverted 2026-08-09).** Gemini returns `IMAGE_OTHER` — a SAFETY refusal yielding no image — on a share of realistic-face inputs, confirmed even reframed as a fictional character; the trigger is a content COMBINATION, NOT the subject's age, and it is unpredictable input to input AND the 2026-08-09 A/B shows it is NOT a stronger watercolour styliser. Grok has a fixed moderate stylisation ceiling that prompt wording (preserve-vs-repaint-vs-content-only) and extra passes do NOT move — do not re-try prompt tweaks for "stronger watercolour". **Failure chain (2026-07-31):** per-attempt throws are consumed retries → ONE alternate-backend retry → else ship the realistic Round-1 sheet unstyled → final `ensureStyledAvatarCoverage` backstop. A character can no longer end a story with zero avatars (decisions.md "Styled-avatar MUST guarantee"). The 2026-07-19 "Gemini stylises better" verdict is REVERSED. | `avatar_style` | image_model_tests 2026-08-09 |
| Avatar sheet eval | Gemini `2.5-flash` (`sheet-2x4-style-eval.txt`) | After each Round-2 attempt | ✅ 6 checks incl. `bodyFaceScore` (body-cell faces) → redo on fail | `avatar_eval` | this repo |
| **Cover — direct** | shared `generateImageOnly` (Grok/Gemini per `coverImage`), `composite:false`; eval/detection in the pipeline (Step 1 / Phase 5b-pre) or explicitly in `iterateCover` for scored callers | **≤5 figures** (see rule below) | ✅ current default (`compositeCovers` gate → `composite` option) | `cover` (⚠️ hardcodes `compositeCovers:false`) | image_routing |
| **Cover — composite** | `iterateCover` calls the `_maybeGenerateComposite` route helper directly (`composite:true` + `compositeInputs`) → `generateCoverViaComposite` (cutouts + plate + 2-pass edit) | **>5 figures** + landmark present (rule below) | 🟡 PROVISIONAL — recently fixed eval/title drift; not yet re-tested with new Pixar avatars | `cover` with `params.composite=true` | scene_composite_killed, cover_vbid_leak |
| **Composite = a shared-path OPTION** | `_maybeGenerateComposite` is a standalone route helper (default **off**). `iterateCover` computes `compositeOn` (fig-count gate + explicit override) and calls the helper; it routes to `generateCoverViaComposite` when on AND a landmark buf is present, else returns null → direct `generateImageOnly`. Pages never call it. | covers on, pages off | ✅ owner directive: "covers = images, composite is just an option; different defaults, same code" | `cover` (`params.composite`) | decisions.md |
| Cover typography (title/Widmung/brand) | `coverTypography.composeCover` baked into served version | `appSideCoverType=true` (default) | ✅ baked into every version (2026-07-19) | via `cover` | image_routing |
| **Painted cover title** (lettering in the artwork's medium, not a flat layer) | **PLATE pass** (`server/lib/coverTitlePaint.js`): composeCover renders real-font glyphs → the title alone on a plain WHITE canvas padded to the **widest landscape preset that fits the strip (up to 20:9)** → **Grok** `grok-imagine` via `editWithGrok` DIRECTLY, with the artwork as a 2nd *style-reference* input → key on inkiness → edge-feather → composite onto the untouched textless plate | Automatic on every new frontCover (`bakeCoverTypographyPostPersist`, non-trial); on demand via `POST /stories/:id/repaint-title` (2 credits, charged only on success) | ✅ 5/5 incl. the twice-failed repro story (exps #447/#448, 2026-08-09). Plate = TITLE STRIP only, preset-padded — a cover-shaped plate page-fills (#439-#443): the model fills empty canvas and no prompt wording stops it. **The model NEVER sees the cover it edits** — the artwork is never re-rendered, so faces/background cannot degrade. **❌ never let a model SPELL the title** (2026 SOTA ~90-95% on short copy, worst on ä/ö/ü/é). **Three traps, all burned already:** (1) do NOT call `editImageWithPrompt` — it wraps the text in the `illustrationEdit` template, which is empty unless `loadPromptTemplates()` ran → Grok 400 "Prompt cannot be empty" → silent **Gemini** fallback; (2) the plate must be LANDSCAPE and TIGHT around the lettering — a wide title in a square canvas gets **re-flowed** (2 lines → 5), and any white slack invites the model to recompose the lockup into it; (3) a 3-channel mask read as 1 channel gives a squeezed, row-wrapped alpha (comb striping). **2026-08-17 (three fixes, all measured on the same cover):** cut the strip from the typography **spec rect** (~20% of page), never the pixel-diff bbox — compression noise inflated it to the 45% cap, the plate went half-empty and the lockup was recentred (coverage 0.00); pad to **20:9 / 2:1** — Grok's documented `aspect_ratio` enum includes them, the "16:9 is the widest" assumption was wrong, and at 16:9 the same tight strip still left enough slack for a 2→3-line reflow (coverage 0.33) while 20:9 passed unchanged (0.52-0.87); and call the plate "a plain flat white background", never "a strip of white paper" — the model painted a physical paper sheet with edges and a drop shadow, which composited as a hairline across the cover (spill 0.29 → 0.15). A 3-row alpha feather at the strip edge removes the residual seam. | `cover_title_paintin` (`mode:'plate'`, calls the production module) | `docs/cover-text-rendering-research.md`, decisions.md 2026-08-07 |
| **Face repair** | **Qwen** `qwen-image-edit@2511` (Runware) + SAM head mask | Face mismatch | ✅ $0.008, union-hard-pad6 blend | `char_repair` / `qwen_insert` / `repair_verify` | image_model_tests SETTLED |
| **Full-character repair** | **Grok** (crosshatch/blended) | Whole-figure mismatch | ✅ "grok makes better images" for full figures | `char_repair` | image_model_tests SETTLED |
<!-- ASSERT models.figureDetectionBackend === 'grounding-dino' -->
| Figure detection / masks | **GroundingDINO → MobileSAM (local) — DEFAULT EVERYWHERE incl. PRODUCTION since 2026-08-17** (set in `server/config/runtime.js` — behaviour lives in code, no env override; the warmup is told what to preload by the caller) | Detection for eval/repair/composite | ✅ box-prompted MobileSAM winner; full-identity text 5/5. ⚠️ box-prompt mask **blows out** on touching figures (see below) — guarded 2026-07-20 | `bbox` | image_model_tests, local_grounded_sam_detection |
| Quality eval (bbox fix_targets) | Gemini `2.5-flash` | Page quality | ✅ required for spatial fix_targets | `quality_eval` | CLAUDE.md |
| **Garment hue normalize** (fix cloth colour drift) | `normalizeGarmentHue` / `normalizeGarmentHueBatch` (garmentHueNormalize.js) — **no model**, masked LAB hue-rotation toward the character's AVATAR garment colour | Runs before EVERY eval in the chain: initial pre-eval (Phase 5b-hue) AND each repair round (before `evaluateImageBatch`), via the shared `normalizeGarmentHueBatch` driver. Corrects only outliers; per-round pass reuses the round's own detection (iterate) and skips redraws without one | ✅ lighting-preserving (rotate a*/b* about origin → L*+chroma exact); illumination-discounted so day/night survives; defers garment-TYPE errors to redraw. Flag `garmentHueNormalize`. **2026-08-06:** the AVATAR side takes NO cast discount (a reference sheet is neutral-lit; discounting it cancelled the signal — hit-rate 3/52 → 10/52), page cast comes from the background, sampling mask is SAM-else-torso-band, and the page hue matches the NEAREST of the avatar's top-K hue clusters (two-garment characters) | `garment_hue` | decisions.md 2026-07-30 + 2026-08-06 |
| Prompt-compliance eval | qwen `qwen3-max` | Stage-2 compliance | ✅ presence-is-input, never-CRITICAL gate | `quality_eval` | project_unified_call |
| **Scene composite** (non-cover, PAGES) | `generateSceneComposite`: colour-silhouette plate (Grok generate) → depopulate (Grok edit) → **GroundingDINO** person+face boxes, palette hue names them → paste avatar cut-outs at measured heights → ONE blend (Grok edit) with a metadata-built prompt, NEVER the page prompt | Pages where `needsScaleRepair()` fires (≥1 declared foreground AND ≥1 background, outdoor, no shared vessel) — it REPLACED scale repair there 2026-08-15 | 🟡 2026-08-25: blend v2 (`8c1baa515`, one positive description) held framing/cast/depth on its first run (exp 851) after exp 848 duplicated a figure and re-framed at 5451 chars. Earlier: correct on a page with real depth (Lab 726 — occluded man behind a parapet, standing figures whole). **Aborts and keeps the original render** when a detected box cannot be a person, or when tallest÷shortest figure < 2.0x (no depth to correct). Needs DINO available or it aborts every time — as of 2026-08-17 DINO is the default in prod too, so this no longer aborts there by construction. Blend prompt = goal + scene overview + cast (wearing/doing) + interactions + emotions from metadata; sending the page's own prompt RELOCATES characters (3/3). | `scene_composite` (params `figureDetect`, `figureMethod`, `blend`, `replayPasteOf`, `blendMode`) | decisions.md 2026-08-15 ×8, scene_composite_killed (superseded for pages) |
| **Style-repair** (repaint a style-outlier page/cover toward the dominant style) | `repairPageStyle` (styleRepair.js): **prompt-only** (no style-ref image), **Grok** `grok-imagine` since 2026-08-24 (`STYLE_REPAIR_MODEL=gemini` to go back). Raw validated prompt (NOT the illustration-edit template), temp 0.7, retry ≤3 on safety no-image. **Neither model is reliable:** Gemini may return `IMAGE_OTHER` — a SAFETY refusal yielding NO image, so the page keeps what it had — triggered by a content COMBINATION (e.g. a young girl in a bikini as a mermaid), NOT by adult or photoreal faces, and unpredictable page to page; Grok no-ops on other pages. A fallback across both is the real fix and is not built | Step-5 audit outliers; **ON by default** (`styleRepairProduction`) | ✅ **RE-ENABLED 2026-08-09** (supersedes same-day disable). The disable rested on two prompt bugs, not a real limit: a 9.5k page-gen prompt + a "match the reference image" instruction with NO ref attached → Gemini text-replied ("no image"). Clean prompt → Gemini restyles fine. Recipe = **character-focused + feature-preserving**: "background already correct; CHARACTERS too realistic → repaint people into {artStyle}; change only style; keep every feature exactly, eyewear if present / none if absent; add nothing, remove nothing." Validated p3/p10/initial page incl. both-ways glasses. **Grok can't restyle** (no-op ~10/255); a content-rich ref leaks the ref's people; "minimal detail/suggest features" DROPS small features (a child's eyes) — all avoided. Refused page keeps its original. | `style_repair` | decisions.md 2026-08-09 (later) |

---

## Routing rules

### Gemini vs Grok — by edit MAGNITUDE (user, 2026-07-19)
- **Big transform** (style transfer, full re-render, "make this Pixar") → **Gemini**. It renders real style; Grok under-stylises.
- **Small/precise tweak** (nudge, minor colour, targeted repair) → **Grok** (or Qwen for masked). Gemini is **lazy** on tiny edits — returns the input essentially unchanged.
- This is what the old "Gemini returns source unchanged" note actually meant: magnitude-dependent, not universal.

### Direct vs Composite cover — by FIGURE COUNT (✅ SETTLED, user decision 2026-07-19)
- **≤ 5 figures → DIRECT.** Direct renders up to 5 people fine (Pixar @5 verified end-to-end). Composite adds no value at these counts — it's slower, needs the analyzer, and looks more "assembled".
- **> 5 figures → composite.** Only crowded covers justify the cutout+plate path.
- **Wired** in `coverIterate.js`: the default `compositeCovers` flag gates `compositeOn` on `coverFigureCount > 5`; an explicit `options.compositeCovers === true` (Test Lab) still forces composite. `iterateCover` no longer forks — it calls the `_maybeGenerateComposite` route helper directly, falling back to the shared `generateImageOnly` direct render when the helper returns null. (`generateImageWithQualityRetry` deleted 2026-08-10 — see decisions.md.)
- (Older style-nuanced draft — comic@4, realistic@3 — is SUPERSEDED by the flat >5 rule per the user.)
  - **Realistic / painterly styles** → even **3** is challenging for direct; composite often needed.
- **⚠️ GATING FACT (2026-07-19): the composite cover path requires a LANDMARK photo.** `generateCoverViaComposite` builds its background plate from a landmark; with no landmark, the shared path (`images.js _maybeGenerateComposite`) logs "composite requested but no landmark buffer — using normal generation" and **silently falls back to DIRECT** (the fallback moved from coverIterate into the shared function when composite became an option). So for landmark-less stories (e.g. first-kindergarten), `compositeCovers:true` never engages — the rule is moot, it's always direct. Composite also needs the Python analyzer (port 5000) up for figure detection/cutouts (cascade-detect); it was down in local runs (`fetch failed`).
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

### Figure-detection blown mask — REJECT rule (✅ 2026-07-20, revised)
The point-prompt-from-head approach was replaced (user preference) with a simpler validation at
Stage 2 (`server/lib/images.js` `_cleanMaskAndCheck`): the DINO box is trusted; a box-prompted SAM
mask is ACCEPTED (its bounds become `bodyBox`) ONLY when it is ONE connected figure ≤10% larger than
the DINO box. Specks are always trimmed (largest connected component kept). If the mask has a real
disconnected region (>3% of the main figure) OR exceeds the DINO box by >10%, it is REJECTED and the
tight DINO box is used as `bodyBox`. Output field `maskVerdict` = mask-ok | rejected-disconnected |
rejected-over-10pct | no-mask. grounding-dino path only; Gemini bbox untouched. (Historical detail below.)

### Figure-detection blown mask — box-prompt union (root cause, 2026-07-20)
Local grounding-dino path: MobileSAM is BOX-prompted per DINO person box and `/figure-mask`
UNIONS every mask it returns. On flat painterly art (watercolour/oil) with touching figures the
silhouette grabs neighbours + background, so `bodyBox = mask bounds` EXPLODES — measured 2.1×–4.2×
the DINO box (a whole-frame box for one figure), which breaks text placement AND character repair
(repair targets the figure box → a blown box has no figure to fix). **The DINO box itself is tight
and correct** — figures where SAM failed (`samApplied=false`) fell back to the DINO box and were all
accurate. FaceBox/head point accurate throughout. **Fix** (`server/lib/images.js`, after Stage-3 face
pairing): any `samApplied` det with `bodyBox ≥ 1.6× gdinoBox` → re-derive the silhouette by
POINT-prompting SAM from the head point + a torso point one head-height below (`_mobilesamMaskPoints`);
if that still blows out / fails, drop the mask and keep the tight `gdinoBox`. Verified: −57%…−81%
area, correct single figure. grounding-dino path only; Gemini bbox path never reaches it. Re-test via
the `bbox` Test Lab stage on a multi-figure painterly page.

### Avatar 2×4 LAYOUT validation — split-figure defect (2026-07-19)
Grok Round-1 sometimes renders ONE figure split across the mid-row divider (top = head+torso, bottom = lower body) instead of 4 head-cells + 4 body-cells. If it ships, the composite extracts cell 5 as a **headless lower body** → broken cover.
- **Detection:** `quickLayoutCheck` (deterministic gutter-uniformity, `character2x4Sheet.js`) catches it — Emma's split anchor scored 41.5%/57.8% gutter uniformity (< 60% ⇒ fail). Production's `generateCharacter2x4Sheet` runs it + the Gemini Pass-1 eval + **up to 3 retries**; verified live — Emma retried (attempt 1 split → attempt 3 clean) then oil-stylised valid.
- **⚠️ `quickLayoutCheck` is WHITE-BACKGROUND / REALISTIC-sheet only.** It measures gutter *whiteness*, so painterly/textured styles (oil, watercolor) FALSE-POSITIVE even when the layout is correct (verified: Sarah 25.3% + Noah 57.4% oil sheets were structurally fine but flagged). Documented as "over-eager" in `character2x4Sheet.js` (comment ~672, why the Pass1→Pass2 gate was removed 2026-05-17). **Do NOT wire it as a hard gate on Pass-2 / styled sheets.**
- **Pass-2 has no deterministic layout guard** — only the Gemini styled-sheet eval, which validates layout *preservation* (styled vs anchor), not *correctness*; a bad anchor passes as "faithfully preserved." So the guarantee lives at Round 1 (validate the anchor), not Round 2.
- **RULE for experiment harnesses:** never reuse a raw one-shot `editWithGrok` anchor — run Round 1 through `generateCharacter2x4Sheet` (validated + retry) or gate the anchor on `quickLayoutCheck`, or you test on broken sheets (this is why the Pixar/oil A/B harness produced a split Emma).

---

### Page composite — what the blend may and may not be told (✅ measured 2026-08-15)

Nine blend variants on ONE fixed pasted canvas (Lab 695–705, replayed with
`params.replayPasteOf` so only the words changed — a fresh composite re-rolls
the plate and makes two prompts incomparable):

| variant | result |
|---|---|
| the page's own generation prompt | character relocated off the bridge, 3/3 |
| poses reworded as descriptions of Image 1 | relocated again |
| page prompt minus Composition / EXACT POSES / EXPRESSIONS | stayed, but sat ON the parapet |
| a generic line explaining what a clipped figure means | relocated |
| naming the occluder explicitly | worst — giant figure on a plank that does not exist |
| retouch-only, no page prompt | DELETED the half-hidden man as an artefact |
| retouch + a cast census | correct, but blank faces |
| census + expressions + attention | expressions landed; frame crept in, feet cut |
| the above at 5451 chars, full DO-NOT block (exp 848) | DUPLICATED the occluded man at foreground size AND re-framed — both explicitly forbidden in that prompt |
| one positive description, no DO-NOTs, 1635 chars (exp 851, `8c1baa515`) | held framing, cast, and depth; occluded man engaged with the railing at background size; gaze/expression only partially landed |

Rules that follow, and the reason each exists:
- **Never send the page prompt.** Its `Composition`, `EXACT POSES` and
  `EXPRESSIONS` sections are orders to arrange a scene; the scene is already
  arranged, so the model carries them out.
- **Always send a cast census.** Without it a partly-hidden figure is painted out.
- **Rewording does not defuse a staging instruction** — deletion does.
- **Do not add another prohibition.** Four have been overridden; prompt length
  itself pulls the camera in (1810 chars held the framing, 3063 cut feet;
  5451 duplicated a figure and re-framed THROUGH the prohibitions, exp 848).
- **State the picture, not the repairs.** One positive description at 1635
  chars (each fact once, no scene overview, no DO-NOT list, occluder unnamed)
  held framing/cast/depth on the page that failed at 5451 — exp 851,
  `8c1baa515`. One clean run, not yet a corpus.
- **Eval-then-repair is not an escape hatch.** Feeding the top-3 evaluator
  findings back as the repair instruction reproduced the same relocation, because
  the evaluator scores the paste against the same brief and its prescribed fix
  literally says "Regenerate".

### Page composite — detection (✅ measured 2026-08-15)

DINO for boxes, palette for identity, DINO face box for the head. Colour-only
detection on the plate was measured and INVERTS the depth verdict on all three
test pages (bridge timbers read as the red character; lawn as the yellow one),
so the depopulated background cannot be skipped for the diff detector — and the
DINO detector does not need it at all. SOM naming is useless on ghosts (UNKNOWN
for 4 of 5, Lab 723): a flat cartoon figure gives a VLM nothing to recognise.

---

## Test Lab stage map (route BACK here to re-test, don't re-script)

`image`, `empty_scene`, `quality_eval`, `semantic_eval`, `bbox`, `char_repair`, `entity`, `text_zone`, `consolidate`, `inpaint`, `iterate`, `repair_round`, `edit_image`, `artifact_repair`, `scale_repair`, `style_transfer`, `pick_best`, `scene_expansion`, `scene_expansion_ab`, `scene_variant`, `scene_description`, `rewrite_blocked`, `repair_verify`, `qwen_insert`, `avatar_realistic`, `avatar_style`, `avatar_eval`, `cover`, `style_check`, `style_repair`.

`style_repair` (story-level, target `{storyId}`): the missing repair half of the detection-only
`style_check` — finds style-outlier pages via `checkStoryStyleConsistency`, repaints each toward the
dominant cluster with BOTH Gemini and Grok (`repairPageStyle`, model-parameterized), and surfaces the
two candidates side-by-side with before/after `checkStyleMatch` scores so a human picks the winning model.
`params.characterRefs: true` adds a second arm per model — the same repaint with the page cast's styled
avatars attached as style reference sheets (`gemini` vs `gemini+refs`, `grok` vs `grok+refs`) — which is
the A/B holding `styleRepairCharacterRefs` flag-off. Doubles the images per page; pair it with
`params.maxTargets: 1` and pin the page via `params.pages` so both runs hit the same target.
Test-Lab-first; production wiring deferred (decisions.md Pt 10).

Targets: page stages `{storyId, pageNumber}`; avatar stages `{storyId, character}`; story-level `{storyId}` (+ `coverType` for `cover`).

---

## Open experiments / gaps (to close, not re-derive)

- **Composite cover with new Pixar avatars — UNTESTED.** The `cover` stage now accepts `params.composite=true` (added 2026-07-19). Remaining enabler: the story's characters must be re-avatared through the new Grok-R1→Gemini-R2 pipeline (showcase avatars are old all-Grok) so the composite pulls the good Pixar cutouts. Then run 5-figure composite vs direct to validate the figure×style rule. UI toggle in the Test Lab client (`params.composite`) still to be exposed.
- **Direct-vs-composite thresholds are intuition only** — pin per style with lab runs (comic@4, realistic@3).
- **Faces-in-style ceiling (the real scene weak point, 2026-08-09).** Backgrounds stylise fine; on final composited pages the CHARACTERS' faces render semi-photographic under painterly styles (watercolor/oil), which reads as "wrong style" even though the plate is correct. This is a character-rendering problem (avatar Round-2 style ceiling + composite blend), NOT a scene-style problem — scene style is settled (row above). Experiment TBD: pull staging pages where faces went photographic, test a stronger face-in-style clause / per-character style pass.
- **✅ ANSWERED 2026-08-24 — per-page art-style drift on adult-cast books was cause (d), not (a)/(b)/(c):** the repaint produced **no image at all**. Gemini returned `IMAGE_OTHER` — its safety refusal, no image at all — on both photographic pages of staging `job_1787638394061_hs70901tfsn` and in Lab #837, and Gemini was the default. The refusal is triggered by content combinations, not by adult or photoreal faces, and Gemini restyles comparable pages fine on other runs — so that 16-page book shipped 4 pages the audit itself flagged photographic, after 18 attempts kept 3. Grok repaints the same page correctly in ~18s/$0.02. Default flipped to Grok; gate rejections and errors are now recorded per attempt in `finalChecksReport.styleConsistency.repairs`, so a future run is diagnosable without re-deriving. decisions.md 2026-08-24.
- **Per-page art-style drift (original 2026-08-09 note, kept for the other candidate causes)** despite `style_repair` wired to prod. Some pages in a finished story read as a visibly different art style. Root cause unconfirmed — three candidates to check on a real multi-page story before any fix: (a) `checkStoryStyleConsistency` under-detects (threshold too loose), (b) the repaint fires but fails the `checkStyleMatch` gate and is discarded, or (c) the "drift" is actually the faces-in-style ceiling above, not a whole-page flip. Do NOT re-derive — pull a recent story, score every page's style, and see which pages drift + whether `style_repair` fired.
