# Toddler mode (ages 1–3) — plan

> **SUPERSEDED 2026-09-04** by the five whole-year age bands (0–1 routine, 2 quest, 3 tries,
> 4 fear-choice, 5 journey, 6+ standard). The ≤ 3 boundary and `prompts/toddler-mode.txt` are gone;
> the content rules below survive as the `routine` band. The oldest-MAIN trigger rule and the
> "reading level is untouched" ruling (§0) both still stand. → `docs/decisions.md`,
> "Five whole-year age bands replace toddler-vs-standard (2026-09-04)"

**Date:** 2026-08-25
**Owner decision:** stories for 1–3 year olds are a distinct book form, not a shortened 5-year-old book.
**Trigger rule (settled by owner, 2026-08-25):** toddler mode is on when the **oldest MAIN character is ≤ 3**.
Secondary characters never influence it. Two mains aged 5 and 1 → normal (5-year-old) story.
A 1-year-old main with a 5-year-old secondary → toddler story.

## Motivating evidence

Prod story `job_1787647410717_5dvfqu8jg` — "Leynor, der kleine Pirat, und der Schatz des Zürcher Zoos",
trial, 6 pages, de-ch, main character **age 1**. Owner's read: the premise (toddler in a pirate costume
at the zoo) is fine at this age; the plotlessness is fine at this age. What is wrong:

1. **Toddler-impossible agency.** Waits alone at Bahnhof Stettbach with a phone, rides a train to Zürich,
   reads a map, resolves a forked path by reasoning, enters a Tropenhaus alone. All 6+ actions.
2. **Wrong form and wrong length.** 100–140 words per page (~8× too long), and an arc shape
   (setup → quest → find) instead of the walk / list / refrain shape a 1–3 book runs on.

## Current state — what exists and what doesn't

**Exists (visual only):** `getAgeCategory()` (`server/lib/promptBuilders.js:724-734`) maps `age ≤ 2` →
`toddler`, and `:117-119` turns that into body-proportion prose. That is the entire toddler awareness
in the system.

**Does not exist — every narrative age branch bottoms out above 3:**

| Place | Lowest band | File:line |
|---|---|---|
| Challenge catalogue | `3–5` (139 entries; nothing below) | `prompts/challenge-catalogue.txt` |
| Idea-gen band filter | `youngest <= 5 ? ['3'] : …` | `server/routes/storyIdeas.js:212` |
| Story shape difficulty | `focusAge <= 5` | `server/lib/promptBuilders.js:4056` |
| Reading levels | `1st-grade`, 25–50 words, "for early readers" | `server/lib/promptBuilders.js:1445` |

**Trial ignores reading level entirely:** `prompts/story-trial.txt:14` and `:181` hardcode
"100–140 words per page"; the template never references `{READING_LEVEL}`.

**Prompts that would actively fight the toddler form** (repetition is the toddler engine, and these
forbid it):

- `prompts/story-beats.txt` — "Consecutive pages do not stage the same place with the same grouping"
- `prompts/story-text-from-beats.txt:57` — "name any page whose text risks repeating the page before it"
- `prompts/story-text-quality-judge.txt:26` — penalises "repetition"
- `prompts/text-refine.txt:53` — already carves out "Unless the reading level asks for very short
  sentences", so this one needs no change if the effective reading level switches (see design §2)

## Design

### 1. One trigger, one chokepoint

Extract the existing focus-character selection out of `buildStoryShapeSection`
(`promptBuilders.js:4015-4019` — filter to `mainCharacters`, sort age DESC, take first) into a shared
`pickFocusCharacter(inputData)`. Add:

```js
function resolveAgeMode(inputData)   // 'toddler' | 'standard'
```

`'toddler'` iff `parseInt(pickFocusCharacter(inputData)?.age) <= 3`. No other caller invents the rule.

### 0. Scope (owner, 2026-08-25): topic and content only

> "No leave trial on 100 words per page that is fine. Amount of text is ok, simple to produce.
> Just make the story topic simple and appropriate."

Toddler mode changes **what the story is about and what happens in it**. It does not change how much
text there is, nor the shape of the book. Specifically **out of scope**:

- Word/sentence counts anywhere. The trial keeps its hardcoded 100–140 words per page.
- Reading level (§2).
- Any picture-book *form* redesign (walk / list / repeated refrain). An earlier draft proposed one;
  it is dropped. Because nothing now depends on repetition, the anti-repetition carve-outs that draft
  needed in `story-beats.txt`, `story-text-from-beats.txt`, `story-text-quality-judge.txt` and
  `text-refine.txt` are **not** required and must not be made.

What is left is small: an age-mode resolver, one prompt fragment about age-appropriate content, and
skipping the challenge machinery.

### 2. Reading level is NOT touched (owner, 2026-08-25)

**Rejected:** an earlier draft of this plan added a 4th `LANGUAGE_LEVELS` entry (`toddler`) and had
the age mode override the wizard's selector.

Owner's reasoning: reading level encodes the *child's reading skill*, and a 3-year-old's reading skill
is the same as a 1-year-old's — the axis does not discriminate inside the toddler band, so encoding
the 1–3 distinction there is a category error. **Only the story content differs.**

Consequences for the rest of this plan:

- `LANGUAGE_LEVELS`, `getReadingLevel`, `getTokensPerPage` are unchanged. No `getEffectiveLanguageLevel`.
- Words per page stay wherever the account's `languageLevel` puts them. Toddler mode does not
  prescribe a word count, and `prompts/toddler-mode.txt` must not state one.
- `text-refine.txt` is untouched — see §0, nothing in this plan depends on repetition any more.

### 3. New prompt fragment, injected as `{TODDLER_MODE}` (empty string when not toddler)

`prompts/toddler-mode.txt`, listed in `docs/prompt-inventory.md`. Content (generic, no story-specific
examples — per CLAUDE.md prompt-genericity rule):

- **Topic:** something small, familiar and close at hand — a place visited, a thing looked at, an
  animal met, a routine. Never a quest, a search, a rescue or a secret to uncover.
- **One subject per page**, whole and close. No crowds, no distant figures, no montage.
- **Toddler-scale actions only:** pointing, naming, reaching, carrying, giving, waving, feeding,
  hiding, patting, falling and getting up. Never travelling alone, navigating, reading, planning,
  reasoning from evidence, or operating anything.
- **No transit.** The book begins where it happens. Never explain how anyone arrived.
- **Supervision without a parent character:** an adult may be present as hands at the frame edge, a
  lap, or legs behind the child — never named, never faced, never a Visual Bible entry. Alternatively
  a same-size companion (a pet or a carried toy that recurs on every page). Never a named parent.
- **One tiny reversal at most** (something is too big, too high, not there yet) — resolved on the
  same page or the next.
- **Ending:** home, comfort, or sleep. Not triumph.

*(No word counts, no sentence counts, no page-form prescription — see §0 and §2.)*

Injected into: `story-trial.txt`, `story-beats.txt`, `trial-idea.txt`,
`generate-story-idea-single.txt` / `generate-story-ideas.txt`.

### 4. Story shape — bypass the challenge budget

In `buildStoryShapeSection`, add a toddler branch **before** the `simplest` branch: zero major
challenges, no page-budget arithmetic, threads = "no storyline; a sequence of moments in one place".
In `storyIdeas.js`, skip the challenge-catalogue injection entirely when the age mode is toddler (its
lowest band is 3–5, so any sample is already wrong). *Follow-up, not in scope: author a 1–3 band for
`challenge-catalogue.txt`.*

### 5. Anti-repetition carve-outs — NOT DONE (see §0)

An earlier draft needed them to support a refrain form. That form is out of scope, so
`story-beats.txt`'s consecutive-pages rule, `story-text-from-beats.txt:57`,
`story-text-quality-judge.txt:26` and `text-refine.txt:53` are all left exactly as they are.

### 6. Trial-specific

- `trial-idea.txt`: in toddler mode, ask for a place and a thing to look at, not a goal — and forbid
  naming an ending.
- **Not done — trial text length stays as it is.** `story-trial.txt` hardcodes "100–140 words per
  page" and never references `{READING_LEVEL}`. Owner 2026-08-25: *"leave trial on 100 words per page
  that is fine."* Recorded so it is not re-proposed as a gap; the `1st-grade`-trial consequence is
  known and accepted.

### 7. Scene side

`{TODDLER_MODE}` in the scene-hint sections: camera `close-up`/`medium` only, one whole subject
centred, `background: empty` or `a few passersby`, never `busy crowd`.

## Verification (per running-validation-stories ladder — no showcase)

1. **Static:** render `buildTrialStoryPrompt` and the beats prompt for (a) a 1-year-old main,
   (b) a 5-year-old main, (c) mains aged 5 + 1, (d) a 1-year-old main with a 5-year-old secondary.
   Assert the mode matches the settled rule in all four and that (b)/(c) are byte-identical to today.
2. **Cheap run:** 4-page story on the smoke account `demo-b-hnecf@magicalstory.ch` with a 1-year-old
   main. Read every page's text and every image.
3. **Trial run:** one trial with a 1-year-old main, checking end-to-end latency stays near the ~123 s
   budget (no extra LLM calls are added by this plan).
4. **Regression:** one 5-year-old story to prove nothing changed on the normal path.

## Documentation

- `docs/decisions.md` entry: Context / Decision / Rationale / Touched files, citing story
  `job_1787647410717_5dvfqu8jg` and the settled trigger rule.
- `docs/prompt-inventory.md`: add `toddler-mode.txt`.
- `tasks/BACKLOG.md`: index this file; add the follow-up "1–3 band for challenge-catalogue.txt".

## Open / deferred

- [ ] A 1–3 age band for `challenge-catalogue.txt` (deferred — toddler mode currently skips it).
- [ ] `characters.age` provenance: the motivating story stored `age: "1"`. Not investigated whether
      the wizard collected it correctly. Flagged, not fixed.

---

## Review — implemented 2026-08-25

**Shipped:** `pickMainCharacters` extracted from `buildStoryShapeSection` (which now calls it, so
the age mode and the story shape share one focus-character definition); `resolveAgeMode`;
`buildToddlerModeSection`; `prompts/toddler-mode.txt`; `{TODDLER_MODE}` wired into
`story-trial.txt`, `story-beats.txt`, `trial-idea.txt`, `generate-story-idea-single.txt`,
`generate-story-ideas.txt`; a toddler branch in `buildStoryShapeSection`; the challenge-catalogue
sample skipped in `storyIdeas.js`; `docs/decisions.md` entry; `docs/prompt-inventory.md` row.

**One deviation from the plan, deliberate.** `pickMainCharacters` now reads a per-character
`isMain` flag when no `mainCharacters` id array is present. The idea-generation payload
(`storyService.ts` `generateStoryIdeas`) carries `isMain` but no id array, so without this the idea
stage would have fallen back to `characters[0]` and could have disagreed with the beats stage about
who the book is about. Ids still win where both exist, so no existing pipeline call changes.

**Verified:** `tests/unit/toddler-mode.test.ts` — 12 assertions, 10 cast configurations, all pass.
Covers both boundaries (3 → toddler, 4 → standard), two mains spanning the boundary, an older
secondary, the `isMain` payload shape, missing age, empty cast, that `toddler-mode.txt` states no
word count, and that the normal-path shape still prices `exactly 2` challenges.

Full suite: 166 passed, 3 failed — the 3 failures are `active-version-recompute.test.ts`, confirmed
pre-existing by re-running with all changes stashed, and already indexed under BACKLOG "Tests".

Note: `tests/unit/*.test.js` files are **not run** — vitest's include is `tests/unit/**/*.test.ts`.
This test is `.ts` for that reason, and it loads both modules through `createRequire` because an
`import` gets a second copy of the prompt-template store that `promptBuilders`' `require()` never
sees (the first version of the test failed on exactly that).

**Still unproven:** no story has been generated in toddler mode. Verification steps 2–4 (a 4-page
smoke run, a trial run, a 5-year-old regression) have not been done.
