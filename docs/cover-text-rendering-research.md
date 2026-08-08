# Getting the cover title INTO the artwork — model landscape + our architecture

**Date:** 2026-08-05, superseded 2026-08-07 · **Status:** SHIPPED TO STAGING as the PLATE pass
(`server/lib/coverTitlePaint.js`), 4/4 on the benchmark set.

> ⚠️ **Sections 3–5 below describe the ORIGINAL crop-and-extract design, which FAILED and was
> abandoned.** They are kept because the failures are the argument for the final design. The
> architecture that shipped is at the bottom: **"Final architecture — the plate pass"**.
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
4. **Crop-bounded edit** — crop the title region + 12 % margin (`params.marginPct`) and send it to
   **Qwen-Image-Edit** at 2× (dims snapped to /64, min 512), with the story's `ART_STYLES` description
   appended. This is the model's documented strength: editing text already present.

   **Crop width is a resolution-vs-context lever, not a safety one** (owner question, 2026-08-05).
   The tight 5 % crop was inherited from the Qwen *composite* recipe, where a full-frame edit
   re-imagined the scene — but step 5 already discards everything outside the glyph mask, so a wider
   crop cannot damage the artwork. What it changes is how many pixels each letter gets, and **how much
   palette the model can see**: a crop showing only the sky behind the title cannot know the cover's
   accent colour lives in a character's coat 60 % further down, so it has no basis for a colour that
   echoes the artwork. Hence two further levers:
   - `params.contextRef` (default **on**) — the full cover rides along as a **second reference**, so the
     model sees the whole palette and lighting while still editing only the crop. No repaint risk.
   - `params.recolor` (default **off**) — swaps the "keep the colour exactly" clause for "pick a colour
     that already appears in the artwork as an accent, and keep it legible against what is behind it".
     This is the lever aimed at the standing complaint that the *deterministic* colour pick is
     sometimes wrong; it moves the colour decision to something that can actually see the picture.
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
- Does `contextRef` + `recolor` actually produce a better-matched title colour than the deterministic
  pick, or does the model just drift toward mud? This is the first A/B to run: same covers, colour
  locked vs model-chosen.
- **Pinning is deliberately NOT built here.** A generic stage-typed `testlab_sets` mechanism is being
  built separately (migration 010 rewrite); title pinning will be a consumer of it, not a second sets
  system. Owner decision 2026-08-05.
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

---

## Run log — what four experiments actually proved (2026-08-05)

Set `last-4-titles` (Test Lab set 3): Tock tock tock (pixar), Das Seil fliegt… ,
Der Turm der Lügen bestraft, Lukas unter dem Lindenbaum (all watercolor).

**#311** — crop 0.12 + full-cover context ref. Output unusable: duplicate titles, scene
fragments inside letters, comb striping. **Three bugs, none of them the model:**

1. **Wrong textless plate.** The plate is a `story_images` row of type `${coverKey}Art`, not
   `cover.artImageData` (which does not exist on real stories). The code fell back to
   `cover.imageData` — the SERVED, already-titled cover — so every crop went to Qwen with the
   title baked in twice and the glyph mask was diffed against an image that already had lettering.
2. **The context reference caused composition, not context.** Qwen has no "edit image 1, consult
   image 2" semantics; with two refs it composes. Proof: an output whose input crop was the top 36 %
   of the cover contained the crossbow man, the houses and the apple. `contextRef` now defaults OFF —
   palette context must be TEXT, never a second image.
3. **The glyph mask was 3-channel.** sharp emits sRGB even from a 1-channel raw input; the mask was
   indexed as 1 channel and passed to `joinChannel` as alpha, so the alpha was the mask **squeezed 3×
   horizontally and wrapped across rows**. That is the comb/scanline striping — model pixels leaking
   hundreds of px from any letter (streaks across a character's eyes with a mask provably empty
   there). Fixed with `toColourspace('b-w')` + hard `length === W*H` assertions.

**#313** — 4/4 loud errors from the new plate guard. Correct: it refused to double-stamp.

**#316** — real plate, single ref, mask bug still live. OCR 4/4, alignment 1/4. Still striped.

**#318** — all three bugs fixed. **OCR 4/4, alignment 3/4** (the 1 failure is discarded and the flat
composite served, as production would). Zero changed pixels below the letters — measured, not eyeballed.

### Verdicts
- ✅ The architecture is sound: glyphs from a font are never misspelled (4/4 across every run), and
  mask-gating + the alignment gate keep the artwork pixel-exact or discard the attempt.
- 🟡 **What paint-in adds is marginal** — a soft halo and slightly richer letter edges. It is not the
  "painted into the artwork" transformation that motivated this. Not worth $0.011/cover as it stands.
- ❌ **The OCR gate alone is not enough** — #311 passed two visually destroyed covers. The
  **alignment gate** (off-mask pixels must equal the crop sent) is the gate that actually catches it.
- 🔴 **The real remaining problem is the deterministic colour**, now cleanly isolated: on the pixar
  cover the picker chose `#678c0d` — a green title on green foliage. It maximises WCAG contrast
  against a sampled background box but is blind to composition. That is the next thing to fix, and it
  needs no model at all.


---

# Final architecture — the plate pass (2026-08-07)

## The turn

Sixteen runs tried to restyle the title ON the cover and then cut the letters back out: diff mask →
solved alpha (known-background matting) → SAM → SAM ∪ glyphs → SAM-seeded colour selection →
colour + connected components + morphological opening. **Every one traded a missed letter pixel for
an admitted background pixel.** On a re-rendered frame "letter or artwork" has no clean answer when
the pigment and the scene share a palette — a green title on green foliage is unsolvable by any
threshold. Owner ended it: *"pass the image and the text as 2 inputs and say redraw the text so it
fits on the scene"*. That does not solve the separation problem — it removes it.

## What ships

1. `composeCover` renders the title from a real TTF (spelling correct by construction).
2. Glyph mask = composed − textless plate. `toColourspace('b-w')` + a length assert.
3. The title alone on a **WHITE 16:9 canvas**; the canvas is grown to contain the strip, never cropped.
4. `editWithGrok` directly: plate = input 1, artwork (1024px) = input 2 as a **style reference only**.
5. Key on **inkiness** (dark OR saturated) → any paper the model invents drops out.
6. Fill enclosed specks < 0.04% of plate area (counters are far larger and stay open).
7. Composite onto the untouched textless plate.
8. **One final eval**: expected TEXT + image → "do these match?" (verification, not transcription).
   Any failure keeps the flat lockup. coverage/spill are diagnostics.

## Run log

| Exp | Change | Result |
|---|---|---|
| #311 | crop 0.12 + full-cover context ref | unusable — **3 own-goal bugs**: wrong textless plate (double title), context ref → composition, 3-channel mask → comb striping |
| #313 | plate guard added | 4/4 loud errors — correctly refused to double-stamp |
| #316 | real plate, single ref | OCR 4/4, alignment 1/4 — still striped |
| #318 | mask channel fixed | OCR 4/4, alignment 3/4, zero changed px below the letters |
| #322 | aggressive restyle prompt | real impasto — **the prompt was the limiter**, not the model |
| #323 / #324 | Grok / Gemini backends | **Grok ✅ true watercolour**; Gemini ❌ washed out, degraded letters; Qwen 🟡 plastic |
| #328 | full frame + find-the-letters | clean on 3, but the found mask contained tree trunks |
| #340 | SAM detection | tree-free mask, but **dropped whole letters** (LINDENB…) |
| #342 | SAM ∪ drawn glyphs | 4/4 — but reinstates the OLD letterform as a floor (owner rejected) |
| #343–#353 | colour selection, components, opening, SAM-free pigment seed | letterforms good, still both false-neg and false-pos |
| #356 | **plate mode**, cyan key | gorgeous lettering, but the model repainted the background and re-framed |
| #359 | white **square** plate | clean extraction; long title **re-flowed 2 lines → 5** |
| #383 | white **16:9** plate + line count pinned | **4/4**, coverage 0.75–0.92, spill ≤0.01 |

## Verdicts

- ✅ **Grok** for the lettering; the medium is right and the letterforms hold.
- ❌ Never `editImageWithPrompt` for this — empty template → 400 → silent Gemini fallback.
- ❌ Never a square plate — the empty space invites re-flow.
- ❌ Never let a model spell the title: 2026 SOTA is ~90–95% on short copy and worst on ä/ö/ü/é.
- 🟡 Grok still varies run to run on long titles; the eval catches it and nothing is charged. No
  automatic retry (owner's call).

## Still open

- Not verified inside a full generation (only via the Lab and the repaint endpoint).
- No restamp route for the back cover, so branding cannot be repaired without regenerating.
- The cover prompt asks for a naturalistic lighting phrase AND the cyber style at once, so the
  evaluator penalises style elements as a setting mismatch — a prompt conflict, not an eval gap.
