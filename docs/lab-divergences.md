# Test Lab divergences from production

The Test Lab runs **production code**. Its purpose is to reproduce and verify
what production does, which it can only do if it calls the same functions with
the same inputs. A Lab-only behaviour is therefore not a free choice — it is a
debt with a lifecycle:

| status | meaning |
|---|---|
| `testing` | a deliberate deviation being evaluated by a named experiment |
| `promoted` | proved better, now the production path too — row can be deleted |
| `rejected` | evaluated and dropped, the Lab no longer diverges — row deleted |

A divergence with no row here, or one parked in `testing` after its experiment
concluded, is a defect. `tests/manual/test-char-repair-parity.js` enforces the
contract side of this.

## Why this file exists

`repairCharacterFace` had its options object assembled **by hand in two
places** — `repairPipeline.js` and `testlab.js`. Nothing tied them together, so
they drifted in both directions: the Lab was missing `clothingDescription`,
`detectionBodyMask`, `imageBackend`, `issueDescription` and `whiteoutTarget`,
and **neither** passed `artStyle`. Every production character repair therefore
ran with an empty "Art style — match this medium and rendering exactly" block,
and no Lab run could have exposed it, because the Lab had the same hole.
Measured on staging story `job_1787252581387_6sn8z0nh2` page 3 (Lab #785): five
identical full-figure repairs, four came back in a different rendering with
broken head/body proportion.

The field list now lives once in `server/lib/charRepairRequest.js`. Both callers
build through it, and any deliberate deviation is passed explicitly so it shows
up as a value rather than as a difference buried in a 7,000-line file.

## Active divergences

| call | divergence | why | experiment | status |
|---|---|---|---|---|
| `char_repair` | `params.repairMode` forces a method via the legacy mode flags (`useBlended` / `useCutout` / `useFullScene`) | production picks the method from the finding; a Lab A/B has to pin one. The flags are read by production's own adapter, so the choice still flows through `legacyFlagsToAxes` rather than around it. **Unset = production** since 2026-09-27 (the stage used to default to `blended`) | method A/B runs (#784 face vs #785 full-figure) | `testing` |
| `char_repair` | `params.whiteoutTarget` / `issueTypes` / `targetFigure` / `bbox` / `faceBbox` / `detection` / `freshDetection` / `referenceCharacter` / `treatment` / `regionSource` / `faceOnly` / `backend` | explicit A/B overrides applied ON TOP of the production call (`charFixCall.buildCharFixCall`); `whiteoutTarget` reaches the same axis resolver as `decision.forceTarget` | ongoing | `testing` |
| `char_repair` | `protectTargetFace` — adds the target's OWN face box to the protected set, so a body repaint preserves the original head pixels | tests the two-pass idea (body first, then face) against the measured failure: a full-figure repaint returns a head in the wrong medium and proportion in 7 of 8 runs, while face-only repair is 5 of 5 clean | #789 (this test) vs #785/#787 baseline | `testing` |
| `char_repair` | Lab-only mechanics: `addStep`, `reuseCandidate`, `promptName`, `blurStrength`, `r2Prompt`, `blurFace` | step capture, deterministic replay, and A/B knobs — instrumentation, not behaviour | ongoing | `testing` |

## Resolved

| call | was | fixed by |
|---|---|---|
| `char_repair` | sent the RAW 2x4 avatar sheet while every generation path picks the pose-matched cell (`resolveCellPose`/`cropAvatarCell`) | PROMOTED: both the production char-fix and the Lab stage now pick the cell by declared facing — body cell for body repair, stacked face+body for face repair. Measured: full sheet 1/5 clean, body cells 6/6 (Lab #785 vs #792/#793). 2026-09-27: the cell is now chosen INSIDE the repair spine by `charRepairReference.js` (face repair = face cell alone, body repair = body cell alone, both upscaled and padded to the call aspect), shared by all four callers; the stacked reference and the `referenceCells` override ('full'/'body4'/'body1') are deleted |
| `char_repair` | called `repairCharacterFace` directly with locally resolved axes, bypassing production's adapter — and with it the bbox validation, the **face-box union expansion** (a face box poking outside the body box expands the body box so the mask does not miss half the face) and the `char_repair_run` metric. The Lab could therefore repair a different REGION than production would. | the stage now calls `images.repairCharacterMismatch`, the same entry point the story pipeline calls |
| `char_repair` | neither caller passed `artStyle` | one shared contract (`charRepairRequest.js`) + parity test |
| `char_repair` | built its own inputs around the shared contract: its own box ladder (padded chained boxes, face-box recovery), `buildClothingDescription` where the run reads the requirement signature + the page's worn state, no wardrobe-state (`--off:`) sheet, the page reference photo where the run falls back to the face photo, a forced `blended` mode and `face` target where the run resolves both from the finding type, no borrowed-label / reference-gap guard, no face-integrity gate, covers saved without restamp | 2026-09-27: the repair round's input building moved verbatim into `server/lib/charFixCall.js` (`buildCharFixCall`); `executeCharFixAction` and the Lab stage both call it, the Lab runs the same face gate and restamps covers via `restampRepairedCover`. Pinned by `tests/unit/lab-prod-call-parity.test.ts` |
| `image` | built its own page call: `inputData` without `layout`, grid via `buildPageCompositeRefs` without objects[] / id fallback, no route reference mode, a text mask on plateless / vantage pages, `artStyle` as a render option | 2026-09-27: the run's page-render inputs moved into `server/lib/pageRenderCall.js`; Phase 5a and the Lab stage both call it. Pinned by `tests/unit/lab-prod-call-parity.test.ts` |
| `edit_image` (plate) | derived with aspect `null` where the run passes the layout aspect | 2026-09-27 |
| `quality_eval` / `semantic_eval` / `eval_variance` / `image` auto-eval | called `evaluateImageQuality` with `buildEvalReplayOptions`: no `pagePrompt` (REQUIRED OBJECTS fell back to `objects[]`), the page's references only (no whole cast), `ctx.outlineHint` as the scene hint (not `resolveEvalSceneHint`: a cover got its description, not its brief), no `storyMeta`, so the judges read the story language as `en` (REQUIRED OBJECTS / REQUIRED TEXT labels), and `pageNumber` passed where the batch passes none; quality_eval skipped the batch's post-eval steps; semantic_eval rebuilt three judge inputs and missed the REQUIRED TEXT rules, the cover fidelity reference and the Visual Bible reference cells | 2026-09-27: `repairPipeline.buildEvalInput`, `images.batchEvalQualityCall` and `evalPipeline.prepareEvalJudgeInputs` / `semanticFidelityOptions` are the run's own code, moved verbatim and exported; the stages build through `testlab.labEvalCall`. Pinned by `tests/unit/lab-prod-call-parity.test.ts` |
| `empty_scene` | built its own plate call: the mask from `getTextAreaMask(ctx.textPosition)` (the stored post-detection position, no spread rule), no QC retry, and a vantage page painted from its OWN plate text, shot, light and objects instead of the vantage's representative page — no derive for an angled or re-lit page | 2026-09-27: the run's plate code moved verbatim into `server/lib/platePipeline.js` (`renderVantagePlates`, `renderPagePlate`); Phase 5a-pre-vantage, Phase 5a-pre and the Lab stage all call it, the Lab on the run's `pageDataArray` rebuilt from the stored pages. Pinned by `tests/unit/lab-prod-call-parity.test.ts` and sibling set `lab-vs-prod-plate` |
| `char_repair` | `detectionBodyMask: null` — the Lab never reused the stored silhouette, on the grounds that "a Lab stage run has no detection pass" | STALE since masks were persisted: the stage now calls `charRepairTarget.resolveFigureMask` with the story's `sourceImageFp`, exactly as production does, and reports a miss rather than absorbing it (`testlab.js`). Confirmed live in exps #996/#998, which surfaced the real resolver's reuse-MISS warning for a cover page |

## Adding a divergence

1. Pass it explicitly (an `overrides` object or a marked Lab-only mechanic), never
   by quietly omitting a field the production caller sends.
2. Mark it in code with `// LAB DIVERGENCE (indexed)`.
3. Add a row here with the experiment that justifies it.
4. When the experiment concludes, promote it into the production path or remove
   it — and delete the row.
