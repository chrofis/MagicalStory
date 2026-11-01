# Cover outfit decided by code — 2026-11-01

## Why (root cause, owner-approved)
A cover's place and weather are decided by code; its OUTFIT is chosen by the Art Director from
AVAILABLE CLOTHING PER CHARACTER (`clothingResolve.buildAvailableAvatarsForPrompt`), which lists
only the categories the STORY's pages use. A bedtime story often has no legal cover outfit in that
list (a child with only `nightwear`, or a `standard` that is "coat over pyjamas"), so the Art
Director picks pyjamas or invents clothes, and guards added afterwards catch it:
- staging run 5 job_1793520777470_7sgat9ene: back cover in nightwear → story stopped
- staging run 6 job_1793526073039_9nhq3ju59: label day, prose pyjamas → bodysuit outdoors at night
- staging run 7 job_1793531935175_rhdndngoq: Jules had only nightwear → story stopped
- PRODUCTION job_1793542624900_w0aqtk6aj (customer, 20 pages): Ludovica had only nightwear → failed at 60%

## Owner decisions (2026-11-01)
1. Code decides what every cover figure wears; the Art Director only describes it.
2. The cover outfit is the STORY's day outfit (`standard`), not the photo clothes.
3. The story's wardrobe step must ALWAYS give every commissioned character a real day outfit
   (`standard`), with no sleepwear parts. "Going out in pyjamas" (a coat over pyjamas) is not a
   day outfit.
4. Costume stories keep COVER_COSTUME_FACT's rule (costume where the place suits it).
5. The title stays model-painted (baked) with the title-redraw retry (12763e850).

## Plan
- [x] 1. Wardrobe step (prompts/story-bible-from-beats.txt + its critic, the clothing review): every
      commissioned character always has `standard` with a full day-outfit description, even when no
      page uses it; it never contains sleepwear parts. A scene where someone goes out in pyjamas uses
      `nightwear` (with outerwear as worn state / the wardrobe-variant mechanism — check what exists).
      Generator and critic get the same sentence (syncing-generator-and-critic).
- [x] 2. One decider `coverBeats.coverOutfits(...)` → `{name: category}`: `standard`, or the costume
      per COVER_COSTUME_FACT (decide how to make that deterministic or keep it the Art Director's
      choice between `standard` and `costumed:<x>` only — report back if unclear). Throws (loud)
      when a cover figure has no `standard` description.
- [x] 3. Inject into the cover's FIXED fields (`coverFacts` → `jevFixed`, `fixedBlock` shows
      "clothing", plan line names "X wears: <outfit text>") and pin into METADATA (`pinBrief`,
      like `looksAtAll`). Iterate repins from stored `jevFixed`.
- [x] 4. The `standard` sheet exists for every cover figure (register the requirement for covers).
- [x] 5. Render guard: `assertCoverClothingIsDay` → one check that cover clothing equals code's decision.
- [x] 6. Delete the guards that only policed the Art Director's choice: COVER_DAY_OUTFIT_FACT +
      anyNightwear (coverBeats), coverNightwearFindings + `cover_nightwear` (clothingCategories,
      briefChecks), the C3 cover sentence (scene-briefs-all.txt, scene-expansion.txt).
      Re-word: book-review-rules.txt cover line and the `cover_outfit_not_stated` detail.
      Keep: `cover_outfit_not_stated` (Jev prose check), COVER_COSTUME_FACT.
- [x] 7. Tests (rewrite cover-day-outfit, cover-outfit-stated, nightwear-category, covers-as-pages;
      new: decider, pin, wardrobe rule), docs/decisions.md entry superseding the two 2026-11-01
      cover entries, verify.json entry, sibling registry.
- [x] 8. (8b done 2026-11-01, Lab #1791: 16 stored stories, characters without a day outfit 18/60 before, 0/60 after, none with pyjama parts; 8a done 2026-11-01: replay over 60 stored staging stories, 23 lack a standard day outfit for a cover figure; 8b wardrobe prompt on stored bedtime stories not run, paid cap was $0) Validate on stored data: replay the decider + pin over stored stories' covers (free);
      the wardrobe prompt change on stored bedtime stories (agent-as-model or a capped paid replay).
- [ ] 9. Staging story run, then ask the owner before any production push.

## Found on the way (not in scope)
- sceneMetadata.js:989-992 / :1149-1152 silently turns an unknown clothing word into 'standard'
  (a forbidden fallback). → BACKLOG.
- Production job_1793545525778_vccdez10p sat at 5% for 12 min until the customer cancelled; logs rolled off.
