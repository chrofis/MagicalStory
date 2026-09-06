# SAM + clothing tasks (user directives 2026-07-20)

## STATUS 2026-07-20 (evening)
- T1/T2/T3 DONE + pushed to staging (e2cddd58). T5 answered (ordering is correct).
- Remaining: T4 (Test Lab SAM view), T6 (clean run to validate redress + reject rule).

## SAM / detection
- [x] **T1 — Reproduce + SHOW SAM outputs** — box-prompt SAM on Sarah init-page / Hans / Noah,
      overlays + local view `scratchpad/sam-outputs.html`. Analyzer restarted locally (MobileSAM).
      Caveat: run on latest image version, so dramatic blowouts were milder (version-specific).
- [x] **T2 — Connectivity analysis** — Sarah: 5 comps (specks) + mask 23% over box → validates the
      "SAM adds regions / exceeds box" hypothesis. Hans/Noah clean on the latest version.
- [x] **T3 — Adopt user's reject rule (e2cddd58)** — `_cleanMaskAndCheck` (Stage 2): trim to largest
      component; accept only if ONE connected figure ≤10% over the DINO box; else reject → DINO box.
      Removed point-prompt guard + _mobilesamMaskPoints. Field `maskVerdict`.
- [x] **T4 — SAM output visibility in Test Lab (2026-07-21)** — bbox stage now returns `samApplied` +
      `maskVerdict` per figure (client dumps figures as JSON → shows automatically); the mask cutout
      itself was already drawn in the overlay strip via `createBboxOverlayImage`.

## Share ONE SAM mask across eval + repair (2026-07-21) — done
The detection mask (`_gdinoMasks`, page-res, non-enumerable, never persisted) was computed once then
ignored downstream. Now:
- **Eval cutout:** `collectEntityAppearances` attaches the figure's mask to the appearance;
  `extractCropFromImage` gates the crop to the silhouette (`dest-in`) + white-mattes → evaluator sees the
  figure isolated, not a rectangle full of neighbours. Static alignment/matte test PASS (synthetic mask,
  no SAM needed). Falls back to the rectangle when no mask (reloaded/old versions).
- **Repair reuse:** `resolveCharBbox` Tier 2 (byte-guarded) returns `bodyMask`; the blended silhouette
  gate reuses it for the ORIGINAL figure, skipping one `/figure-mask` call. The SECOND (Grok-output) call
  and face-mode head masks stay — those pixels didn't exist at detection time.
See `docs/decisions.md` "Detection SAM mask is computed once…". Files: entityConsistency.js, images.js,
testlab.js. Pending live validation on staging (repair-path log: one `/figure-mask` vs two).

## Concept (answered)
- DINO = detector (boxes, "how many + where"). SAM = segmenter (mask from box/point prompt), can't
  detect on its own. We need DINO boxes to seed SAM. Since the DINO box is accurate, the bodyBox can
  just BE the DINO box; the SAM mask is optional/validated (T3).

## Clothing
- [ ] **T5 — Ordering: avatars BEFORE images — take the RUN-LEVEL proof.** The CODE half is proven
      (verified 2026-09-06): `storyJobPipeline.js:1856-1866` `onClothingRequirementsReady` starts
      avatar styling and it is awaited before page images (~`:4870`), with a comment documenting the
      ordering. Only the run-level proof is missing. Original finding: steampunk run had 0 styled avatars (Sarah failed, job
      died at styled-avatar stage) yet 4 scenes generated → clothing inconsistent (Emma pink cover/p1/p2,
      yellow p4). Confirm the pipeline truly completes styled avatars before page generation and does NOT
      proceed on a failed/base avatar. "It must create avatars first and images later."
- [ ] **T6 — Validate the redress fix (1ad718b4) on a COMPLETE run** (the failed steampunk run didn't
      exercise it). Covers were fine; textless only because the job died before the typography bake.

## Status notes
- Clothing redress fix 1ad718b4 is in staging history (other agent pushed 7895ca4b on top).
- Steampunk smoke test FAILED (server restart from other agent's push), salvage partial/inconclusive.
