# Round 9 — defect axes only (a, c, g, h, f)

20 ideas, `claude-sonnet-4-6`, USD 1.1356. Round file: `round-9.json` / `round-9.md`.

**The buy axis is NOT rated here.** A separate blind agent reads the 20 ideas cold. This document
rates only the five defect axes, with the same rubric, the same strictness and the same
calibration as rounds 1-8, so the counts are comparable: `a` contract (premise only, no middle and
no ending), `c` cast present with a role, `g` peril, `h` life-skill topic is the engine (scored on
the 8 life-challenge ideas only), `f` language/format on the R1-R4 criteria.

## What changed before this round

One prompt version, three changes, applied to BOTH sibling templates
(`prompts/generate-story-idea-single.txt`, `prompts/generate-story-ideas.txt`, registry set
`story-idea-templates`):

1. **A buy criterion shared by the generator and its critic.** `server/lib/ideaBuyCriterion.js`
   exports one constant `IDEA_BUY_QUESTIONS` — the parent's four questions — filled into both
   templates twice via `{BUY_CRITERION}`: once as a rule the draft answers, once as the LAST review
   check, which answers each question with a quote from [FINAL]. Same shape as
   `server/lib/trialIdeaCheck.js`: one string, so the rule and the check grading it cannot drift.
   Pinned by `tests/unit/idea-buy-criterion.test.ts`.
2. **Examples rewritten to the standard of the blind 5s** (one picturable strange thing, the
   child's own want, a stake a child feels, an eerie or a funny turn, nothing an adult owns).
   Three archetypal examples, identical in both templates.
3. **Prune.** The rule list and the review checklist were cut to the classes the blind read and the
   round evidence showed matter, and the sentence budget plus the CUT step moved to the protected
   tail.

## Ratings

| # | cell | world | a | c | g | h | f | note |
|---|------|-------|---|---|---|---|---|------|
| 1 | 1 pirate | location | 5 | 2 | 5 | – | 3 | clean contract; no responsible person for a 3-year-old at all |
| 2 | 1 pirate | fantasy | 3 | 2 | 2 | – | 2 | the crab «der die Truhe anstupst, wohin er will» is the decider, explained; leaning over the rail above dark water |
| 3 | 2 making-friends | location | 2 | 3 | 5 | 5 | 3 | s3 narrates the attempt AND its outcome; Leo only «ruft» |
| 4 | 2 making-friends | location | 2 | 3 | 4 | 5 | 3 | s2 and s3 narrate the approach and the rejection; Leo «nicht hinschaut» |
| 5 | 3 wizard | location | 3 | 3 | 5 | – | 3 | «ein Tier … das sich für deinen Zauberer hält» explains the hook; Sofia «läuft neben … her» |
| 6 | 3 wizard | fantasy | 2 | 4 | 5 | – | 3 | rule «ohne ihn darf sie morgen nicht zur Zauberprüfung» + s3 narrates the sneak |
| 7 | 4 moon-landing | participant | 2 | 2 | **1** | – | 2 | «Rollen:» header; 1202 alarm narrated; **Bello absent**; cost = Papa alone around the moon «für immer» |
| 8 | 4 moon-landing | fantasy | 2 | 2 | 4 | – | 2 | two narrated middles; **Nora absent** |
| 9 | 5 not-giving-up | location | 2 | 2 | 2 | 5 | 2 | the whole plot narrated; **Lina and Herr Keller absent**; three sentences past 35 words; «der Ersten war, dem» ungrammatical |
| 10 | 5 not-giving-up | fantasy | 3 | 2 | 2 | 3 | 2 | rule + trait pairing «darf laut Protokoll nicht eingreifen — was Finn tut oder lässt»; **Jonas and Lina absent**; EVA on a tether |
| 11 | 6 dinosaur | location | 3 | 2 | 3 | – | 3 | «weil nur sie weiss, welcher Pinsel wem gehört» is the decider; **Ben, Mama Sara, Papa Tom absent**; a 4-year-old alone at the rock towers |
| 12 | 6 dinosaur | fantasy | 3 | 2 | 3 | – | 2 | rule «schnaubt, sobald sich jemand nähert»; **same three absent** |
| 13 | 7 going-outside | location | 4 | 3 | 5 | 2 | 2 | «Mama» by relation; typo «patschn»; she is carried throughout |
| 14 | 7 going-outside | location | 4 | 2 | 5 | 2 | 2 | no want, no promise, no cost — four sentences of scenery; nobody but Lena |
| 15 | 8 wright-brothers | participant | 3 | 5 | 4 | – | 2 | «Rollen:» header; the failed earlier attempt narrated; cost sentence circular |
| 16 | 8 wright-brothers | fantasy | 2 | 4 | 5 | – | 2 | s4 reports the outcome of the historical event; two sentences past 35 words |
| 17 | 9 knight (fr) | location | 4 | 4 | 5 | – | 3 | cleanest contract of the French pair |
| 18 | 9 knight (fr) | fantasy | 3 | 4 | 4 | – | 2 | «Maman Élodie attend … et ne peut rien faire d'ici» is a rule; two dash-joined clauses |
| 19 | 10 managing-emotions | location | 3 | 5 | 3 | 5 | 2 | s4 puts the emotional mechanic on the page; «er friert ein» |
| 20 | 10 managing-emotions | fantasy | 3 | 5 | 4 | 5 | 3 | s3 narrates Mila finding the chick before Jonas can act |

Means: **a 2.90 · c 3.05 · g 3.80 · h 4.00 · f 2.40**

## Means vs R8

| axis | R1 | R5 | R6 | R7 | R8 | **R9** | Δ R8→R9 |
|---|---|---|---|---|---|---|---|
| a contract (premise only) | 3.25 | 3.65 | 3.15 | 3.15 | 3.60 | **2.90** | **−0.70** |
| c cast present with a role | 3.90 | 4.65 | 4.40 | 4.40 | 4.30 | **3.05** | **−1.25** |
| g peril | 4.30 | 4.65 | 4.30 | 4.30 | 4.30 | **3.80** | **−0.50** |
| h topic is the engine | 3.50 | 4.50 | 4.38 | 4.38 | 4.38 | **4.00** | −0.38 |
| f language/format | 3.70 | 3.90 | 3.35 | 3.60 | 3.45 | **2.40** | **−1.05** |

## Fault classes, count out of 20

| class | R5 | R6 | R7 | R8 | **R9** |
|---|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 9 | 13 | 12 | 12 | **18** |
| — as a narrated event | 3 | 7 | 8 | 5 | **12** |
| — as a stated rule or gate | 7 | 6 | 4 | 5 | **6** |
| — as a trait paired with the obstacle | – | – | – | 2 | **2** |
| Cast listed rather than present (c≤3) | 3 | 3 | 3 | 5 | **14** |
| — **a cast member missing from the idea entirely** | – | – | – | 0 | **6** |
| Output-format drift (f≤3) | 5 | 11 | 7 | 12 | **20** |
| — a dash holding two clauses | 11 | – | – | 9 | **14** |
| — a sentence past ~30 words | – | – | – | 5 | **9** |
| — a `Rollen:`/`ROLES:` header block | 0 | 0 | 0 | 0 | **2** |
| Peril over the line (g≤3) | 2 | 3 | 3 | 4 | **6** |
| Theme present in name only | 3 | 2 | 2 | 3 | **2** |
| Life-skill topic bolted on (h≤3) | 2 | 1 | 1 | 2 | **2** |
| Idea with no promise sentence | – | – | – | 1 | **2** |
| Idea with no cost sentence | – | – | – | 0 | **1** |
| Both arms tell the same story | 4 | 2 | 2 | 2 | **1** |

## What the round measured

**The prune is not free, and it is not cheap.** Every class whose review check was cut regressed,
and the size of each regression tracks what was removed:

- **Cast, 5 → 14, and six ideas simply leave a commissioned character out.** R8's check 4 asked for
  a quote per name; R9's check 2 asks the same thing but no longer sits behind a "Complexity" check
  or a five-improvement list that forced a second pass over the cast. The new failure is not the R8
  one (a relation instead of a name) — it is **omission**: Bello, Nora, Lina, Herr Keller, Jonas,
  Ben, Mama Sara and Papa Tom are absent from ideas whose cells commissioned them. This class was
  at 0 for eight rounds. The large casts (cells 4, 5, 6) carry all six.
- **Format, 12 → 20, i.e. every idea in the round.** The dash rule was removed per the round-9
  brief; dash-joined clauses went 9 → 14, and — not predicted — sentences past ~30 words went
  5 → 9 and the `Rollen:` header block reappeared after eight rounds at zero. The sentence budget
  and the 30-word bound survived the prune and moved to the tail; the header ban and the dash rule
  did not survive, and both classes came straight back. **Position did not substitute for the
  rule.**
- **Contract, 12 → 18 (a 3.60 → 2.90).** The labelling step and the CUT step are both still in the
  prompt, and the CUT lists are still honest — but the checks that used to catch a leak *before* it
  reached the label step (logic/consistency, opening, the five-improvement pass) are gone, and
  narrated middles doubled, 5 → 12.
- **Peril, 4 → 6, and cell 4 is the worst reading of the series.** The Apollo lander is a
  **ninth-of-nine-rounds** miss: «Wenn der Treibstoff aufgebraucht ist … kreist Papa Daniel allein
  um den Mond — für immer» is the R4 wording (g=1) verbatim in spirit. Check 7 is unchanged from
  R8, so this is not a prune casualty; it is the one class nine rounds of prompt work have never
  moved.
- **Topic held (4.38 → 4.00, 2/20 bolted-on).** The life-challenge outside-event sentence is
  route-side and was not touched, and it is the only lever in this series that has held its class
  across five rounds.
- **Cell 7 is no longer the only duplicated pair — it is now the only pair where neither arm has a
  premise at all.** #14 has no want, no promise and no cost. A cast of one one-year-old with no
  adult in the inputs is the ninth round of the same failure.

**The template shrank; the prompt did not.** The single template went 1971 → 1766 words, but the
built prompt is 20-25k characters and the template is ~4% of it — cell-by-cell the sent prompt
moved by between −875 and +598 characters. If prompt length is what was drowning the rules (the R8
hypothesis), pruning the template cannot test it: the age band, the challenge catalogue, the topic
guide and the landmark block are the prompt.

**What this round cannot say** is whether the buy criterion worked. That is the blind agent's read,
and it is the only number that decides whether this version ships. The honest framing for that
decision: R9 trades a broad, measurable defect regression for whatever the criterion and the new
examples bought on the buy axis. If the blind mean is not well past 3.50, the trade is a loss and
the cut checks go back — individually, so the next round is a single-variable step.
