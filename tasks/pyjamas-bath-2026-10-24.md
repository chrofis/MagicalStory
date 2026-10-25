# Pyjamas (nightwear) and the bath-time retirement, 2026-10-24

Trigger: prod showcase job_1792859316244_6429d0n83 (going-to-bed topic). Bath pages p4/p5 and the bed page p10 drew
children in the day outfit, rain boots in the tub. Only `standard` and `costumed` exist; Art Director rule C3 allows a
change for sleep but there was nothing to change to.

Owner decisions (AskUserQuestion, 2026-10-24):

- A. No bath at all. `bath-time` retired. Bedrooms and bathrooms stay allowed (the earlier ruling out a general
  safe-settings ban, decisions.md ~37162, is not re-added).
- B. `nightwear` is a third canonical outfit category. Anyone the plan puts in bed (child or adult) wears it on those
  pages; an adult at a bedside stays dressed. Covers always show the day outfit; `primaryClothing` never becomes
  nightwear. A failed sheet: retry once, then fail the book like a missing costume. Trial: typed topic id
  `going-to-bed` draws a nightwear sheet at prepare-title.
- C. Defaults (no objection): bath-time URL 301 to `/themes/life-challenges`; Swiss thermal-pool ideas stay; an
  unknown or retired life-challenge topic is rejected by name; the wizards ignore an unknown `topic` URL param.

Decisions logged: docs/decisions.md "Nightwear is the third outfit category" and "The bath-time topic is retired".

## Part A: bath removal (done)

- [x] client/src/constants/storyTypes.ts entry, `trialLifeChallengeIds`, comments "five" to "four"
- [x] shared/topic-age-windows.json, server/lib/seoMeta.js, client themeContent/bath-time.json deleted
- [x] prompts/life-challenge-guides.txt `[bath-time]` removed, going-to-bed guide "pyjamas, teeth, story, goodnight";
      adventure-guides.txt bath line; first-words.json "the bath" in en/de/fr/it
- [x] tests: trial-age-appropriate-topics (63 / 25 / four infant topics), pattern-seeds, teaching-guide-parser (63,
      206), age-band (55), beats-category-guidance, coping-strategy-and-page-openings, theme-costume-rule
      (sample topic first-foods), client-wizard-story-type (deep-link fixture topic must be a real id)
- [x] Risk test "fills all six tiles at every age 0-12": PASSES (45/45 in trial-age-appropriate-topics)
- [x] Stored bath-time stories: prod 0, staging 0 (stories and story_jobs), read-only SELECT
- [x] 301 redirect (server.js LEGACY_REDIRECTS); unknown topic rejected at job create, trial create/ideas/prepare-title,
      both idea routes, `buildStoryContextFields` (Lab replay builders); `knownDeepLink` in the wizards

## Part B: nightwear (done)

- [x] B1 one vocabulary: `CANONICAL` gains `nightwear`; `NIGHTWEAR`, `NO_STAND_IN_CATEGORIES`,
      `PLAIN_SHEET_CATEGORIES`, `DAY_CATEGORIES` exported; every hard-coded two-word list reads them (outlineParser
      shared + unified, sceneMetadata x2, promptBuilders isCategory + parseClothingReview regex, wardrobeVariants,
      storyAvatars x3, styledAvatars buckets / export / fuzzy match, clothingResolve parseClothingCategory,
      bboxDetection). `entityConsistency` `: 'standard'` defaults after a costumed test reviewed: the three
      (onlyHasCostumed fallback, buildClothingDescription, clothingContext) are generic or day-only. Sibling set
      `clothing-category-vocabulary` registered.
- [x] B2 sheet generation reuses `prepareStyledAvatars` (redress, kind `costume`); a nightwear category with no
      description is skipped loudly; no stand-in in `getStyledAvatar`, `resolveSheetForRef`, the repair lookup and the
      trial render guard; `MissingRequiredCostumeSheetError` generalised (`categories`), retry = early pass + final pass.
- [x] B3 `NIGHTWEAR_DEF`; bible writer bullet + schema example; `CHILD_TOP_DEF` wording
- [x] B4 clothing-review checks 6, 9, 10; merge through the shared `acceptAddedWardrobeCategory` (pipeline + Lab)
- [x] B5 Art Director C3 / rule 10 / `clothing` field in scene-briefs-all, scene-expansion, scene-iteration,
      scene-iteration-free; `WORN_ITEMS_ROW_RULE` sentence; covers never nightwear (reconciler, primaryClothing via
      `dominantDayCategory`, `assertCoverClothingIsDay` on full-story cover pages)
- [x] B6 evaluators: the page's expected outfit text comes from the page category, so nothing deducts a pyjama page as
      "not the story outfit" (book audit and repairs read `resolveRenderedClothingCategory`); `clothing_incomplete`
      asks no footwear of a pyjama page. D-05f `child_torso_uncovered` unchanged (the pyjama rule keeps the torso covered).
- [x] B7 trial: `getTrialNightwear` (typed id), prepare-title draws the sheet, job requirements + early styling group,
      pages writer offers `nightwear`

## Free validation done (USD 0)

- Unit suite: see the review below.
- Stored-data replay (80 stories, 40 prod + 40 staging, 8428 page-character cells): `resolvePageClothingCategory`,
  `resolveSheetForRef`, `projectStoryCharacterAvatars`, `getCharacterPhotoDetails` byte-identical before (HEAD) and
  after. Script: scratchpad replay.js (read-only SELECT).

## Not validated (needs the owner's go): priced paid-validation plan

Nothing below was run (hard cap USD 0). Total about USD 3.20. Each is a replay of ONE changed stage over stored
inputs, per the iron rule (a set of at least 20, positives and clean negatives, a rate).

| Replay | Stage | Set | Price |
|---|---|---|---|
| Wardrobe writer (story-bible-from-beats) | does it mark `nightwear.used` for exactly the people the plan puts in bed (children and adults), and no one else; schema key present | about 25 stored stories: ~10 with a bedtime plan (going-to-bed and sleepover-like plans), ~15 without (must give `nightwear.used: false`) | about USD 1.15 |
| Wardrobe review (clothing-review) | check 9 adds a missing nightwear entry for a bed page; check 6 accepts pyjamas without shoes; no false adds on non-bedtime stories | the same 25 bibles, review pass | about USD 0.25 |
| Art Director (scene-briefs-all) | bed pages carry `clothing: nightwear` and name pyjama top and bottoms; pages after a plan line that dresses them for the day return to day; covers never nightwear | about 10 stored bedtime stories (all pages) | about USD 1.00 |
| Pyjama sheets (oneCallSheet, kind costume) | the sheet judge accepts two-piece pyjamas with a covered torso on children and adults of every age band | pyjama sheets for at least 20 stored characters (mixed ages and sexes), each judged once | about USD 0.80 |

Report as rates (n of N). If the bible writer's nightwear marking is below about 90% on the positives or above about
5% on the negatives, the decision's "Revisit if" applies (typed in-bed flag on the plan line instead of a prose rule).

### Paid validation run, 2026-10-25 (three of the four replays; pyjama sheets not run: no working xAI/Gemini key)

Spend USD 1.67 of the 2.60 cap (63 calls; ledger and raw outputs in evals/runs/2026-10-25_nightwear-text-replays/, results.jsonl has one line per stage).
Keys came from the owner's key file at runtime. Prompts were built by the real builders over stored plan lines.

**The planned sets could not be filled.** Only 2 stored stories put anyone in bed with plan lines (prod going-to-bed
job_1792859316244_6429d0n83 and job_1791918618204_ssjxzvmp4); no story in either DB is a sleepover; no stored plan has an adult in bed
or a plan line that dresses someone for the day. Two more positives (Lily and the Sunken Shell, Der Fussball vor der Tuer) exist only
as prose, so their beats are reconstructed from the pages (flagged contaminated); Danilo (daytime hospital bed) is ambiguous and not scored.
Rates below are therefore over 4 persons in 4 stories, not 10 stories.

| Replay | Result |
|---|---|
| Writer, positives (3 samples each) | 12/12 intended persons marked (Lea x2, Lily, Noah). Over-marks: Jules 3/3 in 6429 (at the bedroom door in the bedtime routine; the plan does not put him in bed or pyjamas), Emma 2/3 in the Fussball story (prose-reconstructed input) |
| Writer, negatives | 0/72 characters marked, 15/15 stories clean; nightwear key present on 89/89 characters |
| Review check 9, stored pre-nightwear bibles | adds Lea nightwear x2 and Lily = 3/3 evaluable; Noah story not rebuildable (no used outfit stored); Danilo (daytime hospital bed) also added, ambiguous |
| Review, false adds on negatives (writer bibles) | 0/15 |
| Review check 6 | pyjamas without shoes stated complete 3/3; in Lily the reviewer still rewrote the nightwear text only to drop "bare feet" (churn) |
| Art Director, bed pages | clothing nightwear 6/6 (2 bed pages x 3 samples); covers never nightwear 33/33; 0 nightwear in 62 negative story pages |
| Art Director, bed page names pyjama top AND bottoms | **0/6.** 6429 p10 says "purple pyjamas" (3/3); ssj p14 names no pyjama in 2/3 and "red flannel pyjamas" in 1/3. Other nightwear pages of the same books do name top and trousers (e.g. ssj p4, p7; 6429 p8) |
| Art Director, day page after a dressing line returns to day | not testable (no stored dressing line) |

Threshold: writer positives 100% (>= 90%), negatives 0% (<= 5%): the decision's Revisit-if is not triggered on this data, with the
caveat that the data has no adult in bed and only two plan-line stories. Open from this run: the bed page itself does not name the
pyjama garments (the clause in scene-briefs-all rule 10), probably because the duvet covers the body; whether that matters for the
drawing is for the owner (not added to BACKLOG.md: shared registry).

## Left for the owner

- docs/SETTLED.md: not edited (needs sign-off). Proposed refresh: if a line lists the clothing categories as two
  (`standard`, `costumed`), it should read three (`nightwear` added 2026-10-24); no existing line mentions bath-time.
- Human check of a real going-to-bed story: tasks/verify.json entry `nightwear-bed-pages`.

## Review

- Commits: 97b2d4e46 (bath-time retired), 82ca574ea (nightwear + unknown-topic rejection), then the docs commit.
- Full unit suite after the last code change: 832 files, 9270 tests, all pass (`npx vitest run tests/unit`). One earlier
  run showed 10 failures in idea-guide-shape.test.ts while another vitest process ran in the same tree; the file passes
  alone (16/16) and in the final full run.
- Client typecheck (`tsc --noEmit -p client`): clean.
- Existing tests whose pinned numbers moved with the change (not weakened): winter-summer CANONICAL now three,
  planner-review WARDROBE_RULES ten, age-band 55 windows, trial-age-appropriate-topics 63 / 25 / four infant topics,
  teaching-guide-parser 63 / 206, client-wizard-story-type deep-link fixture uses a real topic id (a retired or unknown
  topic is now dropped by design).
- Found along the way, not changed: `getCharacterPhotoDetails` for a base-avatar request of a category with no avatar
  falls to the raw body photo (clothingFallbackOrder has no entry for nightwear); the story run never reaches it for
  nightwear because the final coverage pass fails the book first, and the trial render guard refuses the photo.
- Not changed on purpose: characterPhotos.js (`normalizeAvatarsForResponse` and the avatar slot lists are generic and
  handle a `nightwear` styled key), database.js strip/persist (generic category regex), avatarSlides.js (a pyjama sheet
  becomes a waiting-page slide of a bedtime trial, which is fine).
