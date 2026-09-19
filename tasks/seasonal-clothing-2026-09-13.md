# Season- and weather-appropriate clothing — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: use `executing-plans` to implement this plan task-by-task.
> **NOTHING IN THIS PLAN MAY BE BUILT UNTIL THE OPEN QUESTIONS IN §8 ARE ANSWERED.** §7 is
> deliberately a menu, not a decision — the crux in §5 changes which branch is even coherent.

**Goal:** make the outfit a character wears agree with the season the book is commissioned in,
without breaking the two standing rules that govern clothing (`clothingRequirements` is
canonical; the description must match the avatar).

**Status:** investigation complete (2026-09-13), plan written, **no code or prompt changed**.

---

## 1. The problem, and what the evidence actually says

The prompt for this work was: *"a story set in winter can dress a child in summer clothes and
nothing objects."* The investigation **partly disconfirms the premise as stated, and locates a
different, narrower failure that does reproduce.** Both results are below, with the queries.

### 1a. Season DOES exist, and it DOES reach the writer

There is a single canonical resolver, `server/lib/season.js`, with a wizard input
(`client/src/pages/wizard/WizardStep3BookSettings.tsx:83-92`, defaulted from today's date,
Northern hemisphere), a deterministic fallback, and a stamp onto the job
(`storyJobPipeline.js:7516-7524`). It reaches four places:

| Consumer | Site | What it says |
|---|---|---|
| Story brief (every text stage) | `promptBuilders.js:5312`, `:4738` | `` `Season: ${seasonLabel(inputData)}` `` — unconditional, not `? :` |
| Page image prompt | `prompts/image-generation.txt:24` `{SEASON_NOTE}`, filled `promptBuilders.js:3989` | foliage / ground / sky / daylight |
| Art Director (per-page path) | `prompts/scene-expansion.txt:112` `{SEASON}`, filled `promptBuilders.js:2678` | same |
| Post-render audit | `server/lib/styleConsistency.js:133,184,203` | `SEASON_DECLARED_MISMATCH`, `SEASON_LOCATION_CONFLICT` |

So a season signal exists and is already wired end-to-end **for scenery**. Every one of those
lines is about *foliage, ground cover, sky and daylight colour* (`season.js:92`). **Not one of
them mentions clothing.**

### 1b. Measured: the writer does NOT dress children for summer in cold stories

Query (staging + prod, `stories.data->'clothingRequirements'`, non-costumed entries only,
scratchpad script `m4.js`): every story with `data->>'season' IN ('autumn','winter')`, scanned
for an outfit description containing a bare-weather garment (`shorts|sandal|short-sleeve|
t-shirt|tank top|sundress`) **and** no warm layer (`coat|jacket|parka|scarf|mitten|glove|
beanie|boots|hoodie|sweater|wool|fleece|quilted|long-sleeve|tights|corduroy`):

| | cold-season stories with a non-costumed outfit | summery outfit, no warm layer |
|---|---|---|
| staging | 22 | **0** |
| prod | 12 | **0** |

And the prod `season='winter'` cohort (8 stories) reaches for the `winter` wardrobe slot on its
own: `job_1770323742184_kwejro7hd`, `job_1770067409009_1po1u1fdz`, `job_1769721538434_3yzhru0ga`,
`job_1769380512008_aog73mrs6`, `job_1769285688015_idstty79v` all carry `winter.used: true`.

**Conclusion: the writer, given `Season: Winter` in the brief, already dresses the cast for it.
The "nothing objects" framing is true of the evaluator (§6) but not of the generator.** Do not
build a fix for a writer failure that the stored data does not show.

Caveat on the measure, stated honestly: this is a **regex over the contract text**, not a look at
the pixels. It proves the *ordered* outfit is seasonal. It does not prove the *rendered* outfit
is — a page could still show bare arms under a correctly-specified coat. **That is unmeasured.**
Measuring it needs a VLM pass over stored page images against the contract line, which is a paid
run and is listed as an open question in §8.

Counter-measure in the same sweep: the `winter` and `summer` avatar slots are almost never used
at all — `winter` in 2/112 staging and 7/114 prod stories, `summer` in 8/112 and 5/114. Nearly
every story dresses its cast from `standard` or `costumed`. So the seasonal slots are mostly
dead weight today; the seasonality that does happen happens *inside* the `standard` description.

### 1c. Measured: the real failure is the description-less outfit — and it is the trial path

The same sweep counts outfits marked `used: true` that carry **no description at all**:

| | cold-season stories with a non-costumed outfit | outfit `used`, no description |
|---|---|---|
| staging | 22 | **12** |
| prod | 12 | **11** |

Almost all the staging cases are trial stories. The motivating story is one of them.

**`job_1789296188291_thezv15y1` — "Omar und die Kastanie für Igel Beni", staging, `trialMode: true`,
`season: "autumn"`.** Stored evidence:

- `data.clothingRequirements` is, verbatim and in full:
  `{"Omar":{"costumed":{"used":false},"standard":{"used":true,"signature":"none"}}}`
  — `used: true`, **no `description`**.
- `data.characters[0]` has **no `clothing` key and no `avatars.clothing` key** (only
  `avatars.styledAvatars`).
- `data.sceneDescriptions[0].description` → `scene.characters[0]` is
  `{"name":"Omar", …, "clothing":"standard", …}` — the **category key only**. A full-text scan of
  all 6 scene descriptions for `wearing|T-shirt|shorts|shoes|sneakers|barefoot` returns **zero
  hits**: no page of that story states an outfit in prose anywhere.
- The scene's own setting reads `"lighting":"warm soft afternoon autumn light"`,
  `"weather":"sunny"`, `"description":"…lined with fallen orange and yellow autumn leaves…"`.

Trace the resolution of that contract through the code:

1. `storyJobPipeline.js:727-735` builds the trial contract from config, not from the outline:
   ```js
   trialClothingRequirements[char.name] = {
     standard: { used: true, signature: 'none' },
     costumed: costume ? { … } : { used: false }
   };
   ```
   `signature: 'none'` is explicitly filtered out by every resolver
   (`clothingResolve.js:819` and `:830`: `if (reqs?.signature && reqs.signature !== 'none')`).
2. `buildClothingDescription` (`server/lib/entityConsistency.js:2944`) therefore falls through its
   whole ladder — `signature` → `description` → `avatars.clothing[cat]` →
   `character.clothing.structured` → `character.clothing.current` — and lands on the hardcoded
   `categoryDefaults` at `entityConsistency.js:3008-3015`:
   `standard: 'Casual everyday clothing as shown in reference'`.
3. `promptBuilders.js:3476-3503` records that there is deliberately **no outfit backstop** in the
   image prompt (owner, 2026-08-09: *"The prose is the single owner of what a character wears"*).
   With no prose and no contract, nothing states an outfit.
4. So the pixels come **entirely from the styled avatar sheet**, which was generated from the
   character's creation-time photo through `prepareStyledAvatars(…, trialClothingRequirements, …)`
   (`storyJobPipeline.js:817`) — a path with **no season input of any kind**.

**That is the bug the motivating story exhibits.** It is not "the writer ignored the season". It
is: *the trial path never states an outfit, so the outfit is whatever the child was photographed
in, and the season never enters that decision.* A child photographed in a t-shirt gets a t-shirt
in an autumn book, in every trial story, deterministically.

(The barefoot half of the original report is already fixed in `6643fef69` and is out of scope.)

### 1d. Weather, as opposed to season, does not exist on the production path

- No `weather`, `climate`, `temperature`, `hemisphere`, `month` or `timeOfYear` field in
  `inputData`, the wizard, the story brief, or the Visual Bible schema.
- The beats (production) scene metadata schema — `prompts/scene-expansion.txt:134-160` — has
  **no** `weather`, `lighting`, `time` or `season` key. Structured `time`/`weather` passthroughs
  were deleted deliberately: `server/lib/sceneMetadata.js:879` —
  `// time/weather passthroughs removed 2026-08-11: written for months, read by nothing`.
- Weather survives only in the **legacy unified** schema (`prompts/story-unified.txt:175`
  `"weather": "sunny|cloudy|rainy|snowy|n/a"`) — which is the path the trial story above ran on,
  which is why its stored scene has `"weather":"sunny"`.
- `sceneIntent` sentence 3 (`scene-expansion.txt:163`) permits weather but only as one of four
  interchangeable carriers of mood — *"the mood as it shows — in faces, posture, light or
  weather, never as a mood word"*. The worked example at `:134` contains no weather at all. It
  yields nothing reliable to dress a character against.
- Landmark photos carry a `[scope, season, time]` tag, but it is **stripped before the prompt**:
  `server/lib/visualBible.js:1135-1137` (`REF_LEADING_TAG`), by the 2026-08-16 decision that
  *"Season/weather/light come from the SCENE, never from the landmark photo"* (`season.js:16-17`).

**Bonus gap found while looking (report it, do not fix it here):** the all-pages Art Director
template used by the production beats path, `prompts/scene-expansion-all.txt:316`, has a bare
*"the setting: location, time of day, weather, lighting, mood"* line with **no `{SEASON}`
placeholder**, and `buildSceneExpansionAllPrompt` (`promptBuilders.js:2372-2447`) passes no
`SEASON` key to `fillTemplate` at `:2412`. So on the beats path the Art Director is told the
season **nowhere**; only the image prompt is, via `SEASON_NOTE`. The per-page template
(`scene-expansion.txt:112`) does get it. That asymmetry is its own item — see §8 Q1.

---

## 2. Prior decisions this plan must not reverse

Quoted, with the reversal protocol (`docs/SETTLED.md:6-14`) in force for the first two.

- **`docs/SETTLED.md:71`** — *"**Clothing canonical source is the outline's `clothingRequirements`**
  (per story, per page) — never raw `avatars.clothing`."*
  → Any fix must write the season into `clothingRequirements`, or into what produces it. A fix
  that reads the season at page time and overrides the contract reverses this line.
- **`docs/SETTLED.md:28-32`** — *"**Classification is the PROMPT's job; code may only change a
  severity.** … The sanctioned shape: the evaluator emits a **type** from the closed list, and
  code adjusts what that type may **cost**."*
  → A seasonal check may not be a regex over finding text, or a garment-keyword matcher in JS.
- **Memory `feedback_clothing_is_per_story.md:19`** — *"each story sets its own wardrobe (season,
  costume, setting)"*, and `:25` *"NEVER report 'the outline rewrote the saved avatar clothing'
  as a bug … It is by design."* Season-driven divergence from the saved wardrobe is **wanted**.
- **Memory `feedback_description_must_match_avatar.md:52`** (owner, 2026-08-26) — *"If we keep the
  avatar the description must match the avatar. As we pass both to create later images — if they
  do not match we create impossible images to render."* This is the crux; see §5.
- **Memory `feedback_avatar_colour_check_rejected.md:112`** (owner, 2026-08-27) — per-avatar
  colour/trait verification was removed and must not be re-proposed. A seasonal *avatar* check
  is adjacent enough to need an explicit ask.
- **`docs/decisions.md:553-595`** (2026-09-09) — the season is its own placeholder, not part of
  the location block, and applies in invented worlds too. Any new season plumbing goes through
  `server/lib/season.js`, never a second resolver.
- **`tasks/redo-clothing-analysis-2026-07-20.md:51-54`** — option A ("bias the outline to KEEP
  `standard` == the avatar's stored clothing") was left unapplied as a design trade-off for the
  owner. Branch B2 in §7 revives a cousin of it and must be flagged as such.
- **`docs/decisions.md:199-232`** — `clothingRequirements` covers main and primary characters
  only; secondary characters' outfits live in `secondaryCharacters[].clothing`. A seasonal rule
  must be written into **both** or it will dress half the cast.

Nothing on SETTLED.md, and nothing in `docs/decisions.md`, covers seasonal clothing. **This plan
does not reverse a settled verdict** — but §7-B2 and §6 sit close enough to two of them that both
carry an explicit ask.

---

## 3. Where the season signal should come from

Four candidates. The signal already exists for three of them; only one needs new input.

| Option | What it is | For | Against |
|---|---|---|---|
| **A. The stored `season`** (`data.season`, resolved by `season.js`) | Already on every job, already in the brief, already audited by `styleConsistency.js` | Zero new input. One resolver, already the single source. Deterministic on reruns (`season.js:73-76` resolves from the story's own date, never "now"). Consistent with the scenery the pages already render. | It is a *wizard default from today's date*, not an authored choice — a user creating a book in November for a summer holiday memory gets `autumn` unless they change the dropdown. |
| **B. The location's real climate / hemisphere** | Derive from `data.userLocation` (`{city, region, country, latitude, longitude}` — present on stored rows) | Would fix the Southern-hemisphere inversion (`season.js:44` is hardcoded Northern, as is the client at `WizardStep3BookSettings.tsx:85`) and would distinguish a Zurich winter from a Nairobi one | New data, new failure modes, and **the audience is Swiss** (`project_ads_funnel_strategy`: CH-only). Solves a problem no current user has. Also: `userLocation` is IP-derived and is about where the *reader* is, not where the story is set. |
| **C. An explicit wizard input** (a "cold / mild / warm" or weather dropdown) | New field | Authored, unambiguous | A fifth wizard control for a thing the season dropdown already implies. Wizard surface is a product decision, not an engineering one. |
| **D. Infer from the outline prose** (snow, rain, coats already written) | Read back what the writer wrote | Catches a summer-season story whose plot is a snowy mountain | Circular: the thing you are trying to constrain is the thing you would read. And prose-inference is exactly the text-matching SETTLED.md:28 forbids in scoring — the same objection applies to using it as a generator input. |

**Recommendation: A, with nothing new built.** The signal is present, canonical, already
deterministic across reruns, and already what the scenery obeys — which is precisely the
consistency that is missing (autumn leaves, summer clothes, same page). B and C are separate
product asks; D is not a signal, it is a guess. Open question Q4 in §8 puts the hemisphere gap in
front of the owner rather than silently declaring it out of scope.

---

## 4. Where the fix belongs

Three candidate layers. The argument turns on `docs/SETTLED.md:71`.

**Outline-time — `clothingRequirements` gains seasonal awareness. ← RECOMMENDED**

`clothingRequirements` is the canonical, per-story clothing decision (SETTLED.md:71), it is
authored *before* the avatar sheets are generated (`storyJobPipeline.js:1856-1866`
`onClothingRequirementsReady`, awaited before page images), and it is the input to both the
avatar sheet (`styledAvatars.js:692-700`) and the eval contract
(`evalPipeline.js:1406-1424`). Putting the season there means the sheet, the prose, the page
prompt and the judge all see one seasonally-coherent outfit, because they all already read from
this one place. Every other layer creates a second source of truth.

Concretely the writer already *has* the season (`Season: Autumn` in `STORY_BRIEF`,
`promptBuilders.js:5312`) and the `---CLOTHING REQUIREMENTS---` section
(`prompts/story-unified-imagefirst.txt:444-473`, `prompts/story-unified.txt:430-471`,
`prompts/story-bible-from-beats.txt:31-75`) never once mentions it. The only seasonal hint in
that whole section is an incidental parenthetical at `story-unified-imagefirst.txt:460`
*("e.g., a snowy adventure replaces standard sneakers with hiking boots")*. **The gap is a
missing instruction, in a prompt that already has the input.** That is the cheapest and most
correct place to close it.

**Avatar-time — the wardrobe itself.** Rejected as the primary fix. The base wardrobe
(`characters.data.avatars.{standard,winter,summer}`, `avatars.js:66`) is **per-character-global
and cross-story stale** — flagged as such at `clothingResolve.js:816-818` and
`entityConsistency.js:2947-2949`. Making it seasonal would make one character's saved wardrobe
depend on whichever story was generated last, which is the cross-story wardrobe leak that
`docs/decisions.md:6927/7035/7518` already records as a bug. **But** avatar-time is where the
*trial* failure in §1c lives, because trial skips the outline entirely — see Task 3.

**Page-time — the image prompt.** Rejected. `promptBuilders.js:3476-3503` records the owner's
2026-08-09 removal of exactly this kind of page-time clothing backstop: *"The prose is the single
owner of what a character wears."* Re-adding a seasonal clause at page time reintroduces the
thing that was deliberately deleted, and would put the page prompt in conflict with the avatar
sheet the same page attaches.

---

## 5. The crux: "the description must match the avatar"

The owner's rule (`feedback_description_must_match_avatar.md:52`): *"If we keep the avatar the
description must match the avatar … if they do not match we create impossible images to render."*

**Does a seasonal outline contract violate it? Analysis of what actually happens:**

The rule is about the **rendering-time pair** — the styled sheet image and the outfit text that
travel together into one image call. It is not a rule that the story outfit must equal the
character's *saved* avatar wardrobe; `feedback_clothing_is_per_story.md:25` says the opposite in
so many words.

And the pipeline already has the machine for a deliberate divergence: **`redress`**.
`server/lib/character2x4Sheet.js:1271-1273`:
```
// redress=true → the story outfit differs from the stored avatar's clothing;
// dress the body cells purely from costumeDescription and ignore Image 2's (old)
// clothing. Set by the caller when clothingRequirements ≠ stored.
```
Shipped in `1ad718b4` (`tasks/redo-clothing-analysis-2026-07-20.md:103`) precisely so the outline
can change a garment and the **sheet is redrawn to match**, rather than the text and the picture
disagreeing. `prepareStyledAvatars` (`styledAvatars.js:565`) regenerates story-scoped sheets from
the contract on every run and explicitly does **not** preload stored styled avatars
(`styledAvatars.js:575-579`).

**So the answer to "if the outline demands a winter coat but the avatar sheet shows a t-shirt,
which wins?" is: neither — the sheet is regenerated in the coat, and they match again.** The
contract wins, and the sheet is made to agree with it. That is the existing, designed behaviour
for costumes; a seasonal garment change is the same operation.

**Three things must hold for that to be true, and each is a verification step, not an assumption:**

1. **`redress` must actually fire on a season-driven change.** It is set "when
   `clothingRequirements` ≠ stored" — confirm the comparison catches a coat-vs-t-shirt swap
   inside `standard` and not only a category switch. → Task 1, verified statically before any
   prompt edit.
2. **The judge must see the same contract the sheet was drawn from.** It currently may not:
   `tasks/BACKLOG.md:958` records, code-proven 2026-09-13, that *"Clothing contract built
   independently for judge and generator; divergence only WARNs"* —
   `evalPipeline.js:1362-1367` rebuilds the outfit from `_currentClothing` while the page prompt
   uses `avatars.clothing[resolvedClothing]`, and `clothingResolve.js:559` only logs the
   mismatch. A seasonal contract makes that divergence *more* likely to bite, because the two
   sides would now differ by a whole garment rather than a shade. **This open bug is a hard
   prerequisite.** → Task 0.
3. **The trial path has no contract to redress against at all** (§1c). It must be fixed
   separately and cannot use the outline-time mechanism. → Task 3.

**Where the rule genuinely does bind, and the plan must not cross it:** the *base* wardrobe
(`characters.data.avatars.*`) must stay untouched by any story's season. It is global, it is
what the trait panel guards, and rewriting it per story is the cross-story leak. Seasonality is a
**story-scoped** property, written to `clothingRequirements` and rendered into **story-scoped**
sheets under `story.data.characterAvatars[name]` (`server/lib/storyAvatars.js:1-16`).

---

## 6. Should the evaluator check this at all?

**Recommendation: not in the first change, and not without a separate ask.** Reasons:

- The measured generator failure rate for seasonal contracts is **0** (§1b). An evaluator check
  buys nothing against a failure that stored data does not show, and every new scored type costs
  judge tokens and adds a false-finding surface on every page of every book.
- A new scored type is a **five-site change** (`feedback_new_scored_type_checklist.md:91-101`):
  1. prompt vocabulary — `prompts/entity-consistency-check.txt:147` (`## Type Tie-Break`), rules `:112`
  2. scoring tables — `server/lib/scoring.js:118` `ZERO_POINT_TYPES`, `:150` `MAX_SEVERITY_TYPES`, `:219` `MIN_SEVERITY_TYPES`
  3. `TYPE_TO_BUCKET` — `server/lib/evalBuckets.js:134` (plus the ownership registry at `:36`, `:48`)
  4. consolidator closed list — `prompts/feedback-consolidator.txt:76`, `:78`
  5. `subType` survival — `server/lib/scoring.js:352` in `normalizeIssues`, consumed at `:426`
  \+ the client mirror `useRepairWorkflow.ts` `entityIssuePoints`. **That is its own ask.**
- If it is ever wanted, the sanctioned shape is fixed by `SETTLED.md:28-32`: the judge emits a
  **type** (e.g. `clothing_season`), and code may only cap its severity in `MAX_SEVERITY_TYPES`.
  Note `BUCKET_BILLING_CATEGORY` (`scoring.js:503-509`) already merges every clothing type into
  one charge — *"A character can only get penalized for clothing once"* — so a new type would
  add detection, not cost.
- **A cheaper alternative exists and should be preferred:** `prompts/clothing-review.txt` already
  reviews the wardrobe contract *before any art is made* (`beatsPipeline.js:1329-1384`, fixes
  merged at `:1344-1369`), and it already receives `STORY_BRIEF` — which already carries
  `Season: …`. A seasonal line there costs **zero new tokens on any page** and catches the fault
  at the only point where fixing it is free. → Task 2.
- There is also already a book-level season audit that could carry this without a new type:
  `styleConsistency.js` judges `renderedSeason` per cell (`:635`) against the commissioned season
  (`:481`) and emits `SEASON_DECLARED_MISMATCH`. Extending its judge prompt to read the *cast's
  clothing* as a season witness is a prompt-side change to an existing type. Flagged as an option
  in §8 Q3; not proposed unilaterally.

---

## 7. Implementation — the branches, and the tasks

**Two independent branches.** Branch A is the general fix and is small. Branch B is the trial
fix and is the one the motivating story needs. They do not depend on each other.

### Task 0 — prerequisite: close the judge/generator contract divergence *(blocker)*

- **Modify:** `server/lib/clothingResolve.js:559`, `server/lib/evalPipeline.js:1362-1367`
- Already an open backlog item (`tasks/BACKLOG.md:958`), already code-proven, **not new work
  invented here**. It must land first: a seasonal contract widens the gap from a shade to a
  garment, and a warn-only divergence would turn into wasted repair passes on correct renders.
- [ ] Step 1: reproduce the divergence with a `node -e` harness over a stored story's
      `clothingRequirements` + `characters`, calling both sides and diffing.
- [ ] Step 2: make both sides call `buildClothingDescription(char, cat, artStyle, reqs)` —
      the rule already recorded in `project_clothing_canonical_source.md:70-77`.
- [ ] Step 3: turn the warn at `clothingResolve.js:559` into a loud failure per
      `feedback_clean_code_no_compromises` (fail loudly), or state why it must stay a warn.
- [ ] Step 4: unit test pinning behaviour, not wording (`feedback_behaviour_change_ships_with_its_tests`).
- [ ] Step 5: commit.

### Branch A — outline-time seasonal awareness (the general fix)

#### Task 1 — verify `redress` fires on an in-category garment swap *(no edits; evidence only)*

- **Read:** `server/lib/character2x4Sheet.js:1260-1275`, `server/lib/styledAvatars.js:295-345`,
  `:565-700`
- [ ] Step 1: find every caller that sets `redress` and quote the comparison it uses.
- [ ] Step 2: determine whether `standard` = "t-shirt + shorts" (stored) vs "anorak + corduroy
      trousers" (contract) sets `redress: true`. If it compares *categories* rather than *text*,
      it does not, and §5's whole argument fails — **stop and report, do not proceed to Task 2.**
- [ ] Step 3: write the finding into this file under a `## Review` heading. No commit of code.

#### Task 2 — write the season into the wardrobe instruction and its reviewer

Prompt-only. **Load the `validating-prompt-changes` skill first.** Wording must follow
`feedback_prompt_writing` (terse, no CRITICAL banners, no "because") and
`feedback_prompt_genericity` (archetypes only — never "an autumn churchyard in Rohrdorf").

- **Modify:**
  - `prompts/story-unified-imagefirst.txt:446` (the `**Description** (standard/winter/summer)` bullet)
  - `prompts/story-unified.txt:446` (the same bullet in the twin)
  - `prompts/story-bible-from-beats.txt:31-40` (the beats wardrobe rules)
  - `prompts/clothing-review.txt` (add the matching review criterion)
- [ ] Step 1: confirm `Season:` is present in the built prompt each template actually receives —
      read the BUILT prompt, not the template (`feedback_dont_claim_production_from_your_own_harness`).
      `story-unified*.txt` gets it only via `{STORY_BRIEF}`; `story-bible-from-beats.txt` likewise.
- [ ] Step 2: add one rule to each wardrobe section, of the shape: *the outfit suits the
      commissioned season — outer layer, sleeve length and footwear follow it; a cold season is
      not dressed in bare arms or open shoes.* Archetypal only.
- [ ] Step 3: add the mirror criterion to `prompts/clothing-review.txt` so the contract is
      checked before any art is paid for.
- [ ] Step 4: decide and state, in the prompt, whether a cold season should prefer the `winter`
      **slot** or a warm `standard` description. **Blocked on Q2 (§8)** — the slots are near-dead
      (§1b) and switching slot changes which avatar sheet is generated.
- [ ] Step 5: run the existing prompt/unit tests; add one pinning that the season line survives
      `shrinkPromptForModel` (`project_prompt_shrink_hazard` — the shrinker deletes head blocks;
      a must-survive instruction belongs at the protected tail END).
- [ ] Step 6: commit.

### Branch B — the trial path (the motivating story)

#### Task 3 — give the trial contract a real, seasonal outfit description

- **Modify:** `storyJobPipeline.js:727-735`; possibly `server/config/trialCostumes.js`
- The trial contract is `{ standard: { used: true, signature: 'none' } }` — a `used: true` with
  nothing behind it, which `clothingResolve.js:819,830` discards and
  `entityConsistency.js:3008-3015` replaces with a generic default. Nothing in the trial states
  an outfit at any stage (verified: zero clothing words across all 6 scene descriptions of
  `job_1789296188291_thezv15y1`).
- Three shapes, **owner's choice — Q5 in §8**:
  - **B1.** Give the trial a per-season `standard` description from config, alongside the
    existing `trialCostumes.js` mapping. Cheapest; no extra model call; deterministic.
  - **B2.** Have the trial read the character's stored `avatars.clothing.standard` and adapt it
    for the season. **Note:** this is a cousin of option A in
    `tasks/redo-clothing-analysis-2026-07-20.md:51-54`, which was left unapplied as an owner
    decision, and it reads the global wardrobe the trial character does not have anyway.
  - **B3.** Leave the contract empty and instead make the trial's **avatar sheet** seasonal
    (`prepareStyledAvatars` at `storyJobPipeline.js:817`). Fixes the pixels but leaves the
    contract empty, so the judge still has no contract — `image-evaluation.txt:62` (N-16) then
    reports nothing, by design.
- [ ] Step 1: write a failing unit test asserting a trial contract for an autumn story yields a
      non-empty, season-appropriate `standard.description` through
      `buildClothingDescription(char, 'standard', artStyle, reqs)`.
- [ ] Step 2: run it, confirm it fails on the generic `categoryDefaults` string.
- [ ] Step 3: implement the chosen shape.
- [ ] Step 4: run it, confirm pass; run the full trial unit suite.
- [ ] Step 5: check sibling paths — **load `fixing-sibling-paths`**. The trial contract is read at
      `storyJobPipeline.js:959`, `:1160`, `:1189`, `:1563`, `:1593`, `:2256` (covers). All six must
      see the same outfit.
- [ ] Step 6: commit.

#### Task 4 — close the beats-path Art Director season gap *(separate, blocked on Q1)*

- **Modify:** `prompts/scene-expansion-all.txt:316`; `server/lib/promptBuilders.js:2412`
- The production beats Art Director is told the season nowhere (§1d). This is arguably a bug in
  its own right and independent of clothing. **Do not fold it into Branch A** —
  `feedback_build_exactly_what_was_agreed`. Raise it, let the owner decide.

---

## 8. Open questions for the owner — **answer before anything is built**

1. **The beats Art Director gets no season at all** (`scene-expansion-all.txt:316` has no
   `{SEASON}`, `promptBuilders.js:2412` passes no `SEASON`), while the per-page template does.
   Is that deliberate, or the bug it looks like? Fix it as part of this work, as its own item, or
   leave it?
2. **Slot or description?** The `winter` / `summer` avatar slots are nearly dead — winter used in
   2/112 staging and 7/114 prod stories. For a cold season, should the writer switch the
   **category** to `winter` (which changes which sheet is generated, and which every per-page
   `clothing` field must then name), or keep `standard` and write a warm outfit **into its
   description**? These are meaningfully different code paths.
3. **Evaluator: yes, no, or reuse?** Recommendation is *no new scored type* (§6). The two
   alternatives are (a) the free pre-art check in `clothing-review.txt`, (b) extending the
   existing `styleConsistency.js` season judge to read the cast's clothing as a season witness —
   a prompt-side change to an existing type rather than a five-site addition. Which?
4. **Hemisphere.** `season.js:44` and `WizardStep3BookSettings.tsx:85` are hardcoded Northern. The
   audience is CH-only, so this affects nobody today. Leave it, or fix while in the file?
5. **Which trial shape** — B1, B2 or B3 (Task 3)?
6. **Is the unmeasured half worth measuring?** §1b proves the *contract* is seasonal; it does not
   prove the *pixels* are. Establishing that needs a VLM pass over stored page images of the ~34
   cold-season stories against their contract lines. Estimated well under CHF 0.50 on stored
   images with no regeneration — but it is a paid call and needs a mandate. Worth it before
   building, or build on the contract-level evidence?

---

## 9. Validation and cost

Per `running-validation-stories`, climbing the ladder — **a showcase is the last resort**, and
`feedback_never_run_showcase_unprompted` applies.

| Rung | What | Cost |
|---|---|---|
| 1. Stored evidence | Re-run the §1 sweeps after the change and confirm 0 description-less cold-season outfits. The scripts are in this session's scratchpad; re-create from §1 if gone. | **$0** |
| 2. Built-prompt read | Dump the BUILT wardrobe prompt for a stored autumn job and confirm the season rule is present *and survives the shrinker*. | **$0** |
| 3. Unit tests | Task 0 Step 4, Task 3 Step 1. | **$0** |
| 4. Trial run | One `/try` run on staging with `season` forced to `winter` — this is the exact reproduction of §1c. Per `running-trial-showcases`. | ~CHF 0.30-0.50 |
| 5. 4-page smoke story | On the smoke account `demo-b-hnecf@magicalstory.ch`, non-trial, cold season, no character recreation — validates Branch A. | ~CHF 0.50 |
| 6. Full showcase | **Not needed.** No structural or character-pipeline change here. | — |

Rungs 4 and 5 are the only paid steps, ≈ CHF 1 total. Both need an explicit mandate
(`paid API calls need a mandate and a cap`). **Verify the deploy SHA via `/api/health` before
either** (`feedback_verify_deploy_before_validation`), and remember the analyzer image lags
`/api/health` by ~15x (`feedback_analyzer_deploy_lag`).

---

## 10. Review

*(Fill in after execution. Record: whether `redress` fires on an in-category swap (Task 1), the
post-change sweep numbers, and a `docs/decisions.md` entry for whichever branch ships —
seasonal clothing is a behavioural rule with a non-obvious rationale and belongs there.)*
