# Fiona pirate rerun — staging job_1791450210539_nwi88y9lr (2026-10-08, commit 9bcab624)

Rerun of job_1790446348343_z3fw660ie with identical inputs. Raw report of the review agent below (issue numbers are referenced from tasks/BACKLOG.md). Backups/images were in the session scratchpad only.

### Run facts (new vs previous run)

| | New run (10-08) | Old run (09-26) |
|---|---|---|
| Duration | 56.5 min | 58.0 min |
| Outline stage | 35.5 min | 33.7 min |
| …of which arc | 22.6 min (arc_create alone 842 s) | 21.5 min |
| Avatars | 2.0 min | 0.8 min |
| Images | 2.4 min | 2.8 min |
| Repair | 15.9 min | 20.7 min |
| Total cost | $6.50 | $6.55 |
| Arc | arc_create $1.06 (Sonnet 5.5, 103k out tokens), retell $0.13, panel $0.14 | arc_create $1.27 (Opus 5.5), retell $0.25, panel $0.27 |
| Text | text_refine $0.12 | text_refine $0.64 + post-audit refine $0.27 |
| Planner | beats_plan $0.038 / 1,685 out tokens | $0.040 |
| Page images | $1.16 / 42 calls | $1.04 / 34 |
| Inpaint | $0.36 / 9 | $0.12 / 3 |
| Avatar sheets | style transfer $0.20 / 10 calls | $0.10 / 5 |
| Visual Bible | $0.33 (incl. 1 cut stream) | — |
| Plate QC | $0.14 / 26 | — |
| Mean page score | 87.75 (min 68) | 71.9 (min 9) |
| Surviving CRITICAL findings | 4 | 12 |
| Shipped defective pages | 6 | 8 |

- **Cost target:** about CHF 5.2 at roughly 0.80 CHF/USD (my assumption), so slightly over the CHF 5 target and well under the CHF 8 cap. The biggest items are page images and arc_create.
- **Arc timing:** the arc is still the long pole. arc_create runs about 14 minutes and produces 103k output tokens.
- **Verify run:** `node scripts/admin/verify-run.js job_1791450210539_nwi88y9lr --staging --write` judged 77 entries: **0 CONFIRMED, 0 FAILED, 57 HUMAN, 20 NOT COVERED**. It skips entries already decided. A dry run with `--all` gives 13 CONFIRMED and 3 FAILED, which matches the server report:
  - `emotion-enum` (was confirmed, so this is a regression): 25 of 28 brief rows carry an enum emotion.
  - `ots-crop-no-contact` and `plan-check-ots-contact`: on p3 the near figure, Lorena, slips the chart into her coat. These also failed on the previous Fiona run.
- `tasks/verify.json` is modified and **not committed**. I did not run `--all --write` or `--pull`.

### Worked as intended (with evidence)

1. **Planner at effort medium:** beats_plan 1,685 out tokens ($0.038), beats_replan 1,080, story bible 1,084. All are under 5k and the plan takes 12.8 s.
2. **Untouched-page re-plan guard:** the one finding the re-plan created ("minted" in the log) is `NO_PEOPLELESS_PAGE` on p6, a page round 1 changed. Round 2 correctly did not run. The round was kept and nothing regressed (`replan-round-never-regresses` CONFIRMED). There were no `changeRefusals`, and the p10 cast-out of Herr Frei was accepted.
3. **Lead page per figure:** every commissioned figure leads a page (castTable: kept 15, broken 0). Fiona leads p12, Sarah p5, Saira p4, Facundo p13, Lorena p14.
4. **Arc Facts:** few and physical, most figures "none". The two figure facts are Facundo "can throw a weight across the Limmat" (used p13) and Herr Frei "his keys jingle with every stride" (used p3, p4, p5, p7, p15). There are two one-line world rules, and the sunset deadline is met on p14 ("Auf den Türmen lag noch das letzte Licht"). This is better than the old arc, which had feelings as limits and 3 invented figures.
5. **Text:**
   - Präteritum throughout, «» quotes, ss spelling, no dashes. All five friends have scenes.
   - Refine edits stay at or under 0.30 per page (maximum 0.294 on p6). Refine added no narrator links; it removed an explanation ("Wir müssen sie vom Wasser aus lesen") and the never-paid-off weir rule.
   - The text keeps owed facts as acts, for example «Diesmal hob sie ihn nicht ab.»
6. **Plate QC fails loudly:** 4 `plate_shipped_failed_qc` errors, for LOC005.3, LOC003.1, LOC004.2 (a photographic plate, confirmed by looking at it) and the p-2 plate.
7. **Paste-back:** collateral changes drop to 0–1 cells on p1, p3, p4, p9 and p16. Visually the rest of each frame is identical.
8. **Paired re-judge:** repair children carry `parentFindings` (fixed or still_present) and `alsoInParent`.
9. **Reader findings left out of selection:** confirmed in `selectionScore`; see issue 2 for the side effect.
10. **Back-cover caption removed:** the inpaint removed "THE PIRATE CREW RESTS TOGETHER" and v1 shipped.
11. **Avatar sheets:** single person per sheet, no caption strips, not photographic, and the head row is cropped on all 5 (`crop.applied` true). No carried object appears in the outfit text. There is no tail figure in this story.
12. **Cost ledger:** the api_usage rows sum exactly to $6.4964 (the total). 65 of 75 buckets are on ledger 2, 1 cut stream is recorded, and plate_qc and the page_quality_inventory/semantic/absence buckets exist.

**Not covered by this story:** char-fix frames and billing (no char-fix ran), cover creature (none in the story), submerged light (no underwater pages), anchor gate.

### New issues

1. **Repair selection, dedication page (initialPage) – HIGH.** v0 shipped with a painted English caption "THE CREW" (CRITICAL `rendered_text`). The inpaint (v1) removed it cleanly (`parentFindings` P1 fixed). But the re-judge charged v1 with defects that are equally in the parent and not tagged `alsoInParent`: "Page is photographic" MAJOR, plus missing accessories. So v1 scored 69 against v0's 75, and the version with the caption shipped. Likely cause: the paired judge only tags against parent findings, and the parent was judged leniently.
2. **Repair selection, p1 – MED.** The inpaint did fix the action: chestnuts are visibly going into Facundo's pocket. The re-judge still says the CRITICAL is "still_present". v0's selection score (75, with its reader MAJOR "headband instead of eye patch" given back) beat v1 at 73, so the unfixed picture shipped. Reader findings are given back to v0 even though v1 has the same pixels in that area; v1 was simply never read by the reader.
3. **Garment recolour damage shipped, p16 – HIGH.** v0 drew Saira sleeveless. The recolour pass (top cream→white) applied a hue shift with ΔE 22.4 over 16,369 px (DINO 0.39) to her bare arms and neck. The arms now look like pale mint patchy skin. This v1 shipped at 83 against v0's 68, and no judge flagged it. Underneath, the trigger was a trivial cream-vs-white entity finding.
4. **Inpaint false "fixed" and a ghost artifact, p9 – MED.** The fix "Add the black cloth eye patch" was not done, yet the re-judge marked P2 fixed and v1 scored 100. Lifting the anchor also left a doubled ghost fluke at the lower left.
5. **Repair text with an age and a wrong position, p4 – MED.** The log reads `Turn this character's head forward, eyes fixed on the 24-year-old woman in the white shirt, fourth from the left's back` on a page with 2 figures. This contradicts `repair-descriptor-no-names`, which the checker CONFIRMED. The inpaint also turned Saira's head (new MAJOR); v0 correctly kept.
6. **Covers photographic – HIGH.**
   - Front cover v0 shipped at 43, with Sarah's bandana missing and Lorena not in a ponytail.
   - The front-cover iterate scored 26.
   - The back cover and dedication page are also flagged photographic. My own look agrees: they read as digital paintings with near-photo faces, while the pages are watercolor. The old run's front cover was more watercolor.
7. **Cover brief prose still has layout phrases – LOW–MED.** `ad-showcase-fixes` claim (2) fails. The front cover has "The top third of the picture is the empty dark grey and deep blue dusk sky", and the dedication page has "feet placed along the bottom fifth". The dedication page then rendered a caption.
8. **Avatar hair judge rejects 3 of 5 sheets – MED.** Fiona, Sarah and Lorena shipped with "style judge rejected every attempt … 1/10 (hair …)". The sheets match the photos; the declared hair does not. For example, Fiona's description says "neck-length, brushed back" but she has long hair, and the judge fails all 8 cells. This doubled style-transfer calls (10 vs 5) and avatar time (2.0 vs 0.8 min). Saira's head row also cuts off the top of her head.
9. **Art Director adds a garment, p3 – LOW–MED.** The brief gives Lorena "a black tricorn hat" that is not in her wardrobe, and she wears it only on p3. The hat finding was dropped as "finding_contradicts_brief".
10. **Over-the-shoulder shot on a contact action, p3 – MED.** The decision layer (Jev) chose over-the-shoulder, the plan check missed it, and the "slips chart into coat" CRITICAL survived. The inpaint changed pixels in the box but not the action.
11. **Brief drops a plot object, p5 – MED.** The text says «Kisten voller Kürbisse» and the plan says "behind pumpkin crates", but the brief has an "empty wooden market stall frame". There is no Visual Bible entry for the crates. The picture shows Sarah sitting in the open with no pumpkins and not hiding. Only the reader caught this; it was MAJOR and could not count toward selection.
12. **Rope direction reversed in the brief, p7 – LOW–MED.** The brief says she "tosses the thick bow rope over the heavy wrought-iron mooring ring", meaning on rather than off. The shipped v1 shows the rope still tied to the ring, a rope loop floating in the air, and Saira on the quay rather than on deck. It also produced `consolidator_fix_unbacked` "Remove the bow rope from around the mooring ring".
13. **Crew on the wrong side of the water, p13 – MED.** The text has Facundo «trat an die Reling» on the anchored ship. The brief and image put Facundo and Sarah on the quay steps, with the ship tied behind them and Herr Frei on the far steps.
14. **Ship changes shape, p8 – MED.** The p8 plate and page show a mastless open rowboat with a wheel. The Silbermöwe in the Visual Bible, p7 and p13 is a tall-masted galleon.
15. **Brief gaze contradicts metadata – LOW.** On p3 and p11 the prose says "looking straight ahead at Herr Frei" or "stares fiercely ahead" while `looksAt` says the chart. Gaze MAJORs then drive inpaints, including p16, a group-laugh page where looking at each other is natural.
16. **Lector edits – MED.**
   - Undid the Swiss word: «Nehmt ein Brötli» became «Brötchen».
   - Changed the plot: «Lorena trug die Karte die Treppe hinunter unter Deck» became «hinauf an Deck». That now contradicts p14 «Aus dem Schiff kam Lorena mit der Karte».
17. **p1 never introduces Saira and Lorena – LOW–MED.** The plan cast p1 as 3 figures. Refine patched this with relative clauses: «Lorena, die mit den anderen hereingekommen war» and «Saira, die vorneweg gelaufen war».
18. **Text logic – LOW–MED.**
    - p9: Facundo's anchor act is taken from him («Käpt'n Vreni griff nach seinem Arm … Die Kette rasselte durch die Luke»).
    - The decoy's crookedness only matters up close, and Herr Frei sees through it anyway («Das ist nur eine Kopie»).
    - p16 «für nächsten Samstag» is set up nowhere earlier.
19. **Re-plan rules conflict – LOW.** Adding faces to p15 (`PEOPLELESS_ON_INTERACTION_PAGE`) created `NO_PEOPLELESS_PAGE` on p6, the finding that stopped convergence. Also, `beats_replan_change_unreadable` flags 3 "instant shortened — PLAN[PLAN_INSTANT_TOO_LONG]" changes as outside the declared vocabulary, so nothing reviewed them.
20. **Cost ledger misses some calls – LOW.** 31 qwen3-vl inventory calls (about 100k in / 57k out tokens, roughly $0.03) are booked under the alias `qwen3-vl` and land as `unpriced_calls`. The price table only knows the full model name `qwen/qwen3-vl-32b-instruct`.
21. **Visual Bible reference cells accepted as bad – LOW.** 3 cells failed twice and were accepted anyway: the red pencil, the neat copy (drawn as a crumpled ball) and the galley-sack copy (drawn as plain paper).
22. **p12 thumb press never achieved – LOW.** The CRITICAL survived. The copy reads as parchment rather than brown sack, and Fiona holds a pen instead of the red pencil.
23. **Pirate-costumed background extras, p14 – LOW.** People in vests and sashes in the background could read as extra crew.
24. **Interior plate – LOW.** p2: ivy grows on the indoor museum walls.

Not in this list: the `[COVER-VALIDATE] backCover: no LOC picked — substituting …` lines in the logs (e.g. "Kinderzimmer in Fislisbach"). They come from other jobs that ran at the same time, not this story, and I did not investigate them.

### Compared with the previous run
Text is cleaner: physical Facts, no recited rules, and refine cost dropped from $0.91 to $0.12. Cost and duration are flat.

Pages are much better: mean 87.75 against 71.9, and the worst page is 68 against 9. Covers are worse in style: photographic, the dedication page ships a caption, and front 43 against the old front cover's 60.

Repair mechanics did run: paste-back and paired re-judge are in place. Selection still picked the wrong version on the dedication page and p1, and recolour damage shipped on p16.

