# Round 11 — defect axes only (a, c, g, h, f)

20 ideas, `claude-sonnet-4-6`, USD 1.0840. Round file: `round-11.json` / `round-11.md`.

**The buy axis is NOT rated here.** A separate blind agent read the 20 ideas cold against R1
(`blind-set-r11.md` → `blind-scores-r11.md` → `analyze-blind.js --rounds=1,11`): **R1 3.55, R11
3.50, diff −0.05; R11 wins 4 arms, loses 4, ties 12, and produced ZERO 5s against R1's three.**
Against R10's 3.90 on the same R1 anchor (3.55 in both reads) this round is **−0.40**. This document
rates only the five defect axes, same rubric, same strictness, same calibration as rounds 1-10.

## What changed for this round

Three targeted fixes, aimed at the class R10 named as the next to fix (peril, worst of the series at
8/20), at felt cost, and at the cold 10-12 fantasy arm:

1. **Peril.** Check 7 in both sibling templates gets the quoting treatment for the two shapes that
   slipped: quote any words that leave a child alone at a height or on an edge, and any words in the
   cost sentence that end on a child not coming home or not returning; replace the place, and replace
   that cost with a loss the child can bear. The historical exemption is verbatim. The RULES peril
   bullet names the two shapes in one sentence. In code, `rescue` is withheld from a cast whose
   youngest is five or under (`SHAPE_PERIL_PRONE`, `server/routes/storyIdeas.js`).
2. **The cold 10-12 fantasy arm.** `prompts/age-band-journey.txt`, the `[[premise]]` stake rule: what
   is at risk is a person or a creature they care about, never a promise made to themselves, a
   recording or a machine's state; the thing out of the ordinary is one they hold or touch, never one
   they operate.
3. **Felt cost, and every named adult does one thing.** RULES: the cost is a loss the child feels,
   never the end of an afternoon, an outing or a visit; every named adult does one thing, and being
   present, waiting, watching or driving is not one. Wording added to the existing cast check (4) and
   to the existing "cost" label in check 6 — no new checks.

## Ratings

| # | cell | world | shape | a | c | g | h | f | note |
|---|------|-------|-------|---|---|---|---|---|------|
| 1 | 1 pirate | location | a lost thing that moves | 5 | 3 | 5 | – | 5 | cleanest contract of the round; but the father «steht am Steuerrad und ruft ihm zu» — the adult-at-the-wheel shape the fix names |
| 2 | 1 pirate | fantasy | a visitor who will not leave | 4 | 2 | 5 | – | 5 | **no adult anywhere** for a 3-year-old; «die ganze Besatzung» is not one |
| 3 | 2 making-friends | location | an unwanted companion | 4 | 4 | 5 | 5 | 5 | speaking to the stranger IS the obstacle; Leo calls the time |
| 4 | 2 making-friends | location | a message to deliver | 4 | 4 | 5 | 5 | 5 | cost «ohne je zu wissen, wie sie heisst» is a felt loss; the boat is in her hands and in the puddle at once |
| 5 | 3 wizard | location | an unwanted companion | 2 | 4 | 5 | – | 5 | «er leuchtet nur, wenn Elias ihn hält» is a stated rule; Oma Ruth only listens from the valley |
| 6 | 3 wizard | fantasy | a promise to keep | 3 | 5 | 5 | – | 5 | «lässt keinen durch, der nicht bezahlen kann» is a gate; all three carry a stake |
| 7 | 4 moon-landing | participant | an unwanted companion | 3 | 5 | **2** | – | 3 | fuel running out in the vehicle AND «Luca kommt nicht zurück zu ihr» — the never-return shape, surviving the new check; one dash |
| 8 | 4 moon-landing | fantasy | a swap or a mix-up | 4 | 4 | 5 | – | 5 | «hört er Armstrongs ersten Schritt durch eine geschlossene Tür» — the best cost of the round |
| 9 | 5 not-giving-up | location | rescue | 3 | 5 | 3 | 5 | 4 | «wirft Finn den Andockhaken immer wieder» narrates the attempt; Jonas still drifts out of reach, but the cost is now a friend, not an abandonment |
| 10 | 5 not-giving-up | fantasy | race against time | 2 | 5 | **2** | 5 | 2 | Finn hangs on the outer hull (height/edge) and «kommt nicht mehr heim vor dem Winter»; two dashes |
| 11 | 6 dinosaur | location | an unwanted companion | 4 | 4 | 5 | – | 5 | cost «muss sie es allein zurücklassen» is felt; Mama Sara and Papa Tom only call her name |
| 12 | 6 dinosaur | fantasy | a swap or a mix-up | 3 | 4 | 5 | – | 3 | «nun glaubt Papa Tom ihr, und Mama Sara nickt, und Ben zuckt mit den Schultern» narrates the middle; one dash |
| 13 | 7 going-outside | location | a lost thing that moves | 5 | 5 | 5 | 5 | 5 | want, obstacle, promise, cost, nothing narrated; the grandmother sets her down and steps back |
| 14 | 7 going-outside | location | a thing that grows | 5 | 5 | 5 | 5 | 5 | as clean as #13 — and almost the same story |
| 15 | 8 wright-brothers | participant | a promise to keep | 3 | 5 | 4 | – | 2 | «Amir legt sich auf das Holzgestell» narrates; Yara's holding promise is a real stake; two dashes |
| 16 | 8 wright-brothers | fantasy | a thing that grows | 2 | 5 | 5 | – | 2 | narrates the twelve-second flight and its outcome; three sentences past 30 words |
| 17 | 9 knight (fr) | location | a swap or a mix-up | 3 | 3 | 5 | – | 3 | «Maman Élodie attend au pied de la tour et compte les minutes» — the adult-does-nothing shape again; one dash |
| 18 | 9 knight (fr) | fantasy | a message to deliver | 2 | 5 | **2** | – | 3 | «L'armure ne laisse passer personne — sauf…» is a rule and a dash; Théo spends the night alone and untended in the tower |
| 19 | 10 managing-emotions | location | a swap or a mix-up | 2 | 5 | 3 | 5 | 3 | the quarrel collapsing the tunnel on them is a narrated middle and puts them underground; one dash |
| 20 | 10 managing-emotions | fantasy | a secret kept | 3 | 5 | 5 | 5 | 5 | «Mila dreht Jonas für immer den Rücken zu» — a loss the child feels |

Means: **a 3.30 · c 4.35 · g 4.30 · h 5.00 · f 4.00**

## Means vs R8, R9, R10

| axis | R1 | R8 | R9 | R10 | **R11** | Δ R10→R11 |
|---|---|---|---|---|---|---|
| a contract (premise only) | 3.25 | 3.60 | 2.90 | 2.95 | **3.30** | **+0.35** |
| c cast present with a role | 3.90 | 4.30 | 3.05 | 4.10 | **4.35** | +0.25 |
| g peril | 4.30 | 4.30 | 3.80 | 3.50 | **4.30** | **+0.80** |
| h topic is the engine | 3.50 | 4.38 | 4.00 | 4.75 | **5.00** | +0.25 |
| f language/format | 3.70 | 3.45 | 2.40 | 4.10 | **4.00** | −0.10 |
| **blind parent buy** | 3.55 | 3.50 | 3.55 | **3.90** | **3.50** | **−0.40** |

## Fault classes, count out of 20

| class | R8 | R9 | R10 | **R11** |
|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 12 | 18 | 14 | **12** |
| — as a narrated event | 5 | 12 | 11 | **9** |
| — as a stated rule or gate | 5 | 6 | 5 | **3** |
| Cast listed rather than present (c≤3) | 5 | 14 | 4 | **3** |
| — a cast member missing entirely | 0 | 6 | 2 | **0** |
| — a named adult who does nothing | – | – | 2 | **2** |
| Output-format drift (f≤3) | 12 | 20 | 8 | **8** |
| — a dash holding two clauses | 9 | 14 | 8 | **7** |
| — a sentence past ~30 words | 5 | 9 | 1 | **3** |
| **Peril over the line (g≤3)** | 4 | 6 | **8** | **5** |
| — a child alone at a height or on an edge | – | – | 4 | **1** |
| — a cost that ends on never coming home | – | – | 2 | **2** |
| Life-skill topic bolted on (h≤3) | 2 | 2 | 0 | **0** |
| Theme in name only | 3 | 2 | 0 | **0** |
| Both arms tell the same story | 2 | 1 | 1 | **1** |

## What the round measured

- **Peril 8 → 5, and the height class 4 → 1.** The quoting treatment did to peril what quoting did to
  cast and topic in rounds 4-5: the shape it can name, it removes. Only #10 still puts a child on an
  edge.
- **The never-coming-home class did NOT move (2 → 2).** #7 and #10 both end on a child not returning,
  and both are arms where a fuel or battery countdown makes that cost feel inevitable. Check 7 asks
  for it to be replaced; on those two the model quoted the peril and then wrote the same cost anyway.
- **The felt-cost rule landed.** Not one cost in twenty is the end of an afternoon, an outing or a
  visit. #14 is the same duck-shaped idea as R10's blind 3 and its cost is a loss.
- **The adult-does-one-thing rule did NOT land (2 of 20).** #1's father stands at the wheel and
  calls; #17's mother waits at the foot of the tower and counts the minutes. Both are exactly the
  shapes the rule names, and both survived a check that asks for the one thing to be quoted —
  calling and counting are quotable, so the check accepts them. The fault is the rule's definition of
  "one thing", not where it sits.
- **Contract recovered to 3.30, the best since R8** — and not a class this round targeted.
- **The 10-12 fantasy arm is half-fixed, and the cell got WORSE on the buy axis.** #10 no longer
  turns on a joystick: the strange thing is an antenna arm Finn reaches for by hand, and the stake is
  a crew that cannot get home rather than a recording erasing itself. But the setup still opens on
  what Finn «hat sich vorgenommen … nicht auf Befehl», the self-undertaking the band rule forbids as
  a stake, and the blind rater scored BOTH cell-5 arms 2 ("cold engineering"; "procedural, nobody to
  care about") — the location arm having been a 4 in R10. The band rule reached the object and the
  risk; it did not reach the register, and what the rater is reading is the space guide's own
  machinery (Sektor, Akku, Panel, Koordinaten).
- **The headline: every defect axis improved or held, and the buy mean fell 3.90 → 3.50 with no 5s at
  all.** This is the third measurement in the series where defect compliance and the buy axis move in
  opposite directions. The R11 wins are the two historical cells and the emotion cell; the losses are
  cells 1, 3 and 4 fantasy — three arms where R10 scored 5 or 4 on a bigger, less-hedged premise. The
  likeliest reading is that a peril rule stated as two forbidden shapes trims the TOP of the
  distribution as well as the bottom: ideas that would have ended on a real, frightening loss now end
  on a bearable one, and a bearable loss is not what earns a 5.
