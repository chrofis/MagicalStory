# 01-ARC — judge findings (job_1790100385959_1nitlympp, "Das Ei im Laub", built at b03c64b0)

## Status 2026-09-23

Checked against staging `31fd7db0c` (after the evening fix round). FIXED = the commit that fixes it; OPEN = no fix yet, no ruling needed to start; OWNER CALL = touches a decision, a SETTLED line or has options the owner picks. Stale-doc and registry items listed at the end of each file were corrected in `a25ecb865` unless listed below.

- FIXED: #1 "(none" parsed as a character — `86d6ff4a7` (open-bracket sentinel in `parseFigureList`; the create spec and arc-retell say an empty list is the heading alone).
- OPEN: #4 panel/hints language line, #5 "central figure" definition, #6 ENTRANCE/ASSUMED rule missing from TELLING_RULES, #8 topic-guide lines lifted verbatim, #9 hints carry no sentence anchors, #10 commission walk, #11 eight-year-old listener vs AGE_MODE, #14 "therefore" connector; B (arc_hints prompt and retell raw reply not stored).
- OWNER CALL: #2 pets named in saved details (prompt widening vs code harvest), #3 main-cast label vs STORY SHAPE, #7 user-described view vs photo-vantage rule, #12 size-of-change exception (reversal of 2026-09-06), #13 permitting parent closing the loop; C landmark-list trimming.

---

Stages: arc_create (claude-opus-5, default effort) → arc_panel ×3 (grok-4.6 / deepseek-v4-pro / gpt-5.6-luna-pro, same prompt) → arc_retell (claude-opus-5) → arc_hints (grok-4.6, prompt NOT stored; rebuilt from `prompts/arc-hints.txt` + `buildArcHintsPrompt` promptBuilders.js:8646).
Prompts as sent: create 32.7k chars, panel 23.2k, retell 53.1k, hints ≈6.5k (brief 1.8k + final arc 4.3k + source rule 0.4k + char details 2.4k).
Create committed Arc 2 ("Turi"); retell rebuilt it (shop-window trip cut); final critique = 5 × MINOR.

Legend: **[RUN]** = confirmed by this run's stored output; **[JUDG]** = judgement, no direct evidence in this run.

---

## A. Ranked findings

### 1. [HIGH][RUN] Parser turns "(none — …)" into a commissioned character named "(none" — real bug, still open at HEAD
- Create critique wrote, as the spec invites (it asks for the heading "even when no figure is on the list" but never says how an empty list is written): `- (none — the premise supplies no named figure beyond Levin, Julian, Max, Kiaan)` (02-arc_create.RESPONSE.txt:27, :82).
- `parseFigureList` (promptBuilders.js:8760) cuts at " — " → name `"(none"`. `isNegativeFigureAnswer` (:8740) removes only a *closed* trailing parenthetical, so `"(none"` survives and gets pushed. I replayed the regex locally: `bare = "(none"`.
- beatsPipeline.js:1000 sets `arcPremiseNames = ["(none"]`, and :1278 adds it to `commissionedNames`. The plan counters then fire against the phantom figure, twice (rawOutline.full.txt BEATS REVIEW): `PLAN[NO_FOCAL_PAGE]: (none never has a focal page`, `PLAN[UNDER_COVERED_CHARACTER]: (none is in frame on 0 page(s)`. Both came before and after the re-plan, and the first set helped buy "Re-divided page(s): 1, 5, 6, 17, 18".
- This is the 2026-09-17 bug class again (`- none (…)`, comment at :8761), in a different shape. `git diff b03c64b0 HEAD`: **not fixed**.
- This is a clear bug, so it belongs in `tasks/bugs.json` (I am read-only and did not add it). Proper fix, in two parts. (a) Parser: strip a *leading* "(" too, or test the sentinel on the text inside the parentheses. (b) Prompt: add one sentence to the spec, e.g. "An empty list is the heading alone, with no dash line."

### 2. [HIGH][RUN] Named pet from a character's saved details has nowhere to go: Nia gets charged as "invented" downstream
- Nia exists only in Max's *Special details* ("Seine Hündin heisst Nia"), not in the premise and not in the character list. The "Premise figures" definition covers only figures "the commission's own premise supplies that its character list does not" (arc-create via `arcCritiqueSpec` promptBuilders.js:8543; arc-retell.txt:42). The budget rule says "Not counted: anyone the commission named, including any animal or companion it supplied" (promptBuilders.js ARC_BUDGETS).
- The creator resolved this by prose. It put Nia on neither list and wrote `(Nia is supplied by the commissioned cast and is not counted…)` after the Allowed line (02:87). The parser cannot read that.
- The plan counters then fired `PLAN[ARC_INVENTED_UNDECLARED] … Nia` and `PLAN[ARC_INVENTED_OVER_ALLOWANCE] … 3 invented figures (Turi, Flämmli, Nia) against an allowance of 2`, both before and after the re-plan (rawOutline BEATS REVIEW).
- None of the three panelists' CAST lenses flagged Nia (arc-panel.txt:27 has the same wording gap).
- This is a generator↔critic gap across stages: the arc prompt, the panel and the plan counters use three different definitions of "commissioned". Fix: widen the premise-figures definition to "a named figure the commission's premise **or a character's saved details** supplies", in both constants plus arc-panel CAST. Alternatively, have code harvest pet names from `specialDetails`. Code-side extraction from prose is the forbidden pattern, so the prompt route is preferable. Ask the owner.

### 3. [HIGH][RUN] Main-cast contradiction: 4 figures labelled "(main character)", STORY SHAPE says 2, and "no moment of their own" fights the critique, the telling rules and the plan counters
- CHARACTER DETAILS labels all four `(main character)` (01-create:32/39/46/53), because `mainCharacters` holds all 4 ids (input_data.json) and `buildStoryContextFields` promptBuilders.js:6612.
- STORY SHAPE (promptBuilders.js:6336 / :6227-6228) says "Main characters: Levin (5) and Julian (3) — at most two carry a book … Everyone else — Max, Kiaan — is simply there alongside the main character. **No moment of their own, no arc.**"
- The same prompt also asks for the opposite. TELLING_RULES (:8471, :8495, :8496) say "Each character's nature causes a problem or solves one", "each gets one line of their own on first appearance", "distinctive voice". Critique Q4 asks "Are the figures people a child likes … can tell apart?". The fault list says "a removable character".
- Evidence: the create critique marks Kiaan as the weak spot ("Kiaan barely", "Kiaan is the thinnest"), and the final critique Fault 1 says "[MINOR] Kiaan … could be folded into Max without loss". Downstream, `PLAN[NO_FOCAL_PAGE]: Kiaan never has a focal page` (1st division) and `… Max never has a focal page` (after the re-plan). So the arc was told to keep Max and Kiaan moment-less, and the next stage deducts for exactly that.
- Fix (needs an owner decision, not a string edit): (a) the "(main character)" label must match `pickMainCharacters`, so the prompt never carries two different main-cast claims; (b) "No moment of their own" should become "no arc of their own; each still does one thing only they would do".

### 4. [MED][RUN] Panel prompt has no working-language instruction, so Panelist C answered in German
- arc-panel.txt has no "Work in ENGLISH" (create and retell line 1 do). The <user_input> is German, and gpt-5.6-luna-pro replied fully in German ("## Turn-für-Turn-Prüfung … M1 – Landmarke …", 04-…C…txt). That text went verbatim into the retell prompt (05-retell:387-420).
- The retell handled it this time. But two languages in one critic block is noise, and future parsers of panel text would break.
- Fix: one line in arc-panel.txt ("Answer in ENGLISH."). Same for arc-hints.txt (its grok output happened to be English). Not fixed at HEAD.

### 5. [MED][RUN] The "central figure" check is undefined, and the creator reads it as the hero
- The rule "The commission's central figure acts in every third … never reduced to cargo" (promptBuilders.js:8500) and the Check line (:8554) were born from "the title dragon acted twice after hatching (cargo)" (decisions.md:33618). So the central figure is meant to be the commission's title creature/subject.
- Neither text says so. Both the create critique and the final critique answer "Central figure: **Levin** reads Turi's lie … OK" (02:37/93; 06:9). The check duplicates the hero-competence rule and never tests the thing it was built for.
- Here the commissioned subject is an egg, which cannot act until it hatches (final arc s17), so "never cargo" is also unsatisfiable for an egg premise.
- Fix: define it once in the constant ("the figure the commission's story idea is about: its creature, title figure or quest object, **not** the main character; an egg or object acts through what it does to others, such as cooling, knocking or moving").

### 6. [MED][RUN] Panel ENTRANCE/ASSUMED lens deducts for rules the creator was never given (generator↔critic gap)
- arc-panel.txt:20-21: "Figures who do not know each other meet on the page before they act together", "a name never exchanged".
- The creator's TELLING_RULES only say "each gets one line of their own on first appearance" (promptBuilders.js:8495). Nothing tells the creator that strangers exchange names or that a figure's possession or arrival needs a cause.
- In this run, committed Arc 2 never exchanges names yet ends "Levin asks Max and Kiaan…". Julian's Marroni appear from nowhere (s7). Turi arrives with no cause (s5). Panel A #1/#4/#9, B #1 and C M4/M5 all caught these, and the retell fixed them (final s1 stand, s3 names, s4 shadow). So the arc was corrected after the fact instead of written right.
- The `arc-generator-vs-critic` registry set exists for exactly this. Fix: add one line to TELLING_RULES mirroring ENTRANCE/ASSUMED ("strangers meet and are named on the page before they act together; nothing is carried, known or used that the arc has not given them").
- HEAD added the SENSE lens (725a4cd45). Its generator mirror went into the *critique fault list* only (promptBuilders.js:8565), not into TELLING_RULES, so the creator still writes blind to it and only self-critiques against it.

### 7. [MED][RUN] Photo-vantage landmark rule overrides the user's own described view
- The premise says "wo man die Türme des Grossmünsters über den Dächern der Stadt sehen kann".
- The landmark block (01-create:166) forbids "a skyline from a hilltop", and Grossmünster's only exterior photo is "viewed across waterfront from lower…". The final critique records: "The Grossmünster view the idea suggests is dropped, because no listed photo shows that vantage" (06:10).
- The commission section says "the world it happens in" is binding. The prompt never says which rule wins when the user's own words name the view. The creator chose the photo rule, and a user-requested element vanished.
- Fix (owner call): "a view the commission's own words describe stands; it is drawn as background from what the photos show". Otherwise the gap should at least be reported to the landmark pipeline.
- Related: panel A #8, B #8 and C M1 all flagged the committed arc's Bahnhofstrasse "steps up to the Lindenhof" and its "lights … from the hill" as bad vantages that the creator's own LANDMARK self-check missed (create Checks have no landmark line). The creator critique spec has no landmark check even though the panel has a LANDMARK lens, which is another generator↔critic asymmetry.

### 8. [MED][RUN] Topic-guide "What turns" line lifted verbatim into the book as a stated realisation
- Guide line: "The one who was feared turns out to be the one who is frightened" (01-create:78).
- It appears in committed arc s12 ("so the one they were afraid of is the one who is frightened") and final arc s13 ("therefore the boys see that the one they were afraid of is the one who is frightened"). The book text then states it (rawOutline:711): "Der Drache, der ihnen Angst gemacht hatte, war selbst voller Angst. Das sahen sie jetzt ganz deutlich."
- That is a moral stated in narration, which Q5 and the ending rule forbid ("acted on and never stated"). The final critique Q5 says "Acted, never stated", so the self-check missed its own verbatim lift.
- Fix: label the guide's pick-lists as *plot shapes to enact, never sentences to write*. One line at the TOPIC GUIDE header, applied generically to all guides.

### 9. [MED][RUN] Hints carry no sentence anchors, so one hint was misplaced and created a continuity error in the plan
- Hint 3: "Let Julian eat one cooled Marroni in the huddle before the shell knocks" (08-arc_hints). The planner placed it on **page 14**: "eats it in the huddle against Turi's warm side while the others wait". That page sits *before* the egg is found (p15) and before Turi curls round the nest (arc s16), so the huddle does not exist yet at p14. Plan check flagged p14 ("claims completed generosity … neither shown").
- Hint 1 was a real arc contradiction: final s14 sends Turi to the wall, yet Levin finds the steam "at the wall" (s15). It is *never repaired in the arc text* that travels downstream (rawOutline ---ARC--- still has it); only the beats silently resolved it.
- Fix: the hints prompt asks each ISSUE to cite the arc sentence number(s) ("ISSUE (s14-15): …"). The parser regex (promptBuilders.js:8696) already tolerates a prefix before the colon only if it is kept inside "ISSUE", so check the regex when changing the format.

### 10. [LOW-MED][RUN] Commission self-check misses a named premise element
- The premise: "Zwei fremde Buben … stehen auf der anderen Seite desselben Baumes und haben dasselbe Ei **zur gleichen Zeit** entdeckt".
- Committed Arc 2 s3: "Max comes round the tree…" (arrives after). Its Check says "Commission honored: … four boys who do not know each other … — delivered. OK" (02:94). Panel C M2 caught it, and the retell fixed it (s2 "digging into the same pile from the other side of the trunk").
- The "Commission honored" check asks about "central quest and named elements" but gives no instruction to walk the premise sentence by sentence. Suggestion: "list each concrete element the story idea names and say where the arc delivers it".

### 11. [LOW-MED][RUN] Reader-age contradiction inside one prompt: 5 vs early reader vs 8
- AGE_MODE: "The child this book is for is five" and BUDGETS "read aloud to a five-year-old". Reading level: "early readers" (languageLevel 1st-grade). The critique spec, hard-coded at promptBuilders.js:8557: "answered as an **eight-year-old** listener".
- The 8 is a 2026-08-30/31 constant (decisions.md:29832, :30072) that predates the age-mode section. The judge persona is 3 years older than the stated reader in the same prompt.
- Fix: fill it from the same focus age the AGE_MODE header uses (`youngestMainAge` / focus age), with one source. No run evidence of harm beyond an inconsistent persona.

### 12. [LOW][RUN] Size-of-change rule is ignored by both panel and retell, and the result was better
- Panel rule: "A solution to a MAJOR fault stays inside the existing structure" (arc-panel.txt:31). Retell rule: "MAJOR faults are repaired inside the kept structure" (arc-retell.txt:39). The only exception is an invented rule or mechanism.
- Panel A sol.1 "the egg does not leave the hill again", and the retell cut the whole Bahnhofstrasse episode (Fixing: "MAJOR 2 by cutting the shop-window trip outright"). A location detour is not a rule or mechanism, so this is outside the licence.
- The creator itself proposed the cut (create fault 2: "or it should be cut and the loss moved up"), and the cut removed three geography absurdities (panel A#3, B#7, C M7).
- Either widen the exception ("…or an episode whose only purpose is the faulted one") or accept that the rule is not enforced. **This is a change to the 2026-09-06 decision (decisions.md:34695 "structural restraint gains one exception"), so it needs the owner and the reversal protocol.**

### 13. [LOW][JUDG] Unsupervised 3- and 5-year-old after dark; the permitting parent never returns
- Final s1 adds "their mother … lets them play up on the Lindenhof if they stay by the big linden". She never reappears. The book ends in the dark with four children aged 3-5 alone (book text rawOutline:613 "Jetzt durften die beiden alleine auf den Lindenhof").
- The rules cover "An adult who permits it still says what to watch for" and "children safe and together", but not the permitting adult closing the loop. The final critique Fault 4 notes only that her rule is "never tested".
- The plan counters then counted "their mother" as an invented figure (first division), while the arc budget says an unnamed figure does not count. That is another cross-stage counting disagreement (plan-group scope).

### 14. [LOW][RUN] "therefore" as a mechanical connector
- The rule "Every sentence follows from the one before — therefore, or but" (promptBuilders.js:8469) produces "Julian holds the steaming bag against his cheek, **therefore** Levin says that steam always means something is warm" (final s1). There are 13 "therefore" in the stored outline.
- The rule constrains causality but is read as a lexical requirement. Reword: "each sentence is caused by or pushes against the one before; the word itself is optional".

---

## B. Missing (per prompt)
- **arc_create:** the stranger-naming/arrival rule (see #6). A landmark line in the self-check (the panel has LANDMARK). A definition of "central figure" (#5). A home for pets named in saved details (#2). How to write an empty figure list (#1).
- **arc_panel:** a language line (#4). CHARACTER_SOURCE_RULE: the panel reads "Max und Kiaan sind seine guten Freunde" with no rule saying the premise wins. No harm this run (panel A enforced the first meeting), but the `character-source-claim` registry set lists create, retell, story-arc-review, beats and hints, **not arc-panel**. Not told the reader age, the event budget or the telling rules, so no panelist checks events or age-fit. Deliberate? Undocumented (see D).
- **arc_retell:** nothing structural missing. It does not receive the *discarded* arc, which had the better geography (Rathausbrücke/Schober actually sit across the Limmat from Lindenhof) and the "knock" device. That is by design (one committed arc) and fine.
- **arc_hints:** no reader age, no telling rules, no landmark list, no final critique (so it may re-raise known MINORs), no sentence anchors (#9), no language line. The prompt is **not persisted** (beatsPipeline.js:1155-1163 builds `hintsPrompt` but the `arcReviewReport` at :1173ff stores only `arcHints`). The retell *raw* reply is also not stored (manifest: "PARSED fields; raw reply not stored"), so the "Challenges taken" `[C###]` tags (stripped by parseArcRetell :8857, kept as `takenIds`) cannot be audited against the raw. This contradicts the comment at :1170 "Everything the machine produced, verbatim".

## C. Bloat (chars per call; input data vs instruction)
| item | where | chars | kind | note |
|---|---|---|---|---|
| REAL LANDMARKS list, 20 entries | create, panel, retell | ~8.3k ×3 ≈ 25k | input data | Story used Lindenhof + Bahnhofstrasse (create Arc 1: 4). FIFA Museum, Zoo, Giacometti-Halle, James Joyce Foundation, Kunsthaus and Hauptbahnhof interior are irrelevant to a Lindenhof premise. Three descriptions are in French or German. A proximity/relevance cut to ~8 would save ~5k per call. Landmark-pipeline decision. |
| Retell re-sends full create context | retell | ~31k | input + instruction | Needed (separate call). Candidate for prompt caching on the shared prefix; order currently differs (CHALLENGE_IDEAS moved after TELLING_RULES), which breaks prefix reuse. |
| Topic guide irrelevant parts | create, retell | ~0.9k ×2 | instruction data | "COSTUME: not needed - use standard, summer or winter avatar" is an image-pipeline instruction in a story prompt. "Set in mountain eyries, valleys of mist, volcanic ridges…" contradicts a city commission. "saddle and harness, a hot spring". |
| Trait lists (Levin 25 strengths / 7 flaws) | all 4 | ~1.2k ×4 | input data | Known and decided (decisions.md ~49519: wizard cap fixes it going forward). Profile predates the cap. |
| Reading level "3-6 sentences per page (25-70 words)" | create, retell | ~120 ×2 | instruction | The arc "has no pages" (critique spec). Irrelevant at this stage. |
| Rule duplication: no-adult-rescue (STORY SHAPE "Cause", HERO "never a grown-up", RULES "children resolve it themselves"); low point (HERO + RULES); visible change (SHAPE + RULES); stay together (two RULES lines that disagree: "unless it has a reason to separate" vs "never two groups") | create, retell | ~1.2k ×2 | instruction | Consolidate to one statement each. The two stay-together lines contradict for noSplit books. |
| Panelist C turn-by-turn walk (18 lines + 13 issues, German) passed verbatim | retell | ~5.9k | model output | The panel prompt asks "Name each missed issue in one line"; the walk is extra. |

## D. Blind / withholding and doc gaps
| stage | shown | withheld | documented? |
|---|---|---|---|
| arc_create | everything incl. challenge draw, topic guide, landmarks | — | yes |
| arc_panel | commission, char details, landmarks, committed arc + creator's critique + Stronger line, invented allowance | reader age/AGE_MODE, reading level, BUDGETS (events), TELLING_RULES, STORY_SHAPE, topic guide, challenge draw, CHARACTER_SOURCE_RULE, the discarded arc, language line | **Partly.** Seeing the creator's critique is documented (decisions 2026-09-01 "missed issues"). The allowance (2026-09-09) and landmarks (A14, 2026-09-21) are documented as additions. **No entry says why the panel is blind to age, rules and budgets, or why it lacks the source rule.** prompt-inventory.md:35 does not list withheld inputs. |
| arc_retell | everything create had + committed arc + critique + all 3 panels (letters, no model names) | discarded arc, model identities | Anonymity documented (decisions 2026-08-31 pt 4). Discarded-arc exclusion not documented. |
| arc_hints | commission, final arc (+Challenges taken, tags stripped), source rule (master 'arc'), char details | critique, age, rules, landmarks, budgets, panel output | Hints design documented (2026-09-01) but no statement of what it is deliberately *not* shown. |

**Stale or wrong docs:**
1. `scripts/admin/sibling-registry.json` set `arc-generator-vs-critic`, reason field: says arc-create and arc-retell "each carry their OWN hand-maintained near-duplicate copy of the same fault-shape list". False since 2026-09-19 (`arcCritiqueSpec` constant, promptBuilders.js:8536). The set also omits **arc-hints.txt** as a critic, although its CHANGE lines steer the planner.
2. Same registry, `character-source-claim`: omits **arc-panel.txt**, which reads the same saved profiles.
3. `docs/decisions.md` ~line 49526: says "`arc-panel.txt` and `arc-hints.txt` head the block with a bare `# CHARACTER DETAILS` and make no source claim". Stale for arc-hints, which now fills `{CHARACTER_SOURCE_RULE}` (master 'arc', arc-hints.txt:11).
4. `docs/prompt-inventory.md:35-37`: arc-panel/arc-retell/arc-hints rows do not mention withheld inputs, the SENSE lens (HEAD), or that the hints prompt is not persisted.
5. The critique's "eight-year-old listener" rests on a pre-age-mode decision (decisions.md:29832/:30072). No entry reconciles it with AGE_MODE.

## E. What changed since b03c64b0 (HEAD 1435e0d0c)
- `arc-panel.txt`: new **SENSE** lens (a11662c21 → 725a4cd45), and the same clause added to the shared fault list (promptBuilders.js:8565). This partly addresses the class behind panel B #2/#6 and C M8/M9 (the "why don't they just…" reasoning). It does **not** fix #6's generator gap (no TELLING_RULES line).
- `models.js`: arc_create effort **max**, arc_retell **medium** (e4d4fe113, staging trial). This run used Opus 5 at default (high). Not a prompt fix.
- **Findings #1-#14: none fixed at HEAD.**

## F. Things working as intended (for balance)
- The commission preamble's "promise of drama, not a law" handled "sonst stirbt das Wesen" well: all arcs carried it as "never wakes up / goes cool and quiet" with no death on the page.
- CHARACTER_SOURCE_RULE held: no stage treated the four boys as friends.
- The cross-vendor panel earned its cost. It surfaced 10 / 8 / 13 missed issues with little overlap with the creator's critique, and the retell resolved almost all of them (final critique all MINOR).
- All 3 hints were valid issues.

## Not-a-reversal / reversal flags
- #12 changes the 2026-09-06 panel-restraint decision: **owner + reversal protocol needed**.
- #3 touches STORY SHAPE "at most two carry a book" (not in SETTLED.md, but an owner-level shape rule): **ask**.
- None of the findings conflict with SETTLED.md lines (it has no arc-machine entries besides prompt genericity) or with memory notes project_arc_effort_opus55 (effort) or feedback_prompt_writing (all proposed rewordings are terse, no banners).
