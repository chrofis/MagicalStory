# VB scale class, generic gate, and plate routing for large elements — 2026-09-15

Status: PLAN — owner reviewed 2026-09-15. Phases 1-3 APPROVED for implementation; phase 4 NOT NOW (owner). Open questions answered below.

## Goal

Three owner decisions (2026-09-15), plus one optional unapproved phase.

1. A closed `scaleClass` enum on every Visual Bible element, so scale is a field code can read.
2. A generic-vs-specific gate at bible-authoring time, so an everyday instance never buys an id, an entry, a paid reference render or a page cell.
3. Vehicle-class and larger route their reference to the **plate**, never to a page reference cell beside the cast.
4. (OPTIONAL, not approved) A mechanical post-render scale check deriving an existing finding type from two bboxes.

## Evidence

From `job_1789420511893_zly5rcdej` (staging), via `tasks/scale-ideas-2026-09-15.md`:

- **ART004 "roasted chestnut"**, `size: "the size of a thumb"` — correct free text. Attached as one of three page-8 reference cells. Rendered football-sized, nearest object to camera. A cited reference has to appear; the cell made a thumb-sized prop a hero object. **A correct free-text size changed nothing, because nothing in code reads it.**
- **VEH001 "wooden sailing ship"**, `type: undefined, size: undefined` — the vehicle parse (`visualBible.js:738-750`) has no `size` slot at all. Cited as a page-12 cell; rendered as a small open rowboat although the plate prompt named the ship. **The cell won over the plate.**
- Already tried and settled: free-text `size` authored everywhere (`e476ca314`); AD must name a size ratio (`b62396e4a`, reach only, effect unmeasured); "foreground is placement, not size" (`2adea0dd9`); **a scale referent inside a VB cell was REJECTED** (`feedback_no_scale_referent_in_vb_cell`) — anything sharing a cell leaks onto the page. Not proposed here.

**Prior-art check (`docs/SETTLED.md`, `docs/decisions.md`) — nothing in this plan reverses a settled line:**
- SETTLED "Three Visual Bible elements per page — and LOCATIONS ARE NOT ELEMENTS" (2026-09-08). Decision 3 moves vehicle/building/landscape elements off the page for the same reason a LOC is not an element: *the location is the plate the cast is composited into.* This **extends** that logic, it does not reverse it. `VB_ELEMENT_BUDGET` keeps counting secondary characters, animals and artifacts.
- SETTLED "One authored `label` per VB element is the only element string an image model sees" (2026-09-13). `scaleClass` is machine-facing and is **never printed verbatim into any image prompt** — no new element string.
- SETTLED "Classification is the PROMPT's job; code may only change a severity." Phase 4 obeys this: two measured bboxes + an authored enum → an existing type. No description text is ever inspected.
- decisions.md "VB object descriptions are drawn literally — no shape similes" (a size comparison is explicitly allowed). Unchanged.
- decisions.md 2026-09-11, `sizeNote` on REQUIRED OBJECTS, animals included (`promptBuilders.js:4024-4040`). Decision 1 **keeps** this; removing it would be the reversal.
- decisions.md 2026-09-11, "no code-side enforcement of the element budget". The decision-3 filter is a **routing** rule keyed on an authored class, not a budget enforcer — it removes nothing the AD asked for, it re-addresses it to the plate.

## Design

### Decision 1 — `scaleClass` enum on every VB element

**Schema.** One new authored key, closed enum, on `artifacts`, `vehicles`, `animals`, `secondaryCharacters`, `locations`:

```
"scaleClass": "hand | arm | person | vehicle | building | landscape"
```

Meaning, stated as height against a standing adult (this wording goes in the prompt so the AD and the phase-4 bands cannot drift apart):

| class | height against a standing adult | examples |
|---|---|---|
| `hand` | fits in one hand | cup, chestnut, key, coin, ring |
| `arm` | spans a forearm to an arm | book, crossbow, lantern, loaf, paddle |
| `person` | knee-height to head-height | chest, dog, barrel, chair, a child |
| `vehicle` | taller or longer than a person, boardable or pushable | cart, boat, wagon, horse |
| `building` | several people high, fixed to the ground | house, tower, ship, mill, bridge |
| `landscape` | the horizon, not an object | mountain, forest, lake, valley |

**`size` stays. Recommendation: keep both, with a clean split of duty.** Reasoning:

- The two fields have **different consumers**. `size` is a sentence, authored per object, and its only job is to reach a model as prose (`promptBuilders.js:4040` `sizeNote`, `visualBible.js:849` `buildArtifactDescription`). `scaleClass` is a token, and its only job is to be **read by code** — routing, cell framing, phase-4 bands. Code cannot read a sentence; that is precisely the p8 failure.
- Folding `size` away would reverse `e476ca314` and the 2026-09-11 animal extension (which cites a dragon rendering knee-high on two pages and house-sized on a fourth) with **no evidence that `size` harms**. The p8 evidence says `size` was *insufficient*, not wrong. Deleting it needs the reversal protocol and has no case.
- Merging them (one field carrying both) is worse than either: the enum stops being closed, and `sizeNote` starts emitting `"vehicle"` into a page prompt, which is a bare category the label rule forbids.

So: **`scaleClass` is added everywhere; `size` is kept where it exists (artifacts, animals) and is NOT added to vehicles.** A vehicle's size reaches the model through the plate prose and the plate reference (decision 3), so a page-facing `size` sentence for a vehicle would have no consumer. That is how VEH001's missing size gets fixed — by the class, not by a second free-text field nobody reads.

**Parser behaviour** (`server/lib/visualBible.js`, the JSON whitelist parse at `:666` artifacts, `:713` locations, `:738` vehicles, plus the animals and secondaryCharacters branches):

- [ ] Add `scaleClass` to each whitelist (the parse is a WHITELIST — an unlisted field is dropped silently; that is documented at `:688`).
- [ ] Normalise: lowercase, trim. **Unknown value → `null` + `log.warn`.** Never coerce to a nearest class; a guessed class routes an object to the wrong pipeline.
- [ ] Missing value → `null` + `log.warn` naming the id. Not an error: old stored bibles have none (see Risks).
- [x] ~~Consistency check, warn-only~~ — CUT by owner 2026-09-15 (open question 2). Was: when both `size` and `scaleClass` exist and the `size` text obviously contradicts the class, log it. This is the one place a text check is acceptable *because it decides nothing* — it emits a log line for a human, never a finding and never a route. Keep it to an exact-token list (`hand`/`palm`/`thumb`/`fist` vs `building`/`landscape`) or skip it entirely if that feels like the thin end of the pattern-matching wedge; the owner's call (open question 2).
- [ ] `scaleClass` is **never** concatenated into `description`, `label`, `sizeNote` or any prompt string.

**Prompt-rule wording draft** (identical at every authoring site — one canonical wording):

> `"scaleClass"`: `[one of: hand, arm, person, vehicle, building, landscape — how tall this element is beside a standing adult. hand: fits in one hand. arm: spans a forearm to an arm. person: knee-height to head-height. vehicle: taller or longer than a person, boardable or pushable. building: several people high, fixed to the ground. landscape: the horizon rather than an object. Never omitted. Judge the element itself, not how the story feels about it.]`

And one line in each site's rules block:

> `- Every element carries `scaleClass`. The field is never omitted, and an adjective is not a class — massive, tiny, huge name no band.`

### Decision 2 — generic vs specific gate at bible-authoring time

**Shape: an authored `"generic": true` on the entry, which the parser drops.** Not "instruct the AD to omit". Reasons:

- Omission is what `fillTemplate` and every parser already read as `false`/absent (this is the `crowdExpected` failure class, `docs/sibling-paths.md`). An omitted entry is **indistinguishable from a forgotten entry** — no log line, no counter, no way to audit whether the gate is being applied at all.
- A `generic: true` entry that the parser drops produces exactly one artefact per object: a log line and a counter. That is auditable, and it is the only version of this that can be measured on a real story without a paid re-run.
- It also gives the AD a place to put the decision, which is the thing the owner is actually asking it to make.

**The gate the AD is given** (one test, no list of categories — a category list would be a story-specific example and would rot):

> `"generic"`: `[OMIT for every element that must look the same on every page it appears on. Set to true only when any instance of the thing would serve: swap it between two pages and no reader could tell. A generic element gets no entry beyond this one, no id and no reference image — it is written into the page prose by name and nothing else. If the story ever refers back to THIS one — it is found, lost, given, marked, recognised, or a character owns it — it is not generic.]`

**Parser behaviour:**

- [ ] `generic === true` → the entry is NOT pushed into `visualBible.artifacts` (or animals/vehicles). It is pushed into a new `visualBible.genericObjects[]` with `{ label, description, scaleClass, pages }` and **no `id`**.
- [ ] `genericObjects[]` is invisible to: `getElementReferenceImagesForPage`, `getEmptySceneElementReferences`, `buildReferenceSheetBatches` (no paid render), `ELEMENT_COLLECTIONS` / `VB_ELEMENT_BUDGET`, `entityConsistency`, `bboxDetection` grounding.
- [ ] **Citation guard.** If a page's AD `objects[]` names a generic entry (by id or by name), `log.error` and strip the citation before it reaches `collectVbObjectCitations` (`visualBible.js:2932`) — otherwise the citation path would resurrect the entry through the `askedFor` map and hand it a cell. Fails loud, never silently.
- [ ] **A SPECIFIC object keeps its entry and its cell whatever its class.** The owner rejected "drop all hand-sized cells"; nothing in this plan drops a cell on size grounds alone.

**How the page prompt still names a generic object without an id.** It already does — the AD's SCENE prose is the channel. The added rule at the authoring site:

> `- A generic element is named in the page's scene prose like any other physical fact, and never appears in `objects[]`. It has no id to cite.`

The REQUIRED OBJECTS block (`promptBuilders.js:4060`) is a presence checklist built from `objects[]`, so a generic object correctly never appears there. Its look comes from the prose, which is where an everyday object's look belongs.

### Decision 3 — vehicle-class and larger belong to the plate

**Where the plate prompt is built:** `buildEmptyScenePrompt` (`server/services/prompts.js:596`) — its `**VEHICLES:**` block at `:610-657`, gated on the AD's `objects[]` (`sceneObjectsNameEntry`, owner 2026-09-04) with the `aboardId` exception at `:648-651`. Callers: `storyJobPipeline.js:2171` (trial), `:4518`/`:4603` (per-page + retry), `:4849`/`:4931` (per-vantage + retry), `images.js:4220` (iterate), `coverIterate.js`, `testlab.js:667`.

**Where the plate's reference image is built:** `buildEmptySceneVbGrid` (`referenceSheets.js:1510`) → `getEmptySceneElementReferences` (`visualBible.js:2757`), today **vehicles + non-landmark locations only**, cap 9, one reference family per plate (landmark photo beats grid, `:1518`).

**Where page reference cells are selected:** `getElementReferenceImagesForPage` (`visualBible.js:2901`), priority `secondaryCharacters(1) > animals(2) > artifacts(3) > vehicles(4) > locations(last)`, cap `VB_SLOT_MAX_ELEMENTS` = 4. Filtering happens in two places: `buildPageCompositeRefs` (`referenceSheets.js:1549`, the documented single source of truth — drops vehicles/locations when `hasBackground`) and the inline Phase 5a-pre-grid block (`storyJobPipeline.js:5047-5090`, same rule, gated on `hasPlate`).

**The change:**

- [ ] `getEmptySceneElementReferences`: widen from "vehicles + non-landmark locations" to "vehicles + non-landmark locations + **any element whose `scaleClass` is `vehicle`, `building` or `landscape`**". A building-scale *artifact* — a monument, a mill, a bridge, a pole-with-banner — reaches the plate it belongs to instead of competing for a page cell. Same AD-`objects[]` authority gate, same `aboardId` skip, same cap 9.
- [ ] `buildEmptyScenePrompt`: widen the `**VEHICLES:**` block to `**STRUCTURES:**`, same gate, same aboard exception, same "render only the part the camera sees" tail. Wording draft for the header: *"Any vessel, vehicle or built structure in this backdrop is one of those described below — match its colour, construction and named parts, never a generic substitute:"*
- [ ] `getElementReferenceImagesForPage`: drop any entry with `scaleClass` in `{vehicle, building, landscape}` — **unconditionally, at selection time**, not gated on whether a plate was sent. This is the p12 fix: the current filter only fires when `hasPlate`, so a plateless page still spends a cell on a three-master, and the cell wins over the prose. One `log.info` per dropped element naming id + class + "routed to plate". **See Risks: the drop is conditional on the element actually reaching a plate.**
- [ ] The existing `type !== 'vehicle' && type !== 'location'` filters in `buildPageCompositeRefs:1574` and `storyJobPipeline.js:5071` become redundant for classed bibles but **stay** as the `scaleClass === null` fallback for stored bibles.
- [ ] **Bug found en route, fix in the same commit:** `storyJobPipeline.js:4313` computes `vbRefElementIds` from the **unfiltered** `elementReferences`, before Phase 5a-pre-grid (`:5047`) drops cells. So `promptBuilders.js:4062-4067` can tell the model *"the attached reference images include a rough image of <the ship>"* when that cell was dropped — the model is told to match a reference it was never given. Move the `vbRefElementIds` computation to after 5a-pre-grid, or recompute it from `kept`.

**`docs/image-routing.md` — new row for the decision matrix:**

| Task | Method / Model | When | Verdict | Test Lab stage | Ref |
|---|---|---|---|---|---|
| **Large-element reference (vehicle / building / landscape scale)** | Attach to the **PLATE** only — `getEmptySceneElementReferences` → `buildEmptySceneVbGrid` → `buildEmptyScenePrompt` `**STRUCTURES:**`. **Never a page reference cell beside the cast**: `getElementReferenceImagesForPage` drops `scaleClass ∈ {vehicle, building, landscape}` unconditionally, plate or no plate. Selection is by the authored `scaleClass` enum, not by VB collection — a building-scale ARTIFACT routes to the plate too. | Every page | ✅ owner, 2026-09-15. Evidence: `job_1789420511893_zly5rcdej` p12 cited VEH001 as a page cell and a three-master rendered as an open rowboat although the plate prompt named the ship — **the cell won over the plate.** A reference cell has exactly one size, its own, and nothing in the cell says whether it depicts a thumb or a three-master; the plate sizes a structure against bollards, cobbles and quay height. The prior filter existed but was gated on `hasPlate`, so a plateless page still spent a cell. A scale referent INSIDE the cell is REJECTED and is not the alternative (`feedback_no_scale_referent_in_vb_cell`). | `empty_scene` (the plate now carries the structure reference) + `image` (the page's cell set changed) | this plan, decisions.md 2026-09-15 |

**Test Lab stages that re-test it:** `empty_scene` for the plate side, `image` for the page side, `scene_expansion` / `scene_expansion_ab` for the AD schema change. No new stage.

## Optional Phase 4 (NOT approved — do not build without an explicit yes)

**Mechanical scale check after render.** Ratio = detected object bbox height ÷ nearest standing figure bbox height, compared against the authored `scaleClass` band.

**Why this is a measurement feeding an existing type, not text pattern-matching.** `docs/SETTLED.md`: *"Classification is the PROMPT's job; code may only change a severity… never pattern-match a finding's description text to decide what it MEANS."* This derivation never reads prose. Its three inputs are (a) a detector bbox, (b) a detector bbox, (c) an enum token an author wrote into the bible — the same shape as `derivePresenceFinding` (`evalPipeline.js:~1370`), whose inputs are two independent counts and a declared roster. Both emit a **type from the existing closed list**: `scale` (D-21, `image-evaluation.txt:165`) for `hand`/`arm`/`person`, `structure_scale` (D-31, `:166`) for `vehicle`/`building` — both already in the evaluator vocabulary, and `structure_scale` already carries a MAJOR ceiling in `MAX_SEVERITY_TYPES` (`scoring.js:170`). **No new type, no new severity, no new prompt classification.**

**Starting bands** (object height ÷ nearest standing adult figure height; deliberately wide, these are "obviously wrong" gates, not accuracy tests):

| class | band | fires at |
|---|---|---|
| `hand` | 0.02 – 0.15 | > 0.22 |
| `arm` | 0.10 – 0.35 | > 0.52 |
| `person` | 0.55 – 1.35 | < 0.37 or > 2.0 |
| `vehicle` | 1.2 – 6.0 | < 0.8 |
| `building` | > 3.0 | < 2.0 |
| `landscape` | — | never fires |

Fire only when **all** hold, mirroring the two-witness discipline: (1) the object has a detected bbox from `enrichWithBoundingBoxes` / `expectedObjects` grounding (`bboxDetection.js:1892`); (2) a **standing, uncropped** figure is in frame (`clipped_by: none`, not sitting/kneeling — the same skip conditions the inventory already uses for `height_order`); (3) the ratio is outside the band by ≥1.5×; (4) `scaleClass` is non-null. Otherwise **decline**, with a counter, exactly like `presenceCounterName`.

**Feedback into retries** (memory rule: compute in code, inject into generator AND critique, retries carry the failure reason): the derived finding gets `derivedBy: SCALE_DERIVED_MARKER` and `sources: [FINDING_SOURCES.FINAL_CHECKS]` (the code-authored provenance stamp, `evalPipeline.js` PROVENANCE 2026-09-14), joins the findings list, and its `fix` string carries the measured ratio and the target band in words — *"the <label> is drawn at about X× the height of the figure beside it; at <class> scale it should reach <band, in body terms>"*. That string is what the retry carries; the same measurement is injected into the re-render prompt, not just the critique.

**This phase does not ship without stored-evidence validation first** — re-derive over ≥10 stored pages including p8 and p12 of `job_1789420511893_zly5rcdej` and count false positives before any band is written into production.

## Files touched per phase

**Phase 1 — `scaleClass` (one commit, all VB authoring sites move together):**
- `prompts/scene-expansion-all.txt` — artifacts/vehicles/animals/locations schema + the rules-block line
- `prompts/story-unified.txt` — same
- `prompts/story-trial.txt` — same
- `prompts/story-unified-imagefirst.txt` — same. **It is a VB authoring site and the registry did not list it** (it sat only in `unified-writer-twins`); it must be in `vb-authoring-sites` before phase 1 lands.
- `scripts/admin/sibling-registry.json` — add the member above + a `parity.anchors` block on `vb-authoring-sites` (the set has **no `parity` today**; `metadataKeys` does not apply, these are VB JSON schemas not `---METADATA---` blocks). Anchors: `"scaleClass"` and, in phase 2, `"generic"`.
- `tests/unit/sibling-parity.test.ts` — no code change needed, the parity loop is data-driven from the registry; adding `parity.anchors` adds its assertions automatically. Verify it fails before the prompts are edited.
- `server/lib/visualBible.js` — whitelist + normalise + warn, on all five collections
- `docs/decisions.md` — new entry (Context / Decision / Rationale / Touched files)
- `docs/SETTLED.md` — **not touched in phase 1**; it earns a line only after it survives a re-litigation.

*Verified NOT authoring sites, so deliberately excluded:* `prompts/scene-expansion.txt` (consumes the VB, authors none — zero hits for an artifacts/vehicles schema) and `prompts/story-bible-from-beats.txt` (wardrobe contract only; its own header says *"The Visual Bible and the cover scene hints are written later, by the Art Director"*). Record both in the commit message so the next session does not re-derive it.

**Phase 2 — generic gate:**
- The same four prompt files + `scripts/admin/sibling-registry.json` (anchor `"generic"`)
- `server/lib/visualBible.js` — `genericObjects[]` split, citation guard
- `server/lib/referenceSheets.js` — generic entries never enter a reference-sheet batch
- `server/lib/vbElementBudget.js` — generic entries never count
- `docs/decisions.md`

**Phase 3 — plate routing:**
- `server/lib/visualBible.js` — `getElementReferenceImagesForPage` drop + `getEmptySceneElementReferences` widen
- `server/lib/referenceSheets.js` — `buildEmptySceneVbGrid` comment/contract; `buildPageCompositeRefs` fallback comment
- `server/services/prompts.js` — `buildEmptyScenePrompt` `**VEHICLES:**` → `**STRUCTURES:**`
- `storyJobPipeline.js` — Phase 5a-pre-grid comment + the `vbRefElementIds` ordering bug
- `docs/image-routing.md` — the row above
- `docs/image-generation-methods.html` — update §5b (reference slots) and the plate section
- `docs/decisions.md`

**Phase 4 (optional):** `server/lib/evalPipeline.js`, `server/lib/scoring.js` (verify no new ceiling needed), `docs/decisions.md`. **No prompt file** — that is the point of the phase.

## Tests per phase

Behaviour ships with tests in the same commit.

- **Phase 1:** `tests/unit/sibling-parity.test.ts` (extended via the registry, must fail before the prompts change) · `tests/unit/vb-scale-class.test.ts` (new — whitelist admits the field on all five collections; unknown value → `null` + warn, never coerced; missing → `null`, not a throw; `scaleClass` never appears in `description`/`label`/`sizeNote`) · `tests/unit/artifact-size.test.ts` (existing — extend: `size` still reaches `sizeNote` unchanged, i.e. the regression guard that we did not fold it away)
- **Phase 2:** `tests/unit/vb-generic-gate.test.ts` (new — `generic:true` never lands in `artifacts[]`, gets no id, no reference batch, no budget count; a page citing a generic id is stripped with a `log.error`; `generic` absent behaves exactly as today) · `tests/unit/ad-authored-bible.test.ts` (existing — extend)
- **Phase 3:** `tests/unit/vb-plate-routing.test.ts` (new — a `scaleClass: vehicle|building|landscape` element is absent from `getElementReferenceImagesForPage` **with and without** a plate; a `building`-class ARTIFACT appears in `getEmptySceneElementReferences`; `aboardId` still wins; `scaleClass: null` falls back to today's `type`-based behaviour; the no-plate fallback keeps the cell) · `tests/unit/element-refs-scene-objects.test.ts` (existing — extend: a cited large element is routed, not resurrected) · `tests/unit/cast0-plate-routing.test.ts` (existing — regression) · a new case asserting `vbRefElementIds` equals the cells actually sent
- **Phase 4:** `tests/unit/scale-derivation.test.ts` (new — band table in/out, the four decline conditions each produce their own counter, emitted `type` is `scale` or `structure_scale` and never a new string, `derivedBy`/`sources` stamped, function is pure)

Run `node scripts/admin/check-sibling-paths.js --list` before declaring any phase done.

## Open questions — ANSWERED by owner 2026-09-15

1. **Does `locations` carry `scaleClass`?** A LOC is not an element and never gets a page cell, so the field would have exactly one consumer: phase 4 (which would never fire on it — `landscape` has no band). Adding it costs four prompt edits for nothing measurable; leaving it out makes the enum "every element except locations", which is a footnote future sessions will trip on. **Recommendation: add it, for uniformity.**
2. **The `size`/`scaleClass` contradiction check** — warn-only log, or nothing at all? It is the only text inspection anywhere in this plan, and although it decides nothing, it is the shape the SETTLED rule warns about. Lean: build it; would not argue if cut.
3. **Retro-classify stored bibles, or leave them `null` forever?** A one-off `scripts/admin/` backfill could set `scaleClass` on existing stories' artifacts/vehicles from their `size` text — but that is an LLM call per element (paid) or a text heuristic (the thing we just said not to do). See Risks; default is **no backfill**.
4. **Phase 4: build it at all?** Not approved. If yes: stored-evidence validation run (free, ~10 stored pages) before any band reaches production, or straight to a Lab stage?
   **→ Owner: ADD it, for uniformity.**
   **→ Owner: CUT it. No text inspection anywhere in the plan.**
   **→ Owner: NO backfill. `null` is a first-class route that falls back to today's type-based behaviour.**
   **→ Owner: NOT NOW. Ship phases 1-3; revisit once the enum has data behind it.**

## Risks

- **Cell-count budget per page after the change.** This change only ever *frees* cells: `VB_SLOT_MAX_ELEMENTS` stays 4 and `VB_ELEMENT_BUDGET` stays 3; large elements and generic objects leave the page grid, they never join it. The measured baseline (`job_1787959478282_bz19gm36h`: 10 of 14 pages selected 5-6 elements, every page spending cells on the vehicle and its locations) should fall to ≤3 on most pages. **The real risk is the opposite one:** a page whose only element was the ship now sends **zero** cells and renders with no visual reference at all. That failure already has a precedent — page 1 of `job_1788295892348_l028ggiq7a`, a cast-0 ship exterior that attached zero references while a finished plate of the ship existed and was discarded. Mitigation: the drop is *conditional on the element actually reaching the plate*. If `buildEmptySceneVbGrid` returns null for that page (landmark photo present, or no plate sent), the large element **keeps its page cell** rather than travelling on nothing. That fallback must be in the phase-3 test file, not an afterthought.
- **Existing stored bibles have no `scaleClass`.** Every finished story's `stories.data.visualBible` predates the field. **Decision: no migration, default `null`, and `null` is a first-class route** — every branch falls back to today's `type`-based behaviour. This matters beyond cosmetics: repair, iterate, regeneration and cover paths all re-read stored bibles months later (`regeneration.js:726/1193/2070`, `coverIterate.js:1810`), and a `null` that throws or that gets guessed into a class would change a shipped book's routing on a repair. A backfill is open question 3.
- **Four prompt files move together, and the gate blocks the push if one lags.** That is the gate working. The registry member list must be corrected (adding `story-unified-imagefirst.txt`) *before* the prompts are edited, or the gate will pass a three-quarters-complete change.
- **The AD may over-apply `generic`.** An object the story returns to on page 11 marked generic on page 3 loses its identity silently. The `log.info` count per story is the only detector; watch the first few stories' counts rather than assuming the gate landed correctly.
- **Concurrent edits to `scripts/admin/sibling-registry.json` and `docs/decisions.md`.** Both are append-shaped, but re-read before editing — do not rebase over other sessions' entries.
- **No paid calls were made and no story was generated for this plan.** Static reading only.

## Incidental findings (worth acting on regardless of this plan)

- `prompts/story-unified-imagefirst.txt` authors a Visual Bible and was **missing from the `vb-authoring-sites` registry set** — that set was under-enforcing. Handed to the gate owner 2026-09-15.
- `storyJobPipeline.js:4313` builds `vbRefElementIds` from the unfiltered reference list, so a page prompt can claim an attached reference image that Phase 5a-pre-grid dropped. Fix scheduled in phase 3; could ship alone.
