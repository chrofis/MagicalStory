# Reader MAJOR admitted to repair; wrong_action routed to page redo (2026-10-15)

Owner decision (Option 1, 2026-10-15). Evidence: prod `job_1792078014622_uh8tj6ht1` p5 shipped at 83 with a MAJOR reader-only finding (gull flying, text says hopping); `findBadPages` never admitted it. Historic fix rate of MAJOR `action_interaction` after inpaint: 56/241 (23%).

- [x] A. `findReaderMajorFinding` + READER RESCUE arm in `findBadPages` (any type, `sources` includes `reader`, severity MAJOR+), still under `applyRoundCap`.
- [x] A. `AUDIT_ADMIT_SEVERITIES` gains MAJOR (final audit admission, extra round).
- [x] B. New finding type `wrong_action` (a different KIND of action than the brief states). Own bucket in `evalBuckets.js` (not in the facing/gaze/pose merge, so SETTLED "facing/gaze/pose -> inpaint" is untouched), `CONSOLIDATED_TYPES`, `MAX_SEVERITY_TYPES` (major), `NOT_INPAINTABLE_TYPES`, `ITERATE_ROUTED_TYPES` (gate 2d -> iterate).
- [x] B. Prompts: `image-semantic.txt` (closed list + rule), `book-audit.txt` (type definition; the list comes from `CONSOLIDATED_TYPES`), `feedback-consolidator.txt` (closed list, keep-own-type, rule 7 wording).
- [x] Tests: `tests/unit/reader-major-regen.test.ts`; `final-book-audit-round.test.ts` updated.
- [x] Free replay over the last 40 prod stories: `scripts/analysis/replay-reader-major-admission.js`.
- [x] Paid validation (cap USD 1): `scripts/analysis/validate-wrong-action-iterate.js`.
- [x] Docs: decisions.md, image-routing.md, codebase-guide.md; verify.json entry `reader-major-regen`.

Finding while building: the p5 consolidator records show NO `requires_char_fix_not_inpaint` drop for the gull (drops were "capped at 3, defer to next round"; round 2 set `requires_regeneration: true`). Creature fixes therefore got no separate code change; rule 7 now says wrong_action is a page redo, never a character repair, creatures included.
