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
| 7 | **Shape-aware crosshatch** — magenta hatch SVG drawn on transparent canvas, then `dest-in` masked by the silhouette | ✅ | One unambiguous signal ("repaint the magenta region"), the magenta region IS the figure's exact shape, no rectangle to fill, no second colour to interpret | `0e50d6a4` |

### Grok output handling

| # | Decision | Status | Why | Last commit |
|---|---|---|---|---|
| 8 | Resize Grok output back to source dims | 🟡 (gated by feather toggle) | Trade-off: resizing 896×1280 → 880×1168 loses ~2% linear in the silhouette region. Worth it because the alternative is Aurora touching every pixel of the frame | `0d1c3ddd` |
| 9 | Pass Grok bytes verbatim (no resize, no re-encode) | 🟡 (legacy default in older builds) | Was correct when we trusted Aurora to only repaint inside the mask. Aurora doesn't honour that — it re-renders the whole scene | `ecaa54b2`, `6f9d9202` (set), `0d1c3ddd` (default off) |
| 10 | **Feather-composite Grok output over the original scene at the silhouette only** (6px feather) | ✅ default ON, dev-toggleable | The actual fix for "other characters degraded after repair". Outside silhouette = original JPEG bytes pixel-for-pixel. Inside = Grok's repaint. | `0d1c3ddd` |
| 11 | Sharp `create({channels:1})` for the feathered mask | ❌ | Sharp requires 3+ channels for `create`. Build 3-channel black canvas, composite silhouette PNG, blur, then `extractChannel(0)` | `255fb796` |

### Prompt

| # | Decision | Status | Why | Last commit |
|---|---|---|---|---|
| 12 | Long prompt with face-magenta / blue-fill / cyan-outline language (~2,600 chars rendered) | ❌ | Each visual-signal change bolted on more prompt language without removing old; hit 2,622 chars | `0e50d6a4` (slimmed) |
| 13 | Slim prompt: ~450 char template, ~750-1,000 chars rendered | ✅ | Visual signal is now unambiguous (shape-aware hatch), so the prompt only needs to label the magenta and forbid touching outside | `0e50d6a4` |
| 14 | Compress `actionContext` from 5-line bulleted block to single ` · `-separated line | ✅ | ~120 chars saved per repair; same info | `0e50d6a4` |
| 15 | "Every pixel outside the crosshatch is final — do not re-render other characters" line | ✅ (belt + suspenders) | The mask-composite is the actual enforcement; the prompt just saves Aurora a wasted denoising step on the surrounding scene | `0d1c3ddd` |

## Dev toggle: feather composite

Knob name: `featherComposite` (default `true`).

- **UI** — `StoryDisplay.tsx`'s admin char-repair popover has a checkbox: **"Feather composite (inpaint only) — preserve untouched pixels outside the silhouette."**
- **API** — `POST /api/stories/:id/repair-workflow/character-repair` accepts `featherComposite: false` in the body.
- **Backend** — `repairCharacterMismatchWithGrok({ featherComposite: false })` skips Step 8 and returns Grok bytes verbatim.

When **ON** (default): Grok's output is resized to source dims, masked by
the silhouette (with 6 px feather), and composited over the original
scene. Other characters and background are byte-for-byte identical to
before. Slight detail loss inside the silhouette only.

When **OFF**: Grok's bytes pass through verbatim (legacy behaviour). The
entire scene re-renders — saturation drifts, edges crunch up, colours
re-quantise across every pixel, but you keep Grok's full native
resolution inside the figure.

You almost always want it ON. The toggle exists for A/B comparisons and
for the rare scene where the silhouette mask comes back wrong (e.g.
rembg failed and you want Grok's full output anyway).

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
