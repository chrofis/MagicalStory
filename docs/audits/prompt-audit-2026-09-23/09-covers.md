# 09 — COVERS: prompt judge findings

## Status 2026-09-23

Checked against staging `31fd7db0c` (after the evening fix round). FIXED = the commit that fixes it; OPEN = no fix yet, no ruling needed to start; OWNER CALL = touches a decision, a SETTLED line or has options the owner picks. Stale-doc and registry items listed at the end of each file were corrected in `a25ecb865` unless listed below.

- FIXED: C1 title erased by title-blind judges — `c9484709c` (the cover text contract is a required-text item in the one `{TEXT_RULES}` block all three judges get; COVER_TEXT replaces the prepended TEXT_RULES; the generator's title block is headed `**REQUIRED TEXT:**`). C2 repair path protecting a painted title — `c9484709c` (the consolidator renders required lettering as never-remove; `inpaintPage` adds the title to its required-text clause when the cover is not restamped). The stale `images.js` comment and image-routing rows — `a25ecb865`.
- OPEN: C3 cover shrink drops REQUIRED CAST / DEPTH AND SIZE while keeping SHOT and non-cover rules, C5 `classifyOverlap` drops an unrelated garment, C6 painted lettering on textless covers excused by the app-overlay note, C7 false entity finding (crop artefact, same class as 08 S7), C8 height order vs age words, C9 one missing prop counted twice, C10 cover layout rules never judged, C11 the root `prompt` holds the inpaint text, C12 reference-card colour rule vs outfits.
- OWNER CALL: C4 backfill fills to 5 even when nothing was dropped; C3 item 3 (touches the 2026-08-26 unified cover template decision).

---
Run: job_1790100385959_1nitlympp "Das Ei im Laub" (staging, built at b03c64b0). Judge: covers group (creation → judges → consolidation → inpaint as one system).

## What I looked at
- All 7 cover images from R2, opened and looked at directly: frontCover v0 and v1, initialPage v0 and v1, initialPageArt, backCover v0, backCoverArt. Local copies and crops are in `lastrun/09-covers/img/`.
- `stories.image_version_meta` shows these active versions: **frontCover = v1**, initialPage = v1, backCover = v0.
- Stored prompts, eval outputs and consolidation I/O are in `09-covers/*`. The `prompt_shrink` events come from `stories.data`'s generation log.
- The quality-judge prompt is not stored, so I rebuilt it. Rebuilt: the run-time template (`git show b03c64b0:prompts/image-evaluation.txt`) + the cover-notes prepend + the stored `compressedScene`. Not rebuilt: the cast, clothing, object and landmark blocks, which are marked as not rebuilt. File: `findings/09-covers.quality_eval.REBUILT_partial.txt`.
- I made no paid calls and no edits.

---

## RANKED FINDINGS

### C1 — CATASTROPHIC, CONFIRMED: the shipped front cover has no title. The judge ordered it removed, and the re-judge passed the titleless cover at 100.
**Pixels:**
- v0 (`frontCover/cover/v0.jpg`) is a strong cover. "Das Ei im Laub" is painted as twig-and-leaf letters in the upper third, spelled correctly.
- v1 (`v1.jpg`) is the same painting with the title cleanly erased.
- v1 is the active version (`image_version_meta.frontCover.activeVersion = 1`).
- `titleBaked: true` is still stamped on the cover, so the stored state is stale. No `frontCoverArt` exists, so no restamp can bring the title back.

**What happened, step by step (all from stored data):**
1. **Generator.** The prompt opens with the shared page preamble (`prompts/image-generation.txt:3`): "No lettering on any surface … **The only exception is a REQUIRED TEXT block below**; with no such block, nothing in the image is lettered." The title arrives in a block labelled `**TITLE:**`, not REQUIRED TEXT (`promptBuilders.js:2321-2323`), at the very end of the prompt. The prompt contradicts itself. Grok painted the title anyway.
2. **What the judges are given as the prompt.** For covers, ORIGINAL_PROMPT / IMAGE_PROMPT = `compressedScene` (`images.js:2524`, `sceneMetadata.resolveEvalSceneDescription`). That is the part of the prompt *before* the protected tail. It contains the "No lettering" preamble but not the TITLE block, because the TITLE block sits in the tail on purpose (the shrink-hazard fix, see memory `project_prompt_shrink_hazard`). The shrink happened on all three covers (C3), so `compressedScene` was set.
3. **Semantic judge (flash).** It is called at `evalPipeline.js:2151-2162` with the raw `originalPrompt` and `textRules: requiredTextBlock`.
   - `requiredTextBlock` is built only from Visual Bible element text (`evalPipeline.js:2030-2052`), so for a cover it is `''`.
   - The cover text contract (`cover-evaluation-notes.txt` TEXT_RULES + COVER_NOTE) is added *later*, at `evalPipeline.js:2318-2364`, and only to `promptForEval` for the quality judge.
   - So the semantic judge never sees the title. It filed `[CRITICAL] rendered_text: 'Das Ei im Laub' … IMAGE_PROMPT explicitly states 'No lettering…' and the TEXT_RULES block is empty` (`10c`).
4. **Consolidator (qwen-plus).** Its "Intended scene description" also has no title (`20a:216`). Rule 1 forbids it from second-guessing a finding, so it produced `scene_fix: "Remove the text 'Das Ei im Laub'."`, score 75.
5. **Inpaint** (`11a`, 91 chars). Grok executed the order perfectly: the title is gone.
6. **Re-judge of v1: quality 100, semantic 100.**
   - The quality judge *does* get the cover TEXT_RULES ("Allowed text missing → CATASTROPHIC"). But that text sits inside `USER_PROMPT "…"`, while template item 11 `TEXT RULES: {TEXT_RULES}` is empty. D-33 says "Skip entirely when TEXT RULES is empty" (`image-evaluation.txt:173` now, same at run time). So nothing in the structured channel asks for the title.
   - The rebuilt prompt shows both side by side.
   - The semantic judge still has no title contract.
   - Result: v1 wins "best".

**Sibling miss:** decisions.md 2026-09-21 (REQUIRED TEXT, ~line 54205) moved page text to one `{TEXT_RULES}` channel "the same shape as the cover mechanism". Covers were never moved onto that channel. The generator preamble changed in the same commit (e025d9fef), and that change is what now contradicts the TITLE block.

**Fixed since b03c64b0? NO. The risk has gone up.**
- 67c617743 rewrote D-23 to name "A caption, **title** … laid over the art — CATASTROPHIC". With item-11 TEXT RULES still empty on covers, the quality judge now has an explicit rule against the title too (my judgement; not yet seen in a run).
- 1d4f1bcf1's undeclared-lettering check is scene-only, with the comment "a cover's title has its own path". That path does not reach the semantic judge, the consolidator or D-33.

### C2 — CRITICAL, CONFIRMED: nothing in the repair path protects a painted title
- `inpaintPage` builds its instruction as `Fix these issues…\n${edit}${preserve}${quietZone}${requiredTextClause}` (`images.js:3487`). The required-text clause is built only from Visual Bible ids (`images.js:3474-3484`), so it never carries the cover title.
- The comment at `images.js:3444-3448` ("Covers render textless … cover inpaint repaints the textless art layer and re-composites the text afterward") is **stale**. Since SETTLED.md:60 (baked title everywhere, 2026-09-06), the front cover has no `frontCoverArt` and no restamp.
- So any inpaint on a baked front cover, even one about a hand, has no instruction to keep the title. Nothing refuses a `rendered_text` fix whose target is the title itself.
- The 91-char prompt had enough context for what it was told to do; it was told the wrong thing.

### C3 — MAJOR, CONFIRMED: shrinking the cover prompts cuts the cast/depth/marks rules and keeps rules that don't apply to covers
Logged `prompt_shrink` events (generation log, the first three IMAGE GEN-ONLY entries, lengths match the stored prompts exactly):

| Cover | Before → after (cap 7,900) | Dropped |
|---|---|---|
| initialPage | 9,849 → 7,764 | COUNTS, DEPTH AND SIZE, HANDS, NO MARKS, **REQUIRED CAST** |
| frontCover | 10,615 → 7,351 | the same, **+ the page `Composition` block** |
| backCover | 9,819 → 7,734 | COUNTS, DEPTH AND SIZE, HANDS, NO MARKS, REQUIRED CAST |

- REQUIRED CAST is exactly the rule that covers the backfilled figures (C4): "A character the scene description gives no action to is still drawn…". DEPTH AND SIZE is the rule that defines the hint's foreground/background positions.
- **Kept instead** (protected tail or head):
  - `**SHOT:**` (~260 chars). Covers declare no shot.
  - The "FIRST reference photo shows a real location" rule (~480 chars). `landmarkPhotos` is null on all three covers. This is my judgement: the grok-ref-0 content was not checked.
  - The duplicated ground/feet bullet in COVER COMPOSITION (~560 chars), repeated from the page Composition block.
- A 4-child cover is 1.9–2.7k chars over the cap every time. This is the prompt-shrink hazard again, now on the cast rules.

### C4 — MAJOR, CONFIRMED: the cast backfill overrides the Art Director's cover casts
- The hint (`04-art-director/03-…cover_hints_section.txt`) gave the initial page **two** children: Levin centre, Julian right foreground holding ART001, "crisp afternoon discovery". The back cover got three.
- `validateCoverHintCast` (`coverIterate.js:650-686`) refills "freed slots", but it fills up to `MAX_COVER_CHARACTERS` = 5 **even when nothing was dropped** (`kept=2`, `cap=5`). It added Max and Kiaan to the initial page and Julian to the back cover.
- Backfilled figures have `position: ''`. The prose then reads "Max, a preschooler little boy, eyes on the viewer." with no placement.
- The count flips `buildInitialPageComposition` to "GROUP scene introducing all the story's characters".
- Pixels: the discovery moment became a four-boy line-up.
- decisions.md 2026-09-06 (~line 35719) says the code "refills the freed slots". The implementation goes further than that decision. This is the owner's call, not a clear bug.

### C5 — MODERATE, CONFIRMED in the prompt: the worn/held dedupe deletes an unrelated garment
- The initial page's Julian line lost "brown ankle boots"; the front cover still has it.
- Cause: the held ART001 is named "brown paper bag of Marroni". The name token "brown" matches the boots segment. A bag has no worn slot, so `classifyOverlap` returns `'duplicate'` (`coverIterate.js:412`: `if (!meta.slot || !segSlot) return 'duplicate'`), and the boots are dropped.
- No visible defect: the avatar carried the boots.
- An artifact with no worn slot can never duplicate a garment. That case should be `'unrelated'`. The sibling-registry "page vs cover worn-vs-held" set applies here.

### C6 — MODERATE, CONFIRMED in pixels: painted lettering on textless covers is excused
- The initial page (v0 and v1) shows a "TAXI" sign, a lettered shop fascia, a triangular road sign with garbled lettering, and garbled letters on the chestnut cart. Neither judge flagged any of it.
- The initial page and back cover are judged in `appOverlay` mode. `cover-evaluation-notes.txt` TEXT_NOTE_APP_OVERLAY says: "if such text IS present treat it as the intended app-composited overlay — never flag it".
- But the eval runs on the **textless** art, before `bakeCoverTypographyPostPersist`. So any lettering the judge sees was painted by the model, never the overlay.
- The letteringCheck (1d4f1bcf1) excludes covers.
- Current D-23 (67c617743) would accept "TAXI" and rate the garbled signs MINOR, but the overlay note overrides it.

### C7 — MODERATE, CONFIRMED in pixels: false entity finding on the back cover (−15)
- The entity check reported `figure_completeness` / `cutout_artifact` on Julian: "jagged white edges and missing regions".
- A crop of Julian (`img/c_bc_julian.jpg`) shows a clean jacket and arm, with no white edges.
- This looks like a measurement artefact (a crop or mask seen as a defect). The back cover was left at 70, with no repair.

### C8 — MODERATE, CONFIRMED: the generator is told two different heights for the same child, and the judge enforces one of them
- Julian, Max and Kiaan are all age 3.
- Julian is written as "toddler little boy (Looks: toddler)", 102 cm. Max is "preschooler", 98 cm.
- HEIGHT ORDER makes Max the shortest, while "toddler" makes Julian read as the smallest. The back cover followed "toddler".
- The semantic judge filed MAJOR `scale` on Max (`backCover/10c`), and that is correct against the height list.
- This comes from the shared character block, not only covers. It fails most visibly on a four-child cover line-up.

### C9 — MINOR, CONFIRMED: one missing prop counted twice
On the initial page v0, "missing paper bag" (MAJOR) and "Julian not holding it" (CRITICAL) are one physical cause. The code score was 60 while the consolidator's own score was 75. The semantic `element` field carries prose instead of an id, so the inpaint had no reference image (`inpaintReferenceImages: []`). The inpaint worked anyway: v1 shows a plain paper bag in Julian's hands.

### C10 — MINOR, CONFIRMED: cover layout rules are never judged
- Covers are told three layout rules: keep the top third open (front), keep the bottom 20% empty (initial page), keep the bottom 10% empty (back). No judge template checks any of them.
- In the pixels, the feet on the initial page and back cover reach about y=0.93–0.94, so both bottom-band rules are broken and unflagged.
- The initial page's bottom-20% rule is sent even with no dedication (`typography.skipped: no-dedication`), so there it protects nothing (bloat).

### C11 — MINOR, CONFIRMED data shape; the risk is my judgement: the cover's root `prompt` is now the inpaint text
`coverImages.frontCover.prompt` and `initialPage.prompt` hold the "Fix these issues…" edit text (91 and 179 chars). Anything that reads the root `prompt` would get the edit text, not the render prompt: `resolveEvalArtStyle(img.prompt)`, the `Paint "…"` regex fallback that recovers expectedText (`evalPipeline.js:2328-2333`), and cover iterate. It would get no title and no style. This is the same class as the registry's `pipeline-page-record-vs-cover-record` note about the root mirror.

### C12 — JUDGEMENT, no defect in this run: the reference-card colour rule contradicts the outfits
`promptBuilders.js:2352` says "Never paint … these colours onto any character, clothing". The frame colours are GREEN, RED, PURPLE and BLUE, while the same prompt dresses the boys in a red shirt, green fleece, purple hoodie and blue shirt. Read literally, it forbids the contract outfits. This is a shared page and cover builder.

---

## Missing (summary)
- The cover text contract does not reach `{TEXT_RULES}` for the quality, semantic or compliance judges, nor the consolidator (C1).
- The generator's text exception names only a REQUIRED TEXT block (C1).
- Inpaint has no title-preservation clause (C2).
- REQUIRED CAST and DEPTH AND SIZE are lost to shrinking (C3).
- Backfilled figures get no position (C4).
- Cover layout rules have no critic (C10).

## Bloat (estimates per cover prompt)

| Item | Chars |
|---|---|
| SHOT block | ~260 |
| Landmark-first-photo rule when no landmark ref (judgement) | ~480 |
| Page `Composition:` block on initial and back: its facing bullet is overridden by "eyes on the viewer", its vessel bullet doesn't apply, its ground bullet duplicates the cover's | ~1,050 |
| Duplicate ground bullet inside COVER COMPOSITION | ~560 |
| Bottom-20% rule on an initial page with no dedication | ~170 |
| **Total** | **~2.0–2.5k per cover** — about the amount the shrink cut from each |

- The consolidator prompt is ~30k chars for a one-finding cover (emotion-grouping, per-character rules and so on). It is shared with pages; I note it but do not ask for a change.

## Improve (generic)
1. **Send a painted cover's `expectedText` through the same `requiredText.js` builders as pages.** That means the `{TEXT_RULES}` allow-list for all three judges plus the consolidator input, the generator's REQUIRED TEXT block (or make the preamble exception name the title block), and the inpaint repair clause. Then remove the TITLE_RULES prepend from `cover-evaluation-notes.txt`. This is one channel, per the `syncing-generator-and-critic` skill. Classification stays in the prompt; no code pattern-matching of the finding text.
2. **Rewrite the appOverlay note:** "the app adds the title/dedication/brand later — never flag it missing; lettering visible in this art was painted by the model and is judged by the normal text rules."
3. **Cover builds:** leave out SHOT and the page Composition block, and keep REQUIRED CAST and DEPTH AND SIZE instead. Either measure that covers fit under 7,900, or rank REQUIRED CAST as a page fact the cut must not drop. Check this against prompt-inventory:192 ("cover built from the SAME image-generation template") before changing it: it is not a SETTLED line, but it is a recorded decision.
4. **Backfill only the slots freed by dropped phantoms**, and give a backfilled figure a position — or ask the owner whether "fill up to 5" is intended.
5. **`classifyOverlap`:** an artifact with no worn slot (bag, egg) → `'unrelated'`.
6. **Scoring:** one cause counts once (a missing held prop plus "not holding it").
7. Add the cover-only layout rules (top third, bottom band) to a critic, or stop sending them.

## Blind spots / what is withheld from each judge
| Judge | Sees | Doesn't see | Documented? |
|---|---|---|---|
| Quality (image-evaluation) | COVER_NOTE plus the cover TEXT_RULES, both inside USER_PROMPT; the part of the prompt before the protected tail (no ART STYLE, no TITLE); item-11 TEXT RULES = '' | the structured title requirement, so D-33 cannot fire | prompt-inventory:134 names only the quality path; the item-11 emptiness is undocumented |
| Semantic (image-semantic) | the same prompt head (with the "No lettering" preamble), cover brief as SCENE_HINT, TEXT_RULES = '' | the COVER_NOTE and the title | **decisions.md ~9392 ("a COVER note tells the fidelity + quality evaluators") is STALE**: the fidelity judge gets no cover note |
| Consolidator (qwen-plus) | the scene description without the title | the text contract | undocumented |
| Inpaint (Grok) | the instruction only; no refs; no preserve list; no title clause | the title, the required-prop reference | the `images.js:3444` comment is stale |

**Stale docs:**
- `docs/image-routing.md:29-30` ("composeCover baked into served version"; plate-pass painted title "Automatic on every new frontCover"; "❌ never let a model SPELL the title") contradicts SETTLED.md:60 (model-baked title everywhere).
- `images.js:3444-3448` comment.
- decisions.md ~9392.

**Registry gap:** `scripts/admin/sibling-registry.json` set `cover-generator-vs-critic` (~line 267) lists only `cover-composition.txt`, `coverIterate.js` and `cover-evaluation-notes.txt`. It omits `prompts/image-semantic.txt` / `sceneValidator.js`, the cover branch of `evalPipeline.js`, `requiredText.js`, and the consolidation prompt. That is exactly the members C1 slipped through.

## Reversal check
- Nothing here recommends reversing SETTLED:60 (the baked title stays). Going back to a composited title would be a reversal, and I do not recommend it.
- SETTLED:59 (cover gaze owned by code) is respected.
- C4 changes how a decisions.md entry is carried out (not SETTLED), so it needs an owner question.
- C3 item 3 touches a recorded decision (prompt-inventory:192 / 2026-08-26 unification), so ask the owner.

## Already fixed since b03c64b0 (28 commits)
- **Nothing cover-specific.**
- 67c617743 (D-23 rewrite) now allows correctly spelled in-world signs such as "TAXI" on scene pages. On covers the appOverlay note still overrides it, and it adds "title" to the CATASTROPHIC list, which makes C1 worse.
- 1d4f1bcf1 and 3d8f4871d (lettering and emotion code checks) are scene-only by design.
