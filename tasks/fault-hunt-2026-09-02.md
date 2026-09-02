# Fault hunt 2026-09-02 — remaining findings (fixed tier shipped in a02726f19)

Three-agent sweep for the five fault classes (silent defaults, name/copy drift,
derived-truth inversion, N-place registration, starved judges). The mechanical
tier — nine fixes — shipped and is documented in docs/decisions.md (2026-09-01
and 2026-09-02 entries). THIS file holds what is still open, so it survives
session context clears. Tick items here AND in BACKLOG.md.

## Awaiting owner decision (design tier)

- [ ] **Raw photo published as 2×4 sheet and cell-cropped** (explained to owner,
  no go/no-go yet). Guarantee seed `styledAvatars.js:~1052` and trial preview
  seed `_seedStandardFromPreview :~1709` leak past the cache-only containment
  contract because the publish leg `getStyledAvatarsForCharacter :~1593` has no
  `guaranteeSeededKeys` filter → `storyAvatars.js` projects it as `styled-standard`
  → `cropAvatarCell` slices a plain portrait as if it had 8 cells. Fix shape:
  register the trial seed in `guaranteeSeededKeys` + filter seeded keys in the
  publish leg. MUST verify first that trial pages still receive the reference
  through the cache path (`applyStyledAvatars`) — if trial reads only
  `styledAvatars`, the filter alone silently drops trial references entirely.
- [ ] **Entity judge's "first appearance canonical / majority wins" feeds a
  GENERATED cell forward as the repair target** — `canonicalVersion` used at
  `images.js:~4623` and `entityConsistency.js:~3082`; a page-1 hallucination can
  get correct pages repainted to match it. Prompt-design change (owner's call).
- [ ] **`scale` means two things**: image-evaluation D-29 uses it for wrong AGE,
  evalBuckets maps `scale → composition_textzone` (repair iterate_placement),
  repairLogic lists it under body form. An age defect routes to a placement
  repair that cannot fix it. Classification → prompt, owner's call.
- [ ] **`spec_conflict`**: `image-semantic.txt:52` mandates a type its own
  closed list (~:108) excludes; in code it falls to bucket `other` → billed 25 +
  routed to regen, though its defined remedy is "rewrite the spec".
- [ ] **Repairs are self-graded** — `repairVerification.js` never sees the
  photo/avatar/clothing spec; a repair that installed the wrong identity is
  marked verified. Also `faceRepair.js` gates check blend integrity only.
- [ ] **No-photo characters**: generated standard avatar becomes the identity
  "photo" that grades its own descendants 10/10 (`styledAvatars.js:~298`,
  `character2x4Sheet.js:~513/~1085`).
- [ ] **Costume/avatar eval fails open in 4 places** (`routes/avatars.js:823-860`
  "benefit of doubt") — deliberate and labelled; owner may want `confidence:
  'low'` to gate something.
- [ ] **VB `extractedDescription` dormant landmine** — write path
  (`visualBible.js:918-1032`) has zero callers but ~20 read sites prefer it over
  the authored description. Recommend deleting the dead pair (or inverting the
  `||` preference).

## Unfixed medium/low (mechanical, no decision needed — just not yet done)

- [ ] Semantic parse-failure coerced to semantic **0** in
  `_buildBreakdownFromEvalResult` (`scoring.js:~606-613`) — "wrong scene" read
  from a page never judged; contradicts decideRepairMethod's null→100 contract.
- [ ] Empty-scene QC catch returns `{pass: true}` (`evalPipeline.js:~467`) — a
  broken plate becomes the page's composition anchor with no retry.
- [ ] `checkForNewArtifacts` errors to "no artifacts" (`repairVerification.js:
  ~345-355`); mitigated by verifyRepairedRegion failing closed.
- [ ] `evalJudges.parseFixableIssues` returns [] for garbage and logs "→ 0
  issues" — garbage indistinguishable from clean (`evalJudges.js:~60-101`).
- [ ] `pageScores[...] ?? 100` makes unscored pages sort HEALTHIEST in
  char-repair budgeting (`repairLogic.js:~76`, `regeneration.js:~5184`).
- [ ] Admin health report shows "0 failures" when the failures query itself
  fails, at log.debug (`adminActivity.js:~134-149`).
- [ ] Trial frontCover stream swallows errors and resolves null — never gets
  the allSettled `_coverType` tag (storyJobPipeline trial path).
- [ ] Registry leftovers: dead Lab prefill `styledCostumedAvatar`
  (admin/testlab.js:~131 — loads a 2x2-era prompt production never sends; an
  unedited run ships literal `{COSTUME_DESCRIPTION}`); dead loader
  `incremental-consistency-check.txt` + stale prompt-inventory row; ~20
  hand-copies of the `{frontCover:-1,initialPage:-2,backCover:-3}` map bypassing
  coverKeys.js (all agree today); ScorecardsPanel SCORER_NAMES missing the
  4.1-4.4 evaluators (label fallback only); `styleConsistency.js:~396` SEV table
  rewrites critical/catastrophic outliers to 'moderate'.
- [ ] Entity two-pass identity call sends the BODY manifest (`cropType: "body"`)
  with the head-grid buffer (`entityConsistency.js:~973/~2488`) — internal
  contradiction in what the judge is told, low severity.
- [ ] Two-witness absence filter cannot check a claim with no `character` field
  (prose-only "X is missing") — one such false positive observed; a structural
  extension (if every expected character was seen, a nameless absence claim is
  unsupported) was sketched but not built.

## Session state at context clear

- Everything through the nine-fix batch is on STAGING (a02726f19 + follow-ups;
  migration 034 applied and verified). **PRODUCTION promotion is pending and is
  the owner's call** — prod was last promoted around the hair_nuance build.
- Lab evidence: #845 (entity verify), #850 (subType chain), #866 (hard-to-segment
  set, separation verdict), #972 (post-fix billing demo, 54 typed findings,
  per-page cap). Set #12 "Hard to segment" = 12 members.
- tasks/bugs.json: hollow-eval-scores-100 registered fixed (a02726f19).
