# Story pipeline review: staging @ 6563a70, 2026-11-13 (Fable, read-only)

Done from a cloud session that had no node_modules, DB access or paid calls (USD 0 spent).
Every finding comes from reading the code. CONFIRMED means the path was traced end to end;
PLAUSIBLE means the path exists but the trigger or impact was not fully traced.
Findings 1, 3 and 4 were re-checked by hand against the code after the review.
Nothing here has been fixed yet: each item needs its fix, a regression test and the usual push gates.

## Ranked findings

| # | Sev | Where | Defect | Verdict | Prevention (root cause → cheapest structural stop) |
|---|---|---|---|---|---|
| 1 | High | `server/routes/jobs.js:518-541, 753`; `storyJobPipeline.js:7362, 6837-6845` | The watchdog sets a live job to `failed` and refunds it, but `checkCancellation` only reacts to `cancelled`. The pipeline keeps spending and then saves the story. | CONFIRMED | Two writers own job status with different terminal rules. One `assertJobLive()` check before each paid phase and before `upsertStory`. Note: `failed` was removed from `checkCancellation` on purpose (a transient branch error tripped every slot), so the fix must tell a watchdog kill (e.g. a `refunded`/settled marker) apart from an in-pipeline failure. Unit test: watchdog-settled job → no upsert. |
| 2 | High | `server/lib/clothingResolve.js:616-636`; `server/lib/styledAvatars.js` ("falling back to raw photo"); `server/lib/bookAudit.js:519-538` | The raw-photo fallback is not fixed. The resolver still falls from styled avatar to unstyled avatar to body or face photo, and `buildCastReferenceParts` accepts any `photoUrl`. | CONFIRMED | The resolver returns "some picture" with no type contract. `buildCastReferenceParts` requires `photoType` starting with `styled-` and throws otherwise. CI grep banning `photos.body`/`photos.face` outside the avatar builder. |
| 3 | High | `server/lib/repairPipeline.js:3273` (also `2056`); `server/lib/promptBuilders.js:12813-12833` | The story projection given to the review drops `mainCharacters`. `mainCharactersText` then silently names the first character as "the main character" (`chars.slice(0, 1)`). | CONFIRMED drop; PLAUSIBLE impact | Hand-built projections (third time, see comments dated 2026-09-20 and 09-24). One `auditStoryView(storyData)` builder for both callers; `mainCharactersText` throws when no main is declared. |
| 4 | High | `server/lib/bookAudit.js:381-383, 577-580, 956` | A truncated or unparseable review reply only logs a warning. Zero matched `FAULT` lines reads as a clean book. The prompt asks for `FAULTS: <count>` but no code reads it. | CONFIRMED | Free-text line protocol with no integrity check. Throw when `finish_reason` is not `stop`/`end_turn`, or when the parsed count differs from `FAULTS: n`. Better: structured JSON output. |
| 5 | High | `server/lib/bookAudit.js:254-275, 320-329`; `server/lib/promptBuilders.js:9664-9671` | The painter is told to add passers-by (`population: ambient/crowd`) and given an emotion per figure. The reviewer's BRIEF line carries only cast, outfits and height. | CONFIRMED | Generator and critic read different slices of the brief. Build `briefLine` from the same block the painter gets (population, emotion, cited objects). Register the pair in `sibling-registry.json`. |
| 6 | Med | `storyJobPipeline.js:5413-5416, 6540-6541`; `server/lib/bookAudit.js:211, 830`; `server/lib/bookReview.js:291` | A page whose render and one retry both fail ships without a picture at 100% with no refund. The review's "no page skipped" guard cannot fire, because imageless pages are filtered out before it. | CONFIRMED | Catch-and-continue around a required output. Fail the job (refund) when `missingImages.length > 0`; review compares `pagesRead` with the expected page list. |
| 7 | Med | `storyJobPipeline.js:4058-4064, 5475` | Text refinement runs in parallel with image generation, so briefs and pictures come from pre-refine text (a comment records the refiner rewrote 172 of 178 pages). A refine failure keeps the original text silently. | CONFIRMED order; PLAUSIBLE impact | Freeze text before briefs, or run a free code check after the join (see fault classes). |
| 8 | Med | `storyJobPipeline.js:5941-5952, 5975-5995` | TEXT faults from all review rounds are merged, deduped only by exact line, and applied after the final review. | PLAUSIBLE | Use only the final round's TEXT faults; record that text changed after the last read. |
| 9 | Med | `server/lib/repairPipeline.js:3272-3274`; `server/lib/bookAudit.js:785, 922` | The object-scale pass stays on in book-review mode, runs on Opus in every round and retry; only the last result is surfaced and it triggers no repair. | CONFIRMED | Default-on option inherited by a new caller. `objectScale: round === final`, model pinned to the Flash model it was measured on. |
| 10 | Med | `server/lib/bookAudit.js:90, 99, 114`; `server/lib/sceneBriefCheck.js:475-512, 1008, 1071` | Repair routing and brief findings are decided by regex over LLM prose. | CONFIRMED | Structured review output; closed brief fields instead of prose scans. |
| 11 | Low | `storyJobPipeline.js:7312-7314, 7396-7404, 7416-7425` | Scope, layout and season failures are caught and the job continues; an unstamped layout falls to `textInImage=true`. | CONFIRMED code; trigger not traced | Throw. CI grep for "falling back" in pipeline files. |
| 12 | Low | `server/lib/bookReview.js:193` vs `server/lib/bookAudit.js:836` | Every version is stamped "no reference pictures go to the review", although cast references are sent since 2026-11-13. | CONFIRMED | Derive the row from `review.castParts.length`. |
| 13 | Low | `server/lib/bookReview.js:569` | The "no book ships with a wrong title" stop is skipped when a re-review fails. | CONFIRMED | Run `verifyTitle` on the picked cover unconditionally. |

## Failure scenarios for the top findings

1. **Refund and story.** A job passes 180 minutes, or its heartbeat write stalls for 10. A status poll calls `settleJobWithRefund` (failed, refunded, trial slot released). The worker continues; at line 6837 `checkCancellation()` sees `failed`, does not throw, and `upsertStory` writes the full book. The user has the refund and the story, and every paid call after the kill was spent on a refunded job.
2. **Raw photo as cast reference.** One character's styled avatar fails. `applyStyledAvatars` logs "falling back to raw photo". Opus receives a child's real photograph labelled `CAST REFERENCE` (sent to OpenRouter), judges illustrated figures against it and triggers paid character repairs. The same resolver feeds page render references.
3. **Wrong main character.** A wizard story declares its main by `inputData.mainCharacters` ids; only the trial route sets `isMainCharacter`. The projection has no ids, so the prompt names the first listed character and judges the plot questions and BUY_CRITERION against them.
4. **Silent clean review.** Opus ends with `finish_reason: length` halfway through the fault list. Pages after the cut score clean and are never repaired.
5. **Brief mismatch.** A market page with `population: ambient` renders three passers-by as instructed. The reviewer sees only the cast, reports extra characters, and the pipeline pays for a redraw plus a re-review of a correct picture.

## Why the recurring picture faults get through generation

The brief is already structured (cast, emotion enum, `looksAt`, population, VB citations, required text). Each class escapes at a specific gap.

- **Wrong size (giant cat, unicorn).** Size reaches the painter only as words. SETTLED records that reference cell area does not control size. Creatures are in neither size check: `SCALE_COLLECTIONS = ['artifacts','vehicles']` (`objectScaleAudit.js:118`) and the height line covers story characters only (`bookAudit.js:285-292`). Evidence: BACKLOG lines 152, 182, 1310, 1530, 1545, 1719.
  Fix: a structured height for each VB animal/creature relative to a cast member, compiled by code into the same HEIGHT ORDER line for painter and reviewer; a free post-render detector-box ratio check that re-renders before any Opus call.
- **Missing prop named in the text (wand).** "Page text is not a checklist" is settled, so nothing compares text with brief. The VB budget keeps four elements per page. The text is also rewritten after the pictures (finding 7). Evidence: `tasks/lia-weihnachtsstern-review-2026-11-03.md:15`.
  Fix: after the refine join, a code check (`castResolver.entriesMentioned` over VB labels); an element the final text names and the brief does not cite becomes a TEXT fault or a pre-render brief fix, not a redraw.
- **Extra characters (townspeople).** The prompt asks for them (ambient is the default) and the critic is not told (finding 5). Evidence: BACKLOG 1315, 1368, 1373, 1438; bug `crowd-expected-never-emitted-on-beats-path`.
- **Wrong emotion.** The enum reaches the painter, but the reviewer judges emotion from the words only (`book-audit.txt` question 5); the per-page emotion judge is off in book-review mode. Evidence: BACKLOG 179-181, 1394-1395.
  Fix: each figure's declared emotion in the reviewer's brief line.
- **Inappropriate contact (kiss).** No prompt contains a contact rule (no "kiss" in `prompts/`); `interactions` are free prose.
  Fix: a closed contact enum with code-written wording, one constant shared by painter and reviewer.
- **Action not shown (boy not pushing the car).** Action is prose per character; nothing checks before render that the page's deciding act matches `sceneIntent`. `wrong_action` is then a full redraw (decisions 2026-10-15).
  Fix: a structured `{actor, verb, objectId}` per page from the beat plan, compared by code with the brief.
- **Handwriting as bold print.** The template bans all lettering except REQUIRED TEXT; `requiredText.js` carries the string but no style. Evidence: BACKLOG 284, 1241.
  Fix: a `lettering` enum (handwritten, printed, carved) in the REQUIRED TEXT block and the brief line.

No stored evidence was found for the kiss, wand or car cases specifically; those three rest on code gaps only.

## Cost

- Object-scale on Opus (finding 9): roughly USD 0.1–0.5 per book (estimate, not measured).
- Whole-book re-reviews: about USD 0.4–0.6 per review. Sending only repaired pages to the middle review would save about a third of one review but loses cross-page reads; needs a Lab test.
- Finding 5: each falsely flagged page costs a redraw plus its share of a re-review.
- Finding 1: all remaining spend on a job that was already refunded.

## Action plan (impact / effort)

1. Stop on a watchdog-settled job before paid phases and before save (finding 1). Small.
2. Fail loudly on a non-styled cast reference, truncated review output and imageless pages (findings 2, 4, 6). Small.
3. One brief view for painter and reviewer: population, emotion, cited objects, creature height (finding 5 and three fault classes). Medium.
4. One `auditStoryView` builder, no first-character fallback (finding 3). Small.
5. Free code checks before the review: text-names-element vs brief after the refine join, detector-box size ratios for creatures (finding 7 and two fault classes). Medium.

## Not covered

`beatsPipeline.js` and `textRefine.js` internals; `images.js`, figure detection, `sceneComposite`, cover iteration; the inpaint, iterate and char-fix executors; `upsertStory` and `stories.data` consistency; trial-path and de/en/fr/it drift; `evals/` contents; `docs/decisions.md` was searched, not read.

## Separate: repository exposure (found the same day)

The GitHub repository is public. Tracked files contain the production Railway DB connection string with password
(`scripts/backfill-grok-cost.js`, `scripts/backfill-grok-misattribution.js`, `tests/manual/download-avatars.js`,
`tests/manual/test-gemini-real.js`, `tests/manual/test-real-face.js`), two Google API keys (`index.html`,
`tests/manual/test-gemini-real.js`), customer PII under `inbox/` and `tasks/`, and reference photos. Owner to:
make the repo private, rotate the DB password, revoke the Google keys, check DB access logs; then remove the
secrets from the files (history keeps them, so rotation is what matters).

## Status 2026-11-14 (branch `claude/pipeline-fixes-2026-11-13`, not on staging yet)

| # | Status |
|---|---|
| 1 | FIXED 5e42e242: save gate stops on any non-processing status |
| 2 | FIXED e46e99f7: a real photo is never a cast reference (member left out, logged) |
| 3 | FIXED 5c5a8586: mainCharacters reaches the review (3 drop sites) |
| 4 | FIXED e46e99f7: cut-off or count-mismatched review reply fails |
| 5 | FIXED f8976911: BRIEF line carries the painter's population sentence; Lab check pending (verify `book-review-background-people-brief`) |
| 6 | FIXED 71cab547: missing page picture fails + refunds (owner; supersedes 2026-08-29 for pages) |
| 7 | BY DESIGN: pictures are drawn from briefs written before the text; a failed rewrite keeps the original text, which is the owner's wanted behaviour ("if text is worse we take the old one"). No change |
| 8 | FIXED 5db82b3b: TEXT faults written against a replaced picture are dropped |
| 9 | CHANGED 7ecde23a (owner): review -> repair -> re-review; size check in the first review only |
| 10 | FIXED (owner: plain text): the FAULT/BETTER/count lines are a closed grammar and stay; the one free-text reader, `buildTouchupPlan` picking the edited figure from a name in the sentence, is removed: every touch-up sentence is one scene instruction. JSON output: not worth it. `sceneBriefCheck` population word list remains a candidate |
| 11 | FIXED f9b2f7d2: failed layout/season stamp fails the job |
| 12 | NOT A BUG: cast references are used only to count duplicates; "likeness not checked" is accurate |
| 13 | FIXED 3cfccd26: a failed re-review no longer skips the wrong-title stop |

Still open from the action plan: emotion on the reviewer's BRIEF line, creature height, text-names-element check, contact enum, action spec, lettering style.
