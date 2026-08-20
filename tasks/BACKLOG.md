# BACKLOG — the single index of open work

**This file is the entry point. Read it before starting work; add to it when you find
something.** It holds one line per open item with a pointer to the file that carries the
detail. The source documents keep their long-form context — this index exists so nobody has
to sweep forty files to find out what is open.

**Conventions**
- One line per item, `- [ ]` while open, `- [x]` when done (with the date and commit).
- Every line ends with a `→ file:line` pointer. The pointer is the contract: the detail lives
  there, not here.
- When you close an item, tick it **in both places** — here and in the source file.
- New work found mid-session goes here immediately, even if you are not going to do it.
- Clear, reproduced bugs do **not** go here — they go in `tasks/bugs.json`, which blocks every
  push while open (`check-open-bugs.js`). This file is for everything that is not a
  drop-everything bug: improvements, unbuilt features, unrun experiments, deferred decisions.

**Not searched by future sweeps:** `docs/archive/` (superseded, see its README) and
`.claude/skills/` + `prompts/*.txt` (checkbox templates, not tasks).

Last full sweep: **2026-08-20**.

---

## P0 — gating the production promotion

- [ ] Verify on staging before promoting to master — **35 commits ahead as of 2026-08-20**
      (the "259 commits" figure in the source file is from 2026-07-20 and has since been
      promoted) → `docs/compliance-and-todo.html:81`
- [ ] Confirm location-verify + the landing #418 fix with a fresh showcase
      → `docs/compliance-and-todo.html:83`

---

## Image quality — unresolved render defects

The first two are corroborated by more than one source, which is why they lead.

- [ ] **Per-page art style breaks to photorealism** (showcase p5, −22). Still occurring in
      prod despite `style_repair`; three candidate causes listed in the routing doc
      → `docs/showcase-2026-08-10-findings.md:40`, `docs/image-routing.md:163`
- [ ] **`garment-recolour` makes pages much worse** (p14: 30 → −80). Independently measured
      2026-08-20: recolour children swing 100 → 0 semantically on several prod pages
      → `docs/showcase-2026-08-10-findings.md:69`
- [ ] Character repair runs, produces nothing, logs nothing (`wasCharacterFixed` false on all
      14 pages) → `docs/showcase-2026-08-10-findings.md:52`
- [ ] Fake handwriting rendered on a prop (p13) → `docs/showcase-2026-08-10-findings.md:76`
- [ ] `costumeReads` sub-score has never been observed firing — unproven, not known broken
      → `docs/showcase-2026-08-10-findings.md:80`
- [ ] Back-cover "magicalstory.ch" unreliable (3/4 missing, 1 doubled)
      → `tasks/showcase-bugs-2026-07-20.md:15`
- [ ] Figure detection fails on 4 known pages (Sarah initialPage bodyBox 69%×72% merged +
      faceBox mislocated; Sarah p2; Hans p3; Noah p9)
      → `tasks/showcase-bugs-2026-07-20.md:27-31`
- [ ] Detection guard fires but is not 100% — 3 residual `fixed=-` figures, bbox-cache
      suspected, staging-only → `tasks/showcase-bugs-2026-07-20.md:91`
- [ ] Lena's VB binding is name-only in the prompt → `tasks/showcase-bugs-2026-07-20.md:74`
- [ ] `som_identity_fallback=4` on smoke `job_1787250416967_9owpz1j3b` is unexplained (noted
      inside an otherwise-fixed bug entry) → `tasks/bugs.json`
- [ ] Cover text: not verified inside a full generation; no restamp route for the back cover;
      the cover prompt asks for naturalistic lighting AND a stylised look, so the evaluator
      penalises it → `docs/cover-text-rendering-research.md:229`
- [ ] Mitigation playbook for known image failure modes — deferred wholesale (hazard list in
      scene-expansion, matching eval checks, Lab validation)
      → `docs/image-failure-modes.md:35`
- [ ] Composite cover with the new Pixar avatars is untested, and the Lab toggle for
      `params.composite` is not exposed → `docs/image-routing.md:160`
- [ ] Direct-vs-composite thresholds are intuition, never measured → `docs/image-routing.md:161`
- [ ] Faces-in-style ceiling — experiment TBD → `docs/image-routing.md:162`
- [ ] Single-portrait avatars (no 2×2 grid) — open lever, not shipped
      → `docs/image-generation-methods.html:533`
- [ ] 2×4 costumed sheet: Row-1 costume leak; need 5× per character for a real `IMAGE_OTHER`
      rate; identity drift across angles; downstream consumer / index remap undecided
      → `docs/tests/costumed-2x4-findings.md:100`
- [ ] Sarah's photo triggers `IMAGE_OTHER` on every Gemini call
      → `docs/tests/costumed-2x4-findings.md:95`
- [ ] Qwen composite: identity scores vs refs, 4-insertion drift, interacting poses and
      occlusion-order steerability all unmeasured
      → `docs/tests/qwen-composite-experiment.html:75`

---

## Eval + scoring

Full detail for this whole section: `tasks/eval-variance-backlog.md` (recovered 2026-08-20
after `tasks/todo.md` was overwritten; the head of the original, including the A-section noise
measurement, is lost).

- [ ] **B1–B4 — one prompt change across three templates + one validation run.** Clothing and
      object findings carry no `subject` (so per-character billing degrades to per-page);
      `viewer_address` has no type (89 findings, 43 pages, 19 of the last 40 stories, filed
      inconsistently); `emotion` is aliased to `naturalness`
      → `tasks/eval-variance-backlog.md`  **needs owner approval before coding**
- [ ] B5 — `image-semantic.txt:46` and the `action_interaction` type contradict each other on
      gaze; whichever way B3 goes, they must agree → `tasks/eval-variance-backlog.md`
- [ ] C1 — repair/redo is near a coin flip on mid pages (`shouldRedo` fires below 50 while the
      score carries ~26 pts of noise) → `tasks/eval-variance-backlog.md`
      **needs a yes/no from the owner**
- [ ] C2 — the consolidator's contribution is unpredictable (mean range 52.2 → 36.8 overall,
      but a raw 98 became a production 5 on one page) → `tasks/eval-variance-backlog.md`
- [ ] C3 — entity consistency's own run-to-run variance is unmeasured
      → `tasks/eval-variance-backlog.md`
- [ ] Three severity tables, five deduction buckets, and `evalScore` redundancy want
      collapsing → `docs/scoring-simplification-review.md:170`
- [x] D3 — guard against a second taxonomy in `scoring.js` — **done**, pre-push gate 6
      (`check-taxonomy-ownership.js`)
- [x] Reduce eval CALLS per page — **closed 2026-08-20, measured and rejected**; rationale and
      the reopening bar in `tasks/eval-variance-backlog.md`

---

## Compliance + legal — not built

- [ ] GDPR hard-delete: wipe Postgres rows, wipe R2 objects, honour Stripe/Gelato retention,
      confirmation flow + email receipt (endpoint shape sketched, nothing implemented)
      → `docs/compliance-and-todo.html:57`
- [ ] Geo-blocking: restrict checkout to CH/EU/UK, block sanctioned jurisdictions at the edge,
      EU VAT via Stripe Tax → `docs/compliance-and-todo.html:67`

---

## Growth, ads, product

- [ ] **E1 — confirm the GA4 conversion event actually fires.** The ads file itself flags this
      as outranking all the quality-score work → `tasks/ads-quality-score.md:64`
- [ ] Ads quality score: 21 further items — A1–A6 landing/LCP, B1–B4 keyword and ad-group
      hygiene, C1–C8 asset audit, D1–D3 weekly tracking → `tasks/ads-quality-score.md:21-61`
- [ ] Sentry error alerting; Plausible/Umami analytics → `docs/compliance-and-todo.html:87`
- [ ] Activate the referral programme — code is shipped, the surface is hidden
      → `docs/compliance-and-todo.html:89`
- [ ] R2 storage Phase 2 + Phase 3 → `docs/compliance-and-todo.html:90`
- [ ] Audio narration prototype → `docs/compliance-and-todo.html:91`
- [ ] P2: Life Skills story library; subscription tier; fairy-tales category; Test-models panel
      UX; the UI text cleanup backlog → `docs/compliance-and-todo.html:96`
- [ ] P3: video story trailers; Kontext LoRA per character; Gemini 3 Pro Image multi-character
      covers → `docs/compliance-and-todo.html:106`
- [ ] Review platforms — Trustpilot TrustBox, AggregateRating schema, link in the shipped
      email (all gated on 5+ reviews) → `biz/13-review-platforms.md:18`
- [ ] Launch playbook — 41 unchecked items (pixel/CAPI, Turnstile, rate limiting, gift cards,
      email sequence, Stripe live, schema, sitemap, GDPR pages, DE/EN/FR copy, SEO page sets,
      social setup, ad campaigns) → `biz/10-launch-playbook.md`

---

## Refactor + tech debt

- [ ] STR-1 — split `processUnifiedStoryJob` (~4,600 lines); STR-2–STR-5 + VAR-1 each ship as
      their own PR → `docs/review-2026-07-04-structural-plan.md:3`
- [ ] Split `evaluateImageQuality` (1,058 lines) and `generateImageWithQualityRetry` (761
      lines); re-cluster `images.js`; move `inpaintPage`; hoist 10 closures in
      `runUnifiedRepairPipeline`; break the generation↔evaluation cycle
      → `docs/scoring-simplification-review.md:170`
- [ ] Dead code: unused `IMAGE_MODELS` import in `repairPipeline.js`; callerless
      `detectGrokBorder`; test-only exports; two competing "is this dressed" thresholds
      → `docs/scoring-simplification-review.md:170`
- [ ] Re-run the `eea385113` sweep (61.5% outfit omission); turn the destructure audit into a
      unit test → `docs/scoring-simplification-review.md:170`
- [ ] Migration drift into CI; prune `scripts/_tmp_*.js`; collapse 40+ `refine-tell-vN.js`;
      inline base64 → R2 Phase 3; drop the legacy `pictureBook` / `outlineAndText` paths;
      consolidate the three test-image panels → `docs/compliance-and-todo.html:114`
- [ ] REV-7 (P3) deferred minors: second poller lacks `knownPages`; `imgRowToBytes` is a
      hand-copied fork of `imgBytesAsync`; `dropInlineBase64` mutates shared refs
      → `docs/review-2026-07-04.html:124`

---

## Test Lab tooling

- [ ] D1 — zombie experiment rows block every push for up to 2h. A container restart leaves
      `status='running'` and the busy probe then refuses all pushes (cost an hour on exp747).
      A heartbeat on the experiment row kills the class → `tasks/eval-variance-backlog.md`
- [ ] D2 — range over 3 samples is a noisy estimator; validation runs need more repeats or a
      better statistic → `tasks/eval-variance-backlog.md`
- [ ] E1 — a Lab→story link opens as plain admin, missing owner/impersonation rights. Root
      cause of the dead "Geschichte ansehen" button. **Deliberately deferred —
      security-sensitive** → `tasks/showcase-bugs-2026-07-20.md:63`
- [ ] D2 (showcase) — "Geschichte ansehen" shows but does nothing (symptom of E1 above)
      → `tasks/showcase-bugs-2026-07-20.md:57`
- [ ] D1 (showcase) — "Emma on title failed"; needs an exact repro action + result
      → `tasks/showcase-bugs-2026-07-20.md:55`

---

## Verification pending (code shipped, proof not taken)

- [ ] Run a full trial on staging as admin; query `trial_events` for the complete ordered row
      trail for one `visit_id` → `tasks/todo.md:49`
- [ ] Confirm the admin card renders the funnel with real staging rows → `tasks/todo.md:51`
- [ ] T5 — confirm the pipeline completes styled avatars BEFORE page generation
      → `tasks/sam-clothing-tasks-2026-07-20.md:39`
- [ ] T6 — validate the redress fix (`1ad718b4`) on a complete run
      → `tasks/sam-clothing-tasks-2026-07-20.md:43`
- [ ] Confirm the repair path issues one `/figure-mask` call, not two
      → `tasks/sam-clothing-tasks-2026-07-20.md:31`
- [ ] One full showcase re-run to confirm redo counts drop end-to-end
      → `tasks/redo-clothing-analysis-2026-07-20.md:124`
- [ ] Admin drafts: no admin UI (publishing is a raw POST); old demo accounts not consolidated;
      the draft path is unproven end-to-end
      → `docs/production-todo-admin-drafts.md:63`
- [ ] SEO theme pages — 13 unchecked verification steps (title/FAQ JSON-LD/sitemap/robots/
      hreflang/og:title, `/themes` in DE/EN/FR, Rich Results Test)
      → `docs/plans/2026-03-10-seo-theme-pages.md:479`
- [ ] Demo stories — test the setup-demo-user script; run the demo test locally
      → `docs/plans/2026-03-10-demo-stories.md:21`

---

## Decisions waiting on the owner

Nothing below should be coded until it is answered.

- [ ] Approve the B1–B4 evaluator prompt change → `tasks/eval-variance-backlog.md`
- [ ] C1 targeted confirmation eval — yes or no → `tasks/eval-variance-backlog.md`
- [ ] Trial: generate the 2×4 costumed sheet eagerly or lazily?
      → `tasks/story-scoped-avatars-plan.md:89`
- [ ] Cover/page unification — 8 open risks: checkpoint UX for score-less covers, TITLE_ERROR
      regen mapping, composite `score: null` eval exemption, `iterateCover` consumers outside
      the pipeline, aspect drift after removing the fallback, entity check on negative pages,
      keeping trial covers cheap, whether cover gen moves into Phase 5a
      → `docs/plans/2026-08-10-cover-page-unification-review.md:193`
- [ ] Anonymous account flow — keep or drop the ideas step; story viewing without email;
      cleanup interval 24h vs 48h; localStorage vs sessionStorage
      → `docs/plans/2026-03-08-anonymous-account-flow.md:244`
- [ ] Whether any of the eval work goes to master → `tasks/eval-variance-backlog.md`

---

## Experiments proposed, none run

Seeded 2026-07-21. None of these is committed work — they are candidates.

- [ ] Rewrite self-critique into per-page failure-mode verdicts → `docs/testing-backlog.md`
- [ ] Cross-model review A/B (Sonnet writes / Opus reviews) → `docs/testing-backlog.md`
- [ ] Extend the acceptance gate (count/position/location + simpler-shot fallback)
      → `docs/testing-backlog.md`
- [ ] Enum scene descriptors; palette-locked hex consistency → `docs/testing-backlog.md`
- [ ] Batch API + prompt caching, offline path only → `docs/testing-backlog.md`
- [ ] Scene-prose length A/B — 250–350 words vs the ~150 cap → `docs/testing-backlog.md`
- [ ] Ten ranked competitive follow-ups (Gemini 3.x vs Grok avatar A/B, layflat hardcover tier,
      persistent watermarked trial share link, on-demand landmark acquisition, SAM 3.1 concept
      prompting, local illuminant estimation, judge-ensemble gate, embedding identity score,
      typographic art direction, production text-quality judge gate)
      → `docs/testing-backlog.md:140`
- [ ] Verify the claim that Sonnet 5 pricing moves $2/$10 → $3/$15 on Sep 1 before relying on
      it → `docs/testing-backlog.md:203`

---

## Backlog of decisions never written up

- [ ] Trial cover `onTitle` → `onCoverScene`; `extractTitle` legacy fallback conditions;
      cascade face-detection merge order; why Grok is the avatar-face provider
      → `docs/decisions.md:1385`

---

## Deliberately out of scope

Recorded so nobody re-proposes them as gaps.

- GA4 mirroring of trial step events → `tasks/todo.md:54`
- Reactivating Search-Deutschschweiz-v1 (campaign 23884069828) → `tasks/todo.md:54`
- B → Gemini fallback option; C2; D1 → `tasks/showcase-bugs-2026-07-20.md:126`
- `requirements/` (2025-01 pre-implementation spec, 174 items) and `docs/archive/` — both
  superseded; moved out of the search path 2026-08-20
