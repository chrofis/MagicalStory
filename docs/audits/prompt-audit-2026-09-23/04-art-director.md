# 04 — Art Director / scene expansion + Visual Bible + scene review

## Status 2026-09-23

- OWNER RULINGS IMPLEMENTED (late 2026-09-23): A3 shared grip allowed when it is the page's only action (SHARED_GRIP_RULE, one reading for both counters); A9 height decides, no age-bucket size comparisons, no photo-read height estimate. The LOC-as-grip bug and 6d/8l in the iterate templates are FIXED too (see tasks/bugs.json).

Checked against staging `31fd7db0c` (after the evening fix round). FIXED = the commit that fixes it; OPEN = no fix yet, no ruling needed to start; OWNER CALL = touches a decision, a SETTLED line or has options the owner picks. Stale-doc and registry items listed at the end of each file were corrected in `a25ecb865` unless listed below.

- FIXED: A1 review-deleted `off` row reverting to worn, and the post-review clothing re-check gated on pre-review findings — `ee8890278` (declared rows carried forward per id at both adopt points; the re-check runs on every reviewed run). A2 the element budget / page table counting garments the picker never packs — `ee8890278` (`wornItems.carriedByReference`, one predicate; a `wornItems` row is page presence). A12's p17 iterate cast — `32dce4da9`.
- OWNER DECIDED 2026-09-23: A8 follows 03 F1 — the clothing plan wins over the AD's wording, the AD only selects outfit versions. Blind spots: the AD is not given the art style (added in the image prompt next) and the scene review is not given the page text (images come before text; the review judges drawability).
- OWNER CALL: A3 shared-hands rule (AD lines 587 vs 591 vs the code guard; the documented 🟡 conflict — this run is the evidence), A9 HEIGHT ORDER vs age cues.
- FIXED in `4994fe530` (AD / scene-review agent, second evening round):
  - A4 — check 4 now stages a same-goal group where the plan line puts it, together or scattered, and never regroups figures the plan line places apart.
  - A5 — NOT A DEFECT, a measurement artefact. The "AD emitted" column was read from `stories.data.outline`, which is the transcript AFTER the post-review usage rebuild (`applyBriefUsage`, beatsPipeline ~3354) wrote the briefs' citations back into `pages`. `beatsReviewReport.vbBriefUsage` holds the AD's own table: ART002 `[3,4,6,7,8,11]`, ART004 `[4,9,11,12,16,18]` — exactly what the checker saw. The AD's table disagreed with its own citations, and `vb_cite_offpage` was right. Root cause of the confusion: the raw AD reply was never stored — fixed, `sceneExpansionReport.replies[]` (item C/storage).
  - A6 — eyes-open (6d) and creature face (8l) are now ONE constant each (`EYES_OPEN_RULE`, `CREATURE_FACE_RULE`) in both AD templates and scene-review check 6. `landmarkView` and shot-vs-plate are CODE checks sent to the review: `landmark_view_missing` (a page citing a real landmark with no `landmarkView`) and `shot_off_plate` (an eye-level page on an angled vantage — nothing derives that plate; the AD is told the same line from `shotVocabulary.VANTAGE_SHOT_RULE`, and the dead `wide-low` vantage shot is gone). Replayed over the stored briefs: 17/17 landmark pages and p13, p14, p16, p17, p18 flagged. VB size rules: the "a size comparison is fine" clause and the vehicle "dimensions in metres" line contradicted scaleClass as the one size source (decisions 2026-09-15) and are removed.
  - A7 — a vantage is split when its pages differ in time of day or weather; the plate carries the light. The "do not split for time of day" sentence is gone.
  - A10 — 5f and 12j removed from scene-expansion-all (page text, owner); the art-style line removed (owner); an AD-specific landmark block (no "woven into the story's action", "into your story", "can be creative", no example with a `description` key); headings now name REAL LANDMARKS / AVAILABLE CLOTHING PER CHARACTER; the cover cast lines are built in code (no "and None"); the optional-`depth` line removed from both AD templates; 11b and "Camera at thresholds" merged into one rule (profile or over the shoulder, never straight behind).
  - A11 — scene-review 9f now says every page cites the dotted state id, as the AD's field rule does.
  - C8 (partial) — scaleClass spec, `generic` and `label` each stated once; second creature-tone block, duplicate lettering / two-sided-prop / landmark-accuracy / thresholds lines removed. Replay: AD prompt 113,770 → 103,772 chars (−9.1%).
  - C9 — check 0 is sent only with its clothing section; DECLARED TEXT is one line when nothing declares text. BRIEF FAULTS re-measured on the stored briefs: 9,786 (as sent) → 4,274 after `ee8890278` (garment noise gone); +5.3k now from the two new real finding types.
- OWNER CALL (proposals): A3 shared-hands (unchanged, still pending). A8 → the wardrobe agent (owner: the clothing plan wins). A9 — the data does NOT list a 3-year-old above a 5-year-old: heights are the user's (Max 98, Julian 102, Kiaan 102, Levin 110 cm); the clash is Julian's photo-read Looks bucket `toddler` ("clearly smaller than a preschooler") against his entered height above preschooler Max. Options: drop the comparative clauses from the age-cue markers (HEIGHT ORDER carries the measured order), or order HEIGHT ORDER by bucket first. Landmark list trimming (6.2k of 20 unused landmarks): the AD is the stage that decides which places are landmarks and the ≥2 guideline is checked on its bible, so filtering by name-match on the arc would hide candidates — propose only after a Lab A/B.
- OPEN: rule renumbering (cosmetic, cross-referenced ids pinned by a test); the `interaction_object_shared_hands` guard counting a LOC id as a one-grip object (p9 `loc002.3`, p12 `loc002.4`) — separate from the A3 owner call; 6d/8l are not in the two iterate templates (art-director-vs-iterate).

---

Run: staging `job_1790100385959_1nitlympp` ("Das Ei im Laub", 18 p, de-ch, cast 3-5, watercolor), built at `b03c64b0`.
Stages judged as one system:
- **Creation:** `beats_scene_expansion` (gemini-3.1-pro-preview), prompt 112,251 chars → VB + cover hints + 18 briefs.
- **Code checks:** `sceneBriefCheck` / `clothingCheck` / `vbElementBudget` produced 29 findings, handed to the review.
- **Judge and recreation:** `beats_scene_review` (deepseek-v4-pro), prompt 84,419 chars. It rewrote 14 of 18 pages, and the final briefs are those rewrites verbatim.

Status of the causes: `prompts/scene-review.txt`, `sceneBriefCheck.js`, `vbElementBudget.js`, `clothingCheck.js`, `wornItems.js` and the clothing re-check in `beatsPipeline.js` are all unchanged since `b03c64b0` (verified with `git diff --stat`). So everything below is still open unless it is marked FIXED.

---

## A. Ranked findings

### CONFIRMED by this run (stored evidence)

**A1 — CRITICAL. A review-deleted garment row reverts silently to "worn". The post-review clothing re-check never ran. Cost p12 (final score 10).**
- **The chain, step by step:**
  1. The AD declared Max's sweatshirt ART005 `off` on p9, p11, p12 and p18.
  2. The code budget fault told the reviewer to "drop purple hooded sweatshirt (ART005)" on p11 and p12.
  3. The reviewer deleted the ART005 `wornItems` row on p11 and p12, and every row on p18 (`07-…rewritten_briefs.json`). The prose still dresses Max in "white long-sleeve shirt".
  4. With no row, the state defaults to worn. The p12 image prompt then says: *"Max IS wearing this on this page: purple hooded sweatshirt … Draw it on Max even if the attached reference shows Max without it."* (`08-page-images/page12/10a…PROMPT.txt:22`), while the prose on line 25 says the white shirt.
  5. Result: `duplicate_character` CRITICAL "Max appears twice", with both figures in purple hoodies. Final score 10.
- **Why nothing caught it:** the post-review clothing re-check and the worn-state round only run `if (clothingByPage && clothingByPage.size > 0)` (`server/lib/beatsPipeline.js:2837`), i.e. only when the PRE-review check found something. Here it found nothing, so reviewer-introduced `removal_unstated` was never detected. This contradicts decisions.md 2026-09-19 ("An UNDECLARED garment state is REPORTED, not defaulted").
- **Not visible in my sample:** p18 has the same defect (`wornItems: []`, prose shirts-only). p11 loses ART005 too.

**A2 — HIGH. The element budget and the page-table check count worn garments that the reference selection never packs. The resulting fake overflow drove destructive rewrites.**
- `rankPageElements` (`server/lib/vbElementBudget.js:136`) counts every artifact, including `wornAs` garments on their owner. `getElementReferenceImagesForPage` drops exactly those (`server/lib/visualBible.js:3647`, `referenceCarriesItem`).
- The header claim "the same set `getElementReferenceImagesForPage` selects" is therefore false for garments.
- **Effect:** all 4 `vb_element_overflow` findings (p9, p11, p12, p16) are garment-driven, and so are 11/11 `vb_page_uncited`. That is about 6.5k of the 9.8k BRIEF FAULTS block. The pipeline itself marks these overflows `briefFixable: false` (`09-…other_records.json`) and sends them anyway.
- **Damage done by the "fixes":**
  - p9: Levin's fleece was deleted from the prose (he is in the fleece on p7, p10 and p11), with no row declaring it off. That is a continuity break the reviewer introduced.
  - p12: the ART005 row was dropped (see A1).
  - p1, p2, p4, p7, p10, p15: ART006 was added to `objects[]` just to satisfy the table.
- **Rule conflict:** AD rule "`pages` is earned … a worn satchel … earns only the pages that make something of it" (prompt line 288, template `scene-expansion-all.txt:155`) contradicts the code's "table == citations" check for garments, which live in `wornItems`, not `objects[]`.

**A3 — HIGH. The generator is told to write the exact shape the code guard faults: one fused `"A + B"` interaction row. The fixes then broke the plan line.**
- **Inside the AD prompt:**
  - line 587: "One object takes one pair of hands".
  - line 591 **Shared objects**: "several characters … carry the same basket … emit ONE entry: join the names with ` + `" (template :458 vs :462).
  - The code (`sceneBriefCheck.js:743`) flags every fused row with `hands:true`.
- **In this run:**
  - The plan for p4 says "all four boys strain together to lift the egg … two on each side".
  - The reviewer, obeying the fault, made Julian "brace Levin's arm" and made Max and Kiaan merely "reach … ready to take the other side". That breaks its own rule "a rewrite never … adds an action the plan line does not name".
  - p4 still ended with 3 actions and shared hands, both listed in `briefUnfixed`.
  - The same pattern recurs on p9 (3 boys on the egg) and p16 (`"Kiaan + Nia"`).
- **New false-positive class (not the documented one):** the guard treats a LOCATION as a one-grip object. p9 flagged "2 characters have hands on loc002.3", p12 "6 characters … on loc002.4". Banking leaves on the ground is not a hand-off.
- **Documentation status:** the crew-push conflict is documented as "Known conflict, deliberately left in" (decisions.md:24758, status 🟡 "Not yet run inside a generation"). This run is that evidence, and it went against the plan.

**A4 — HIGH. The reviewer's single-moment check contradicts the plan line the reviewer is told is the authority (p12).**
- `scene-review.txt:52` check 4: "a searching group stands together scanning, never split across separate spots with roles".
- The p12 plan says: "all of them scattered … each searching a different pile".
- **The reviewer's hybrid:** one fused row, "Max + Levin + Kiaan + Julian + ANI001 + ANI002 … dig and rake", on a LOC. The prose still says "each dig … a different pile" and "Julian stands nearby wiping his eyes".
- The image prompt's EXACT POSES therefore gives Julian a digging pose (`page12/10a:41`) against prose that has him standing and crying.
- **Eval of the result:** Max twice, Kiaan (not Julian) "standing, crying", "children appear to be playing".
- **Upstream:** the aerial page was also planner-mandated. That was FIXED upstream by `147ce6a96` (aerial no longer owed).

**A5 — MEDIUM. The page table the checks and the reviewer saw is neither the one the AD wrote nor the final one.**

| element | AD emitted | checker/reviewer saw | final VB |
|---|---|---|---|
| ART002 egg | [3,4,6,7,8,9,11,16,17] | [3,4,6,7,8,11] | AD's |
| ART004 gilet | [4,5,9,11,12] | [4,9,11,12,16,18] | AD's |

- **Result:** false `vb_cite_offpage` (egg p9 and p16; gilet p5). The reviewer then "corrected" the egg states back to what the AD had already written (`bibleCorrections.applied`).
- Cause not traced (read-only budget). `vbEntityCoversPage` (`iterateBeat.js:148`) unions `pages`, `appearsInPages` and state pages, so some pre-review mutation removed pages.

**A6 — MEDIUM. The critic has no check for AD rules that failed in this run (generator↔critic gap, registry set `scene-brief-generator-vs-critic`).**
- **6d eyes open:** p12 Julian "eyes squeezed shut" shipped. p4 "eyes squeezed narrow".
- **8l a creature's face written:** Turi has no brow/eyes/mouth on p9 ("stands watching") or p11. Flämmli has no face terms on p17. The rule text says "a face left unwritten is drawn from the action alone".
- **`landmarkView`:** emitted on 0 of 17 landmark pages. Field rules line 557 says it "selects the reference photo".
- **Shot vs vantage plate:** p13 is a `close-up` on the `aerial` vantage LOC002.4. Line 551 requires "a framing the plate of the vantage this page cites can hold". A downstream derive may cover this (`5beac7c16`), but that was not verified.
- **VB description rules, no critic:**
  - ART003 says "plate-sized … resembling a smooth shield". That breaks both line 274 ("No entry gives a size of its own") and line 285 ("never compare its SHAPE to another object").
  - ART002 says "football-sized".

**A7 — MEDIUM. One vantage plate is shared across a time-of-day change: the prompt contradicts itself.**
- Line 310: "Do not split for lighting, weather, time of day". Line 317: the plate carries "a lighting direction that matches the story's time and weather".
- LOC002.1 is painted "crisp autumn sky" (afternoon) and serves p2 (afternoon) and p18 ("deep evening light … the city at night").
- p18's own prose is also internally inconsistent (evening vs night).
- The effect on the p18 image is not verified (not in the sample).

**A8 — MEDIUM. The AD and the reviewer read different outfit contracts.**
- The reviewer's CHARACTER DETAILS carry garment wording the AD invented in the VB: Levin's fleece "with a high collar", Kiaan's gilet "with diamond quilting". This is the `wornAs` merge. The AD itself was given the plain outfit.
- These details were never in the avatar source text. That risks memory `feedback_description_must_match_avatar` (a description must match the avatar). Judgement; image impact not measured.

**A9 — MEDIUM. The HEIGHT ORDER input contradicts the age cues.**
- "Max (shortest) -> Julian (slightly taller) -> …" versus Julian "toddler … clearly smaller than a preschooler" and Max "preschooler".
- The AD copied it ("Max, the shortest preschooler of the group", p4). The same line reaches the image prompt (`page12/10a:7`).
- The source is upstream character data (`buildRelativeHeightDescription`), but the AD receives it unchallenged.

**A10 — LOW-MEDIUM. Dead or misaddressed instructions in the beats AD prompt (confirmed from the prompt as sent).**
- **Page text not shown:** rules 5f ("The page text is not a checklist") and 12j ("A prop the page text puts against a character") reference page text. The beats AD is never shown page text (it is written later), so 12j cannot be applied. About 0.9k.
- **Art style not shown:** line 297 says "Every description … must render in the named illustration style. A photorealistic style gets…". Line 56 says "you are not shown the art style". This is an internal contradiction.
- **Landmark block written for a story writer** (`promptBuilders.js:10178-10198`):
  - "build at least two of them in, woven into the story's action".
  - "incorporate it authentically into your story".
  - "Your 'name' can be creative".
  - an example with a `"description"` field that the `locations` schema does not have.
  - These contradict AD rule 1 ("never add to the plan line").
- **Heading mismatch:** line 308 says "Only a place listed in an AVAILABLE LANDMARKS section above", but the section is titled "REAL LANDMARKS". Line 81 says "AVAILABLE_AVATARS", but the section is "AVAILABLE CLOTHING PER CHARACTER".
- **Cover cast line:** "up to 5 characters from Levin, Julian, Max, Kiaan and None". `namedByMain` returns the literal `'None'` when there are no primary characters (`promptBuilders.js:2476`).
- **Rule clashes within the prompt:**
  - Line 559: "Only add `depth` when the character is in the background". Line 571: "`depth` … required for every character".
  - 11b: the camera outside, with a back view allowed. "Camera at thresholds" (line 622): "never straight behind the character".
- **Rule numbering is scrambled:** 12, 12b, 12e, 12f, 12c, 12g, 12h, 12j, 12k, 12d; also 8i and 8j/8k sit after 8c.

**A11 — LOW. `9f` (reviewer) contradicts AD field rules on state citation.**
- `scene-review.txt:76`: "A page before the first change cites the bare id".
- AD line 567: "An object WITH states is always cited dotted, the pages before its first change included".
- The AD followed its own rule (`ART002.1`). The reviewer did not fault it this time, but the two instructions disagree.

**A12 — LOW. The briefs import arc state that the plan lines dropped.**
- The plan omits arc beat 16 (egg back in the root hollow, three jackets over the nest). The AD nevertheless set Levin's fleece "spread over the nest" on p16, before any nest exists. It also hatched the egg at the wall on p17, contrary to the page text.
- The root cause is the page plan (judge 02). This AD-side symptom is recorded for completeness.
- The p17 CRITICAL `missing_character` "EXPECTED CAST of 4" was downstream: iterate cast by name scan, FIXED `1435e0d0c`.

### ALREADY FIXED since `b03c64b0`
- **p10 over-the-shoulder with contact** ("presses his open palm flat against Turi's flank", `back view, glancing over the shoulder`): FIXED by `50e150c21` / `be213ec9a` (`{OTS_NEAR_FIGURE}`, `OTS_NO_CONTACT_RULE` in all four AD/iterate templates).
- **Aerial floor** that forced p12: FIXED by `147ce6a96`.
- **p17 iterate cast:** FIXED by `1435e0d0c` (downstream).
- **`emotion` enum** added to the field rules (`3d8f4871d`). This is new, and it slightly grows the prompt.

### JUDGEMENT without run evidence
- **J1:** At 112k the AD prompt carries about 97k of instruction for about 15k of data. There are many 5-10-sentence rules with justification clauses, e.g.:
  - rule 3: 10 sentences.
  - 10d: 7 sentences, including "The avatar reference wears the full outfit, so…".
  - 11: 8 sentences.
  - state rules at lines 280-281.

  These violate `feedback_prompt_writing` (at most 2 sentences, no reasons). 20 justification markers ("because/so that") are in the sent prompt. No run evidence isolates prompt length as the cause of any specific defect here.
- **J2:** Title-page hint omits Turi (ANI002) though the plot turns on him (line 350). Arguable, because the title names the egg, which is listed.
- **J3:** The fleece/gilet/sweatshirt got VB artifact entries only because the arc makes jackets plot props. That is correct in principle, but every tracked garment then generates rows, page claims and budget load on every page (A1/A2 are the price).

---

## B. Size tables

### AD prompt as sent (112,251 chars)
| section (prompt lines) | chars | kind | notes |
|---|---:|---|---|
| role (1-4) | 379 | instr | |
| per-page rules (5-74) | 31,509 | instr | 5f/12j dead (page text not shown), about 0.9k. Creature-tone paragraph (1,088) duplicated at 296. Two-sided prop (73) duplicated at 304. Lettering 12c/12g duplicated at 276/303/408. 11b duplicated at 622. |
| cross-page C1-C8 (75-89) | 3,041 | instr | |
| story arc + challenges (92-118) | 4,562 | data | |
| plan lines (119-173) | 3,925 | data | |
| character details + height + clothing (174-187) | 2,694 | data | HEIGHT ORDER wrong (A9) |
| real landmarks (188-258) | 8,704 | 6.9k data + 1.8k instr | 20 landmarks, 2 used (0.7k). Writer-oriented instructions and example (A10). |
| VB rules incl. plate rules (260-332) | 20,480 | instr | plate rules 5.7k. Creature tone again (1,088). Vehicle-only lines. |
| cover hints (333-355) | 2,469 | instr | "None" bug |
| output schema (364-453) | 14,057 | instr | `{SCALE_CLASS_SPEC}` 1,265 × 5 = 6.3k (5.1k redundant). `generic` spec 484 × 3. `label` 211 × 4. |
| page format, example, metadata example (456-537) | 4,838 | instr | |
| field rules (538-627) | 15,271 | instr | "Distance rule" twice (497/611). Landmark accuracy duplicates 331. `depth` contradiction. |

- **Mechanically redundant:** about 18k (16%): scaleClass ×4 5.1k, irrelevant landmark rows 6.2k, landmark writer text and example 1.2k, creature tone 1.1k, generic/label repeats 1.6k, two-sided prop / lettering / thresholds / distance / landmark-accuracy repeats about 2.8k.
- **Conditionally irrelevant to this story:** about 12k more, covering vessels, `aboard`, vehicles, documents, water/cellar/shaft, crowds, secondary characters, costumes. These can only be gated on INPUT signals (plan lines, landmark list). The VB is authored in the same call, so it cannot drive the gating.

### Scene-review prompt as sent (84,419 chars)
| section | chars | kind | notes |
|---|---:|---|---|
| header + target | 388 | instr | |
| commission | 1,770 | data | |
| character details | 2,351 | data | VB-merged wording ≠ AD's (A8) |
| page plan | 3,814 | data | |
| all briefs | 37,328 | data | necessary |
| VB stated objects / declared text / plates | 3,723 | data | 9 lines of "(none declared)" add nothing |
| BRIEF FAULTS | 9,786 | data | about 6.5k garment/page-table noise (A2/A5) |
| YOUR TASK (37 checks) | 22,918 | instr | 5a copies AD rule 3 verbatim (1.5k). 9g copies the VB lettering rule (1.4k). Check 0 (clothing_mechanical) is sent even when no section exists. |
| output format | 1,862 | instr | |

---

## C. Improvements (generic)
1. **Gate the post-review re-check on the review having run, not on pre-review findings.** Run `clothingCheck` on the rewritten briefs unconditionally (`beatsPipeline.js:2837`). A review-introduced `removal_unstated` then enters the existing worn-state round (fixes A1).
2. **Make the budget and page-table checks count what the selection packs.** Exclude `worn` + `referenceCarriesItem` garments from `rankPageElements` and from `checkBiblePageTable`. That is one shared predicate, so the counter and the packer cannot drift. Also treat `wornItems` rows as the garment's page presence (fixes A2).
3. **The shared-hands guard:**
   - never counts a LOC id or a location name as an object;
   - does not fault a fused row whose plan line names that many actors on one object.

   Resolve AD lines 587 vs 591 into one rule, either "one row per toucher" or "fused row", and make the guard read the same shape. This is the documented 🟡 conflict: bring the owner this run as the evidence and ask (fixes A3).
4. **Reword reviewer check 4:** the plan line's staging of a group (together or scattered) is binding, and the check only removes an action the plan line does not name (fixes A4).
5. **Add critic checks, or code counters, for eyes-closed words, the creature face on creature pages, `landmarkView` on landmark pages, and shot vs vantage-shot.** Each needs the generator side stated once and injected into both (fixes A6).
6. **Plates:**
   - either split a vantage when pages on it change time of day;
   - or state that plate light is neutral and the page carries time of day.

   Pick one and delete the other sentence (fixes A7).
7. **Show the reviewer the same outfit strings the AD got,** or show both the AD and the illustrator the merged one (fixes A8).
8. **Trim the prompt:**
   - state the scaleClass spec once and have the schema say "one band from the SCALE list";
   - drop the second creature-tone paragraph;
   - send only the landmarks the plan lines or arc name (plus their photos);
   - replace the writer-oriented landmark text with an AD version;
   - remove 5f/12j from the beats template or fill the page text;
   - fix the heading names and the "None" fill;
   - renumber the rules.

   Estimated saving about 18k chars with no rule removed.
9. **Reviewer prompt:** omit the DECLARED TEXT block when nothing is declared, and omit check 0 when no mechanical section exists.

---

## D. Blind / withholding
- **The AD is not shown:**
  - art style (stated at prompt line 56, contradicted at 297);
  - page text (not yet written, but referenced by 5f/12j);
  - the avatar images (only text).
  - Documented only inside the prompt.
- **The reviewer is not shown:**
  - the arc and page text;
  - the art style;
  - full VB entries (species, colouring, scaleClass, artifact descriptions — only state rows, text declarations and plates);
  - cover hints, the landmark photo list, HEIGHT ORDER, the child age band;
  - the AD rulebook. It gets its own 37 checks, several verbatim.
- **The reviewer IS shown a different page table (A5) and different outfit strings (A8) than the AD used.** Neither difference is documented.
- **No decisions.md entry states what the scene reviewer sees or is withheld.** The model pairing is documented (decisions "Art Director model = gemini-3.1-pro (2026-08-29)" plus the 2026-09-10 reviewer bake-off).

### Stale docs
- **`docs/SETTLED.md:62`:** says "**Three** Visual Bible elements per page", enforced by "`rankPageElements` / `truncateBriefToBudget`". Code is FOUR since 2026-09-11, and `vbElementBudget.js` header: "NOTHING IN CODE ENFORCES IT … all three code-side enforcers were removed". Changing the SETTLED line needs the protocol, but this is a factual refresh, not a reversal.
- **`server/lib/sceneBriefCheck.js:749`:** comment "never more than three packable" (stale, now 4).
- **`docs/prompt-inventory.md:50`:**
  - It lists `scene-review.txt` under `storyHelpers.js buildSceneReviewPrompt`; the builder is `promptBuilders.js:9550` (storyHelpers is the facade).
  - It describes the check scope as "(repetition, arc, continuity)", but the prompt has 37 tagged checks.
- **`vbElementBudget.js` header:** "the same set getElementReferenceImagesForPage selects" is false for worn garments (A2).

### Reversal check
- **Nothing proposed here reverses a SETTLED line.** C3 touches the decisions.md 2026-08-23 🟡 "known conflict", which is conditional, not settled. It needs owner sign-off (`AskUserQuestion`).
- **C2 respects decisions 2026-09-19 (no default):** it changes what is counted, not the default.
- **Memory:**
  - The p14 removal of Turi by the reviewer is consistent with `feedback_ad_trims_cast_by_design` and AD rule 3. It is not flagged.
  - Nothing proposes a scale referent in VB cells (`feedback_no_scale_referent_in_vb_cell`).
  - `feedback_position_relational_not_lr` (prefer relational positions) is still contradicted by the AD's own output checklist, prompt line 492 "left/right/center". The builder change for it was never made in this template. Noted, not re-litigated.
