# Age-band view split — first-principles audit (2026-09-15)

**Status:** steps 1-3 IMPLEMENTED 2026-09-16 (see §8 and `docs/decisions.md`, 2026-09-16
entry); step 4, the measured idea run, is the owner's and has not run. Originally: design only. No paid calls made; every finding below is from
the repo (`prompts/age-band-*.txt`, `server/lib/promptBuilders.js:5175-5300`, `:7788-7845`) and
from the measurements already recorded in `docs/decisions.md`.

## 0. Why this exists

`BAND_VIEW_DROPS` (`promptBuilders.js:5187`) slices one band file into three views by *removing*
tagged spans:

```js
writer:  []                 // whole file
premise: ['book']           // own-town idea arm
tone:    ['book', 'plot']   // make-believe idea arm
```

Three consecutive misses, each found only by paying for a measured idea run:

1. `fdc85a290` — the AGENCY rule was inside `[[plot]]`; the make-believe arm never received it.
   6 of the 10 worst ideas were fantasy cards resolved by an object or an adult.
2. `862432a85` — the RESOLUTION rule was also inside `[[plot]]`. Journey band: local arm 6/6,
   fantasy arm 3/6; 9 of 28 cards stopped on the problem; ratings fell 3.39→3.32 (child) and
   3.29→3.18 (parent), cancelling three otherwise-working fixes from the same day.
3. Open — the PREMISE-DEFINING sentence ("what the book is *of*") is `[[plot]]` in every band.

Three misses of the same shape is a mechanism finding, not three authoring slips. This document
audits the mechanism.

---

## 1. The readers

Every call site of `buildAgeModeSection`. Six live readers, not three.

| # | Call site | View | What it produces | Length |
|---|---|---|---|---|
| R1 | `promptBuilders.js:6037` `buildBeatsPrompt`, `:6429` `buildArcCreatePrompt`, `:6469` `buildArcRetellPrompt`, `:7567` `buildTrialStoryPrompt` | `writer` (default) | the arc / beats / whole trial book | a book |
| R2 | `promptBuilders.js:7818` `buildTrialIdeaPrompts` — **own-town arm** | `premise` | one story premise, own town, real landmarks | **≤40 words** |
| R3 | `promptBuilders.js:7818` `buildTrialIdeaPrompts` — **make-believe arm** | `tone` | one story premise, invented world | **≤40 words** |
| R4 | `routes/storyIdeas.js:214` — full-wizard idea generation | `writer` (default) | back-of-book blurb (`generate-story-idea(s).txt`: "who this is about, where they are, what they want and what is in the way — and stops there") | a paragraph |
| R5 | `promptBuilders.js:6979` `buildArcReviewPrompt`, and `storyScorecard.js:284` (judge context, `arc` only) | `writer` (default) | a critique / a score | n/a — a **critic**, not a generator |
| R6 | `testlab.js:8543` `runTrialChallengeDrawStage` | `writer` (default) | Lab diagnostic context | n/a |

(`tests/manual/render-trial-idea-prompt.js:43,73` is a dev harness, also `writer`.)

Two readers nobody triaged when the views were designed:

- **R4 is a premise generator reading the writer view.** It is asked for exactly what R2/R3 are
  asked for — subject, want, obstacle, no ending — at paragraph length, and it receives the
  `[[book]]` worked-example menus, the `**Ending.**` rules and the per-page feeling rules. Lab
  #1273 measured that menus in a rule position at premise size are answered verbatim (8 of 10
  ideas). R4 is the same exposure, unmeasured.
- **R5 is a critic reading the writer view while judging output produced from `premise`/`tone`.**
  A generator↔critic asymmetry of exactly the kind `scripts/admin/sibling-registry.json`
  (`axis: generator-vs-critic`) exists to catch. A judge can deduct an idea for a book-craft rule
  the idea arm was never given.

**Only R1 needs the whole file.** R2, R3 and R4 are all premise-shaped. R5 should read whatever
the artefact it is judging was written under.

---

## 2. Every rule, every band, current tag

Nesting is real: `[[book]]` spans open *inside* `[[plot]]` spans, and three rules open a tag
mid-sentence. "nested" below means the tag covers a clause of the rule, not the rule.

ROLE column is my classification (§3): **P** = premise-defining, **C** = book craft,
**M** = machinery, **X** = worked-example menu.

### routine (age 0-1)

| Rule | Tag now | Role | Recommended: writer / own-town / make-believe |
|---|---|---|---|
| Header + "Write for that child… override any instruction to build a conflict" | untagged | P | all |
| **A day, not a plot.** | `[[plot]]` | **P** | all |
| **A new thing on every page.** | `[[plot]]` | M | writer, own-town |
| **Naming and repetition are the payoff.** | `[[book]]` | C | writer |
| **The child's traits are the plan.** | `[[book]]` | C | writer |
| **Show three different feelings.** | `[[book]]` | C | writer |
| **One small thing goes wrong, and comes right.** | untagged | P | all |
| **Nothing frightening.** | untagged | P | all |
| **What the child does.** ("never anything that turns on working something out") | `[[plot]]` | **P** | all |
| **No real-world errands alone.** | `[[plot]]` | **P** | all |
| **Topic.** ("a place full of things… never a quest, a search, a rescue, a secret or a prize") | `[[plot]]` | **P** | all |
| **Food.** | `[[book]]` | C | writer |
| **Nothing appears from nowhere.** | `[[book]]` | C | writer |
| **A make-believe story opens and closes where the child really is.** | untagged | P | all |
| **A life event is weather, not a task.** | `[[book]]` | C | writer |
| **Ending.** | `[[book]]` | C | writer |

Starkest band, as the brief says. The make-believe arm for a one-year-old is currently told only
that something goes wrong and comes right, that nothing is frightening, and that the story opens
and closes at home. It is **not** told the book is a place full of things with a child let loose
in it, **not** told never a quest/search/rescue/secret/prize, and **not** told the child may never
solve a puzzle or run an errand alone. Those are the band's three hardest prohibitions and all
three are `[[plot]]`-only.

### quest (age 2)

| Rule | Tag now | Role | Recommended |
|---|---|---|---|
| Header + override line | untagged | P | all |
| **One tiny goal, and nothing else.** | `[[plot]]` | **P** | all |
| …"Something ordinary in this child's own day, and a different thing in every book." | `[[book]]` nested | **P** | all |
| **The search is the story.** (one place per page, friendly-no each time) | `[[plot]]` | M | writer, own-town |
| **A phrase comes back every time.** | `[[book]]` | C | writer |
| **Nothing frightening.** | untagged | P | all |
| **The child does the finding.** | untagged | P | all |
| **It resolves.** | untagged | P | all |
| **Food.** | `[[book]]` | C | writer |
| **Nothing appears from nowhere.** | `[[book]]` | C | writer |
| **A make-believe story opens and closes…** | untagged | P | all |
| **A life event is weather…** | `[[book]]` | C | writer |
| **Ending.** | `[[book]]` | C | writer |

Note the nested `[[book]]` clause: "a different thing in every book" is an anti-repetition rule —
premise-defining, and it currently reaches neither idea arm, which are the only two readers that
draw two cards at once.

### tries (age 3)

| Rule | Tag now | Role | Recommended |
|---|---|---|---|
| Header + override line | untagged | P | all |
| **One problem, met three times.** — "a single concrete problem, plain enough to point at" | `[[plot]]` | **P** | all |
| …"a thing, a place or a creature that will not do what is wanted… for a life-skill topic the problem is the outside event" | `[[book]]` nested | **P** | all |
| …"Three tries, no more. Each try is a different kind of attempt… The first two do not work." | `[[plot]]` | M | writer, own-town |
| **The child's own doing.** | untagged | P | all |
| **It resolves.** | untagged | P | all |
| **Small noticing, not cleverness.** | `[[plot]]` | **P** | all |
| **Kindness is the motive.** | untagged | P | all |
| **A gentle obstacle, never a villain.** | untagged | P | all |
| **Feelings named plainly.** (first sentence) | untagged | P | all |
| …"One feeling per turn of the story, on the face and in what the body does." | `[[book]]`, opens mid-rule | C | writer |
| **Food.** | `[[book]]` | C | writer |
| **A life event is weather…** | `[[book]]` | C | writer |
| **Ending.** | `[[book]]` | C | writer |

`**Small noticing, not cleverness.**` is misfiled today: "never a child who reasons like a
grown-up" is a statement about what kind of story this is, and a 40-word premise can absolutely
violate it. It is the same class as the agency rule that was moved in `fdc85a290`.

### fear-choice (age 4)

| Rule | Tag now | Role | Recommended |
|---|---|---|---|
| Header + reader line | untagged | P | all |
| **Something scary, faced and grown past.** ("the book turns on one thing the main character is afraid of") | `[[plot]]` | **P** | all |
| …"Anything a child of this age is afraid of, and a different one in every book." | `[[book]]` nested | **P** | all |
| **The child's choice resolves it.** | untagged | P | all |
| **It resolves.** | untagged | P | all |
| **A light villain is allowed.** | untagged | P | all |
| **Magic is welcome.** | untagged | P | all |
| **Feelings on the page.** | `[[book]]` | C | writer |
| **Ending.** | `[[book]]` | C | writer |

The whole band is *about* a fear, and the only sentence that says so is `[[plot]]`.

### journey (age 5+, no upper cap)

| Rule | Tag now | Role | Recommended |
|---|---|---|---|
| `{BAND_TITLE}` / `{READER_LINE}` | untagged | P | all |
| **The full shape.** ("Ordinary world, then a call… then home — changed. Every one of those beats is on the page, in that order.") | `[[plot]]` | **P** + M — split | subject half: all; beat enumeration + "in that order": writer, own-town |
| **A real low point is required.** | `[[book]]` inside `[[plot]]` | C | writer |
| **The hero's own idea turns it.** | untagged | P | all |
| **It resolves.** | untagged | P | all |
| **A real antagonist is allowed.** (first sentence) | untagged | P | all |
| …"A twist, a sidekick who earns their place, and a setup on an early page that pays off at the end" | `[[book]]` | C | writer |
| **Competence.** ("never carried through their own story") | untagged | P | all |
| **Humour and mild peril.** | untagged | P | all |
| **Ending.** | `[[book]]` | C | writer |

Journey is the least damaged band — its untagged agency/resolution/competence/antagonist rules
between them imply the subject. That is luck, not design.

### The mechanical symptom nobody looks for: dangling antecedents

Rendering the `tone` view of each file today produces prose that refers to spans that are gone:

| Band | Surviving text | Antecedent, and where it went |
|---|---|---|
| tries | "Before **the third try** … **the first two** missed"; "**The third try** works" | "Three tries, no more" — `[[plot]]` |
| tries | "notices something about **the problem**" | "a single concrete problem" — `[[plot]]` |
| fear-choice | "What ends **the fear**"; "as long as **the fear and the choice** stay the spine of it" | "one thing the main character is afraid of" — `[[plot]]` |
| quest | "They look and they find"; "**The wanted thing** is found" | "One tiny goal" — `[[plot]]` |
| journey | "**The turn** comes before the last page" | "then the turn" — `[[plot]]` |
| routine | (no dangling reference; instead a silent hole where the subject rule was) | `**Topic.**` — `[[plot]]` |

Four of five bands ship the make-believe arm prose with an undefined referent. This is the
cheapest possible signal of the whole bug class, and nothing checks for it (§5).

---

## 3. What each reader actually needs

Working from the job, not the tag. The test the brief proposes — *could a 40-word premise honour
this rule, and would a premise be wrong without it?* — separates three roles cleanly:

- **P — premise-defining.** What the book is *of*; who resolves it; that it resolves; what kind of
  story is forbidden (no quest at age 1, no villain at 3, no grown-up rescue anywhere); whether
  magic is allowed; where it opens and closes. A 40-word premise can honour every one of these,
  and is wrong without them. **Every reader needs P.**
- **C — book craft.** Per-page feeling, ending register, food safety, "nothing appears from
  nowhere", naming-and-repetition, trait-per-page, the life-event framing, the low point as a
  written page. A premise cannot express these; including them costs tokens and invites the model
  to write a book instead of a premise. **Writer only.**
- **M — machinery.** Enumerated beats in order, "three tries, no more", one place per page, "a new
  thing on every page". These are page-count arithmetic. A premise cannot honour them — but the
  own-town arm's job is a *concrete* premise, and naming the shape helps it; that is the surviving
  justification for a two-tier idea view. **Writer + own-town, by choice.**
- **X — worked-example menus.** Dropped for a different reason from C: not "cannot honour" but
  "will be copied verbatim" (Lab #1273, 8/10). They must be dropped for **any** reader producing
  less than a book — which includes **R4**, currently reading `writer`.

The key correction: `[[plot]]` today means *both* P and M. That conflation is the fault. Every one
of the three misses is a P rule filed under a tag whose other members are M.

---

## 4. The mechanism

### Root cause, stated precisely

It is not "two tags, three views". It is:

1. **The tag names say who drops the span, not what the span is.** `[[book]]` / `[[plot]]` are
   written by an author holding the writer's prompt in mind. Whether a new rule is premise-
   defining is never the question the file asks.
2. **Untagged means "everyone", silently.** Forgetting to tag is safe for the writer and invisible
   for the other readers; the *absence* of a tag is the most consequential authoring act in the
   file and it has no syntax.
3. **The unit of the mechanism is a span, not a rule.** Tags open mid-sentence and nest, so
   "which rules does the fantasy arm get" is not answerable by looking at the file.
4. **Subtraction can leave broken prose.** Removing a span cannot remove the references to it.

### Options

**A. Keep three views, retag per §2's table.**
- *Cost:* a few hours; five files; no code change; existing tests mostly hold.
- *Would it have caught the misses?* It fixes all three today. It prevents none of the next three —
  the next author faces the same two ambiguous tag names and the same silent default.
- *Verdict:* necessary work, insufficient as an answer.

**B. Tag by ROLE.** Replace `[[book]]`/`[[plot]]` with `[[premise]]` / `[[craft]]` /
`[[mechanics]]` / `[[example]]`. A tag then states what a rule **is**; who drops it is a
consequence.
- *Cost:* same retag as A plus a rename in `applyBandView` and the tests.
- *Would it have caught the misses?* Yes, all three, at authoring time. Under B, `**Topic.**`
  ("what the book is about") is unmistakably `[[premise]]`; nobody writes `[[mechanics]]` around
  "the book turns on one thing the child is afraid of".

**C. Compose views from named blocks (allow-list), and forbid untagged prose.**
`BAND_VIEW_DROPS` becomes `BAND_VIEW_KEEPS`; `applyBandView` **throws** on any prose outside a
tagged span (the header/reader line carries `[[premise]]` explicitly).
- *Cost:* code change is small; the retag must be total rather than partial.
- *Would it have caught the misses?* It catches the *silence*: a rule cannot enter the file
  without its author stating which readers it is for. It does not by itself stop a wrong choice.

**D. Three separate files per band (15 files).** Rejected. Fifteen hand-kept copies is the drift
the one-file design exists to prevent, and is precisely the "fix the mirror class, not the
instance" failure logged 2026-09-15.

### Recommendation: **B + C together, plus the §5 tests.**

One pass, not three:

1. Four role tags: `[[premise]]`, `[[craft]]`, `[[mechanics]]`, `[[example]]`.
2. Every line of every band file sits inside exactly one tag. `applyBandView` throws on untagged
   prose and on an unknown tag (it already throws on an unknown view — keep that).
3. Views become inclusions, and are renamed so the name no longer misleads:

   | View | Keeps | Reader |
   |---|---|---|
   | `writer` | premise + craft + mechanics + example | R1 |
   | `premise` | premise + mechanics | R2 (own-town arm) |
   | `premise-open` (today's `tone`) | premise | R3 (make-believe arm) |
   | `blurb` (new) | premise + mechanics, **never example** | R4 (full-wizard idea) |

   `tone` is renamed because the name itself taught three authors that subject rules do not belong
   in it; its doc comment says "tone and safety", which is how `**Topic.**` ended up excluded.
4. **R5 (the critic) reads the view the artefact was written under**, not `writer` — an explicit
   `bandView` argument at `storyScorecard.js:284` and `buildArcReviewPrompt`. Per the
   generator-vs-critic axis in `sibling-registry.json`, this pair must be declared there.

Trade-offs, honestly:

- **Migration is one mechanical pass over five files (~55 spans) plus ~30 lines of JS and the
  tests.** No rule WORDING changes, so nothing archetypal is at risk and no prompt-genericity
  question arises.
- **It still changes what two production arms receive** (that is the point: P rules start
  arriving at R3). That is a behaviour change and needs a measured idea run before it is trusted —
  the same shape of run that found misses 1-3. It cannot be validated statically.
- **R4 changing view is the largest single behavioural delta** — it currently gets menus it will
  likely stop copying. Good, but unmeasured today; worth its own arm in the same run.
- **`[[example]]` is a fourth tag for a fifth reason** (copy-risk, not honour-ability). Merging it
  into `craft` would be simpler but would re-create the conflation this whole audit is about.

### The alternative the owner should be asked about

The 2026-09-14 decision made the two idea arms differ **in plot licence** as a variety device.
Three of three misses are downstream of *two arms reading two different rule sets*. The 2026-08-25
ruling the arms implement says they must differ **in KIND** (own town vs make-believe), which the
appended clause already does. So there is a simpler design: **both arms read `premise`**, and the
difference is only the appended KIND clause + the rotated variety axis.

- Pro: the whole class of "one arm was told, the other was not" disappears by construction; a
  band-file test no longer has to reason about per-arm views at all.
- Con: it reverses the explicit 2026-09-14 "the arms now differ in plot licence, not in one
  appended sentence" (decisions.md, "Trial idea variety: the two arms differ by construction"),
  and the measured 292-word fantasy prompt grows back toward the local arm's ~470.

This is an owner decision, not mine to take (§7).

---

## 5. The test that would have caught all three

Today's tests pin rules **by name** (`tests/unit/trial-idea-variety.test.ts:50-72`,
`tests/unit/age-band.test.ts:471-515`). That is why each miss needed a paid run: a test that
asserts "the tone view contains *The hero's own idea turns it*" cannot fail for a rule nobody
thought to add to the list.

**T1 — declared premise slots (the class-level test).**

Each band file declares its premise obligations as named slots rather than free prose:

```
[[premise:subject]]**The full shape.** ... [[/premise:subject]]
[[premise:agency]]**The hero's own idea turns it.** ... [[/premise:agency]]
[[premise:resolution]]**It resolves.** ... [[/premise:resolution]]
```

with a per-band manifest in JS naming which slots that band must declare. `routine` legitimately
has no agency rule (the band forbids the child working anything out) — it declares
`agency: 'none'` **positively**, so absence is never silence.

The test then iterates **every band × every view any premise-shaped reader uses** and asserts each
required slot's text is present in the render. Plus: exactly one span per slot per file (no
duplicates), and `writer` contains every slot.

*Would it have caught the three?* Miss 1 → `agency` absent from `tone`. Miss 2 → `resolution`
absent from `tone`. Miss 3 → `subject` absent from `tone` in five bands. **All three, at commit
time, for free.** And it fails for the *next* one too: any future premise obligation added to the
manifest is checked against every band and every view at once.

**T2 — no dangling antecedent (the generic backstop, needs no judgement).**

Each band file declares the definite noun phrases it introduces and where:

```js
{ band: 'tries', introduces: { 'the third try': 'subject', 'the problem': 'subject' } }
```

For every view render: if the render contains the phrase, it must also contain the introducing
span. Catches the whole family of "a rule survived but its referent did not" — which is what four
of five bands ship today (§2), independent of anyone classifying rules correctly.

**T3 — totality.** `applyBandView` throws on untagged prose; a test asserts every band file parses
with zero untagged bytes, that the union of `writer`'s keeps is the whole file (this exists today
and must survive), and that every tag in every file is one of the four known roles.

**T4 — reader inventory.** A test enumerating every `buildAgeModeSection` call site's view (a
frozen list) so a new caller defaulting to `writer` is a deliberate, reviewed act rather than the
default. R4 and R5 became untriaged readers precisely because `writer` is the default argument.

T1 is the answer to the brief's question 5. T2 is the cheap one to build first and would have
flagged misses 2 and 3 with no design work at all.

---

## 6. Same pattern elsewhere

**Span-subtraction by `[[tag]]` exists nowhere else** — `grep -rl '\[\[' prompts/` returns only
the five `age-band-*.txt` files. But *view-by-subtraction* as a shape recurs, and every instance
has the same failure mode (the removed thing is invisible at the removal site):

| Site | The subtraction | Same failure mode? |
|---|---|---|
| `server/lib/images.js:895` `shrinkPromptForModel` | deletes whole blocks to fit a length cap | **Yes, already burned** — memory `project_prompt_shrink_hazard`: it deletes head blocks, so must-survive instructions have to be parked at the protected tail end. Identical disease: a reader silently loses a rule. |
| `fillTemplate` dropping undeclared keys | a `{TOKEN}` with no value vanishes with a log warning | **Yes** — memory `feedback_spread_value_needs_a_placeholder`, four instances in one day. `fillBandTokens` exists (`promptBuilders.js:5245`) precisely to dodge this. |
| `buildTopicWindowSection` / `SIMPLE_BANDS` challenge-catalogue skip (`routes/storyIdeas.js:218`) | returns `''` for whole classes | Partly — both are *deliberate* and logged, but neither has a test that the skip is the intended one rather than a resolver bug (the 2026-09-14 `'standard'` band returning `''` for most of the product was exactly this). |
| trial vs full prompt split (`story-trial.txt` vs the beats chain) | a whole pipeline reads a reduced prompt | **Yes** — memory `feedback_trial_path_lags_full_path`; this is what `sibling-registry.json` gate 9 now guards. |

The through-line: **wherever a prompt is assembled by removal, add a positive assertion of what
must survive.** That is T1/T2 generalised, and `shrinkPromptForModel` should get the same
treatment (a declared must-survive set, asserted post-shrink) — noted as backlog, not proposed
here.

---

## 7. Settled-verdict check

- **`docs/SETTLED.md` carries no line on age bands, band views, idea arms or prompt layering.** The
  2026-09-14 decision recorded this explicitly ("`docs/SETTLED.md` carries no line on idea
  generation, so no reversal protocol applies"). Confirmed again today against all 80 lines.
- Therefore **the recommendation in §4 reverses nothing under the formal protocol.** It is a
  refactor of a mechanism plus a retag that moves P rules to every reader — the same direction as
  `fdc85a290` and `862432a85`, continued to completion.
- **The one thing that WOULD be a reversal** is the §4 alternative (both arms read the same view).
  It contradicts decisions.md 2026-09-14 "The make-believe arm gets `tone`, the own-town arm gets
  `premise` — the arms now differ in plot licence, not in one appended sentence". Not on
  SETTLED.md, so the four-step protocol is not formally triggered, but it is an explicit owner
  decision from yesterday and must not be taken by an agent. **Ask.**
- `decisions.md:19740` (arms differ in KIND), `:14578` (premise not walkthrough), `:33028` (name
  want/obstacle/cost concretely), `:26317` (age-3 challenge-catalogue exclusion) are all
  unaffected by §4's primary recommendation.

---

## 8. Staging, if approved

This is a medium-sized change, and it should not be one commit.

1. [x] **T2 + T3 against today's files** (no retag) — `41438ac32`, committed failing on four bands
   (dangling antecedents) and on every band (untagged prose).
2. [x] **Role tags + allow-list views** — `40d026e16`. `writer` verified byte-identical in all five
   bands. One deviation from §2: "Three tries, no more." and the six-beat enumeration are
   `[[premise]]`, not `[[mechanics]]` — they are the antecedents T2 demands, and a premise can
   honour them; only the per-try / per-page machinery stays writer-side.
3. [x] **T1**, the declared-premise-slot test, with `BAND_PREMISE_SLOTS` and `routine`'s positive
   `agency: 'none'`. Proven to catch all three historical misses.
   [ ] **R4 → `blurb` and R5 → the artefact's view** — NOT done: owner chose "log, decide later"
   (2026-09-16). Both are in `tasks/BACKLOG.md`.
4. [ ] **One measured idea run** across bands × arms, judged the same way the 28-idea run was, before
   any of this is called good. That is the only step that costs money and it needs its own
   mandate.

Steps 1-3 are static and testable. Step 4 is the only claim that needs a paid measurement.
