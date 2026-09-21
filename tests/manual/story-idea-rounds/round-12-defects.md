# Round 12 — defect axes only (a, c, g, h, f)

20 ideas, `claude-sonnet-4-6`, USD 1.1389. Round file: `round-12.json` / `round-12.md`.

**The buy axis is NOT rated here.** A separate blind agent read the 20 ideas cold against R1
(`blind-set-r12.md` → `blind-scores-r12.md` → `analyze-blind.js --rounds=1,12`): **R1 3.50, R12
3.30, diff −0.20; R12 wins 3 arms, loses 6, ties 11, one 5 against R1's three.** Against R10's
3.90 on the same anchor this is **−0.60**; against R11's 3.50, **−0.20**. This document rates only
the five defect axes, same rubric and strictness as rounds 1-11.

## What changed for this round

One change, code-side, both sibling templates in step: **the world seed.** Every adventure guide
carries two ten-item lists (`Who lives here` / `What turns`, `abf78b05d`). Until now the model chose
from them; now `server/lib/worldSeeds.js` picks ONE centre and ONE turn per arm, deterministic from
the same seed `pickPremiseShapes` uses, guaranteed different between the two arms on BOTH lists, and
hands them over as a value — the same reason the shape is picked in code. Injected as `{WORLD_SEED}`
(single template) / `{WORLD_SEED_1}`, `{WORLD_SEED_2}` (two-idea template):

> This idea starts from this centre and this turn. Centre: &lt;c&gt;. Turn: &lt;t&gt;. Swap one only
> if it cannot fit the cast or the topic; keep the other.

A theme with no adventure guide gets nothing: cells 4 and 8 (historical) and cell 2 (theme
`realistic`) ran seedless, verified in `dry-run-1-4-5.json` before the round.

## Ratings

| # | cell | world | seed centre / turn | a | c | g | h | f | note |
|---|------|-------|--------------------|---|---|---|---|---|------|
| 1 | 1 pirate | location | castaway child / the tide turns | 5 | 3 | **3** | – | 5 | both seeds used literally and well; the waiting child sits on a stone the rising water will cover |
| 2 | 1 pirate | fantasy | a crab that will not be put back / the promiser cannot keep it | 4 | 3 | 5 | – | 5 | no adult anywhere for a three-year-old; three wants competing |
| 3 | 2 making-friends | location | *(no guide — seedless)* | **2** | 4 | 5 | 5 | 4 | «versuchen zwei Mädchen zusammen» is the solution, on the back cover; one dash |
| 4 | 2 making-friends | location | *(seedless)* | 4 | 4 | 5 | 4 | 5 | the note mechanic is a puzzle; the friendship is second |
| 5 | 3 wizard | location | a ghost that attaches itself / a promise given before it was understood | 4 | 5 | **3** | – | 5 | both seeds are the whole premise; two seven-year-olds climb the ruin at dusk |
| 6 | 3 wizard | fantasy | a creature made by accident / it is now too big for the room | 4 | 5 | 5 | – | 4 | the round's only blind 5; one dash |
| 7 | 4 moon-landing | participant | *(historical — seedless)* | **3** | 5 | 4 | – | **3** | Luca takes the controls as the fuel drops — narrated; a 40-word close |
| 8 | 4 moon-landing | fantasy | *(seedless)* | 4 | 5 | 5 | – | 5 | clean contract, but the landing happens off-screen |
| 9 | 5 not-giving-up | location | a creature nobody remembers bringing / the one relied on is homesick | 4 | 4 | 5 | 4 | 4 | seeds used, but dropped into a capsule at the Ruine Stein — the two worlds do not meet |
| 10 | 5 not-giving-up | fantasy | a voice on the radio / the alien understands everything except words | 4 | 5 | **3** | 5 | **3** | the tries (Morse, tones, numbers) are the topic working; Finn floats on the outer hull; 45-word sentence |
| 11 | 6 dinosaur | location | an old plant-eater falling behind / the egg moves, mother nowhere | 4 | 4 | **3** | – | 5 | a four-year-old alone where the ruin wall breaks off |
| 12 | 6 dinosaur | fantasy | an egg that keeps rolling out / the avoided big one is not the problem | **3** | 5 | 5 | – | 5 | the misidentification is resolved on the cover |
| 13 | 7 going-outside | location | a pony nobody may approach / the vet comes once this afternoon | 5 | 3 | 5 | 5 | 5 | the tightest contract of the round; the turn is bolted on, not earned |
| 14 | 7 going-outside | location | a hen that has stopped laying / the market opens at six | 5 | 3 | 4 | 5 | 5 | **the two cell-7 arms are finally different stories** (R11: the same one twice) |
| 15 | 8 wright-brothers | participant | *(seedless)* | 4 | 5 | 5 | – | 5 | «glaubt Yara Amir nie wieder» is a felt cost |
| 16 | 8 wright-brothers | fantasy | *(seedless)* | **3** | 5 | 5 | – | **3** | the cost is "no child on earth ever sees flight begin" — not a loss a child owns; 50-word opener |
| 17 | 9 knight (fr) | location | a banner-maker's child / the guarded thing is missing | 4 | 5 | 5 | – | 5 | **Maman Élodie handed over the wrong banner** — an adult who acts, the R11 fault gone |
| 18 | 9 knight (fr) | fantasy | the cook thanked by nobody / the wrong person is believed | **3** | 5 | 4 | – | **3** | four middles on the cover; Théo stranded past the drawbridge |
| 19 | 10 managing-emotions | location | a dragon keeping an old promise / the flight is for one, two need it | 4 | 5 | **3** | 5 | 4 | the seed IS the emotion lesson; the quarrel happens on a rock ledge |
| 20 | 10 managing-emotions | fantasy | a hatchling that has chosen its family / the elder answers too slowly | 4 | 5 | 5 | 5 | **3** | «ob Pip den Winter übersteht» lands; 50-word sentence with two dashes |

Means: **a 3.85 · c 4.40 · g 4.35 · h 4.75 · f 4.30**

## Means vs R8-R11

| axis | R1 | R8 | R9 | R10 | R11 | **R12** | Δ R11→R12 |
|---|---|---|---|---|---|---|---|
| a contract (premise only) | 3.25 | 3.60 | 2.90 | 2.95 | 3.30 | **3.85** | **+0.55** |
| c cast present with a role | 3.90 | 4.30 | 3.05 | 4.10 | 4.35 | **4.40** | +0.05 |
| g peril | 4.30 | 4.30 | 3.80 | 3.50 | 4.30 | **4.35** | +0.05 |
| h topic is the engine | 3.50 | 4.38 | 4.00 | 4.75 | 5.00 | **4.75** | −0.25 |
| f language/format | 3.70 | 3.45 | 2.40 | 4.10 | 4.00 | **4.30** | +0.30 |
| **blind parent buy** | 3.50 | 3.50 | 3.55 | **3.90** | 3.50 | **3.30** | **−0.20** |

## Fault classes, count out of 20

| class | R9 | R10 | R11 | **R12** |
|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 18 | 14 | 12 | **5** |
| — as a narrated event | 12 | 11 | 9 | **4** |
| — as a stated rule or gate | 6 | 5 | 3 | **0** |
| Cast listed rather than present (c≤3) | 14 | 4 | 3 | **4** |
| — a cast member missing entirely | 6 | 2 | 0 | **0** |
| — a named adult who does nothing | – | 2 | 2 | **1** (#9, c=4) |
| — no adult at all for a cast of one under five | – | – | 1 | **4** |
| Output-format drift (f≤3) | 20 | 8 | 8 | **5** |
| — a dash holding two clauses | 14 | 8 | 7 | **8** |
| — a sentence past ~30 words | 9 | 1 | 3 | **5** |
| **Peril over the line (g≤3)** | 6 | **8** | 5 | **5** |
| — a child alone at a height or on an edge | – | 4 | 1 | **4** |
| — a cost that ends on never coming home | – | 2 | 2 | **0** |
| Life-skill topic bolted on (h≤3) | 2 | 0 | 0 | **0** |
| Theme in name only | 2 | 0 | 0 | **0** |
| **Both arms tell the same story** | 1 | 1 | 1 | **0** |

## What the round measured

- **The contract axis is the best of the series (2.95 → 3.30 → 3.85), and the stated-rule class is
  gone (3 → 0).** A premise handed a centre and a turn has somewhere to put its first two sentences,
  so it stops inventing a gate or narrating a middle to fill them. This was not a class the round
  targeted; it is what a starting point does.
- **Both-arms-the-same is 0 for the first time.** Cell 7 was the standing instance — R10 and R11 both
  produced two near-identical ideas from one cast. With a guaranteed-different centre and turn per
  arm it produced a pony and a hen. This is the mechanism working exactly as designed.
- **The seed is visibly used in all 14 seeded arms**, usually as the opening image (the castaway
  child on the stone, the crab in the crow's nest, the cook thanked by nobody, the dragon's old
  promise). Not one arm ignored it.
- **Peril's height class went back up (1 → 4)** and this is the seed's doing: the turns that carry
  urgency put a child somewhere — a ruin at dusk, a broken wall, an outer hull, a rock ledge. The
  quoting check that killed this class in R11 is unchanged; the seed supplies the place faster than
  the check removes it. **The never-coming-home class, which R11 could not move, is 0.**
- **Format drift moved the wrong way inside a better mean.** Dashes 7 → 8 and long sentences 3 → 5,
  while f rose to 4.30 — the faults are concentrated on five arms instead of spread over eight.
- **The buy axis fell again, 3.50 → 3.30, and the loss is not where the seed helped.** R12 loses 6
  arms; five sit in cells 4, 5, 6 and 10 where R1 wrote a bigger, less-furnished idea. The seed's
  wins are real (cell 3-2 is the round's only 5; cells 8-1 and 10-2 both gain) but the rater reads a
  seeded premise as *more populated*, and on a back cover more population reads as harder to follow:
  «three wants competing, a three-year-old loses the thread» (cell 1-2), «five names tangled around a
  capsule» (cell 5-1), «a riddle, not a picture» (cell 10-1).
- **Cell 5 is unmoved at 2.0 for the third round running** (R10 4+2, R11 2+2, R12 2+2). The rater's
  reasons repeat: Kanal sieben, a 48-hour window, Morse, an antenna, Herr Keller waiting. R11's
  verdict already named the space guide's own machinery as the cause and no premise rule touches it;
  the world seed does not either.

Per-cell buy means, R1 → R12: cell 1 **4.0 → 3.5**, cell 5 **2.0 → 2.0**, cell 7 **3.0 → 3.0**,
cell 10 **3.0 → 3.5**.

## Verdict

🟡 **The seed is kept on the defect axes and did not earn a round 13.** It produced the best contract
mean of the series, ended the duplicate-arm class outright, and removed the stated-rule class — none
of which any prompt rule achieved in eleven rounds. It did not clear 4.0 on the buy axis (3.30), so
the confirmation round was not run and USD 1.26 of the budget is unspent.
**R10 (3.90) still stands as the best measured version on the buy axis**, and this round is the
third consecutive piece of evidence for R11's finding: defect compliance and the parent's buy read
pull in opposite directions, and the only two changes that ever moved the buy axis were product
changes, not rule or input changes.
