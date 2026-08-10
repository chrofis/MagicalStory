# Showcase 2026-08-10 — German / pirate / steampunk

Two attempts on staging, persistent account `demo-berger@magicalstory.ch`, both
as free admin drafts.

| | attempt 1 | attempt 2 |
|---|---|---|
| job | `job_1786395764032_0qa6x9nsp` | `job_1786397108357_q1fjbdzbx` |
| outcome | cancelled at 30% | **completed, 28 min** |
| costumed avatars | 2/5 | **5/5** |
| wizard time | 3.7 min (created characters) | 55 s (reused them) |
| warn/error events | avatar failures | **0** |
| pages scoring positive | — | **13/14** |

Attempt 1 was killed by the judge-JSON bug — see `docs/decisions.md`, "A judge
that cannot punctuate must not delete a good image".

## Confirmed working (first live proof)

- **Wardrobe review reaches the persisted contract.** All 5 rewrites LANDED in
  `stories.data.clothingRequirements`. This is the transcript-merge fix; before
  it, the review was inert and reached only the early avatar kickoff.
- **World art styles shape the wardrobe.** Every character got a pirate base
  (coat/vest, tricorn or bandana, breeches, boots) plus steampunk accents —
  brass gear buckle, mechanical buckle with a tool pouch, compass on a chain,
  corset belt with grommets, clockwork-embossed belt, telescope. Five distinct
  dominant colours (red/brown/blue/purple/green).
- **Costume name reaches the sheet.** 5/5 costumed avatars, `clothing` 9-10/10.
- **Goggles render pushed up onto hat or bandana**, face clear — the face rule
  held on every character.
- **The front cover is canon-exact**: Emma's green-tinted goggles on her red
  bandana, Noah's compass on a short chain and goggles on the tricorn brim.
- **Admin draft**: `admin_draft = true`, `credits_reserved = 0`, account balance
  untouched at 200.
- **Figure detection was clean** — zero `detection_fallback`, zero
  `sam_mask_leak`. Earlier runs had 8-12 per story.

## Open defects found by this run

### 1. Art style broke to photorealism on one page (p5, score −22)

Page 5 rendered as a photograph — real faces, real depth of field — while p9,
p10, p13 and the cover are cel-shaded steampunk graphic novel. Same story, same
style descriptor, one page defected. Hans is also absent from the group.

This is the failure mode `docs/decisions.md` (2026-08-06, "Cyber (and any
setting art style) must name a figure MEDIUM") fixed for `cyber` by leading the
descriptor with a medium. `ART_STYLES.steampunk` already leads with "steampunk
graphic novel illustration", so the descriptor is not obviously at fault — the
break is per-page, not per-story. Unresolved.

### 2. Character repair runs, produces nothing, logs nothing

Railway stdout shows char-fix firing:

```
[CHAR-FIX] Round 1 char-fix Emma on p13: target bbox source=entity
[CHAR-FIX] Round 1 char-fix Hans on p14: protection bboxes for: Emma, Noah
```

But `wasCharacterFixed` is false on all 14 pages, p13 has only an `original`
version, and the story's own `generationLog` contains **zero** char-fix events.
The work happened and left no trace anywhere a reader of the story data can see.

Note `repairPipeline.js` / `images.js` / `figureDetection.js` were being edited
in parallel by another session on this date — diagnose against their commits
before assuming this is longstanding.

### 3. `garment-recolour` made a page much worse

p14: `original` scored 30, `garment-recolour-round-1` scored **−80**. The
version picker correctly kept the original, so nothing shipped broken, but the
method cost a paid call to produce something 110 points worse.

### 4. Fake handwriting on a prop (p13)

The parchment carries scribbled pseudo-text. `image-generation.txt` requires
letters and maps to show pictorial marks only — no handwriting, no captions.

## Still unproven

- `costumeReads` — the sub-score added to `sheet-row-bodies-eval.txt` was never
  observed in the stored eval output. Not confirmed firing.
- Whether the reviewed wardrobe reaches the *page prompts* as reliably as it
  reaches the contract; the cover proves the avatar path, per-page garment drift
  (Emma in a coat instead of vest+skirt on p10/p13) suggests the page path is
  looser.
