# Screen from round 10 — the baseline and the four variant diffs (2026-09-21)

Free part only. **No generation was run and nothing was spent**: the owner stopped the
screen before the four paid rounds. What is recorded here is the restored baseline, the
`--variant=` mechanism, and the dry-run diff of each variant against that baseline.

## The baseline

`prompts/generate-story-idea-single.txt`, `prompts/generate-story-ideas.txt` and
`prompts/age-band-journey.txt` are byte-identical to `902399b9b` (the round-10 commit).
Rounds 11, 12 and 13 are rolled out of the templates: the peril quoting clauses, the
felt-cost and one-thing-each adult rules, the TURN slot, the removal of HOOK and PROMISE,
the three-to-five budget, and the `{WORLD_SEED}` placeholder.

Kept from after round 10, as instructed:

| kept | why |
|---|---|
| `prompts/adventure-guides.txt` @ `abf78b05d` | the ten `Who lives here` / `What turns` lists per world, and the five-prop lists |
| `SHAPE_PERIL_PRONE` (`6e0032049`) | `rescue` withheld from a cast whose youngest is ≤ 5 |
| `server/lib/worldSeeds.js` + telemetry | the centre/turn pick still runs and still rides in `idea_generated`; it is simply not injected |
| the client roles cast line | display only, invisible to the harness |

`{WORLD_SEED}`, `{WORLD_SEED_1}` and `{WORLD_SEED_2}` stay declared in `applyReplacements`
(pinned by `tests/unit/world-seeds.test.ts`), so no call site can ship an unfilled
placeholder; there is simply no placeholder left in either template to fill.

### Verification — cell 1, built prompt vs the round-10 stored prompt

`node tests/manual/story-idea-rounds.js --dry-run --cells=1` against
`round-10.json` → cell 1, both arms. Two differences, both expected:

1. **The adventure-guide section** (deliberate, and present in the baseline and in all four
   variants alike): the two ten-item lists are inserted, `telescope` drops off the prop list,
   and one line is added — `The idea is built on one centre and one turn, never on the props.`
   Nothing injects or points at the lists; they are present and unused.
2. **The premise shapes shifted by one position.** Cell 1's youngest is 3, so
   `SHAPE_PERIL_PRONE` removes `rescue` from the pool, the pool loses an entry and the
   index arithmetic lands elsewhere: arm 1 `race against time` → `a lost thing that moves`,
   arm 2 `a lost thing that moves` → `a visitor who will not leave`. This follows from the
   filter the owner asked to keep. It is not a defect, but it means **the baseline is not
   shape-identical to round 10 on the four cells whose youngest is ≤ 5** (cells 1, 2, 6, 7),
   and an arm-by-arm comparison against the stored R10 texts on those cells compares
   different shapes.

Everything else in both prompts is byte-identical.

## The variant mechanism

`tests/manual/story-idea-rounds.js --variant=<name>`. All four variants live in the harness,
never in the committed templates, so the four runs come from ONE commit and nothing is edited
between them. Three forms:

- **substitution** — applied to the single template AND asserted on the pair template, so a
  sibling set cannot drift. Each `from` must occur **exactly once** per template or the run
  throws; a silently-missed edit would measure the baseline twice.
- **guide suffix** — an override of the `ADVENTURE_SETTING_GUIDE` value (the route now returns
  `adventureSettingGuide` so a caller can append to it without rebuilding it).
- **route option** — `perilYoungestMax`, a measurement knob defaulting to
  `SHAPE_PERIL_MAX_YOUNGEST` (5), i.e. production is unchanged.

Dry runs write `dry-run-<variant>-<cells>.json`, so the diffs coexist.

## The four diffs

### 1. `peril-input` — no template change

Route option `perilYoungestMax: 7`: the challenge-catalogue sample drops every entry flagged
peril-prone (field 5 = `1`) and `SHAPE_PERIL_PRONE` withholds `rescue` whenever the youngest
is **under 8** instead of under 6.

Cell 1 (youngest 3) shows a zero diff — it was already below the old threshold. The cells the
variant actually bites on are those with a youngest of 6 or 7: cells 3 and 9. Verified on
**cell 3** (youngest 7) by flag, not by sample, because the catalogue sample is randomised per
call and the raw text diff is dominated by that noise:

| | catalogue sample | peril-flagged entries in it | shapes |
|---|---|---|---|
| baseline | 40 | **3** (a chase through a crowded breakable place; a storm strands the party; a guide who gives the wrong directions on purpose) | an unwanted companion / a promise to keep |
| `peril-input` | 40 | **0** | a promise to keep / a secret kept |

The shape change is the second half of the variant: the pool loses `rescue` and the index
arithmetic moves. No template byte changed.

### 2. `adult-line` — two sites, one sentence

Exactly two lines change in each template, both arms:

```
RULES:
- The youngest main character does something in the idea, and whoever is responsible for them is named.
+ An adult is in the idea only when the story needs them, and then they want something of their own.

check 4:
- ... quote the words that give them a stake. Living with, coming along with, or waiting for the others is not a stake. A name with no such words ...
+ ... quote the words that give them a stake. An adult is in the idea only when the story needs them, and then they want something of their own. A name with no such words ...
```

Nothing else. The peril check, the CUT labels, the hook and promise checks and the
four-to-six budget are untouched.

### 3. `turn-examples` — three examples, nothing else

The three round-10 examples are replaced by the three of `3c9937df8` verbatim (pulled from
git, not retyped), in both templates. Each gains one sentence in which something acts back —
the gap-keeper says the grandmother's name; the gravel slides and there is more of the animal
than one child can carry; the singing stops and the garden decides the child let the goat in —
and each cost sentence changes with it. Six sentences each, inside the round-10 budget.

No rule, no check, no label, no slot: the examples are the only bytes that move.

### 4. `seeds-soft` — one line in the guide section

One line is appended to `ADVENTURE_SETTING_GUIDE`, after the last guide line and before
`**LOCATION PREFERENCE**` / `**SEASON**`:

```
+ Pick one from each list, or one in their spirit.
```

No code pick, no placeholder, no template change. The two lists themselves were already
present in the baseline and in every variant.

## What was NOT done

The four paid rounds (`--round=v-peril`, `v-adult`, `v-turn`, `v-seeds`), the 120-text blind
set, `blind-scores-screen.md`, the N-round `analyze-blind.js` and `screen-defects.md` — none
of it ran. `make-blind.js` and `analyze-blind.js` are unchanged and still take two rounds.
