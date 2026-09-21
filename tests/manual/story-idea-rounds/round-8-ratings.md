# Round 8 — ratings (contract room, the promise slot, the shape catalogue, the age band)

20 ideas, `claude-sonnet-4-6`, USD 1.0298. Rated by reading, no judge call. Same rubric, same
strictness and the same axis-i calibration as rounds 6 and 7 (`2` = one of a pair that is one idea,
unsellable, or a broken output; `3` = competent but the hook is machinery, a lesson, a plot summary
or an arm's-length frame; `4` = one picturable thing, the child's own want, no buy-objection;
`5` = a parent buys it on the image alone). **f is scored on the R1-R4 criteria only**, as in R5-R7,
so the column stays comparable — the sentence-count limit inside it moves from five to six.

## What changed before this round

Three owner-directed changes, plus one correction to the harness itself.

- **A — contract room + a promise slot.** The setting sentence is no longer a required slot (the
  reader picked the town and the season in the wizard); the idea opens on the hook or the child and
  the place appears as the scene the action is in. A **promise** slot was added: one sentence of
  what the reader will get to see, without saying whether they manage it and without naming what
  decides it. The CUT step's labels went from three (setup / event / rule) to six
  (setup / hook / promise / event / rule / cost), so the new slot cannot be cut as an event.
  Budget four to six sentences, one per slot. Examples rewritten in both templates.
- **B — a story-shape catalogue, computed in code.** `prompts/premise-shapes.txt` holds twelve
  shapes; `pickPremiseShapes` in `server/routes/storyIdeas.js` picks one per arm, deterministically
  from the same seed `buildVariantInstructions` uses, never the same shape on both arms, never one
  above the youngest character's age, and never the two-mains shape for a one-main cast. The
  EVENT class was removed from `buildVariantInstructions`' second location arm — the shape now owns
  what makes the story hard, and two sources for it contradicted. The place class and the
  responsible-adult axis stay.
- **C — the 10-12 band.** Diagnosed from the SENT prompt, and the diagnosis was not the band's text.
  **`tests/manual/story-idea-rounds.js` never called `loadPromptTemplates()`**, which the server does
  at boot (`server.js:2364`). `PROMPT_TEMPLATES` was therefore empty in the harness,
  `buildAgeModeSection` returned only `AGE_OWNS_PROPS_RULE`, and **rounds 1-7 rated a prompt with no
  age-band plot-shape rules in it at all** — a prompt production never sends, in every cell, not
  only cell 5. Fixed. The narrow content fix for cell 5's school-project pull went into the
  `not-giving-up` topic guide (`prompts/life-challenge-guides.txt`), which the idea path and the
  story path share by construction, so it is one edit: *"**Whose it is.** The hard thing is one the
  main character took on for themselves and could walk away from. Never a piece of work set by a
  school or a grown-up, never a submission or an assessment, and the place it is practised is not a
  classroom."* `prompts/story-idea-requirements-adventure-1.txt` also went from "incorporate 1-2
  landmarks" to "one of them is the scene the action happens at".

**Round 8 is therefore not a clean single-variable step from round 7.** Four things moved at once,
and one of them (the band) changes every cell's prompt. Read the deltas below with that in mind.

## Shapes drawn, per cell

| cell | arm 1 | arm 2 |
|---|---|---|
| 1 | race against time | a lost thing that moves |
| 2 | a swap or a mix-up | rescue |
| 3 | an unwanted companion | a promise to keep |
| 4 | rescue | an unwanted companion |
| 5 | rescue | race against time |
| 6 | a swap or a mix-up | rescue |
| 7 | a lost thing that moves | a thing that grows |
| 8 | a promise to keep | a thing that grows |
| 9 | a swap or a mix-up | a message to deliver |
| 10 | a swap or a mix-up | a secret kept |

## Ratings

| # | cell | world | a | b | c | d | e | f | g | h | i | hook | promise | shape kept |
|---|------|-------|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 pirate, Noah 3 | location | 5 | 5 | 3 | 5 | 5 | 5 | 4 | – | 4 | «ein Piratenschiff» an der Holzbrücke (s1) | «Noah … greift nach dem Kästchen» | y |
| 2 | 1 pirate | fantasy | 5 | 5 | 3 | 5 | 5 | 5 | 5 | – | 4 | «ein Tintenfisch» auf dem Deck (s1) | «Noah … knien und den Tintenfisch ansehen» | partly |
| 3 | 2 making-friends | location | 2 | 4 | 4 | 5 | 5 | 2 | 5 | 5 | 3 | «ein Eichhörnchen mit einem weissen Schwanz» (s1) | «Mia einen zweiten Versuch macht» | y |
| 4 | 2 making-friends | location | 5 | 4 | 3 | 5 | 5 | 4 | 5 | 5 | 4 | «eine Kastanie … oben» (s1) | «zwei Arme gemeinsam in die Äste» | **n** |
| 5 | 3 wizard | location | 5 | 5 | 4 | 5 | 5 | 5 | 5 | – | **5** | «ein Zauberbuch an einer Kette» (s1) | «im alten Torgewölbe … das Buch vor ihnen» | y |
| 6 | 3 wizard | fantasy | 3 | 5 | 5 | 5 | 5 | 5 | 5 | – | 4 | «eine Flamme» im Turm (s1) | «vor dem Tor des Turms» | y |
| 7 | 4 moon-landing | participant | 3 | 5 | 5 | 3 | 5 | 4 | **2** | – | 3 | «der Mondlander Eagle» (s1) | «sucht … einen Fleck, der sicher genug ist» | **n** |
| 8 | 4 moon-landing | observer | 3 | 3 | 5 | 5 | 4 | 2 | 5 | – | 4 | «ein Gerät mit zwei Leuchten» (s2) | «Luca mit Nora und Bello im Dunkeln» | **n** |
| 9 | 5 not-giving-up | location | 3 | 5 | 5 | 5 | 4 | 2 | 3 | 5 | 4 | «eine Sonde … abgestürzt im Teufelskeller» (s1) | «klettert Finn in die Dunkelheit» | y |
| 10 | 5 not-giving-up | fantasy | 3 | 4 | 5 | 5 | 5 | 3 | 3 | 5 | 4 | «das Raumschiff Kessler» (s1) | «kriecht Finn ein drittes Mal durch die Schleuse» | y |
| 11 | 6 dinosaur | location | 3 | 4 | 5 | 5 | 4 | 3 | 5 | – | 4 | «ein Dinosaurierei … auf dem Fensterbrett» (s1) | «steht Emma vor Opa Hans und zeigt» | y |
| 12 | 6 dinosaur | fantasy | 3 | 5 | 5 | 4 | 5 | 5 | 3 | – | 4 | «ein Dinosaurier-Ei … im Herbstwald» (s1) | «Emma dem Raptorsaurus allein gegenübersteht» | y |
| 13 | 7 going-outside | location | 5 | **2** | **2** | 4 | 3 | 3 | 5 | 2 | **2** | «ein Fäustling» im Wind (s2) | «die warme Hand … nimmt und hält» | y |
| 14 | 7 going-outside | location | 5 | 3 | 3 | 5 | 3 | 3 | 4 | 3 | 3 | «eine Gans» (s2) | – (the goose nearing is setup) | **n** |
| 15 | 8 wright-brothers | participant | 4 | 5 | 5 | 5 | 5 | 5 | 4 | – | **5** | «ein Flugapparat aus Holz und Stoff» (s1) | «liegt Amir auf dem Apparat … wie die Schiene endet» | y |
| 16 | 8 wright-brothers | observer | 3 | 4 | 5 | 5 | 5 | 2 | 5 | – | 4 | «der Flyer» auf der Holzschiene (s1) | «wird dabei sein, wenn der Flyer zum ersten Mal abhebt» | **n** |
| 17 | 9 knight (fr) | location | 3 | 4 | 5 | 4 | 5 | 3 | 5 | – | 3 | «deux boucliers aux blasons pareils» (s1) | «Chloé tenir les deux boucliers … et choisir» | y |
| 18 | 9 knight (fr) | fantasy | 3 | 5 | 5 | 4 | 5 | 3 | 4 | – | 3 | «un chevalier sans visage» (s3) | «Chloé se tenir seule devant ce chevalier» | y |
| 19 | 10 managing-emotions | location | 2 | 4 | 5 | 5 | 5 | 2 | 4 | 5 | 3 | «ein Drachenjunges … zwei Steine» (s1) | «die beiden Kinder im Dunkeln aufeinanderprallen» | partly |
| 20 | 10 managing-emotions | fantasy | 4 | 3 | 4 | 5 | 5 | 3 | 5 | 5 | 3 | «ein Drache … auf dem Turm von Eisenfall» (s1) | **missing** | y |

Means: a 3.60 · b 4.20 · c 4.30 · d 4.70 · e 4.65 · f 3.45 · g 4.30 · h 4.38 · **i 3.65**

## Means, R1 → R8

| axis | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | Δ R7→R8 |
|---|---|---|---|---|---|---|---|---|---|
| a contract (premise only) | 3.25 | 3.10 | 3.25 | 3.10 | 3.65 | 3.15 | 3.15 | **3.60** | +0.45 |
| b concreteness | 3.80 | 4.25 | 4.20 | **4.25** | 4.15 | 4.00 | 3.95 | 4.20 | +0.25 |
| c cast present with a role | 3.90 | 4.40 | 4.40 | 4.50 | **4.65** | 4.40 | 4.40 | 4.30 | −0.10 |
| d age fit | 3.90 | 4.00 | 4.35 | 4.50 | 4.60 | 4.65 | **4.70** | **4.70** | 0.00 |
| e world/theme fit | 4.30 | 4.45 | 4.45 | 4.70 | 4.55 | 4.60 | **4.75** | 4.65 | −0.10 |
| f language/format | 3.70 | 4.10 | **4.20** | 4.00 | 3.90 | 3.35 | 3.60 | 3.45 | −0.15 |
| g peril | 4.30 | 4.15 | 4.55 | **4.70** | 4.65 | 4.30 | 4.30 | 4.30 | 0.00 |
| h topic is the engine | 3.50 | 4.00 | 4.00 | 4.38 | **4.50** | 4.38 | 4.38 | 4.38 | 0.00 |
| **i would a Swiss parent buy this** | 3.25 | 3.25 | 3.15 | 3.30 | 3.35 | **3.65** | 3.55 | **3.65** | +0.10 |

## Fault classes, count out of 20 per round

| class | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 |
|---|---|---|---|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 10 | 11 | 11 | 15 | 9 | 13 | 12 | **12** |
| — as a narrated event | 10 | 11 | 11 | 6 | 3 | 7 | 8 | **5** |
| — as a stated rule or gate | – | – | – | 9 | 7 | 6 | 4 | **5** |
| — as a trait paired with the obstacle | – | – | – | – | – | – | – | **2** |
| Both arms tell the same story | 4 | 4 | 4 | 4 | 4 | 2 | 2 | **2** |
| Cast listed rather than present (c≤3) | 6 | 3 | 4 | 3 | 3 | 3 | 3 | **5** |
| Output-format drift (f≤3) | 7 | 5 | 5 | 5 | 5 | 11 | 7 | **12** |
| Peril over the line (g≤3) | 3 | 4 | 2 | 2 | 2 | 3 | 3 | **4** |
| Theme present in name only | 3 | 3 | 3 | 3 | 3 | 2 | 2 | **3** |
| Life-skill topic bolted on (h≤3) | 5 | 3 | 3 | 2 | 2 | 1 | 1 | **2** |
| English `ROLES:` label | 2 | 2 | 0 | 0 | 0 | 0 | 0 | **0** |
| Idea with no quotable hook | – | – | – | – | – | 0 | 0 | **0** |
| Review self-talk shipped inside [FINAL] | – | – | – | – | – | – | 2 | **0** |
| Idea with no promise sentence | – | – | – | – | – | – | – | **1** |
| Shape not kept | – | – | – | – | – | – | – | **5** (+2 partly) |
| Opens with an address sentence | – | – | – | – | – | – | – | **0** |

## Per-cell movement on i, R7 → R8

| cell | R7 (arm1, arm2) | R8 (arm1, arm2) | Δ mean |
|---|---|---|---|
| 1 pirate | 4, 4 | 4, 4 | 0.00 |
| 2 making-friends | 4, 4 | 3, 4 | −0.50 |
| 3 wizard | 3, 4 | **5**, 4 | **+1.00** |
| 4 moon-landing | 4, 4 | 3, 4 | −0.50 |
| 5 not-giving-up | 3, 3 | 4, 4 | **+1.00** |
| 6 dinosaur | 2, 2 | 4, 4 | **+2.00** |
| 7 going-outside | 2, 4 | 2, 3 | −0.50 |
| 8 wright-brothers | 4, 4 | **5**, 4 | +0.50 |
| 9 knight (fr) | 3, 5 | 3, 3 | −1.00 |
| 10 managing-emotions | 4, 4 | 3, 3 | −1.00 |

## Did the three changes work?

**Two took, one bought its gain with format.**

- **The promise slot took, and it is the strongest single thing in the round.** 19 of 20 ideas carry
  a quotable promise (the one miss is #20). It does what it was added for: «wird dabei sein, wenn
  der Flyer zum ersten Mal abhebt» (#16), «Emma dem Raptorsaurus allein gegenübersteht» (#12), «liegt
  Amir auf dem Apparat und spürt, wie die Schiene unter ihm endet» (#15). None of the 19 says whether
  the hero manages it. **The feared regression — the promise becoming a leaked middle — did not
  happen once**; the only promise that edges toward naming the decider is #11 («zeigt auf etwas, das
  alle übersehen haben»), and it names nothing.
- **Dropping the setting slot took completely.** Not one idea in twenty opens with an address
  sentence, against every round before this one. The landmark did not go with it: the Holzbrücke,
  Ruine Stein, Teufelskeller, Landvogteischloss and Stadtpfarrkirche are all scenes the action is in
  rather than places named in passing. `a` recovered +0.45 to 3.60, its second-best of the series,
  and the narrated-event leak fell 8 → 5, its second-lowest.
- **The shape catalogue took on 13 of 20, and where it took it is the reason the cell moved.**
  Cell 6 went from unusable to i=4 on both arms with a mix-up and a rescue; cell 3's «unwanted
  companion» (a stone-spirit that has attached itself to the boy and will not let go) is the only
  i=5 in the local-world column of the whole series. Five ideas ignored the shape outright (#4, #7,
  #8, #14, #16) and two kept it only in a clause. **No cell drew the same shape on both arms**, and
  the both-arms-identical class held at 2 — the shape did not break cell 7's pair, but nothing has.
- **The age band arriving for the first time is visible in `c` and in the cast work.** Eleven of
  twenty ideas now give every named character a stake, including the six-person cast of cell 6 twice.
  It is also the likeliest cause of the format regression: the band adds ~350 words of plot-shape
  rules to a prompt that was already long, and the ideas came back longer and more clause-heavy.

## Evidence for every score ≤3

- **#1 c=3 / #2 c=3** the responsible person is a relation, not a name: «Noahs Vater», «der Kapitän».
- **#3 a=2** the mix-up is narrated as it happens: «als das Mädchen Mias Stimme hört, dreht sie sich
  um — und sieht Leo an, nicht Mia», then «Das Mädchen geht auf Leo zu, weil sie ihn für denjenigen
  hält, der ‹Hallo› gesagt hat». That is the middle.
- **#3 f=2** sentence 2 runs ~34 words with a dash holding two clauses.
- **#3 i=3** the engine is real and given away in the same breath.
- **#4 c=3** Leo's stake is that he «schaut nicht her».
- **#4 shape n** nothing is stuck, held or lost; the drawn shape was rescue.
- **#6 a=3** a gate: «der Turmwächter lässt keinen Schüler ohne die Unterschrift des Zaubermeisters
  durch das Tor».
- **#7 a=3** a narrated event: «Dann blinkt auf dem Computer der Alarm auf, der Treibstoff schwindet,
  und die Eagle sinkt auf einen Krater zu».
- **#7 d=3** a six-year-old flies the lander as Buzz Aldrin, and a dog is aboard.
- **#7 g=2** the Apollo lander for the **seventh round of eight**: «Wenn der Treibstoff reisst, bevor
  der Lander aufgesetzt hat» — check 7's "vehicle with a supply running out", named in its own words.
- **#7 i=3 / #7 shape n** the shape drawn was rescue and the idea is a landing.
- **#8 b=3** the hook is «ein Gerät mit zwei Leuchten», the unnamed something the concreteness rule
  forbids by name.
- **#8 f=2** an em-dash holding a clause in sentence 2, and the cost sentence is ungrammatical: «Wer
  das Gerät nicht zurückbringt, kostet Papa Daniel die Nacht».
- **#8 e=4 / #8 shape n** the arm is labelled fantasy and plays at a kitchen table; the shape drawn
  was an unwanted companion.
- **#9 a=3** the forbidden pairing of each character's trait with the obstacle: «Jonas weiss, wie man
  Seile sichert, Lina hat die Karten des Geländes, und Herr Keller ist der Einzige, der den
  Teufelskeller kennt».
- **#9 f=2** three dash-joined sentences and six sentences with the longest at ~30 words.
- **#9 g=3** a twelve-year-old climbing alone into a dark rock crevice — check 7's darkness class.
- **#10 a=3** the same trait pairing, one sentence long.
- **#10 f=3** sentence 3 is a dash-joined ~30-word list.
- **#10 g=3** «bleibt die Besatzung der Kessler für immer dort draussen» reads as a crew lost in
  space.
- **#11 a=3** sentence 3 narrates: «Emma sieht, wie alle das Falsche festhalten und ihr zunicken».
- **#11 e=4** the dinosaur theme is the egg and nothing else; no landmark on a location arm.
- **#11 f=3** the cost sentence carries a dash and an abstraction a four-year-old's book cannot use:
  «trägt auch das falsche Recht».
- **#12 a=3** two stated rules: «der Raptorsaurus lässt niemanden heran» and «Papa Tom und Mama Sara
  können den Wald nicht betreten, weil das Raptorsaurus-Revier beginnt, wo ihr Weg endet».
- **#12 d=4 / #12 g=3** a four-year-old alone in front of a raptor at nightfall, and the cost is the
  egg not hatching: «schlüpft darin niemand mehr».
- **#13 b=2** no want is stated and the hand that reaches is nobody's: «eine Hand streckt sich nach
  dem Herbstlaub … aus». The mitten blowing away is not an obstacle to anything.
- **#13 c=2** the only other person in the book is «die warme Hand, die den Kinderwagen schiebt».
- **#13 d=4 / #13 h=2 / #13 i=2** she is in the pram throughout; going-outside cannot be the engine
  of a book that opens with her already outside.
- **#13 e=3 / #14 e=3** the farm theme is the word «Bauernhof» in #13 and absent in #14.
- **#13 f=3 / #14 f=3** «kleine», «warme» (#13) and a dash-joined closing sentence (#14).
- **#14 b=3** the goose and the mitten are two unconnected things; neither is an obstacle to the
  other and no loss is stated.
- **#14 c=3** «ihre Grossmutter», unnamed, eighth round.
- **#14 h=3 / #14 i=3 / #14 shape n** lovely images, no obstacle, no cost; the shape drawn was
  a thing that grows.
- **#16 a=3** sentences 4 and 5 narrate: «jetzt ist sie im Wind und im Gedränge der Männer
  verschwunden. Amir muss sie finden».
- **#16 f=2** **seven sentences**, over the new six-sentence budget, with a semicolon holding two
  clauses in sentence 4.
- **#16 shape n** the shape drawn was a thing that grows.
- **#17 a=3** the want is the adult's errand the child-acts rule forbids: «Maman Élodie a confié à
  Chloé la tâche de garder les deux boucliers ensemble», and the promise names the decider
  («choisir lequel tendre en premier»).
- **#17 d=4 / #17 f=3 / #17 i=3** blazon identification for a six-year-old; sentences 2 and 3 run
  ~36 and ~31 words.
- **#18 a=3** a rule: «il ne laisse passer personne».
- **#18 d=4 / #18 f=3 / #18 i=3** the stake is the mother's position as intendante, not the child's;
  «rousses», «trempé»; an em-dash clause in sentence 4.
- **#19 a=2** the gate is stated in full, and it is the lesson: «er gibt seine Antwort nur, wenn
  derjenige, der anklopft, seinen grössten Zorn erst ablegt».
- **#19 f=2** sentences 2 and 3 run ~33 and ~38 words, the second with a dash.
- **#19 i=3** a premise that hands the reader its own moral mechanic.
- **#20 b=3** Jonas has no stated want; only Mila's is on the page.
- **#20 c=4 / #20 f=3** two em-dashes holding clauses in sentence 2.
- **#20 i=3 / promise missing** the only idea in the round with no promise sentence, and the one with
  the least to picture.

## Regressions

- **Format, f≤3 at 12/20 — the worst count of the series, past round 6's 11.** The shape is not
  round 6's (length): the six-sentence budget is honoured in 19 of 20 (#16 runs to seven). It is
  **the dash**, in nine ideas, and 30-word sentences in five. The rule against it has stood since
  round 5 and check 2 asks for it by name. The plausible cause is prompt length: the age band now
  adds ~350 words, the shape line and the promise rules another ~80, and the clause-joining rule is
  one line in a RULES list that is now twenty lines long. **This is the first class to fix in
  round 9**, and the lever is position rather than another rule.
- **Cast listed rather than present, 3 → 5.** All five are the same fault: a responsible adult named
  by relation instead of by name («Noahs Vater», «der Kapitän», «ihre Grossmutter», «die warme Hand,
  die den Kinderwagen schiebt»). Three of the five are in casts of one, where the wizard supplies no
  adult to name, so the rule asks for something the inputs do not contain.
- **Peril, 3 → 4 and g flat at 4.30.** The Apollo lander is a **seventh-of-eight-rounds** miss and no
  prompt change has ever touched it. Two of the four are cell 5, where the new shapes put a
  twelve-year-old in a dark crevice and a crew stranded in space; the shape catalogue can push peril
  and has no peril column, unlike `challenge-catalogue.txt`, which does.
- **Cell 9 −1.00 and cell 10 −1.00 on i.** Cell 9's fantasy arm fell from the round-7 i=5 because
  the message-to-deliver shape attached the stake to the mother's job. Cell 10 fell on both arms
  because the mix-up and the secret shapes each pulled the emotional mechanic onto the page as a
  rule.
- **Cell 7 is still the only duplicated pair, and is still the worst pair in the round** (#13/#14,
  both the mitten, i=2 and i=3). Eight rounds, five shapes of variety instruction, one shape
  catalogue. This cell is a cast of one one-year-old with no adult in the inputs, and the failure
  is the same every time.

## The three worst on i in round 8, and why

1. **#13, cell 7 arm 1, i=2 — «ein Fäustling» im Wind.** No want (the hand that reaches belongs to
   nobody), no obstacle (the mitten is not in the way of anything), no named person besides the
   child, two adjectives, and going-outside cannot be the engine of a book that opens with her
   already outside in the pram. The shape was kept and did not help: a lost thing that moves is the
   mitten, which nobody is after.
2. **#19, cell 10 arm 1, i=3 — «ein Drachenjunges … zwei Steine».** The mix-up shape is well drawn
   and the Ruine Stein is a real scene, but sentence 3 states the gate and the gate is the lesson:
   let go of your anger and the dragon answers. A premise that hands over its own moral mechanic is
   the i=3 shape this series has measured in six rounds, and the shape catalogue made it easier to
   reach, not harder.
3. **#17 and #18, cell 9, i=3 both — «deux boucliers aux blasons pareils», «un chevalier sans
   visage».** Both arms hang the stake on an adult: one is a task the mother handed over, the other
   is the mother's position at the castle. The R7 child-acts rule is in the prompt actually sent and
   did not reach either arm; the round-7 note on cell 5 — "the next lever is not another rule in
   the same list" — now applies to this cell too. Cell 9 was the only cell to lose a 5 this round.

## Note on comparability

Rounds 1-7 were rated against a prompt that was missing its age-band plot-shape rules, in every
cell. Round 8 is the first round whose prompt matches what `POST /generate-story-ideas-stream`
actually sends. The R1-R7 columns above are kept because the cells, the rubric and the rater are
unchanged and the relative movement is still informative, but a round-7-to-round-8 delta on any
axis is four changes wide, not one.
