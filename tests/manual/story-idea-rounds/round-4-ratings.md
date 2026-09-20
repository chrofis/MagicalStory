# Round 4 — ratings (after the three round-3 fixes)

20 ideas, `claude-sonnet-4-6`, USD 0.7443. Rated by reading, no judge call.
Same rubric and same strictness as rounds 1-3, recalibrated against the R1-R3 evidence lines:
(a) contract — premise only; (b) concreteness of want/obstacle/cost; (c) cast present with a role;
(d) age fit youngest+oldest; (e) world/theme fit, no leak; (f) language + format; (g) peril line;
(h) life-skill topic is the engine (n/a elsewhere); (i) would a Swiss parent buy this.

Applied before this round:

- **Both templates** (`generate-story-idea-single.txt`, `generate-story-ideas.txt`, registry set
  `story-idea-templates`): check 6 rewritten to be exhaustive ("number the sentences of [FINAL];
  for each one after the first write setup or event; every sentence marked event other than the
  last is cut … list every cut sentence, not one of them"), the `CUT:`/`CUT_1:`/`CUT_2:` step now
  asks for numbers + full text and restates the absence requirement; check 4 excludes co-location
  as a stake ("Living with, coming along with, or waiting for the others is not a stake"); a RULES
  line "The youngest main character does something in the idea, and whoever is responsible for them
  is named."
- **`server/routes/storyIdeas.js`**: the two variant instructions were pulled into one exported
  `buildVariantInstructions(world1, world2)` — the harness carried a hand-copied duplicate of them,
  which is exactly the drift the sibling rule exists to stop. When BOTH arms resolve to `location`,
  the second arm now names three axes to vary: a different class of place (indoors vs outdoors,
  home vs public), a different responsible adult or none, and a different outside event that makes
  the skill hard. The calls stay parallel — serialising them was rejected on happy-path latency.
  Pinned by `tests/unit/idea-variant-instructions.test.ts` (4 tests).
- The non-streaming endpoint builds no per-arm instruction pair at all (it fills one combined
  template whose story 2 is always the make-believe world), so there was nothing to keep in step
  there; its half of fix (2) does not exist. The two prompt fixes did land on both templates.

| # | cell | world | a | b | c | d | e | f | g | h | i |
|---|------|-------|---|---|---|---|---|---|---|---|---|
| 1 | 1 pirate, Noah 3 | location | 5 | 5 | 5 | 4 | 5 | 4 | 5 | – | 4 |
| 2 | 1 pirate | fantasy | 3 | 5 | 5 | 3 | 5 | 4 | 5 | – | 3 |
| 3 | 2 making-friends | location | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | 4 |
| 4 | 2 making-friends | location | 5 | 3 | 5 | 5 | 5 | 4 | 5 | 4 | 2 |
| 5 | 3 wizard | location | 2 | 5 | 4 | 5 | 5 | 3 | 5 | – | 3 |
| 6 | 3 wizard | fantasy | 3 | 5 | 5 | 5 | 5 | 4 | 5 | – | 4 |
| 7 | 4 moon-landing | participant | 4 | 5 | 4 | 3 | 5 | 5 | 1 | – | 2 |
| 8 | 4 moon-landing | observer | 4 | 5 | 5 | 5 | 5 | 4 | 5 | – | 4 |
| 9 | 5 not-giving-up | location | 2 | 5 | 4 | 5 | 3 | 3 | 5 | 5 | 3 |
| 10 | 5 not-giving-up | fantasy | 2 | 5 | 5 | 5 | 5 | 3 | 5 | 5 | 3 |
| 11 | 6 dinosaur | location | 3 | 4 | 4 | 4 | 5 | 4 | 5 | – | 4 |
| 12 | 6 dinosaur | fantasy | 3 | 5 | 5 | 4 | 5 | 4 | 5 | – | 4 |
| 13 | 7 going-outside | location | 3 | 2 | 3 | 4 | 3 | 4 | 5 | 3 | 2 |
| 14 | 7 going-outside | location | 3 | 2 | 3 | 4 | 3 | 5 | 5 | 3 | 2 |
| 15 | 8 wright-brothers | participant | 2 | 3 | 5 | 4 | 5 | 5 | 3 | – | 4 |
| 16 | 8 wright-brothers | observer | 3 | 2 | 5 | 5 | 5 | 4 | 5 | – | 3 |
| 17 | 9 knight (fr) | location | 3 | 5 | 3 | 5 | 5 | 4 | 5 | – | 4 |
| 18 | 9 knight (fr) | fantasy | 3 | 5 | 5 | 5 | 5 | 5 | 5 | – | 4 |
| 19 | 10 managing-emotions | location | 2 | 5 | 5 | 5 | 5 | 3 | 5 | 5 | 4 |
| 20 | 10 managing-emotions | fantasy | 2 | 5 | 5 | 5 | 5 | 3 | 5 | 5 | 3 |

Means: a 3.10 · b 4.25 · c 4.50 · d 4.50 · e 4.70 · f 4.00 · g 4.70 · h 4.38 · i 3.30

| axis | R1 | R2 | R3 | R4 | Δ R3→R4 |
|---|---|---|---|---|---|
| a contract | 3.25 | 3.10 | 3.25 | 3.10 | −0.15 |
| b concreteness | 3.80 | 4.25 | 4.20 | 4.25 | +0.05 |
| c cast present | 3.90 | 4.40 | 4.40 | 4.50 | +0.10 |
| d age fit | 3.90 | 4.00 | 4.35 | 4.50 | +0.15 |
| e world/theme | 4.30 | 4.45 | 4.45 | 4.70 | **+0.25** |
| f language/format | 3.70 | 4.10 | 4.20 | 4.00 | −0.20 |
| g peril | 4.30 | 4.15 | 4.55 | 4.70 | +0.15 |
| h topic is the engine | 3.50 | 4.00 | 4.00 | 4.38 | **+0.38** |
| i would buy | 3.25 | 3.25 | 3.15 | 3.30 | +0.15 |

## Evidence for every score ≤3

- **#2 a=3** the test is handed over: «Noah muss herausfinden, welche der drei Buchten gemeint ist, bevor das Schiff den Anker wirft».
- **#2 d=3** the three-year-old holds the only map and does the navigating; Kapitänin Mara «wartet auf ihn am Steuer», which the new check 4 calls not a stake.
- **#2 i=3** same toddler-carries-it problem as R1-R3.
- **#4 b=3** the want is never stated and the cost is a metaphor: «verlässt sie den Park mit demselben Abstand zwischen sich und dem Mädchen wie zu Beginn».
- **#4 i=2** the weaker half of a pair that is still one idea (see Regressions).
- **#5 a=2** the gate and the test, in full: «das Siegel öffnet sich nur, wenn Elias und Sofia gemeinsam eine Prüfung bestehen, bei der sie einander nicht helfen dürfen».
- **#5 f=3** sentences 2 and 3 run ~50 words each across dashes.
- **#5 i=3** the premise explains its own machinery.
- **#6 a=3** the gate again: «der Turm öffnet sich nur für jemanden, dem Oma Ruth das Vertrauen ausgesprochen hat — und das hat sie bisher keinem ihrer Schüler getan».
- **#7 d=3** a nine- and a six-year-old fly the lander.
- **#7 g=1** fourth round unmoved, and now stated outright as death: «wer nicht landet, kehrt nicht zurück». R3's version was «kehrt die Eagle nie zurück»; check 7 names "a vehicle with a supply running out" and the model ships it every round.
- **#7 i=2** unsellable at this peril level.
- **#9 a=2** the middle is narrated: «jede Reparatur legt eine neue Schwachstelle frei, bevor sie überhaupt verstehen, warum die letzte nicht gehalten hat», «Ein zweites Team … ist längst beim nächsten Versuch, während [sie] noch am ersten stehen».
- **#9 e=3** the space theme resolves to a model spaceship assembled at a Swiss ruin.
- **#9 f=3** sentence 1 is ~55 words with a colon inside it.
- **#9 i=3** a school contest sold as a space story.
- **#10 a=2** the mechanism: «eine Sequenz aus dreissig Schritten, bei der jeder Fehler das Modul vollständig zurücksetzt und von vorne beginnen lässt».
- **#10 f=3** four sentences of ~55 words each.
- **#10 i=3** strong premise, plot-summary length.
- **#11 a=3** a trait paired with the obstacle, which the RULES line forbids by name: «bevor Ben, der seinen Weg allein suchen will, die Gruppe auseinanderbringt».
- **#11 b=4 / c=4** the three adults now have a stake («bevor Mama Sara, Papa Tom und Opa Hans merken, dass die Kinder verschwunden sind») — R3's packing list is gone, but they are still off-page.
- **#12 a=3** a second thread narrated: «Zara hat sich derweil tiefer ins Farngestrüpp davongeschlichen, und Papa Tom und Mama Sara suchen sie».
- **#13 a=3 / #14 a=3** the event is still the whole text: «Unterwegs verliert sie einen Fäustling», «verliert Lena einen Fäustling, und die Hand wird kalt».
- **#13 b=2** the want is never stated and the cost trails off after itself: «bis er auf dem Weg zurück gefunden wird — oder nicht», against the rule "nothing comes after it".
- **#14 b=2** the cost is a metaphor: «Ohne den Fäustling ist der Heimweg weiter als der Hinweg».
- **#13 c=3 / #14 c=3** the new RULES line half-landed: a responsible adult is now named in both («ihre Betreuerin Marta», «ihre Mutter»), which R3 lacked, but the one-year-old still only has things done to her — «in den Kinderwagen gesetzt», «fährt sie … im Kinderwagen» — and losing a mitten is the only thing she "does".
- **#13 e=3 / #14 e=3** the farm theme is still an address: «wohnt auf einem Bauernhof am Rand von Baden».
- **#13 h=3 / #14 h=3** going outside is the occasion; the mitten is the obstacle.
- **#13 i=2 / #14 i=2** the fourth round in which both arms tell the mitten story.
- **#15 a=2** the middle happens on the back cover: «Yara hat gesehen, dass daran etwas nicht stimmt — aber Amir steigt bereits auf die Maschine, ohne sie anzuhören».
- **#15 b=3** «etwas nicht stimmt» is the unnamed something the concreteness rule forbids by name.
- **#15 g=3** a ten-year-old takes off in the Flyer; check 7 lists "at a height" and it shipped.
- **#16 a=3 / b=2** the want is unnamed and the rule is stated: «Yara aber will etwas anderes von diesem Tag, und keines der beiden bekommt, was es will, wenn das andere nicht mitspielt».
- **#16 i=3** two children watching, with no named want for one of them.
- **#17 a=3** trait paired with obstacle: «Théo est persuadé que c'est à lui de décider comment remettre l'écu en place — pas à Chloé».
- **#17 c=3** Théo is present only because he was sent along — «est là parce que Maman Élodie ne laissera partir Chloé nulle part sans lui» — and Maman Élodie appears only inside that clause. This is precisely the co-location the new check 4 excludes, and the check passed it.
- **#18 a=3** the route that decides the outcome, named: «Le seul passage libre mène par le chemin du moulin, et c'est le chemin que leur mère leur a expressément défendu d'emprunter».
- **#19 a=2** the mechanism, a third round running: «seine Flügel öffnen sich nur, wenn die Luft um ihn herum ruhig ist, und jedes Mal, wenn Jonas und Mila in Streit geraten, zieht er die Flügel eng an den Körper».
- **#19 f=3** adjective pile plus a typo: «verletzter Drache», «nassen Kopfsteinpflaster», «Schossbergs».
- **#20 a=2** the rule written out as a rule: «Vorn hat eine Regel: Wer schreit, wer schlägt, wer die Riegel loslässt, weil die Wut zu gross wird, beginnt von vorn».
- **#20 f=3** four sentences of ~55 words.
- **#20 i=3** the lesson is stated rather than set up.

## Did the three targeted classes move?

| targeted class | R1 | R2 | R3 | R4 | verdict |
|---|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 10 | 11 | 11 | **15** | count up; the SHAPE changed (below) |
| Both arms tell the same story | 4 | 4 | 4 | **4** | flat — one of three axes took |
| Cast listed rather than present (c≤3) | 6 | 3 | 4 | **3** | back to the R2 best |

### Middle-leak: the count went the wrong way, and it is worth reading why

The exhaustive check 6 did exactly what it was asked and it removed the class of leak it can see.
Every R3 leak of the form *a narrated event* is gone: R3's «Dann schlägt der Computer Alarm, und der
Treibstoff sinkt schneller» (#7) and «nach dem vierten Fehlschlag erklärt Herr Keller … das Modul
für unreparierbar» (#10) have no counterpart in R4, and cell 2 — a=2 and a=3 in R3 — is a=5 on both
arms, the cleanest pair in four rounds. a=2 fell from 7 to 6.

What replaced them is a different shape: **the stated rule or gate.** «das Siegel öffnet sich nur,
wenn …» (#5), «der Turm öffnet sich nur für jemanden, dem …» (#6), «jeder Fehler setzt das Modul
zurück» (#10), «Vorn hat eine Regel: wer schreit … beginnt von vorn» (#20), «Le seul passage libre
mène par …» (#18). Nine of the fifteen a≤3 ideas leak in this form and nothing else.

A stated rule is not an event. Asked to label each sentence **setup or event**, the model labels a
condition "setup" — correctly, by its own taxonomy — and keeps it. The new check therefore cannot
reach the residual by construction. That is the whole delta: the leak type the check names is
gone, the leak type it does not name grew into the space.

## Regressions

- **Both arms tell the same story: still 4 ideas (#3/#4, #13/#14).** The named axes half-worked.
  Cell 7's *responsible adult* axis took cleanly (arm 1 «ihre Betreuerin Marta», arm 2 «ihre
  Mutter»); the *class of place* and the *outside event* did not — both arms are outdoors on the
  Holzbrücke over the Limmat, both under the chestnuts, both about the lost mitten. Cell 2 is worse:
  both arms are the park at the Museum Langmatt, the same unknown girl, the same Leo-is-minding-her
  frame. Naming the axes did not defeat the fact that the second call cannot see the first.
- **f 4.20 → 4.00.** Over-length sentences returned (#5, #9, #10, #19, #20 — five ideas at ~55 words
  a sentence). Plausible mechanism: check 6 now spends the [REVIEW] budget labelling sentences
  rather than shortening them, and the "3-5 sentences" rule is satisfiable by writing five very long
  ones. The class count is flat at 5; the severity is what moved.
- **#7's peril is the one finding that has never moved in four rounds**, and this round it is
  phrased as death outright.

## Fault classes, ranked (frequency × severity)

| rank | class | n/20 | severity | R4 | R3 | R2 | R1 |
|---|---|---|---|---|---|---|---|
| 1 | Middle leaked — **stated rule or gate** | 9 | 3 | 27 | – | – | – |
| 2 | Middle leaked — narrated event | 6 | 3 | 18 | 33 | 33 | 30 |
| 3 | Both arms tell the same story | 4 | 3 | 12 | 12 | 4 | 4 |
| 4 | Output-format drift (over-length, adjectives) | 5 | 2 | 10 | 10 | 10 | 14 |
| 5 | Peril over the line | 2 | 3 | 6 | 6 | 12 | 9 |
| 5 | Cast listed rather than present | 3 | 2 | 6 | 8 | 6 | 12 |
| 5 | Theme present in name only | 3 | 2 | 6 | 6 | 6 | 6 |
| 8 | Life-skill topic bolted on | 2 | 2 | 4 | 6 | 6 | 15 |
| 9 | English `ROLES:` label | 0 | – | 0 | 0 | 4 | 4 |

## The next three worst classes and a proposed fix for each

Not applied.

### 1. Middle leaked as a stated rule or gate (9/20)

**A prompt lever is left, and it has not been tried.** The residual is not a failure of the CUT
mechanism — round 3 verified the model deletes what it nominates, and round 4 confirms it again.
It is a failure of the *taxonomy*: check 6 offers two labels, and a condition is honestly neither.
Add the third:

> 6. **Back cover, not synopsis**: number the sentences of [FINAL]. Label each one after the first
>    "setup", "event", or "rule". A "rule" is any sentence that says what only happens if, what
>    opens only when, what resets, or what someone will not do — the condition a reader would use
>    to work out the ending. Every sentence labelled "event" other than the last is cut, and every
>    sentence labelled "rule" is cut. The last sentence states the cost and is kept.

This is cheap, rides in the same call, and targets the exact nine ideas above.

**The code-side alternative, and why it is not the fix here.** A JS verification of the kind
`server/lib/trialIdeaCheck.js` runs for the trial — the generator copies spans of its own output,
JS checks only that the copied spans are real spans and never reads their meaning, and a failure
reruns once with the reason fed back — would be the right shape if the model were *lying* about its
CUT list. It is not: the CUT strings are genuinely absent from [FINAL] in every round since R3. A
`cut ⊄ final` assertion would fire on approximately zero of these twenty ideas, because the leaked
rules are never nominated in the first place. JS cannot recognise a rule-statement without reading
meaning, which the settled prompt-vs-code split forbids code from doing.
**Latency cost if a rerun is ever wired anyway:** R4's per-arm wall clock is 24.6-41.8 s (median
~34 s). A rerun sits on the wizard's critical path and would roughly double the arm that fails —
+30 s on a screen the user is waiting at. Taxing every idea to catch 45% of them is the trade the
trial's own doc already rejected once, and the prompt lever above costs nothing.

### 2. Both arms tell the same story (4/20, flat at 4 for three rounds)

Naming the axes moved one of three. The failure is structural: the second call cannot see the
first, so "different" is unverifiable from inside it. Two shapes remain, owner's call:
(a) **make the axis a value, not an adjective** — pick the second arm's place class in JS
(`indoors` / `outdoors`) and its event class from a small list, from the cell's own inputs, and
state the chosen one as a requirement rather than asking for "a different class of place"; the
model then has nothing to vary against, it is told which one it is in. Zero latency cost, and it is
the same "compute the constraint in code, inject it into the prompt" shape as the mechanical-rules
rule. (b) serialise and pass arm 1's [FINAL] into arm 2 — rejected on latency in this round and
still rejected.

### 3. Output-format drift, specifically sentence length (5/20, severity up)

The rule is "three to five sentences", which five 55-word sentences satisfy. Bound the other end
in both templates: *No sentence runs past about 30 words. Three to five sentences, and a sentence
that needs a dash to hold two clauses together is two sentences.* Cheap, and it is the only class
where the rule as written is literally satisfiable by the failing output.

### Also worth a line (not in the top three)

- **Peril's #7 has not moved in four rounds** and is now a death sentence in plain words. Check 7
  asks the model to name the youngest character and quote the words that put *them* in one of four
  places; #7's clause puts the *vehicle* there. Peril has to be checked for anyone on the page and
  for the craft they are in, not only for the youngest child.
- **Theme in name only (#9, #13, #14)**: a theme that resolves to a model of the thing, or to a
  home address.
- **Invented cast** (#1 invents a sister for a one-character cell, #2 invents a captain). Not
  rated and not obviously wrong — #1's invented sister is what lifted its age fit from 3 to 4 —
  but worth a decision before a later round rates it either way.
