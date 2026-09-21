# Round 10 — defect axes only (a, c, g, h, f)

20 ideas, `claude-sonnet-4-6`, USD 1.0497. Round file: `round-10.json` / `round-10.md`.

**The buy axis is NOT rated here.** A separate blind agent read the 20 ideas cold against R1
(`blind-set-r10.md` → `blind-scores-r10.md` → `analyze-blind.js --rounds=1,10`). This document rates
only the five defect axes, with the same rubric, the same strictness and the same calibration as
rounds 1-9, so the counts are comparable: `a` contract (premise only, no middle and no ending),
`c` cast present with a role, `g` peril, `h` life-skill topic is the engine (scored on the 8
life-challenge ideas only), `f` language/format on the R1-R4 criteria.

## What this round is

Round 10 is not a new prompt version. It is the **combined state** measured in one place, after the
draft-two experiment was reverted (`9ebac9412`):

- the R9 prompt version in full — the shared buy criterion (`IDEA_BUY_QUESTIONS`, one constant
  filled into both templates twice), the examples rewritten to the standard of the blind 5s, and
  **every rule and review check the round-9 prune removed, put back** (`3b7f320f8`);
- the 17 life-challenge guides and the age-band plot shapes as they stood at `7ad802926`, including
  the going-outside guide rewritten to one sensory want and one world-thing that answers or resists;
- the `age-band-journey.txt` premise rule: the stake belongs to the main character's own life, never
  an assignment, a submission, a competition entry or a place won in a selection, and the obstacle
  is something they can touch or someone who wants the opposite;
- the adventure guides from `50124a79b`;
- the templates byte-identical to `3b7f320f8` — no second draft, no PICK step.

## One rubric change, stated up front

**A leading `Rollen:` / `ROLES:` block is no longer an `f` defect.** R9 counted it as format drift
(2 of 20). Since `7ad802926` it is generated **by design**: the chosen idea text becomes
`storyDetails` whole, and that block is the only path the historical casting takes to the writer,
the beats chain and the premise-aware judges, so it must keep being produced — and
`client/src/utils/ideaRoles.ts` lifts it off the blurb for DISPLAY, rendering it as a small cast
line beneath the idea. It is still present on both historical ideas (#7, #15) and is counted below
as an occurrence, not as a fault. Every other axis keeps R1-R9 strictness exactly.

## Ratings

| # | cell | world | a | c | g | h | f | note |
|---|------|-------|---|---|---|---|---|------|
| 1 | 1 pirate | location | 5 | 4 | 4 | – | 5 | clean contract: hook, want, obstacle, cost, nothing narrated; father present by relation |
| 2 | 1 pirate | fantasy | 4 | 4 | 4 | – | 5 | «weil darin ein Papagei sitzt und nicht mehr herauskommt» explains the hook |
| 3 | 2 making-friends | location | 2 | 5 | 5 | 4 | 3 | «bis die Bälle sich vermischen» and «Mia kriecht hinterher» are two narrated middles; one dash |
| 4 | 2 making-friends | location | 2 | 3 | 2 | 5 | 5 | s2 narrates the approach AND the rejection; Leo only «sieht von weitem»; a 5-year-old climbing the ruin wall alone |
| 5 | 3 wizard | location | 2 | 5 | 4 | – | 5 | «Wurm hat sich an Elias geheftet» explains the hook; s4 narrates the climb already under way |
| 6 | 3 wizard | fantasy | 3 | **1** | 4 | – | 2 | raven gate «gibt nichts heraus, bevor er nicht etwas dafür bekommt»; **Sofia absent**; two dashes |
| 7 | 4 moon-landing | participant | 4 | 4 | 3 | – | 5 | `Rollen:` block (by design); all four cast present; fuel running out in the vehicle, 9-year-old at the controls |
| 8 | 4 moon-landing | fantasy | 3 | 5 | 2 | – | 5 | s5 narrates the roof climb; a 9-year-old on the roof is the height class |
| 9 | 5 not-giving-up | location | 5 | 5 | 2 | 5 | 5 | cleanest contract of the round; five stakes, five names; but Jonas left stranded in orbit as the cost |
| 10 | 5 not-giving-up | fantasy | 3 | 5 | 4 | 5 | 3 | «der Steuerknüppel reagiert nicht» narrates the attempt going wrong; one dash |
| 11 | 6 dinosaur | location | 2 | 4 | 4 | – | 3 | Ben carrying it the wrong way and «Das Ei beginnt, sich zu bewegen» are narrated; Mama Sara and Papa Tom are shopping; one dash |
| 12 | 6 dinosaur | fantasy | 4 | **1** | 4 | – | 3 | **Zara absent**; «er traut Emma den Weg nicht zu» is a trait paired with the obstacle; one dash |
| 13 | 7 going-outside | location | 2 | 5 | 5 | 5 | 3 | the pursuit is narrated across three sentences; but the want is sensory and the doing is the child's, with Rosi supporting not carrying; one dash |
| 14 | 7 going-outside | location | 3 | 2 | 4 | 5 | 3 | «bis man es nicht mehr sieht» narrates the outcome; **no adult anywhere** for a 1-year-old; one dash |
| 15 | 8 wright-brothers | participant | 3 | 5 | 4 | – | 5 | `Rollen:` block (by design); «Amir klettert trotzdem» narrates the middle; Yara's opposing stake is the best obstacle in the round |
| 16 | 8 wright-brothers | fantasy | 2 | 5 | 3 | – | 2 | a stated permission rule plus a narrated run through the dunes; two sentences past 30 words; one dash; an 8-year-old on the landing path |
| 17 | 9 knight (fr) | location | 4 | 4 | 5 | – | 5 | near-clean; only «Chloé se retrouve seule» stages rather than promises |
| 18 | 9 knight (fr) | fantasy | 2 | 5 | 2 | – | 5 | Théo's prohibition is a gate; «Chloé grimpe seule les escaliers» narrates it; a 6-year-old alone up a stone tower |
| 19 | 10 managing-emotions | location | 2 | 5 | 2 | 5 | 5 | the dragon's condition is a stated rule and puts the emotional mechanic on the page; «Dann kommt keines der beiden je nach Hause» |
| 20 | 10 managing-emotions | fantasy | 2 | 5 | 3 | 4 | 5 | «Wer das Ei als Erster … bringt, darf …» is a rule; the fists-and-held-breath beat is narrated |

Means: **a 2.95 · c 4.10 · g 3.50 · h 4.75 · f 4.10**

## Means vs R8 and R9

| axis | R1 | R5 | R6 | R7 | R8 | R9 | **R10** | Δ R9→R10 | Δ R8→R10 |
|---|---|---|---|---|---|---|---|---|---|
| a contract (premise only) | 3.25 | 3.65 | 3.15 | 3.15 | 3.60 | 2.90 | **2.95** | +0.05 | −0.65 |
| c cast present with a role | 3.90 | 4.65 | 4.40 | 4.40 | 4.30 | 3.05 | **4.10** | **+1.05** | −0.20 |
| g peril | 4.30 | 4.65 | 4.30 | 4.30 | 4.30 | 3.80 | **3.50** | −0.30 | **−0.80** |
| h topic is the engine | 3.50 | 4.50 | 4.38 | 4.38 | 4.38 | 4.00 | **4.75** | **+0.75** | **+0.37** |
| f language/format | 3.70 | 3.90 | 3.35 | 3.60 | 3.45 | 2.40 | **4.10** | **+1.70** | **+0.65** |

## Fault classes, count out of 20

| class | R5 | R6 | R7 | R8 | R9 | **R10** |
|---|---|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 9 | 13 | 12 | 12 | 18 | **14** |
| — as a narrated event | 3 | 7 | 8 | 5 | 12 | **11** |
| — as a stated rule or gate | 7 | 6 | 4 | 5 | 6 | **5** |
| — as a trait paired with the obstacle | – | – | – | 2 | 2 | **1** |
| Cast listed rather than present (c≤3) | 3 | 3 | 3 | 5 | 14 | **4** |
| — **a cast member missing from the idea entirely** | – | – | – | 0 | 6 | **2** |
| Output-format drift (f≤3) | 5 | 11 | 7 | 12 | 20 | **8** |
| — a dash holding two clauses | 11 | – | – | 9 | 14 | **8** |
| — a sentence past ~30 words | – | – | – | 5 | 9 | **1** |
| — a `Rollen:`/`ROLES:` header block | 0 | 0 | 0 | 0 | 2 | **2, no longer a fault** |
| Peril over the line (g≤3) | 2 | 3 | 3 | 4 | 6 | **8** |
| Theme present in name only | 3 | 2 | 2 | 3 | 2 | **0** |
| Life-skill topic bolted on (h≤3) | 2 | 1 | 1 | 2 | 2 | **0** |
| Idea with no promise sentence | – | – | – | 1 | 2 | **0** |
| Idea with no cost sentence | – | – | – | 0 | 1 | **0** |
| Both arms tell the same story | 4 | 2 | 2 | 2 | 1 | **1** |

## What the round measured

**Putting the pruned checks back recovered every class the prune cost, except two.** R9 traded a
broad defect regression for whatever the buy criterion bought; R10 keeps the criterion and the new
examples, puts the checks back, and adds the three product fixes — and the blind buy mean is the
best of the series (3.90 against R1's 3.55, `blind-scores-r10.md`).

- **Cast, 14 → 4, and omission 6 → 2.** The class R9 invented (a commissioned character simply
  absent) is nearly gone: only Sofia (#6) and Zara (#12), both on the two largest fantasy casts, and
  both in the *second* arm of their cell. The five-name cell 5 carries all five names with a real
  stake in **both** arms — the class that was worst in R9.
- **Format, 20 → 8, and sentences past 30 words 9 → 1.** The restored sentence budget and the
  restored dash rule each recovered their own class. Dashes are the residual: all 8 format faults
  are a dash, and 5 of the 8 are an appositive dash (`ein Ei — so gross wie Emmas Kopf`) rather than
  two joined clauses, which is the least harmful shape of the fault.
- **Contract did not recover: 18 → 14, mean 2.90 → 2.95, against R8's 3.60.** This is the honest bad
  news. Restoring the checks bought four ideas; narrated middles are still 11 of 20. Ten rounds of
  checklist work have not moved this class below R8's level, and the failure is consistent: the
  model stages the attempt *already under way* (`Mia kriecht hinterher`, `Amir klettert trotzdem`,
  `Chloé grimpe seule`, `Luca klettert auf das Dach`) instead of promising it. The checklist asks
  for the leak to be labelled and cut; it never stops the sentence being written. Notably the blind
  rater does not punish this — several narrated-middle ideas score 4 — so contract and buy are
  pulling apart, and contract is the axis with no buy-side pressure behind it.
- **Peril got worse, 6 → 8 — the worst reading of the series.** Two classes: height (#4 a 5-year-old
  up a ruin wall alone, #8 a 9-year-old on a roof, #18 a 6-year-old alone up a tower, #16 an
  8-year-old on the landing path) and never-coming-back (#9 Jonas left in orbit, #19 «kommt keines
  der beiden je nach Hause»). Check 7 is unchanged across R8, R9 and R10, so this is neither a prune
  casualty nor a restore win: it is the one class ten rounds of prompt work have never moved, and it
  is now measurably drifting the wrong way. **This is the class to fix next, and it is the only axis
  where R10 is worse than R9.**
- **The three structural fixes of `7ad802926` all landed, and the blind read confirms each.** Cell 5
  (not-giving-up) lost the school exhibition and the competition slot for a rescue and a promise
  made to oneself — the `age-band-journey` stake rule working; arm 1 went blind 2 → 4 and both arms
  score h=5. Cell 7 (going-outside) lost the mitten for a duck and a chick that stay out of reach,
  with the grown-up supporting and the doing the child's — h 5 and 5 against R9's 2 and 2, arm 2
  blind 3 → 4. Cell 4 and cell 8 keep the `Rollen:` block and are no longer docked for it: cell 4
  arm 1 went blind 2 → 4 ("warm and urgent under the cast line") and cell 8 arm 1 3 → 4. Topic
  bolted-on and theme-in-name-only are both **0 for the first time in the series**, and h 4.75 is
  the highest reading of any round.
