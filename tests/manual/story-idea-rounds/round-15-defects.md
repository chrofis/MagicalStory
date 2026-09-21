# Round 15 — defect axes only (a, c, g, h, f)

20 ideas, `claude-sonnet-4-6`, USD 0.9948. Round file: `round-15.json` / `round-15.md`.

**The buy axis is NOT rated here.** A separate blind agent read all 60 texts of R1, R10 and R15
pooled in one shuffle (`blind-set-r15.md` → `blind-scores-r15.md` →
`analyze-blind.js --rounds=1,10,15`). This document rates only the five defect axes, with the same
rubric, the same strictness and the same calibration as rounds 1-10, so the counts are comparable:
`a` contract (premise only, no middle and no ending), `c` cast present with a role, `g` peril,
`h` life-skill topic is the engine (scored on the 8 life-challenge ideas only), `f` language/format
on the R1-R4 criteria. A leading `Rollen:` block is an occurrence, not a fault (R10 rubric change).

## What this round is

R15 = R14's prompt state (the idea-shaped guide, `5c855e367`) plus the three fixes the round-10
blind pointed at — the arm-2/fantasy handicaps, all measured on one confounded pair of axes
(arm 2 3.70 vs arm 1 4.10; fantasy 3.63 vs location 4.08):

1. the blind "Create a DIFFERENT story. Use a different location, different approach to the
   conflict, and different story structure." is gone from the second arm, in
   `buildVariantInstructions` and in the two-idea template's `[DRAFT_2]` framing; so is
   "Start directly in the adventure world";
2. `story-idea-requirements-adventure-2.txt` no longer orders the idea to ignore the user's
   location, to start directly in the world, and to have no transition from real life — the idea
   plays in the world of the theme, may open at home or already inside it, and may carry a stake at
   home;
3. the fantasy arm is handed ONE concrete place from its own world guide (`pickWorldPlace`,
   `{WORLD_PLACE}`), the way the location arm is handed named landmarks.

## Ratings

| # | cell | world | a | c | g | h | f | note |
|---|------|-------|---|---|---|---|---|------|
| 1 | 1 pirate | location | 2 | 5 | 3 | – | 5 | «er klettert allein die Treppe zum Deck hinauf» and the gull nudging the chest are narrated; a 3-year-old alone up to a deck over the Limmat |
| 2 | 1 pirate | fantasy | 4 | 5 | 5 | – | 5 | four sentences, want-obstacle-cost and nothing narrated; the father casting off is the home stake the new requirements allow — but thin |
| 3 | 2 making-friends | location | 2 | 5 | 5 | 5 | 3 | «Mia hält ihm ihre Kastanie hin und sagt, er soll gehen» narrates the attempt; two dashes |
| 4 | 2 making-friends | location | 2 | 4 | 5 | 5 | 5 | s4 and s5 narrate the approach AND the refusal; Leo's promise gives him a stake, but he only waits |
| 5 | 3 wizard | location | 3 | 5 | 5 | – | 3 | «krächtzt» is misspelt; an appositive dash; the raven singling Sofia out is the best obstacle of the round |
| 6 | 3 wizard | fantasy | 3 | 5 | 3 | – | 3 | «wartet ein Jahr» is a stated rule; **Sofia is present with her own promise** (absent in R10); two en-dashes; a mist bridge over floating islands for two 7-year-olds |
| 7 | 4 moon-landing | participant | 3 | 3 | 2 | – | 5 | `Rollen:` block (by design); Bello is in the block and nowhere in the prose; fuel running out with a 9-year-old on the controls |
| 8 | 4 moon-landing | fantasy | 2 | 5 | 5 | – | 5 | two narrated middles, and the last sentence is an outcome, not a cost |
| 9 | 5 not-giving-up | location | 4 | 5 | 2 | 4 | 4 | cleanest contract of the round, five names with five stakes; but Jonas locked in a detaching capsule is the never-coming-back class |
| 10 | 5 not-giving-up | fantasy | 2 | 5 | 3 | 5 | 2 | a stated docking rule, the failing connections and the corridor crossing all narrated; two dashes; one sentence past 30 words |
| 11 | 6 dinosaur | location | 2 | **1** | 4 | – | 5 | **Ben absent entirely**; Mama Sara and Papa Tom only wait at the bridge; «Emma hält dem Jungen die Hand hin» narrates the middle |
| 12 | 6 dinosaur | fantasy | 2 | 4 | 4 | – | 3 | the last-but-one sentence narrates the RESOLUTION; Zara only nods; one clause-joining dash |
| 13 | 7 going-outside | location | 2 | 5 | 3 | 5 | 5 | the pursuit is narrated across two sentences; the want is sensory and the doing is the child's, with Mama letting go rather than carrying; a 1-year-old running the Limmat jetty |
| 14 | 7 going-outside | location | 2 | 2 | 5 | 5 | 5 | «Lena tapst ihm nach» narrates it; **no adult anywhere** for a 1-year-old |
| 15 | 8 wright-brothers | participant | 2 | 5 | 4 | – | 3 | `Rollen:` block (by design); the second attempt and the lever pull are both narrated; one sentence ~35 words |
| 16 | 8 wright-brothers | fantasy | 2 | 5 | 5 | – | 3 | «Amir nimmt Yara auf die Schultern» narrates it; two en-dashes; Yara's own following stake is real |
| 17 | 9 knight (fr) | location | 3 | 5 | 5 | – | 4 | «Chloé traverse la cour en courant» stages rather than promises; Maman responsible for two children and seeing one is a fine stake |
| 18 | 9 knight (fr) | fantasy | 3 | 5 | 3 | – | 5 | «Chloé s'enfonce seule dans le bois» narrates it; a 6-year-old alone in a wood at dusk; the mother recast INTO the world as Dame Élodie is the home stake working |
| 19 | 10 managing-emotions | location | 2 | 5 | 5 | 5 | 5 | «er weicht zurück, sobald jemand laut wird» is a stated rule and puts the emotional mechanic on the page |
| 20 | 10 managing-emotions | fantasy | 3 | 5 | 3 | 5 | 5 | the dragon turning away is narrated; flying a ridge in fog at eight; **Mila's brother waiting on the clearing is a home stake inside the fantasy world** |

Means: **a 2.50 · c 4.45 · g 3.95 · h 4.88 · f 4.15**

## Means vs R10

| axis | R1 | R8 | R9 | R10 | **R15** | Δ R10→R15 |
|---|---|---|---|---|---|---|
| a contract (premise only) | 3.25 | 3.60 | 2.90 | 2.95 | **2.50** | **−0.45** |
| c cast present with a role | 3.90 | 4.30 | 3.05 | 4.10 | **4.45** | **+0.35** |
| g peril | 4.30 | 4.30 | 3.80 | 3.50 | **3.95** | **+0.45** |
| h topic is the engine | 3.50 | 4.38 | 4.00 | 4.75 | **4.88** | +0.13 |
| f language/format | 3.70 | 3.45 | 2.40 | 4.10 | **4.15** | +0.05 |

## Fault classes, count out of 20

| class | R8 | R9 | R10 | **R15** |
|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 12 | 18 | 14 | **18** |
| — as a narrated event | 5 | 12 | 11 | **16** |
| — as a stated rule or gate | 5 | 6 | 5 | **2** |
| — as a trait paired with the obstacle | 2 | 2 | 1 | **0** |
| Cast listed rather than present (c≤3) | 5 | 14 | 4 | **3** |
| — **a cast member missing from the idea entirely** | 0 | 6 | 2 | **1** |
| Output-format drift (f≤3) | 12 | 20 | 8 | **7** |
| — a dash holding two clauses | 9 | 14 | 8 | **6** |
| — a sentence past ~30 words | 5 | 9 | 1 | **2** |
| — a misspelt word | – | – | – | **1** |
| — a `Rollen:`/`ROLES:` header block | 0 | 2 | 2 | **2, not a fault** |
| Peril over the line (g≤3) | 4 | 6 | 8 | **8** |
| Theme present in name only | 3 | 2 | 0 | **0** |
| Life-skill topic bolted on (h≤3) | 2 | 2 | 0 | **0** |
| Idea with no promise sentence | 1 | 2 | 0 | **0** |
| Idea with no cost sentence | 0 | 1 | 0 | **1** |
| Both arms tell the same story | 2 | 1 | 1 | **1** |

## What the round measured on the three fixes

**The concrete place landed on every fantasy arm that had one to land on: 6 of 6.** The four
adventure fantasy arms and the two life-challenge fantasy arms each name the place the code picked
— ships (#2), the Floating Islands (#6, «Auf den Schwimmenden Inseln»), the river plain (#12, «Auf
der Flussebene»), an amber forest for the knight world (#18), the research station (#10), the valley
of mist (#20, «über dem Nebeltal»). The two historical arms correctly got no place line (no
adventure guide). No fantasy arm opens on invented scenery with no name.

**The home stake the new requirements allow is being used, and it is not a transition scene.** Four
of the six fantasy arms carry one: the father casting off (#2), Oma Ruth losing her spells (#6),
Yara following (#16), Mila's brother waiting on the clearing (#20); and #18 recasts the mother
herself into the world as Dame Élodie, which is the shape the old "IGNORE the user's location
completely / no transition from real life" rule forbade outright. None of them spends a sentence
travelling from the real town into the world.

**Cast omission is nearly closed on the fantasy arm — and moved to the location arm.** R9 had 6
missing cast, R10 had 2 (Sofia on #6, Zara on #12), both on second/fantasy arms of the two largest
casts. In R15 **both of those are fixed**: Sofia now carries the same promise and is the only one
who ever made the guard laugh; Zara is thin («steht hinter ihm und nickt») but present. The one
remaining omission is Ben on #11 — the **location** arm of the same six-name cell — so the class is
no longer an arm-2 phenomenon.

**Peril recovered a little (8 → 8 by count, 3.50 → 3.95 by mean) but the two classes are unchanged.**
The count is still 8; what improved is severity, not incidence. Height is 5 of the 8 (#1 a
3-year-old alone up onto a deck over the river, #6 a mist bridge, #13 a 1-year-old on a jetty, #18
a wood at dusk, #20 a ridge in fog) and never-coming-back is 2 (#7 fuel out with Papa Daniel alone
behind the moon, #9 Jonas on the wrong side of the hatch). Check 7 is untouched since R8. **This
remains the class no prompt round has moved, and it is the one to fix next.**

**Contract got worse: a 2.95 → 2.50, narrated middles 11 → 16.** This is the honest bad news of the
round and it is the same failure R10 named: the model stages the attempt *already under way*
(«er klettert allein die Treppe hinauf», «Mia hält ihm ihre Kastanie hin», «Lena tapst ihm nach»,
«Amir nimmt Yara auf die Schultern»). Two things changed at once and only one of them can be blamed
cleanly: the R14 cut removed `{SCENE_COMPLEXITY_GUIDE}` and the challenge catalogue from both
templates, and R15 removed the second arm's structural instruction. The stated-rule shape of the
leak collapsed (5 → 2), so the leak did not disappear, it changed form — the checklist asks for the
leak to be labelled and cut, and never stops the sentence being written. Ten rounds of checklist
work have not moved this class, and R10 already recorded that the blind rater does not punish it:
**contract and buy are pulling apart, and contract is the axis with no buy-side pressure behind
it.**
