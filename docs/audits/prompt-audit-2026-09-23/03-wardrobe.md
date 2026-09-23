# 03 — STORY BIBLE + WARDROBE: judge findings

## Status 2026-09-23

Checked against staging `31fd7db0c` (after the evening fix round). FIXED = the commit that fixes it; OPEN = no fix yet, no ruling needed to start; OWNER CALL = touches a decision, a SETTLED line or has options the owner picks. Stale-doc and registry items listed at the end of each file were corrected in `a25ecb865` unless listed below.

- FIXED (part of F1): a same-garment same-colour restatement re-renders no avatar — `ee8890278`; joiner and declared slot — `6a2b0e121`.
- FIXED F1 direction (owner ruling 2026-09-23: the contract owns garment wording): `reconcile` deleted; a linked same garment `adopt`s the contract clause, the contract is untouched, no re-render; the AD's clothing list carries each version's outfit — `8dbe8d28b`. Replay on this run: 3 adopt, 0 re-renders.
- FIXED F2 (prompt side): review prompt 12,708 → 11,627 chars (wardrobe brief + cast, no binding paragraph / strengths / flaws) — `8dbe8d28b`. Reasoning effort: Lab `noReasoning` knob added; measurement in decisions.md.
- FIXED F3 (check 9 scoped to listed characters), F4 (base layers in bible rule + check 11), F5 (bible gets the arc; new check 12 plot garments), F6 (owner: no saved clothing; dead sentence deleted), F7 (colour words alone, both sides), F8, F9; `wardrobeBibleReport`, bible prompt + raw reply and review raw reply stored — `8dbe8d28b`.
- OWNER DECIDED 2026-09-23: the clothing plan wins over the Art Director's wording; the AD only selects outfit versions (with / without coat etc., each its own avatar). The bible is deliberately not given the stored clothing (clothing is per story).
- OWNER CALL: a `conflict` (a DIFFERENT garment in a filled slot) still rewrites the contract and re-renders; under the ruling it either becomes an error or a new wardrobe version (who creates versions mid-pipeline). Also the cover dedupe's slot-conflict branch (same question). J1 (reviewer blind to appearance / art style), J3 (STYLE_WARDROBE VB line), J4, J5 open.
---

Run: staging `job_1790100385959_1nitlympp` ("Das Ei im Laub", 18 pp, de-ch, 4 boys aged 3-5, watercolor), built at `b03c64b0`.
Stages: `beats_story_bible` (claude-sonnet-4-6, 8.1 s) → `beats_clothing_review` (deepseek-v4-pro, **185.9 s**, 0 rewrites) → avatar kickoff → Art Director → `applyWardrobeBibleCorrections` (clothingCheck.js) → **final contract**.

## How the prompts were obtained

- **Bible prompt: rebuilt, not guessed.** `buildStoryBibleFromBeatsPrompt` was run locally over the stored `input_data.json`, the staging DB's `stories.data.characters` (read-only) and the plan lines. The same script rebuilt the **review** prompt **byte-identical** to the stored `clothingReviewReport.prompt` (12,708 = 12,708 chars). So the bible rebuild (15,423 chars) uses the same verified inputs. Files: `scratchpad/lastrun/wardrobe-judge/beats_story_bible.PROMPT.rebuilt.txt`, `rebuild.js`, `story.json`.
- **`03-wardrobe/01-beats_story_bible.RESPONSE.clothing_section.txt` is NOT what the bible model replied.** It is the section after a post-review rewrite (F1). `changed=[]`, so the review's `# CURRENT WARDROBE` block is the only faithful copy of the bible's output. The two differ on Levin ("…and a forest green zip-up fleece jacket" → "forest green long-sleeve zip-up fleece jacket with a high collar") and on Kiaan ("and a rust-brown quilted gilet — a sleeveless front-zip body warmer…" → "rust-brown sleeveless front-zip body warmer with diamond quilting…").
- **Already fixed since `b03c64b0`?** No. `git diff b03c64b0 HEAD` changes nothing in `story-bible-from-beats.txt`, `clothing-review.txt`, `clothingCheck.js` or the two builders. The promptBuilders diff covers only OTS/image-prompt work, and the beatsPipeline diff covers only arc effort. **Every finding below is still live on HEAD.**

---

## CONFIRMED BY THIS RUN (ranked by severity)

### F1 [HIGH] The reviewed contract was overwritten after review by the Art Director's paraphrase, and two avatars were re-rendered for it
- Evidence: generationLog `beats_wardrobe_bible_conflict` at 18:39:37Z: `Levin/outer layer "and a forest green zip-up fleece jacket" vs ART006 "fleece jacket"; Kiaan/outer layer "and a rust-brown quilted gilet — …" vs ART004 "quilted gilet"`, both `corrected:true`. The garment is the same in each case. The AD wrote a `wornAs` entry (`04-art-director/02…visual_bible_section.txt` ART004/ART006) with new wording ("diamond quilting", "long-sleeve … with a high collar"). `clothingCheck.js:655-662` (`kind='reconcile'`: a declared item "owns its words") then copied the AD's words into the contract.
- Consequences, all visible in the run:
  - (a) The final contract (`04-clothingRequirements.final.json`) is unreviewed text. The reviewer never saw "diamond quilting" or "high collar".
  - (b) `onWardrobeCorrected` re-rendered Levin and Kiaan: `06-avatars/4-Levin.*` and `5-Kiaan.*` are full second pass1 + pass2 runs, and Kiaan's pass2 needed 2 attempts. That is about 7 extra Grok renders plus judge calls, and the avatars restart about 2 min after the AD.
  - (c) The spliced clause lost its joiner and garment noun. Kiaan now reads "…dark brown lace-up boots, rust-brown sleeveless front-zip body warmer…" with no "and" and no "gilet", while the briefs and the VB label still say "quilted gilet".
- The direction contradicts the documented design:
  - `story-bible-from-beats.txt:38`: "The Visual Bible copies those words for its own entry of the same object."
  - `scene-expansion-all.txt:146`: "that character's outfit above describes the same item in that slot, in the same words."
  - decisions.md 2026-09-15 "plot-critical worn object": the wardrobe authors the words and the VB copies them.
  - The code does the reverse: the AD's paraphrase wins.
- The 2026-09-15 "a wardrobe correction re-renders its avatar" entry justifies re-rendering as serving "a rare conflict". Here there was no conflict, only a paraphrase. In the last 40 staging stories, 3 logged `beats_wardrobe_bible_conflict`, and this run's 2 were both the paraphrase kind.
- The check is also inconsistent. Max's hoodie ART005 has `wornAs: Max.outer layer` and different words ("long-sleeve … thick hood"), but it was not reconciled because "sweatshirt" does not derive to the outer-layer slot. So the "identical words" invariant is only partial anyway.
- Suggestion: for `kind==='reconcile'` (same garment, declared `wornAs`), rewrite the **VB entry's description to the contract's words**, not the other way round. Then no avatar re-render is needed and the reviewed text stands. Keep "VB wins" only for a real different-garment conflict.
- **Flag as a partial reversal** of decisions.md 2026-09-15 "The Visual Bible outranks the wardrobe contract" (the reconcile half, commit `accd6b197`). It needs the protocol: owner sign-off plus evidence (≥3 stories). The docs already disagree with each other, so the owner needs to pick one direction either way.
- The generator side of this bug is also the AD's (it did not copy the words, which is judge 04's domain).

### F2 [HIGH] The review is 186 s on the critical path in front of the avatars, and returned nothing
- This run: 185.9 s for `changed: []` (the bible itself took 8.1 s). Over the last 40 staging stories (DB, read-only): median **123 s**, p90 **389 s**, max 475 s. 30/40 rewrote ≥1 outfit, so the stage does earn its keep.
- The owner has already ruled "Avatar kickoff stays serial behind the wardrobe review" (tasks/BACKLOG.md:644, answered 2026-09-21). **Do not re-raise the move-off-critical-path option without new evidence.** The p90 of 389 s is that evidence if the owner wants it.
- Levers that leave the ruling intact:
  - cut the prompt (B-items below, about 4 k of 12.7 k chars is not wardrobe data);
  - cap reasoning effort for this call (DeepSeek is a reasoning model, and the decisions 2026-09-18 pricing entry notes output tokens far exceed the visible answer).
- The model is set by env (`CLOTHING_REVIEW_MODEL`, models.js:452), which conflicts with CLAUDE.md "behaviour is code, only secrets are env vars". That is a judgement, outside this stage's prompt.

### F3 [MEDIUM] Check 9 made the reviewer dress the dragon, the dog and the hatchling; the output was silently discarded
- Analysis item 9: "Turi, Nia, and Flämmli … have no wardrobe category covering their animal/dragon appearances. Added below." Items 3 and 6 then reason about "the added creature entries".
- Log `beats_clothing_review_stray`: "Turi/costumed, Nia/costumed, Flämmli/costumed … ignored".
- The same stray warning appears in **6 of the last 40** staging stories.
- Cause: `clothing-review.txt:33` defines coverage as "any character a page … transforms (a tail, wings, an animal form…)". The plan names non-cast figures, and nothing says that only the listed `Characters:` wear a wardrobe. The reviewer spends reasoning tokens (F2), and its colour and completeness answers were partly about invented entries.
- Improve (generic): "Only the characters listed under `Characters:` have a wardrobe. Animals, creatures and other figures in the plan are not dressed here."
- Diagnostics gap: the report stores `analysis` + `changed`, not the raw `---CLOTHING---` block, so a stray entry's text cannot be inspected (only its name reaches the log).

### F4 [MEDIUM] Stripping outer layers left three boys in the same recoloured base outfit; neither prompt looks at the base layer
- The bible gave all four the same base: "long-sleeve shirt + trousers + shoes", recoloured red/yellow/white/blue. The garment-type variety sits only in the outer layer.
- The story removes outer layers: Max's hoodie is off from p9, Kiaan's gilet from p11/12, Levin's fleece from p16.
- Final brief p18 (`10-final_briefs`): Levin "red long-sleeve shirt, mid-blue jeans, dark grey sneakers"; Max "white long-sleeve shirt, dark navy jogger trousers, white sneakers"; Kiaan "blue long-sleeve shirt, grey straight-leg chino trousers, dark brown lace-up boots". That is exactly the "same set of garments recoloured" that `story-bible-from-beats.txt:50` and review check 11 forbid.
- Both rules judge the whole outfit, and the "largest garment" colour rule (bible :47, check 3) likewise assumes the outer layer stays on.
- Improve (generic, both sides, per the generator-critic rule): "When the page plan has a character take off an outer layer, the garments left underneath still differ from the others' in type, not only colour."

### F5 [MEDIUM] The plot's "jacket" is not in the wardrobe it belongs to
- Plan p9: "Max holds **his jacket** up against the wind". p11: "Turi snatches the **bundled jacket**". The arc (rawOutline line 19) says "lift the egg in **Kiaan's jacket**", and p16 has "three jackets over the top".
- The bible gave Max a purple **hooded sweatshirt**, not a jacket, and Kiaan a **sleeveless gilet**. Yet `story-bible-from-beats.txt:38` says "A worn object the story turns on is described IN FULL in the outfit that wears it."
- Downstream, the AD improvised: p9 uses Max's sweatshirt, and p11 uses Kiaan's gilet (as the arc wants). The jacket held up by Max on p9 and the one that wraps the egg on p11 are different garments.
- Two gaps:
  - (a) Missing input: the bible sees only the plan lines, never the arc sentences that name whose garment it is ("Kiaan's jacket"), so it cannot assign ownership the plan leaves implicit.
  - (b) The reviewer has **no check** for bible rule :38, a generator-critic gap. Proposed check: "name any garment the plan uses as an object (held, wrapped, spread, snatched) that no outfit contains, or that the outfit names as a different garment type."

### F6 [LOW-MED] The bible prompt says to "start from the character's stored clothing above", but no stored clothing is in the prompt
- `story-bible-from-beats.txt:40` says this. The rebuilt `# CHARACTER APPEARANCE` has no `Wearing:` line for any of the four.
- `buildCharacterPromptBlock(…, {includeClothing:true})` → `extractCharacterVisualProfile` reads `char.clothing.current` or a string `char.clothing`. These characters store `structuredClothing` and `avatars.clothing` (e.g. Levin: "yellow long-sleeve sweatshirt with a dinosaur graphic, dark blue jeans, black and white sneakers"), so `includeClothing:true` yields nothing.
- Per memory `feedback_clothing_is_per_story`, the per-story wardrobe legitimately differs from the saved one, so there are two valid fixes: feed the stored clothing, or delete the sentence. That is the owner's call.

### F7 [LOW] The reviewer passed off-list colour words; the bible broke its own "plain colour words only" rule
- Bible `:48` and review check 3 (`clothing-review.txt:27`) both list the 10 allowed words. The contract uses forest green, olive green, navy blue, mid-blue, rust-brown, dark grey and dark brown.
- The analysis says "only allowed colour words are used". Either modifiers are meant to be allowed (then say so) or this is a miss on both sides.
- Practical risk (judgement): Kiaan's "rust-brown" gilet against Turi the "rust-red" dragon on p11, where Turi is holding it. Check 3 only compares cast members, never cast against recurring creatures.

### F8 [LOW] Wrong count in the output format
- `clothing-review.txt:48` says "<your answers to checks 1-10>", but there are 11 checks. The reviewer answered 11 anyway.

### F9 [LOW] Stale cover rule in the bible prompt
- `story-bible-from-beats.txt:39` ("If any character is costumed, every cover uses the costumed variant") is a cover-hint instruction.
- The same template (line 3) says cover hints are written later by the AD, so the rule has no consumer here. It belongs in scene-expansion-all.txt, if it is not already there.

---

## JUDGEMENT WITHOUT EVIDENCE IN THIS RUN

- **J1: the reviewer cannot see what several checks need.**
  - It gets no `CHARACTER APPEARANCE`, so check 5's "glasses are identity … keeps them" is only usable when the outfit happens to list glasses. The bible is not told to list glasses in the outfit either, so this is a generator-critic gap.
  - It gets no hair colour, so it cannot judge garment-vs-hair clashes.
  - It gets no `ART_STYLE`: the bible got the style because of decisions.md "Illustration style: {ART_STYLE}" (style-blind 3D-render drift), but the critic cannot check for it.
  - Is this documented? The builder comment (`promptBuilders.js:9294-9297`) documents only why the plan is shown. The omissions are not recorded in decisions.md.
- **J2: bible rules with no reviewer check.** Pairs to add to the sibling registry:
  - :38 plot-worn object (F5);
  - costumed-when-theme-implies / role-dressed stays standard (:36-37);
  - "Clothing only — no pets, carried objects or bag contents";
  - structural garment parts, which check 2 only partly covers.
- **J3: `STYLE_WARDROBE` in world styles carries a line about "their Visual Bible entry"** (`buildStyleWardrobeBlock`, `promptBuilders.js:1657`). Neither wardrobe stage writes the VB any more, so for steampunk/cyber that line has no consumer in either prompt. Not triggered here (watercolor).
- **J4:** the "largest garment" in check 3 is undefined for layered outfits (a sleeveless gilet over a long-sleeve shirt).
- **J5:** neither prompt has a season/weather rule beyond `Season:` in the brief. Outfits were season-appropriate here.

## BLOAT (data vs instructions)

| Prompt | Block | Chars | Verdict |
|---|---|---|---|
| bible + review | `THE COMMISSION` binding-rules paragraph (not the idea itself) | ~650 each | Instruction for plot stages; irrelevant to wardrobe |
| bible + review | Strengths/Flaws lines | 1,187 each | Data; irrelevant to clothing (keep Special details, age, gender) |
| bible | `Face:` + `Age cues:` lines | 1,142 | Data; face geometry irrelevant; age cues marginal (Looks bucket suffices) |
| bible | Reading level + story language | ~150 | Irrelevant |
| bible | Cover rule :39 | ~90 | Stale (F9) |
| bible output | 12 boilerplate `{used:false}` entries | output side | Could omit unused variants |
| review | Full plan lines (3,982) | — | Needed (check 9 / F5); only cast + instant are used |

About 3 k chars (bible) and about 1.8 k chars (review) are removable without losing a wardrobe input. That matters mostly for F2.

## BLIND / WITHHOLDING and DOC GAPS

- Reviewer: not shown appearance, art style, stored clothing or the arc (J1, F5). None of this is recorded as a deliberate choice.
- Post-review mutation (F1): documented as "VB wins" (2026-09-15) and contradicted by "VB copies the wardrobe's words" (2026-09-15, same day, and `scene-expansion-all.txt:146`). **The two decisions conflict.**
- `wardrobeBibleReport` is built (`beatsPipeline.js:2346-2383`) but never returned or persisted: `stories.data` has no such key, and only the log line survives.
- `sibling-registry.json` has no `generator-vs-critic` set for `story-bible-from-beats.txt` ↔ `clothing-review.txt`, and none for the wornAs "same words" contract across the three sites plus the `clothingCheck` reconcile direction.
- `docs/prompt-inventory.md:54` names the clothing-review builder as `storyHelpers.js` (a re-export). It lives in `promptBuilders.js:9274`. Minor staleness.
- `docs/SETTLED.md`: the only clothing line (:76, "canonical source is clothingRequirements") is untouched by any suggestion here. The only recommended reversal is the F1 reconcile direction (flagged above).
- Harness note for the caller: the manifest label for `01-…clothing_section.txt` should say "post-review, post-VB-reconcile transcript", not the bible response.
