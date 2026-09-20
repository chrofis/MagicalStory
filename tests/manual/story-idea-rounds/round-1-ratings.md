# Round 1 — ratings (baseline, no prompt edits)

20 ideas, `claude-sonnet-4-6`, USD 0.5353. Rated by reading, no judge call.
Rubric 1-5: (a) contract — premise only; (b) concreteness of want/obstacle/cost;
(c) cast present with a role; (d) age fit youngest+oldest; (e) world/theme fit, no leak;
(f) language + format; (g) peril line; (h) life-skill topic is the engine (n/a elsewhere);
(i) would a Swiss parent buy this.

| # | cell | world | a | b | c | d | e | f | g | h | i |
|---|------|-------|---|---|---|---|---|---|---|---|---|
| 1 | 1 pirate, Noah 3 | location | 4 | 3 | 5 | 2 | 5 | 4 | 2 | – | 3 |
| 2 | 1 pirate | fantasy | 5 | 5 | 5 | 3 | 5 | 4 | 4 | – | 4 |
| 3 | 2 making-friends | location | 5 | 2 | 5 | 4 | 5 | 5 | 5 | 5 | 4 |
| 4 | 2 making-friends | location | 2 | 4 | 3 | 4 | 5 | 3 | 5 | 5 | 3 |
| 5 | 3 wizard | location | 2 | 4 | 3 | 5 | 5 | 3 | 5 | – | 3 |
| 6 | 3 wizard | fantasy | 2 | 4 | 3 | 5 | 5 | 4 | 4 | – | 3 |
| 7 | 4 moon-landing | participant | 1 | 4 | 3 | 2 | 4 | 2 | 1 | – | 2 |
| 8 | 4 moon-landing | observer | 3 | 4 | 5 | 5 | 5 | 4 | 5 | – | 4 |
| 9 | 5 not-giving-up | location | 3 | 4 | 3 | 4 | 3 | 2 | 3 | 4 | 3 |
| 10 | 5 not-giving-up | fantasy | 4 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 |
| 11 | 6 dinosaur | location | 4 | 4 | 2 | 4 | 2 | 4 | 4 | – | 3 |
| 12 | 6 dinosaur | fantasy | 5 | 4 | 2 | 5 | 3 | 5 | 5 | – | 3 |
| 13 | 7 going-outside | location | 4 | 2 | 2 | 3 | 3 | 5 | 5 | 3 | 3 |
| 14 | 7 going-outside | location | 4 | 2 | 2 | 3 | 3 | 5 | 5 | 4 | 3 |
| 15 | 8 wright-brothers | participant | 3 | 5 | 5 | 4 | 5 | 2 | 4 | – | 4 |
| 16 | 8 wright-brothers | observer | 4 | 4 | 5 | 4 | 5 | 3 | 5 | – | 3 |
| 17 | 9 knight (fr) | location | 4 | 4 | 5 | 4 | 4 | 4 | 5 | – | 4 |
| 18 | 9 knight (fr) | fantasy | 3 | 4 | 5 | 4 | 5 | 2 | 5 | – | 3 |
| 19 | 10 managing-emotions | location | 2 | 4 | 5 | 4 | 4 | 5 | 4 | 1 | 3 |
| 20 | 10 managing-emotions | fantasy | 1 | 4 | 5 | 4 | 5 | 4 | 5 | 1 | 3 |

Means: a 3.25 · b 3.80 · c 3.90 · d 3.90 · e 4.30 · f 3.70 · g 4.30 · h 3.50 · i 3.25

## Evidence for every score ≤3

- **#1 b=3** obstacle is an absence of knowledge, not a force: «er weiss nicht, wie er dorthin gelangen soll».
- **#1 d=2 / g=2** a three-year-old crossing open water alone: «das Schiff liegt weit draussen auf dem Wasser».
- **#2 d=3** a three-year-old commands the voyage: «Noah ist ein Bub von drei Jahren und segelt auf einem Piratenschiff».
- **#3 b=2** no cost is stated at all; the idea ends on «das Mädchen schaut nicht herüber».
- **#4 a=2** the middle is narrated: «Mias erster Versuch, etwas zu sagen, landet nicht so, wie sie es meint, und das Mädchen wendet sich ab».
- **#4 c=3** the brother has no stake: «ist dabei, hat aber seine eigenen Gedanken darüber, wie das geht».
- **#4 f=3** six sentences (limit five).
- **#5 a=2** names the figure that decides the outcome and the exit condition: «Ein Wächter dieses Reiches hat das Buch jedoch schon seit langer Zeit für sich beansprucht».
- **#5 c=3** the grandmother only waits: «Oma Ruth wartet daheim».
- **#5 f=3** six sentences.
- **#6 a=2** states the test and prescribes the solution: «wer den Turm ohne Einladung betritt, verliert bis zum nächsten Neumond die Stimme … müssen das Buch abliefern, ohne den Eingang zu betreten».
- **#6 c=3** the grandmother is an errand-giver grafted into a fantasy world: «hat die beiden in den Wald geschickt, um Tannenzapfen zu sammeln».
- **#7 a=1** the whole middle is given away: «der Bordcomputer gibt einen Alarm aus, die Landefläche unter ihnen ist falsch, und der Zeiger am Treibstoffmesser sinkt».
- **#7 c=3** the dog is a manufactured role: «Bello: Maskottchen der Besatzung an Bord der Eagle».
- **#7 d=2 / g=1** a six-year-old flies a lander that is running out of fuel — this can kill: «bevor der Treibstoff der Eagle ausgeht».
- **#7 f=2** one sentence of ~100 words carries the entire premise.
- **#8 a=3** the last sentence is a task list, i.e. the middle: «Er muss Nora beruhigen, Bello einfangen … und herausfinden, ob Papa Daniels Nachricht schon irgendwo auf ihn wartet».
- **#9 a=3** the blocking mechanism is pre-solved for the reader: «die einzige Startfläche … liegt auf einem abgesperrten Dach nahe der Hochbrücke, zu dem ihnen der Zugang verwehrt wird».
- **#9 c=3** two of five are a footnote: «ihre Freunde Jonas und Lina schliessen sich an».
- **#9 e=3** the space theme is only a school competition prop: «Bauplänen für eine Miniaturrakete».
- **#9 f=2** six sentences plus ornamental adjectives: «eine verwitterte Kassette», «eine funktionsfähige Rakete».
- **#9 g=3** the goal sits on a sealed roof by the Hochbrücke — height peril for 10-12s.
- **#11 c=2 / #12 c=2** the cast is a packing list: «geht sie mit ihrem Bruder Ben, ihrer Freundin Zara, Mama Sara, Papa Tom und Opa Hans in den Teufelskeller» — four of the six do nothing.
- **#11 e=2 / #12 e=3** the dinosaur theme is a toy and park statues: «den Stein-Dinosaurier, den Opa Hans ihr geschenkt hat», «ihre Stegosaurus-Figur aus Ton».
- **#13 b=2 / #14 b=2** the want is never stated; the cost is a cold hand: «Dann ist ein Fäustling weg — und Lenas Hand ist kalt».
- **#13 c=2 / #14 c=2** the only character is acted upon: «Jemand legt ihr die Kappe auf den Kopf, zieht ihr die Stiefel an und schiebt sie im Kinderwagen los».
- **#13 d=3 / #14 d=3** nothing here is the one-year-old's doing.
- **#13 e=3 / #14 e=3** the farm is an address, not a setting: «Lena lebt auf einem Bauernhof bei Baden».
- **#13 h=3** the topic is going outside, and the idea opens with her already outside.
- **#13/#14** both arms resolve to `location` (farm is a realistic-environment theme) and both tell the same mitten story — the customer sees two versions of one idea.
- **#15 f=2** English section label inside a German output: «ROLES:\nAmir: Orville Wright».
- **#15 a=3** backstory recounted as plot: «Hunderte von Versuchen hinter sich gebracht und nach jedem Absturz neu angefangen».
- **#16 f=3** one 60-word sentence of nested errands: «doch Yara hat in der Nacht zuvor den Auftrag bekommen, die Gruppe der Zeugen … zu zählen und dem Vater zu melden».
- **#18 a=3** the obstacle announces that a non-ordinary force is the answer: «une pierre qu'aucune force ordinaire ne semble pouvoir écarter».
- **#18 f=2** grammatical error: «le pont-levis ne attend personne» (n'attend).
- **#19 a=2** names the object that decides it: «Der Name steht auf einem Stein, den der Drache selbst bewacht».
- **#19 h=1** managing emotions appears nowhere; it is a race for a prize.
- **#20 a=1** the solution is written out: «Das Tor öffnet sich nur, wenn die zwei Kinder … gemeinsam den Schlüsselstein aus der Felskammer am Hang holen — eine Kammer, die nur für zwei Paar Hände zugänglich ist».
- **#20 h=1** the topic is absent; two strangers compete for an apprenticeship.

## Fault classes, ranked (frequency × severity)

| rank | class | n/20 | severity | score |
|---|---|---|---|---|
| 1 | Middle or solution leaked into the premise | 10 | 3 | 30 |
| 2 | Life-skill topic bolted on, not the engine | 5 of 8 LC ideas | 3 | 15 |
| 3 | Output-format drift (over-length, English label, fr grammar, adjectives) | 7 | 2 | 14 |
| 4 | Cast listed rather than present | 6 | 2 | 12 |
| 5 | Peril over the line | 3 | 3 | 9 |
| 6 | Theme present in name only | 3 | 2 | 6 |
| 7 | Both arms tell the same story (realistic-environment life-challenge) | 2 | 2 | 4 |

Class 5 has the highest per-instance severity in the set (#7 puts a six-year-old in a
lander that is running out of fuel) even though it is only third by frequency.

## The three worst classes and a proposed fix for each

No fix applied. Every wording below is generic, terse and carries no justification clause.
`generate-story-idea-single.txt` and `generate-story-ideas.txt` are siblings: each change
lands in both, in the matching `[REVIEW]` checklist.

### 1. Middle or solution leaked into the premise (10/20)

The ban already exists in the RULES block and is still broken half the time. What is missing is
a self-check that cannot be answered with "no issues": check 6 today asks a yes/no question and
the model answers itself out of it. Make it quote, the way the trial idea self-check does.

Replace check 6 in both templates:

> 6. **Back cover, not synopsis**: quote the noun in the draft that a reader would expect to
>    decide the outcome, and quote the sentence that says what happens next. Cut both from [FINAL].
>    If nothing can be quoted, write "nothing to cut".

### 2. Life-skill topic bolted on (5 of 8 life-challenge ideas; two score 1)

The full-wizard life-challenge instruction says only "Show the characters facing this challenge
and learning to handle it" — it never says the topic supplies the obstacle. The trial path
already says it ("names one outside event that forces the child to use this skill"). The full
path's sibling sentence is missing. Two sites:

- `server/routes/storyIdeas.js`, the `life-challenge` branch of `categoryInstructions` — add the
  missing sentence, mirroring the trial wording: *"What stands in the way is this skill being
  hard, met in one outside event — never a feeling on its own."* (This is prompt text living in
  JS; the trial's `categoryContextFor` is its sibling and must keep the same claim.)
- both templates, a new `[REVIEW]` check: *"**Topic**: quote the words where the topic is what
  stands in the way. If the idea reads the same with the topic removed, rewrite it."*

### 3. Cast listed rather than present (6/20)

"All the characters must be mentioned" stays (owner declined removing it); what is missing is
what counts as mentioned. Add one line under it in both templates:

> - A character is in the idea through what they want or what they are answerable for, never
>   through a list of who came along.

and make check 4 quote rather than judge:

> 4. **Characters**: for each name, quote the words that give them a stake. A name with no such
>    words is not in the story yet.

### Also worth a line (not in the top three)

- **Peril (#7, #1, #9)**: the peril rule is one bullet in RULES and has no `[REVIEW]` counterpart
  tied to the youngest age. Check 7 exists but is a yes/no question — the same quoting treatment
  as check 6 would apply.
- **`story-idea-requirements-historical-1.txt`** hard-codes the English label `ROLES:` in its
  format block, which is why #15 emitted an English header inside a German idea. The label needs
  to follow the output language.
