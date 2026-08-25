# Story text quality — provenance trace of 15 defects

**Story:** `job_1787638707796_x8272kcs22m` — "Levin und der kleine Drache", de-CH,
1st-grade, 18 pages, 4 characters, watercolor. Generated 2026-08-25 06:18 CH.
avgQualityScore 69, totalCost CHF 3.53.

**Method:** read the child-facing text only, listed what works and what doesn't, then walked
every stored pipeline artifact backwards — `storyDetails` (idea) → `outline` ARC →
`arcReviewReport.audit` + `.analysis` (arc critique + refined arc) → `outline` PAGE PLAN →
`beatsReviewReport.briefsIn` (draft beats) → `outline` BEATS REVIEW (beats critique) →
`outline` BEATS (refined beats) → `storyText` (writer output) → `textRefineReport`
(continuity audit + refined text) → `sceneImages[].text` (what the child reads).

**Headline finding:** the text is structurally sound and stylistically damaged, and almost
all of the stylistic damage is *manufactured downstream by the review stages*, not by the
writer. Three review stages each fix a real fault by adding logistics to the prose, and each
one pays for the added logistics by deleting an emotional or characterising sentence, because
they all work under an implicit constant page length.

Measured on this story:

| Stage | Faults fixed | Emotional/characterising sentences destroyed | New defects introduced |
|---|---|---|---|
| Arc review (`story-arc-audit` + `story-arc-review`) | 8 | 0 | 2 (bike thread, front-loaded lore) |
| Beats review (`story-beats-audit` + `story-beats-review`) | 18 ledger items | 3 | 1 (prop state written into BEAT) |
| Text refine (`story-text-audit` + `text-refine`) | 14 | 8 | 3 (wade contradiction, time-stamps, travelogue openers) |

---

## What works — keep these, they are load-bearing

1. **The Chekhov's gun is genuinely well built.** The gold Znüni foil is planted on p4 as an
   incidental (the dragon noses it), carried through pp. 6–14, fires on p16, returns on p17.
2. **Four co-leads, four distinct functions, no dead weight.** Levin patience/lead, Max speed,
   Julian eyes/carrier, Kiaan knowledge.
3. **p13** — Levin crouches and waits, "Er drängt nicht und zieht nicht." Shown, not stated.
   The single best page.
4. **Real local geography** — Uetliberg, Burg Manegg, the Limmat footbridge.
5. **Swiss usage is correct throughout** — Znüni, Velo, Buben, guillemets, `ss` everywhere.

---

## T1 — Prop bookkeeping is written into the child-facing prose

**Symptom.** "Julian hält die Folie" appears on seven pages (6, 7, 8, 10, 14, 17, 18); Max's
Velo is inventoried on 5, 6, 8, 10, 14, 17, 18. p8 ends "Julian hält die Folie fest. Max hält
sein Velo neben sich, die Räder sind nass." A child hearing this read aloud hears a props list.

**Where it enters — the beats review, precisely.**
Draft beat p17 (`beatsReviewReport.briefsIn[16]`) ends: *"All four boys watch it go."*
Refined beat p17 (outline BEATS) ends: *"Julian holds the foil again. Max's bike stands
beside him."* The BEATS REVIEW ledger states the reason: *"p18 bike last leaned at the ruin →
fixed on p10, p14, p17"* and *"p18 foil back with Julian unshown → fixed on p17"*.

The reviewer had two places to record prop state — the BEAT line and the SCENE line — and
put it in the BEAT. `story-text-from-beats.txt` tells the writer *"BEAT is what happens on
that page"* and *"Do not narrate staging"*. A prop in the BEAT is therefore not staging to
the writer; it is an event, and it gets narrated. The rule against staging exists and is
correctly worded; the beats reviewer routes around it.

**Fix (prompt, `story-beats-review.txt`).** Prop-continuity fixes may only be written into
the SCENE line, never the BEAT. Add to §Delivery / the ledger contract: *"A held or carried
object whose only job on this page is continuity goes in SCENE. BEAT carries only what
changes."* Mechanical check available: flag any refined BEAT that gained a clause naming a
prop already established, with no verb of change.

---

## T2 — The text-refine stage deletes emotion to pay for logistics

**Symptom.** Almost no interiority in 18 pages. One emotional beat survives ("Sein Mund
bleibt offen", p7).

**Where it enters — `text-refine.txt`, measurably.** Eight deletions, all in the refine pass:

| Page | Writer wrote | Refiner replaced it with |
|---|---|---|
| 1 | "Levin und **sein kleiner Bruder** Julian gehen den Waldweg entlang, **als Julian innehält**" | "Levin und Julian hocken am Fuss des grossen Baumes." |
| 4 | "…den Weg zurück. **Er dreht sich fast um.**" | "…den Weg zurück." *(sentence deleted)* |
| 6 | "Julian schaut bachaufwärts, **tief und aufmerksam, wie er es immer tut**" | "Julian schaut bachaufwärts und zeigt mit dem Arm." |
| 7 | "**Julians Gesicht ist wie eingefroren.**" | "Sein Mund bleibt offen." |
| 8 | "…starrt er nur noch den kleinen Drachen an **und sagt kein Wort**" | "…starrt er nur noch den kleinen Drachen an." |
| 13 | "Julian … **schaut ihnen mit offenem Gesicht entgegen**" | "Julian **ist Max aussen herum gefolgt** und wartet schon vor dem Bogen." |
| 16 | "**Sein Gesicht ist ruhig. Er zweifelt nicht.**" | "Levin hält die Hand ganz still." |
| 9 | "**Er sagt noch nichts.**" | *(deleted; replaced by "Es ist später Nachmittag geworden.")* |

The p4 deletion is the worst: "Er dreht sich fast um" is the arc's hesitation beat, explicitly
required by the BEATS REVIEW (*"p4 and p11 need a visible almost-turn (body)"*). The refiner
removed the thing an upstream reviewer had mandated. p13 is the pattern in one line: relief
out, logistics in.

**Why.** `text-refine.txt` gives the refiner a hard obligation (*"Every AUDIT FINDING enters
that ledger the same way: fixed on a page, or a stated reason it stands"*) and no protection
for existing prose. Page length is implicitly held constant, so every fix costs a sentence,
and the cheapest sentence to cut is always the one carrying no plot.

**Fix (prompt, `text-refine.txt`).** Two additions:
1. A protected class: *"A sentence naming what a character feels, notices or almost does is
   never the sentence you cut to make room. If a fix needs room, shorten a sentence that
   names only objects or positions."*
2. Make the ledger report deletions: require the analysis to list, per rewritten page, any
   sentence removed and why — so the loss is visible in `textRefineReport` and can be gated.

---

## T3 — The refiner invents plot to close an audit fault, creating a logic hole

**Symptom.** p4 establishes the stream as the obstacle (stones too far apart for Julian's
legs). p8 says *"Max hat sein Velo dabei durch das seichte Wasser geschoben."* If it was
shallow enough to wade with a bicycle, there was never an obstacle. The whole of challenge 1
dissolves retroactively.

**Where it enters — the text audit, then the refiner, in one hop.**
`story-text-audit.txt` question 5 asks whether anything exists *"in a state — open, broken,
**wet**, moved, known, missing — that nothing shown or said caused"*. It duly fired:
*"FAULT: p8 — Max's bicycle wheels are wet from the water with no crossing that would wet
them shown."* The refiner is obliged to fix it *on the page*, so it wrote a wade into the
story. The writer's own p8 had no wade — it said only "die Räder noch feucht vom Wasser".

The correct fix was to drop "die Räder sind nass", not to invent a crossing. The refiner
cannot choose that, because the prompt only offers *fix on a page* or *state a reason it
stands*; **delete the detail that caused the fault** is not an available move.

**Fix (prompt, `text-refine.txt`).** Add a third ledger disposition: *"Remove the detail —
when a fault is caused by an incidental detail that carries no plot, delete the detail rather
than inventing an event to justify it."* And a guard: *"Never invent an event that makes an
established obstacle easier."*

---

## T4 — Time-of-day stamps injected as prose

**Symptom.** "Der Waldweg führt **am Nachmittag** zu einem breiten Bach" (p4). "**Es ist
später Nachmittag geworden.**" (p9). "Sie fängt **das Nachmittagslicht** ein" (p7). Reads
like a logbook.

**Where it enters.** `story-text-audit.txt` fired *"FAULT: p9 — late-afternoon light is
present after a morning beginning and only a stream crossing."* True fault — the arc opens on
a summer morning and the pictures are amber by p9. The refiner closed it by writing clock
readings into the narration on three pages.

**Root cause is upstream, though.** The ARC says *"a warm summer morning"* and the deadline is
nightfall; the PAGE PLAN puts dusk at p10. Eighteen pages cannot cross morning→dusk on one
forest walk without a felt passage of time, and no stage is responsible for that. The refiner
was patching an arc-level problem with adverbs.

**Fix (prompt, `story-arc-review.txt`).** When the arc carries a deadline of nightfall, the
arc must state the starting time such that the page count spans it plausibly — here, "early
afternoon", not "morning". Cheap, one-line, removes the fault before it exists. Time should
then reach the child through light and the dragon's behaviour, not through named hours: add
to `text-refine.txt` *"Never state a clock time or a named part of the day to fix a
continuity fault; show it in light, shadow or what the characters do."*

---

## T5 — Travelogue connectives injected as page openers

**Symptom.** p14 opens *"Nach der Ruine steigen die vier Buben den letzten Hang hinauf."*
p18 opens *"Nach dem Flug steigen die vier Buben den Hügel hinunter bis zur Limmat."* Neither
opener exists in the writer's text; both are refiner-added.

**Where it enters.** Audit faults *"p14 — the group is on the Uetliberg ridge with no path
shown from the Manegg ruin"* and *"p18 — the boys are on the Limmat footbridge with no journey
shown down from the Uetliberg ridge"*. Both are travel between pages, which is what a page
turn is *for* in a picture book. The BEATS REVIEW had already ruled on exactly this and got it
right: *"p18 ridge to Mühlesteg with no descent → **stands**: the descent would be a passage of
time (not one drawn moment)."* The text audit, which has no memory of the beats review,
re-raised it, and the refiner had no standing to refuse.

**Fix (prompt, `story-text-audit.txt`).** Exempt page-turn travel from question 4: *"A page
turn may carry travel and elapsed time. Do not raise a TRANSITION fault for a change of place
between consecutive pages unless the text or picture claims the characters did not move."*
Alternatively/additionally: feed the beats-review ledger's "stands" decisions into the text
audit so a settled question is not reopened.

---

## T6 — The arc reviewer closes an orphan prop by dragging it through the whole story

**Symptom.** Max's Velo is pushed up a steep forest path, past a ruin, onto a ridge, and stands
in the grass on p14. On p12 he sprints and it vanishes; on p14 it is back. It never does
anything.

**Where it enters — the arc critique, verbatim.**
`arcReviewReport.audit`: *"FAULT: Max's bicycle is present when he joins at the stream but has
no path once he is on foot at the ruin and on the bridges home."*
`arcReviewReport.analysis` fix: *"Corrected arc: the path is too rough to ride, so he walks the
bike; he leans it at the ruin, takes it again when they leave, and has it on the Zürich bridge."*

That correction then became a `Closed:` thread in the arc, which the BEATS REVIEW is obliged
to enforce (*"bike walks with Max → fixed on p6, p8, p10"*), which is where T1's prop
bookkeeping comes from. One arc-review sentence generated seven pages of dead weight.

The available cheaper fix — **Max leaves the bike at the stream and picks it up on the way
home** — closes the same fault and removes the prop from 11 pages. The reviewer never
considered it because its contract is to give the object a path, not to ask whether the object
should exist.

**Fix (prompt, `story-arc-review.txt`).** Add a disposition to the correction format:
*"When an object has no path and no job, the correction may retire it (leave it somewhere with
a reason and collect it later) instead of carrying it. Prefer retiring over carrying whenever
the object does nothing in the challenges it would be carried through."*

---

## T7 — Double exposition: the rule is stated on a sign, then restated in dialogue

**Symptom.** p9 is an information panel that explains the entire ending (dragons follow warm
glowing fires home). p15 has Kiaan restate the same rule. The resolution is handed to the
reader twice, once by furniture.

**Where it enters — the arc critique, again as a "fix".**
Audit: *"FAULT: The museum panel later supplies how dragons navigate, but when it first
appeared the arc stated only a picture of a dragon-like creature."*
Fix: *"Corrected arc: when first seen, the board shows a dragon looking at orange mountain
fires **and says such creatures follow that warm glow home**."*

Then the BEATS REVIEW hard-enforced it: *"The fire-glow rule must be on the board on p9, not
invented on p15."* Kiaan's p15 line is now redundant by construction — the reviewer mandated
that the payoff be spoiled nine pages early.

The fault was real (a device may not acquire meaning retroactively). The chosen fix was the
blunt one: state the rule where it first appears. The alternative that keeps the payoff — the
board shows the picture and Kiaan is *seen reading it*, so the child knows Kiaan learned
something without learning it themselves — was not in the reviewer's option set.

**Fix (prompt, `story-arc-review.txt`).** Add: *"A device may be given its meaning by showing
a character learn it, without telling the reader what was learned. Prefer that when the device's
meaning is the story's solution — stating the solution early spends the payoff."*
This is a judgement call with real trade-offs (understandability vs. surprise) — **needs the
owner's decision before implementing.**

---

## T8 — Max's build-up pays off in nothing

**Symptom.** p5: *"Sein Kinn ist oben, sein Blick ist klar. Max weiss schon, was zu tun ist."*
p6: he parks the bike, and **Julian** spots the log. The hero shot resolves to nothing.

**Where it enters — the ARC, uncaught by every reviewer.** The arc gives Max his entrance at
the stream (*"He joins at the stream on that bike"*) and gives the log to Julian (*"Julian …
spots a fallen log"*). The PAGE PLAN then makes p5 a *"close-up — 1 character — Max entrance …
decisive and fast, his entrance picture"*. Nothing in the pipeline checks that a page which
declares a character is about to act is followed by that character acting — the arc critique's
§4 only checks that each secondary has *a* moment (Max's is p12), not that a build-up lands.

**Fix (prompt, `story-beats-review.txt`).** Add to §2 Arc: *"Name every page whose beat states
a character is about to act, decide or know what to do. The next page must show that character
doing it. If another character acts instead, the build-up page is wrong — move it or reassign
the action."*

---

## T9 — Reading level is enforced on the writer, then not re-checked

**Symptom.** p9: *"Die Tafel zeigt, dass solche Tiere dem warmen Leuchten dieser Feuer folgen,
um nach Hause zu ihrer Familie zu finden."* — 20 words, nested subordinate clause, and
slightly ungrammatical ("nach Hause zu ihrer Familie **zu** finden"). Target is 1st grade.
p10: *"Er will die Spur der Buben nicht halten"* reads like a translation.
p11: *"die Mauer ist viel zu hoch, um darüber zu schauen"* reads like a constraint being
justified rather than a scene being described.

**Where it enters.** The writer produced all three. `story-text-from-beats.txt` has the rule
(*"Every word must be one a child at the reading level already uses … keep a sentence to one
idea"*) and it failed on the exposition pages, where the writer was carrying a lot of mandated
information. `text-refine.txt` receives `{READING_LEVEL}` but has **no per-sentence
reading-level check in its list of rewrite triggers** — so it touched p9 (changed *erklärt* →
*zeigt*) and left the 20-word clause standing.

Note also: `story-text-quality-judge.txt` exists (`server/lib/textQualityJudge.js`) but did
not run on this story — `finalChecksReport` holds only `entity` and `styleConsistency`.

**Fix.** (a) Add a rewrite trigger to `text-refine.txt`: *"Rewrite any page carrying a sentence
longer than the reading level allows, or a sentence with a subordinate clause inside a
subordinate clause."* (b) Separately decide whether `textQualityJudge` should run in the
unified pipeline — **owner decision, it is a cost/latency question.**

---

## T10 — The hatching happens between pages

**Symptom.** p2 ends on «Es schlüpft!». p3 opens with the dragon already sitting on the
ground. The most magical image in the book is in the gutter.

**Where it enters — the PAGE PLAN**, which allocates p2 to "Levin's face as the egg glows" and
p3 to "the hatched dragon stands before Levin and Julian". The BEATS REVIEW §6b explicitly
inspected and defended this allocation: *"Opening occupies p1–3 (one page over the shape's
'2') … it stands because the committed plan needs forest, glow close-up, hatch+stake."* It
counted pages, not moments — it never asked whether the hatch itself was on a page.

**Fix (prompt, `story-beats-review.txt`).** Add to §7 Pacing: *"Name the story's single most
wanted image (the transformation, the arrival, the reveal). If no page shows it, the plan is
wrong."* Cheap here: p2 becomes the shell splitting open with the snout emerging; the stake
moves to p3 where it already is.

---

## T11 — The climax obstacle is unseeded

**Symptom.** The mist arrives on p14 with no prior mention. Nothing on p3, p10 or anywhere
hints at weather.

**Where it enters — the ARC** (*"a thick bank of evening mist has rolled in"*), and both
reviewers cleared it. The arc critique §10 checked only that the blocker has a cause
(*"The mist sits at dusk for its own weather reason"*); the BEATS REVIEW §8 checked only that
it is not a magic key (*"The mist is from dusk on that ridge, not from a carried key"*).
**Neither stage asks whether an obstacle was foreshadowed** — only whether it is legal.

**Fix (prompt, `story-arc-review.txt` §10 Blockers).** Add: *"For each blocker, name the
earlier page or arc moment where the reader could have seen it coming. A blocker in the final
challenge that first exists when it blocks is unearned even when its cause is natural."*
One clause on p3 or p10 ("über den Alpen liegt schon ein grauer Streifen") fixes it.

---

## T12 — No dialogue floor; the dragon is never named

**Symptom.** Roughly eight spoken lines across 18 pages, most of them exposition. The dragon
— the co-protagonist a child attaches to — has no name.

**Where it enters — nowhere. It is an absent rule.** `story-text-from-beats.txt` tells the
writer *"write what [the illustration] cannot show: the interior, the dialogue, the turn"*,
which is the right instruction, but nothing measures it and nothing survives the refine pass
(see T2). Naming a companion creature is not requested at any stage.

**Fix.** (a) `story-text-from-beats.txt` analysis step: add *"name every page with no spoken
line; a book at this length needs spoken lines on at least a third of its pages"* — a
countable check in Step 1, which is the pattern that worked for interaction load.
(b) `story-arc-review.txt`: *"A non-speaking animal companion that travels with the children
is given a name by them, on the page where they decide to help it."* — **owner decision:
this changes story convention, not just prose.**

---

## T13 — The ending is cold; the anti-moral rules have no floor

**Symptom.** *"Levin geht vorneweg und schaut nicht zurück. Niemand sagt viel."* A six-year-old
who has just given away a baby dragon gets no comfort and no arrival home.

**Where it enters — three stages agreeing.**
ARC shape: *"Levin, for once, does not second-guess anything."*
BEATS REVIEW §9: *"No page should speak the moral."* §11: *"not by a line of praise."*
Text refine **added** the final sentence *"Niemand sagt viel."* — it is not in the writer's p18.

Each rule is individually correct (no moralising, no stated lesson). Together they produce an
ending with no warmth, and the refiner then adds a sentence that makes it colder. There is a
ceiling on sentiment and no floor.

**Fix (prompt, `story-beats-review.txt` §9).** Add the floor: *"The last page shows the
characters safe and together, and one of them feels something a child can name — glad, tired,
proud, missing someone. Banning a stated moral is not a ban on a stated feeling."*

---

## T14 — The title rule forces the protagonist's name onto a four-lead story

**Symptom.** "Levin und der kleine Drache" reads as a two-hander; it is a four-boy story where
each contributes the piece that solves it.

**Where it enters.** `story-text-from-beats.txt`: *"The title is in the story language,
**contains the main character's name**, and does not spoil the ending."* Hard rule, no
alternative. `titleCandidates` is empty for this story, so nothing else was ever considered.

**Fix — owner decision.** Either relax to *"contains the main character's name **or** names
what the group does together"*, or keep the rule (it is good for personalised-book
recognisability — a parent scanning a shelf wants to see their child's name). This is a
product call, not a craft call. **Ask before changing.**

---

## T15 — The dedication page is empty

**Symptom.** `stories.data.dedication === ""` for a delivered 18-page book.

Not diagnosed further — needs a check of whether the wizard collected one and it was dropped,
or the field was never offered. Separate investigation.

---

## Summary — where the defects are born

```
IDEA (storyDetails)          ── T4 seed (opens on "Sommermorgen" with a nightfall deadline)
  │
ARC                          ── T8 (Max build-up vs Julian solve)   T11 (mist unseeded)
  │                             T13 (cold ending shape)
ARC CRITIQUE (8 faults)      ── T6 (bike given a path instead of retired)
REFINED ARC                     T7 (rule front-loaded onto the board)
  │
PAGE PLAN                    ── T10 (no page for the hatch)
  │
DRAFT BEATS                     (clean — best prose state of the whole run)
  │
BEATS CRITIQUE (18 ledger)   ── T1 (prop state written into BEAT, not SCENE)
REFINED BEATS                   T2 partial (3 characterising clauses trimmed)
  │                             T13 (anti-moral rules with no floor)
  │
WRITER TEXT                  ── T9 (reading level fails on exposition pages)
  │                             T12 (no dialogue floor — absent rule)
  │                             T14 (title rule)
  │
TEXT AUDIT (14 faults)       ── T5 (page-turn travel raised as a fault)
TEXT REFINE                     T2 main (8 emotional sentences deleted)
  │                             T3 (wade invented → obstacle destroyed)
  │                             T4 (clock times written into prose)
  ▼
WHAT THE CHILD READS
```

**The one-line version:** the writer's draft was the best version of this text, and each
review stage traded a sentence of feeling for a sentence of logistics. The reviews are not
wrong — they found 40 genuine faults — but none of them has a budget, a protected class, or
a "delete the detail" option, so every fix is paid for out of the prose.

---

## Proposed order of work

Prompt-only, no code, cheapest-first. **None of these is implemented — T7, T9(b), T12(b) and
T14 need an owner decision first (see each section).**

1. **T3 + T5** — `text-refine.txt` gains a "remove the detail" disposition; `story-text-audit.txt`
   exempts page-turn travel. Kills the worst logic hole and the travelogue openers. Two clauses.
2. **T2** — `text-refine.txt` protected class + deletion ledger. The single highest-value change.
3. **T1** — `story-beats-review.txt`: prop continuity goes in SCENE, never BEAT.
4. **T13 + T11 + T8** — three one-clause additions to the beats/arc review checklists.
5. **T4** — arc states a start time that spans the deadline; refiner may not write clock times.
6. **T6** — arc review may retire an object instead of carrying it.
7. **T9(a) + T10** — reading-level rewrite trigger; "most wanted image" pacing check.

**Validation:** these are prompt changes → the `validating-prompt-changes` skill applies. The
Lab has a `text_refine` stage, so T2/T3/T5 can be A/B'd against this exact story's stored
writer text at zero image cost — replay the refine pass with the amended prompt and diff which
sentences it deletes.

---

## Review

*(to be written after the fixes land)*
