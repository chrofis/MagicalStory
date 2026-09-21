# Round 18 — defect axes (vs R10 and R15)

Twenty ideas per round, same ten cells, same model (`claude-sonnet-4-6`).
Mechanical counts are from `round-N.json` (script: sentence split on `[.!?]`,
cast-name match on the full name or its last token, `Rollen:` block stripped
before counting sentences). Peril and narrated middles are read, not scripted.

## Mechanical

| axis | R10 | R15 | R18 |
|---|---|---|---|
| ideas | 20 | 20 | 20 |
| a cast member missing from the text | 2 | 1 | **0** |
| more than six sentences | 0 | 2 | **0** |
| a sentence past 30 words | 4 | 1 | **1** |
| leading `Rollen:` block (not a fault) | 2 | 2 | 2 |
| mean length, characters | 606 | 572 | **543** |

Missing cast: R10 `c3/i2` (Sofia), `c6/i2` (Zara); R15 `c6/i1` (Ben); R18 none.
Over-long sentence: R18 `c5/i1` at 37 words — the same cell that carried the
R10 38-word sentence, so the advanced/5-character cell is where length still
escapes. The two `Rollen:` blocks are both historical cells (4 and 8) in every
round; per the owner they are not scored as a fault.

## Peril (the youngest main character at a height, in deep or rising water, in
the dark underground, or in a vehicle with a supply running out)

| round | count / 20 | where |
|---|---|---|
| R10 | 10 | c2/i2 wall ledge · c4/i1 Eagle, fuel running out · c4/i2 child climbs onto the roof · c5/i1 child sealed in a blocked docking module · c5/i2 rover at a crater rim · c6/i1 cave system · c8/i1 climbs the airframe in gusts · c9/i2 climbs a tower alone · c10/i1 taken into the depths of the mountain, cost reads as never coming home · c10/i2 cliff ledge |
| R15 | 5 | c1/i1 a three-year-old climbs to a deck alone · c4/i1 Eagle, fuel running out · c5/i1 child locked in an escape capsule · c5/i2 hand-over-hand through a corridor beside a pressure-free exterior · c8/i1 lies in the airframe and pulls the lever |
| R18 | **4** | c4/i1 Eagle, fuel running out (the event's own danger — kept by rule) · c5/i2 pressed against a locked hatch as the module leaves its shaft · c8/i1 crawls into the machine as the wind turns · **c10/i1 a dragon lifts a child into the air, and the cost sentence is "der beiden Kinder erster Tag bleibt ihr letzter"** |

R18 halves R10 and stays under R15, and three of its four are the historical
event's own danger or a mild in-vehicle moment. The one to look at is `c10/i1`:
the lift into the air is peril, and the cost line is the closest any of the sixty
texts comes to implying a child does not come back. That is the same failure as
R10 `c10/i1` ("Dann kommt keines der beiden je nach Hause") on the same cell —
the dragon/managing-emotions cell produces it in two rounds out of three.

## Narrated middles (a rule, a test, or the thing that decides the outcome)

| round | count / 20 | where |
|---|---|---|
| R10 | 5 | c2/i1 "gibt nichts zurück, ohne etwas dafür zu bekommen" · c3/i2 the raven "gibt nichts heraus, bevor er nicht etwas dafür bekommt" · c5/i1 "muss das Manöver … jetzt genau einmal richtig machen" (names the test outright) · c10/i1 "lässt keines der beiden gehen, solange sie sich gegenseitig anschreien" · c10/i2 "Wer das Ei als Erster zum Gipfelnest bringt, darf …" |
| R15 | 6 | c1/i1 the gull moves the chest "jedes Mal, wenn Noah näher ist" · c2/i2 "wer darin sitzt, gehört dazu" · c3/i2 "Wer die Brücke nicht überquert hat …, wartet ein Jahr" PLUS "sie ist die Einzige, die den Wächter schon einmal zum Lachen gebracht hat" (a trait paired with its obstacle) · c5/i2 "Die Kapsel dockt nur an, wenn Helios stillsteht." · c10/i1 "er weicht zurück, sobald jemand laut wird" |
| R18 | **4** | c3/i1 Oma Ruth "kennt das einzige Mittel" (names what decides it) · c5/i1 "wenn Finn und Alina nicht herausfinden wie man es erreicht" · c10/i1 "Wenn Jonas schweigt, fliegt Vareth mit Mila davon" · c10/i2 "Wenn Jonas schweigt, reist Funke ab" |

The class changed shape rather than only shrinking. R10 and R15 stated rules in
their own sentence ("X only happens when Y"), which check 4 cuts. R18's four all
hide inside the COST sentence, as a condition on the main character's own choice
("if Jonas stays silent, …"). Check 4 labels that sentence "cost" and keeps it,
so the guard does not see it. Both instances are the managing-emotions cell,
where the topic itself is an internal choice.

## New in R18

- **A landmark dragged into a world it cannot be in.** `c5/i1` has Finn on an
  orbital station while "Jonas und Lina stehen unten an der Ruine Stein". The
  round-17 location-arm frame says the real landmark is where it starts and
  where it comes back to; on a space theme the model satisfied that by putting
  half the cast at the landmark and half in orbit in the same paragraph. Two
  cells with an off-Earth or off-era theme are exposed to this (5 and, less
  badly, 4).
- **A want handed to a stranger.** `c1/i1`: the parrot is wanted by "ein Bub,
  der dort oben schon seit dem Morgen allein wartet" — an unnamed boy — and
  Noah's part is to fetch it for him. Check 8 asks whether the want is the main
  character's own; an unnamed third party's want passed it.
- Not a defect, but worth recording: every R18 text names its whole cast, the
  first round of the three where that is true.

## Counts at a glance

| | R10 | R15 | R18 |
|---|---|---|---|
| peril | 10 | 5 | **4** |
| narrated middles | 5 | 6 | **4** |
| missing cast | 2 | 1 | **0** |
| over-long sentences | 4 | 1 | **1** |
| over six sentences | 0 | 2 | **0** |
