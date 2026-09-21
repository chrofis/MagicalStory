# Round 13 — defect axes only (a, c, g, h, f)

20 ideas, `claude-sonnet-4-6`, USD 1.0045. Round file: `round-13.json` / `round-13.md`.

**The buy axis is NOT rated here.** A separate blind agent read the 20 ideas cold against R1
(`blind-set-r13.md` → `blind-scores-r13.md` → `analyze-blind.js --rounds=1,13`): **R1 3.55, R13
3.50, diff −0.05; R13 wins 5 arms, loses 7, ties 8, zero 5s against R1's three.** That is R11's
reading exactly (3.50), **+0.20 on R12**, and still **−0.40 on R10's 3.90**. This document rates
only the five defect axes, same rubric and strictness as rounds 1-12.

## What changed for this round

Subtraction, both sibling templates in step (`89dc2f1c2`). R12's blind read fell to 3.30 and six of
its losing reasons said the same thing — «five names tangled around a capsule», «three wants
competing», «a riddle, not a picture»: **too populated to follow on a back cover.** The world seed
(a centre and a turn, picked in code) already hands the premise its picturable thing and its change,
which is precisely what the HOOK rule and the PROMISE slot were asking the model to invent a second
time, at a cost of two sentences.

Removed from both templates: the `THE PROMISE` slot-list entry; the "one thing out of the ordinary"
RULES bullet; the "one sentence is an event this book contains" RULES bullet; the Hook and Promise
quoting checks (and the renumbering that follows); the `"hook"` and `"promise"` CUT labels — the
labels are now setup / turn / event / rule / cost, with setup, turn and cost kept. The turn now
stands between the obstacle and the cost. **Sentence budget four-to-six → three-to-five.** The three
examples lose their promise sentence and run five sentences each.

Kept, unchanged and verified in the built prompt (`--dry-run --cells=1,3`): the contract (no middle,
no ending, the CUT step), the turn slot, the child's own want and the child acting, the positive
adult rule, cast presence, peril including the historical-danger exemption, the language block, the
buy criterion (exactly twice per built prompt), the shape, and the world seed.

## Ratings

| # | cell | world | a | c | g | h | f | note |
|---|------|-------|---|---|---|---|---|------|
| 1 | 1 pirate | location | 5 | 4 | **2** | – | 5 | the tightest four-beat premise of the series; a three-year-old reaching into rising water for a net |
| 2 | 1 pirate | fantasy | 5 | 4 | 4 | – | **3** | «Das Schiff legt ab.» is a three-word sentence doing real work; one dash in the cost |
| 3 | 2 making-friends | location | 4 | 4 | 5 | 5 | **3** | the first tower breaking into hers is the whole book in one clause; one dash |
| 4 | 2 making-friends | location | 4 | **3** | 4 | **3** | 5 | Leo is a scarf owner; the friendship is a returned object, not a friendship |
| 5 | 3 wizard | location | **3** | 5 | 5 | – | **3** | «weiss, wie man Geister heimschickt» and «was einst versprochen wurde» — the solution and the test, both named; two dashes |
| 6 | 3 wizard | fantasy | **3** | 5 | 5 | – | **2** | the book that stops the creature is named; two dashes and a stray paragraph break inside the idea |
| 7 | 4 moon-landing | participant | 4 | 4 | **3** | – | 4 | «kommt niemand nach Hause» is exactly the forbidden cost shape, historical exemption or not |
| 8 | 4 moon-landing | fantasy | 4 | 5 | 5 | – | **3** | «Auf der Erde läuft dem Raumschiff der Treibstoff davon» is incoherent; two dashes |
| 9 | 5 not-giving-up | location | 4 | **1** | 5 | 4 | 4 | **Jonas, Lina and Herr Keller are absent from a cast of five**; the turn states the lesson instead of showing it |
| 10 | 5 not-giving-up | fantasy | **3** | 5 | 5 | 5 | **3** | «Versuch für Versuch» narrates the middle — but it is also the topic working; two dashes |
| 11 | 6 dinosaur | location | 5 | **1** | **2** | – | 5 | **Opa Hans and Zara are absent from a cast of six**; a four-year-old sealed in the dark when the crevice closes |
| 12 | 6 dinosaur | fantasy | 5 | **3** | 5 | – | **2** | all six named, four of them as a list; Mama Sara and Papa Tom wait and call; a 45-word sentence |
| 13 | 7 going-outside | location | 4 | 4 | 5 | 4 | **2** | no adult for a one-year-old; «weicht jeden Mal» is ungrammatical; a 35-word cost with a dash |
| 14 | 7 going-outside | location | **3** | **3** | 5 | 4 | **3** | **no cost sentence at all** — the last line is an image; an invented grandmother who only holds her |
| 15 | 8 wright-brothers | participant | 4 | 5 | 5 | – | **3** | the strongest historical framing of the series; two sentences past 30 words |
| 16 | 8 wright-brothers | fantasy | 5 | 5 | 4 | – | 5 | clean on every axis; Yara in the path of the Flyer is frightening, not fatal |
| 17 | 9 knight (fr) | location | 5 | 4 | 5 | – | **2** | the wrong banner given to the wrong child is a perfect turn; a 40-word sentence and a dash; Élodie only waits |
| 18 | 9 knight (fr) | fantasy | **3** | 4 | 5 | – | **2** | **six sentences** (over budget), an invented Madeleine, and «la clé qui ouvre le chemin» names what decides it |
| 19 | 10 managing-emotions | location | 4 | 5 | 5 | 5 | **3** | the dragon taking both children for one person is the emotion lesson made visible; two dashes |
| 20 | 10 managing-emotions | fantasy | 5 | 4 | 4 | 5 | **3** | opens on an invented «Finn» before either real character; one dash |

Means: **a 4.10 · c 3.90 · g 4.40 · h 4.38 · f 3.25**

## Means vs R8-R12

| axis | R1 | R8 | R9 | R10 | R11 | R12 | **R13** | Δ R12→R13 |
|---|---|---|---|---|---|---|---|---|
| a contract (premise only) | 3.25 | 3.60 | 2.90 | 2.95 | 3.30 | 3.85 | **4.10** | **+0.25** |
| c cast present with a role | 3.90 | 4.30 | 3.05 | 4.10 | 4.35 | 4.40 | **3.90** | **−0.50** |
| g peril | 4.30 | 4.30 | 3.80 | 3.50 | 4.30 | 4.35 | **4.40** | +0.05 |
| h topic is the engine | 3.50 | 4.38 | 4.00 | 4.75 | 5.00 | 4.75 | **4.38** | −0.37 |
| f language/format | 3.70 | 3.45 | 2.40 | 4.10 | 4.00 | 4.30 | **3.25** | **−1.05** |
| **blind parent buy** | 3.55 | 3.50 | 3.55 | **3.90** | 3.50 | 3.30 | **3.50** | **+0.20** |

## Fault classes, count out of 20

| class | R9 | R10 | R11 | R12 | **R13** |
|---|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 18 | 14 | 12 | 5 | **4** |
| — as a narrated event | 12 | 11 | 9 | 4 | **1** |
| — as a stated rule, gate or deciding object | 6 | 5 | 3 | 0 | **3** |
| Cast listed rather than present (c≤3) | 14 | 4 | 3 | 4 | **5** |
| — a cast member missing entirely | 6 | 2 | 0 | 0 | **2** |
| — a named adult who does nothing | – | 2 | 2 | 1 | **3** |
| — no adult at all for a cast of one under five | – | – | 1 | 4 | **3** |
| — a character invented who is not in the cast | – | – | – | 0 | **3** |
| Output-format drift (f≤3) | 20 | 8 | 8 | 5 | **14** |
| — a dash holding two clauses | 14 | 8 | 7 | 8 | **11** |
| — a sentence past ~30 words | 9 | 1 | 3 | 5 | **5** |
| — over the sentence budget | – | – | – | 0 | **1** |
| — a stray paragraph break inside the idea | – | – | – | 0 | **1** |
| — a cost slot missing outright | – | – | – | 0 | **1** |
| **Peril over the line (g≤3)** | 6 | 8 | 5 | 5 | **3** |
| — a child alone at a height or on an edge | – | 4 | 1 | 4 | **0** |
| — deep or rising water | – | – | – | 0 | **1** |
| — dark underground | – | – | – | 0 | **1** |
| — a cost that ends on never coming home | – | 2 | 2 | 0 | **1** |

## Length, R10 / R12 / R13

Computed from the round jsons, the leading `Rollen:` block stripped before counting:

| | mean sentences | sentence range | mean words |
|---|---|---|---|
| R10 | 5.35 | 4-6 | 99.4 |
| R12 | 6.00 | 5-7 | 114.0 |
| **R13** | **4.45** | **4-6** | **89.6** |

**The subtraction did what it was asked to do on length: −1.55 sentences and −24.4 words against
R12, a 21% shorter back cover, and the shortest of the series.** One arm (#18, the French fantasy
knight) still ran six sentences.

## Reading

**Three axes say the subtraction worked.**
- **a 3.85 → 4.10, the best of thirteen rounds.** Narrated middles collapse 4 → 1. Removing the
  promise slot removed the sentence that most often carried the middle: an "event this book
  contains", written in the story's voice, is a narrated event by construction — the model was being
  *asked* for one, and then marked down for producing it.
- **Peril 5 → 3, and the height class 4 → 0**, the class the owner named. The seed's turns still
  supply the urgent place, but with two fewer sentences there is no room to walk a child out onto it.
- **Length**: the shortest, tightest ideas of the series. #1 and #16 are four- and five-sentence
  premises with nothing in them that is not load-bearing.

**Two axes got worse, and neither is about the removed slots.**
- **f 4.30 → 3.25 is the worst format reading since R9**, and 11 of the 14 faults are ONE fault: a
  dash holding two clauses. That rule is untouched and check 2 still asks for it. What changed is
  the pressure: told to say the same things in three to five sentences instead of four to six, the
  model welds two clauses together with a dash rather than drop one. **This is the measured cost of
  the budget cut, not of the slot removal** — and it is the cheapest thing on this page to fix,
  because the rule already exists and is simply being outvoted by the budget.
- **c 4.40 → 3.90, driven by a class that did not exist before: three ideas INVENT a character**
  (a grandmother, Madeleine, a dragon called Finn — #14, #18, #20) and two drop real ones (#9 loses
  three of a cast of five, #11 loses two of six). Both halves are the same pressure as the dashes:
  with fewer sentences the cast has fewer places to stand, so a big cast gets trimmed and a small one
  gets a companion invented for it. **The cast rule is unchanged and it is now the constraint under
  most strain** — and a missing uploaded family member is a hard fault on the buy axis too.
- **h 4.75 → 4.38** is one arm (#4), where the friendship became a returned scarf.

**The buy axis recovers 0.20 and stops there.** R13 3.50 against the same R1 anchor that read 3.55
here, 3.50 in R11's read and 3.50 in R12's — well inside the 3.45-3.55 band six independent reads
have given it. The blind rater's losing reasons are no longer about population: they are about the
want («the want reverses on itself», «the want is adult-shaped», «who is lost and who is searching
never resolves», «an adult's veto; nobody to care about»). **The R12 crowding complaint is gone from
the reasons entirely — and the score did not follow it back up to R10's 3.90.** Zero 5s for the
third round running; R10 remains the only version that produced three.

The standing reading from R11 and R12 survives this round: **no rule-list change has ever moved the
buy axis, and subtraction has now been tried as well as addition.** Cell 5 is again the floor (2 and
4, «Herr Keller will die Leitung sperren — nobody to care about»), for the fourth straight round and
the same reason: the space guide's own machinery, which no premise rule touches.
