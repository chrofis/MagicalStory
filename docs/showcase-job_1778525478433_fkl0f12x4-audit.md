# Showcase audit — `job_1778525478433_fkl0f12x4`

**Story:** "Das Bild in Emmas Jackentasche" (Berger/DE — Neues Geschwisterchen)
**Style:** Cartoon · **Pages:** 14 · **Pipeline:** unified · **Generated:** 2026‑05‑11

URL: <https://www.magicalstory.ch/create?storyId=job_1778525478433_fkl0f12x4>

## Headline

The pipeline ran clean end‑to‑end (3 repair rounds, char‑fix at the end, pick‑best at finalisation). The big surprise of this run wasn't a pipeline bug — it was a **dev‑tooling lie**: `scripts/analysis/review-page.js` had been reading `scene.activeVersion` from the JSON blob (always `undefined`), so it reported the *last‑pushed* version instead of the actually‑active one. That made it look like pick‑best was choosing strictly worse versions on pp 2/5. It wasn't — pick‑best is correct; the script was lying. Fixed below.

Two real production bugs found and patched. Two genuine quality concerns (no quick fix). Several smaller things logged for follow‑up.

## Per‑page final scores (now corrected)

```
p1   90   p6    0¹   p11   0
p2   40   p7   35    p12  10
p3   50   p8   50    p13  50
p4   95   p9    0    p14  65
p5   30   p10  70    front 80²  initial 100  back 80³
```
¹ Bug 3 — only 1 version generated, repair didn't fire. ² Bug 1 — own title flagged as unrequested text. ³ Garbled background text on the back cover map.

## Bugs fixed in this commit

### Bug 1 — Cover hard‑fail gate reads the wrong `title` source (CRITICAL)

`server.js:5366` was `inputData.title || inputData.storyTitle || ''`. The user never types a title; the unified Sonnet pass invents one at line 3889 (`title = parser.extractTitle()...`). So `inputData.title` is always empty on unified runs, the gate text becomes `MUST include this exact title text: ""`, and Gemini correctly flags the rendered title as "unrequested text". Every unified‑pipeline cover took a MAJOR rendered_text deduction for its own title.

Evidence on this story: front cover scored 80 with one MAJOR — `"Unrequested text 'Das Bild in Emmas Jackentasche' is present at the top of the image"` — that IS the book title.

**Fix:** prefer the local `title` variable (in scope from the parser) when populating the cover eval prompt; fall through to `inputData.title` only when both are empty.

Also extended dedication source to `coverData.dedication || inputData.dedication` for the same reason.

### Bug 2 — `scripts/analysis/review-page.js` shows the wrong active version (HIGH for dev workflow)

The script was reading `scene.qualityScore` and treating the LAST entry in `scene.imageVersions` as active when `scene.activeVersion` was missing — which it always is for unified‑pipeline stories. The source of truth is the separate `image_version_meta` JSONB column on `stories`, written by `setActiveVersion` (`server/services/database.js:2367`).

**Fix:** select `image_version_meta` alongside `data` and resolve activeIdx from there. Display per‑version source label + finalScore at the top of the active summary.

Verified: p2 now correctly reports `v1 (iterate-round-1) finalScore=40` instead of `v2 (char-fix-round-3) score 0`.

This was the bug that caused me to draft a false "pick‑best is choosing worse versions" report. Worth flagging in case the same misread bit anyone else in past sessions.

## Genuine quality concerns (proposals, not patched)

### Concern A — `p11` reaches end of pipeline at finalScore 0 (HIGH)

All three p11 versions scored 0:
```
v0 original             qual 0 (50−50 entity penalty)
v1 iterate‑round‑1      qual 0
v2 iterate‑round‑2      qual 0 (50 entity penalty again — active)
```

Scene description packed Noah + Emma + Daniel onto the Holzbrücke railing with declared interactions ("Noah grips railing, gazes upstream", "Emma grips railing, gazes upstream", "Daniel hand on railing, behind them"). Every version painted at least one character facing the camera. The eval's CRITICAL rule on declared‑interaction violations couldn't be cleared in three rounds because the model literally cannot render two children + adult on a narrow bridge railing all in matching pose without one of them turning to camera.

**Proposal:** for declared‑interaction scenes with 3+ characters all interacting with the same object on the same axis (railing, table, balcony), the scene expander should drop the interaction declaration on at least one character — let one face the camera and only enforce the gripping pose on the others. Cleaner: pass the character count into the prompt and have Sonnet collapse some interactions when 3+ characters share one object.

### Concern B — `p9` and `p12` also unsalvageable; pattern is "everyone interacting with one object"

Same shape as p11:
- p9 (4 versions, all 0) — railing + view scene
- p12 (4 versions, best = 10) — gathered around an object

Iterate‑round attempts often score 0 with MORE issues than the original. Each new render adds a new failure (clothing drift, character misidentification). When iterate keeps producing 0‑score versions, the budget is wasted and the user sees the worst‑attempted of many bad images. The pipeline already has `bothStrategiesTriedAndRegressed` to skip after both methods failed — but `iterate→iterate→iterate` without crossing to char‑fix at any point means we never even get the regression detector to fire.

**Proposal:** after Round 1 if iterate didn't improve the score, force the next round to use char‑fix (or skip) instead of running iterate again. Same primitive twice = cargo‑culting; the regression detector already understands that pattern across methods.

### Concern C — `p6` got only 1 version (MEDIUM)

`p6 score=0 issues=2 src=original — only 1 version produced`. Both issues were MAJOR facing_direction. Visual score was 0, threshold is 60, repair should have fired. Either:
- p6 didn't land in Round 1's bad‑page list (some upstream check skipped it), or
- the repair budget allocated to other pages spilled past p6

Without fresh Railway logs I can't confirm. Need to download the run's log.

**Proposal:** when a page has finalScore ≤ threshold AND no repair was attempted, the finaliser should log a loud `[BUDGET-SKIP]` warning, so the next analysis catches this silently. Right now there's no trace that p6 was *known to be bad and not repaired*.

### Concern D — Back‑cover map shows garbled text (MEDIUM)

`backCover score=80 — Garbled text 'ONTO NAY', 'EBIHUANGE', 'ERGUPEM' and other unreadable text is present on the map in the background.`

The story features a treasure‑map artifact (`ART002 - Erste Schatzkarte`) and the back cover renders it with fake garbled text — both Grok and Gemini tend to fill map decorations with plausible‑looking but nonsense lettering. The eval correctly flags this MAJOR, but we don't do anything with it. Options:
- Add a `no garbled text on maps/signs/books` rule to the cover prompt explicitly
- Severity demote: garbled text on a *decorative background prop* shouldn't be MAJOR; recolour as MODERATE in the cover eval gate (similar to the "items outside the crop" rule we already added)

I lean toward the cover prompt change — clearer signal at generation time, which prevents the issue rather than just down‑weighting it.

## Smaller observations

- **Run cost (DB‑sourced):** can't confirm without fresh Railway logs; total cost unavailable for this audit.
- **Repair‑round attrition** was: Round 1 = 12 bad pages → Round 2 = 5 → Round 3 = 3. Normal shape.
- **Cartoon style:** rendered consistently across covers + interior. The accordion‑hidden category did work after the spec fix.
- **Showcase auto‑advance worked:** rotation bumped from 2 → 3 on first successful run. Next default is now index 3 (Berger dinosaur comic).

## Action summary

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Cover title source bug | **fixed** | server.js:5364 |
| 2 | review‑page.js wrong active version | **fixed** | scripts/analysis/review-page.js |
| A | p11 unsalvageable: 3+ chars sharing interaction | proposal | scene-expansion / Sonnet rule |
| B | iterate→iterate→iterate cargo‑cult after no improvement | proposal | repairLogic.js |
| C | Silent budget‑skip for bad pages | proposal | finaliser log line |
| D | Garbled text on map background | proposal | front/back‑cover prompt |
