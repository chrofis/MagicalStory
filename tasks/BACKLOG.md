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
- [ ] **Scored A/B for `grok-imagine-2` pages/covers before production can follow staging.**
      Staging renders pages + covers on Imagine 2.0 ($0.04) since 2026-08-30; production stays
      on `grok-imagine` ($0.02). The switch has NO scored evidence — Lab 959/963/965 all ran
      `autoEval:false` and their score arrays are empty, so the basis is an eyeballed sample.
      → `docs/decisions.md` 2026-08-30 page-tier entry, `docs/image-routing.md:17`
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
- [x] referenceView is applied inconsistently — MOOT 2026-08-26: referenceView replaced by two bible entries per face-prop, so the side is an id choice, not an optional field — staging job_1787638394061_hs70901tfsn has two maps; ART001 got the field, ART004 ("Rossas Kartenkopie") did not, though a map is squarely in the type list. The field is optional, so the bible author can just omit it.
- [ ] A visual-bible description still states who holds a prop — ART004 in the same story reads "held in one hand along its lower edge" and describes its face, against the rule that a description never says who holds/carries/wears it. → prompts/story-bible-from-beats.txt
- [x] CARRY_ROUTES is unexercised — EXERCISED 2026-08-25 in prod job_1787689073034_1v6ew0y1kae, all three routes fired — no story has yet run with a non-empty arc or beats audit carry block. Confirm on the next staging run that the block appears in the plan/Art Director/text prompts and that nothing regresses. → server/lib/beatsPipeline.js CARRY_ROUTES
- [ ] **Validate the 2026-08-25 review fixes on a live run**: first toddler story through the injected arc/beats reviewers, and first story with a non-empty REVIEWER'S RULINGS carry block → `docs/decisions.md` (2026-08-25 "Carried findings travel WITH the reviewer's rulings" entry)
- [ ] **SEO repositioning onto the creation differentiator** — measured: ~10 clicks/month, all 149 ranking queries are the template-book category at pos 38-52 (Librio's turf), creation queries at pos 27-61. Phase B shipped 2026-08-25 (footer link architecture, /so-funktionierts→/kinderbuch-erstellen + 301, www→apex 301, page rewritten to the searched vocabulary). Phases C (scale the AI-generator comparison set, creation hub, editorial surface) and D (authority: Swiss family bloggers, Trustpilot, startup press, roundup listings, expand /science) still open. → `tasks/seo-creation-repositioning-2026-08-25.md`
- [ ] Comparison slugs live in two places — `COMPARISONS` in `server/lib/seoMeta.js:488` duplicates the ids in `client/src/constants/comparisonData.ts`. Adding a comparison requires editing both; missing the server one silently costs the page its meta, canonical and sitemap entry. Derive one from the other. → `server/lib/seoMeta.js:488`
- [ ] **Page 7 shipped as a reference SHEET, not a scene (2026-08-26).** staging
      `job_1787693271900_cyc9lol5y` p7: the final `scene/p7/v0.jpg` is a two-panel diptych
      with a red/blue border and a strip of four reference thumbnails (vest, girl, hat,
      parrot) along the bottom. The beat is one adult crouching to offer a toy to a child;
      the render splits them into separate panels. `story_images` for that story carries
      `ref_sheet_source` rows, so the suspicion is the reference sheet leaking into the page
      output. ONE occurrence, on a run with `skipQualityEval=true` (no eval/repair pass), so
      systematic-ness is unproven — reproduce before treating as a registry bug.
      → `server/lib/images.js` (page image path), `story_images.image_type='ref_sheet_source'`
- [ ] **Full-cast pages render photorealistic instead of the requested art style (2026-08-26).**
      Same story, `artStyle=watercolor`: 7 of 10 pages are watercolor, but p1 and p10 — the only
      two pages carrying all five characters — came out photographic. Hypothesis: the cast-aware
      router sends full-cast pages down the composite path, which pastes photographic avatar
      cutouts. Worth confirming against `compositeOutcome` per page before any fix.
      → `server/lib/imageRouter.js`, `server/lib/sceneComposite.js`
- [ ] **A watercolour page rendered as a photographed painting (2026-08-26).** Same story p2: the
      illustration is depicted as a physical painting lying on a white surface, with paper edges
      and margins inside the frame instead of filling it. → `prompts/image-generation.txt`
- [ ] **Trial empty-scene plates never generate for variant-backed landmarks, so the PAGE edits a raw photo (2026-08-26).**
      `storyJobPipeline.js:1856` gates plate generation on `loc.photoFetchStatus === 'success'`. That status is
      only ever set by `prefetchLandmarkPhotos` (`landmarkPhotos.js:1370,1395`) — and the call site at
      `storyJobPipeline.js:2578` filters to `!l.photoVariants?.length`, so any landmark WITH photo variants is
      excluded from the prefetch entirely and keeps `'pending_lazy'` forever. Variant-backed Swiss landmarks are
      the normal modern case, so the gate can never pass. Measured: prod `job_1787647410717_5dvfqu8jg`
      ("Bahnhof Stettbach", `isSwissPreIndexed=true`, `photoVariants=2`, `photoFetchStatus='pending_lazy'`) and
      staging `job_1787696601288_bfgznq960` — both ZERO `empty_scene` rows.
      NOT merely the streaming race: the `landmarksReady` barrier (declared `:602`, awaited only by covers at
      `:1214`) would resolve immediately here, since the landmark is not in the prefetch set at all. The fix is
      to resolve the plate's photo the variant-aware way pages already use
      (`getLandmarkPhotosForScene` -> `pickVariantForView` -> `loadLandmarkPhotoVariant`), not to await the barrier
      and not to loosen the status check.
      Consequence: with no plate, `packReferences` promotes the raw landmark photograph into a Grok slot
      (`grok.js:1113-1124`, `!hasSceneBackground`), so the page becomes an EDIT of a real photo — prod p1 got 3
      refs vs 2 elsewhere and is the only non-watercolour page (real bystanders, garbled SBB board). The trial
      empty-scene feature believed active since `decisions.md:1514` is effectively inert.
      NOTE: `decisions.md:12530` settled that the photo BELONGS in the plate's reference slot, so the fix is to
      make the plate exist, not to remove the photo. Also `validateEmptyScene` has no style/photorealism check,
      so a photographic plate passes QC even in full mode.
      -> `storyJobPipeline.js:1843-1917,2578`, `server/lib/grok.js:1113-1124`, `server/lib/landmarkPhotos.js`

- [ ] **Trial sends the whole 2x4 character sheet as the page reference instead of the matching pose (2026-08-26).**
      The intended design is already one-pose: `cropAvatarCell` (`sceneComposite.js:936`) exists and the full
      pipeline uses it (`storyJobPipeline.js:3303-3310`). On the trial path it no-ops for two independent
      reasons. (1) `projectStoryCharacterAvatars` reads ONLY `char.avatars.styledAvatars[artStyle]`
      (`storyAvatars.js:62`); the DB reload clears that to `{}` (`storyJobPipeline.js:6267-6270`) and trial
      seeds its sheets via `setStyledAvatar`, which writes the module cache only — so the map is empty and
      `applyStoryCellRefs` hits `if (!story) continue` (`storyAvatars.js:237`) leaving the full sheet in
      `photoUrl`. (2) Trial passes raw character records from `getCharactersInScene`, which carry no
      `pose`/`perspective`, so `resolveCellPose` would return `threeQuarter` for every page anyway, and no
      `closeUp` flag is passed. Verified on prod `job_1787647410717_5dvfqu8jg` p2: the stored reference image
      is the full 8-panel sheet. Known cost of whole-sheet refs: Grok reproducing the sheet, scored -140
      (`decisions.md:10189`, `:10703`).
      → `storyJobPipeline.js:1046-1055`, `server/lib/storyAvatars.js:56-99,230-240`, `server/lib/styledAvatars.js:543,1149`
- [x] A closed prop reference cannot serve a page that needs the prop OPEN — ADDRESSED 2026-08-26 by the two-entry rule (turned away / face to camera); unverified, see the verify item below — prod job_1787689073034_1v6ew0y1kae p9 ("looking up from the book") rendered the open book flat to camera. The reference fixes the carried case; the read case still rests on 12d prose alone.
- [ ] **Trial pages still send the whole 2x4 sheet, not the pose cell (2026-08-26, OPEN).** Landmark half of
      the same work is fixed and verified; this half is not. Every page's stored ref is `photoType=bodyNoBg`,
      never `cell-*`. Reproduced against PERSISTED data locally: the projection and `applyStoryCellRefs` both
      work (`cell-threeQuarter-headbody`), so the fault is purely WHEN the sheet lands on the character vs
      page render. `publishStyledAvatarsToCharacters` at the end of `prepareStyledAvatars` did not close it.
      The silent `continue` paths in `applyStoryCellRefs` are now loud, so the next trial names the reason —
      look for `[CELL REFS] ... sending the FULL reference image`. Two paid trials already spent; do not
      re-run blind. → `server/lib/storyAvatars.js:233-250`, `storyJobPipeline.js:1046-1095`
- [ ] Verify the two-entry face-prop rule on a real story — that the bible emits a pair with matching identity, that the Art Director names exactly one per page (never both), and that a page needing the face gets it. Replaces referenceView, which was verified; the pair is not. → docs/decisions.md 2026-08-26
- [ ] finalScore does not reconcile with its stored breakdown (prod dragon p18: 45 with visual 100, entity 0, no findings) — every deduction must be attributable from the stored record → `server/lib/scoring.js`
- [ ] Entity clothing check now catches the covers but still misses one page. Two calls per grid shipped 2026-08-27 (identity on the head grid, wardrobe on the body grid, one image each) after five single-call prompt wordings measured 0 findings. Verified 8 grids: 1 TP / 1 FN / 0 FP, 8 identity findings kept, zero cross-leakage. The miss is p12 of job_1787689073034_1v6ew0y1kae (grid 5 cell C) — same garment, same character, caught on grid 6. → docs/decisions.md 2026-08-27 "Entity consistency runs two calls per grid"
- [ ] **Book audit IMG faults are noisy — tighten before any of them may trigger a repaint (2026-08-26, OPEN).** Adding the staging clause to the CONTRADICTION question took the prod dragon story from 17 to 30 faults and caught p16, but much of the growth is "the picture shows the moment slightly before/after the words" nitpicking (an expression not conveying breathlessness, a figure "already standing" rather than "entering"). Question 3 (ONPAGE) invites it. Measure-only today, so it costs nothing — but it is not a repair signal yet. → `prompts/book-audit.txt`, docs/decisions.md 2026-08-26 "The final-book audit"
- [ ] **The staged-confrontation case is still not caught by the book audit (2026-08-26, OPEN).** Prod `job_1787689073034_1v6ew0y1kae` p12 stages a confrontation with every figure side by side facing the viewer; three replays flagged p12 only for unexplained missing characters. The visual-flow pass independently shows `facing=camera` on p9–p13, so the signal exists in the data — a cross-check between `timeFlow[].facing` and the page's declared interaction may catch it where prose alone does not. → `prompts/book-audit.txt`, `server/lib/styleConsistency.js`
- [ ] **Book-audit TEXT round has never run on real faults (2026-08-26, OPEN).** All three replays routed 0-1 TEXT faults and the corrective round is only exercised inside the pipeline, which was never run. The triple-store update (`expandedScenes` / `allImages` / rebuilt `fullStoryText`) is written and syntax-checked but unverified end-to-end. → `storyJobPipeline.js` (book-audit block), docs/decisions.md 2026-08-26
- [ ] **`bestSource` and the pinned `activeVersion` disagree on at least one shipped page (2026-08-26, OPEN).** Prod `job_1787689073034_1v6ew0y1kae` p14: `bestSource=original` (imageVersions index 0) while `image_version_meta` pins `activeVersion=4` (`style-repair-grok`). 17 of 18 pages agree. Every consumer that resolves "the shipped image" by one rule alone will read a different picture than the reader saw on that page; `bookAudit.shippedVersionIndex` takes the pin when given one, but no other consumer was audited. → `server/lib/bookAudit.js`, `server/services/database.js` `rehydrateStoryImages`
- [ ] Subject pages (cast 0) hit two `length === 0 → use everyone` fallbacks: `entityConsistency.js:1587-1590` falls back to the whole story roster when a page's prose names nobody, and `repairPipeline.js:283` (`wanted.size === 0`) picks every character as the style-reference pool. Both should skip. → docs/decisions.md 2026-08-26
- [ ] Verify subject pages end-to-end on a real staging run — the planner replay proved the PAGE PLAN designates them, but nothing has yet rendered or evaluated a zero-cast page. → prompts/story-beats.txt PAGE PLAN
- [ ] **The first 37 of 59 minutes produce nothing the customer can see.** Measured on prod job_1787689073034_1v6ew0y1kae: outline/text stages 0–37 min, first page image 38 min, finalize 59 min. The spinner now says so honestly, but the shape is the issue — decide whether something can be shown earlier (a cover first, or each page as it finishes) rather than a half-hour of carousel. → docs/decisions.md 2026-08-26 spinner entry
- [ ] **Withhold only genuine ex-municipalities from the merged parent (2026-08-28, OPEN, owner deferred).** Matching a landmark to BOTH its village and its municipality means a Baden story may still be offered the Turgi bridge, ranked below Baden's own. Exact fix: a free Wikidata pass over ~1,700 localities to tell a former independent municipality (Turgi, Zurzach) from an internal hamlet (Bärau, Oberwil), then exclude only the former from the parent. Village-only matching is NOT the fix — measured, it strands 327 municipalities with zero landmarks. → docs/decisions.md 2026-08-28 "A landmark answers to BOTH its village and its municipality"
- [ ] **Some Swiss landmarks are typed wrong in `landmark_index.type` (2026-08-28, OPEN — count NOT measured).** Surfaced steadily while judging: a road bridge typed `Castle` (id 5206), a valley typed `Cathedral` (14014), a mountain peak typed `Castle` (19560), airfields typed `Square`, a fish ladder typed `Castle`. The two-score model neutralises them for selection (a wrong-subject photo scores near 0), so this is quality, not a live defect. Re-typing from the stored judge `reason` text is the obvious route and is exactly the prose-pattern-matching CLAUDE.md forbids for eval logic — decide the approach before writing code. → `landmark_photo_scores.reason`, docs/decisions.md 2026-08-28
- [ ] **8 Swiss images can never be judged — the Commons file will not download (2026-08-28, OPEN).** 9437_3 (a 360° panorama), 3350_2, 11382_2, 11382_3, 8394_2, 6661_2, 2496_4, 9563_2. Each belongs to a landmark whose other slots ARE judged, so no town lost coverage. They stay `story_score`-neutral until someone re-fetches them at a smaller width. → `scripts/admin/prep-landmark-judging.js` `thumbUrl()`
- [ ] **292 Swiss landmark rows have no image at all (re-measured 2026-08-29, OPEN — free sources exhausted).** Distinct from the 8 undownloadable ones: there is nothing to fetch. The claim that they are "excluded by `HAS_PHOTO_SQL` so they never reach a story" was WRONG — that constant only ever SORTED. Until 2026-08-29 a town whose only row was photoless suppressed the proximity fallback and the story was set at a place nobody can draw (Ehrikon → Ruine Alt-Wildberg, a castle demolished by fire c.1320). Fixed: a match with nothing servable now falls through to proximity. Two independent free passes (Wikidata P18 + Commons category; Wikipedia lead image) yielded only 6 of 295, so the remainder are ruins with nothing standing, alpine peaks and tiny chapels. Anything further needs a NON-Wikimedia source. → `scripts/admin/fetch-landmark-photos-free.js`, `docs/landmark-database.md` §7
- [ ] **Duplicate images across landmark ids (2026-08-28, OPEN).** Judges reported byte-identical files under different ids (1013/1014, 4556/4557, 7738/7739, 30898/30899) and several rows storing the same picture in two slots. Wastes a judged slot and can serve the same photo twice in one story. A checksum pass over `photo_url` would find them. → `landmark_photo_scores`
- [ ] **Stored images rotated 90° (2026-08-28, OPEN — count NOT measured, judges flagged them ad hoc).** Found by looking, across every slot tier (e.g. 5937, 8437, 8455, 10823, 11396, 12726, 17889, 32032). They are scored on what they show, so a good subject sideways keeps a mid photo score and can still be selected. Either auto-rotate on fetch via EXIF or drop them. → `scripts/admin/prep-landmark-judging.js`
- [ ] **Grok failed 8 of 16 page primaries on one staging run (2026-08-29, OPEN — routing NOT decided, needs the owner).** `job_1787959478282_bz19gm36h`: 6 pages were rescued by the Gemini fallback (they carry 4-7 `grokRefImages` — the unpacked Gemini part list, not a slot breach) and 2 (p1, p3) were lost entirely because the fallback's three sanitization levels also failed. Those two now get one guarded retry and a loud `data.missingImages` flag, but the underlying primary-failure rate is untouched and no routing change was made or authorised. Decide with the owner in `docs/image-routing.md`, and read `docs/SETTLED.md` on `IMAGE_OTHER` first — the shape of the answer is likely the unbuilt "fallback across both models", not a flip of the default. → `server/lib/images.js` `_dispatchImageGeneration`, docs/decisions.md 2026-08-29
- [x] **The auto-index trigger runs paid, unbounded work on a user request (2026-08-29, FIXED).** An already-indexed town no longer triggers discovery at all (`townAlreadyIndexed()` in `server/lib/landmarkPhotos.js`). Previously the 146 Swiss towns whose landmarks were all judged under 40 looped forever: lookup filtered them out, discovery re-found the same Wikipedia places, the indexer re-saved them, `story_score` was preserved so they stayed filtered — and the next cold cache repeated it at ~30 landmarks of paid analysis a turn. Also closed the hole where discovery results bypassed `JUDGED_USABLE_SQL` and served the very landmarks the judge rejected. Remaining (unchanged, still owner's call): the trigger is still fire-and-forget and unbounded for genuinely NEW towns. → `docs/landmark-database.md` §8
- [ ] **790 of 2,264 Swiss towns have no scene-settable landmark (measured 2026-08-29, OPEN).** 35% of towns offer nothing a scene can be set at — the biggest single type in the index is 1,508 `City` rows, the `(Stadt)` aerials, which are overviews not settings. Wikipedia geosearch is largely tapped for towns already searched; the untapped sources are Wikidata P131 per municipality (not radius-bound, so it finds what geosearch missed), Commons categories per municipality, and the federal heritage inventories (KGS / ISOS). Scope with the owner before running anything — this is a project, not a follow-up. → `docs/landmark-database.md` §12
- [ ] **`server/routes/admin/landmark-index.js` is dead code (2026-08-29, OPEN).** It defines 8 endpoints near-identical to the mounted `swiss-landmarks.js` router, but is required by nothing and mounted nowhere; the client calls neither path. Delete after a grep, per the codebase-audit convention. → `server/routes/admin/index.js`
- [ ] **16 landmark rows hold NON-FREE images uploaded locally to a language Wikipedia (found 2026-08-29, OPEN — owner's call).** Their `photo_url` is `/wikipedia/de|it|.../` rather than `/wikipedia/commons/`. Commons accepts only freely-licensed media, so a local upload is where fair-use files live — and the list bears that out: six are corporate LOGOS (EFG Swiss Open Gstaad, Cyprus University of Technology, Ersparniskasse Affoltern, Evangelisch-reformierte Landeskirche GR, Flugplatz Konstanz, Hochschule für Jüdische Studien) plus the IOC-owned 1972 Olympic mascot Waldi. They surfaced because `backfill-landmark-attribution.js` could not find them on Commons — the credit lookup doubles as a licence check. We sell printed books, so this is commercial use of probably-unlicensed work; the images are also useless as scene references (a bank logo is not a setting). Two parts: (a) null those 16 photo slots, (b) make the fetchers refuse any URL that is not `/wikipedia/commons/`, so it cannot recur. → `scripts/admin/fetch-landmark-photos-free.js`, `server/lib/landmarkPhotos.js`, `docs/landmark-database.md` §11
- [ ] **Dev-mode arc panel renders the OLD arcReviewReport shape (2026-08-30, OPEN — cosmetic, dev-only).** The arc machine (create → panel → re-tell) stores its trail under the same `arcReviewReport` key with `machine: 'create-panel-retell'` and new fields (create, committed, rounds[], finalArc, critique); the client dev panel still expects the old drafted/analysis/audit fields, so machine runs show up incomplete there until the panel learns the new shape. Persistence and pipeline are unaffected. → `client/src/components/generation/StoryDisplay.tsx`, docs/decisions.md 2026-08-30 "The arc stage is the ARC MACHINE"
- Phantom vessels reappeared on antagonist solo pages (p2/p9 of job_1788123310558) — hazard rule holds for crew pages, breaks when the rival steers alone → scratchpad piraterun/images/page-review.html
- Antagonist style drift: Rossa renders comic-dark with olive/green skin (p14/p16, job_1788123310558) — suspect VB reference set/description → same review
- Pseudo-handwriting glyphs on parchments/cards on most pages despite no-text rule (job_1788123310558) → same review
- Glass-penetration impossibilities in museum/vitrine scenes (p6/p16) + toy-ship model never renders as a ship (job_1788123310558) → same review
- [x] **`Setting/location:` line makes the commission name the reader's home city as the binding world (found 2026-08-31, CLOSED 2026-08-31 — owner ruled "named location is binding"; `premiseNamedWorld` stamp + `buildSettingLine` relabel shipped, see docs/decisions.md "Named location is binding").** `buildStoryContextFields` injects IP-geo `userLocation` inside the commission block under "What this names is binding: … the world it happens in", so a premise that names another world (e.g. a sea voyage abroad) gets relocated home — 2/2 pirate validation runs, all 3 judges flagged it; the 2026-08-31 landmark-precedence prompt fix cannot beat it. Fix candidate: relabel as reader's home for landmark use only, not the story's setting. → `server/lib/promptBuilders.js:4059`, `:4368`; docs/decisions.md 2026-08-31 "Arc-machine refinement 4"
- Arc machine has no commission-compliance owner — most-repeated CRITICAL across all 2026-08-30/31 experiments (crew roster violations, bleak endings) is never caught internally, only by outside judges → scratchpad piraterun/arc-v3-final/, panel-analysis.md suggestion 3
- Arc machine does not persist its prompts (create/panel/retell) — only outputs; forensics needed a worktree reconstruction → persist assembled prompts in the trail (cheap, text-only)
- Proofread output leaked reasoning + withdrew a finding mid-line (job_1788123310558, p5 REPETITION «weisses Möwensegel» — "withdraw. Let me re-examine"); the withdrawn line still matches FAULT_LINE_RE so it may have been enforced — verify whether the corrective round acted on it, then harden the parser (ignore lines containing a withdrawal) → scratchpad piraterun/q2-map-redraw/
- Prose-level logic drift has no checker: writer changed beat's "none good enough" to «Jedes Mal hatte etwas nicht gestimmt» (unknowable-truth implication, p3, job_1788123310558); text audit compares to beats too loosely, book audit TEXT route is all text-vs-picture; scene reviewer also skipped p3 entirely → same scratchpad dir
- Semantic evaluator grades images against beats SCENE while images are generated from the AD brief — 2 unjust penalties on job_1788123310558 (p6 CRITICAL, p9 MAJOR); feed the evaluator the AD brief → scratchpad piraterun/q3-beats-vs-ad/
- AD batch scene-expansion silently truncated after p11 (likely output cap), pages 12-16 fell back to weak per-page prompt without continuity rules; 4/5 carry flagged issues; single usage label hides it — fail loudly + raise cap → same dir
- [x] No camera-coherence rule in beats/AD — DONE 2026-08-31 (beats redesign 75fc965e9: one-camera rule in story-beats.txt + plate-side rule in both AD templates)
- [x] AD receives neither arc nor page plan — DONE 2026-08-31 (beats redesign 75fc965e9: FINAL_ARC + per-page PLAN line into scene-expansion-all)
- Beats review is the serial killer of story content (Q6/Q7/Q8/Q9 all trace to it): silently strips events, rivals, persuaders; per-page change-field + beats-level redundancy check + re-site-or-declare rule proposed; page budget sums to 15/16 (one page bought by nothing) → scratchpad piraterun/q8-p12/
- VB bible schema invites skin-tone prose clichés ("warm olive skin"); owner ruling 2026-08-31: do NOT request skin tone at all — drop it from the face field schema → scratchpad piraterun/q1-rossa-vb/
- Beats-review checks overhaul for the post-SCENE shape (change-field check, redundancy check, re-site-or-declare rule) — separate campaign; 2026-08-31 redesign only made the template consistent → scratchpad piraterun/q8-p12/
