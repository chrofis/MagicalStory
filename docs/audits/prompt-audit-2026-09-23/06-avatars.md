# 06 — STYLED AVATARS: prompt-judge findings

## Status 2026-09-23

Checked against staging `31fd7db0c` (after the evening fix round). FIXED = the commit that fixes it; OPEN = no fix yet, no ruling needed to start; OWNER CALL = touches a decision, a SETTLED line or has options the owner picks. Stale-doc and registry items listed at the end of each file were corrected in `a25ecb865` unless listed below.

- FIXED: the reconcile re-render — a same-garment rewording re-renders nobody (option b) — `ee8890278`. S1-1 row judges copying the example and S1-2 style judge copying TASK text — `86d6ff4a7` (placeholder examples, per-cell reasons, one echo guard `isEchoedJudgeVerdict` behind `askSheetJudge` for all four judges: re-ask once, then throw). S2-1 cell 4/8 pose — `86d6ff4a7` (`REAR_TURN_POSE`, one constant in both row generators and all four judges). S3-3 wrong bodies example and the `anglesScore` field name — `86d6ff4a7` (placeholder examples, `angles.score`).
- FIXED (`54554c69d`, decisions.md "Styled-avatar audit: head-and-shoulders crop…"): S2-3 head row framed like a passport photo + heads CROP task (validated: 1 of 2 paid runs, the second wording); S2-4 no-invented-trim rule in both live rows + heads/bodies judges; S2-5 `SHEET_GROUND_RULE` in pass 2 + style-judge TASK 8 (cell splitter measured not to need drawn dividers); S3-3 heads/identity/style finals computed in code; S4 `buildPrompt` / `evaluateSheetWithGemini` / `sheet-2x4-evaluation.txt` deleted, Lab `avatar_eval` override per judge (`params.evalPrompt`) and `avatar_style` prefill = the built prompt; sheet-judge prompts stored (`passes.pass1.judgePrompts`, `passes.pass2.judgePrompt`); S2-2 in the prompt only — the anchor line says the style text wins over the swatch.
- OPEN: S3-2 colour drift — the style judge now compares hair/skin to the pass-1 sheet, but still passed blotchy cheeks and an auburn hair shift on validation; S2-4 the body row still drew an unnamed polo on 1 of 2 runs; raw judge replies not stored; mojibake check.
- OWNER DECIDED 2026-09-23: S2-2 closed — the anchor keeps its figures; a figure-free anchor was tested and does not work (2026-08-12 stands).
- OWNER CALL: option (c) re-render a VISIBLE change from the approved sheet instead of the photos; S3-1 drawn-younger age (standing ruling — report only); a pencil-free replacement watercolour anchor (with its figures) — the prompt now says the style text wins over the swatch.

---

Run: `job_1790100385959_1nitlympp` ("Das Ei im Laub", watercolor, Levin 5 / Julian 3 / Max 3 / Kiaan 3), built at `b03c64b0`.
Stage: pass 1 (decoupled body row + head row, grok-imagine-image) → pass 1 row judges (gemini-2.5-flash: heads, bodies, identity) → pass 2 style transfer (grok, watercolor anchor as Image 2) → pass 2 style judge (gemini-2.5-flash).
Evidence: the stored prompts and verdicts in `06-avatars/`, the staging DB (`stories.data.styledAvatarGeneration`, `generationLog`), and **the pixels**. I downloaded all 6 pass-1 composites, all 8 pass-2 outputs and the style anchor to `06-avatars/img/` and looked at each one.

**Already fixed since b03c64b0:** none. `git diff b03c64b0 HEAD` touches none of these files: `character2x4Sheet.js`, `styledAvatars.js`, `clothingCheck.js`, the `sheet-*` templates, or the wardrobe hook. The 28 commits since then only change plate and promptBuilders code that has nothing to do with avatars.

---

## Why Levin and Kiaan were generated twice (recreation)

**What happened.** This was not a retry. It was a full second photo-to-sheet run: pass 1 and pass 2 again, from scratch. `generationLog` has `beats_wardrobe_bible_conflict` at 2026-09-22 20:39:37 CH. It reads: `Levin/outer layer "and a forest green zip-up fleece jacket" vs ART006 "fleece jacket"` and `Kiaan/outer layer "... rust-brown quilted gilet — a sleeveless front-zip body warmer ..." vs ART004 "quilted gilet"`, both with `corrected: true`.

**The garments are the same.** Both are `kind: 'reconcile'` findings. The Visual Bible item carries a `wornAs` link, so `clothingCheck.js:653-656` restates the wardrobe clause in the bible's words even when both name the same garment. The bible words are "long-sleeve zip-up fleece jacket with a high collar" and "sleeveless front-zip body warmer with diamond quilting". Then:
- `beatsPipeline.js:2392` fires `onWardrobeCorrected` for any applied finding, reconcile included.
- `storyJobPipeline.js:2054-2079` invalidates the cached sheet and runs `prepareStyledAvatars` again. That call goes back to the photos.

**Confirmed costs:**
- Two extra avatar builds: 3 + 4 Grok calls plus about 8 Gemini judge calls, roughly $0.15, and about 80 s of avatar work chained into `streamingAvatarStylingPromise`.
- **An identity re-roll inside one sheet slot.** Levin v1 (the `0-` files) has curly, darker-blond hair and a toddler face. Levin v2 (the `4-` files) has shorter, straighter, lighter hair and a different face. This is the drift that the 2026-09-19 wardrobe-variant design (`character2x4Sheet.js:1770-1775`) was built to avoid: "two independent photo→sheet runs disagree on hair, build...". The v1 sheet already *showed* the high collar and the diamond quilting, so the new words described what was already drawn.

**Docs are stale.** The decisions.md entry *"2026-09-15 — A wardrobe correction re-renders its avatar"* (line ~48053) justifies the re-render as serving "a rare conflict". The reconcile kind (`accd6b197`, the same day) makes it fire on **any** declared-`wornAs` outer layer that is worded differently: 2 of 4 characters in this run. The comment at `storyJobPipeline.js:2051-2053` ("Corrections are rare (a genuine contract/bible contradiction)") is wrong for the same reason.

**Options (owner's call, no reversal needed):**
- (a) Do not re-render on `kind: 'reconcile'`. Nothing visual changed, so only the text is restated.
- (b) Re-render only when the slot's garment noun or colour changed.
- (c) When a re-render is warranted, derive it from the approved sheet with the `redressSheetVariant` machinery instead of from the photos. This keeps identity fixed.

---

## Findings, ranked by severity

### S1-1 — CONFIRMED: every pass-1 row judge returned the template's example JSON verbatim
- **Evidence:** 6 of 6 sheets, 100% of the reason strings.
  - Heads: `"Front, three-quarter, profile, back left to right"`, `"No arrows or stray marks on any head"`, `"Visible shoulders are clothed in the requested garment in every cell"`, `"One head per cell, four separate heads, ..."`.
  - Bodies: `"Every figure wears the requested items, consistent across cells"`, `"Reads as the requested costume; 10 when none was requested"`, `"Proportions match the stated age"`, `"Plain white background in every cell"`.
  - Identity: `"All 4 heads match the reference person in face structure, hair, skin tone, and age"`, with 9/9/9/9 per cell on all 6.
  - The scores equal the example scores (9 / 9 / 9 / 10).
- **Pixels prove the judge did not look.** Kiaan's head and body cells 3 and 4 are **both profiles** in both sheets, yet angles scored 9 with "Front, three-quarter, profile, back". The heads prompt itself says a duplicated profile scores 1-3.
- **Cause:**
  - `sheet-row-heads-eval.txt:20-29`, `sheet-row-bodies-eval.txt:35-47` and `sheet-row-identity-eval.txt:17-18` give a concrete, filled-in example with plausible reasons.
  - `evaluateSheetRow` / `evaluateIdentity` (`character2x4Sheet.js:1218-1273`) have no echo guard.
- **A missed sibling.** Exactly this failure was fixed for the pass-2 judge on 2026-08-12 (decisions.md "Style-anchor people bleed: swatch wording + de-echoed style eval"): `<placeholder>` example plus `isEchoedStyleVerdict` at `character2x4Sheet.js:1093-1128`. The row evals were created on 2026-08-09 and 2026-08-15, and the fix never reached them. The pair is not in `scripts/admin/sibling-registry.json` as far as I can tell (not checked exhaustively).
- **Consequence:** pass 1 has effectively **no working quality gate**. The only real signal in pass 1 is the pose-keypoint head check (`applyPoseHeadGate`).
- **Improve:**
  - Use `<placeholder>` reasons in all three templates.
  - Share one echo detector across all four sheet judges: an exact match against the template example strings, plus a check for `<`.
  - Require a per-cell observation (for example "cell3: profile facing left, cell4: profile facing right") that cannot be copied from the prompt.

### S1-2 — CONFIRMED: the pass-2 style judge copies the TASK text instead of the example, so the echo guard does not catch it
- **Evidence:**
  - The layout reason is the TASK 1 sentence verbatim in 5 of 6 finals: "Image 3 is a 4-column × 2-row grid like Image 2. Top row = 4 head-and-neck cells... Same cell order: front, three-quarter, profile, back".
  - The identity reason paraphrases TASK 2 in 6 of 6.
  - bodyFace copies TASK 5 ("Cell 8 shows the back of the head as expected").
- **Pixels contradict the verdicts.**
  - Kiaan's final (`5-Kiaan.p2.a2`) shows profile/profile in cells 3/4 and 7/8, and its top row is knee-length figures, not "head-and-neck cells". Layout scored 9 and 10.
  - Levin v1's pass-2 hair is visibly light-brown/auburn (the clean task itself listed "hair (light brown...)") against the pass-1 blond. Identity scored 9, "hair colour consistent".
- **Cause:** `isEchoedStyleVerdict` (`character2x4Sheet.js:1118-1128`) only detects `<` or two legacy strings.
- **Improve:**
  - Make layout per-cell ("cellN: <facing>, <crop: head|half|full>"), the same shape the clean task already forces.
  - Flag any reason whose longest substring appears verbatim in the prompt.

### S2-1 — CONFIRMED: the generator and the critics disagree about the cell 4/8 pose
- **Generator:** the body row asks cell 4 for a REAR TURN (body away, head turned back, one eye visible) and forbids a flat back or a second profile (`character2x4Sheet.js:325`). The head row asks the same (`:347`).
- **Critics:**
  - `sheet-row-bodies-eval.txt:12` says "front, three-quarter, profile, back".
  - `sheet-row-identity-eval.txt:5,7` says "(front, three-quarter, profile, back)".
  - `sheet-2x4-style-eval.txt:15` says "front, three-quarter, profile, back".
  - `sheet-2x4-style-eval.txt:39` says "Cell 8 shows the back of the head and needs no face".
  - Only the heads eval (`:3,6`) knows about the rear turn.
- **Pixels:**
  - Levin v1 and v2 body cell 4 are flat back views with no face.
  - Kiaan v1 and v2 cells 4 and 8 are plain profiles.
  - None was penalised. Given S1-1 they could not have been.
- **Improve:** use one shared pose vocabulary for the generator and every critic, such as a JS constant injected into both, per the `syncing-generator-and-critic` rule. Cell 8 then needs a face check (one eye and cheek) in style TASK 5.

### S2-2 — CONFIRMED: style-anchor contamination on 2 of 6 anchored attempts, and the anchor contradicts the style text
- **Evidence:**
  - Kiaan run 1 attempt 1 and run 2 attempt 1 both came back with the anchor's grandmother, grandfather and boy painted across the sheet (`2-Kiaan.p2.a1.jpg`, `5-Kiaan.p2.a1.jpg`). The composition is the same both times.
  - Levin, Julian and Max were clean with the anchor, 0 of 4.
  - The gate worked: solo 1, then a retry without the anchor passed. Cost: 2 wasted Grok calls plus 2 judge calls.
  - The two contaminated verdicts disagree on clean: 1 in run 1 and 9 in run 2.
- **The anchor contradicts the style text.** The swatch (`style-anchor-watercolor`, the `*.ref2.jpg` files) is a **pencil-outlined** ink-and-wash drawing. The style line in the same prompt says "Paint-dominant: no hard outlines, no ink or pencil lines".
- **Possible link, not established:** Kiaan's pass-1 sheets are the only ones on a light-grey (not white) backdrop. That may make the anchor's white-ground figures blend more easily.
- **Improve:** choose a swatch that obeys the style line, with no outlines. A figure-free swatch **reverses** the 2026-08-12 decision ("Anchors keep their family figures on purpose"), so that needs the SETTLED/decision reversal protocol and Lab evidence first.

### S2-3 — CONFIRMED: the head row is never head-and-shoulders, and the critic explicitly allows that
- **Generator:** "Each cell is a HEAD-AND-SHOULDERS close-up" (`character2x4Sheet.js:346`).
- **Critic:** "Some shoulder or a bit of torso in a cell is fine — do not penalise it" (`sheet-row-heads-eval.txt:3`).
- **Pixels:**
  - Levin v1, Julian, Max and Kiaan v1 head rows are cropped at the waist or hip.
  - Kiaan v2's head row runs to the knees (almost a second body row).
  - Levin v2 is the only real close-up.
- After pass 2 the top row of Kiaan v2 is effectively full-body. The style judge reported "Top row = 4 head-and-neck cells".
- **Impact on the head-cell crops downstream:** my judgement, not measured.
- **Improve:** add a crop-extent item to heads TASK 3 or a new task: "the lowest visible body part per cell is at most the upper chest". Or loosen the generator wording if a half-length top row is wanted.

### S2-4 — CONFIRMED (conditional on reading "shirt" strictly): invented collars and plackets pass, and the generator was never told
- **Pixels:** the costume says "A red long-sleeve shirt" (Levin) and "A blue long-sleeve shirt" (Kiaan). Both Levin sheets render a **buttoned polo collar**, and both Kiaan sheets a collared henley/polo.
- **The critic's own rule would fail this.** Heads TASK 3 says "A collar, placket, hood or trim the outfit does not name — a collared polo where a plain crew neck was asked for — scores 1-3". The judge echoed 9 (S1-1).
- **Gap on the generator side:** the matching generator line ("never a collar, placket, hood or trim the costume does not name") exists only in the dead `buildPrompt` (`character2x4Sheet.js:657`). The live `buildBodyRowPrompt` / `buildHeadRowPrompt` do not carry it. The critic enforces a rule the generator never got.

### S2-5 — CONFIRMED: pass 2 paints backdrops and removes the grid, and no judge checks it
- **Pixels:** 6 of 6 shipped styled sheets have painted wash shapes behind the figures and ground shadows. In all of them the thin black dividers are gone (Levin v1 turned them into torn paper-card edges).
- **Where it goes unchecked:**
  - The pass-2 prompt says "Keep the content of Image 1 unchanged", but the style line says "depth from atmospheric haze".
  - The style eval has no background or divider task.
  - The bodies-eval TASK 6 background check runs on pass 1 only.
  - `quickLayoutCheck` is advisory on pass 2 by design (`character2x4Sheet.js:1640-1653`). `layoutValid` was false on the contaminated Kiaan attempts only.
- **Downstream impact:** my judgement. The cell splitter (`/split-reference-sheet`) looks for near-uniform gutter bands, and painted washes and missing dividers undermine that. Owner of stage 07+ should check the crops.
- **Improve:**
  - One pass-2 line: "white paper ground and the thin cell dividers stay; nothing is painted behind a figure".
  - A matching style-eval task: backgroundScore on Image 3.

### S3-1 — CONFIRMED symptom, NO recommendation: sheets read younger than the declared age
- **Pixels:** Levin (declared 5) reads about 2-3 in both pass-1 sheets. Julian and Max (3) read about 18-24 months.
- **Judges:** every proportion and age judge said 9 ("Proportions match the stated age", which is echoed).
- **Standing ruling:** `feedback_age_band_clamp_is_fine.md` records that the owner ruled drawn-younger apparent age is fine (2026-09-11). **Reporting the symptom only. Not proposing a change.**
- **Inconsistency to put to the owner:** since 2026-09-14 the sheet prompt says the stated age "decides the proportions in every cell" (`declaredAgeBlock`, `:621-629`), and the critic claims to score against it. Either that wording or the ruling is not what is actually happening.

### S3-2 — CONFIRMED pixels, judgement on severity: pass-2 colour drift passes clean and identity
- Levin v1: blond turned auburn-brown.
- Levin v2 and Max: strong, blotchy red rouge patches on the cheeks in the head row.
- Clean TASK 4 compares against "natural colouring in Image 1" and treated these as natural shading. Cheek blush is borderline, so this is not a clear defect.
- Per `feedback_eye_colour_consistency_not_accuracy.md`, the check that matters is consistency between sheets of one story. That argues for comparing Image 3's hair colour to **Image 2** (pass 1), not to the photo.

### S3-3 — Scoring asymmetry and a wrong example
- `reviewHeadRow` trusts the model's own `heads.finalScore` (`character2x4Sheet.js:445-449`). Bodies is recomputed in code (`applyPoseHeadGate:413-422`).
- The heads formula names `anglesScore`, but the JSON field is `angles.score` (`sheet-row-heads-eval.txt:18,22`).
- The bodies example shows `finalScore: 8` while every example sub-score is at least 9 (`sheet-row-bodies-eval.txt:44`). That teaches an inconsistent min.

### S3-4 — Generator↔critic input gaps (judgement)
- **Hair:** the hair block (`buildHairBlock`) goes to both generator rows. No critic receives it, because identity sees only the photo and the standard-avatar faces. Nobody checks "wavy, short, tousled, light blonde".
- **Age in pass 2:** the pass-2 generator gets no age number, only "each character keeps their real age — babies, children, teenagers...". The pass-2 critic scores `CHARACTER_AGE`. That is acceptable as preservation, but the asymmetry is undocumented.
- **Mojibake:** the stored style-eval reason for Kiaan run 1 contains `4-column Ã— 2-row` (a double-encoded ×). The model may have received a mis-encoded ×. Not verified. Worth one grep of the sent prompt bytes.

### S4 — Dead code, stale docs, Lab mis-wiring (confirmed by grep)
- **Dead code:** production never calls `evaluateSheetWithGemini` + `prompts/sheet-2x4-evaluation.txt` (9.6 KB), `buildPrompt` (single-call 2×4, ~3 KB, still carrying the old "match apparent age in Image 3" vs declared-age contradiction), `loadPhantom`, or `buildCharacterDescription`. They are only re-exported via `_internal`.
- **`docs/prompt-inventory.md:207` is stale.** It lists `sheet-2x4-evaluation.txt` as the "2×4 sheet eval (pass 1)". Pass 1 is the split row eval (`:209-211`).
- **Test Lab prefills (`server/routes/admin/testlab.js:129-135`):**
  - `avatar_eval` prefills the dead whole-sheet eval, and its comment calls that "the pass-1 realistic evaluator".
  - A Lab `promptOverride` for `avatar_eval` is passed to **both** the heads and bodies row evals (`character2x4Sheet.js:1288,1293`), so one override replaces two different templates.
  - `avatar_style` prefills `styled-costumed-avatar.txt`, which production never loads. The real pass-2 prompt is built in JS (`buildStyleTransferPrompt`).
- **Audit naming:** the shipped styled-sheet URLs for Julian, Max, Levin v2 and Kiaan v2 point at page-debug keys (`debug/p1/ref-photo-1-orig.jpg`), presumably content-hash dedup. It is confusing in an audit but harmless.
- **decisions.md:** no entry covers example-JSON echo on the row evals. The 2026-09-15 re-render entry is stale (see the recreation section above).

---

## Bloat (estimated characters)
| Prompt | Redundant or unused | ~chars |
|---|---|---|
| Body row | tail/fin/fused-lower-body clause on a plain everyday outfit | 330 |
| Body row + head row | bib-and-brace garment rule, sent twice, with no parts-named garment in this story | 2 × 390 |
| Body row | rear-turn explained twice (hair block and cell-4 sentence), plus "ignore Image 1's cell 4" twice across the rows | 250 |
| Head row | full-body proportion text ("about 5 heads tall") in a head-and-shoulders prompt | 330 |
| Head row | "Photographic / lifelike ... consistent with Image 3" repeats the opening lines | 120 |
| Bodies eval | per-cell head question that code always overrides with pose (`applyPoseHeadGate`) | 250 (plus output tokens) |
| Style eval | TASK 4 per-cell colour enumeration: 5,070 output tokens over 8 calls, and it still passed an auburn shift | output tokens |
| Dead | `sheet-2x4-evaluation.txt`, `buildPrompt`, `styled-costumed-avatar*.txt` | ~15,000 |

The pass-2 prompt (1,388 chars) is lean. Its only bloat is the generic "babies, children, teenagers, adults and grandparents" line (~110).

---

## What each eval is shown, and whether that is documented
| Call | Images given | Text given | Withheld | Documented? |
|---|---|---|---|---|
| Heads row (pass 1) | head-row crop only | REQUESTED_OUTFIT | photo, avatar, hair, age | Yes: code comment `:1211-1217` and prompt-inventory `:209`. The reason is that the judge answered head-presence from the reference. No decisions.md entry found. Age withheld without a stated reason. |
| Bodies row (pass 1) | body-row crop only | outfit, costume name, CHARACTER_AGE | photo, avatar, hair | Yes (inventory `:210`, code `:1223-1227`). Head presence is owned by pose (decisions 2026-08-08). |
| Identity (pass 1) | photo + stored standard-avatar head row + head crop | CHARACTER_AGE | body row, hair text, costume | Code comment `:1249-1251` ("user direction"). The inventory says heads-only. **Hair text withheld, reason not documented.** |
| Style eval (pass 2) | photo + pass-1 sheet + styled sheet | REQUESTED_STYLE, CHARACTER_AGE | costume (deliberate), background rule | Costume withheld: code `:1066-1068` and prompt line 10. **No background or divider requirement anywhere, not documented.** |
| Previous sheet (the re-render) | not shown to anything | — | the approved v1 sheet | **Undocumented.** The re-render starts from photos, contrary to the 2026-09-19 wardrobe-variant principle. |

---

## Confirmed by this run vs judgement
- **Confirmed (stored data plus pixels):**
  - S1-1 row-judge echo, 6 of 6.
  - S1-2 style-judge task-text echo and the Kiaan layout miss.
  - The false reconcile causing a full re-render and a Levin identity re-roll.
  - S2-1 rear-turn failures that went unpenalised, and the critic wording mismatch.
  - S2-2 anchor contamination in Kiaan 2 of 2 attempts, and the pencil lines in the anchor.
  - S2-3 head-row crop, with the critic waiver in the prompt text.
  - S2-4 polo collars, with the generator rule found only in dead code.
  - S2-5 painted backdrops and lost dividers.
  - S3-1 age symptom (no recommendation, per the owner ruling).
  - S4 dead code and stale docs.
- **Judgement, not proven:**
  - Downstream harm from S2-3 and S2-5.
  - The grey backdrop raising anchor bleed.
  - Whether the rouge and hair shifts count as defects.
  - The mojibake source.
  - The latency cost of the re-render.

## Reversal flags
- A figure-free style anchor reverses decisions.md 2026-08-12. It needs the owner, evidence and a new decision entry.
- The age symptom falls under `feedback_age_band_clamp_is_fine.md`. Ask only; do not propose.
- Nothing here re-proposes per-avatar colour or trait verification against the photo (`feedback_avatar_colour_check_rejected.md`). The S3-2 suggestion compares pass 2 to pass 1 (consistency), not to the photo.
