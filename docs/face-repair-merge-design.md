# Face-Repair Merge — 5 Methods → 3 Parameters (Design)

> Owner spec (2026-07-25): "Face repair can use BOX or CUTOUT. Can BLUR,
> CROSSHATCH, or WHITEOUT. Can call DIFFERENT MODELS. This should be 3
> PARAMETERS not 5 METHODS. All such paths must be merged."
>
> Status: **IMPLEMENTED (2026-07-26)** — owner green-lit the shape and accepted
> the IoU-gate tradeoff. All 5 stages landed on `server/lib/faceRepair.js`. The
> deterministic pieces are unit-tested (`tests/manual/faceRepair-geometry.test.js`,
> 29 assertions). **Still pending: a staging Test Lab A/B on 8-10 stored repair
> cases to confirm pixel-level equivalence and calibrate the IoU/white-card gate
> thresholds before these gates reach prod defaults** (see Risk + `docs/decisions.md`).

## The 3 axes (+ 2 orthogonal extras)

- **regionSource**: `box` (mark region in full page) | `cutout` (extract crop, treat, paste back)
- **treatment**: `blur` | `crosshatch` | `whiteout`
- **model**: `grok` | `qwen` | `gemini`
- orthogonal: **faceOnly** (face/head vs whole figure), **requireMobilesam** (bool)

## Current 5 methods → axes

| Method (today) | regionSource | treatment | model | faceOnly | reqSAM | blend engine | gates today |
|---|---|---|---|---|---|---|---|
| `grok_face_insert` | cutout | whiteout | grok | face | ✅ | **samUnionBlend** | coverage, IoU, white-card, reqSAM |
| `grok_blended` (face) | box | blur | grok | face | ✗ | inline legacy union | sharpness only |
| `grok_blended` (body) | box | blur | grok | body | ✗ | inline legacy union | sharpness only |
| `grok_cutout` | cutout | crosshatch | grok | body | ✗ | inline feather | sharpness only |
| `grok_inpaint` (fullScene) | box | crosshatch | grok | body | ✗ | inline feather union | leak-ratio only |
| `grok_blackout` | box | none | grok | — | ✗ | none | **none** |
| Gemini repaint | whole | none | gemini | — | ✗ | none | none |
| Test Lab `runQwenInsert` | cutout | whiteout | qwen | both | ✅ | **samUnionBlend** | **+style-match**, IoU, white-card |

**The core problem, made concrete:** only 2 of these (`grok_face_insert` + Test
Lab's qwen insert) route through the ONE shared blend engine `samUnionBlend` and
apply the strong gates. The other three each carry their *own* private blend
engine and their *own* partial gate set — sharpness on 2 & 3, leak-ratio on 4,
IoU/white-card/style-match on **none**. That's the "gate on one path, not the
sibling" complaint exactly.

Redundancies: `grok_cutout` and `grok_inpaint` are the *same* `crosshatch+grok+
body` differing only in regionSource + two hand-rolled blenders. `grok_blackout`
and Gemini are both the degenerate `treatment:none` (no mask, verbatim model
output) duplicated twice.

## Unified function

New module `server/lib/faceRepair.js`, `repairCharacterFace(scene, avatar, opts)`.
Core lifted from today's `grokFaceInsertRepair`. Flow:

`normalize inputs → resolve region (box|cutout) → build treatment mask
(blur|crosshatch|whiteout) via ONE requireMobilesam-honoring fetcher → call model
(grok|qwen|gemini) → **style-match gate** → **samUnionBlend** (IoU + white-card
inside) → composite → **sharpness gate** → return`.

**The whole point:** style-match, IoU, white-card, coverage, requireMobilesam and
sharpness all live in the shared spine — there is no path to the output that
skips them. Test Lab A/B can toggle `opts.gates.*`; production defaults all on.
Defaults reproduce today's dominant path (`cutout+whiteout+grok+faceOnly`).

`method` name strings are replaced by a stable descriptor `grok:cutout:whiteout:face`
for logs/telemetry/dev-panel.

## Migration (staged, reversible — no path deleted before its replacement is proven)

1. **Land `faceRepair.js`** behind an unused export; unit-test region resolver +
   treatment-mask builders. No caller change.
2. **Route Test Lab only** (`runQwenInsertStage`, `runCharRepairStage`) to it —
   non-production, already expects samUnionBlend output, lowest blast radius, and
   it's where the A/B tooling lives. **This alone kills the testlab↔prod divergence.**
3. Convert `repairCharacterMismatchWithGrok` (`images.js:11305`) into a ~20-line
   **adapter** (legacy flags → axes) calling `repairCharacterFace`; delete the
   four inline branches + two private blend engines. Run the A/B batch.
4. Flip `decideRepairMethod` (`repairLogic.js:179`) to emit a `repairParams`
   {regionSource,treatment,model,faceOnly} object instead of a method name;
   `resolveRepairAxes` centralizes "face issue → whiteout+cutout+face; body issue
   → crosshatch+body" (today scattered at `images.js:8174` + `regeneration.js:5457`).
5. Deprecate `grok_blackout` (no more no-gate verbatim) + fold in Gemini last.

Callers rewired: `executeCharFixAction` (`images.js:8119`), manual route
(`regeneration.js:5522`), both Test Lab twins.

## Risk — READ BEFORE APPROVING

**Biggest behavior change:** routing the legacy body `blur`/`crosshatch` paths
through `samUnionBlend` means they now face the **IoU gate (0.55)** and white-card
gate they never had. Body repaints that legitimately shift the figure a little —
which the old inline feather silently shipped — may now be **rejected** (return
null → "kept original"). That's *more correct* (fewer bad repaints ship) but it's
a visible change: some pages that used to get a (possibly-flawed) repair will now
keep the original instead. Mitigation: `opts.gates.iou` is tunable; calibrate the
threshold on the A/B batch before prod.

Other risks: the ~570-line blended branch has registration-shift / silhouette-
union / midpoint-clamp subtleties that must extract byte-faithfully (only a live
A/B confirms); `colorCorrect`/`bodyColorMode` defaults must exactly match today's
per-path values (face insert `colorCorrect:false`; TL body `bodyColorMode:true`)
or garment/skin colour shifts; the bespoke guards (large-face-box downgrade
`11390`, degenerate-cutout `11372`, occluder-subtract `12560`) must survive
extraction.

**Cannot be verified without running it** → needs staging + a Test Lab A/B on
8-10 stored repair cases (face+body, single+occluded-group) before production.
