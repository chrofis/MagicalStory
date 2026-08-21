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
| `char_repair` | `detectionBodyMask: null` | production reuses the SAM silhouette produced by its detection pass; a Lab stage run has no detection pass, so the blend gate re-runs `/figure-mask` on the same pixels | n/a — structural, not a behaviour test | `testing` |
| `char_repair` | forces a method via the legacy mode flags (`useBlended` / `useCutout` / `useFullScene`) | production picks the method from the finding; a Lab A/B has to pin one. The flags are read by production's own adapter, so the choice still flows through `legacyFlagsToAxes` rather than around it | method A/B runs (#784 face vs #785 full-figure) | `testing` |
| `char_repair` | `protectTargetFace` — adds the target's OWN face box to the protected set, so a body repaint preserves the original head pixels | tests the two-pass idea (body first, then face) against the measured failure: a full-figure repaint returns a head in the wrong medium and proportion in 7 of 8 runs, while face-only repair is 5 of 5 clean | #789 (this test) vs #785/#787 baseline | `testing` |
| `char_repair` | Lab-only mechanics: `addStep`, `reuseCandidate`, `promptName`, `blurStrength`, `r2Prompt`, `blurFace` | step capture, deterministic replay, and A/B knobs — instrumentation, not behaviour | ongoing | `testing` |

## Resolved

| call | was | fixed by |
|---|---|---|
| `char_repair` | called `repairCharacterFace` directly with locally resolved axes, bypassing production's adapter — and with it the bbox validation, the **face-box union expansion** (a face box poking outside the body box expands the body box so the mask does not miss half the face) and the `char_repair_run` metric. The Lab could therefore repair a different REGION than production would. | the stage now calls `images.repairCharacterMismatch`, the same entry point the story pipeline calls |
| `char_repair` | neither caller passed `artStyle` | one shared contract (`charRepairRequest.js`) + parity test |

## Adding a divergence

1. Pass it explicitly (an `overrides` object or a marked Lab-only mechanic), never
   by quietly omitting a field the production caller sends.
2. Mark it in code with `// LAB DIVERGENCE (indexed)`.
3. Add a row here with the experiment that justifies it.
4. When the experiment concludes, promote it into the production path or remove
   it — and delete the row.
