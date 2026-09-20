# Round 3 — ratings (after the three round-2 fixes)

20 ideas, `claude-sonnet-4-6`, USD 0.6676. Rated by reading, no judge call.
Same rubric and same strictness as rounds 1 and 2: (a) contract — premise only; (b) concreteness
of want/obstacle/cost; (c) cast present with a role; (d) age fit youngest+oldest; (e) world/theme
fit, no leak; (f) language + format; (g) peril line; (h) life-skill topic is the engine (n/a
elsewhere); (i) would a Swiss parent buy this.

Applied before this round, in both templates (`generate-story-idea-single.txt`,
`generate-story-ideas.txt`): check 6 bound to [FINAL] ("Neither quoted string may appear in
[FINAL]") plus an explicit `CUT:` output step between the improvements and [FINAL]; the RULES /
REQUIRED line "The last sentence states what failing costs. Nothing comes after it."; check 7
rewritten to name the youngest character and their age and quote the placement words. Plus
`story-idea-requirements-historical-1.txt`: the role-list heading now follows the output language
(the literal `ROLES:` label is gone from the format block and from all four examples).

| # | cell | world | a | b | c | d | e | f | g | h | i |
|---|------|-------|---|---|---|---|---|---|---|---|---|
| 1 | 1 pirate, Noah 3 | location | 5 | 5 | 5 | 3 | 4 | 4 | 5 | – | 3 |
| 2 | 1 pirate | fantasy | 5 | 4 | 5 | 3 | 5 | 4 | 5 | – | 3 |
| 3 | 2 making-friends | location | 2 | 4 | 5 | 5 | 5 | 4 | 5 | 4 | 3 |
| 4 | 2 making-friends | location | 3 | 3 | 4 | 5 | 5 | 3 | 5 | 2 | 2 |
| 5 | 3 wizard | location | 2 | 3 | 3 | 4 | 4 | 4 | 4 | – | 3 |
| 6 | 3 wizard | fantasy | 4 | 5 | 5 | 5 | 5 | 5 | 5 | – | 4 |
| 7 | 4 moon-landing | participant | 2 | 4 | 4 | 3 | 5 | 5 | 1 | – | 2 |
| 8 | 4 moon-landing | observer | 5 | 5 | 5 | 5 | 5 | 5 | 5 | – | 4 |
| 9 | 5 not-giving-up | location | 2 | 5 | 5 | 5 | 4 | 3 | 2 | 5 | 3 |
| 10 | 5 not-giving-up | fantasy | 2 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 |
| 11 | 6 dinosaur | location | 4 | 5 | 3 | 5 | 3 | 4 | 5 | – | 3 |
| 12 | 6 dinosaur | fantasy | 3 | 5 | 5 | 5 | 4 | 3 | 5 | – | 3 |
| 13 | 7 going-outside | location | 3 | 2 | 2 | 3 | 3 | 5 | 5 | 3 | 2 |
| 14 | 7 going-outside | location | 3 | 2 | 2 | 3 | 3 | 5 | 5 | 3 | 2 |
| 15 | 8 wright-brothers | participant | 4 | 5 | 5 | 4 | 5 | 5 | 4 | – | 4 |
| 16 | 8 wright-brothers | observer | 4 | 5 | 5 | 4 | 5 | 5 | 5 | – | 4 |
| 17 | 9 knight (fr) | location | 4 | 5 | 5 | 5 | 5 | 5 | 5 | – | 4 |
| 18 | 9 knight (fr) | fantasy | 4 | 5 | 5 | 5 | 5 | 5 | 5 | – | 4 |
| 19 | 10 managing-emotions | location | 2 | 4 | 5 | 5 | 4 | 3 | 5 | 5 | 3 |
| 20 | 10 managing-emotions | fantasy | 2 | 3 | 5 | 5 | 5 | 3 | 5 | 5 | 3 |

Means: a 3.25 · b 4.20 · c 4.40 · d 4.35 · e 4.45 · f 4.20 · g 4.55 · h 4.00 · i 3.15

| axis | R1 | R2 | R3 | Δ R2→R3 |
|---|---|---|---|---|
| a contract | 3.25 | 3.10 | 3.25 | +0.15 |
| b concreteness | 3.80 | 4.25 | 4.20 | −0.05 |
| c cast present | 3.90 | 4.40 | 4.40 | 0.00 |
| d age fit | 3.90 | 4.00 | 4.35 | **+0.35** |
| e world/theme | 4.30 | 4.45 | 4.45 | 0.00 |
| f language/format | 3.70 | 4.10 | 4.20 | +0.10 |
| g peril | 4.30 | 4.15 | 4.55 | **+0.40** |
| h topic is the engine | 3.50 | 4.00 | 4.00 | 0.00 |
| i would buy | 3.25 | 3.25 | 3.15 | −0.10 |

## Evidence for every score ≤3

- **#1 d=3** a three-year-old walks from the Landvogteischloss to the Ruine Stein alone, racing a rival crew: «Noah will ihn haben, bevor die Sonne hinter dem Schlossberg verschwindet». Milder than R2 (no dusk, no Limmat) but still a toddler out alone.
- **#1 i=3** the buyer still sees a three-year-old unaccompanied.
- **#2 d=3** the three-year-old still holds the ship: «Noah steht auf dem Deck eines Piratenschiffs».
- **#2 i=3** same toddler-alone problem.
- **#3 a=2** the middle is narrated a third round running: «Ihr erster Versuch landet falsch — das Mädchen dreht sich weg — und die Pause … geht zu Ende».
- **#3 i=3** competent, but cell 2's two arms are again one idea.
- **#4 a=3** the event is narrated: «doch als sie hingeht, rollen die Kastanien durch einen Schritt über den Weg».
- **#4 b=3** no cost is stated; «die Zeit läuft» is not a loss.
- **#4 f=3** that same clause is not German anyone writes; «grossen Menge».
- **#4 h=2** the obstacle is spilled chestnuts, not the difficulty of joining in — the topic is back to being scenery.
- **#4 i=2** the weaker of two ideas that are the same idea.
- **#5 a=2** names the decider object and the middle: «öffnet das Buch einen Turm … darin steht ein Kristallstab», «aber der Turm lässt sie nicht einfach wieder heraus».
- **#5 b=3** the cost clause does not parse as a condition: «bevor Oma Ruth das Zauberbuch in ihren Händen sieht».
- **#5 c=3** Oma Ruth waits in the flat again, exactly the R1 finding: «während Oma Ruth in der Wohnung auf sie wartet».
- **#5 i=3** the reader cannot follow what losing looks like.
- **#7 a=2** the middle is still handed over: «Dann schlägt der Computer Alarm, und der Treibstoff in der Eagle sinkt schneller». No decision sentence this time, so 2 rather than R2's 1.
- **#7 d=3** a nine- and a six-year-old fly the lander — the participant concept, but at this peril level.
- **#7 g=1** unmoved across all three rounds: «Wenn Luca keinen sicheren Boden findet, bevor die Vorräte enden, kehrt die Eagle nie zurück». The new check 7 names exactly this case ("a vehicle with a supply running out") and the model still shipped it.
- **#7 i=2** unsellable at this peril level.
- **#9 a=2** the mechanism and the per-character assignments are written out: «wobei jeder Fehlversuch das Gerät für Stunden sperrt», «Lina ist die Einzige, die die technischen Unterlagen lesen kann».
- **#9 f=3** the third sentence runs ~60 words across two dashes.
- **#9 g=2** a crewed station whose life support fails in three days — people could die: «Ihre Lebenserhaltungssysteme fallen in drei Tagen aus».
- **#9 i=3** the peril belongs to strangers off-page.
- **#10 a=2** the middle and the withheld solution: «nach dem vierten Fehlschlag erklärt Herr Keller … das Modul für unreparierbar», «sie haben eine Idee, die Finn und Alina noch nicht bereit sind, ernstzunehmen».
- **#11 c=3** three of six are back to a packing list: «wohnt mit Bruder Ben, Mama Sara, Papa Tom und Opa Hans in Baden»; Zara is along for the walk.
- **#11 e=3** the dinosaur theme is a footprint legend at a Swiss ruin: «von Fussspuren erzählt, die Dinosaurier einst in den Felsen hinterlassen haben sollen».
- **#11 i=3** the same.
- **#12 a=3** the middle starts and a trait is paired with the obstacle: «Ben … hat das Heft zuletzt in einem anderen Teil des Geländes gesehen und läuft mit ihr», «Zara kann das Heft nicht … unterscheiden, weil sie nicht weiss, wie Opa Hans seine Sieben schreibt».
- **#12 f=3** five sentences, the fourth ~60 words — a plot summary by length.
- **#12 i=3** long and busy for a 14-page book at 1st-grade level.
- **#13 b=2 / #14 b=2** the want is still never stated; the cost is still a cold hand: «Die Hand, die jetzt offen ist, wird kalt», «Ohne ihn ist Lenas Hand kalt».
- **#13 c=2** the one-year-old is only acted upon and nobody is named as acting: «Sie wird in den Kinderwagen gesetzt … und nach draussen gebracht».
- **#14 c=2** worse — the actor is an anonymous pronoun: «Jemand schiebt den Wagen».
- **#13 d=3 / #14 d=3** nothing here is the one-year-old's doing.
- **#13 e=3 / #14 e=3** the farm is still an address: «wohnt auf einem Bauernhof am Rand von Baden».
- **#13 a=3 / #14 a=3** the middle is the whole text: «Unterwegs fällt ihr Fäustling in die Herbstblätter».
- **#13 h=3 / #14 h=3** going outside is the occasion, not what stands in the way.
- **#13 i=2 / #14 i=2** the third round in which both arms tell the mitten story.
- **#19 a=2** the rule that decides the outcome, stated in full: «Der Drache weigert sich, irgendjemanden durchzulassen, der ihm mit Wut oder Ungeduld gegenübertritt, und jedes Mal, wenn einer der beiden die Beherrschung verliert, zieht er sich tiefer in die Felsen zurück».
- **#19 f=3** the closing sentence is ungrammatical: «wer zu spät kommt, verliert Jonas seinen Platz im Schulprojekt und Mila ihren einzigen Beweis».
- **#19 i=3** good premise, broken last line.
- **#20 a=2** the mechanism again: «bemerkt, dass der eigene Ärger … das Einzige ist, das den Drachen wirklich interessiert, und zwar auf eine Weise, die den Weg versperrt».
- **#20 b=3** the want is an unnamed something, which the concreteness rule forbids by name: «etwas bringen muss, das er verlangt».
- **#20 f=3** ~50-word sentences, adjective pile: «der heisse, enge Ärger».
- **#20 i=3** the premise is a lesson stated, not a hook.

## Did the three targeted classes move?

| targeted class | R1 | R2 | R3 | verdict |
|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 10 | 11 | 11 | count flat, **severity down** — no a=1 this round (R1 and R2 each had two) |
| Peril over the line (g≤3) | 3 | 4 | 2 | **halved** |
| English `ROLES:` label (f, historical participant) | 2/2 | 2/2 | **0/2** | **gone** |

The `CUT:` step ran on all 20 ideas — every reply emitted one, and every string it nominated is
genuinely absent from [FINAL] (cell 2 arm 1 cut «und Mia weiss nicht, wie sie es ein zweites Mal
versuchen soll»; cell 4 arm 1 cut «von Hand nach einer ebenen Stelle suchen», «während die Anzeige
sinkt»). Binding the check to [FINAL] plus an explicit output step converted the quotation into a
cut, which round 2's wording had not. What it did not do is find *all* the leaks: the check asks
for "the noun" and "the sentence", singular, so the model nominates one, removes it, and ships the
next one. That is the whole residual: a≤3 is flat at 11 while no idea is catastrophic any more.

Peril moved on the named cases (the rising tide of R2 #2 is now an ebb that buries the chest, the
four-year-olds are out of the caves) and cost nothing elsewhere. The two survivors are both cases
the check's own list does not cover cleanly: #7's «Vorräte enden» is the vehicle clause and was
shipped anyway, and #9's peril belongs to off-page adults, whom "the youngest character" does not
name.

Removing the literal `ROLES:` fixed the format drift outright — both participant ideas open with
«Rollen:» and both scored f=5, up from 2.

## Regressions

- **Both arms tell the same story: 2 → 4 ideas.** Cell 7 again (the mitten, twice), and now cell 2
  as well (the same park, the same girl with the same object, the same brother-minding frame). Both
  cells are realistic-environment life-challenges where `resolveIdeaWorlds` returns `location`
  twice; the second instruction asks only for "different local places". This is the class that got
  worse, and it costs `i` directly — four of the five ideas scoring i≤2 are half of a duplicated pair.
- **Cast listed rather than present: 3 → 4** (#5, #11, #13, #14). #11 reverted to the R1 packing
  list for three of six; #5 put Oma Ruth back in the flat.
- **Topic bolted on: 2 → 3** (#4 new). Concreteness pulled the obstacle toward a physical accident
  (spilled chestnuts) and away from the life skill — the same tension that moved peril in R2.
- **i 3.25 → 3.15.** Noise around a flat class; the duplicate pairs are what hold it down.

## Fault classes, ranked (frequency × severity)

| rank | class | n/20 | severity | R3 score | R2 score | R1 score |
|---|---|---|---|---|---|---|
| 1 | Middle or solution leaked into the premise | 11 | 3 | 33 | 33 | 30 |
| 2 | Both arms tell the same story (realistic-environment) | 4 | 3 | 12 | 4 | 4 |
| 3 | Output-format drift (over-length, broken sentence, adjectives) | 5 | 2 | 10 | 10 | 14 |
| 4 | Cast listed rather than present | 4 | 2 | 8 | 6 | 12 |
| 5 | Peril over the line | 2 | 3 | 6 | 12 | 9 |
| 5 | Life-skill topic bolted on | 3 | 2 | 6 | 6 | 15 |
| 5 | Theme present in name only | 3 | 2 | 6 | 6 | 6 |
| 8 | English `ROLES:` label | 0 | – | 0 | 4 | 4 |

## The next three worst classes and a proposed fix for each

Not applied.

### 1. Middle or solution leaked into the premise (11/20, count flat for three rounds)

The `CUT:` step proved the model will delete what it nominates. It nominates one thing. Make the
check exhaustive and make it read [FINAL], not the draft. Replace check 6 in both templates:

> 6. **Back cover, not synopsis**: number the sentences of [FINAL]. For each one after the first,
>    write "setup" or "event". Every sentence marked "event" other than the last is cut. The last
>    sentence states the cost and is kept.

and keep the `CUT:` line, listing the numbers.

### 2. Both arms tell the same story (4/20, up from 2)

`resolveIdeaWorlds` returns `location` for both arms on a realistic-environment life-challenge, and
the second prompt's instruction ("different local places, a different approach to the conflict, a
different story structure") is not something the model can check itself against — it never sees the
first idea. Two shapes, owner's call: (a) in `storyIdeas.js`, give the second realistic arm a named
axis to vary — a different place class (indoors vs outdoors, home vs public) and a different person
answerable for the child; or (b) pass the first arm's [FINAL] into the second prompt with "share no
location, no object and no other person with this". (b) serialises the two calls, which costs
wall-clock on the live wizard; (a) does not.

### 3. Cast listed rather than present (4/20, up from 3) — and its one-year-old variant

Check 4 already asks for a quoted stake per name, and it passes while #11 ships «wohnt mit Bruder
Ben, Mama Sara, Papa Tom und Opa Hans in Baden». The check accepts co-location as a stake. Tighten
it in both templates:

> 4. **Characters**: for each name, quote the words that give them a stake. Living with, coming
>    along with, or waiting for the others is not a stake. A name with no such words is not in the
>    story yet.

plus one RULES line for the one-year-old cell, where the fault is that the protagonist is only
acted upon:

> - The youngest main character does something in the idea, and whoever is responsible for them is
>   named.

### Also worth a line (not in the top three)

- **Theme in name only (#11, #13, #14)**: a theme that resolves to a local legend or a home address.
- **Peril's two survivors (#7, #9)**: the check's list names "a vehicle with a supply running out"
  and #7 ships exactly that; and #9's peril is carried by off-page adults, whom "the youngest
  character" does not reach. Peril has to be checked for anyone on the page, not only the youngest.
