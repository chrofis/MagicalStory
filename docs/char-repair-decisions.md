# Character-repair (`grok_inpaint`) decision log

This document captures the decisions we've made about how the body-target
character repair (`grok_inpaint`, the `useFullScene` branch in
`server/lib/images.js`) prepares its inpaint mask, calls Grok, and
post-processes Grok's output. We've toggled some of these knobs more than
once; the goal of this sheet is to stop relitigating.

If you're about to flip one of these decisions, **read this first**, log
the new verdict at the bottom, and update the relevant row.

## Pipeline overview

```
1. bbox in (entity consistency)
2. face-bbox union → expand body bbox to enclose face if face leaks out
3. midpoint-split bbox vs each protectedBodies neighbour
4. shape-aware crosshatch on transparent canvas, masked by silhouette
5. composite shaped hatch onto scene → masked input image
6. send (avatar, masked-input) to Grok with the slim prompt
7. resize Grok output to source dims
8. feather-composite over original scene at silhouette only
9. return final image (jpeg q95)
```

## Decision rows

Status legend: ✅ kept · ❌ rejected · 🟡 conditional/dev-toggle.

### Bbox preparation

| # | Decision | Status | Why | Last commit |
|---|---|---|---|---|
| 1 | Face-bbox union with body-bbox if face leaks out | ✅ | Otherwise crosshatch misses half the face, Grok preserves a sliver of original face alongside the repaint | `6ad7aa22` |
| 2 | Midpoint-split target bbox against `protectedBodies` neighbours on the dominant axis of centre separation | ✅ | Two adjacent figures' bboxes overlap; without contraction the crosshatch covers the neighbour and Grok repaints them too | `fb651b65` |
| 3 | `HATCH_SAFETY` margin around bbox | ❌ (was 0.12) | The padding gave Grok room to scale the figure up, reading as "moved forward". Now `0` — hatch hugs the silhouette | `fb651b65` |

### Mask shape

| # | Decision | Status | Why | Last commit |
|---|---|---|---|---|
| 4 | Solid magenta block over face | ❌ | Originally added so Grok knows what to repaint; superseded once the silhouette became the primary signal | `059d7763` |
| 5 | Cyan outline overlay tracing the silhouette | ❌ | Outline alone wasn't strong enough — Aurora still scaled the figure | `059d7763` |
| 6 | Solid blue interior fill on the silhouette | ❌ | Strong size signal but eval scores cratered (95→50%); model fought the colour as much as honoured it | `0e50d6a4` |
| 7 | **Shape-aware crosshatch** (inpaint mode) — magenta hatch SVG drawn on transparent canvas, then `dest-in` masked by the silhouette | ✅ | One unambiguous signal ("repaint the magenta region"), the magenta region IS the figure's exact shape, no rectangle to fill, no second colour to interpret | `0e50d6a4` |
| 7b | **Shape-aware face blur** (blended mode) — target face crop is rembg'd; the blur is clipped to the silhouette so only the face/head pixels are softened | ✅ | Mirrors decision #7 for the face-mode path. Removes the rectangular blur halo that was bleeding into the scene around the face. Other-character faces stay rectangle-blurred so Grok can't trait-bleed from their unblurred surroundings | `<this commit>` |

### Grok output handling

This is the most-relitigated part of the pipeline. The ground truth is
that **two failure modes are in tension**:
- (a) Grok bytes verbatim → Aurora re-quantises every pixel; neighbours
  and background lose saturation, edges get crunchy.
- (b) Always feather over the original silhouette → if the repainted
  figure landed in a slightly different pose/position, the silhouette
  mask is wrong for the new figure: feather clips real character pixels
  and stitches old-pose pixels at the boundary (two-headed bodies,
  ghost limbs).

We've toggled between (a) and (b) at least twice. The current rule is
**conditional**: feather only when the repainted figure is mostly inside
the original silhouette.

| # | Decision | Status | Why | Last commit |
|---|---|---|---|---|
| 8 | Pass Grok bytes verbatim (no resize, no re-encode) | ❌ deprecated as a default | Was right when ghost-limb artefacts dominated. Now we have a fitness check that detects the dangerous case, so we can feather in the safe ones | `ecaa54b2`, `6f9d9202` |
| 9 | Always feather-composite Grok output over original at silhouette | ❌ | Caused ghost limbs whenever the repainted figure shifted out of the original silhouette. Replaced by row #10 | `0d1c3ddd` |
| 10 | **Conditional feather**: rembg the Grok output, compare new silhouette vs old; feather only if `newOnly < 15% × oldPx`; otherwise use Grok verbatim | ✅ default | Auto-detect handles both failure modes — preserves scene when feather is safe, accepts scene drift when figure moved | `<this commit>` |
| 11 | Resize Grok output to source dims (when feathering) | ✅ (only when feather is applied) | Required for like-for-like compositing. ~2% linear downsample of figure region only. When feather is skipped, Grok bytes pass verbatim and dims are preserved | `<this commit>` |
| 12 | Sharp `create({channels:1})` for the feathered mask | ❌ | Sharp requires 3+ channels for `create`. Build 3-channel black canvas, composite silhouette PNG, blur, then `extractChannel(0)` | `255fb796` |

### Prompt

| # | Decision | Status | Why | Last commit |
|---|---|---|---|---|
| 12 | Long prompt with face-magenta / blue-fill / cyan-outline language (~2,600 chars rendered) | ❌ | Each visual-signal change bolted on more prompt language without removing old; hit 2,622 chars | `0e50d6a4` (slimmed) |
| 13 | Slim prompt: ~450 char template, ~750-1,000 chars rendered | ✅ | Visual signal is now unambiguous (shape-aware hatch), so the prompt only needs to label the magenta and forbid touching outside | `0e50d6a4` |
| 14 | Compress `actionContext` from 5-line bulleted block to single ` · `-separated line | ✅ | ~120 chars saved per repair; same info | `0e50d6a4` |
| 15 | "Every pixel outside the crosshatch is final — do not re-render other characters" line | ✅ (belt + suspenders) | The mask-composite is the actual enforcement; the prompt just saves Aurora a wasted denoising step on the surrounding scene | `0d1c3ddd` |

## Dev toggle: feather composite

The default behaviour is **automatic**: the conditional check in row #10
decides per repair whether to feather or pass Grok bytes verbatim. The
log line `[CHAR REPAIR GROK] Feather composite: ...` shows the decision
and the leak ratio.

There is also a manual override:

- Knob name: `featherComposite` (default `true`).
- **UI** — `StoryDisplay.tsx`'s admin char-repair popover has a checkbox.
- **API** — `POST /api/stories/:id/repair-workflow/character-repair` accepts `featherComposite: false`.
- **Backend** — `repairCharacterMismatchWithGrok({ featherComposite: false })` skips even the fitness check and returns Grok bytes verbatim.

When the checkbox is **ON** (default): the auto-detect runs. Feather is
applied only when the figure stayed inside the original silhouette;
otherwise Grok bytes pass through unchanged.

When the checkbox is **OFF**: Grok's bytes pass through verbatim,
unconditionally. Use this only for A/B debugging. The auto-detect
already handles "skip if bad" — you almost never want to disable it.

## When to revisit

- **Full ControlNet support in Aurora.** Today Aurora exposes no control
  channel, so we have to bake spatial constraints into the input image.
  If/when xAI ships a real conditioning input, the whole Step 4 + Step 8
  scaffolding becomes obsolete — pass the silhouette as a control map and
  trust the model.
- **Multi-reference enhancement.** Aurora now accepts 2–3 reference
  images. We currently send `[avatar, masked_scene]`. A third reference
  (e.g. the unmodified original scene) might let us drop Step 8 if Aurora
  learns to diff the masked vs unmasked input. Untested.
- **Switch backend to Flux Inpaint.** Flux exposes ControlNet. Costs
  $0.005-$0.01/inpaint vs Grok's $0.02. Verdict on Flux for *page
  generation* was ❌ in `project_image_model_tests.md`, but inpaint is a
  different problem — Flux's "stiffness" becomes an asset when you want
  rigid composition control. Not implemented; A/B test if the mask
  composite still leaves visible artefacts at the seam.

## How to add a new decision

1. Append a row to the relevant table above with status, reason, and
   commit hash.
2. If you're rejecting a previous ✅: change its status to ❌, add a
   one-line "deprecated by #XX" note, and link the new row.
3. If the change is dev-toggleable: surface the toggle in
   `StoryDisplay.tsx`'s admin popover and document the knob in the
   "Dev toggle" section.
