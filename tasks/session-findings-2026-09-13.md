# Session findings — 2026-09-13

Written at the end of the 2026-09-13 session so nothing open is lost when the context is
cleared. **No code or prompt changes were made while writing this.** Every file:line pointer
below was re-checked against `staging` at `ae05f18b6`; where a line number in the session's
own notes had drifted, the corrected one is given and the drift noted.

Motivating story throughout: staging trial `job_1789296188291_thezv15y1` (de-CH, Rohrdorf).

---

## 1. The wrong-landmark plate — UNFIXED, and the main one

**What it is.** In `job_1789296188291_thezv15y1` both covers render the real **Kirche
Rohrdorf** — recognisable silhouette, correct tower. All **six interior pages** render a
*different*, generic gothic church with a graveyard that does not exist at the real site.
The book therefore shows two different buildings for the same named place.

**Root-cause chain (all four links verified in code; the render evidence is the six stored
page images plus the two covers):**

1. **The page call drops the landmark photo by design.**
   `server/lib/grok.js:1321`
   ```js
   if (landmarkBuffers.length > 0 && !hasSceneBackground && slots.length < maxSlots) {
   ```
   The comment above it (`:1315-1320`) states the assumption outright: *"When a scene
   background already exists, the landmark is assumed to be baked into it (the empty-scene
   gen path uses the landmark as input) and we skip."* On a page call the plate holds slot 0,
   so `hasSceneBackground` is true and the real photo is never packed. **Everything the page
   knows about the landmark comes from the plate.** Confidence: certain (code-read).

2. **The plate call really does get the photo, as pixels, plus a strong fidelity block.**
   - Trial plate call: `storyJobPipeline.js:2155-2181` — `bgLandmarkPromise` →
     `emptySceneLandmarkPhotos` → `generateImageOnly(..., { landmarkPhotos })`.
     (The session note said `:2123`; that line is the `landmarkPromiseByPage` build a few
     lines earlier. Same path.)
   - Full/vantage plate calls: `storyJobPipeline.js:4476`, `:4558`, `:4805`, `:4887`.
   - Fidelity block: `promptBuilders.js:731` `buildLandmarkFidelityBlock()`, body at
     `:736-744`. It names the landmark, says *"The attached reference photo shows this exact
     real-world landmark"*, and demands the silhouette be preserved.
   - `prompts/empty-scene.txt` independently instructs that the photo defines structure.
   Confidence: certain.

3. **The model disobeyed anyway.** Zero of the real silhouette survived across six plates,
   while the *cover* path — which packs the photo directly — got it right. So this is model
   obedience on the plate call, **not** a wiring fault. Confidence: high. The cover-vs-page
   contrast is the strongest single piece of evidence, because both paths ran on the same
   story with the same photo.

4. **Already known, and one prompt pass has already failed to move it.**
   `storyJobPipeline.js:2050` area carries the standing comment about this; `docs/decisions.md`
   task #34 is the logged entry. A prose-strengthening pass did not change the outcome.

**Nothing detects it.** The empty-scene QC (`server/lib/evalPipeline.js`, pixel phase to
`:427`, Gemini vision phase `:429-527`) asks five things: people/figures present, setting
mismatch, content errors, character-placement clearance, composition geometry, plus an era
check. **There is no landmark-identity question** — nothing asks "is this the building in the
attached photo?" Re-read 2026-09-13; confirmed absent. A failing plate passes QC silently.
Worse since `bc8c55dd6` grouped plates by vantage: **one bad plate now covers a whole page
group**, which is exactly how six pages failed together here.

**Candidate fix already shipped but UNPROVEN.** `286086573` added `referenceKind` to the
trial plate call (`storyJobPipeline.js:2177`). The trial plate previously omitted the
"the attached reference image IS this place" REFERENCE line that full plates get
(`server/services/prompts.js:563`). That is a real asymmetry and it is now closed — but **no
run has happened since**, so whether it fixes the wrong building is unknown. Do not record it
as a fix.

**What a real fix would involve** (none of this is built; listed as shape, not a decision):
- *Detection first*: add a landmark-identity question to the empty-scene QC vision phase,
  attaching the reference photo alongside the plate. Cheap, and it converts a silent failure
  into a retry. This is the piece the author of this doc would do first.
- *Or* relax the `grok.js:1321` skip so a page whose plate carries a real landmark still gets
  the photo as a reference slot — costs a slot, and slots are capped.
- *Or* accept plate unreliability and route landmark pages through the cover-style direct
  path. Largest change.
Each is an owner decision; the prompt-vs-code rule applies (classification in the prompt,
ceilings in code).

---

## 2. Text–image contradictions, unlogged and undetected

**What it is.** In the same story the chestnut husk is drawn **open** on p1 and p3 where the
page text says it is `fest verschlossen`, and drawn **closed** again on p6 where the text has
it open. **3 of 6 pages contradict their own text** on a single object's state.

**Why nothing caught it.** Trials run with `skipQualityEval: true` and
`enableFullRepair: false`, so real `/try` users receive images no evaluator has looked at.
Independently of the trial shortcut, **no eval check compares a declared object STATE in the
page text against the rendered image** — the semantic evaluator scores presence, placement and
interactions, not state transitions across pages.

Adjacent, already-open item: `tasks/vb-object-states-2026-09-06.md` covers VB object states on
the authoring side. This finding is the *render/eval* half and is not the same item.

**Confidence.** Certain on the observation (the six images and the six page texts are stored
on the job). Untested on the remedy.

**What a fix would involve.** A state field that the Art Director already declares would have
to be compared against the visual inventory pass — `evalPipeline.js` P1 already returns
`objectMatches` (`:298`), so the raw material exists; the missing piece is a per-page expected
state and a finding type. Note the "new scored type = 5 sites" rule
(`feedback_new_scored_type_checklist`): vocab, scoring tables, evalBuckets, consolidator,
subType. Also an owner call whether trials should score at all — they are deliberately cheap.

---

## 3. Everything shipped on 2026-09-13 is unverified by a live run

All of the below is on `staging` only and **has never been exercised by a generated story.**
Today's date resolves to **autumn**, which is precisely the reproduction case for the footwear
and seasonal items — so a single `/try` run (~$0.63) would exercise most of this list at once.
No such run has been made. (A run needs owner mandate; this is a record, not a request.)

| Commit | What shipped | What a live run would confirm |
|---|---|---|
| `6643fef69` | Avatar reference sheet states the figure is shod | The sheet renders shoes; no barefoot avatar in an autumn story |
| `bc8c55dd6` | Trial: one backdrop plate per vantage, not per page | Plate count drops to the vantage count; pages in a group share one canvas; **and** that a bad plate's blast radius is what item 1 predicts |
| `286086573` | `referenceKind` on the trial plate call (8 plate sites total carry it: `storyJobPipeline.js:2177,4476,4558,4805,4887`, `coverIterate.js:1775`, `images.js:4076`, `testlab.js:666`) | Whether the REFERENCE line changes the wrong-building outcome — see item 1 |
| `c936e1d06` | Plate prompt / refs / `vantageId` persisted | The stored page rows actually carry `emptySceneGrokRefImages`, the plate prompt and the vantage id, so a future failure is diagnosable from stored data instead of a rerun |
| `2548bcc36` | Beats Art Director is told the season | The brief mentions autumn conditions; the render follows |
| `d3771bf2c` | Trial avatar sheet drawn for the story's season | Autumn wardrobe on the sheet rather than whatever the photo wore |
| `3175f451b` | The available-landmarks list is the only licence to tag a real landmark | No `isRealLandmark` entry that is not in the supplied list |

Related and already on the backlog, do not duplicate: the `stagedRealLandmarks` flag-count
item (`storyJobPipeline.js:2628`) — it is the *code* half deliberately left out of
`3175f451b`.

---

## 4. Five age bands unrun

The age-band work (2026-09-04, five whole-year bands) has been exercised for **age 3 only**.
Unrun: **ages 1, 2, 4, 5, and an 8-or-12 control.**

- Characters and photos already exist: account `demo-agebands@magicalstory.ch`, family
  `agebands`, photos in `tests/fixtures/demo-photos/agebands/` (14 faces on disk: Ava, Clara,
  Elias, Ingrid, Kian, Marek, Mia, Naomi, Nora, Omar, Rohan, Samuel, Tobias, Zara).
- Only age 3 has a rotation entry: `tests/helpers/trial-rotation.json:84-93` — index 6, Omar,
  `"Agebands/DE — Omar (3), Abenteuer, freies Thema — Altersband 'tries'"`.
- **The trial flow cannot use saved characters.** Each age therefore needs its *own* rotation
  entry pointing at that age's photo; the existing account does not shorten the run.
- Cost: ~$0.63 per run, so ~$3.15 for all five. Needs an explicit mandate.

Confidence: certain on the state (files read today). The cost figure is the standing trial
estimate, not re-measured this session.

---

## 5. The barefoot-reference edge case — RECORDED DECISION, not open work

`buildFootwearRule` falls back to **"plain everyday shoes"** when neither the reference photo
nor the outfit shows footwear, and permits bare feet **only** when the outfit names them. A
child photographed visibly barefoot would therefore get shoes added to the avatar.

**Owner decision (2026-09-13): leave it. Revisit only if it is seen in a real story.**

This is written down here so it is not re-discovered and "fixed" by a later session. It gets
**no BACKLOG line** — the backlog is for open work, and this is settled-until-observed. If it
is ever seen in a real story, that observation is the new item.

---

## 6. `tests/trial-showcase-state.json` is uncommitted, and was overwritten

`git status` shows ` M tests/trial-showcase-state.json`. Current content:

```json
{ "nextIndex": 0, "lastRunAt": "2026-09-13T10:43:08.626Z", "lastEntry": 6 }
```

This session's showcase run wrote `nextIndex` / `lastEntry` **over a value another session had
already set** in the shared working tree. The file was deliberately NOT committed by this
session (shared-tree discipline: stage only your own explicit paths).

**Action for whoever owns the other session:** check whether your rotation position was lost
and restore it from your own side before the next showcase. Nobody should commit this file
blindly — committing the current value would make one session's position authoritative for
everyone.

Confidence: certain that the file is modified and uncommitted; the identity of the other
session and the prior value are **not** recoverable from here (the file is untracked-in-content
terms — the prior value existed only in the working tree). This is the concrete instance of the
standing `feedback_shared_tree_discipline` hazard.

---

## Cross-references — already on BACKLOG, not re-filed here

- `stagedRealLandmarks` counts the FLAG, not a successful resolution →
  `storyJobPipeline.js:2628` (added earlier today).
- The trial photo upload does not ride out an analyzer restart; owner decision **log only, do
  not fix** → `server/routes/trial.js:1959`, `server/routes/photos.js:15,55` (added earlier
  today).
- Season-appropriate clothing, 6 open questions → `tasks/seasonal-clothing-2026-09-13.md`.
- Trial prompt parity, four ported rules unmeasured → BACKLOG "Verification pending".
