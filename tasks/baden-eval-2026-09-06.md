# Baden showcase evaluation — open items (2026-09-06)

Source story: `job_1788641639919_mpjwlzkf1` on staging ("Lily and Ethan and the Count of Twenty",
en-gb standard, watercolour, Baden, 14 pages, completed 2026-09-05 23:38 CH on commit 1414c7cc0).
Full report: session scratchpad `baden1/report.html`. Items fixed the same day are not listed
(time-of-day projection f820dfc4e, slot packing 9c08c6b5e, sheet cutout 14aa9d666, AD VB budget).

## Bugs (not yet reproduced as a registry entry — confirm, then move to tasks/bugs.json)

- [ ] **B4 — Duplicate and ghost props undetected.** p3: the red hat is on Lily's head AND lying on the
      cobbles. p12: the hat grows a pompom it has nowhere else. Initial page: Rachel holds the kitchen
      kettle on the riverbank (VB artifact leaked onto a cover). All passed eval at 70–100. No eval
      axis checks prop multiplicity or prop-vs-VB-description drift; the entity check covers people only.
- [x] **B5 (closed 2026-09-06, owner: staging runs one repair pass on purpose; not a bug) — p7 shipped at quality 40 / semantic 20 with two bad versions and no third path.** Lily
      crouches smiling beside a shed instead of hidden in a gap under the Holzbrücke. Both v0 and v1
      ≤40; the repair ladder gave up silently. A page this far below threshold needs a different
      approach on strike three (re-brief / regenerate from the empty scene), not a silent ship.
- [ ] **B6 — Vantage plate white-box failure retried twice, bad plate kept.** LOC001.1 and LOC002.1
      failed empty-scene QC with a 31–35% uniform-white-box artifact, both retries failed, plates kept.
      LOC002 ("the flat window over the square") feeds p2 and p10 — exactly the two pages with the
      wrong tower (baroque spire instead of Stadtturm). Treat the white-box failure as a hard fail
      with a changed prompt, not "keep the first plate".
- [ ] **B7 — diagnose why sanitisation misses standalone-id `preserve` entries.** CORRECTED
      2026-09-06: the claim that `sanitizeVbIdsInPrompt` does not cover the consolidator path is
      FALSE — `feedbackConsolidator.js:458-467` sanitises `instruction`, `fix_draft` and
      `fix_critique` AND maps `preserve` through the same cleaner, since 65d132d06 (2026-08-09),
      and `sanitizeVbIdsInPrompt` handles locations including `LOC005.1` sub-ids. The cleaner IS
      wired; the cause is elsewhere. Original finding: p8 round 1 `scene_fix.preserve` =
      `["LOC006","ART001","ART007","LOC005.1","terrain","skyline","towers","masts",…]` — raw grid ids
      plus the landmark-protection block's own example words. `sanitizeVbIdsInPrompt` does not cover
      the consolidator path. Related: memory `project_cover_vbid_leak_phantom_plate`.

## Improvements

- [ ] **I8 — Pacing budget unenforced.** Standard level asks for 40–80-word quiet pages interleaved with
      120–150-word pages; this book has 111–150 on every page, no breath page. A counter in the
      textRefine shape ("no page under 80 words") is the cheap fix. Same gap as BACKLOG "T9(a)/T10".
- [x] **I9 — Season consistency stated, not measured.** DONE (2026-09-06). The style audit gained a
      season axis on the same grid pass as the time-of-day one: the judge returns `renderedSeason` per
      cell from a closed five-word vocabulary, code compares fields only. `SEASON_DECLARED_MISMATCH`
      (cell vs `resolveSeason(storyData)`) and `SEASON_LOCATION_CONFLICT` (cells sharing a base VB
      LOC id disagreeing) land on `seasonFindings`, guideline semantics mirroring timeFlow exactly —
      reported and stored, never an outlier, never a score, no repaint.
      **Residual gap:** the p3/p5/p6 defect is a within-autumn hue drift (copper vs pale yellow), and
      both read `autumn` at this vocabulary — replayed offline, zero findings on this book. Catching a
      palette drift inside one season needs a separate observation; owner's call, not built.
      → `server/lib/styleConsistency.js`, `tests/unit/season-and-visual-flow.test.ts`, decisions.md 2026-09-06.
- [x] **I10 — "Monday" parsed as an invented character.** DONE (2026-09-06). `collectPlaceNames` now
      also returns the story language's weekday and month names from `Intl.DateTimeFormat` (long +
      short, plus capitalised forms), flowing into `resolveCast` through the existing `placeNames`
      argument — no call-site change. English is always included because the PAGE PLAN is English by
      contract. Replayed over the stored 14-line plan: invented went `["Monday"]` → `[]`.
      → `server/lib/planCounters.js`, `tests/unit/plan-counters.test.ts`, decisions.md 2026-09-06.
- [~] **I11 — Invented children's ages unconstrained.** PARTIAL (2026-09-06) — computation landed,
      wiring BLOCKED. `server/lib/inventedAgeBand.js` (new, pure, 22 tests) computes the commissioned
      child band [min, max] and tolerance [min-1, max+2], renders the prompt line, runs the
      deterministic post-check over `visualBible.secondaryCharacters` (peerhood read as the bible's own
      `peer` field, never inferred from prose), clamps as the fallback (the bible stage is fail-soft
      and has no retry loop), and exposes `secondaryAgeCues` for the image prompt.
      **Blocked:** all three call sites live in files carrying another agent's uncommitted work —
      `buildStoryBibleFromBeatsPrompt` and the `AGE & PROPORTIONS` block in `server/lib/promptBuilders.js`,
      the bible stage in `server/lib/beatsPipeline.js`. The prompt template was left untouched on
      purpose (an unfilled placeholder would leak into every bible call).
      **Verified root cause (c):** the `AGE & PROPORTIONS` block is built from `sceneCharacters` =
      `getCharactersInScene(sceneDescription, inputData.characters)` — the COMMISSIONED cast only — so
      an invented child has never had a head-count proportion cue on any page.
      **Measured caveat:** band [6, 9] → tolerance [5, 11]; CHR001's stated "about ten" is INSIDE it,
      so the post-check does not flag this book. The levers that would have moved it are the injected
      band and the missing per-page proportions cue, both blocked.
      → `server/lib/inventedAgeBand.js`, `tests/unit/invented-age-band.test.ts`, decisions.md 2026-09-06.
- [ ] **I12 — No friend is ever named** in a making-friends book (rival = "the boy in the striped
      scarf", rescued child = "the small girl in the red duffel coat"). Plan-check check 2 flagged it
      three times; it is not a MUST FIX so the re-plan ignored it. Decide whether an epithet-only
      cast on the final page of a life-challenge story should rank must-fix.
- [ ] **I13 — Cost $5.58 vs the $4.2–4.9 baseline**, incl. one wasted scene-expansion batch that
      returned 0/14 briefs and was retried at full output cap. Diagnose the 0/14 (parse failure vs
      empty response) before tuning anything.
