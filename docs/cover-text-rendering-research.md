# Getting the cover title INTO the artwork — model landscape + our architecture

**Date:** 2026-08-05 · **Status:** Test Lab stage `cover_title_paintin` built, not yet run
**Trigger:** the flat title overlay reads as "pasted on"; asking Grok to draw the title garbles letters,
and retry-plus-eval can't be trusted to catch a single wrong character.

---

## 1. The landscape (web research, Aug 2026)

| Model | Text accuracy | Price / image | Notes |
|---|---|---|---|
| **Ideogram 4.0** | ~90–95 % on short copy — best in class | $0.03 turbo / $0.06 default / $0.10 quality | Typographic accuracy is an explicit design goal. Has a mask-based **Edit** endpoint (fal, Replicate, Runware). |
| **GPT Image 2** (OpenAI) | near-perfect Latin + CJK | — | #1 on the image arena (score 446, Aug 2026). Reported as "first model that draws cover typography with no gibberish". |
| **Recraft V4 / V4.1** | ~90 %; **native SVG path output** | ~$0.04 | Only major model emitting editable vector letterforms. Wordmarks good; complex logotypes still want manual cleanup. |
| **Qwen-Image / Qwen-Image-Edit** | SOTA open-source — #1 Text + Alignment on OneIG-Bench; beats SOTA on LongText-Bench / CVTG-2K | **$0.008** on our existing Runware account (`alibaba:qwen-image-edit@2511`) | Edit variant is purpose-built to **add / remove / modify text in an existing image while preserving font, size and style**. |
| **Seedream 4.5** | +28 % over Flux Schnell on text (4.93 vs 3.85) | ~$0.03 | ByteDance hosting → data-residency question for a Swiss product. |
| Grok Imagine (our default) / Gemini | garbles letters — the problem being solved | $0.02 / $0.04 | |

### The two findings that decide the architecture

**(a) ~90 % is not a shippable number.** One title per book means roughly **1 cover in 10 ships wrong**.
Benchmarks are English-heavy, and the failure mode concentrates exactly on **umlauts and accents**
(ä ö ü é è) — which is 100 % of our German and French titles. A VLM quality judge does not reliably
catch one transposed letter, so "generate → eval → retry" cannot close the gap.

**(b) The research that solved this never asks the model to spell.** GlyphControl, AnyText / AnyText2,
TextDiffuser and Glyph-ByT5 all pre-render the correct glyphs from a font and feed them as a spatial
condition, leaving diffusion to do styling only. Glyph-ByT5 reports design-image text rendering going
from **<20 % → ~90 %** on that change alone. Spelling accuracy is still described in the 2026 literature
as the unsolved axis for free generation.

**Conclusion:** the letters must come from a font file. The model's job is medium, texture, light and
edge — never spelling.

---

## 2. What we already had

`server/lib/coverTypography.js` is **not** a naive overlay. It already does: 9 bundled display fonts,
arch / archdown / tilt / straight layouts, occupancy-aware placement from `bboxDetection.figures`,
palette sampling with WCAG contrast, garment-colour candidates, a 3D extruded side + outline, and a
measure-then-fit render pass via resvg. Titles render textless and get baked app-side
(`applyCoverTypography`), with `${key}Art` keeping the textless plate.

So the gap is not "better typography" — it is that the lettering is a **flat graphic layer** with no
medium, no paper bleed, no contact shadow, no participation in the illustration's light.

---

## 3. The architecture: glyph-conditioned paint-in

Test Lab stage **`cover_title_paintin`** (`server/lib/testlab.js`), story-level, target `{storyId}`:

1. **Compose** — `composeCover({kind:'front'})` renders the title from a real TTF. Spelling correct by
   construction. Unchanged production code.
2. **Glyph mask** — pixel-diff composed vs textless art (`|Δ| > 12`) gives the exact letter mask plus its
   bbox. No new detection, no SAM, no API call.
3. **Dilate** — grow the mask by ~1.2 % of the short side (`params.dilatePct`), then soften its border.
   The dilation is the room in which the model is *allowed* to add outline, bleed and shadow.
4. **Crop-bounded edit** — crop the title region + 5 % margin and send only that to
   **Qwen-Image-Edit** at 2× (dims snapped to /64, min 512), with the story's `ART_STYLES` description
   appended. This is the model's documented strength: editing text already present. The crop bound is
   the rule established by the Qwen composite experiments — full-frame edits re-imagine the scene.
5. **Mask-gated paste-back** — the painted crop is composited back at exact coordinates using the
   dilated glyph mask as alpha. **Artwork outside the letters is pixel-identical by construction.**
6. **OCR gate** — the painted title crop is transcribed by the utility vision model (temperature 0,
   "copy exactly, do not correct") and compared to the story title: whitespace-collapsed,
   case-insensitive (several fonts are uppercase-only), **diacritic-sensitive**. Deterministic pass/fail,
   not a judge. `Marchen ≠ Märchen`.

On FAIL the production port keeps the flat composite. A garbled title is then **structurally unable to
ship** — the failure mode the user rejected is removed rather than made less likely.

### Cost
$0.008 per cover, one call. No retry loop by design: a failed gate falls back, it does not re-roll.

---

## 4. What is NOT decided yet

The stage exists; **no run has happened**. Open questions for the first experiment:

- Does Qwen actually add medium/texture inside a mask this thin, or does it return the crop essentially
  unchanged? (The "Gemini is lazy on tiny tweaks" rule is why the backend is Qwen, not Gemini — but the
  edit magnitude here is small.)
- Is `dilatePct` 1.2 % the right room? Too tight → no shadow/bleed; too loose → the model repaints art.
- OCR gate false-negative rate on a *good* paint-in (stylized letters the transcriber misreads). If this
  is non-trivial, the gate needs a second transcription vote before it can gate production.
- Whether the flat 3D-extrude look should be dropped from the composite when a paint-in is planned
  (the extrude may fight the painted treatment).

**Not chosen** (and why): letting Ideogram 4 or GPT Image 2 draw the title from scratch — best possible
integration, but ~90 % first-try, weakest exactly on our umlauts, and it still needs the same OCR gate
plus a fallback path. If the paint-in disappoints, that is the next thing to A/B in the same stage.

---

## 5. Sources

- <https://masonry.so/blog/best-ai-image-model-for-text-rendering>
- <https://vibedex.ai/blog/best-ai-text-rendering-2026>
- <https://www.mindstudio.ai/blog/ideogram-4-recraft-2-gpt-image-2-comparison>
- <https://qwenlm.github.io/blog/qwen-image-edit/> · <https://arxiv.org/pdf/2508.02324> · <https://oneig-bench.github.io/>
- Glyph-ByT5 <https://arxiv.org/pdf/2403.09622> · AnyText2 <https://openreview.net/pdf/62e6058c6bce2b28ab8af509d23522643ae6a392.pdf>
- <https://fal.ai/models/fal-ai/ideogram/v3/edit/api> · <https://runware.ai/collections/sota-models>
