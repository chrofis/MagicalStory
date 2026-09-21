# Story-idea quality rounds (full wizard) — 2026-09-20

Reuse of the trial-idea round method (fixed cells → generate → rate → fix worst 3 classes → rerun same cells, ≤5 rounds)
for the FULL wizard's story ideas (`prompts/generate-story-idea-single.txt`, both worlds, `server/routes/storyIdeas.js`).

Contract rated against: the back-cover premise (decisions.md 2026-09-14): setting/time; who + want; obstacle + cost;
no middle, no ending; all characters present with a role; no adjectives; 3-5 sentences; peril line = frightening,
never lethal/injuring; correct language; age fit; theme/world fit; local arm uses real landmarks, fantasy arm no city leak.
NOT the trial's three-slot (outcome) contract — that is a different, deliberate design.

## Cells (10, fixed across rounds)
1-6 characters, 10-20 pages, ages 1-12, life-challenge on/off, historical, pirate/wizard/other worlds. See harness.

## Rounds
- [x] R1 baseline done 2026-09-20: harness `tests/manual/story-idea-rounds.js`, 10 cells × 2 worlds, USD 0.535, ratings + 3 worst classes in `tests/manual/story-idea-rounds/round-1-ratings.md` (no prompt edits)
- [x] R2 fix + rerun done 2026-09-20: three R1 fixes applied (quoting check 6, life-challenge outside-event sentence + Topic check, presence line + quoting check 4), USD 0.632, ratings in `tests/manual/story-idea-rounds/round-2-ratings.md`. Cast 6→3 and topic-bolted-on 3→2 moved; middle-leak 10→11 did not; peril 3→4 regressed
- [x] R3 fix + rerun done 2026-09-20: three R2 fixes applied (check 6 bound to [FINAL] + explicit CUT: step, "last sentence states the cost" rule line, check 7 tied to the youngest character; ROLES: label now written in the output language), USD 0.6676, ratings in `tests/manual/story-idea-rounds/round-3-ratings.md`. Peril 4→2 and the ROLES label 2→0 moved; middle-leak stayed at 11 but lost its 1s; both-arms-identical regressed 2→4
- [x] R4 fix + rerun done 2026-09-20: three R3 fixes applied (check 6 exhaustive — number [FINAL]'s
  sentences, label setup/event, cut EVERY non-final event; check 4 excludes co-location as a stake;
  RULES line for the youngest character + a named responsible adult; and a named variety axis in
  `buildVariantInstructions` for the second `location` arm, extracted from the route so the harness
  stops hand-copying it). USD 0.7443, ratings in `tests/manual/story-idea-rounds/round-4-ratings.md`.
  Cast 4→3, topic-bolted-on 3→2, theme/world +0.25 and h +0.38 moved. Middle-leak a≤3 went 11→15 —
  the narrated-event leak is GONE and the **stated rule/gate** leak (9/20) grew into the space, because
  a condition labels as "setup" under the new two-label taxonomy. A prompt lever remains (a third
  label, "rule"); a trialIdeaCheck-style JS rerun would fire on ~0 of these. Both-arms-identical flat
  at 4 (the responsible-adult axis took, place class and outside event did not); f regressed 4.20→4.00
- [x] R5 fix + rerun done 2026-09-20: three R4 fixes applied (check 6 gains a third label "rule"
  with the cost sentence exempted; check 7 covers anyone in the idea and the craft they travel in;
  ~30-word sentence bound in RULES and the format check — all on both templates — plus the second
  `location` arm's place class and event class computed as VALUES in `buildVariantInstructions`).
  USD 0.7176, ratings in `tests/manual/story-idea-rounds/round-5-ratings.md`. a 3.10→3.65 (best of
  five), middle-leak 15→9, narrated-event leak 6→3, cell 4's four-round peril g=1→g=5.
  Both-arms-identical still 4. Commit 6d497a619
- [x] R6 fix + rerun done 2026-09-21 (owner-directed, buy axis): HOOK slot + CHILD ACTS in both
  templates, USD 0.8198, ratings in `round-6-ratings.md`. i 3.35→3.65 (largest single-round move
  on i), both-arms-identical 4→2 for the first time, every idea has a quotable hook; a, f and g
  regressed on length pressure. Commit `34ab9a230`
- [x] R7 fix + rerun done 2026-09-21: three worst buy-axis classes (want that is an adult's job,
  hook that pulls an explanation in behind it, counted length), USD 0.8608, ratings in
  `round-7-ratings.md`. i 3.55, rule/gate leak 6→4 with no hook a decider, e 4.75 best of seven,
  cell 2's arms differ at last; the length check backfired with review self-talk inside [FINAL] in
  2/20. Commit `3b53ba824`
- [x] Review below

## Review

**Means, R1 → R5** (20 ideas per round, same ten cells, same rubric; f is scored on the R1-R4
criteria in every round — round 5's new dash rule is counted but not scored, so the column stays
comparable).

| axis | R1 | R2 | R3 | R4 | R5 | Δ R1→R5 |
|---|---|---|---|---|---|---|
| a contract (premise only) | 3.25 | 3.10 | 3.25 | 3.10 | **3.65** | +0.40 |
| b concreteness | 3.80 | 4.25 | 4.20 | 4.25 | 4.15 | +0.35 |
| c cast present with a role | 3.90 | 4.40 | 4.40 | 4.50 | **4.65** | +0.75 |
| d age fit | 3.90 | 4.00 | 4.35 | 4.50 | **4.60** | +0.70 |
| e world/theme fit | 4.30 | 4.45 | 4.45 | 4.70 | 4.55 | +0.25 |
| f language/format | 3.70 | 4.10 | 4.20 | 4.00 | 3.90 | +0.20 |
| g peril | 4.30 | 4.15 | 4.55 | 4.70 | 4.65 | +0.35 |
| h topic is the engine | 3.50 | 4.00 | 4.00 | 4.38 | **4.50** | +1.00 |
| i would a Swiss parent buy this | 3.25 | 3.25 | 3.15 | 3.30 | 3.35 | +0.10 |

**Fault classes, count out of 20 per round**

| class | R1 | R2 | R3 | R4 | R5 |
|---|---|---|---|---|---|
| Middle or solution leaked (a≤3) | 10 | 11 | 11 | 15 | **9** |
| — as a narrated event | 10 | 11 | 11 | 6 | **3** |
| — as a stated rule or gate | – | – | – | 9 | **7** |
| Both arms tell the same story | 4 | 4 | 4 | 4 | **4** |
| Cast listed rather than present (c≤3) | 6 | 3 | 4 | 3 | **3** |
| Output-format drift (f≤3) | 7 | 5 | 5 | 5 | **5** |
| Peril over the line (g≤3) | 3 | 4 | 2 | 2 | **2** |
| Theme present in name only | 3 | 3 | 3 | 3 | **3** |
| Life-skill topic bolted on (h≤3) | 5 | 3 | 3 | 2 | **2** |
| English `ROLES:` label | 2 | 2 | 0 | 0 | **0** |

**Fixes kept** (all five rounds' prompt edits stay in both templates; nothing was reverted):
quoting-style checks (check 4 "quote the words that give them a stake", check 6's quote-and-number,
check 8's topic quote) — they moved c 3.90→4.65 and h 3.50→4.50; the explicit `CUT:` step, which
made the [REVIEW] verdict actually reach [FINAL] and is honest in every round since R3; the
life-challenge outside-event sentence; the presence definition plus "co-location is not a stake";
peril tied to the youngest character *by age* (R3) and then widened to anyone on the page and the
craft they travel in (R5); writing the `ROLES:` heading in the output language; the third `rule`
label; and the computed variety values in `buildVariantInstructions`.

**What stayed flat, and why**

- **Both arms tell the same story — 4/20 in every one of five rounds.** Three shapes of the
  instruction were tried: an adjective ("a different location and structure", R1-R2), named axes
  ("vary all three of these: class of place / responsible adult / outside event", R4), and computed
  values ("these are requirements, not choices: this story plays outdoors; what makes it hard is a
  time someone else has set", R5, verified present in the prompt actually sent via `--dry-run`).
  All three land on 4. Only the *responsible adult* axis ever took. The cause is structural: the
  second call cannot see the first, so "different" is unverifiable from inside it, and both arms
  are drawn to the same strongest reading of the same inputs. The only untried lever is serialising
  the calls, rejected three times on happy-path latency (per-arm wall clock 18.6-48.4 s in R5).
- **Theme in name only (3/20) and cast-as-a-list (3/20)** — flat for three rounds, never targeted.
- **Format (5/20)** — flat for four rounds; the shape keeps changing (adjectives → 55-word
  sentences → dash-joined clauses) while the count does not.
- **i "would a parent buy this" (3.25 → 3.35)** barely moved across the whole series. Contract
  compliance is not the same thing as appeal, and this rubric only measures the first.

**Total cost across five rounds: USD 3.2966** (R1 0.5353, R2 0.6318, R3 0.6676, R4 0.7443,
R5 0.7176), `claude-sonnet-4-6`, 100 ideas.

**Commits:** `0ade598d2` (R2 fixes), `f00a844a2` (R3 fixes), `e1d352515` (R4 fixes),
`6d497a619` (R5 fixes). Decisions entry: `docs/decisions.md` → "Story-idea premise contract:
five rating rounds, what moved it and what did not".

## Review — rounds 6 and 7 (the buy axis)

Five rounds moved every defect axis and left (i) "would an adult buy this" at 3.25 → 3.35. The
owner's diagnosis and decision: the contract has slots for setting, want, obstacle and cost and
none for the hook, and the worst three ideas were fully compliant and flat. Two levers, with the
premise contract left as strict as it was — a **hook slot** (one picturable thing out of the
ordinary, plain noun, sentence 1 or 2, setup or obstacle, never the decider) and **child acts**
(the want is the main child's own, and a toddler's want is something to reach, follow, touch, hold
or get to). R7 then hit R6's three worst buy-axis classes.

| axis | R1 | R2 | R3 | R4 | R5 | R6 | R7 |
|---|---|---|---|---|---|---|---|
| a contract | 3.25 | 3.10 | 3.25 | 3.10 | **3.65** | 3.15 | 3.15 |
| b concreteness | 3.80 | 4.25 | 4.20 | 4.25 | 4.15 | 4.00 | 3.95 |
| c cast present | 3.90 | 4.40 | 4.40 | 4.50 | **4.65** | 4.40 | 4.40 |
| d age fit | 3.90 | 4.00 | 4.35 | 4.50 | 4.60 | 4.65 | **4.70** |
| e world/theme | 4.30 | 4.45 | 4.45 | 4.70 | 4.55 | 4.60 | **4.75** |
| f language/format | 3.70 | 4.10 | **4.20** | 4.00 | 3.90 | 3.35 | 3.60 |
| g peril | 4.30 | 4.15 | 4.55 | **4.70** | 4.65 | 4.30 | 4.30 |
| h topic is the engine | 3.50 | 4.00 | 4.00 | 4.38 | **4.50** | 4.38 | 4.38 |
| **i would buy** | 3.25 | 3.25 | 3.15 | 3.30 | 3.35 | **3.65** | 3.55 |

**Kept:** the hook slot and the child's own want. They moved (i) further in one round than five
rounds of defect fixes, and they broke the both-arms-identical class (4/20 → 2/20) that four shapes
of the variety instruction never touched. The "named and never explained" clause is kept — after
it, no hook is a decider and the rule/gate leak is at its series low of 4/20.

**To revert:** the R7 length check's "and name what you cut" clause. It put review self-talk inside
[FINAL] in 2/20 (once in English inside a German text) — the only shape in seven rounds a paying
user would see as broken. Keep the counting; drop the naming.

**Did not take:** the "want a child would have" rule on cell 5 — a school-exhibition slot and a
module calibration, unmoved across two rounds aimed at them. Another rule in the same list is not
the next lever.

**Still open:** cell 7 is now the only duplicated pair; the Apollo lander is a six-of-seven-round
peril miss; check 7 never reads the closing cost sentence, where R7's other peril miss lives.

**Cost, rounds 6-7: USD 1.6806** (R6 0.8198, R7 0.8608), `claude-sonnet-4-6`, 40 ideas.
Series total USD 4.9772, 140 ideas. Commits `34ab9a230` (R6), `3b53ba824` (R7).

Outputs: `tests/manual/story-idea-rounds/round-N.json` + `round-N-ratings.md` (gitignored if large).

- [x] R8 fix + rerun done 2026-09-21 (owner-directed, three changes): (A) contract room — the
  setting slot dropped, a PROMISE slot added, the CUT step's labels widened to
  setup/hook/promise/event/rule/cost, budget 4-6 sentences, examples rewritten in both templates;
  (B) `prompts/premise-shapes.txt` + `pickPremiseShapes` in `server/routes/storyIdeas.js`, one
  computed shape per arm (deterministic, always different per arm, age-filtered), injected as
  `{PREMISE_SHAPE}` / `{PREMISE_SHAPE_1}` / `{PREMISE_SHAPE_2}`, with the EVENT class removed from
  `buildVariantInstructions`; (C) the 10-12 band — diagnosed from the SENT prompt, and the cause was
  that the harness never called `loadPromptTemplates()`, so rounds 1-7 rated a prompt with no
  age-band rules at all; plus one line in the shared `not-giving-up` topic guide. USD 1.0298,
  ratings in `round-8-ratings.md`. a 3.15→3.60, b 3.95→4.20, i 3.55→3.65 (equal series best);
  promise present in 19/20 and never a leaked middle; no idea opens with an address sentence;
  cell 5's school-exhibition slot gone at last (i 3.0→4.0), cell 6 2.0→4.0. Cost: format drift
  12/20, the series worst — the dash in nine ideas. Commit below.

## Review — round 8 (contract room, the promise slot, the shape catalogue)

| axis | R5 | R6 | R7 | R8 |
|---|---|---|---|---|
| a contract | **3.65** | 3.15 | 3.15 | 3.60 |
| b concreteness | 4.15 | 4.00 | 3.95 | **4.20** |
| c cast present | **4.65** | 4.40 | 4.40 | 4.30 |
| d age fit | 4.60 | 4.65 | **4.70** | **4.70** |
| e world/theme | 4.55 | 4.60 | **4.75** | 4.65 |
| f language/format | 3.90 | 3.35 | 3.60 | 3.45 |
| g peril | **4.65** | 4.30 | 4.30 | 4.30 |
| h topic is the engine | **4.50** | 4.38 | 4.38 | 4.38 |
| **i would buy** | 3.35 | **3.65** | 3.55 | **3.65** |

**Kept:** all three changes. The promise slot is the strongest single lever the series has produced
on what a reader sees — 19 of 20 ideas carry a quotable one, none of them says whether the hero
manages it, and the feared regression (a promise that is a leaked middle) did not occur once.
Dropping the setting slot took completely and cost nothing: the landmarks are still there, now as
the scene the action is in. The shape catalogue took on 13 of 20 and every cell that moved up on
i had a shape that took.

**The finding that outranks the ratings:** the harness never loaded the prompt templates, so rounds
1-7 rated a prompt with no age-band plot-shape rules in it at all, in every cell. Production always
sent them. Round 8 is the first round comparable to the live route.

**Next round's first class is format (f≤3 at 12/20, series worst).** It is not length — 19 of 20
honour the six-sentence budget. It is the dash, in nine ideas, and five sentences past 30 words,
against a rule that has stood since round 5. The lever is position in the prompt, not another rule:
the RULES list is now twenty lines long and the age band adds ~350 words in front of it.

**Still open:** cell 7 is the only duplicated pair for the second round and the worst pair in the
round — a cast of one one-year-old with no adult in the inputs, so the "name whoever is responsible"
rule asks for something the wizard did not supply. The Apollo lander is a seven-of-eight-round peril
miss and no change has ever targeted it. `premise-shapes.txt` has no peril column, unlike
`challenge-catalogue.txt`, and two of round 8's four peril misses came from shapes.

**Cost, round 8: USD 1.0298.** Series total USD 6.0070, 160 ideas, `claude-sonnet-4-6`.
