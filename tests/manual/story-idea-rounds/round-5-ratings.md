# Round 5 — ratings (after the three round-4 fixes) — FINAL ROUND

20 ideas, `claude-sonnet-4-6`, USD 0.7176. Rated by reading, no judge call.
Same rubric and same strictness as rounds 1-4, recalibrated against the R1-R4 evidence lines:
(a) contract — premise only; (b) concreteness of want/obstacle/cost; (c) cast present with a role;
(d) age fit youngest+oldest; (e) world/theme fit, no leak; (f) language + format; (g) peril line;
(h) life-skill topic is the engine (n/a elsewhere); (i) would a Swiss parent buy this.

**Rubric note (important for the f column):** round 5 added a *new* format rule (no sentence past
~30 words; a dash holding two clauses is two sentences). Scoring f against the new rule would have
changed the rubric mid-series and made the R1-R5 f column incomparable. **f is therefore scored on
the R1-R4 criteria only** (adjectives, sentence count, clearly over-length sentences ~35 w+,
language, typos). Compliance with the new dash rule is counted separately below and scored nowhere.

Applied before this round:

- **Both templates** (`generate-story-idea-single.txt`, `generate-story-ideas.txt`, registry set
  `story-idea-templates`):
  - check 6 gained a third label: `setup` / `event` / **`rule`**, with `rule` defined as "what only
    happens if, what opens only when, what resets, or what someone will not do — the condition a
    reader would use to work out the ending". Every `rule` sentence is cut; the closing cost
    sentence is explicitly exempted ("that is not a rule, and it is kept") so the cut step cannot
    eat it.
  - check 7 (peril) now covers **anyone in the idea, or the craft they travel in**, not only the
    youngest character — cell 4's lander scored g=1 in R4 and g≤3 in all four rounds.
  - RULES + format check: "No sentence runs past about 30 words. A sentence that needs a dash to
    hold two clauses together is two sentences."
- **`server/routes/storyIdeas.js`** — `buildVariantInstructions(world1, world2, seedInput)`: when
  both arms resolve to `location`, the second arm's constraint is now **computed in JS and stated
  as values**, not asked for as a difference. One of four place classes and one of six event
  classes are picked and written into the instruction ("These are requirements, not choices: this
  story plays …; what makes it hard is …"). The pick is **deterministic** from the request's own
  inputs (cast names+ages, topic, theme, language) rather than random per call — the rating harness
  replays the same ten cells every round, so a random pick would have made the cells stop being
  fixed; different wizard inputs still land on different classes. Serialising the two calls stays
  rejected (happy-path latency). Pinned by `tests/unit/idea-variant-instructions.test.ts` (6 tests).

| # | cell | world | a | b | c | d | e | f | g | h | i |
|---|------|-------|---|---|---|---|---|---|---|---|---|
| 1 | 1 pirate, Noah 3 | location | 5 | 4 | 5 | 4 | 5 | 4 | 5 | – | 4 |
| 2 | 1 pirate | fantasy | 3 | 3 | 5 | 3 | 5 | 5 | 5 | – | 3 |
| 3 | 2 making-friends | location | 4 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 4 |
| 4 | 2 making-friends | location | 4 | 3 | 5 | 5 | 5 | 5 | 5 | 5 | 2 |
| 5 | 3 wizard | location | 2 | 5 | 5 | 5 | 5 | 4 | 5 | – | 3 |
| 6 | 3 wizard | fantasy | 5 | 5 | 5 | 5 | 5 | 4 | 5 | – | 4 |
| 7 | 4 moon-landing | participant | 4 | 5 | 5 | 5 | 4 | 4 | 5 | – | 4 |
| 8 | 4 moon-landing | observer | 3 | 4 | 5 | 5 | 5 | 2 | 5 | – | 3 |
| 9 | 5 not-giving-up | location | 2 | 5 | 5 | 5 | 3 | 4 | 5 | 5 | 3 |
| 10 | 5 not-giving-up | fantasy | 3 | 5 | 5 | 5 | 5 | 4 | 4 | 5 | 3 |
| 11 | 6 dinosaur | location | 4 | 3 | 4 | 5 | 4 | 3 | 4 | – | 4 |
| 12 | 6 dinosaur | fantasy | 3 | 5 | 3 | 5 | 4 | 3 | 5 | – | 3 |
| 13 | 7 going-outside | location | 3 | 2 | 3 | 4 | 3 | 5 | 5 | 3 | 2 |
| 14 | 7 going-outside | location | 4 | 3 | 3 | 4 | 3 | 4 | 5 | 3 | 2 |
| 15 | 8 wright-brothers | participant | 5 | 4 | 5 | 4 | 5 | 3 | 4 | – | 4 |
| 16 | 8 wright-brothers | observer | 5 | 5 | 5 | 5 | 5 | 4 | 5 | – | 4 |
| 17 | 9 knight (fr) | location | 2 | 3 | 5 | 4 | 5 | 3 | 5 | – | 3 |
| 18 | 9 knight (fr) | fantasy | 5 | 5 | 5 | 4 | 5 | 4 | 3 | – | 4 |
| 19 | 10 managing-emotions | location | 4 | 5 | 5 | 5 | 5 | 4 | 3 | 5 | 4 |
| 20 | 10 managing-emotions | fantasy | 3 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 |

Means: a 3.65 · b 4.15 · c 4.65 · d 4.60 · e 4.55 · f 3.90 · g 4.65 · h 4.50 · i 3.35

| axis | R1 | R2 | R3 | R4 | R5 | Δ R4→R5 |
|---|---|---|---|---|---|---|
| a contract | 3.25 | 3.10 | 3.25 | 3.10 | **3.65** | **+0.55** |
| b concreteness | 3.80 | 4.25 | 4.20 | 4.25 | 4.15 | −0.10 |
| c cast present | 3.90 | 4.40 | 4.40 | 4.50 | **4.65** | +0.15 |
| d age fit | 3.90 | 4.00 | 4.35 | 4.50 | **4.60** | +0.10 |
| e world/theme | 4.30 | 4.45 | 4.45 | 4.70 | 4.55 | −0.15 |
| f language/format | 3.70 | 4.10 | 4.20 | 4.00 | 3.90 | −0.10 |
| g peril | 4.30 | 4.15 | 4.55 | 4.70 | 4.65 | −0.05 |
| h topic is the engine | 3.50 | 4.00 | 4.00 | 4.38 | **4.50** | +0.12 |
| i would buy | 3.25 | 3.25 | 3.15 | 3.30 | **3.35** | +0.05 |

a is the highest it has been in five rounds, and by the largest single-round margin in the series.

## Evidence for every score ≤3

- **#2 a=3** a rule survived the new label: «der Papagei will die Karte nicht einfach hergeben» is
  "what someone will not do" in the check's own words.
- **#2 b=3** the cost is a tautology: «Wer ohne Schatz zurückkehrt, kehrt mit leeren Händen heim».
- **#2 d=3** the three-year-old is again the one entrusted with the map, fifth round running.
- **#2 i=3** same toddler-carries-it problem.
- **#4 b=3** the cost is a metaphor: «fährt sie nach Hause, als wäre sie nie dort gewesen».
- **#4 i=2** the weaker half of a pair that is still one idea (see Regressions).
- **#5 a=2** the gate, verbatim: «hat den Stab versteckt und gibt ihn nur zurück, wenn jemand
  beweist, dass er in die richtigen Hände gehört». Both a condition and a test to pass.
- **#5 i=3** the premise explains its own machinery.
- **#8 a=3** «Bello ist für das Radio verantwortlich, und Bello lässt sich nichts befehlen» — a rule.
- **#8 f=2** sentence 1 is ~38 words and sentence 3 is ~55, both with dashes inside.
- **#8 i=3** reads as a plot summary at that length.
- **#9 a=2** the reset rule and the narrated middle together: «Das Programm setzt sich nach jedem
  Testlauf auf die Ausgangswerte zurück, und das Team scheitert jedes Mal kurz vor dem letzten
  Schritt».
- **#9 e=3** the space theme resolves to a school computer simulation at a Swiss ruin — the same
  finding as R4.
- **#9 i=3** a school contest sold as a space story.
- **#10 a=3** a gate: «hält einen Teilschritt bereit, der nur zählt, wenn alle anderen zuerst
  stimmen».
- **#10 i=3** the premise is machinery again, though milder than R4's thirty-step sequence.
- **#11 b=3** the last sentence states no cost at all: «Ben hat den einzigen Schlüssel zum Kellertor
  versetzt, und die Zeit läuft ab» — a stakes clock, not a loss.
- **#11 f=3** sentence 2 is ~40 words with two dashes inside it.
- **#12 a=3** the gate: «nur wer am Ende der Tagesführung beim Wärter bleibt, darf nachfragen».
- **#12 c=3** the cast is a list again: «steht mit Zara, Ben, Mama Sara, Papa Tom und Opa Hans in
  einem Dinosaurierpark» — only Emma and Opa Hans have a stake.
- **#12 f=3** sentences 1 and 2 are ~35 and ~30 words.
- **#12 i=3** four of the six are scenery.
- **#13 a=3** the mitten event is still the whole text, and the closing sentence states no cost:
  «Die Grossmutter sucht, aber der Fäustling ist weg, und Lena kann nicht warten».
- **#13 b=2** the want is never stated and there is no loss.
- **#13 c=3 / #14 c=3** a responsible adult is present in both («ihre Grossmutter», «ihr Vater») but
  neither is *named*, against the RULES line, and the one-year-old is still acted upon —
  «trägt ihre Grossmutter sie … hinaus», «fährt sie im Kinderwagen nach draussen».
- **#13 e=3 / #14 e=3** the farm theme is still an address: «wohnt auf einem Bauernhof bei Baden».
- **#13 h=3 / #14 h=3** going outside is the occasion; the mitten is the obstacle.
- **#13 i=2 / #14 i=2** the fifth round in which both arms tell the mitten story.
- **#14 b=3** the want is unstated, though this arm does state a cost.
- **#15 f=3** sentence 3 is ~38 words with a dash pair inside it.
- **#17 a=2** the rule and the test in one clause: «il refuse de le lui confier tant qu'elle n'aura
  pas accompli une vraie mission de chevalière».
- **#17 b=3** the errand is the unnamed something the concreteness rule forbids by name:
  «pour trouver ce qu'on lui a demandé de rapporter».
- **#17 f=3** sentences 1 and 3 run ~33 and ~38 words.
- **#17 i=3** the premise is a brother's condition rather than a want.
- **#18 g=3** a six-year-old sent after a banner «dans les tours les plus hautes du donjon» — the
  height clause the widened check 7 is supposed to reach, and it shipped.
- **#19 g=3** the cost is a creature's death in plain words: «schläft es für immer ein».
- **#20 a=3** the middle is narrated: «Jonas und Mila geraten so heftig in Streit über das Wie, dass
  der Weg stehenbleibt».

## Did the three targeted classes move?

| targeted class | R1 | R2 | R3 | R4 | R5 | verdict |
|---|---|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 10 | 11 | 11 | 15 | **9** | **best of the series** |
| — of which a stated rule/gate | – | – | – | 9 | **7** | down, not gone |
| — of which a narrated event | 10 | 11 | 11 | 6 | **3** | down again |
| Both arms tell the same story | 4 | 4 | 4 | 4 | **4** | flat, five rounds |
| Cast listed rather than present (c≤3) | 6 | 3 | 4 | 3 | **3** | holds at the best |
| Output format (f≤3) | 7 | 5 | 5 | 5 | **5** | flat |
| Peril over the line (g≤3) | 3 | 4 | 2 | 2 | **2** | holds |
| Theme present in name only | 3 | 3 | 3 | 3 | **3** | flat |
| Life-skill topic bolted on (h≤3) | 5 | 3 | 3 | 2 | **2** | holds |
| English `ROLES:` label | 2 | 2 | 0 | 0 | **0** | closed since R3 |

### The `rule` label worked, partially

a≤3 fell 15 → 9, the lowest count in five rounds, and a rose 3.10 → 3.65. Three of R4's named
rule-leaks have no counterpart in R5: cell 3's fantasy arm is a=5 (R4: «der Turm öffnet sich nur
für jemanden, dem …» — gone; the new text states the forest's price as a *force*, which the
contract's own Example 2 allows), cell 10's location arm is a=4 (R4's «seine Flügel öffnen sich
nur, wenn die Luft ruhig ist» — gone, three rounds running before this), and cell 10's fantasy arm
lost «Vorn hat eine Regel: Wer schreit … beginnt von vorn».

Seven rule-leaks remain, and they split into two kinds. Four are **unambiguously the named class**
and the check simply missed them (#5, #10, #12, #17 — "gives it back only if", "only counts when",
"only whoever stays may ask", "refuses until"). Three are the **"what someone will not do"** clause
(#2, #4, #8), which the definition names but which reads to the model as characterisation rather
than as a condition. Nothing in the residual is a *new* failure shape; it is the same shape at
lower frequency. The cut step is still honest — no CUT-nominated sentence appears in any [FINAL].

### Peril: the four-round finding closed

**Cell 4's lander is gone.** R1-R4 all put a nine- and a six-year-old in the Apollo lander
(R4: «wer nicht landet, kehrt nicht zurück»); R5's participant arm keeps them in Houston with a
failed television picture, g=5 and d=5 where R4 was g=1 and d=3. Widening check 7 from "the
youngest character" to "anyone in the idea, or the craft they travel in" is the only change that
touched it, and it is the single largest per-idea swing in the series (#7: a+0, b+0, d+2, **g+4**,
i+2). Cell 8's participant arm also softened, g 3 → 4.

The two remaining g=3s are new instances of the same rule at the edges the check does not list:
a tower's height (#18) and a creature's death (#19).

## Regressions

- **Both arms tell the same story: still 4 (#3/#4, #13/#14).** The computed values *were* stated —
  cell 7's second arm was told, in the prompt actually sent (verified by `--dry-run`), «this story
  plays outdoors, in the open air, away from any building; what makes it hard is a time someone
  else has set, which cannot be moved» — and the model still produced the mitten, outdoors, for the
  fifth round. Cell 2's second arm is the Museum Langmatt park again, with the same unknown
  children and the same Leo-minding frame. **Verdict: stating the axis as a value did not defeat
  the duplication either.** What the values did change is the *responsible adult* (grandmother vs
  father in cell 7 — the one axis that also took in R4) and nothing else. Three shapes of the axis
  instruction have now been tried across R3, R4 and R5 (adjective, named axes, computed values) and
  all three land on the same count of 4. The remaining lever is the one rejected on latency:
  serialising the calls so arm 2 can see arm 1's [FINAL].
- **f 4.00 → 3.90, and the new sentence-length rule did not take.** Counted separately and scored
  nowhere: **11 of 20 ideas contain at least one dash holding two clauses together**, which the new
  RULES line calls two sentences (#1, #2, #6 ×2, #8 ×2, #9, #10, #11 ×2, #15, #17, #19). Over-length
  sentences are down — R4 had five ideas with ~55-word sentences, R5 has one (#8) — but the dash
  habit is untouched, and #8 is the worst single format score of the series.
- **b 4.25 → 4.15 and e 4.70 → 4.55**, both inside the round-to-round noise of the series
  (b has moved ±0.05-0.10 in every round since R2). e's dip is two dinosaur-park ideas (#11, #12)
  where the theme is statues rather than dinosaurs.
- **#7's role card contradicts its own premise** (Luca is cast as Neil Armstrong in the `Rollen:`
  block, then spends the premise in front of a television in Houston). Scored as e=4. This is new
  in R5 and is a side effect of removing the lander: the roles block was not rewritten with it.

## Fault classes, ranked (frequency × severity)

| rank | class | n/20 | severity | R5 | R4 | R3 | R2 | R1 |
|---|---|---|---|---|---|---|---|---|
| 1 | Middle leaked — stated rule or gate | 7 | 3 | 21 | 27 | – | – | – |
| 2 | Both arms tell the same story | 4 | 3 | 12 | 12 | 12 | 12 | 12 |
| 3 | Output-format drift (dashes, over-length) | 5 | 2 | 10 | 10 | 10 | 10 | 14 |
| 4 | Middle leaked — narrated event | 3 | 3 | 9 | 18 | 33 | 33 | 30 |
| 5 | Cast listed rather than present | 3 | 2 | 6 | 6 | 8 | 6 | 12 |
| 5 | Peril over the line | 2 | 3 | 6 | 6 | 6 | 12 | 9 |
| 5 | Theme present in name only | 3 | 2 | 6 | 6 | 6 | 6 | 6 |
| 8 | Life-skill topic bolted on | 2 | 2 | 4 | 4 | 6 | 6 | 15 |
| 9 | English `ROLES:` label | 0 | – | 0 | 0 | 0 | 4 | 4 |

## What is left open after five rounds

Nothing was applied after this round; the series ends here.

1. **Both arms tell the same story (4/20, flat in all five rounds).** Three prompt-side shapes have
   failed. The only untried lever is serialising the two calls and passing arm 1's [FINAL] into
   arm 2 — rejected three times on happy-path latency (per-arm wall clock 18.6-48.4 s in R5, median
   ~30 s; serialising doubles the screen the user waits at). Owner's call, not a bug to fix blind.
2. **Rule/gate leak (7/20).** Down from 9 and still the top class. Four of the seven match the
   check's definition word for word, so the next prompt lever would be to make check 6 quote each
   sentence it labels rather than only number it.
3. **The dash habit (11/20).** The rule was added this round and was ignored; it has had one round.
4. **Theme in name only (3/20)** and **cast-as-a-list (3/20)**, both flat for three rounds.
5. **Invented cast** — #1 invents Noah's mother, #2 a captain, #20 a dragon-keeper. Still unrated
   and still undecided; in R5 all three inventions supply the responsible adult the RULES line asks
   for, so the behaviour now looks load-bearing rather than accidental.
6. **#7's roles block contradicts its premise** — new, one instance, cheap to check if it recurs.
