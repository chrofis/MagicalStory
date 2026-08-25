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

## In flight

- [ ] Analyzer worker architecture — session-scoped worker processes, recyclers deleted;
      staging verification pending (photo upload, 4-page smoke, Lab experiment, RSS ~53MB idle)
      → `tasks/analyzer-workers-2026-08-23.md`

## Image quality — unresolved render defects

The first two are corroborated by more than one source, which is why they lead.

- [x] **Interaction load — FIXED 2026-08-23 (c191eef6d).** Pages declaring two distinct
      actions failed 7/7 (mean semantic 17); four characters sharing ONE action averaged 73.
      Cast size is not the driver. Shipped: an `action` label required on every interaction row
      (`watching`/`standing` reserved), a mechanical count in sceneBriefCheck, and the finding
      fed to the scene reviewer. exp 825: 3 flagged, 3 rewritten, 3 returned with one action
      → `docs/interaction-load-2026-08-23.md`, `docs/decisions.md`
- [ ] **"No body-part positioning" is still ignored — it has no mechanical check.** Three
      confirmations 2026-08-23 (exp 815 p7 "grips the tiller with both hands", exp 818 p12
      "presses left hand flat against the carving", exp 825 p11 "grips the spokes with both
      hands locked"). The action rule was fixed by counting a declared field and telling the
      reviewer; this rule has only prose behind it, and prose alone moved neither writer in
      four experiments. Same treatment would apply: a declared field, a count, a finding
      → `docs/decisions.md` (2026-08-23 exp 825 entry)
- [ ] **The brief checks run once, before the scene review — a rewrite can create a new
      violation nobody re-checks (exp 830).** p8 was flagged for two actions; the reviewer merged
      them into one shared action and the result has two characters gripping one wheel, which the
      hands rule forbids. Correct fix on the flagged finding, new violation created, no second
      pass. Re-running `checkScenes` on the rewritten briefs would catch it — either as a report
      or as a second review round → `server/lib/beatsPipeline.js` (scene review callsite)
- [ ] **The one-action and one-object-one-pair-of-hands rules have never produced an IMAGE.**
      Every run this session was text-only by owner instruction (exp 818/821/825/830). The rules
      demonstrably change the briefs; whether that changes the render is unmeasured, and the one
      real story that ran under the action rule (`job_1787493968756_4fgr5nukroz`) scored a mean
      61 — no better than baseline — because its remaining single actions were hand-offs
      → `docs/decisions.md` (2026-08-23 exp 825 / one-object entries)
- [ ] **Text-prop and VB-face rules are unverified (🟡).** Prop writing is never model-spelled,
      a prop's VB entry describes the object not its face, and 12c/12d now live in both scene
      templates. No story has run under any of it. Watch `viewer_address` and `object_presence`
      on pages carrying a map, letter or note → `docs/decisions.md` (2026-08-23 entries)
- [ ] **Owner hypothesis, untestable as built: a menu of suggested interactions may beat a
      mandate.** `buildExactPosesBlock` emits every row as the same imperative bullet and
      `priority` only sorts them, so "the model may pick one of five" is not a behaviour that
      exists. Testing it needs a code change first → `server/lib/promptBuilders.js:3400`
- [ ] **Beats still write two-action pages — the prompt rule did not fix it (exp 821).** 4 of 16
      pages carried two actions vs 5 of 16 originally; two named both outright ("Saira takes the
      wheel … Fiona lets go and steps back"). Not blocking — the brief-level check catches them
      downstream and the reviewer rewrites — but the defect is still born in the beat
      → `docs/decisions.md` (2026-08-23 one-action entries)

- [ ] **Avatar "pick best of N" via a vision model — NEEDS LAB PROOF FIRST (owner, 2026-08-22).**
      Today a failed avatar is regenerated and the retry replaces the original. The proposal:
      keep all attempts, send all four options plus the source photo to a vision model and ask
      which matches best — ideally judged on the frontal AND the side view. Do NOT wire this
      into the pipeline before a Test Lab experiment shows the picker beats the current
      first-valid-wins behaviour; the same judge already sits at 7-9/10 across the entire
      quality range and may be no better at ranking than at scoring
      → `docs/decisions.md` (2026-08-22 ArcFace entry, "Still open")
- [ ] **Raise avatar retries from 1 to 3 — reverses a prior user direction.** The owner asked
      for "up to 3x redo" on 2026-08-22, but `MAX_SHEET_RETRIES = 1` in character2x4Sheet.js:98
      cites "user direction 2026-08-09". Needs an explicit reversal decision plus a cost
      estimate (each retry is a paid Grok call per category)
      → `server/lib/character2x4Sheet.js:98`
- [ ] **Trial avatar likeness — owner reported the photo "nicht sehr gelungen / fehlende
      Ähnlichkeit" vs the original (2026-08-21 trial feedback).** Not yet diagnosed: the
      owner deleted that trial run, so there is no stored evidence to compare. Next time a
      likeness complaint lands, capture the account/story ID first, then compare the four
      stages (face crop → identity sheet → style transfer → page render) to localise where
      the likeness is lost → `docs/decisions.md` (2026-08-21 title entry, same feedback round)

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
- [ ] Composite plate: `objects[]` never reaches the plate prompt, so PRIORITY 1's promise to
      render "every required object" has no source — the setting text is the empty-scene prompt,
      which by construction has no props. Needs its own section inside the 8000-char Grok budget
      the setting is already trimmed to fit → `docs/decisions.md` 2026-08-24 flat-lineup entry
      (the flat-lineup half of this item is FIXED in `143ed6f05`: pose resolver, compound
      interaction keys, and the fabricated left/right direction)
- [ ] Composite delivers 0 pages out of every trigger measured so far — 3 real production
      triggers across two finished stories (2026-08-24) all aborted; earlier audit found 11
      gate-true pages / 161 with no record. Whether the gates are right or the plate is too weak
      is the open question → `docs/decisions.md` 2026-08-24 stage-frames entry
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

## Story text quality — the review stages trade feeling for logistics

- [ ] **The landmark mandate teleports a toddler book — 2 of 2 toddler stories (2026-08-25).** `story-trial.txt`'s
      LANDMARKS section says "At least one scene MUST take place at one of these real local
      landmarks", and toddler mode says "No journeys. The story begins where it happens." In staging
      story `job_1787683120734_qkgfbd86o` the two collided: pages 1-5 are on a pirate ship at sea,
      then p6 opens "Später sitzt Leynor am Stüssibrunnen in Dübendorf" — an unexplained teleport on
      the last page. Fix is a choice: drop the landmark requirement in toddler mode, or set the whole
      story at the landmark from p1. → `prompts/story-trial.txt` (LANDMARKS), `prompts/toddler-mode.txt`
      SECOND occurrence, same shape: `job_1787687259758_k7mennm8c` p1-p5 are on a pirate ship at sea,
      p6 opens "Nach dem grossen Abenteuer auf dem Piratenschiff sitzt Leynor am Lindenhofbrunnen in
      Dübendorf". Every toddler story with a landmark has done this, so it is systematic, not luck.
- [ ] **"riesenross" — a non-word the writer produces for "riesengross", twice in one day.**
      `job_1787682773703_v5c2dq4te` p4 ("Seine Augen werden riesenross") and
      `job_1787687259758_k7mennm8c` p2 ("Das Steuerrad ist riesenross"). Both de-CH, both survived
      text refine. Two occurrences in two of three stories is a pattern, not a one-off sampling slip.
      → text-refine / story-text-audit prompts
- [x] **Toddler mode (ages 1–3) — BUILT 2026-08-25, verified on two staging runs.** No narrative age branch in the system
      goes below 3 (challenge catalogue starts at 3–5, story shape at `focusAge <= 5`, lowest reading
      level is `1st-grade`); `toddler` exists only as body proportions. Prod trial
      `job_1787647410717_5dvfqu8jg` gave a 1-year-old main a solo train journey, a map to reason
      from, and 100–140 words/page. Trigger rule settled by owner: oldest MAIN character ≤ 3.
      → `tasks/toddler-mode-2026-08-25.md`
- ~~The trial ignores reading level entirely~~ — **won't do (owner, 2026-08-25: "leave trial on 100
      words per page that is fine")**. `prompts/story-trial.txt:14` and `:181` hardcode "100–140 words
      per page" and never reference `{READING_LEVEL}`; the `1st-grade`-trial consequence is known and
      accepted. Recorded so it is not re-proposed → `tasks/toddler-mode-2026-08-25.md` §6

Full provenance trace of 15 defects in `job_1787638707796_x8272kcs22m` ("Levin und der kleine
Drache", 18p, de-CH). Measured: the writer's draft is the best prose state of the run; the arc
review, beats review and text refine each fix real faults by adding logistics and paying for
them by deleting an emotional or characterising sentence. Text refine alone: 14 faults fixed,
**8 emotional sentences destroyed, 3 new defects created.** All fixes below are prompt-only.

- [ ] **T3 — text refine invents plot to close an audit fault, destroying an obstacle.** "Max hat
      sein Velo durch das seichte Wasser geschoben" (p8) makes the p4 stream obstacle
      retroactively fake. The refiner has no "delete the detail" disposition, only "fix on a page"
      → `tasks/story-text-quality-2026-08-25.md:T3`
- [ ] **T5 — page-turn travel raised as a continuity fault → travelogue openers.** "Nach der
      Ruine steigen die vier Buben…", "Nach dem Flug…". The beats review had already ruled this
      "stands"; the text audit has no memory of it → `tasks/story-text-quality-2026-08-25.md:T5`
- [ ] **T2 — text refine deletes emotion to pay for logistics (8 measured deletions).** Includes
      "Er dreht sich fast um" (p4), the hesitation beat the beats review explicitly *mandated*.
      Needs a protected class + a deletion ledger → `tasks/story-text-quality-2026-08-25.md:T2`
- [ ] **T1 — prop bookkeeping written into BEAT instead of SCENE → "Julian hält die Folie" on
      7 pages.** The beats-review ledger routes around the writer's "do not narrate staging" rule
      → `tasks/story-text-quality-2026-08-25.md:T1`
- [ ] **T6 — arc review closes an orphan prop by carrying it through 11 pages** (Max's Velo). No
      "retire the object" disposition → `tasks/story-text-quality-2026-08-25.md:T6`
- [ ] **T4 — clock times written into prose** ("am Nachmittag", "später Nachmittag") to patch an
      arc-level problem: a nightfall deadline starting on a "Sommermorgen"
      → `tasks/story-text-quality-2026-08-25.md:T4`
- [ ] **T8 / T11 / T13 — three missing checks, one clause each.** A build-up page whose action
      is taken by someone else (Max p5 → Julian p6); a final-challenge blocker that is never
      foreshadowed (the mist); an ending with a sentiment ceiling and no floor ("Niemand sagt
      viel.") → `tasks/story-text-quality-2026-08-25.md:T8`
- [ ] **T9(a) / T10 — reading level not re-checked after the writer** (p9 carries a 20-word
      nested clause at 1st-grade); no pacing check that the story's most-wanted image gets a page
      (the hatch happens between p2 and p3) → `tasks/story-text-quality-2026-08-25.md:T9`
- [ ] **T15 — `stories.data.dedication` is empty on a delivered book.** Undiagnosed: wizard never
      offered it, or it was collected and dropped → `tasks/story-text-quality-2026-08-25.md:T15`

## Tests

- [ ] **3 unit tests fail on `staging` HEAD: `tests/unit/active-version-recompute.test.ts`.**
      `recomputeAllActiveVersions` leaves `sceneImages[0].activeVersion` undefined where the test
      expects 1. Pre-existing (reproduced with all local changes stashed), found 2026-08-23 while
      verifying an unrelated change. Not filed in `tasks/bugs.json` because it is undiagnosed —
      could be the recompute path or a stale test, and a bugs.json entry blocks every push
      → `tests/unit/active-version-recompute.test.ts:113`

## Eval + scoring

- [ ] **A page can fail semantics outright and never trigger a redo (measured 2026-08-23).**
      `scoreThreshold: 50` gates on `finalScore`, computed over *consolidated* deductions, so
      semantic 0 can land at finalScore 60 and ship first try. 9 of 34 pages across two prod
      stories had semantic ≤50 with no regeneration; two scored a flat 0
      → `docs/interaction-load-2026-08-23.md`

Full detail for this whole section: `tasks/eval-variance-backlog.md` (recovered 2026-08-20
after `tasks/todo.md` was overwritten; the head of the original, including the A-section noise
measurement, is lost).

- [ ] **B1–B2 — add a `subject` field to clothing and object findings.** Without it,
      per-character billing degrades to per-page: two characters' clothing problems collapse
      into one charge. Only 11% of `object_presence` and 3% of `setting` findings carry a
      subject today → `tasks/eval-variance-backlog.md`
      **needs owner approval before coding** (classification is the prompt's job)
- [x] B3 `viewer_address` + B4 `emotion` own types — **done 2026-08-20**
      (`evalBuckets.js:91,101`; `docs/decisions.md:13936`)
- [x] B5 gaze contradiction — **resolved**; `image-semantic.txt:46` and `:89` now agree
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

- [ ] **A running experiment cannot be cancelled.** No abort route (only `/experiments/:id/redo`)
      and no abort signal in the run loop, so firing an N-target set commits the whole spend the
      moment it starts — found while running exp 815 (2026-08-23), where the change was clearly
      losing by result 4 of 14 and there was no way to stop the remaining 9
      → `server/routes/admin/testlab.js:877`
- [ ] **A blocked image discards the text arms too.** `scene_expansion_ab` renders inside the
      stage, so an `IMAGE_OTHER` refusal throws before `newSceneDescriptionA/B` are stored and the
      page loses the brief comparison as well as the image (1 of 5 in exp 815). The text-only
      `scene_expansion` stage should gate the render for prompt-shape questions
      → `server/lib/testlab.js` (`runSceneExpansionAbStage`)

- [x] D1 — zombie experiment rows blocking pushes — **fixed 2026-08-19** (30s `heartbeat_at`,
      5-minute freshness on the reaper and the busy probe; `docs/decisions.md:13844`)
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
- [x] ~~Composite blend fix (`3ad9e1a12`) unverified~~ — VERIFIED in exp 848 (2026-08-25): the
      size-neutral clause held, no enlargement onto the occluder. A DIFFERENT blend defect
      surfaced in the same run (duplicate figure + re-frame) → next line
- [ ] Composite blend v2 (`8c1baa515`, positive description, 1635 chars) awaits its first
      measured run — exp 848 duplicated the occluded figure and re-framed at 5451 chars, both
      already forbidden in that prompt → `docs/decisions.md` 2026-08-25 blend-rewrite entry
- [ ] Composite stage frames in production (`14bcc6330`) proven only offline against a spy —
      the end-to-end proof is the next page that trips the gate → `docs/decisions.md`
      2026-08-24 stage-frames entry
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

- [ ] Approve the B1–B2 evaluator prompt change (`subject` field) → `tasks/eval-variance-backlog.md`
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
- [ ] **T7 — spoil the payoff or risk the reader?** The arc review fixes "device acquires meaning
      retroactively" by stating the rule where the device first appears, which spoiled this
      story's ending 9 pages early (p9 board, then p15 Kiaan repeats it). Alternative: show a
      character *learning* it without telling the reader what → `tasks/story-text-quality-2026-08-25.md:T7`
- [ ] **T9(b) — should `textQualityJudge` run in the unified pipeline?** The template and
      `server/lib/textQualityJudge.js` exist; it did not run on this story. Cost/latency call
      → `tasks/story-text-quality-2026-08-25.md:T9`
- [ ] **T12 — dialogue floor, and does a companion animal get a name?** ~8 spoken lines in 18
      pages; the dragon is never named. The name rule changes story convention, not just prose
      → `tasks/story-text-quality-2026-08-25.md:T12`
- [ ] **T14 — must every title contain the main character's name?** Hard rule in
      `story-text-from-beats.txt`; produces "Levin und der kleine Drache" for a four-lead story.
      Product call (shelf recognisability) vs craft call
      → `tasks/story-text-quality-2026-08-25.md:T14`

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
- [ ] Aboard-vehicle pages: if figures-on-deck placement misbehaves in production after the VB-vehicle plate injection (b6481c9e4), consider drawing vessel+crew together (AD declares aboard flag; plate excludes vehicle; buildPageCompositeRefs keeps VEH ref) — parked as too complicated for now → docs/decisions.md 2026-08-23 entry
- [ ] Entity consistency never grids VEH entities — a wrong-shape vehicle passes every post-gen eval (seen: flagship rendered as rowboat on 9 pages, objects channel empty) → server/lib/entityConsistency.js; plate-injection fix (b6481c9e4) reduces but does not close this
- [x] German object names are dropped as "proper names" — FIXED 2026-08-24 (guard deleted; 0/61 correct) — `isBareProperName(object) && !charSet.has(object)` deletes ordinary German props, because every German noun is capitalised. Measured: 6 rows lost in one book (Schiffslaterne x4, Frachtkisten x2, Schatzkiste). → `server/lib/sceneMetadata.js:194`
- [x] A visual-bible actor (the dragon) can never act — FIXED 2026-08-24 (VB actors admitted + resolved; unknown actors now reported) — `sanitizeInteractions` validates the actor against the human scene cast only, so `ANI001→ART005` is dropped. Prod p7 lost its whole action ("crossing the log") this way and rendered with an empty EXACT POSES block. → `server/lib/sceneMetadata.js:191`
- [x] The visual-bible entity NAME gets painted onto the prop as legible text — FIXED 2026-08-24 (sanitizeVbIdsInPrompt now rewrites names, not just ids) — "Fiona's Schatzkarte" lettered across the map (staging p5), "Goldene Möwe" across the hull (p4). The brief never quotes a string; it just uses the VB name as the noun phrase. 12c does not cover this. → `prompts/scene-expansion-all.txt:42`
- [x] 12d loses to face description — RULE TIGHTENED 2026-08-24 (face content banned from the brief); unverified until a story runs with the evaluator alive: 7 of 7 pages whose brief describes what is ON a document rendered that face to the camera, including one that also said "angled toward herself" (staging p13). The angle instruction cannot win while the prose spends a clause on the face. → `prompts/scene-expansion-all.txt:44`
- [ ] Objects declared once get drawn 2-3 times — one rope rendered as three (staging p11), one book as two (prod p3). No check counts rendered instances against declared ones.
- [ ] Cast members go missing without a finding — prod p7 drew 2 of 4 boys, p15 and p18 drew 3 of 4. The brief check only catches cast in the prose but absent from metadata, never the reverse.
- [ ] `style_repair` repaints the COMPOSED cover, title text and all — it selected page -1 in Lab #837 and all three arms restyled the title instead of repainting `${key}Art` and restamping via `composeCover`. The text survived legibly this time; nothing guarantees it will. → `server/lib/styleRepair.js` (cover targets from `planStyleRepair`)
- [ ] The style gate cannot tell grain from brushwork — Lab #837 scored a noise-filtered photographic face as `better: 'after'`, "prominent brushstrokes". The content veto works (`changed: []` was right every time); the style half is credulous. → `server/lib/styleAnalysis.js` (`compareStyleProximity`)
- [ ] PARKED (owner, 2026-08-24): face-crop style repaint — crop the face box, repaint it at full frame so the face IS the image, composite back via the feathered insert-blend. Lab #837 measured Grok spreading repaint effort uniformly (face/rest = 1.07), so a small face gets almost none of it and the page still returns looking worked-on. Not rejected, not scheduled. → `docs/decisions.md` (Lab #837 entry)
- [ ] The style repaint changes the page ASPECT RATIO — 864x1222 in, 832x1248 out, on all three Lab #837 arms (Grok's documented input-aspect coercion, and Gemini's repaint did it too). A repaint that ships would silently re-crop the page or cover. → `server/lib/styleRepair.js` (`repairPageStyle`, aspectRatio opt)
- [x] Verify the closed-prop reference actually flips the render — DONE 2026-08-24, 4 renders: closed ref works, face-free description is the required other half — 2 pages x 4 arms (baseline / closed ref / no ref / closed ref + OTS-egocentric text) in the Test Lab. Owner approved 2 pages 2026-08-24. → docs/decisions.md 2026-08-24 "drawn CLOSED"
- [ ] Orientation phrasing is still intrinsic ("angled toward herself"); GenSpace says egocentric final-image phrasing binds far better ("the plain reverse side faces the viewer"), and only "over-the-shoulder shot" / "shot from behind" are attested vocabulary. → prompts/scene-expansion-all.txt 12d
- [ ] Scale similes in a visual-bible description render literally — "roughly the size of two open palms" drew two human hands onto the parchment in a prop reference sheet. Phrase is live in production ART001. Compare a prop against a neutral object, or give size in cm. → prompts/story-bible-from-beats.txt artifact description hint
- [ ] A duplicated inset panel pasted over a page scored 100/100/100 — prod job_1787638707796_x8272kcs22m p15 has a rectangular crop of its own background composited into the lower-left corner and no evaluator axis caught it. No axis owns frame-level compositing artefacts.
- [x] Decide whether an INTRODUCED brief fault should trigger a second review round — DONE 2026-08-25: yes, targeted at ~$0.02 — the re-check now reports it, nothing fixes it, and the page ships. Costs one text call per affected story. → docs/decisions.md 2026-08-25
- [ ] referenceView is applied inconsistently — staging job_1787638394061_hs70901tfsn has two maps; ART001 got the field, ART004 ("Rossas Kartenkopie") did not, though a map is squarely in the type list. The field is optional, so the bible author can just omit it.
- [ ] A visual-bible description still states who holds a prop — ART004 in the same story reads "held in one hand along its lower edge" and describes its face, against the rule that a description never says who holds/carries/wears it. → prompts/story-bible-from-beats.txt
- [ ] CARRY_ROUTES is unexercised — no story has yet run with a non-empty arc or beats audit carry block. Confirm on the next staging run that the block appears in the plan/Art Director/text prompts and that nothing regresses. → server/lib/beatsPipeline.js CARRY_ROUTES
- [ ] **Validate the 2026-08-25 review fixes on a live run**: first toddler story through the injected arc/beats reviewers, and first story with a non-empty REVIEWER'S RULINGS carry block → `docs/decisions.md` (2026-08-25 "Carried findings travel WITH the reviewer's rulings" entry)
- [ ] **SEO repositioning onto the creation differentiator** — measured: ~10 clicks/month, all 149 ranking queries are the template-book category at pos 38-52 (Librio's turf), creation queries at pos 27-61. Phase B shipped 2026-08-25 (footer link architecture, /so-funktionierts→/kinderbuch-erstellen + 301, www→apex 301, page rewritten to the searched vocabulary). Phases C (scale the AI-generator comparison set, creation hub, editorial surface) and D (authority: Swiss family bloggers, Trustpilot, startup press, roundup listings, expand /science) still open. → `tasks/seo-creation-repositioning-2026-08-25.md`
