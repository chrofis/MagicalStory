# Story review — `job_1789420511893_zly5rcdej` (staging, 2026-09-15)

Generated on staging 2026-09-14 23:15 CH → 2026-09-15 00:38 CH, 16 pages + 3 covers.
Reviewed by reading the full text and **viewing all 19 images** before any metadata was consulted.
Scores below are the stored `finalScore` per page, pulled read-only from the staging DB
(`stories.data.sceneImages[].finalScore`) on 2026-09-15; `crowdExpected` is `false` on all 16 pages.

> Written up because this run is the evidence behind four `docs/decisions.md` entries dated
> 2026-09-15: the `crowdExpected` P0, the "scores did not track picture quality" measurement,
> `extra_character` having no repair route, and the people-free-page decision.

---

## 1. Text verdict — good

Swiss German is clean (`ss`, never `ß`), the guillemets are correct and tight, the moral turn is
**dramatised** rather than narrated, and the chestnut payoff set up early lands at the end. No
lector-class defects found in the read. The text is not the problem with this book.

## 2. Art verdict — mostly good, with a cluster of wardrobe defects at the back

Pages 1-7 are strong. The genuine defects, in order of importance:

1. **Captain Sarah wears a pirate tricorn instead of her navy cap with the golden anchor** — on
   **p14, p15, the back cover and the initial page**. The cap is the plot object of the story. This
   is the one defect that needs its own investigation and has not had one: candidate causes are a
   VB artifact entry with a holder, or the cover cast builder picking the **costumed** sheet instead
   of the standard one. Four surfaces, three of them covers — which is itself a hint that it is the
   cast-builder side, not the page side. → backlog.
2. **Emma wears the tricorn on p13 and p14**, before she recovers it on p16 — a continuity inversion.
3. **Emma wears a red coat instead of her blouse on p16.**
4. **The giant chestnut on p8** — ART004 is `size: "the size of a thumb"`, and the render puts a
   football-sized chestnut as the nearest object to camera. Scale, not identity; see
   `tasks/scale-ideas-2026-09-15.md`.
5. **Cloned faceless adults on p9.**
6. **Kilian is missing his tricorn on p11.**
7. **p13: Emma is idle where the text has her pulling.**
8. **p12 is empty** — see §4.

## 3. Per-page table — score against what the picture shows

| Page | Score | Unrepaired CRITICALs | What the picture actually shows |
|---|---:|---:|---|
| p1 | 60 | 1 | Harbour crowd, correct. 12 figures for a cast of 3 → false `extra_character` |
| p2 | **-5** | 1 | A fine page. 10 figures for a cast of 3 → false `extra_character` |
| p3 | 3 | 3 | No defect recorded in the read |
| p4 | 60 | 1 | Crowd correct. 10 figures for a cast of 1 → false `extra_character` |
| p5 | 60 | 1 | No defect recorded in the read |
| p6 | 55 | 1 | No defect recorded in the read |
| p7 | 80 | 0 | Strong page |
| p8 | **68** | 1 | **Football-sized chestnut nearest to camera** (a thumb-sized prop); crowd correct, 10 figures for a cast of 1 |
| p9 | 58 | 1 | **Cloned faceless adults** |
| p10 | **35** | 2 | Good page, no real defect |
| p11 | 40 | 1 | **Kilian missing his tricorn** |
| p12 | **33** | 4 | **Empty quay — the emotional climax, drawn with no children in it** |
| p13 | 65 | 0 | **Emma in the tricorn; idle where the text has her pulling** |
| p14 | 50 | 0 | **Captain Sarah in a pirate tricorn, not her navy cap**; Emma also in the tricorn |
| p15 | 60 | 0 | **Captain Sarah in a pirate tricorn** |
| p16 | -40 | 4 | **Red coat instead of the blouse**; the tricorn is recovered here |
| front cover | — | — | OK |
| initial page | — | — | **Captain Sarah in a pirate tricorn** |
| back cover | — | — | **Captain Sarah in a pirate tricorn** |

Mean `finalScore` **42.6 (≈43)**, against **62-69** on the three stories immediately before this one,
which carried 0-1 `extra_character` findings each.

## 4. Root causes

### 4a. The false CRITICALs — `crowdExpected` was never emitted

Nine of sixteen pages took an `extra_character` **CRITICAL** for harbour crowds the brief asked for
and the renderer drew correctly. The crowd guard is correct end to end — `sceneMetadata.js:883/921/1082`
→ `evalPipeline.js:1087` → `:1452 decline('crowd_expected')` — and had never been handed a `true`,
because `crowdExpected` was declared only in `prompts/scene-expansion.txt` (the per-page FALLBACK
template) while the live beats path expands with `prompts/scene-expansion-all.txt`. Omission reads as
false. 11 of the 16 briefs contain crowd / onlooker / quay / Hafen wording.

Fixed in **`f7979f824`** (both templates now declare it, pinned by
`tests/unit/scene-expansion-template-parity.test.ts`). →  `docs/decisions.md` 2026-09-15
"`crowdExpected` must be declared by BOTH Art Director templates".

**Why they could only subtract:** `wasCharacterFixed === false` on all 16 pages. `extra_character`
keeps CRITICAL (`scoring.js` ~186), its inpaint route was closed on 2026-09-13
(`NOT_INPAINTABLE_TYPES`, `0f25e7f25`), and `selectCharRepairTasks` (`repairLogic.js:444`) keys on a
cast name, which a surplus figure does not have. → `docs/decisions.md` 2026-09-15 "`extra_character`
has no repair route by design".

### 4b. p12 — the climax was spent on the people-free-page quota

The plan line for p12 reads, literally, *"…no one at the gangway place"*. `NO_PEOPLELESS_PAGE`
(`planCounters.js:547-548`) **requires** one people-free page per book and nothing constrained WHICH
page; `NO_COMMISSIONED_ON_PAGE` (`:598`) only inspects `peopled` pages, so a zero-cast page is skipped
by construction. The planner spent the quota on the emotional climax and no counter could object.

Fixed in **`c7bd81263`** (`PEOPLELESS_ON_INTERACTION_PAGE`). → `docs/decisions.md` 2026-09-15
"People-free pages are a feature; interaction drama gets faces". Open: whether that counter is
promoted from advisory to must-fix.

## 5. "Scores ≠ quality" — the evidence

- **p10 = 35** on a good page with no real defect.
- **p8 = 68** with a football-sized chestnut nearest to camera.
- **p12 = 33** — an empty climax — outscoring **p2 = -5**, a fine page, by 38 points.

The depression is not random: the charge landed on the pages with the most people in them, which on
this book are the good ones. A ranking this inverted cannot route repair effort, and read at a
glance it says "bad book" — which is exactly what the first report of this run said, from the
numbers alone, before anyone opened the images.

## 6. Also verified

Plan counters **did** run on this story (`fe7919c89`, confirmed by runtime evidence: 5/3/2 counter
findings, 15 pages re-divided). The pipeline was not skipping its checks; the checks were reading a
field nobody populated.

## 7. Still open from this review

- Captain Sarah's tricorn on p14/p15/back cover/initial page — needs its own investigation.
- Emma headwear continuity p13/p14, and the red coat on p16.
- VB element scale (p8 chestnut, p12 ship) — ideas only, see `tasks/scale-ideas-2026-09-15.md`.
- `PEOPLELESS_ON_INTERACTION_PAGE` advisory → must-fix.

All four are indexed in `tasks/BACKLOG.md`.
