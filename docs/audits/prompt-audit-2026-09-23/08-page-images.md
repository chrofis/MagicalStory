# Judge 08: page images, recreation and final checks

## Status 2026-09-23

Checked against staging `31fd7db0c` (after the evening fix round). FIXED = the commit that fixes it; OPEN = no fix yet, no ruling needed to start; OWNER CALL = touches a decision, a SETTLED line or has options the owner picks. Stale-doc and registry items listed at the end of each file were corrected in `a25ecb865` unless listed below.

- FIXED: S1 invented "missing" items and duplicate taking the repair slots — `2e36a6636` (evidence rules in both judges, `duplicate_character` capped when detector people ≤ roster, one second look at CRITICAL/MAJOR absence claims, a rule-2/2a drop never charged). S4 iterate cast from a name scan and dropped parent citations — `32dce4da9`. S6 judge text ordering the trait in char-fix — `319fa6054` (no judge text). S8 garment off by design charged as missing — `17bbd887a`. S3 (shrink part) — the commit "fix(shrink, covers): the cut is ranked…" (anchors never cut, ranked per-bullet cut, reach pinned on the SENT prompt; see the S3 status line).
- OPEN: S1 bbox coordinates in an inpaint instruction (BACKLOG line); S3 outfit-restatement dedupe (AD/wardrobe); S4 "shallow depth of field" and the rewrite's self-report; S5 char-fix reads retired `pose/action/holding/gaze` fields and loses the held prop; S7 entity-grid crop artefacts become findings; S9 plates: three cameras in one prompt, dangling light direction, pixel-only retry, derive never QC'd and carries no style; S10 plate QC has no style/camera check; S12 generator-side contradictions; S13 consolidator audit-only score section; S14; unstored eval prompts (improve 9).
- OWNER CALL: S2 version selection between near-identical renders (second sample, costs cents); S6 upstream (AD writes a stored eye colour the avatar may not show); S10 figures-allowed vs people-free plate QC; S11 per-page style gate parrots ART STYLE (style repair stays OFF); S1 cap ranking by verified × severity.

---

Run: staging `job_1790100385959_1nitlympp` ("Das Ei im Laub", dragon run 6), built at `b03c64b0`. Pages 12, 14 and 17, every version downloaded and viewed.
Pixels I looked at: `scene/p12/v0,v1`, `scene/p14/v0,v1`, `scene/p17/v0,v1`, `empty_scene/p12,p13,p14`, plate-QC v1 images (`aux/sceneImages-11…`, `-13…`), the p14 blend mask, and the Julian entity grids `entity-history/r0/grid-3,4` and `r1/grid-2,3`. Local copies are in `scratchpad/lastrun/imgs/`.
Shipped versions: p12 **v0** (score 10), p14 **v0** (83), p17 **v1** (45).

Status legend. **[C]** = confirmed by this run's pixels or stored data. **[J]** = judgement, no direct evidence. **[FIXED@HEAD]** = fixed in a commit after b03c64b0. **[IN-FLIGHT]** = fixed in the uncommitted working tree of another session: not at HEAD, not validated. **[BACKLOG]** = already listed in `tasks/BACKLOG.md` or `tasks/bugs.json`.

---

## Ranked findings

### S1. p12: the quality judge invented three defects, and the repair round was spent on them [C] (partly [BACKLOG])
- **Pixels (v0).** Exactly four boys: Julian (orange jacket, top), Max (purple hoodie, left), Levin (green, centre) and Kiaan (blue, right). Also the dragon, the dog, and the gilet in a heap by the wall. Kiaan is visibly wearing brown boots.
- **Quality eval v0 (`10b`)** reported:
  - "Max appears twice" as CRITICAL. Figure 1 is a "purple hoodie, back view" at x .29-.49 / y .38-.62. That spot is empty ground.
  - "Kiaan missing brown lace-up boots" (MAJOR). The boots are present.
  - "gilet missing" (MAJOR). The gilet is present.
- The detector saw 4 humans. Its `gdinoBox`/`bodyBox` values are y-first and label all four boys correctly.
- **Consolidator result:** it kept the invented duplicate and the invented boots, and dropped the only real defects to the cap ("capped at 3"). The real defects are from the semantic judge: Kiaan and Max stand crying instead of searching. See `20b-eval_consolidation.round0`.
- **The inpaint instruction was nonsense.** It told Grok to "remove the figure … that is not at bbox [0.363,0.058,0.712,0.27]", and Grok cannot read coordinates. v1 is pixel-near-identical to v0.
- **On the backlog already:** "duplicate_character CRITICAL routes a repair without checking the detector's figure count … bbox coordinates Grok cannot read" (BACKLOG, run 6 P12).
- **Not on the backlog:** the two hallucinated MAJOR "missing" items on the same page, which are 3 false findings out of 4 from this judge on this page. Also missing: the ranking that sends real, lower-severity semantic findings to the cap while false CRITICAL/MAJOR findings get the repair slots.
- Files: `prompts/image-evaluation.txt`; consolidator cap in `prompts/feedback-consolidator.txt` "Cap and severity sort".

### S2. p12: version selection was decided by judge noise, and the shipped page carries a false "unrepaired CRITICAL" [C]
- v0 and v1 are essentially the same image.
- **Quality:** v0 was SOFT_FAIL with a duplicate; v1 was PASS with no issues.
- **Semantic:** v0 had 3× MAJOR (score 40). v1 had 4× CRITICAL plus 1 MAJOR (score 0) for the same poses. It also re-described the same dog as "walking" where v0 said "raking paws".
- **Result:** v1 scored −15 and v0 scored 10, so v0 shipped. `unrepairedCritical: duplicate_character "Max appears twice"` is stored on a page with no duplicate. `repair_rounds…json` records the inpaint as "regressed −25", which is pure noise.
- This is the same instability as the documented 36.8-point run-to-run range (memory `eval-judge-audit-2026-09-19`). **Selection between near-identical versions cannot rest on one sample per judge.**

### S3. The shrinker breaks generator↔critic parity on the pages that need it most [C]
- **Status 2026-09-23: FIXED (shrink part).** NO MARKS and HANDS are never cut. Cuts go in rank order, with Composition cut one bullet at a time. The split-state rule is emitted only for elements with states. Reach is pinned on the SENT prompt. See decisions.md 2026-09-23, "The shrink ranks its cuts…". Replayed on p12: it now keeps REQUIRED CAST and both anchors and loses COUNTS, DEPTH and Composition. OPEN: the outfit-restatement dedupe (prose vs WORN ITEMS vs cards), which belongs to the Art Director and wardrobe stages. The p17 phantom cast blocks: iterate-repair-cast-from-name-scan, fixed in 32dce4da9.
- **What was dropped.** p12 was sent at 6,834 chars after `sectionAwareCut` removed COUNTS, DEPTH AND SIZE, HANDS, NO MARKS, REQUIRED CAST and Composition (`server/lib/images.js:839-853`). Pre-shrink it was ≈10,085: 6,834 + 1,176 + 522 + 645 + 233 + 351 + 324, measured from p14's copies of the same blocks.
- **The parity break.** `sibling-registry.json` set `page-image-generator-vs-critics` pins **D-24 ↔ NO_CHARACTER_MARKING** and **D-16b ↔ HANDS_HOLD_ONLY_NAMED** as parity anchors. Those are exactly cut blocks #3 and #4. `tests/unit/generator-critic-rule-reach.test.ts` pins reach in the BUILT prompt, not the SENT one. On any over-cap page the critics can deduct for rules the illustrator never received. The quality judge also judges `duplicate_character`/`missing_character` while REQUIRED CAST is gone.
- **Whole-block granularity overshoots.** After the 5 generic blocks were dropped, p12 was ~110 chars over the cap. The cut then removed all of Composition (1,176). The comment at `images.js:846-847` says Composition is "in practice never reached once the shot block carries one definition". **This run reached it.**
- **p17 v1 (iterate).** The phantom 4-boy HEIGHT ORDER / AGE / REFERENCE CARD blocks (~970 chars for absent characters) pushed out COUNTS, DEPTH AND SIZE and HANDS. The hatchling was then drawn at the adult dragon's size. The link is [J]; the drop is [C] from the diff of `10a`→`11a`.

### S4. p17: the iterate repair shipped a worse page, and three judges missed it [C] ([BACKLOG]/[IN-FLIGHT] for the cast part)
- **Pixels.**
  - v0 is good: a small orange hatchling standing in the broken grey egg, the red Turi beside it, and the spark leaving to the right.
  - v1 (shipped) has **no eggshell at all**. The hatchling is **rust-red and nearly Turi's size**, which reads as two copies of Turi.
- **How the rewrite got there.**
  - The rewrite dropped ANI002/ANI003 from `objects[]`. REQUIRED OBJECTS lost both dragons' lines and Turi's reference image; only the egg's reference remained.
  - It name-scanned four absent boys into the cast (HEIGHT ORDER, AGE, card colours).
  - It added "shallow depth of field" twice, contradicting ART STYLE "depth from atmospheric haze, not optical blur".
  - It switched the location to LOC002.1 while claiming "Retained all previously cited object ids".
  - Its `diagnosis` says "previous fix added Julian to frame". v0 has no Julian, so this is a hallucinated premise.
- **What the judges said about v1.**
  - Quality: PASS, Flämmli "bright orange scales". False.
  - Semantic: flagged the missing shell as MAJOR only, and "Flämmli (smaller red dragon)" without a finding.
  - Presence arithmetic: a false CRITICAL "Levin absent", because EXPECTED CAST came from the name-scanned cast.
- **Nothing checks a VB-backed creature's colour or scale** once its reference cell is gone.
- **Status.** The cast bug is `tasks/bugs.json` `iterate-repair-cast-from-name-scan` (open). The uncommitted working tree adds `castOfRewrittenBrief` (`sceneMetadata.js:1509`) and `carryParentObjects` (`iterateBeat.js:831`, `images.js:4272, 4328`). The "shallow depth of field" contradiction and the self-report mismatch are **not** addressed anywhere.

### S5. p14: the char-fix removed the story prop and left a hard seam, and three gates passed it [C]
- **Pixels.** v0 is excellent: Julian biting a Marroni and leaning on the scales. The v1 char-fix:
  - Brown eyes, as ordered.
  - **The chestnut is gone.** The hand rests empty at the chin.
  - The mouth is open-smiling rather than "chewing softly".
  - A **rectangular seam**: a hard horizontal edge across the jacket at y≈0.6 and a blocky pixel patch at the right shoulder (x≈.75-.81, y≈.49-.60), at the edge of the repair crop.
- **Root cause of the lost prop.** `faceRepair.js:582-591` builds "state in this scene (MUST be preserved)" from `characters[].pose/action/gaze/holding`. The current brief schema does not carry those fields: hands live in `interactions[]` (AD rule 8j), and gaze is `looksAt`. Only `Expression` reached the prompt (`11a`). This is a stale field reader, so every char-fix loses the page's held object and action.
- **Gates that passed it.**
  - Quality eval v1: PASS, "items_held right: marroni", `composite_seam:false`. Both false.
  - `repair-naturalness` and `repair-face-check` (prompt-inventory:178-179) let it through.
- v1 was not shipped (60 < 83), but only because of the score.

### S6. The eye-colour contradiction drove a repair in the wrong direction, and the entity judge flip-flopped between rounds [C] (partly [IN-FLIGHT])
- **Stored record.** Julian `eyeColor: "blue"`. The AD wrote "blue eyes" into the p1, p8 and p14 briefs, and the generator painted vivid blue on the p14 close-up.
- **The avatar sheet** (`06-avatars/img/1-Julian.p2.a1.jpg`) reads dark/indistinct.
- **Entity round r0** (`entity-history/r0/grid-4`, cell E = P14): CRITICAL "blue eyes … vs the canonical **dark-eyed** Julian". That routed the char-fix.
- **Entity round r1** (`r1/grid-3`, cell C = P14, now brown): "eyes are brown in cell C, but **blue** in the reference photo (R)". The same judge on the same reference gave the opposite verdict.
- **The consolidator** wrote a fix_draft with "blue eyes" while forwarding a finding that condemned blue.
- **Status.** The uncommitted `faceRepair.js` change (`CHAR_FIX_DEFECT_PHRASES`, "no judge text") stops the judge's sentence from ordering the trait. The upstream half is not addressed: the AD writes a stored eye colour into briefs that the avatar may not show. Memory `description-must-match-avatar` / `eye-colour-consistency-not-accuracy` applies here. That is an owner call, not a reversal.

### S7. The entity grid's crop artefacts become findings against the page [C]
- `cutout_artifact` MAJOR on p14 reads: "a large white, pixelated area covers part of the character's right arm and the object". The white pixel block exists **only in the grid crop** (SAM mask edge on the paper bag, visible in r0/grid-4 cell E and r1/grid-3 cell C). The page pixels are clean.
- The same applies to the cover cell A (P-3), where the jagged jacket edges come from the crop.
- The consolidator then planned an inpaint "remove the white pixelated artifact from Julian's right arm and the Marroni" on a page that has no such artifact.
- Files: `entityConsistency.js` crop/mask assembly; prompt `entity-consistency-check.txt`.

### S8. The entity check flagged a garment that is off by design [C] [IN-FLIGHT]
- Kiaan on p11 and p12 got "missing the rust-brown gilet". Both briefs declare `ART004 state: off`. The p12 image shows it correctly in a heap by the wall.
- **Cause:** the pipeline passes the bible as `wornItemsVisualBible` and the grid read `visualBible`, so the off rows resolved to nothing.
- The uncommitted `wornItems.wornItemsBibleOf` plus the `entityConsistency.js:1821-1836` change fixes this. Not at HEAD.

### S9. Plates: contradictory camera, an unvalidated retry and derive, and style lost in the derive [C]
- **Contradictory camera in one prompt.** `storyJobPipeline.js:4677` takes SHOT from the representative page, which is `close-up` for both LOC002.4 (p13) and LOC002.5 (p14). The FRAMING paragraph comes from the vantage/AD plate text: "downward-looking aerial view" (LOC002.4) and "high-angle view looking sharply down" (LOC002.5). The VANTAGE line says "close to the wet ground… looking along". Then `storyJobPipeline.js:4689` says "The FRAMING paragraph decides the camera position", and `prompts/empty-scene.txt:27` says "Use the camera angle named in the SHOT line. Do not change the framing". Three cameras in one prompt. Pixels: eye-level medium-wide plates for both.
- **Dangling reference.** `sceneGeometry.js:72` emits "take the light from the direction named above", but no direction is named anywhere in the LOC002.5 prompt.
- **The retry is judged on pixels only.** `storyJobPipeline.js:4841` passes `skipVision: true`, so a retry that fixes nothing semantic still "passes". The LOC002.4 retry base (`empty_scene/p13`) is a photographic core with painted edges.
- **The derived plate is never QC'd** (`storyJobPipeline.js:4872-4894`). The p12 aerial derive (`empty_scene/p12`):
  - It barely moved the camera: slightly higher and wider, still not "straight down".
  - It **lost the watercolour edges and reads as a photograph**.
  - It shows small people at the house door.
- **The derive instruction** (`shotVocabulary.js:594-602`) carries no ART STYLE and no "no figures". The aerial definition it pastes in names "figures seen from over their heads".
- **Partial fix at HEAD.** b2751c799 removed "position" from the keep-list, which pinned the camera (found on p2). It is unvalidated for aerial.
- **The routing doc contradicts the derive.** `docs/image-routing.md:20` says edit-on-a-photoreal-base "drags toward realism", and the derive is exactly an edit. The doc has no row for derived plates.

### S10. The plate QC has no style or camera check, and its figure rule contradicts the generator [C]
- `prompts/empty-scene-qc.txt:2` says "Small background figures, animals, and distant people are fine". The generator says "No figures, no animals… never draw a figure" (retry prompt, and `storyJobPipeline.js:4692`). `docs/decisions.md:24115` says plates stay people-free.
- The newer plate-population design (`storyJobPipeline.js:~5290`, 5beac7c16) treats plate people as setting evidence. That tension is a documented-but-unresolved owner call, not a bug.
- The QC never checks ART STYLE or SHOT, so photographic plates and wrong-camera plates pass. On p12 v1 the QC did catch the chess board and people.

### S11. The per-page style gate parrots the ART STYLE text; the book-level check disagrees [C]
- All 6 quality responses I read return `faces: "loose washes with visible brushstroke texture"`. That is the ART STYLE sentence verbatim, and it is not one of the template's own options (`image-evaluation.txt:26`). `matches_style: true` everywhere.
- The template forbids exactly this: "Do not … back-fill labels that agree with it" (`:30`). A single call cannot enforce "answer before reading".
- The book-level `style_consistency.json` says `styleMatch: drifted`: "faces consistently smooth and digitally rendered… too defined". My read of p14 and p17 agrees with the book-level check.
- Style repair is OFF by owner decision (routing row 40, 2026-09-19). Do not reverse it. The finding is only that the per-page gate is non-functional as a detector.

### S12. p12 image prompt contradictions (generator side) [C]
- **Max's clothes.** WORN ITEMS: "Max IS wearing … purple hooded sweatshirt". The prose: "Max in his white long-sleeve shirt". ART005 was not declared in p12 `wornItems`, so it defaulted to worn. The image followed WORN ITEMS, and no judge noticed the conflict.
- **Julian's pose.** EXACT POSES lumps "Max, Levin, Kiaan, Julian, Nia, Turi: dig and rake…", from one interaction naming six actors. The prose says Julian "stands nearby wiping his eyes". One line for six actors also erases the per-character actions the semantic judge then scores (Max "drops lower", Levin and Kiaan "pull the same pile").
- **Height versus age.** HEIGHT ORDER: "Max (shortest) → Julian (slightly taller)", from stored cm (98 / 102). AGE: "Julian: toddler … clearly smaller than a preschooler", from apparentAge. Two sources give contradictory orders. The age-band clamp itself is settled (memory `age-band-clamp-is-fine`); only the contradiction is new.
- **Gaze targets.** "eyes on Lindenhof square" for 3 boys: the location id resolves into a gaze target, which is meaningless in an aerial (`promptBuilders.js:5066-5073`).
- **Closed eyes.** "eyes squeezed shut" for Julian breaks AD rule 6d "Eyes are open". This is AD-stage; the brief checks did not catch it.
- **Night.** The brief says "dark night, city lost in the dark". The image is warm golden lamplight, not dark. Semantic and style timeFlow both accepted "night" [J].

### S13. The consolidator prompt is 35k chars, and 9.3k of it is "audit only" [C]
- Section sizes for p12 round 0: Rules 5.1k, Cap 2.5k, Spec 1.5k, **Final score (audit only) 9.3k**, Fix shape 4.1k, Output 4.0k, scene 3.0k.
- `feedback-consolidator.txt:68` says the pipeline scores from `deduped_issues`, so `final_score` is recorded only (`feedbackConsolidator.js:533`).
- qwen-plus then rambles over it. p17 round 0: "…rounded to 50 per pipeline tolerance … but rul…". It runs twice per repaired page.

### S14. The semantic judge is over-literal about unpaintable brief details [J]
- p17 v0 got MAJOR "spark is visible and ends within the frame instead of shooting completely out of the right side". The brief demanded something the image can barely show.
- CRITICAL "still largely inside the shell": the hatchling's front half is clear and its hind feet are inside.

---

## Section size table: p12 page prompt as sent (6,834 chars; ≈10,085 before the shrink; cap 7,900)
| Section | chars | Verdict |
|---|---|---|
| THIS IMAGE DEPICTS | 220 | keep |
| Generate a SINGLE illustration | 502 | keep; generic |
| When the FIRST reference photo… | 511 | generic; could be shortened |
| HEIGHT ORDER | 136 | contradicts AGE (S12) |
| AGE & PROPORTIONS | 484 | keep |
| REFERENCE CARD COLOURS | 354 | keep (non-droppable) |
| WORN ITEMS | 773 | **trim**: repeats the full garment descriptions already on the reference cards; ~350 would do |
| Scene prose | 1,294 | **trim**: 374 chars are the four outfits restated, a duplicate of refs and WORN ITEMS |
| REQUIRED OBJECTS | 642 | the 202-char "A state that divides…" rule is irrelevant here (nothing breaks); emit it only when an object has a split state |
| SEASON | 288 | generic |
| ART STYLE | 864 | "Each character keeps their real age…" duplicates AGE (~110) |
| SHOT | 177 | keep |
| EXACT POSES | 120 | one line for six actors (S12) |
| EXPRESSIONS AND EYES | 456 | "eyes on Lindenhof square" ×3 is noise |
| *dropped:* Composition / REQUIRED CAST / DEPTH / COUNTS / NO MARKS / HANDS | 1,176 / 522 / 645 / 233 / 351 / 324 | the shrinker cut these instead |

The ~1,000 chars of restated outfits and garment descriptions, plus the 202-char split rule, would have kept Composition and REQUIRED CAST (about 1,700 chars) on this page.

---

## Improve (generic)
1. **Shrink.** Before dropping any rule block, dedupe restated outfit clauses in the prose against WORN ITEMS and the cards. Emit the split-state rule only when a cited object declares a split state. Protect the two parity anchors (NO MARKS, HANDS) positionally, as the cover TITLE was protected (memory `prompt-shrink-hazard`). Pin reach on the **sent** prompt in `generator-critic-rule-reach.test.ts`.
2. **Duplicate / missing claims.** Ask the owner for a severity ceiling in code when the detector count disagrees: `duplicate_character` with detector humans ≤ expected. This is structured data, not description text, so it is allowed by the CLAUDE.md eval rule, but it is an owner call.
3. **Version selection between near-identical renders.** Take a second independent sample when two versions differ by less than a pixel-diff threshold. This is the same cure as grid-judge collapse (memory `grid-judge-collapse`). Owner call, costs cents.
4. **Char-fix state.** Build it from `interactions[]` (hands, objects held) and `looksAt`, not the retired `pose/action/holding/gaze` fields (`faceRepair.js:582-591`).
5. **Plates.**
   - One camera source per plate: FRAMING must be authored for the SHOT that is sent, or SHOT must come from the vantage that owns the FRAMING.
   - Run the vision QC on the retry and the derived plate.
   - Add ART STYLE and "empty of figures" to the derive instruction.
   - Remove the dangling "direction named above".
6. **Plate QC.** Add a medium check (photographic = FAIL) and a camera check. Resolve the figures-allowed versus people-free contradiction (owner).
7. **Iterate rewrite.** Recheck the rewrite against ART STYLE (optical blur), and check its `draftValidation` / diagnosis claims against its own metadata.
8. **Consolidator.** Delete the 9.3k audit-only scoring section, or make `final_score` code-computed. Rank the cap by (verified × severity), so a real MAJOR is never starved by an unverified CRITICAL.
9. **Store the unstored prompts.** Plate QC, quality, semantic, inventory, iterate re-brief, entity, book audit, style. This review had to rebuild them from builders.

## Blind / withholding: what each judge sees
- **Blind inventory** (`runVisualInventory`, `evalPipeline.js:98-121`, template `image-inventory-unified.txt`): image only. Documented as blind by design (decisions 2026-08-23 "P1 is blind and names nobody"; SETTLED line 34). OK.
- **Quality** (`buildEvaluationPrompt`, `services/prompts.js:862`): image and refs, ORIGINAL_PROMPT (the sent scene head via `resolveEvalSceneDescription`), EXPECTED_CAST, CLOTHING_CONTRACT, ART_STYLE, REQUIRED_OBJECTS, LANDMARK. It **sees the ART STYLE it is asked to judge "before reading"** (S11). The shrink-dropped generic rules it still enforces are not in its ORIGINAL_PROMPT. Undocumented.
- **Semantic** (`sceneValidator.js:773`): image, SCENE_HINT, IMAGE_PROMPT, STORY_TEXT (context only), cast, clothing, landmark. The text-not-a-checklist rule is SETTLED (memory `page-text-not-a-checklist`); p17's missing boys are correctly left to the book audit, which did flag them (p17 FAULT[IMG]).
- **Compliance judge:** OFF (SETTLED line 34), recorded per page as `notEvaluated`. OK.
- **Plate QC** (`evalPipeline.js:408-476`): plate image, scene text (300 chars), placements, main prose (800 chars), era. **No ART STYLE, no SHOT.** Retry is pixel-only; derived plates are never judged. Not documented as a choice.
- **Consolidator:** text only (no image), documented in prompt-inventory:139. It cannot catch pixel hallucinations, and no one upstream verifies them.
- **Entity:** crop grids plus the reference sheet. Its crops carry SAM mask artefacts it then reports (S7). Undocumented.
- **Book audit:** text plus shipped image per page (prompt-inventory:48). OK.

## Doc gaps / stale docs
- `docs/prompt-inventory.md:136` says `image-visual-inventory.txt` is used by `images.js runVisualInventory`. **Stale:** runVisualInventory sends `imageInventoryUnified` (`evalPipeline.js:105`); `image-visual-inventory.txt` is now only regeneration.js and testlab.
- Not in prompt-inventory's hardcoded-prompt list or `image-generation-methods.html`:
  - the plate derive instruction (`shotVocabulary.js:594`)
  - the vantage-plate FRAMING/SHOT assembly (`storyJobPipeline.js:4685-4692`)
- `docs/image-routing.md` row 20 (plates) predates derived plates (decisions 2026-09-21) and contradicts them ("edit on a photoreal base drags toward realism").
- The comment at `images.js:846-847` ("Composition … in practice never reached") is disproved by p12.
- No doc records that the plate QC skips vision on the retry and never judges the derived plate.

## Already fixed since b03c64b0 (`git diff b03c64b0 HEAD`)
- The derive keep-list no longer says "position" (b2751c799). S9 partly fixed; unvalidated for aerial.
- Derived plates are persisted as derived, and population is read per derived plate (5beac7c16). Records only; no QC.
- Emotion moved to a code enum, and lettering is captured from the inventory (3d8f4871d, 1d4f1bcf1). Does not touch any finding here.
- **IN-FLIGHT (uncommitted, another session):** S4 cast and creature ids; S6 no judge text in char-fix; S8 worn-state bible key; plus text-diff findings. Not at HEAD, not validated.
- **Open and unaddressed:** S1 hallucinated "missing" items and cap ranking; S2; S3; S5; S6 upstream (AD eye colour); S7; S9 (except "position"); S10; S11; S12; S13.

## SETTLED / memory cross-check
No recommendation here reverses a SETTLED line:
- Compliance judge stays off.
- Text-not-a-checklist is respected.
- The age-band clamp and style-repair-OFF are acknowledged, not reversed.
- Items 2, 3 and 5-6 are owner calls under the "code may only change a severity" rule.
