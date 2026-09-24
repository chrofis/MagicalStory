# Prod story job_1790107559778_fcmlfa8kn ("Lukas und die siebte Zeile") — diagnosis 2026-09-23

Ran 2026-09-22 22:05–23:21 CH on prod `bdb6e44e` (master 2026-09-20). Staging was 163 commits ahead.
Owner complaints: p10 not night, p8 worse through redos, p7 strangers + invented landmark,
p5/p6 door in the rain, p3 Lukas too big, p1 object behind the boy, most pages fail.

## Clear bugs (tasks/bugs.json, fixed by agents on staging)
- Scene review returned fenced-JSON briefs on p2,3,5,6,7,8,10; `stripSceneMetadata` then dropped
  all Art Director prose (p7 prompt = "Objects:"). Causes p3 scale, p7 strangers, p10 daylight.
- Reader findings from the book audit charged to the NEXT repaired version (p5 v3, p8 v2).
- Cast-0 page with invented figures routed to char-fix 3× with no method flip (p7).
- Uetliberg photo_description_2 wrongly "metal lattice"; plate QC enforced the text over the photo.

## Open design items (BACKLOG.md)
- [x] **Location reference cells are drawn as isolated objects.** `prompts/reference-sheet.txt:5,15`
      ("ONE element in isolation", "no detailed scenes"), no LOCATIONS section; non-landmark
      locations are batched with props (`server/lib/referenceSheets.js` generateReferenceSheet
      ~1209-1223). LOC001 kitchen became a miniature on a plinth, copied into the p1/p3 plate;
      LOC002 door became a free-standing door slab (p2/p4/p5/p6). Cell gate passed both.
      FIXED 2026-09-24 (owner decision): locations get no cell at all; the plate is built from the
      bible text, stored location cells are ignored (decisions.md "Invented locations are TEXT only").
- [ ] **Shared vantage plate carries the representative page's weather/time to every page.**
      `storyJobPipeline.js` repPageData (~4637/4741 staging). p2/p4/p5/p6 plates byte-identical
      with p2's "heavy rain"; p3 got p1's morning light. Page prompt tells Grok to copy the
      plate's light. Related: BACKLOG D18, M1, shared-plate camera decision.
- [ ] **Plate geometry drops sentences > 240 chars** (`server/lib/sceneGeometry.js` ~173
      `if (s.length > 240) continue;`) — p10's "at night" sentence (247) was lost; an action
      clause leaked into the plate geometry instead. `sceneIntent` also carries no time of day.
- [x] **Writer/AD geography: an interior door placed outdoors.** (2026-09-24: arc PLACE rule + panel lens, AD one-place rule — Lab #1444 3/3 panelists flag it, #1451 keeps the two doors apart; decisions.md) Outline beat 4 drags the key
      drawer "outside to try every key on the door"; AD merged the tower front door and the
      reading-room door into one outdoor LOC002. No check catches interior/exterior contradictions.
- [ ] **Semantic judge contradicts the VB reference** (p6 "pliers instead of nutcracker" — the VB
      nutcracker cell is plier-shaped) and **consolidator escalates severity** (reader MAJOR →
      character_identity CATASTROPHIC on p6 v3).
- [ ] **Text refinement runs after images** and rewrote all 10 pages; the audit then compared new
      words against old pictures (p7 "Manuel absent", p9 "Sophie and Manuel not visible").

- [ ] **Scene review deletes a "no figures" instruction.** p7 before: "completely devoid of figures, a silent, empty
      expanse"; after: "a silent expanse" (`[negation_named]` rewrite). An empty page loses its only emptiness statement.

## Page 8
Owner 2026-09-23: v3 (shipped) is the best version — the picker was right; v1/v2 were the
intermediate regressions.
