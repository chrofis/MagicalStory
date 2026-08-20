# Eval variance + scoring taxonomy — open backlog

**Recovered 2026-08-20.** This block lived in `tasks/todo.md` and was overwritten there by the
trial-funnel plan (todo.md is untracked, so git has no copy). Only the portion still in a
session context could be recovered — **the head of the original file, including section A and
the A1 noise measurement it refers to, is lost.** A1 is cited below by the other items; its
finding was that the score carries roughly 26 points of run-to-run noise.

## B. Finding taxonomy (one prompt change across three templates + one validation run)

- [ ] **B1. Clothing findings carry no `subject`.** Clothing is the largest producer of
      deductions, so per-character billing degrades to per-page: two characters' clothing
      problems collapse into one charge.
- [ ] **B2. Objects have no subject either.** Only 11% of `object_presence` and 3% of
      `setting` findings carry one, so distinct objects merge. Owner accepted this merge for
      now (2026-08-19); a `subject` field closes it properly.
- [ ] **B3. `viewer_address` has no type.** Posing for the camera instead of engaging the
      task: 89 findings across 43 pages in 19 of the last 40 stories, filed inconsistently as
      `action_interaction` (often CRITICAL) or `naturalness` (MAJOR/MODERATE). Owner wants it
      as its own category. Needs a bucket in `evalBuckets.js` first, then a line in
      `BUCKET_BILLING_CATEGORY`. NOT the pose-mirror SETTLED rule (that is left/right and
      stays a non-deduction). Must never fire on covers.
- [ ] **B4. `emotion` has no type** — aliased to `naturalness` in `evalBuckets`.
- [ ] **B5. The evaluator prompts contradict each other on gaze.** `image-semantic.txt` line 46
      says per-figure gaze drift is NEVER a deduction; `action_interaction` deducts CRITICAL
      for exactly that. Whichever way B3 goes, these two must agree.

## C. Scoring + repair decisions

- [ ] **C1. Repair/redo is near a coin flip on mid pages.** `shouldRedo` fires below 50 while
      the score carries ~26 pts of noise, and `REPAIR_DEFAULTS` already records that
      regenerated pages often came back worse. Proposal: a borderline page gets a confirmation
      eval and only enters repair if it fails twice.
- [ ] **C2. The consolidator's contribution is unpredictable.** It cut mean range 52.2 → 36.8
      overall, but per page ranged from turning a raw 98 into a production 5 (crojok432 p4) to
      changing nothing at all. Worth characterising before relying on it.
- [ ] **C3. Entity consistency is unmeasured.** `eval_variance` deliberately excludes it
      (`evaluateImageQuality` never runs it), so its own run-to-run variance is unknown.

## D. Test Lab tooling + method

- [ ] **D1. Zombie experiment rows block every push for up to 2h.** A container restart kills
      the in-process loop and leaves `status='running'`; the busy probe then refuses all
      pushes. Cost an hour on exp747. A heartbeat on the experiment row kills the class.
- [ ] **D2. Range over 3 samples is a noisy estimator.** exp769's two apparent regressions
      (pixar 40→55, control 10→40) may be sampling, not effect. Validation runs comparing
      before/after need more repeats or a better statistic than min-max range.
- [ ] **D3. Guard against a second taxonomy in `scoring.js`.** A type→category map was added
      there and had to be reverted onto `evalBuckets` the same day. `evalBuckets` owns the
      taxonomy; `scoring.js` owns cost only. A check-settled style assertion would catch a
      repeat.

## Open decisions for the owner

- [ ] Approve the B1–B4 prompt change (subject + emotion + viewer_address).
- [ ] C1 targeted confirmation eval — yes/no, given A1's caveat.
- [ ] Whether any of this goes to master.

## Done (the session that produced this backlog)

- `eval_variance` Lab stage (same image × N through the full production chain; score spread,
  raw-vs-consolidated spread, detection/severity/stable attribution, records each finding's
  subject + billing key).
- `sameConcept` / `deductionPoints` / `deductionClassKey` extracted and shared.
- Sets #13 (12-case baseline) and #14 (5 styles + a deliberately stable control).
- One-deduction-per-class billing, keyed on the `evalBuckets` bucket; identity vs build split
  by repair route.
- FIXED: `storedBaseline` reported the page's active version, not the pinned one.
- FIXED: billing had a parallel taxonomy in `scoring.js`.

## Closed from the same effort

- **Reduce eval CALLS per page** — closed 2026-08-20, measured and rejected. Lever 1 (fewer
  versions) dropped by the owner. Lever 2 (reuse the parent's eval on composition-preserving
  repairs) covers only 11% of repaired versions (char-fix + garment-recolour = 17/154 over 8
  prod stories / 106 pages / 250 versions) and the semantic score moves violently on most of
  them (100→0 on a garment recolour), so reuse would ship an obsolete score; `style-repair`
  already does this legitimately at `repairPipeline.js:2711`. Lever 3 (merge P1
  `runVisualInventory` with three-stage Stage 1) rests on a misreading: the two passes are a
  deliberate two-witness design — P1 sees the reference photos and names the cast, Stage 1
  sees the image alone, and Stage 2 compares both via the shared 9-zone vocabulary
  (`evalPipeline.js:915` + `:621-633`). Merging collapses the cross-check into
  self-confirmation and cannot hold two sampling regimes. Reopening needs evidence that P1 and
  Stage 1 rarely disagree.
