# Round 6 — ratings (hook slot + child acts)

20 ideas, `claude-sonnet-4-6`, USD 0.8198. Rated by reading, no judge call.
Same rubric and same strictness as rounds 1-5, recalibrated against the R1-R5 evidence lines:
(a) contract — premise only; (b) concreteness of want/obstacle/cost; (c) cast present with a role;
(d) age fit youngest+oldest; (e) world/theme fit, no leak; (f) language + format; (g) peril line;
(h) life-skill topic is the engine (n/a elsewhere); (i) would a Swiss parent buy this.

**f is scored on the R1-R4 criteria only** (adjectives, sentence count, clearly over-length
sentences ~35 w+, language, typos), as in R5. The dash rule is still counted separately and
scored nowhere, so the f column stays comparable across all six rounds.

**Axis i recalibration** (re-read before scoring, from the R1-R5 evidence lines): `2` = the weaker
half of a pair that is one idea, or unsellable at its peril level; `3` = competent but the hook is
machinery, a lesson, a plot summary, or an arm's-length frame; `4` = one picturable thing, the
child's own want, no buy-objection; `5` = a parent buys it on the image alone.

Applied before this round (both templates, registry set `story-idea-templates`):

- **HOOK slot** — RULES gains: "One thing in the idea is out of the ordinary and can be pointed at
  in a picture: a thing, a creature, a place or an event, named with a plain noun. It stands in the
  first or second sentence and belongs to the setup or to the obstacle, never to what decides the
  outcome." Review check 9 (single) / (10) (multi) quotes the noun and says which sentence it stands
  in, adds one if nothing can be quoted, and replaces it if the quoted thing decides the outcome.
- **CHILD ACTS** — RULES gains: "The want is the main character's own want, stated as theirs, and
  they are the one who sets out after it. An errand an adult handed them is not their want. For a
  main character aged two or under the want is something to reach, follow, touch, hold or get to,
  never an object to fetch back and never an arrangement to sort out." Review check 10 (single) /
  (11) (multi) quotes the want and the setting-out and rewrites an adult's errand or a carried child.

Verified present in the prompts actually sent, both worlds of cells 1 and 7, via `--dry-run`.

| # | cell | world | a | b | c | d | e | f | g | h | i | hook (diagnostic) |
|---|------|-------|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 pirate, Noah 3 | location | 4 | 4 | 4 | 5 | 4 | 4 | 5 | – | 4 | «ein echtes Piratenschiff» (s1) |
| 2 | 1 pirate | fantasy | 4 | 4 | 5 | 4 | 5 | 5 | 5 | – | 4 | «Ein Papagei» (s3) |
| 3 | 2 making-friends | location | 3 | 4 | 5 | 5 | 5 | 4 | 5 | 5 | 4 | «einen Drachen aus orangefarbenem Papier» (s2) |
| 4 | 2 making-friends | location | 5 | 4 | 5 | 5 | 5 | 3 | 5 | 5 | 2 | «einen grossen roten Drachen» (s2) |
| 5 | 3 wizard | location | 3 | 4 | 5 | 5 | 5 | 3 | 5 | – | 4 | «ein Zauberbuch» (s1) |
| 6 | 3 wizard | fantasy | 3 | 5 | 4 | 5 | 5 | 5 | 4 | – | 4 | «der Turm der Zauberakademie» (s1) |
| 7 | 4 moon-landing | participant | 3 | 5 | 5 | 4 | 5 | 3 | 2 | – | 4 | «die Mondlandefähre Eagle» (s1) |
| 8 | 4 moon-landing | observer | 2 | 4 | 5 | 3 | 4 | 2 | 4 | – | 3 | «einen Ausweis» (s1) |
| 9 | 5 not-giving-up | location | 2 | 4 | 5 | 5 | 3 | 2 | 5 | 4 | 3 | «eine Signalkapsel aus dem Jahr 1972» (s1) |
| 10 | 5 not-giving-up | fantasy | 2 | 4 | 5 | 5 | 5 | 2 | 5 | 5 | 3 | «die Raumstation Auroris» (s1) |
| 11 | 6 dinosaur | location | 2 | 3 | 3 | 4 | 4 | 3 | 2 | – | 3 | «einen Dinosaurierzahn» (s1) |
| 12 | 6 dinosaur | fantasy | 3 | 4 | 4 | 5 | 5 | 3 | 5 | – | 5 | «ein Dinosaurierei» (s1), «ein junger Dinosaurier» (s2) |
| 13 | 7 going-outside | location | 4 | 3 | 3 | 5 | 3 | 4 | 5 | 3 | 3 | «Ein Esel» (s2) |
| 14 | 7 going-outside | location | 5 | 3 | 2 | 5 | 4 | 5 | 5 | 4 | 4 | «eine Ente» (s1) |
| 15 | 8 wright-brothers | participant | 4 | 4 | 5 | 4 | 5 | 4 | 4 | – | 4 | «der Flyer» (s2) |
| 16 | 8 wright-brothers | observer | 3 | 4 | 5 | 5 | 5 | 4 | 5 | – | 4 | «eine Flügelmaschine aus Holz und Stoff» (s1) |
| 17 | 9 knight (fr) | location | 3 | 4 | 4 | 5 | 5 | 2 | 3 | – | 4 | «la bannière de chevalier qu'elle a cousue» (s1) |
| 18 | 9 knight (fr) | fantasy | 4 | 5 | 4 | 4 | 5 | 3 | 4 | – | 4 | «Un cerf blanc» (s2) |
| 19 | 10 managing-emotions | location | 2 | 4 | 5 | 5 | 5 | 4 | 4 | 5 | 4 | «ein Drache aus dem Fels» (s1) |
| 20 | 10 managing-emotions | fantasy | 2 | 4 | 5 | 5 | 5 | 2 | 4 | 4 | 3 | «die Höhle des Drachen» (s1) |

Means: a 3.15 · b 4.00 · c 4.40 · d 4.65 · e 4.60 · f 3.35 · g 4.30 · h 4.38 · **i 3.65**

| axis | R1 | R2 | R3 | R4 | R5 | R6 | Δ R5→R6 |
|---|---|---|---|---|---|---|---|
| a contract | 3.25 | 3.10 | 3.25 | 3.10 | 3.65 | 3.15 | −0.50 |
| b concreteness | 3.80 | 4.25 | 4.20 | 4.25 | 4.15 | 4.00 | −0.15 |
| c cast present | 3.90 | 4.40 | 4.40 | 4.50 | 4.65 | 4.40 | −0.25 |
| d age fit | 3.90 | 4.00 | 4.35 | 4.50 | 4.60 | **4.65** | +0.05 |
| e world/theme | 4.30 | 4.45 | 4.45 | 4.70 | 4.55 | 4.60 | +0.05 |
| f language/format | 3.70 | 4.10 | 4.20 | 4.00 | 3.90 | 3.35 | −0.55 |
| g peril | 4.30 | 4.15 | 4.55 | 4.70 | 4.65 | 4.30 | −0.35 |
| h topic is the engine | 3.50 | 4.00 | 4.00 | 4.38 | 4.50 | 4.38 | −0.12 |
| **i would buy** | 3.25 | 3.25 | 3.15 | 3.30 | 3.35 | **3.65** | **+0.30** |

## Did i move, and on which cells

**Yes — +0.30, the largest single-round move on i in six rounds, and the first time i has left the
3.15-3.35 band it sat in for five rounds.** Per cell, R5 → R6:

| cell | R5 i | R6 i | what changed |
|---|---|---|---|
| 1 pirate | 4 / 3 | 4 / **4** | the fantasy arm's parrot is now the obstacle and the 3-year-old's want is to *get to* the chest, not to carry the map |
| 2 making-friends | 4 / 2 | 4 / 2 | unchanged — a paper kite in both arms, and both arms are still one idea |
| 3 wizard | 3 / 4 | **4** / 4 | the location arm gained a nameable object (a spell book Oma Ruth keeps) in place of machinery |
| 4 moon-landing | 4 / 3 | 4 / 3 | flat; the observer arm still reads as a plot summary |
| 5 not-giving-up | 3 / 3 | 3 / 3 | flat — the want is still a dataset and a calibration |
| 6 dinosaur | 4 / 3 | 3 / **5** | the fantasy arm is the best idea of the series (a hatchling that follows a four-year-old); the location arm lost a point to its rock passage |
| 7 going-outside | 2 / 2 | **3 / 4** | the child-acts rule landed: a one-year-old *follows a duck* instead of having a mitten arranged for her, and the two arms differ for the first time in six rounds |
| 8 wright-brothers | 4 / 4 | 4 / 4 | flat |
| 9 knight (fr) | 3 / 4 | **4** / 4 | the location arm's want is now hers (a banner she sewed) rather than her brother's condition |
| 10 managing-emotions | 4 / 4 | 4 / 3 | the location arm gained a dragon out of the rock; the fantasy arm lost a point to a stated lesson |

Six ideas rose, two fell, twelve flat. **The two levers are visible in the text**: every one of the
twenty ideas now has a quotable hook (the `hook` column has no dashes), and cell 7 — the worst pair
in five rounds — produced its first differentiated, child-driven pair.

## Evidence for every score ≤3

- **#3 a=3** a narrated event: «Leo ist acht Jahre alt und auf das Mädchen zugegangen, aber das
  Mädchen hat nur den Kopf geschüttelt und ist weitergelaufen».
- **#4 f=3** two adjectives in the hook: «einen grossen roten Drachen».
- **#4 i=2** the weaker half of a pair that is still one idea: same park, same unknown girl, same
  paper kite as #3, sixth round running.
- **#5 a=3** the hook explains what it opens: «die fehlende Seite zu finden, die das Schloss des
  Buches aufspringen lässt», plus a frost condition. See Regressions — this is the hook hazard.
- **#5 f=3** «sein Freundin Sofia».
- **#6 a=3** a gate: «nur Schüler dürfen die Kammern des Turms betreten».
- **#7 a=3** the middle narrated: «Kurz vor dem Boden schlägt der Computer Alarm, und der Treibstoff
  in der Eagle wird weniger, Sekunde für Sekunde».
- **#7 f=3** sentences 1 and 2 run ~35 words each.
- **#7 g=2** the lander is back. «der neunjährige Luca sitzt im Innern der Mondlandefähre Eagle …
  der Treibstoff in der Eagle wird weniger» — the "vehicle with a supply running out" clause that
  check 7 names in its own words, shipped again after R5 closed it. The cost is explicitly
  non-fatal («kehrt die Besatzung um»), which is the only reason this is a 2 and not R4's 1.
- **#8 a=2** the middle is narrated and a rule is stated: «er nimmt den Ausweis an sich und macht
  sich mit Nora und Bello auf den Weg durch die Nacht» plus «Papa Daniel darf seinen Posten nicht
  verlassen, solange Apollo 11 noch unterwegs ist».
- **#8 d=3** a nine-year-old takes a six-year-old and a dog out through the night with a stolen pass.
- **#8 f=2** four sentences of ~45, ~30, ~40 and ~40 words.
- **#8 i=3** a strong hook (the badge) inside a plot summary, and the want is to smuggle.
- **#9 a=2** an event plus a rule: «Die Kapsel empfängt plötzlich Koordinaten» and «hat für die
  Gruppe genau einen Versuch genehmigt».
- **#9 e=3** the space theme is a school competition at a Swiss railway cellar — the same finding
  as R4 and R5.
- **#9 f=2** six sentences against a hard limit of five.
- **#9 i=3** the want is «dem Schulwettbewerb einen Datensatz übermitteln» — a submission, not a
  want a child has.
- **#10 a=2** a reset rule: «Das Steuermodul des Shuttles bricht bei jedem Versuch anders zusammen
  und verweigert jedes Mal von vorn zu beginnen».
- **#10 f=2** six sentences, and that same clause is not German.
- **#10 i=3** the want is «das Versorgungsshuttle eigenhändig neu kalibrieren» — an adult's job.
- **#11 a=2** the banned pairing, verbatim: «ein Felsdurchgang, den nur jemand so klein wie Emma
  durchqueren kann» — a gate *and* a character trait matched to the obstacle it will meet.
- **#11 b=3** the closing sentence states no loss: «verlässt den Teufelskeller ohne zu wissen, was
  dort wirklich schläft».
- **#11 c=3** «Mama Sara und Papa Tom warten bei der Holzbrücke» — waiting, which check 4 names as
  not a stake.
- **#11 f=3** sentence 2 runs ~40 words.
- **#11 g=2** a four-year-old goes alone into a rock passage her grandfather cannot enter.
- **#11 i=3** a real hook (a tooth in the ground at the Teufelskeller) undone by the toddler-alone
  problem.
- **#12 a=3** a rule in the third sentence: «der Kleine hört nur auf Emma».
- **#12 f=3** sentence 1 runs ~38 words.
- **#13 b=3** no obstacle is stated at all; the mitten is simply lying in the leaves.
- **#13 c=3** the responsible adult is «eine Grossmutter» — present but not named, sixth round.
- **#13 e=3** the farm is an address again: «vom Bauernhof am Rand von Baden».
- **#13 h=3** going outside is the occasion; the mitten is the obstacle.
- **#13 i=3** up from 2 — a donkey and a reaching toddler — but still the mitten story.
- **#14 b=3** the cost does not attach to the want: she wants the duck, she loses warmth.
- **#14 c=2** the RULES line is broken outright — no responsible adult is named or present, only
  «bevor jemand sie wieder hineinträgt». The worst c of the round and a new failure.
- **#16 a=3** a repeated event: «Yara läuft immer wieder auf die Schiene zu, und jedes Mal muss
  Amir ihr nachrennen».
- **#17 f=2** three sentences of ~35 words, and «un vouloir à elle» is the new RULES line surfacing
  as unidiomatic French inside [FINAL].
- **#17 g=3** a six-year-old is sent to plant a banner «sur la tour de la Ruine Stein» — height.
- **#18 f=3** «Un cerf blanc», «feuilles rousses».
- **#19 a=2** the middle narrated and the traits paired with the obstacle: «Jonas ist rasend vor
  Wut, weil Mila seinen Beutel umgestossen hat, und Mila kämpft gegen Tränen, weil Jonas sie
  angeschrien hat».
- **#20 a=2** the lesson stated as a rule: «niemand hat ihm je beigebracht, mit den Gefühlen
  umzugehen, die ihn überwältigen, sodass er alles in seiner Nähe mit Feuer verscheucht», plus
  «nur der Drache kennt den Weg».
- **#20 f=2** sentence 4 runs ~45 words.
- **#20 i=3** the premise explains the lesson instead of setting it up.

## Fault classes, count out of 20 per round

| class | R1 | R2 | R3 | R4 | R5 | R6 |
|---|---|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 10 | 11 | 11 | 15 | 9 | **13** |
| — as a narrated event | 10 | 11 | 11 | 6 | 3 | **7** |
| — as a stated rule or gate | – | – | – | 9 | 7 | **6** |
| Both arms tell the same story | 4 | 4 | 4 | 4 | 4 | **2** |
| Cast listed rather than present (c≤3) | 6 | 3 | 4 | 3 | 3 | **3** |
| Output-format drift (f≤3) | 7 | 5 | 5 | 5 | 5 | **11** |
| Peril over the line (g≤3) | 3 | 4 | 2 | 2 | 2 | **3** |
| Theme present in name only | 3 | 3 | 3 | 3 | 3 | **2** |
| Life-skill topic bolted on (h≤3) | 5 | 3 | 3 | 2 | 2 | **1** |
| English `ROLES:` label | 2 | 2 | 0 | 0 | 0 | **0** |
| Idea with no quotable hook | – | – | – | – | – | **0** |

**Both arms tell the same story fell 4 → 2 for the first time in six rounds.** Cell 7 broke: arm 1
is a donkey and a dropped mitten, arm 2 is a duck walking down to the Holzbrücke and a toddler
following it. Cell 2 did not break — both arms are still a paper kite in the Langmatt park.

## Did any defect axis regress?

**Three did, and all three are traceable to the two new lines.**

- **a 3.65 → 3.15, a≤3 count 9 → 13.** The hook adds a sentence's worth of material to a 3-5
  sentence budget, and in seven ideas that material arrived as a narrated event (#3, #7, #8, #9,
  #16, #17, #19) rather than as setup. The rule-or-gate half actually improved (7 → 6).
- **A hook became a leaked decider in two ideas — the hazard the rule names.** #5: «die fehlende
  Seite … die das Schloss des Buches aufspringen lässt» — the hook is the thing that opens the lock,
  which the RULES line forbids in its own words. #11: «ein Felsdurchgang, den nur jemand so klein
  wie Emma durchqueren kann» — the hook is a gate keyed to the main character's own trait, which is
  both the decider ban and the trait-pairing ban. 2/20; the check quoted a hook in both and did not
  test it against the decider clause.
- **f 3.90 → 3.35, f≤3 count 5 → 11.** Two shapes: sentence-count overruns (#9 and #10 both run to
  six sentences against a hard limit of five — the first overruns since R2) and over-length
  sentences (~35-45 words in #7, #8, #11, #12, #17, #20). Both are length pressure from the added
  hook material. The dash habit, counted and scored nowhere: **12 of 20** (R5: 11) — untouched.
- **g 4.65 → 4.30, g≤3 count 2 → 3.** Cell 4's Apollo lander is back (#7, g=2) after R5 closed it
  — the single finding R5 called the largest per-idea swing in the series. #11 puts a four-year-old
  alone underground. #17 repeats R5's tower height. The widened check 7 did not fire on any of them.
- **c 4.65 → 4.40.** One new instance: #14 names no responsible adult at all, which the RULES line
  has required since R4. Ironically it is the same idea the child-acts rule fixed best.

## The three worst on i, and what is still missing

1. **#4, cell 2 arm 2, i=2 — «einen grossen roten Drachen» in the Langmatt park.** It is compliant:
   hook present, the want is Mia's, she is the one who must speak. It is unsellable only because
   #3 is the same idea, and the second call cannot see the first. Six rounds, four shapes of the
   variety instruction; the lever left is serialising the calls, rejected on latency.
2. **#9 and #10, cell 5, i=3 — «eine Signalkapsel», «die Raumstation Auroris».** Both have a hook
   and both hooks are good. What is missing is that the *want* is an adult's job: to «einen
   Datensatz übermitteln» and to «das Versorgungsshuttle … neu kalibrieren». The child-acts rule
   fixed *whose* want it is and says nothing about whether it is a want a child would have. Both
   also run to six sentences.
3. **#20, cell 10 arm 2, i=3 — «die Höhle des Drachen».** The hook is there and the premise then
   explains it: a 45-word sentence saying the dragon was never taught to handle his feelings and
   therefore drives everything off with fire. The lesson is stated rather than set up, which is the
   same i=3 finding as R4's and R5's cell 10. **Naming the out-of-the-ordinary thing pulls an
   explanation of it in behind.**
