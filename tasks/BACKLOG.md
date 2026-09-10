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

Last full sweep: **2026-09-06**.

---

## P0 — gating the production promotion

- [ ] Verify on staging before promoting to master — **36 commits ahead as of 2026-09-06**
      (`origin/master..origin/staging`; the "259 commits" figure in the source file is from
      2026-07-20 and has since been promoted). Always compare ORIGIN refs: a naive
      `master..staging` gives 1756 because the LOCAL master ref is stale at 2026-07-10
      → `docs/compliance-and-todo.html:81`
- [ ] Confirm location-verify + the landing #418 fix with a fresh showcase
      → `docs/compliance-and-todo.html:83`

---

## In flight

- [ ] Run the landmark-photo R2 backfill to completion on prod — ~19,374 slots at 2 s ≈ 11 h in the
      background: `node scripts/admin/backfill-landmark-photos-to-r2.js` (resumable; re-run until
      "0 slot(s) still without an R2 copy"), then sync to staging → `docs/landmark-database.md` §11 Photo storage

- [ ] Analyzer worker architecture — session-scoped worker processes, recyclers deleted;
      staging verification pending (photo upload, 4-page smoke, Lab experiment, RSS ~53MB idle)
      → `tasks/analyzer-workers-2026-08-23.md`

## Image quality — unresolved render defects

- [ ] **Planner obeys "one action per page" for the instant but parks the effect in the after-segment instead of a new page** — dragon rerun 2026-09-09: strike line clean, no release page, water never arrives in any instant; next step if wanted = code-side clause counter on the instant segment → `docs/decisions.md` (2026-09-09 one-action entry, Measured)
- [ ] **Plates come back letterboxed inside the 1:1 canvas** (painted margins on all three refix8 plates; the location reference cell is 2:1) and the plate copies props from the location reference cell that the `emptyScenePrompt` omits (trough on the strike page) → `docs/decisions.md` (2026-09-09 one-action entry, Measured)
- [ ] **Baden eval B4 — duplicate/ghost props undetected** (hat twice p3, pompom p12, kettle on the
      initial page); no prop-multiplicity / prop-vs-VB check → `tasks/baden-eval-2026-09-06.md:B4`
- [x] **Baden eval B5 — closed 2026-09-06: staging runs a single repair pass on purpose (owner)** → `tasks/baden-eval-2026-09-06.md:B5`
- [ ] **Baden eval B6 — white-box plate failure retried twice, bad plate kept; wrong tower on p2/p10** → `tasks/baden-eval-2026-09-06.md:B6`
- [ ] **Baden eval B7 — diagnose why sanitisation misses standalone-id `preserve` entries (p8).**
      The cleaner IS wired — `feedbackConsolidator.js:458-467` sanitises `instruction`, `fix_draft`,
      `fix_critique` AND maps `preserve` through the same cleaner since 65d132d06 (2026-08-09), and
      `sanitizeVbIdsInPrompt` handles locations incl. `LOC005.1` sub-ids. The cause is elsewhere
      → `tasks/baden-eval-2026-09-06.md:B7`
- [x] (2026-09-06, 12b1aab37) **Baden eval I9 — season consistency stated, not measured** (p6 yellow vs p3/p5 copper) → `tasks/baden-eval-2026-09-06.md:I9`
- [ ] **Baden eval I11 — invented children's ages unconstrained** (scarf boy 11–12 beside a 6-year-old) → `tasks/baden-eval-2026-09-06.md:I11`
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
- [x] (2026-09-06, edd75f3c2) **The brief checks run once, before the scene review — a rewrite can create a new
      violation nobody re-checks (exp 830).** CLOSED: `beatsPipeline.js:1491-1530` re-runs `checkBriefs`
      post-review, splits `beats_brief_introduced` / `beats_brief_unfixed`, plus a targeted second review
      round. Original finding: p8 was flagged for two actions; the reviewer merged
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
      on pages carrying a map, letter or note. **Needs re-measurement, not re-coding: hardened
      since by 34e46855a, 3dcc6c5d6, 969eba010 — needs a scored re-run, not a new fix.**
      → `docs/decisions.md` (2026-08-23 entries)
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
      prod despite `style_repair`; three candidate causes listed in the routing doc.
      **Needs re-measurement, not re-coding: code moved since (40ac24430 restored watercolour's
      anti-photo clauses, plus 3f1b05f4a, 0a3049bce) — needs a scored re-run, not a new fix.**
      → `docs/showcase-2026-08-10-findings.md:40`, `docs/image-routing.md:163`
- [ ] **`garment-recolour` makes pages much worse** (p14: 30 → −80). Independently measured
      2026-08-20: recolour children swing 100 → 0 semantically on several prod pages.
      **Needs re-measurement, not re-coding: code moved since (d11cf70d0, c61ff290c, 1dcdb3c09 all
      attacked its failure mode) — needs a scored re-run, not a new fix.**
      → `docs/showcase-2026-08-10-findings.md:69`
- [ ] Verify char-repair fires on a **CRITICAL** page. Critical-only char-fix is settled BY DESIGN
      (8eb622229 makes CRITICAL findings mark a page bad and rank first; memory
      `project_repair_routing_settled`, 2026-09-04 — MAJOR entity findings are unrepaired on purpose),
      so `wasCharacterFixed` false on 14 non-critical pages is expected, not the bug it was filed as.
      The "logs nothing" half was fixed by 3a597b6c7 (one failure log)
      → `docs/showcase-2026-08-10-findings.md:52`
- [x] (2026-09-06, e4ca42a25) Fake handwriting rendered on a prop (p13) — blanket no-lettering guard restored
      (`image-generation.txt:3`); eval side D-23 `rendered_text` CATASTROPHIC (`image-evaluation.txt:162`);
      34e46855a quarantines declared lettering into solo reference calls
      → `docs/showcase-2026-08-10-findings.md:76`
- [ ] `costumeReads` sub-score has never been observed firing — unproven, not known broken
      → `docs/showcase-2026-08-10-findings.md:80`
- [x] (2026-09-06, c0d594a75) Back-cover "magicalstory.ch" unreliable (3/4 missing, 1 doubled) — cover
      templates retired; branding is no longer model-rendered: `coverTypography.js:140` BRAND_TEXT is
      composited deterministically in the back path (`:530-538`); font rotation 1e1fd0782
      → `tasks/showcase-bugs-2026-07-20.md:15`
- [ ] Figure detection fails on 4 known pages (Sarah initialPage bodyBox 69%×72% merged +
      faceBox mislocated; Sarah p2; Hans p3; Noah p9).
      **Needs re-measurement, not re-coding: the detection stack was rebuilt since (39b4d6b4c,
      225f57208, 14aa9d666) — needs a scored re-run, not a new fix.**
      → `tasks/showcase-bugs-2026-07-20.md:27-31`
- [ ] Detection guard fires but is not 100% — 3 residual `fixed=-` figures, bbox-cache
      suspected, staging-only. **Needs re-measurement, not re-coding: 329170a3e (cache keys on
      bytes) may have removed the suspected cause — needs a scored re-run, not a new fix.**
      → `tasks/showcase-bugs-2026-07-20.md:91`
- [ ] Lena's VB binding is name-only in the prompt → `tasks/showcase-bugs-2026-07-20.md:74`
- [ ] `som_identity_fallback=4` on smoke `job_1787250416967_9owpz1j3b` is unexplained (noted
      inside an otherwise-fixed bug entry) → `tasks/bugs.json`
- [x] (2026-09-06) Cover text — restamp route for the back cover: `coverTypography.js:787,820`
      `restampCover` / `restampServedCover` map `backCover` to `'back'` and throw on unknown keys
      → `docs/cover-text-rendering-research.md:229`
- [ ] Cover text: still not verified inside a full generation; and the cover prompt asks for
      naturalistic lighting AND a stylised look, so the evaluator penalises it
      → `docs/cover-text-rendering-research.md:229`
- [ ] Mitigation playbook for known image failure modes — deferred wholesale (hazard list in
      scene-expansion, matching eval checks, Lab validation)
      → `docs/image-failure-modes.md:35`
- [ ] Composite plate: `objects[]` never reaches the plate prompt, so PRIORITY 1's promise to
      render "every required object" has no source — the setting text is the empty-scene prompt,
      which by construction has no props. Needs its own section inside the 8000-char Grok budget
      the setting is already trimmed to fit → `docs/decisions.md` 2026-08-24 flat-lineup entry
      (the flat-lineup half of this item is FIXED in `143ed6f05`: pose resolver, compound
      interaction keys, and the fabricated left/right direction)
- [ ] Composite is **Lab-only — re-measure before any re-enable.** It is DISABLED in the pipeline
      (`storyJobPipeline.js:4584`: "Scene composite was killed 2026-05-16 — every page goes through
      the direct path"); only `testlab.js:4284` reaches `generateSceneComposite`, so the historical
      "0 pages out of every trigger" figure describes a path production no longer takes. See memory
      `project_scene_composite_killed`. Whether the gates are right or the plate is too weak is the
      open question → `docs/decisions.md` 2026-08-24 stage-frames entry
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
- [ ] The Gemini **fallback** refuses on this photo — accepted; Grok is primary. 21a6ce41b and
      7dbb45de4 corrected the framing: it is a broad safety refusal, not face-specific and not
      "Gemini blocks adults", and both avatar passes now default to Grok (`AVATAR_STYLE_BACKEND`)
      → `docs/tests/costumed-2x4-findings.md:95`
- [ ] Qwen composite: identity scores vs refs, 4-insertion drift, interacting poses and
      occlusion-order steerability all unmeasured
      → `docs/tests/qwen-composite-experiment.html:75`

---

## Story text quality — the review stages trade feeling for logistics

- [x] (2026-09-07) **Arc budgets ACTIONS, not just events; over-length word fault stops demanding deleted meaning** (job_1788727233899_1dpnym94p: 66 actions inside a met 6-event budget, 13/18 pages over the word band) → `tasks/action-budget-2026-09-07.md`
- [ ] **Baden eval I8 — pacing budget unenforced**, no page under 111 words at standard level → `tasks/baden-eval-2026-09-06.md:I8`
- [x] (2026-09-06, 4271daaa2) **Baden eval I10 — "Monday" parsed as an invented character** → `tasks/baden-eval-2026-09-06.md:I10`
- [ ] **Baden eval I12 — no friend is ever named in a making-friends book** → `tasks/baden-eval-2026-09-06.md:I12`
- [ ] **Baden eval I13 — cost $5.58 vs baseline; one 0/14 scene-expansion batch wasted** → `tasks/baden-eval-2026-09-06.md:I13`
- [ ] **The landmark mandate teleports a toddler book — 2 of 2 toddler stories (2026-08-25).** `story-trial.txt`'s
      LANDMARKS section says "At least one scene MUST take place at one of these real local
      landmarks", and toddler mode says "No journeys. The story begins where it happens." In staging
      story `job_1787683120734_qkgfbd86o` the two collided: pages 1-5 are on a pirate ship at sea,
      then p6 opens "Später sitzt Leynor am Stüssibrunnen in Dübendorf" — an unexplained teleport on
      the last page. Fix is a choice: drop the landmark requirement in toddler mode, or set the whole
      story at the landmark from p1. STILL OPEN after the 2026-09-04 age-band split — the rule now
      lives in the `routine` and `quest` band files, which both keep "opens and closes where the child
      really is". → `prompts/story-trial.txt` (LANDMARKS), `prompts/age-band-routine.txt`,
      `prompts/age-band-quest.txt`
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
      SUPERSEDED 2026-09-04 by the five whole-year age bands (0–1 routine, 2 quest, 3 tries,
      4 fear-choice, 5 journey, 6+ standard); the oldest-MAIN trigger rule was retained.
      → `tasks/toddler-mode-2026-08-25.md`, `docs/decisions.md` (2026-09-04 age-band entry)
- ~~The trial ignores reading level entirely~~ — **won't do (owner, 2026-08-25: "leave trial on 100
      words per page that is fine")**. `prompts/story-trial.txt:14` and `:181` hardcode "100–140 words
      per page" and never reference `{READING_LEVEL}`; the `1st-grade`-trial consequence is known and
      accepted. Recorded so it is not re-proposed → `tasks/toddler-mode-2026-08-25.md` §6

Full provenance trace of 15 defects in `job_1787638707796_x8272kcs22m` ("Levin und der kleine
Drache", 18p, de-CH). Measured: the writer's draft is the best prose state of the run; the arc
review, beats review and text refine each fix real faults by adding logistics and paying for
them by deleting an emotional or characterising sentence. Text refine alone: 14 faults fixed,
**8 emotional sentences destroyed, 3 new defects created.** All fixes below are prompt-only.

- [x] (2026-09-06, 4b346fb0d) **T3 — text refine invents plot to close an audit fault, destroying an obstacle.** "Max hat
      sein Velo durch das seichte Wasser geschoben" (p8) makes the p4 stream obstacle
      retroactively fake. The refiner has no "delete the detail" disposition, only "fix on a page"
      → `tasks/story-text-quality-2026-08-25.md:T3`
- [x] (2026-09-06, 4b346fb0d) **T5 — page-turn travel raised as a continuity fault → travelogue openers.** "Nach der
      Ruine steigen die vier Buben…", "Nach dem Flug…". The beats review had already ruled this
      "stands"; the text audit has no memory of it → `tasks/story-text-quality-2026-08-25.md:T5`
- [x] (2026-09-06, 4b346fb0d) **T2 — text refine deletes emotion to pay for logistics (8 measured deletions).** Includes
      "Er dreht sich fast um" (p4), the hesitation beat the beats review explicitly *mandated*.
      Needs a protected class + a deletion ledger → `tasks/story-text-quality-2026-08-25.md:T2`
- [x] (2026-09-06, 4b346fb0d) **T1 — prop bookkeeping written into BEAT instead of SCENE → "Julian hält die Folie" on
      7 pages.** The beats-review ledger routes around the writer's "do not narrate staging" rule
      Additionally SUPERSEDED: 824fb02d9 deleted beat prose, 75fc965e9 replaced SCENE with the
      PAGE PLAN line → `tasks/story-text-quality-2026-08-25.md:T1`
- [x] (2026-09-06, 4b346fb0d) **T6 — arc review closes an orphan prop by carrying it through 11 pages** (Max's Velo). No
      "retire the object" disposition → `tasks/story-text-quality-2026-08-25.md:T6`
- [x] (2026-09-06, 4b346fb0d) **T4 — clock times written into prose** ("am Nachmittag", "später Nachmittag") to patch an
      arc-level problem: a nightfall deadline starting on a "Sommermorgen"
      → `tasks/story-text-quality-2026-08-25.md:T4`
- [x] (2026-09-06, 4b346fb0d) **T8 / T11 / T13 — three missing checks, one clause each.** A build-up page whose action
      is taken by someone else (Max p5 → Julian p6); a final-challenge blocker that is never
      foreshadowed (the mist); an ending with a sentiment ceiling and no floor ("Niemand sagt
      viel.") → `tasks/story-text-quality-2026-08-25.md:T8`
- [x] (2026-09-06, 4b346fb0d) **T9(a) / T10 — reading level not re-checked after the writer** (p9 carries a 20-word
      nested clause at 1st-grade); no pacing check that the story's most-wanted image gets a page
      (the hatch happens between p2 and p3) → `tasks/story-text-quality-2026-08-25.md:T9`
- [ ] **T15 — `stories.data.dedication` is empty on a delivered book.** Undiagnosed: wizard never
      offered it, or it was collected and dropped → `tasks/story-text-quality-2026-08-25.md:T15`

## Tests

- [x] (2026-09-06) **3 unit tests fail on `staging` HEAD: `tests/unit/active-version-recompute.test.ts`** —
      re-ran 2026-09-06: 10 passed / 10, 0 failed (vitest 4.0.17). No longer reproduces.
      `recomputeAllActiveVersions` leaves `sceneImages[0].activeVersion` undefined where the test
      expects 1. Pre-existing (reproduced with all local changes stashed), found 2026-08-23 while
      verifying an unrelated change. Not filed in `tasks/bugs.json` because it is undiagnosed —
      could be the recompute path or a stale test, and a bugs.json entry blocks every push
      → `tests/unit/active-version-recompute.test.ts:113`

## Eval + scoring

- [x] **The arc judge was briefed with the beats commission, not the arc's** — `buildBriefContext`
      sent the full beats page budget and omitted the age-band file and arc budgets, so judges
      deducted on dimensions the age band forbids and the retell wrote a villain into a
      two-year-old's book. Fixed 2026-09-07 (`{ arc: true }` option)
      → `docs/decisions.md` "The ARC judge is briefed with the ARC commission"

- [ ] **A page can fail semantics outright and never trigger a redo (measured 2026-08-23).**
      `scoreThreshold: 50` gates on `finalScore`, computed over *consolidated* deductions, so
      semantic 0 can land at finalScore 60 and ship first try. 9 of 34 pages across two prod
      stories had semantic ≤50 with no regeneration; two scored a flat 0
      → `docs/interaction-load-2026-08-23.md`

Full detail for this whole section: `tasks/eval-variance-backlog.md` (recovered 2026-08-20
after `tasks/todo.md` was overwritten; the head of the original, including the A-section noise
measurement, is lost).

- [ ] **B1–B2 — emit a `subject` on clothing and object findings.** The CONSUMER plumbing already
      landed: 2bee3632c (the jury merges per `(bucket, subject)`) and `evalBuckets.js:265-353` carries
      subject through and warns that scoring bills per `(class, subject)`. What remains is the
      PROMPT-side emission — neither `prompts/image-evaluation.txt` nor `image-semantic.txt` instructs
      the evaluator to emit one — plus owner approval. Without it per-character billing degrades to
      per-page. Only 11% of `object_presence` and 3% of `setting` findings carry a subject today
      → `tasks/eval-variance-backlog.md`
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

- [x] (2026-09-09, c3028d793) **Trial funnel "Bezahlt" filter empty-state + paid bucket honours `gclid`** — `server/lib/trialSource.js` is the single bucket definition; `allSourcesVisits` lets the card say "no visits from this source". → `tasks/ads-reactivation-2026-09-09.md`
- [ ] **Trial claim breaks visit linkage: after an email claim `generation_completed` posts on a fresh visit_id with `user_id NULL`** (seen 2026-09-03, 2026-09-07). Likely the verify link opens in another browser context (no `trial_visit_id`/token) and `/event` only accepts anonymous tokens — design question, not verified from rows. Also: chatgpt.com deserves its own source bucket (5 of 8 trials). → `client/src/utils/trialFunnel.ts:150`, `server/routes/trial.js` event handler
- [x] (2026-09-06, e37e3194a) **E1 — confirm the GA4 conversion event actually fires** — CONFIRMED:
      `client/src/utils/gtagConversion.ts` defines 3 Ads conversions, wired in `TrialWizard.tsx` +
      `TrialGenerationPage.tsx`; `decisions.md:1500` records a conversion-goal decision taken ON real
      conversion data; e37e3194a fixed the consent default that was discarding attribution
      → `tasks/ads-quality-score.md:64`
- [x] (2026-09-06, a51316ad7 + 0d3fb7efd) Ads quality score A1 — ship the LCP fix to prod: both
      commits are present on `origin/master` for `client/index.html` → `tasks/ads-quality-score.md:21-61`
- [ ] Ads quality score: 16 remaining items — A6 re-measure, B1–B4 keyword and ad-group hygiene,
      C1–C8 asset audit, D1–D3 weekly tracking. All Google-Ads-account-side, not repo-verifiable
      → `tasks/ads-quality-score.md:21-61`
- [ ] Sentry error alerting; Plausible/Umami analytics → `docs/compliance-and-todo.html:87`
- [ ] Promote the referral programme on the **marketing site**. The in-app surface is NOT hidden:
      `AccountPage.tsx:12-18` renders code, balance and referral count, and `BookBuilder.tsx` +
      `MyOrders.tsx` consume it → `docs/compliance-and-todo.html:89`
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

- [ ] STR-1 — split `processUnifiedStoryJob` — **now ~6,559 lines (`storyJobPipeline.js:378-6937`,
      file total 7,570); it GREW ~40% since the ~4,600 estimate**; STR-2–STR-5 + VAR-1 each ship as
      their own PR → `docs/review-2026-07-04-structural-plan.md:3`
- [x] (2026-09-06) Split `generateImageWithQualityRetry` (761 lines) — **function DELETED** by the
      2026-08 pipeline unification; zero occurrences in `server/`, `client/src`, `storyJobPipeline.js`
      → `docs/scoring-simplification-review.md:170`
- [ ] Split `evaluateImageQuality` — now **~1,210 lines** (grew from the 1,058 estimate) and it MOVED
      to `server/lib/evalPipeline.js:822-2032`; re-cluster `images.js`; move `inpaintPage` (still
      un-moved at `server/lib/images.js:2617`); hoist the 10 closures in `runUnifiedRepairPipeline`
      (**~3,161 lines, `server/lib/repairPipeline.js:303-3464`; closures still inline — 9 arrow-function
      consts in the first 600 lines alone**);
      break the generation↔evaluation cycle → `docs/scoring-simplification-review.md:170`
- [ ] Dead code: unused `IMAGE_MODELS` import in `repairPipeline.js`; callerless
      `detectGrokBorder`; test-only exports; two competing "is this dressed" thresholds
      → `docs/scoring-simplification-review.md:170`
- [ ] Re-run the `eea385113` sweep (61.5% outfit omission); turn the destructure audit into a
      unit test → `docs/scoring-simplification-review.md:170`
- [x] (2026-09-06) Drop the legacy `pictureBook` / `outlineAndText` paths — **done**; the only
      surviving mentions are comments at `storyJobPipeline.js:7365` and `promptBuilders.js:3064`
      stating unified is the only pipeline → `docs/compliance-and-todo.html:114`
- [ ] Migration drift into CI — **nothing was wired: there is no `.github/` directory at all**;
      prune `scripts/_tmp_*.js` (**12 files still present**); collapse 40+ `refine-tell-vN.js`;
      inline base64 → R2 Phase 3;
      consolidate the three test-image panels → `docs/compliance-and-todo.html:114`
- [ ] REV-7 (P3) deferred minors: second poller lacks `knownPages`; `imgRowToBytes` is a
      hand-copied fork of `imgBytesAsync`; `dropInlineBase64` mutates shared refs
      → `docs/review-2026-07-04.html:124`
- [ ] `callGrokEdit` in coverComposite has no prompt-length guard before the Grok API call
      (other Grok paths shrink to the model's cap first) → `server/lib/coverComposite.js:416`

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

- [ ] **`vb_element_overflow` at birth is 5/5 pages, not ~0, after the assignment trim — the check counts the UNION of
      trimmed bible claims and the Art Director's `objects[]` citations (pirate p12: 3 + 3 = 6), and `briefFixable`
      is false on 8/10 pages although the brief could withdraw its citations; round 2 ADDED ids on dragon p12/13/16.
      Decide: count only one side, or make the AD cite from the trimmed claims. → `docs/decisions.md` 2026-09-08 "Art Director second pass"
- [ ] **`facing_not_per_character` fixes are partial on crowded pages** — dragon p18 (Max, Kiaan) and pirate p16 (three
      background figures) still had no facing clause after the reviewer's own rewrite. Re-measure on the next two
      stories before touching the check. → `docs/decisions.md` 2026-09-08 "Art Director second pass"
- [ ] Run a full trial on staging as admin; query `trial_events` for the complete ordered row
      trail for one `visit_id` → `tasks/todo.md:49`
- [ ] Confirm the admin card renders the funnel with real staging rows → `tasks/todo.md:51`
- [ ] T5 — take the **run-level proof** that styled avatars complete before page generation. The CODE
      half is proven: `storyJobPipeline.js:1856-1866` `onClothingRequirementsReady` starts avatar styling
      and it is awaited before page images (~`:4870`), with a comment documenting the ordering
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
- [ ] SEO theme pages — **the FEATURE shipped** (`/themes`, `/themes/:category`,
      `/themes/:category/:themeId` in `App.tsx:109-111`; metadata in `server/lib/seoMeta.js:363`).
      Only the VERIFICATION is outstanding: 13 unchecked steps (title/FAQ JSON-LD/sitemap/robots/
      hreflang/og:title, `/themes` in DE/EN/FR, Rich Results Test)
      → `docs/plans/2026-03-10-seo-theme-pages.md:479`
- [ ] Demo stories — test the setup-demo-user script; run the demo test locally
      → `docs/plans/2026-03-10-demo-stories.md:21`

---

## Decisions waiting on the owner

Nothing below should be coded until it is answered.

- [ ] **Round 2 of the scene review still re-introduces a code-detected fault round 1 cleared (dragon p1, 1 of 18 after
      the plan-line-authority fix; was 3).** Options: (a) ship flagged as today (`rewriteToZeroUnfixed` reports it);
      (b) mechanical guard — revert a round-2 page whose rewrite introduces a REVIEWABLE finding absent after round 1
      (code-detected types only, no prose classification); (c) let the reviewer's own tag lines (`[plate_contains_effect]`,
      `[facing_not_per_character]`, …) drive the round-2 subset — today only `sceneBriefCheck` types do.
      → `docs/decisions.md` 2026-09-08 "Art Director second pass"
- [ ] Approve the B1–B2 evaluator prompt change (`subject` field) → `tasks/eval-variance-backlog.md`
- [x] (2026-09-06) C1 targeted confirmation eval — **ALREADY DECIDED: DECLINED by the owner.**
      `docs/decisions.md` 2026-08-19 "False-clean pages are an ACCEPTED RISK": "Confirming every 100 with
      a second eval was offered and declined" (restated `:14904`) → `tasks/eval-variance-backlog.md`
- [ ] Trial: generate the 2×4 costumed sheet eagerly or lazily?
      → `tasks/story-scoped-avatars-plan.md:89`
- [ ] Cover/page unification — **the unification SHIPPED** (`decisions.md:8998`, 2026-08-10,
      "covers are pages with flags"); the `coverTitleMode` resolver and `iterateCover` precedence are
      settled (SETTLED.md, wiring 2026-09-03). **Surviving risks, re-scoped: keeping trial covers
      cheap, and the entity check on negative pages** — neither has a decisions.md entry
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
- [x] (2026-09-06, b3acb951c) **T14 — must every title contain the main character's name?** —
      **ANSWERED IN CODE.** `buildTitleRule()` in `server/lib/promptBuilders.js` branches on cast size:
      1 name required, 2 both, 3+ optional ("prefer what they do together"). Shipped 2026-08-25 19:47 CH,
      tested dc12c088e (20:33 CH) — the same evening T14 was written
      → `tasks/story-text-quality-2026-08-25.md:T14`

---

## Experiments proposed, none run

Seeded 2026-07-21. None of these is committed work — they are candidates.

- [ ] ~~Rewrite self-critique into per-page failure-mode verdicts~~ — **SUPERSEDED, retire.** It
      targets the `prompts/story-unified.txt` draft → self-critique → patch chain, which no longer
      exists: 2026-09-03 replaced it with two parallel audits, a merge, one repair and one lector
      (`decisions.md:24967`, `:25539`); the named questions shipped as plan-check Q5–Q7
      → `docs/testing-backlog.md`
- [x] (2026-09-06) Cross-model review A/B (Sonnet writes / Opus reviews) — **RUN, repeatedly**:
      beats-reviewer bake-off of 8 candidates 2026-08-15 (`models.js:146,231`), repair bake-off to
      claude-opus 2026-09-03 (`decisions.md:25244`), arc-auditor bake-off (`models.js:370`). The
      reviewer is now DeepSeek V4 Pro by measurement → `docs/testing-backlog.md`
- [ ] Extend the acceptance gate (count/position/location + simpler-shot fallback)
      → `docs/testing-backlog.md`
- [ ] Enum scene descriptors; palette-locked hex consistency → `docs/testing-backlog.md`
- [ ] Batch API + prompt caching, offline path only → `docs/testing-backlog.md`
- [ ] Scene-prose length A/B — 250–350 words vs the ~150 cap → `docs/testing-backlog.md`
- [ ] Ten ranked competitive follow-ups (Gemini 3.x vs Grok avatar A/B, layflat hardcover tier,
      persistent watermarked trial share link, on-demand landmark acquisition, SAM 3.1 concept
      prompting, local illuminant estimation, judge-ensemble gate, embedding identity score,
      typographic art direction). **#10 "production text-quality judge gate" was DEDUPED 2026-09-06 —
      it is the same open question as T9(b); tracked there, not here.**
      → `docs/testing-backlog.md:140`
- [x] (2026-09-06) Verify the claim that Sonnet 5 pricing moves $2/$10 → $3/$15 on Sep 1 —
      **CONFIRMED TRUE.** `server/config/models.js:1003-1006`: `claude-sonnet-4-6` and `claude-sonnet`
      are both `{ input: 3.00, output: 15.00 }` → `docs/testing-backlog.md:203`

---

## Backlog of decisions never written up

- [x] (2026-09-06) ~~why Grok is the avatar-face provider~~ — written up: `docs/SETTLED.md`
      ("Avatar passes 1 AND 2 default to Grok") plus the `IMAGE_OTHER` entries and 21a6ce41b
      → `docs/decisions.md:1710-1724`
- [ ] Three still unwritten: trial cover `onTitle` → `onCoverScene`; `extractTitle` legacy fallback
      conditions; cascade face-detection merge order → `docs/decisions.md:1710-1724`
      (the old `:1385` pointer was STALE — the list moved as the file grew to 28,235 lines)

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
- [x] (2026-09-06, 6daa2520f) Objects declared once get drawn 2-3 times — CLOSED: D-32 `duplicate_object` added (`prompts/image-evaluation.txt:160`, `evalBuckets.js:123`, MAJOR ceiling `scoring.js:178`, consolidator merge rule, unit test). Original finding: one rope rendered as three (staging p11), one book as two (prod p3).
- [ ] Cast members go missing without a finding — prod p7 drew 2 of 4 boys, p15 and p18 drew 3 of 4. The brief check only catches cast in the prose but absent from metadata, never the reverse.
- [x] (2026-09-06, a228bdeb1) `style_repair` repaints the COMPOSED cover — CLOSED: `styleRepair.js:227-238`
      now sources `${coverKey}Art` and the caller restamps via `composeCover`. Original finding: title text and all — it selected page -1 in Lab #837 and all three arms restyled the title instead of repainting `${key}Art` and restamping via `composeCover`. The text survived legibly this time; nothing guarantees it will. → `server/lib/styleRepair.js` (cover targets from `planStyleRepair`)
- [ ] The style gate cannot tell grain from brushwork — Lab #837 scored a noise-filtered photographic face as `better: 'after'`, "prominent brushstrokes". The content veto works (`changed: []` was right every time); the style half is credulous. → `server/lib/styleAnalysis.js` (`compareStyleProximity`)
- [ ] PARKED (owner, 2026-08-24): face-crop style repaint — crop the face box, repaint it at full frame so the face IS the image, composite back via the feathered insert-blend. Lab #837 measured Grok spreading repaint effort uniformly (face/rest = 1.07), so a small face gets almost none of it and the page still returns looking worked-on. Not rejected, not scheduled. → `docs/decisions.md` (Lab #837 entry)
- [ ] The **Gemini** style repaint arm changes the page ASPECT RATIO — `styleRepair.js:114-141` still picks a preset aspect, so a repaint that ships would silently re-crop the page or cover. The **Grok arm is FIXED** by 09037f6c2 (2026-09-03: aspect-drift crop enabled by default, `skipOutputCrop` opt-out). Original finding: 864x1222 in, 832x1248 out on all three Lab #837 arms. → `server/lib/styleRepair.js` (`repairPageStyle`, aspectRatio opt)
- [x] Verify the closed-prop reference actually flips the render — DONE 2026-08-24, 4 renders: closed ref works, face-free description is the required other half — 2 pages x 4 arms (baseline / closed ref / no ref / closed ref + OTS-egocentric text) in the Test Lab. Owner approved 2 pages 2026-08-24. → docs/decisions.md 2026-08-24 "drawn CLOSED"
- [ ] Orientation phrasing is still intrinsic ("angled toward herself"); GenSpace says egocentric final-image phrasing binds far better ("the plain reverse side faces the viewer"), and only "over-the-shoulder shot" / "shot from behind" are attested vocabulary. → prompts/scene-expansion-all.txt 12d
- [ ] Scale similes in a visual-bible description render literally — "roughly the size of two open palms" drew two human hands onto the parchment in a prop reference sheet. Phrase is live in production ART001. Compare a prop against a neutral object, or give size in cm. → prompts/story-bible-from-beats.txt artifact description hint
- [ ] A duplicated inset panel pasted over a page scored 100/100/100 — prod job_1787638707796_x8272kcs22m p15 has a rectangular crop of its own background composited into the lower-left corner and no evaluator axis caught it. No axis owns frame-level compositing artefacts.
- [ ] `cast_unlisted` prose side still needs the cast name in full — prose saying only "Rossa" for a bible figure "Kapitänin Rossa", with `characters[]` omitting her, is a known miss. Deliberately not widened (would false-positive on two-word bible names ending in a common noun); needs a measured case before changing. → docs/decisions.md 2026-09-01, asserted in tests/manual/sceneCastConsistency.test.js
- [x] Decide whether an INTRODUCED brief fault should trigger a second review round — DONE 2026-08-25: yes, targeted at ~$0.02 — the re-check now reports it, nothing fixes it, and the page ships. Costs one text call per affected story. → docs/decisions.md 2026-08-25
- [x] referenceView is applied inconsistently — MOOT 2026-08-26: referenceView replaced by two bible entries per face-prop, so the side is an id choice, not an optional field — staging job_1787638394061_hs70901tfsn has two maps; ART001 got the field, ART004 ("Rossas Kartenkopie") did not, though a map is squarely in the type list. The field is optional, so the bible author can just omit it.
- [ ] A visual-bible description still states who holds a prop — ART004 in the same story reads "held in one hand along its lower edge" and describes its face, against the rule that a description never says who holds/carries/wears it. → prompts/story-bible-from-beats.txt
- [x] CARRY_ROUTES is unexercised — EXERCISED 2026-08-25 in prod job_1787689073034_1v6ew0y1kae, all three routes fired — no story has yet run with a non-empty arc or beats audit carry block. Confirm on the next staging run that the block appears in the plan/Art Director/text prompts and that nothing regresses. → server/lib/beatsPipeline.js CARRY_ROUTES
- [ ] **Validate the 2026-08-25 review fixes on a live run**: first story in a low AGE BAND (toddler MODE no longer exists — bae4d540d replaced it with five whole-year age bands; use `routine` or `quest`) through the injected arc/beats reviewers, and first story with a non-empty REVIEWER'S RULINGS carry block → `docs/decisions.md` (2026-08-25 "Carried findings travel WITH the reviewer's rulings" entry)
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
- [x] (2026-09-06, 40c02edcd) **Trial empty-scene plates never generate for variant-backed landmarks, so the PAGE edits a raw photo (2026-08-26)** —
      CLOSED 2026-08-26: `storyJobPipeline.js:2005-2035` resolves via `resolveLandmarkPhotoForLocation`; the old
      `photoFetchStatus === 'success'` gate is removed; unit test `tests/unit/landmark-plate-resolve.test.ts` added.
      Original finding:
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

- [x] A closed prop reference cannot serve a page that needs the prop OPEN — ADDRESSED 2026-08-26 by the two-entry rule (turned away / face to camera); unverified, see the verify item below — prod job_1787689073034_1v6ew0y1kae p9 ("looking up from the book") rendered the open book flat to camera. The reference fixes the carried case; the read case still rests on 12d prose alone.
- [ ] **Trial pages still send the whole 2x4 sheet, not the pose cell (2026-08-26, OPEN).** Landmark half of
      the same work is fixed and verified; this half is not. Every page's stored ref is `photoType=bodyNoBg`,
      never `cell-*`. Reproduced against PERSISTED data locally: the projection and `applyStoryCellRefs` both
      work (`cell-threeQuarter-headbody`), so the fault is purely WHEN the sheet lands on the character vs
      page render. `publishStyledAvatarsToCharacters` at the end of `prepareStyledAvatars` did not close it.
      The silent `continue` paths in `applyStoryCellRefs` are now loud, so the next trial names the reason —
      look for `[CELL REFS] ... sending the FULL reference image`. Two paid trials already spent; do not
      re-run blind. Still OPEN 2026-09-06: `storyAvatars.js:242-268` still has three "sending the FULL
      reference image" warn paths — the loud logging shipped, the fix did not. (Merged 2026-09-06 with the
      earlier duplicate entry of the same defect: `cropAvatarCell` (`sceneComposite.js:936`) exists and the
      full pipeline uses it (`storyJobPipeline.js:3303-3310`); on the trial path
      `projectStoryCharacterAvatars` reads only `char.avatars.styledAvatars[artStyle]`
      (`storyAvatars.js:62`) which the DB reload clears to `{}`, and trial passes raw character records
      from `getCharactersInScene` carrying no `pose`/`perspective`. Known cost of whole-sheet refs: Grok
      reproducing the sheet, scored -140 — `decisions.md:10189`, `:10703`.)
      → `server/lib/storyAvatars.js:233-250`, `storyJobPipeline.js:1046-1095`,
      `server/lib/styledAvatars.js:543,1149`
- [ ] Verify the two-entry face-prop rule on a real story — that the bible emits a pair with matching identity, that the Art Director names exactly one per page (never both), and that a page needing the face gets it. Replaces referenceView, which was verified; the pair is not. → docs/decisions.md 2026-08-26
- [ ] finalScore does not reconcile with its stored breakdown (prod dragon p18: 45 with visual 100, entity 0, no findings) — every deduction must be attributable from the stored record → `server/lib/scoring.js`
- [ ] Entity clothing check now catches the covers but still misses one page. Two calls per grid shipped 2026-08-27 (identity on the head grid, wardrobe on the body grid, one image each) after five single-call prompt wordings measured 0 findings. Verified 8 grids: 1 TP / 1 FN / 0 FP, 8 identity findings kept, zero cross-leakage. The miss is p12 of job_1787689073034_1v6ew0y1kae (grid 5 cell C) — same garment, same character, caught on grid 6. → docs/decisions.md 2026-08-27 "Entity consistency runs two calls per grid"
- [ ] **Book audit IMG faults are noisy — tighten before any of them may trigger a repaint (2026-08-26, OPEN).** Adding the staging clause to the CONTRADICTION question took the prod dragon story from 17 to 30 faults and caught p16, but much of the growth is "the picture shows the moment slightly before/after the words" nitpicking (an expression not conveying breathlessness, a figure "already standing" rather than "entering"). Question 3 (ONPAGE) invites it. Measure-only today, so it costs nothing — but it is not a repair signal yet. → `prompts/book-audit.txt`, docs/decisions.md 2026-08-26 "The final-book audit"
- [ ] **The staged-confrontation case is still not caught by the book audit (2026-08-26, OPEN).** Prod `job_1787689073034_1v6ew0y1kae` p12 stages a confrontation with every figure side by side facing the viewer; three replays flagged p12 only for unexplained missing characters. The visual-flow pass independently shows `facing=camera` on p9–p13, so the signal exists in the data — a cross-check between `timeFlow[].facing` and the page's declared interaction may catch it where prose alone does not. → `prompts/book-audit.txt`, `server/lib/styleConsistency.js`
- [x] **Book-audit TEXT round has never run on real faults (2026-08-26) — MOOT, code removed 2026-09-01.** The post-repair final book audit (the only caller of this corrective round) was deleted per owner ruling — it wrote findings to a field with zero consumers. The capability survives as the on-demand Test Lab `book_audit` stage (report-only, no corrective round). → docs/decisions.md 2026-09-01 "Final post-repair book audit REMOVED"
- [ ] **`bestSource` and the pinned `activeVersion` disagree on at least one shipped page (2026-08-26, OPEN).** Prod `job_1787689073034_1v6ew0y1kae` p14: `bestSource=original` (imageVersions index 0) while `image_version_meta` pins `activeVersion=4` (`style-repair-grok`). 17 of 18 pages agree. Every consumer that resolves "the shipped image" by one rule alone will read a different picture than the reader saw on that page; `bookAudit.shippedVersionIndex` takes the pin when given one, but no other consumer was audited. → `server/lib/bookAudit.js`, `server/services/database.js` `rehydrateStoryImages`
- [ ] Subject pages (cast 0) hit two `length === 0 → use everyone` fallbacks: `entityConsistency.js:1587-1590` falls back to the whole story roster when a page's prose names nobody, and `repairPipeline.js:283` (`wanted.size === 0`) picks every character as the style-reference pool. Both should skip. → docs/decisions.md 2026-08-26
- [ ] Verify subject pages end-to-end on a real staging run — the planner replay proved the PAGE PLAN designates them, but nothing has yet rendered or evaluated a zero-cast page. → prompts/story-beats.txt PAGE PLAN
- [ ] **The first 37 of 59 minutes produce nothing the customer can see.** Measured on prod job_1787689073034_1v6ew0y1kae: outline/text stages 0–37 min, first page image 38 min, finalize 59 min. The spinner now says so honestly, but the shape is the issue — decide whether something can be shown earlier (a cover first, or each page as it finishes) rather than a half-hour of carousel. → docs/decisions.md 2026-08-26 spinner entry
- [ ] **Withhold only genuine ex-municipalities from the merged parent (2026-08-28, OPEN, owner deferred).** Matching a landmark to BOTH its village and its municipality means a Baden story may still be offered the Turgi bridge, ranked below Baden's own. Exact fix: a free Wikidata pass over ~1,700 localities to tell a former independent municipality (Turgi, Zurzach) from an internal hamlet (Bärau, Oberwil), then exclude only the former from the parent. Village-only matching is NOT the fix — measured, it strands 327 municipalities with zero landmarks. → docs/decisions.md 2026-08-28 "A landmark answers to BOTH its village and its municipality"
- [ ] **Some Swiss landmarks are typed wrong in `landmark_index.type` (2026-08-28, OPEN — count NOT measured).** Surfaced steadily while judging: a road bridge typed `Castle` (id 5206), a valley typed `Cathedral` (14014), a mountain peak typed `Castle` (19560), airfields typed `Square`, a fish ladder typed `Castle`. The two-score model neutralises them for selection (a wrong-subject photo scores near 0), so this is quality, not a live defect. Re-typing from the stored judge `reason` text is the obvious route and is exactly the prose-pattern-matching CLAUDE.md forbids for eval logic — decide the approach before writing code. → `landmark_photo_scores.reason`, docs/decisions.md 2026-08-28
- [ ] **8 Swiss images can never be judged — the Commons file will not download (2026-08-28, OPEN).** 9437_3 (a 360° panorama), 3350_2, 11382_2, 11382_3, 8394_2, 6661_2, 2496_4, 9563_2. Each belongs to a landmark whose other slots ARE judged, so no town lost coverage. They stay `story_score`-neutral until someone re-fetches them at a smaller width. → `scripts/admin/prep-landmark-judging.js` `thumbUrl()`
- [ ] **~300 Swiss landmark rows have no image at all (OPEN — free sources exhausted; the SERVING harm is fixed).** A photoless row can no longer strand a town: since 2026-09-01 a match with nothing servable falls through to proximity (42 towns, 41 improved, 0 regressions). What remains is pure coverage.** Distinct from the 8 undownloadable ones: there is nothing to fetch. The claim that they are "excluded by `HAS_PHOTO_SQL` so they never reach a story" was WRONG — that constant only ever SORTED. Until 2026-08-29 a town whose only row was photoless suppressed the proximity fallback and the story was set at a place nobody can draw (Ehrikon → Ruine Alt-Wildberg, a castle demolished by fire c.1320). Fixed: a match with nothing servable now falls through to proximity. Two independent free passes (Wikidata P18 + Commons category; Wikipedia lead image) yielded only 6 of 295, so the remainder are ruins with nothing standing, alpine peaks and tiny chapels. Anything further needs a NON-Wikimedia source. → `scripts/admin/fetch-landmark-photos-free.js`, `docs/landmark-database.md` §7
- [ ] **Duplicate images across landmark ids (2026-08-28, OPEN).** Judges reported byte-identical files under different ids (1013/1014, 4556/4557, 7738/7739, 30898/30899) and several rows storing the same picture in two slots. Wastes a judged slot and can serve the same photo twice in one story. A checksum pass over `photo_url` would find them. → `landmark_photo_scores`
- [ ] **Stored images rotated 90° (2026-08-28, OPEN — count NOT measured, judges flagged them ad hoc).** Found by looking, across every slot tier (e.g. 5937, 8437, 8455, 10823, 11396, 12726, 17889, 32032). They are scored on what they show, so a good subject sideways keeps a mid photo score and can still be selected. Either auto-rotate on fetch via EXIF or drop them. → `scripts/admin/prep-landmark-judging.js`
- [ ] **Grok failed 8 of 16 page primaries on one staging run (2026-08-29, OPEN — routing NOT decided, needs the owner).** `job_1787959478282_bz19gm36h`: 6 pages were rescued by the Gemini fallback (they carry 4-7 `grokRefImages` — the unpacked Gemini part list, not a slot breach) and 2 (p1, p3) were lost entirely because the fallback's three sanitization levels also failed. Those two now get one guarded retry and a loud `data.missingImages` flag, but the underlying primary-failure rate is untouched and no routing change was made or authorised. Decide with the owner in `docs/image-routing.md`, and read `docs/SETTLED.md` on `IMAGE_OTHER` first — the shape of the answer is likely the unbuilt "fallback across both models", not a flip of the default. → `server/lib/images.js` `_dispatchImageGeneration`, docs/decisions.md 2026-08-29
- [x] **The auto-index trigger runs paid, unbounded work on a user request (2026-08-29, FIXED).** An already-indexed town no longer triggers discovery at all (`townAlreadyIndexed()` in `server/lib/landmarkPhotos.js`). Previously the 146 Swiss towns whose landmarks were all judged under 40 looped forever: lookup filtered them out, discovery re-found the same Wikipedia places, the indexer re-saved them, `story_score` was preserved so they stayed filtered — and the next cold cache repeated it at ~30 landmarks of paid analysis a turn. Also closed the hole where discovery results bypassed `JUDGED_USABLE_SQL` and served the very landmarks the judge rejected. Remaining (unchanged, still owner's call): the trigger is still fire-and-forget and unbounded for genuinely NEW towns. → `docs/landmark-database.md` §8
- [ ] **790 of 2,264 Swiss towns have no scene-settable landmark (measured 2026-08-29, OPEN).** 35% of towns offer nothing a scene can be set at — the biggest single type in the index is 1,508 `City` rows, the `(Stadt)` aerials, which are overviews not settings. Wikipedia geosearch is largely tapped for towns already searched; the untapped sources are Wikidata P131 per municipality (not radius-bound, so it finds what geosearch missed), Commons categories per municipality, and the federal heritage inventories (KGS / ISOS). Scope with the owner before running anything — this is a project, not a follow-up. → `docs/landmark-database.md` §12
- [ ] **`server/routes/admin/landmark-index.js` is dead code (2026-08-29, OPEN).** It defines 8 endpoints near-identical to the mounted `swiss-landmarks.js` router, but is required by nothing and mounted nowhere; the client calls neither path. Delete after a grep, per the codebase-audit convention. → `server/routes/admin/index.js`
- [x] **16 landmark rows held NON-FREE images uploaded locally to a language Wikipedia (found 2026-08-29, FIXED 2026-09-01).** Cleared on prod AND staging (url, description and credit together), and `isFreelyLicensedImageUrl()` now rejects any `/wikipedia/<lang>/` file at both write paths — `saveLandmarkToIndex` and the free fetcher, which UPDATEs directly and bypassed it. Original finding: Their `photo_url` is `/wikipedia/de|it|.../` rather than `/wikipedia/commons/`. Commons accepts only freely-licensed media, so a local upload is where fair-use files live — and the list bears that out: six are corporate LOGOS (EFG Swiss Open Gstaad, Cyprus University of Technology, Ersparniskasse Affoltern, Evangelisch-reformierte Landeskirche GR, Flugplatz Konstanz, Hochschule für Jüdische Studien) plus the IOC-owned 1972 Olympic mascot Waldi. They surfaced because `backfill-landmark-attribution.js` could not find them on Commons — the credit lookup doubles as a licence check. We sell printed books, so this is commercial use of probably-unlicensed work; the images are also useless as scene references (a bank logo is not a setting). Two parts: (a) null those 16 photo slots, (b) make the fetchers refuse any URL that is not `/wikipedia/commons/`, so it cannot recur. → `scripts/admin/fetch-landmark-photos-free.js`, `server/lib/landmarkPhotos.js`, `docs/landmark-database.md` §11
- [ ] **Dev-mode arc panel renders the OLD arcReviewReport shape (2026-08-30, OPEN — cosmetic, dev-only).** The arc machine (create → panel → re-tell) stores its trail under the same `arcReviewReport` key with `machine: 'create-panel-retell'` and new fields (create, committed, rounds[], finalArc, critique); the client dev panel still expects the old drafted/analysis/audit fields, so machine runs show up incomplete there until the panel learns the new shape. Persistence and pipeline are unaffected. → `client/src/components/generation/StoryDisplay.tsx`, docs/decisions.md 2026-08-30 "The arc stage is the ARC MACHINE"
- Phantom vessels reappeared on antagonist solo pages (p2/p9 of job_1788123310558) — hazard rule holds for crew pages, breaks when the rival steers alone → scratchpad piraterun/images/page-review.html
- Antagonist style drift: Rossa renders comic-dark with olive/green skin (p14/p16, job_1788123310558) — suspect VB reference set/description → same review
- Pseudo-handwriting glyphs on parchments/cards on most pages despite no-text rule (job_1788123310558) → same review
- Glass-penetration impossibilities in museum/vitrine scenes (p6/p16) + toy-ship model never renders as a ship (job_1788123310558) → same review
- [x] **`Setting/location:` line makes the commission name the reader's home city as the binding world (found 2026-08-31, CLOSED 2026-08-31 — owner ruled "named location is binding"; `premiseNamedWorld` stamp + `buildSettingLine` relabel shipped, see docs/decisions.md "Named location is binding").** `buildStoryContextFields` injects IP-geo `userLocation` inside the commission block under "What this names is binding: … the world it happens in", so a premise that names another world (e.g. a sea voyage abroad) gets relocated home — 2/2 pirate validation runs, all 3 judges flagged it; the 2026-08-31 landmark-precedence prompt fix cannot beat it. Fix candidate: relabel as reader's home for landmark use only, not the story's setting. → `server/lib/promptBuilders.js:4059`, `:4368`; docs/decisions.md 2026-08-31 "Arc-machine refinement 4"
- Arc machine has no commission-compliance owner — most-repeated CRITICAL across all 2026-08-30/31 experiments (crew roster violations, bleak endings) is never caught internally, only by outside judges → scratchpad piraterun/arc-v3-final/, panel-analysis.md suggestion 3
- Arc machine does not persist its prompts (create/panel/retell) — only outputs; forensics needed a worktree reconstruction → persist assembled prompts in the trail (cheap, text-only)
- Proofread output leaked reasoning + withdrew a finding mid-line (job_1788123310558, p5 REPETITION «weisses Möwensegel» — "withdraw. Let me re-examine"); the withdrawn line still matches FAULT_LINE_RE so it may have been enforced — verify whether the corrective round acted on it, then harden the parser (ignore lines containing a withdrawal) → scratchpad piraterun/q2-map-redraw/
- [x] Prose-level logic drift has no checker — CLOSED 2026-09-02: writer changed beat's "none good enough" to «Jedes Mal hatte etwas nicht gestimmt» (unknowable-truth implication, p3, job_1788123310558); text audit compared to beats too loosely, book audit TEXT route was all text-vs-picture, scene reviewer also skipped p3 entirely. Fixed by the owner-approved "arc is the master" rule: `story-text-audit.txt` LOADBEARING question (12) + a matching writer-contract line in `story-text-from-beats.txt`. → docs/decisions.md 2026-09-02 "The arc is the master — a load-bearing fact must survive into the text"
- Semantic evaluator grades images against beats SCENE while images are generated from the AD brief — 2 unjust penalties on job_1788123310558 (p6 CRITICAL, p9 MAJOR); feed the evaluator the AD brief → scratchpad piraterun/q3-beats-vs-ad/
- AD batch scene-expansion silently truncated after p11 (likely output cap), pages 12-16 fell back to weak per-page prompt without continuity rules; 4/5 carry flagged issues; single usage label hides it — fail loudly + raise cap → same dir
- [x] No camera-coherence rule in beats/AD — DONE 2026-08-31 (beats redesign 75fc965e9: one-camera rule in story-beats.txt + plate-side rule in both AD templates)
- [x] AD receives neither arc nor page plan — DONE 2026-08-31 (beats redesign 75fc965e9: FINAL_ARC + per-page PLAN line into scene-expansion-all)
- [x] Beats review is the serial killer of story content (Q6/Q7/Q8/Q9 all trace to it): silently strips events, rivals, persuaders; per-page change-field + beats-level redundancy check + re-site-or-declare rule proposed; page budget sums to 15/16 (one page bought by nothing) — MOOT 2026-09-01: the beats reviewer this targeted was deleted outright (replaced by counters + plan-check, then the Lab-only remnant retired), not patched → scratchpad piraterun/q8-p12/, docs/decisions.md 2026-09-01 "Old beats review/audit machinery deleted"
- VB bible schema invites skin-tone prose clichés ("warm olive skin"); owner ruling 2026-08-31: do NOT request skin tone at all — drop it from the face field schema → scratchpad piraterun/q1-rossa-vb/
- [x] Beats-review checks overhaul for the post-SCENE shape (change-field check, redundancy check, re-site-or-declare rule) — separate campaign; 2026-08-31 redesign only made the template consistent — MOOT 2026-09-01: the beats reviewer (story-beats-review.txt) was deleted, not overhauled → scratchpad piraterun/q8-p12/, docs/decisions.md 2026-09-01 "Old beats review/audit machinery deleted"
- [x] **Body character repair on busy multi-figure pages — DONE 2026-09-01 (G7 deep fix).** Root cause was NOT model behaviour to gate away: git archaeology showed the pre-spine fullScene design (d68bd8815 → 2026-07-11 union composite) NEVER trusted the model's background — it feathered only the old∪new figure union onto the ORIGINAL scene, so a whole-scene re-render was harmless by construction and the path never rejected. Stage-3 (24842d2bd) put it behind the crop-space gate battery and 2026-08-06 added a bg-residual hard reject premised on "the model edits in place" — false for Grok box mode → 100% refusal. Fixed: bg residual is registration telemetry (never a reject); new FIGURE registration (scale+shift, feet-anchored) normalises in-place redraws before the unchanged IoU/style/white-card/sharpness/naturalness gates. → docs/decisions.md 2026-09-01 "Background mismatch is registration telemetry", tasks/bugs.json `edit-mode-char-repair-gate-battery-regression`, scratchpad piraterun2/g7-deep/
- Landmark photo descriptions: ~10,000 `photo_description[_N]` slots are NULL (fetch-landmark-photos-free rows); prep/merge scripts shipped 2026-09-02, the agent describing run itself has not been done → scripts/admin/prep-landmark-descriptions.js, docs/landmark-database.md §11
- [x] (2026-09-06) ~~Pre-existing unit-test failures on staging HEAD~~ — re-ran 2026-09-06: 10/10 pass (vitest 4.0.17). Original finding: tests/unit/active-version-recompute.test.ts 3/10 fail ("blob mirror" assertions expect storyData.sceneImages[0].activeVersion stamped, get undefined) — reproduced on clean HEAD a53c7262c with the repair working tree stashed, so it predates the 2026-09-02 repair commit; triage whether recomputeAllActiveVersions dropped the blob stamp or the test is stale → tests/unit/active-version-recompute.test.ts:83
- **`parseVisualBibleObjects` has ALWAYS returned `[]` for real prompts (found 2026-09-02, verified empirically at HEAD and on the stored pirate prompts).** Its section regex `/\*\*REQUIRED OBJECTS[^*]*\*\*:?\s*([\s\S]*?)(?=\n\n|\*\*[A-Z]|$)/i` carries the `i` flag, so the `\*\*[A-Z]` lookahead matches the very FIRST `* **entry**` bullet — the capture group is always empty and no object name is ever extracted. Consequence: `images.js:2376` merges nothing into `expectedObjects`, and the bbox/entity path has been running on `sceneMetadata.objects` alone. Fix is one character (`(?=\n\n|\n\*\*[A-Z]|$)` or dropping `i`), but it would newly feed English short refs to GroundingDINO on EVERY page — a behaviour change on the whole corpus, so it needs owner sign-off, not a silent patch. → `server/lib/bboxDetection.js:92`, `server/lib/images.js:2376`
- **Legacy composite blend boilerplate still promises object descriptions that no longer exist (2026-09-02).** `sceneComposite.js:1769` tells the model to "render each one according to its description" from the brief's REQUIRED OBJECTS — now a name-only checklist. Legacy branch only (fires when `cast` is empty; production takes the `people.length` branch), so cosmetic. Reword when that branch is next touched. → `server/lib/sceneComposite.js:1769`, docs/decisions.md 2026-09-02 "Visual Bible element detail is Art-Director-mediated"
- **The VB grid REFERENCE IMAGE is an unfixable-by-text channel for hull lettering and phantom vessels (measured 2026-09-02, Lab exp 975).** After REQUIRED OBJECTS went name-only, p2 of `job_1788295892348_l028ggiq7a` still rendered a second complete ship with "Golden Gull" painted on the stern — the prompt provably no longer carries the name, so the source is the Visual-Bible grid image, which depicts the vessel's whole exterior including its painted name and is attached to every page. Options: drop VEH/large-LOC entries from the page grid, crop them to a detail, or accept. Owner call. → `server/lib/referenceSheets.js` (`buildPageCompositeRefs`), docs/decisions.md 2026-09-02 "Visual Bible element detail is Art-Director-mediated"
- **AD rules 11d/8f are shipped but unproven on images (2026-09-02).** Lab exp 975 deliberately reused the OLD stored briefs so the prompt-builder change was the only variable, so "Aboard is not alongside" and "True relative size" have text evidence only (exp 974: p5's brief stopped mixing an outside camera with an on-deck figure; p9's brief still described the hull and figurehead of the ship it is aboard — rule 11d only partly obeyed). Needs a beats run or a scene_expansion_ab arm before it can be called effective. → `prompts/scene-expansion.txt:48`, `prompts/scene-expansion-all.txt:50`
- [ ] Fault-hunt 2026-09 remaining findings: design tier awaiting owner (raw-photo-as-sheet, canonical-cell loop, scale dual meaning, spec_conflict, self-graded repairs, no-photo bootstrap, VB extractedDescription) + unfixed medium/low list -> tasks/fault-hunt-2026-09-02.md
- [x] **A cast-0 page gets no landmark PHOTO — CLOSED 2026-09-02** (owner: "of course they must get a landmark"). `refMode: 'off'` dropped `landmarkPhotos`, so a landmark establishing shot with nobody in it rendered a real place from prose alone. `'off'` now drops CHARACTER photos only and keeps the plate, the VB grid and the landmark photos; worst-case packing measured at 2 of 3 Grok slots. → `server/lib/clothingResolve.js` `applyReferenceMode`, docs/decisions.md 2026-09-02 "A cast-0 page gets no plate"
- Cover regen route reports a bogus `qualityScore: -40` (empty issue list, `finalScore` 100, zero deductions) — reproduced 2026-09-03 on `job_1788380714660_4p9mr11xszu` frontCover v1 AND pre-existing on `job_1786235099497_ytd5c7eek` initialPage v1 (2026-08-08, composited mode), so it predates the baked-title wiring. The stored `scoreBreakdown.visual.reasoning` is the visual-INVENTORY JSON, not a scored eval, which is the likely source. Cosmetic today (the consolidated score is what ships) but it is the number the regen UI shows → `server/lib/coverIterate.js:951` (`evaluateImageQuality` call), `server/lib/evalPipeline.js`
- Baked cover titles are wired into first generation on staging (2026-09-03) but **promotion to production still needs owner-judged covers from real staging runs** — the flag stays `perEnvironment({ staging: 'baked', default: 'composited' })` until then, and promoting it is a SETTLED.md reversal → `server/config/runtime.js:69`, docs/decisions.md 2026-09-03 "The baked cover title is wired into FIRST GENERATION"
- **Plate QC judges only white-box pixels — it has no CONTENT check (2026-09-03).** The empty-scene plate gate measures white/flat area and nothing else, so it passed plates that render the wrong thing: `job_1788380714660_4p9mr11xszu` p9 and p15 shipped a ship-on-a-hillside plate. A plate that is geometrically clean but depicts the wrong setting is invisible to the gate. → `server/lib/evalPipeline.js` (empty-scene QC), docs/decisions.md
- **Secondary characters are invisible to the entity-consistency eval (2026-09-03).** The antagonist Rossa rendered male on 3 pages of `job_1788380714660_4p9mr11xszu` and entity consistency produced ZERO findings across the whole story — the eval only ever interrogates the primary cast. The VB sex rule reduces the chance of the render being wrong but does not close the eval hole. → `server/lib/entityConsistency.js`
- **Per-page Gemini evaluator has no pixel-level white-box check (2026-09-03).** `job_1788380714660_4p9mr11xszu` p2 scored 100 while carrying a ~20% white band — the evaluator reasons about content, never measures the frame, so a pillarboxed page is a perfect score. Pairs with the aspect-drift crop (decisions.md 2026-09-03) which removes the commonest cause but not the blind spot. → `prompts/image-evaluation.txt`, `server/lib/evalPipeline.js`
- **Style drift is PHOTOGRAPHIC on re-renders and nothing attributes it (2026-09-03).** p4 and p9 of Lab exp 975 plus the p2 plate came back photoreal against an illustrated book. Distinct from the Rossa comic-dark drift above (that one is a VB reference-set suspicion): here the drift appears specifically on re-render/plate paths and no owner has been assigned to the class. → `server/lib/repairPipeline.js` style audit, `docs/image-routing.md`
- **Sarah/Saira aural-name confusion — no name-distinctness rule at the arc stage (2026-09-03, owner decision pending).** Two cast names one phoneme apart make the read-aloud ambiguous and the text audit cannot tell which character a line means. The fix belongs at the arc/commission stage (reject or rename before anything downstream), which is a prompt change on every story — needs the owner's call on whether to enforce it. → `prompts/story-beats.txt` arc stage
- **Arc logic holes are a class, not incidents — candidate arc-critique question (2026-09-03).** Unshown transitions (a state change the reader never sees) and rule-breaking beats (a beat that violates a constraint the arc itself established) recur across runs and no internal pass asks about them; outside judges catch them. Shape: one load-bearing critique question, same pattern as the 2026-09-02 "arc is the master" rule. → `prompts/story-beats.txt`, docs/decisions.md 2026-09-02
- **VB counts conflate identity numbers with tallies (2026-09-03).** "three iron straps" in a Visual Bible description is part of the object's IDENTITY (it is the three-strap chest), not a per-page instruction to count to three — but the count rules treat both alike, so a page is judged on a number that was never a scene requirement. Needs a finer rule separating identity numerals from countable tallies. → `prompts/scene-expansion.txt`, `server/lib/visualBible.js`
- **Repair and legacy templates still teach pointing composition (2026-09-03).** `prompts/scene-repair.txt` and `prompts/scene-iteration-free.txt` still instruct pointing/gesture-at composition that the main generation templates dropped, so a repaired page can regress to a composition the generator no longer produces. → `prompts/scene-repair.txt`, `prompts/scene-iteration-free.txt`
- **p2 plate mood drift traces to a self-contradictory AD brief (2026-09-03).** The brief for `job_1788380714660_4p9mr11xszu` p2 carried LOCATION describing night and FRAMING describing morning; the plate obeyed one and the page the other. The AD template has no internal consistency check between its own sections. → `prompts/scene-expansion.txt`, `prompts/scene-expansion-all.txt`
- **The wearer parenthetical leaks into the clothing checklist lead (2026-09-03).** The per-page clothing checklist's lead line carries the "(worn by X)" parenthetical that is meant as builder-side annotation, so the model reads the annotation as part of the garment description. → `server/lib/promptBuilders.js` `buildClothingDescription`
- **No server-side path to regenerate a VB element reference sheet (2026-09-03, Lab stage candidate).** Element sheets are produced once during generation; when one is wrong (bad prop, wrong scale, leaked lettering) there is no endpoint or Lab stage to re-render just that sheet, so the only remedy is a whole new story. → `server/lib/referenceSheets.js`, `docs/reference_testlab_howto` add-a-stage recipe
- **Postgres page cache still holds the pre-vacuum pages — a service RESTART is what actually lowers the Railway bill (2026-09-03).** After the purge + `VACUUM FULL` (prod 391→278 MB, staging 655→374 MB) the OS page cache keeps the old files resident; Linux evicts only under memory pressure. Staging Postgres still averaged 1.13 GB. `railway redeploy --service Postgres` (per environment) is blocked by the local permission classifier and needs the owner to run it. → `docs/decisions.md` 2026-09-03 "Test-data retention", `reference_railway_cost_api`
- **One production `characters` row still carries 3.7 MB of inline base64 (2026-09-03).** `db-housekeeping.js --apply` would move it to R2 (violates the no-images-in-JSONB rule) but the write to the production DB was blocked twice by the permission classifier. Staging's equivalent row was migrated. → `scripts/admin/db-housekeeping.js`
- **Staging self-shutdown needs two variables set before it does anything (2026-09-03).** `server/lib/idleShutdown.js` is built, gated and tested but ships inert; it arms only when `STAGING_IDLE_SHUTDOWN=true` and `RAILWAY_API_TOKEN` are set on the staging service. Railway's own `sleepApplication` is now `true` on `MagicalStory / staging` but cannot fire, because `sweepStaleJobs` and `checkStripeRetryBuffer` each query Postgres every 5 min against a 5-min outbound-silence threshold. Owner ruled 2026-09-03 to arm the self-shutdown and keep sleeping as a backstop. → `server/lib/idleShutdown.js:171` (gates), `server.js:2623`, `server.js:2675`, docs/decisions.md 2026-09-03 "Staging idle cost"
- **Prod `files` holds 29 MB of inline `order_pdf` blobs in 2 rows while 20 others use R2 URLs (2026-09-03).** Real order data, so deliberately excluded from the purge; migrating the two blobs to R2 would reclaim ~29 MB of the remaining 278 MB. → `scripts/admin/purge-test-data.js` (files table is never touched)
- **68 `orders` rows point at story ids that no longer exist (2026-09-03, pre-existing).** Includes a literal `story_id = 'NaN'` and bare-timestamp ids (`1765241213715`) from an id scheme predating `job_*`; all from Dec 2025–Apr 2026 and NOT caused by the purge (order-referenced stories are protected). Unclear whether any represent a paid order whose story is gone. → `orders` table, `scripts/admin/purge-test-data.js` protection query
- [ ] landmark_index #23682 "Vallée du Doubs" is typed Castle but is a river valley; retype (and describe its 4 photos, skipped in the 2026-09-03 description run) → scripts/admin/backfill-landmark-types.js
- [x] **MAJOR entity findings route to NO repair method — CLOSED 2026-09-04, owner ruled: keep critical-only.** Owner reviewed the piraterun5 (`job_1788471969309_9cg9dqyirre`) p3/4/12 MAJOR findings visually (Lorena's missing facial markings, Saira face drift) and ruled "major is actually quite good, no need to redo" — MAJOR entity findings are deliberately unrepaired; char-fix stays exactly-`critical` (commit 504a5faf2). Do not re-propose lowering the gate or prompt-side escalation without new evidence + the reversal protocol. → docs/decisions.md 2026-09-04
- [ ] landmark_index rows typed Castle but named after a river/village (#6652 Torneresse, #6536 Saint-Aubin FR, #6660 Villars-sous-Mont, #27275 Stein SG; #10938 Torrone di Nav is a peak typed Bridge, its 3 landscape photos were discarded 2026-09-04 as "no landmark"; #6968 Tête de Ran is a summit typed Castle and #8893 Nierlet-les-Bois a village typed Bridge — their photos are held back undescribed): retype; their held-back photos still need descriptions → scripts/admin/backfill-landmark-types.js
- **Split the Python analyzer into its own Railway service (2026-09-04, owner-chosen, PLANNED not started).** The web container carries a Python ML stack whose shared objects sit permanently in the cgroup page cache Railway bills — measured by `mincore(2)`: 1,361 MB attributable of 1,603 MB resident, led by libtensorflow_cc 378 MB, libtorch_cpu 185 MB, libllvmlite 154 MB. `anon` also peaks at 9.85 GB during the illustration burst inside the container serving users. The seam is clean: every call site resolves `PHOTO_ANALYZER_URL`, and the in-flight cap self-sizes from the analyzer's own cpu_quota. → `tasks/analyzer-service-split-2026-09-04.md`, docs/decisions.md 2026-09-04
- **TensorFlow is 415 MB resident for one quality gate (2026-09-04).** It exists solely for `deepface`'s ArcFace avatar-likeness scoring at `photo_analyzer.py:3500`. `/face-embedding-onnx` already exists at `photo_analyzer.py:3858` and `onnxruntime` is already installed, so the replacement may be largely built — but `arcfaceGate: 0.45` must be re-validated against known same/different pairs first, because a different embedding implementation moves the scores. → `photo_analyzer.py:3500`, `server/config/runtime.js` arcfaceGate
- **`llvmlite` holds 153.6 MB of resident page cache and is not in requirements.txt (2026-09-04).** A transitive dependency (numba, via some package) that nothing obviously calls. Trace what pulls it and whether it can go — cheapest available saving if it is dead weight. → `requirements.txt`
- **`/api/health/memory` reports only the analyzer's ROUTER process (2026-09-04).** `photo_analyzer.py:105` spawns short-lived workers per role; the endpoint measures the parent, so it understated the container by >1 GB mid-run and missed a 9.85 GB `anon` peak entirely. The `cgroup` block added the same day exposes the truth, but the `python` field still misleads anyone reading it during a story. → `server/routes/health.js`
- **1.80 GiB of git history still holds the 1,050 removed test images (2026-09-04).** Untracking stopped them shipping, but every clone still pays for them; only a history rewrite reclaims it, which is destructive and needs coordination across the parallel sessions. → `.gitignore` tests rules, commit f46832896
- **Landmark PRESERVE-exactly wording overrides the era/no-modern-elements rule (2026-09-04, piraterun5 p4/5).** The landmark-fidelity block's preserve-the-photo instruction outranked the era guard, so modern bicycles from the reference photo shipped into a pirate-era story — needs a prompt-precedence fix + Lab check → server/services/prompts.js landmark block
- **Text-repair may not alter counts the plan fixed (2026-09-04, piraterun5 p13).** The text-refine repair rewrote a group of three figures into five after the plan had fixed the number — candidate repair-prompt rule: staged counts are load-bearing and repairs must keep them → prompts text-refine/repair templates
- [x] (2026-09-05) 5 landmark photos cannot be copied to R2: corrupt source JPEGs on Commons (VipsJpeg "Invalid SOS parameters") — slots dropped in the description sweep (#11382_2/3, #12026_3, #9437_3 panorama over pixel limit, #3350_2 source 404); every remaining photo has an R2 copy → scripts/admin/backfill-landmark-photos-to-r2.js
- [x] (2026-09-05) ~~Phantom guide images for the avatar sheet's cell 4/8 still show a pure 180° back~~ — CLOSED, was a misdiagnosis. Opened the actual `phantom-watercolor-adult-axes.png`: cells 1/2/4 are all the SAME front-facing mannequin, only the arrow overlay changes — there was no rival back-view image to blame. The real blocker was the literal phrase "back view" anchoring Grok's render regardless of qualifiers; renaming the pose to "REAR TURN" (dropping "back view" wording entirely for cells 4/8) fixed it, live-tested against a real character. See `docs/decisions.md` 2026-09-05, commit `ca8287441`.
- **`planCounters.js`'s fixed plan-quality quotas don't scale down for short books with a large cast (found 2026-09-04, owner-scoped fix not yet implemented).** A 4-page book with 5 commissioned characters needs ≥2 close-ups + ≥2 ultra-wides + ≥1 solo + ≥1 peopleless page (`planCounters.js:209-236`) PLUS every character in frame on ≥2 pages (`:286-293`) — arithmetically more page-roles than a 4-page book can hold, which forced a real re-plan to strip a story-load-bearing character (Hans) out of the climax page to manufacture an artificial solo page, breaking text/image agreement (see `job_1788378719225_8hpr0mzzh` page 4). Owner chose the fix location (scale the code-side quotas in `planCounters.js` by page count, not a prompt-side or minimum-page-count fix) but the conversation moved to the arc-per-character bug before this was implemented — still open. → `server/lib/planCounters.js:167-236`
- **Two analyzer model files have never been in the deployed image (2026-09-04).** `blaze_face_short_range.tflite` (MediaPipe, `photo_analyzer.py:168` and `:797`) and `yolo11n-pose.pt` (`POSE_WEIGHTS`, the `/pose-heads` endpoint used by the 2×4 sheet head-row check) exist on dev machines but are untracked and absent from production — `ls /app/*.tflite /app/*.pt` on the running container returns only `lbpcascade_animeface.xml` and `mobile_sam.pt`. So MediaPipe face detection falls back to Haar and `/pose-heads` cannot be working in production; `character2x4Sheet.js` degrades to Gemini for the head-row check and logs a warning nobody reads. `Dockerfile.analyzer` deliberately reproduces this rather than silently fixing it inside a refactor. Decide: bake them in (they are 228 KB and 6 MB) or delete the dead code paths. → `photo_analyzer.py:168`, `photo_analyzer.py:2024` `/pose-heads`, `Dockerfile.analyzer` COPY list
- **The 2026-09-04 landmark minimum fails EVERY themed showcase entry that takes the home-town idea (found 2026-09-05).** `storyJobPipeline.js:2466` fails a job outright when `premiseNamedWorld === false` and the story stages fewer than two real landmarks. `premiseNamedWorld` is decided by WHICH idea is chosen — index 0 plays in the reader's home town, index 1 in a make-believe world — and the demo spec used to always click `.first()`. A superhero/pirate/mermaid story that must also build in two real Swiss landmarks is a contradiction the writer cannot satisfy; it retries once and dies. Killed `job_1788558535073_dm6qxomqe` at 56%. Fixed in the spec (themed entries now take index 1), but the same trap applies to any caller that picks an idea positionally, and to a user who picks the home-town idea and then adds a fantasy world in the wizard — that path is unguarded. → `storyJobPipeline.js:2466`, `server/lib/premiseWorld.js`, `tests/demo-story.spec.ts` idea selection
- **`englishEntityRef` chops a description at 12 words with no clause awareness (2026-09-06).** `visualBible.js:661` slices `description.split(/[.;
]/)[0]` to 12 words, so a VB-id substitution can end on a dangling conjunction — ART001 on `job_1788641639919_mpjwlzkf1` resolves to "small hat knitted from chunky red wool, dome-shaped at the crown with". Pre-existing at every `sanitizeVbIdsInPrompt` call site since `5da568617`; the 2026-09-06 leak fix widens where it shows (the consolidator input and the evaluators' interaction blocks now use it too) but does not cause it. Trim on a clause boundary, or prefer `entry.type` the way the NAME pass already does. → `server/lib/visualBible.js:657`, docs/decisions.md 2026-09-06
- [x] (2026-09-06) **A page's two-step text compresses into one un-drawable instant** — the PLAN line joined "presses forehead against a pane" and "turns to the other child" with a trailing clause; scene expansion hardened it into head-on-surface + eye contact off to the side, and the render dropped the declared essential interaction, leaving two children nose-to-nose in a close-up (`job_1788641639919_mpjwlzkf1` p2). Corpus: 4 pages / 3 stories / 82 plan pages (4.9%). FIXED prompt-side on both generator and critique; `sceneBriefCheck.js` deliberately untouched (semantic, not deterministic). → `tasks/cover-cast-and-eval-fixes-2026-09-06.md` §3, `prompts/story-beats.txt:39`, `prompts/scene-expansion.txt` 7e, `prompts/scene-review.txt` check 7, docs/decisions.md 2026-09-06
- [x] (2026-09-06) **Cover hint casts could name a phantom and drop a real character** — the beats bible writer wrote "The smallest girl (centre front, facing viewer)" into the back cover of `job_1788641639919_mpjwlzkf1` and dropped primary Margaret; the phantom key spread to characterDetails/characterClothing/characterPerspectives, only 4 references were packed and the eval raised an unrepairable `missing_character`. FIXED: prompt rule + `validateCoverHintCast()` drops unresolved names and refills slots from the real cast before persistence. → `tasks/cover-cast-and-eval-fixes-2026-09-06.md`, docs/decisions.md 2026-09-06
- [ ] **Lab replay stages resolve their own model default instead of the one production uses (2026-09-06).** `runStoryTextReplayStage` picks `params.textModel || MODEL_DEFAULTS.outline`, while the production page-text writer picks `modelOverrides.textModel || MODEL_DEFAULTS.storyText` (`beatsPipeline.js:382`). They agree today only because both constants are `claude-sonnet`; change either and the Lab silently stops measuring what production runs, with nothing to signal the drift. Found while A/B-ing a writer-prompt change on exp 992 — cost a false "different model" caveat in the reported result. Check the sibling replays too: `scene_review_replay` falls back to `outlineReviewModel`, `story_bible_replay` resolves its own. Fix: each replay reads the SAME constant its production stage reads. → `server/lib/testlab.js` `runStoryTextReplayStage`, `runSceneReviewReplayStage`, `runStoryBibleReplayStage`; `server/lib/beatsPipeline.js:382`
- [ ] **`textRefineReport` prompt/briefsIn/analysis are forward-only — existing stories still show an empty Text-Überarbeitung analysis (2026-09-06).** `b63d71552` writes the three fields at generation time; nothing backfilled. For stories already in the DB, `analysis` IS recoverable from `roundTrace[].analysis` (10,429 ch on `job_1788641639919_mpjwlzkf1`), `briefsIn` partially from `pages[].before` (changed pages only — 12 of 14), and `prompt` is unrecoverable (never persisted before). Options: a read-side fallback in the shared `renderDiffPanel`, or a backfill migration. Owner asked to be given the choice; not yet made. → `client/src/components/generation/StoryDisplay.tsx` `renderDiffPanel`, `storyJobPipeline.js` textRefineReport projection, docs/decisions.md 2026-09-06
- [ ] **A staging deploy killed a running Test Lab experiment despite the idle gate (2026-09-06).** Exp 991 (`story_text_replay`) was left stranded at status `running` with zero log lines while `/api/health/busy` reported `busy:false` — nine commits from other sessions landed during its run and a deploy restarted the container mid-call. The gate demonstrably works (it blocked a push earlier the same hour with `testlab: 1 experiment(s) running`), so either a Lab run has a window before it registers as busy, or a push bypassed the hook. Also: a killed experiment never transitions out of `running`, so a stale row is indistinguishable from a live one — worth a heartbeat or a startup sweep. → `.githooks/pre-push`, `server/routes/admin/testlab.js` experiment lifecycle, `GET /api/health/busy`
- [ ] **Trial prewarm persists 2×4 sheets as base64 data URIs inside `characters.data` (2026-09-06).** `preGeneratedStyledAvatars.watercolor.costumed.default` on `characters_0b170efb-…` (staging) is a `data:image/jpeg;base64,…` string, and `preGeneratedAvatarSlides` are three more. Violates the R2-only rule for JSONB; the generic `extractInlineImagesToR2` sweep evidently does not reach these keys (or has not run on trial rows). Fix: upload in prepare-title and store URLs, plus a sweep of existing rows. → `server/routes/trial.js` prepare-title save block (~line 2400), `server/lib/r2.js` extractInlineImagesToR2
- [ ] **Trial p4: Grok rendered the child's hands as furry monkey paws (2026-09-06).** `job_1788682208484_2a9fxiisj` page 4 — the monkey is a VB element on the reference sheet and the hands took its fur. Trial has no eval/repair by design (decisions.md 2026-08-15), so this ships to the user unseen. Data point for the anatomy-detection question, not a code fix. → `docs/decisions.md` trial gates; memory `project_anatomy_detection_verdicts`
- [ ] **Visual Bible names lose object specificity: "rice crackers" → element `food`, "pirate hat" → `costume hat` (2026-09-06).** Same trial: the element sheet was rendered from the generic name, so it shows a bag of raw rice grains and page 1 carries it verbatim; pages 2-6 each invent a different cracker. Check whether the VB element prompt asks for a category word instead of the object's own noun. → `prompts/` visual-bible element naming, `server/lib/visualBible.js`
- [x] **DONE 2026-09-06 — Landmark scaffolding photos removed.** Root cause was NOT the judged primary (the judge had already demoted it, 45 vs 85); the scaffolded shot reached the Art Director through `loadLandmarkPhotoDescriptions` → `variantsFromIndexRow`, which offers every non-`bad` slot and never joins `landmark_photo_scores`. 81 photos across 73 landmarks were flagged by description sweep, all 81 visually reviewed (6 verdicts flipped vs the text — 4 false positives, 2 defects the text missed). 32 confirmed defects deleted from prod + staging DB and from R2 (shared bucket), 0 landmarks stranded, archive + manifest in `logs/landmark-deleted-2026-09-06/`. 7 landmarks whose ONLY exterior is a building-site photo were held back — owner: not worth pursuing. Residual (not fixed, low value): the variant path filters on `photo_type='bad'` while `bestPhotoSlots` filters on `photo_score < 40`, so a judge-rejected-but-unmarked photo is still citable.
- [ ] **Held props still render too large after the `size` field (2026-09-06).** Trial `job_1788715081819_lvxzpul0z`: prompt carried `toy telescope — fits in one hand` plus the held-object scale rule; Grok drew it forearm-long, two-handed. The element reference sheet shows the prop alone filling its cell, so the visual cue says big. Owner parked it. Options, rising cost: body-comparison size vocabulary repeated at the action; a hand or figure outline for scale on the element sheet; a prop-scale eval check (full stories only). → `prompts/story-unified.txt` / `story-trial.txt` artifact `size`, `server/lib/promptBuilders.js` REQUIRED OBJECTS, `server/lib/referenceSheets.js`, `prompts/image-evaluation.txt`
- [ ] **Cell cropper slices a guarantee-seeded RAW photo as if it were a 2×4 sheet (2026-09-06).** `job_1788719728575_78bsxj6pu` p1 reference = 7 KB sliver of a dress cut from the bodyNoBg cutout that had been seeded under `standard`. `applyStoryCellRefs` should skip entries the guarantee seeded (`guaranteeSeededKeys`) or verify the sheet geometry before cropping. → `server/lib/styledAvatars.js` guarantee seed, cell cropper in `server/lib/character2x4Sheet.js` / `storyJobPipeline.js applyStoryCellRefs`
- [ ] **Other readers of getPrimaryPhoto/getFacePhoto assume inline data after the R2 offload (2026-09-06).** Since `2244b4a14` character photos are URLs on first save. Verified and fixed in `styledAvatars.js` only. Check: `character2x4Sheet.js:530`, `clothingResolve.js:214/635`, `entityConsistency.js:502`, `repairPipeline.js:1277`, `routes/avatars.js:1021`, `routes/trial.js:2665`. → those sites
- [ ] **Push gate blind spot: a job that starts during the Railway build window dies on the restart (2026-09-06).** Push 14e79f92 at 18:58 UTC passed the idle gate; trial job_1788721172453 was created 18:59:32 UTC; the deploy's restart landed ~4-5 min later and the job failed "Server restarted during generation" at 60%. Same shape earlier (20:51 pair killed a wizard mid create-story). The probe is correct at push time; nothing covers the build window. Options: server refuses new jobs while a deploy is building (Railway API poll or a flag set by the pre-push hook), or the hook waits for the deploy to finish and re-checks. Peer note: only the flag closes the window (polling has the same race in miniature); the flag must clear on a failed/cancelled build or the environment silently stops accepting jobs. → `.githooks/pre-push`, `server/lib/idleShutdown.js`, `server/routes/jobs.js` create-story — **THREE more kills on 2026-09-07/08, all staging**: `job_1788816160479_1shwyz0bj` (23:22:40 CH, died 1%), `job_1788820257138_q9ohupndq` (00:30:57 CH, died 00:32:06 CH after 69s at 1%, a ~USD 7 / ~50-min run), plus one peer-reported kill ~90s into a dragon run. The 00:30 case pins the mechanism exactly: push `b4685e637` landed at 00:30, the job was created at 00:30:57, the restart killed it 69s later — the job started INSIDE a deploy window that had already opened, so the push-time idle probe never had a chance. Cheap interim mitigation while the flag is unbuilt: a long paid run compares `GET /api/health` commit against `origin/staging` first and waits if they differ. Two sessions coordinated by hand tonight instead.
- [ ] **A multi-state VB object renders its default look twice — base cell + a "whole"/unaltered state (2026-09-06).** Validation run experiment #1037 produced `ART001` with base = vessel/cap/openings/wire bail handle, and state 1 "whole" = "intact, unlit, carved face complete, top cap in place" — the same picture. So base+4 states = 5 cells, which `expandElementStateCells` routes to a solo batch that renders as a 1x5 vertical column (`cols = count === 4 ? 2 : 1`) with narrower cells than the 2x2 case. Dropping the redundant default state gives 4 cells and a full-size 2x2 grid, and makes the 4-state ceiling a non-issue. Cheaper fix is prompt-side (the writer never emits a state for the unaltered look, the base already is it) than render-side (skip minting a base cell when a state describes the default). → `prompts/story-unified.txt` / `story-bible-from-beats.txt` / `story-trial.txt` states spec, `server/lib/referenceSheets.js` `expandElementStateCells`, `server/lib/visualBible.js` `MAX_OBJECT_STATES`
- [x] **DONE 2026-09-10 (see `docs/decisions.md` "The quality evaluator gets an EXPECTED CAST roster") — `extra_character` is an orphan finding type (2026-09-06).** Now image-evaluation D-04b at CRITICAL, in the consolidator's closed list; the evaluator receives an EXPECTED CAST roster. Original:  Registered in `server/lib/evalBuckets.js` `TYPE_TO_BUCKET` (~line 137, bucket `character_presence`) but present in NO evaluator prompt vocabulary, so nothing can ever emit it. Found while adding `duplicate_identity`. Either give it a definition in the evaluator prompts or delete the mapping. → `server/lib/evalBuckets.js`, `prompts/image-evaluation.txt` / `image-prompt-compliance.txt` / `image-semantic.txt`
- [ ] **Manual per-page regeneration can exhaust its pass budget with a CRITICAL still present, unrecorded (2026-09-06).** `server/routes/regeneration.js:3592` runs the same bounded `maxPasses` 1-3 loop that the unattended pipeline does, and the `unrepairedCritical` stamp added in `14e79f92c` does not cover it. Deliberately left: it is operator-invoked and returns pass history + post-repair score straight to the UI, so the outcome is not silent the way the pipeline's was. Recorded as a judgement, not a miss — revisit if operators report surprise. → `server/routes/regeneration.js:3592`, `server/lib/repairLogic.js` `collectCriticalFindings`
- [x] **Google sign-in showed "Google hasn't verified this app" to customers — FIXED, confirmed on production 2026-09-06.** Reproduced on production at the trial email step (client `69965481554-cl8hv6p5…`, `scope=openid+email+profile`). Two causes fixed in the Cloud console, no code change: (1) project `magical-story-3b745` had NO scopes declared on Data Access, so Google treated the login's `openid`/`userinfo.email`/`userinfo.profile` as unapproved — now declared; (2) the `MagicalStory Ads CLI` client in the same project requested the sensitive `.../auth/adwords` scope and had consumed the `1 user / 100` unverified-sensitive-scope cap — the ads/SEO credentials were migrated to a separate project (`magicalstory-admin-tools`, `69638796140-…`) and the old client deleted. CLOSED: owner confirmed a clean consent card on the production trial sign-in after the two console changes propagated (~10 min). Supporting evidence: Google registrations ran 2026-06-09 → 2026-08-16 (6 users) then stopped dead. If the warning survives, the escape is a fresh OAuth client in a project that never held a sensitive scope (update `GOOGLE_OAUTH_CLIENT_ID` + `VITE_GOOGLE_OAUTH_CLIENT_ID` on Railway; accounts match on email so users are unaffected). → `docs/decisions.md` 2026-09-06 "Admin-script OAuth lives in its own Google Cloud project", `server/routes/auth.js:460`, `client/src/services/googleAuth.ts:184`
- [ ] **A PROSE scene brief still never states an invented character's AGE (2026-09-06).** The `CAST WITHOUT A REFERENCE IMAGE` block added today is scoped to the structured JSON brief, because the prose format demonstrably embeds a secondary's appearance inline (`job_1787689073034_1v6ew0y1kae` p11 spells out the park keeper's hat, shirt, trousers, boots). What the prose does NOT carry is the bible's stated age — that entry says "middle-aged adult, approximately 50s" and the sentence says only "tall and broad-shouldered". Not fixed: beats emits the JSON brief, so this is legacy-path only, and re-adding an emitter to the prose path is the 2026-06-09 duplication the removal was right about. Revisit only if a prose-format page is measured rendering an invented adult at the wrong age. → `server/lib/promptBuilders.js` `collectSecondaryCastForPage` gate, `docs/decisions.md` 2026-09-06 bible-invented-cast entry
- [ ] **`story-trial.txt` has no worn-garment vs artifact rule (2026-09-06).** `story-bible-from-beats.txt:61` states that a worn garment belongs to `clothing` only and that a prop the story turns into costume is ONE artifact with `wornAs` plus a matching clothing requirement; the trial template states neither, which is how prod `job_1788698812047_q5b1vuds7` filed a worn straw costume as artifact `ART002 type: "costume"` and rendered it as a prop. The costume instructions are now gated on a costume existing (docs/decisions.md 2026-09-06), and the trial idea generator no longer proposes a worn costume for a costume-less theme (docs/decisions.md 2026-09-07), so both triggers are closed — but the trial template still cannot express "worn", so a costumed theme whose story turns a prop into clothing has nowhere to say so. STILL OPEN. → `prompts/story-trial.txt` artifacts spec, `prompts/story-bible-from-beats.txt:61`
- [x] **Trial idea generation can hand the writer a premise the trial cannot render (2026-09-06).** DONE 2026-09-07 — the idea generator now performs the same costume lookup and forbids a worn costume when there is none (docs/decisions.md 2026-09-07). The accepted premise for `job_1788698812047_q5b1vuds7` (theme `mothers-day`, `idea_source='ours-unchanged'`) was "Amian zieht sich ein Strohkostüm an …", but a trial's wardrobe is fixed by the static `getTrialCostume(theme)` table, which has no `mothers-day` entry — so no costumed avatar exists and the writer is now instructed that nobody wears a costume. The story therefore diverges from the premise the user accepted. Options (owner's call): idea generation avoids worn-costume premises for themes without a costume, or a premise costume promotes into `clothingRequirements` and generates a costumed sheet. → `server/config/trialCostumes.js`, trial idea-generation prompt, `server/routes/trial.js`
- [ ] **The trial idea generator's age-band block still says the costume is worn (2026-09-07).** `buildAgeModeSection` is shared with full-story idea generation and states, for the youngest bands, "A costume or a favourite theme is what the child **wears**" and "Page one shows them there, **dressing up** or beginning to play". On a costume-less theme it now contradicts the gate appended after it (docs/decisions.md 2026-09-07); the gate is stated last and won the offline render, but the age-band wording is untouched because full stories legitimately generate costumes on demand. Fix would need the age-band section to take the same costume flag. → `prompts/age-band-*.txt`, `server/lib/promptBuilders.js` `buildAgeModeSection`, `server/routes/trial.js` idea generation
- [x] **Arc event budget rewritten to key on the AGE BAND, not page count (2026-09-07).** `buildArcBudgetSection` derived events from page count + reading level only, so the same 3-year-old got 3 events + 1 invented figure at 5 pages but 7 + 3 at 20, and `Math.max(3, ...)` forced three events into a five-page toddler book — contradicting STORY SHAPE inside the same prompt. Now: events are a per-band RANGE (routine/quest flat 1; tries p/7-p/5; fear-choice p/6-p/4; journey p/5-p/4; at 6+ the reading level stands in), floor 1; invented named figures are a per-band ceiling minus half the cast with a structural floor of 2 (an antagonist and a helper), page count removed — the old rule could reach 0 and forbade the figures the dragon story needed; the three simple bands get a "extra length buys repetition, not plot" bullet. Owner anchors (5p=1, 20p=3-4) verified by static render across ages 1/2/3/4/5/8 x pages 5/10/18/20. → `docs/decisions.md` 2026-09-07 "Plot complexity is keyed on the age band, not on page count", `server/lib/promptBuilders.js` `buildArcBudgetSection`
- [x] **Arc ACTION budget became a per-page shape, the total removed (2026-09-07).** Two models self-certified compliance while overrunning a computed total (Sonnet 62 actions against a 36 ceiling, claiming "exactly at budget"; Opus 43, claiming "under budget"). The bullet now states a per-page shape keyed on the age band — ONE main action, at most two, for every band and 1st-grade; two-to-three / three-to-four for the standard band at standard / advanced, advanced dropping 5-8 → 3-4 on measured evidence. Both arc CRITIQUE lines check per-page load instead of a total. One paid Opus arc-create on the dragon inputs: 41 actions / 2.28 per page, 5 of 18 pages over the shape, critique named pages at the ceiling rather than claiming a total. → `docs/decisions.md` 2026-09-07 "The arc's ACTION budget is a per-page shape, not a countable total", `server/lib/promptBuilders.js` `buildArcBudgetSection`
- [x] **The baked cover title runs to the canvas edge on long titles (2026-09-07).** FIXED 2026-09-07 — `bakedTitleLine()` now states an 8%-of-canvas-width margin and tells a long title to break onto more lines; four renders through the real cover path clear the 18px trim (right margin 0/2px → 55/129/35px, longest title ends 114px inside). See `docs/decisions.md` 2026-09-07 "trim-safe margin". Original report: Reproduced on two different titles from two staging trials: `job_1788763045123_z8so79ngb` "Emmas Blumengeheimnis" (final `s` touching the right edge) and `job_1788802404497_i1mm4yn6h` "Emma und das vergessene Geschenk" (final `k` hard against it, both lines tight to both margins). `coverTitleMode` is `baked` in staging AND production (`/api/health/config`), so the model sets the type and nothing enforces a safe margin — a print bleed would clip the last glyph. Not a regression from the 2026-09-07 fixes; present before and after. Check whether the front-cover prompt states a margin at all, and whether title length should route to a two- vs three-line instruction. → `prompts/front-cover.txt`, `server/lib/coverIterate.js`, `server/config/runtime.js` `coverTitleMode`
- [ ] **A trial still ships a styled 2×4 sheet that was never judged (2026-09-07).** After `0e1ad2065` the skip path is honest — `evaluated:false`, `evalSkipped:'skipQualityEval'`, scores `null` instead of a fabricated 10 — and after `a323d52c9` the style anchor is no longer attached when no verdict can reject it, which removes the known contamination source. But the trial sheet is still shipped unassessed, so the next unknown failure mode reaches the user unseen exactly as the anchor blend did (`job_1788763045123_z8so79ngb`). Catching this class inside a trial means running the pass-2 solo check there: one paid Gemini call per character on the speed-critical path. Owner's call, cost vs coverage — not built. → `server/lib/styledAvatars.js` `runStyleTransferPass`, `prompts/sheet-2x4-style-eval.txt`, `docs/decisions.md` 2026-09-07 entries
- [x] **DONE 2026-09-07 — structured data is now per-language.** `buildProductJsonLd(lang)`, `buildFaqJsonLd(lang)` and `buildProductJsonLdForTheme(..., lang)` replace the frozen German constants at all five call sites; the Organization block's stale "3 languages" and its `availableLanguage` list were corrected, and the HowTo tool name gained its missing French branch. Verified: a German-text scan over en/fr/it JSON-LD on 5 route shapes returns nothing, German output unchanged. Original note: `seoMeta.js:689` and `:706` are frozen German constants injected at four call sites (`:907`, `:922`, `:1115`, `:1141`) with no language parameter, so an English, French or Italian page carries German structured data — Google reads that as a language mismatch and can render German text inside a non-German rich result. FAQ markup is the more valuable of the two (it earns the expandable Q&A rows). The product description also still says "3 Sprachen", which was wrong before Italian and is now wrong by two. Pre-existing, NOT introduced by the Italian pass; affects en/fr as much as it. Fix is mechanical: per-language maps selected through the `pickLang()` helper already in that file, verified by diffing emitted JSON-LD per language. → `server/lib/seoMeta.js:689`, `:706`, call sites `:907/:922/:1115/:1141`
- [x] **DONE 2026-09-07 — Swiss landmark discovery now searches Italian Wikipedia.** Owner authorised the spend; `languages` for Swiss geosearch is `['de','en','fr','it']`. `langPriority` already ranked `it` 4th, so a landmark present on several wikipedias still dedupes to its German name — Italian only adds landmarks the other three never had. Cost lands on the NEXT indexing run (each newly discovered landmark downloads and agent-judges photos), including the user-reachable auto-index path. Original note: `landmarkPhotos.js:1712` uses `languages = ['de','en','fr']` for Swiss geosearch, so Ticino and Italian-Grigioni landmarks that exist only on it.wikipedia are never discovered. Deliberately NOT changed during the Italian pass: the result feeds `indexLandmarks` (`:3409`), which downloads and agent-judges photos for every discovered landmark, and the same function sits on the user-reachable auto-index path (`:2138`) — so it costs real money per new landmark. `langPriority` already has `'it': 4`, so dedup ordering needs no work; the change itself is one line. Owner's call, cost vs Ticino coverage. The free half (Italian landmark-word matching on already-fetched results) shipped in `428f72152`. → `server/lib/landmarkPhotos.js:1712`, `:1782`, `:3409`
- [ ] **Italian legal pages are machine-translated and unreviewed (2026-09-07).** Privacy, Terms and Impressum were translated into Italian in `428f72152` and are legally binding once live. Clause structure and Swiss-Italian terminology were preserved (foro competente, titolare del trattamento) and the translating agent flagged nothing as uncertain, but no human or native speaker has read them. `tsc` cannot check this class of error. Recommend a review before these reach production. → `client/src/pages/PrivacyPolicy.tsx`, `client/src/pages/TermsOfService.tsx`, `client/src/pages/Impressum.tsx`
- [ ] **Developer-mode and admin surfaces are English-only in every language (2026-09-07).** Deliberately skipped by the Italian pass, recorded so it is a decision and not a gap: ~147 sites in `StoryDisplay.tsx` dev panels, plus `ReferencePhotosDisplay` (57), `ImageHistoryModal` dev half (55), `ObjectDetectionDisplay` (37), `CharacterForm` dev panels (19), `ModelSelector` (14), `AdminDashboard` (12), `SceneEditModal` consistency panel (8), `EntityConsistencyView`, `GenerationSettingsPanel`, `CoverTextStylePanel`, and `client/src/pages/admin/translations.ts` (de/fr only). All verified gated behind `developerMode` or admin. Only worth doing if a non-German-speaking admin ever uses them. → those files
- [ ] **The arc judge panel has no BLIND judge (2026-09-07).** All three arc judges (`claude-sonnet`, `grok-4.6`, `gemini-3.1-pro`) receive the same BRIEF, so all three score compliance with the commission and nobody scores the arc as a reader meets it. The text stage already solved this: `textRefine.js` merges three sources — `'arc-informed' | 'blind' | 'counter'` — and `prompts/story-text-audit-blind.txt` opens "You have the pages and nothing else: no summary, no plan, no author's notes. Only what the words say exists." No equivalent exists for the arc. Two rubric dimensions are actively HARMED by knowing the plan — `sense` ("heard once, the story holds") and `engaging` ("a child would lean in") — because a briefed judge cannot tell what the arc failed to establish; `fit`, `focus` and `difficulty` genuinely need the brief. This matters more now that `buildBriefContext` gives the arc judge the age band and the budgets (2026-09-07): better compliance checking, still nobody asking "is this a good story?". Owner's call on shape — a FOURTH blind panelist scoring only the reader-side dims (preferred: the panel already spreads 4.3 points, so removing a briefed judge makes it noisier), or converting one of the three. A blind score must never be averaged with the briefed ones; they answer different questions. → `server/lib/testlab.js:7317` `judgeModels`, `prompts/story-arc-judge.txt` rubric, `server/lib/storyScorecard.js` `buildBriefContext`, precedent in `server/lib/textRefine.js:65` and `prompts/story-text-audit-blind.txt`
- [x] **DONE 2026-09-07 — arc prompt-layer contradictions fixed (4 defects).** `# RULES OF THE TELLING` was one fixed block demanding escalation/low-point/unyielding-blocker/rival-thread at every band, against age-band files that forbid all four; the `routine` STORY SHAPE said "N distinct events" while BUDGETS said "at most 1 event"; the reader line was hardcoded "3-5 year old" for ages 1 and 2; the invented-figure justification leaked into a numbered story sentence; and 4 of 7 measured arcs split the cast. Now emitted by `buildTellingRulesSection()` and interpolated as `{TELLING_RULES}`, band-conditional. → `docs/decisions.md` 2026-09-07 entry, `server/lib/promptBuilders.js` `buildTellingRulesSection`
- [x] **DONE 2026-09-07 — the arc-judge rubric is age-band aware.** `lost`, `attempts` and `blockers` demanded a low point, escalation and a willing antagonist — all three forbidden by `SIMPLE_BANDS` (`routine`/`quest`/`tries`), so a correctly-executed toddler book capped around 5/10 and fed those scores to the repair as panel input. Measured config E (age 2, `quest`): `blockers` 1/1/5, `change` 1/1/2, `attempts` 2/2/4. The rubric now says the BRIEF's age-band section governs which dimensions apply and names what those four measure instead; non-simple bands and 6+ are judged exactly as before, and the 14-key strict-JSON contract is byte-identical. Completes `c903b6473` (which gave the judge the band but not what to do with it). → `docs/decisions.md` 2026-09-07 "The arc-judge rubric is age-band aware", `prompts/story-arc-judge.txt`
- [ ] **Five measured plate/containment/beat rules encoded 2026-09-08; the VB-side element overflow is not the reviewer's to fix.** R1-R5 (plate = world before the action, static props by silhouette; facing inside each character's own clause; "inside is not outside" 11e; beats never hand a trapped figure the exit) are on staging, not master. Open: on the dragon story all 11 surviving `vb_element_overflow` pages cited ≤3 ids in their own `objects[]` — the surplus is the bible's `appearsInPages`, so the review can never reach zero there; `sceneReviewReport.rewriteToZeroUnfixed` now names those pages as `briefFixable:false`. Whether the bible should place fewer elements per page, or the count should exclude what the brief never cited, is the owner's call (VB side owned by the parallel state-model session). → `docs/decisions.md` 2026-09-08 "The plate holds the world BEFORE the action", `server/lib/vbElementBudget.js` `rankPageElements`, `server/lib/beatsPipeline.js` `rewriteToZeroUnfixed`
- [x] **DONE 2026-09-08 — a VB object state contradicting the page's own instant no longer wins.** Dragon story p11 (`job_1788816451791_25b31uqlp`) rendered "chip in an open palm / scale with no hands touching it" on the page whose plan line pressed the two halves together, because both state deltas rode REQUIRED OBJECTS verbatim and nothing compared them to the page. Fixed at the root: the bible derives each state from THAT page's plan line and stamps a structured `held` flag; `visualBible.resolveObjectState` is the one resolver for clause and reference cell, drops a `held`-contradicting delta with a WARN, and arbitrates a cited-vs-table disagreement by the page's interactions (table wins on no verdict, WARN either way). **Open, owner's call:** the AD's `interactions[]` are character→object rows only, so "two objects meeting" and "open palm vs pressed" are not structurally detectable in code — prompt-side derivation is the only guard for those; an object→object interaction row would need `scene-expansion-all.txt` (owned by the parallel session today). → `docs/decisions.md` 2026-09-08 "The page instant outranks a contradicting object state", `server/lib/visualBible.js` `resolveObjectState`, `prompts/story-bible-from-beats.txt` states rule, `tasks/bugs.json` `vb-object-state-contradicts-page-instant`
- [x] **DONE 2026-09-08 — Visual Bible page assignment is trimmed to the element budget at birth, and locations no longer count as elements.** Dragon story (`job_1788816451791_25b31uqlp`): 10/18 pages over budget at birth, a worn backpack on 11-15 pages named in no plan line, `briefUnfixed: 11` because a brief cannot withdraw a bible placement. `trimVbAssignments` now keeps plan-line-named entries, trims the rest in `rankPageElements` order, trims `states[].pages` in step, and reports `beatsReviewReport.vbAssignmentTrim`. Owner ruling (AskUserQuestion, 2026-09-08: "Do not count it as it is the empty scene not an artifact") exempts every location from the count; the selection hands the page its location cell last, 3 + 1 = Grok's cap of 4. Closes the open question in the 2026-09-08 plate/containment item above. → `docs/decisions.md` 2026-09-08 "Visual Bible page assignment is trimmed to the element budget at birth", `server/lib/vbElementBudget.js` `trimVbAssignments`, `server/lib/visualBible.js` `getElementReferenceImagesForPage`, `tasks/bugs.json` `vb-pages-not-earned-by-plan-line`
- [x] **DONE 2026-09-10 (see `docs/decisions.md` "The quality evaluator gets an EXPECTED CAST roster") — The figure-count vs cast-size comparison exists but is ONE-DIRECTIONAL — too FEW is caught, too MANY is not (2026-09-09).** `findBorrowedLabel` now WARNs on surplus (diagnostic; deficit refusal unchanged); the finding path is the evaluator's D-04b `extra_character` against the roster it now receives. Original:  Corrected from an earlier, wrong version of this item. We DO detect figures and we DO compare the count to the brief: `findBorrowedLabel` (`server/lib/charRepairTarget.js:109-125`) builds the page's brief cast and compares it to the detected figures. But line 112 is `if (brief.size <= figures.length) return null;` — it forms an opinion ONLY when the brief lists MORE characters than were drawn. A frame with MORE figures than the brief returns null, no opinion. It is also scoped to char-repair TARGETING (refusing to repaint on a borrowed label), not to quality scoring, so it can never produce a finding. Evidence: front cover of `job_1788903616404_iqvhj4l8m` held FIVE children for a four-boy cast and scored 100/100. Separately the quality evaluator gets NO cast roster at all — only `ORIGINAL_PROMPT` text (`server/lib/evalPipeline.js:675`) — so it free-matched the invented fifth child to a name it read in the prose at 0.9 confidence; its rubric penalises only MISSING (`D-04`) and DUPLICATE (`D-03`/`D-03b`), and `N-09 "Crowd extras"` is an explicit NEVER-DEDUCT rule. Cheapest fix is likely widening the existing comparison to both directions and giving it a finding path, rather than building anything new. Pairs with the `extra_character` orphan-type item above. The name-leak that produced the figure is fixed (`53f7a9b62`); the detection gap is not. → `server/lib/charRepairTarget.js:109-125` (the one-directional compare), `server/lib/evalPipeline.js:675` + `:854`, `prompts/image-evaluation.txt:54` (N-09) / `:114` (D-04) / `:223`, `server/lib/evalBuckets.js:137`
- [x] **Repair dead band: a page with three MAJOR findings and no CRITICAL is structurally invisible to repair (2026-09-09).** RESOLVED 2026-09-09: floor 50 → 60, plus a type rescue for MAJOR+ findings of inpaint-friendly types, plus a per-round repair cap (50% round 1 / 30% later, worst-first, deferred not dropped) → `docs/decisions.md` "The repair admission gate: floor back to 60...". Original finding below. `job_1788903616404_iqvhj4l8m` p3 shipped at finalScore 55 with zero repair attempts and three MAJORs (three-stage `clothing` jeans-not-joggers, three-stage `action_interaction` bread roll held at the waist instead of pocketed, semantic `missing_element` Levin's bicycle absent). `findBadPages` (`server/lib/repairLogic.js:30-70`) admits a page only on `score < 50` OR `issueCount >= 5` OR a CRITICAL; 55/2/none matched nothing. `enableFullRepair` was true and does reach the loop — it buys PASSES, not a lower bar. NOTE this is a different class from the closed 2026-09-04 entity ruling above (owner: MAJOR *entity* findings stay unrepaired by design); these are compliance/semantic findings, and the question of whether that class deserves admission is untouched. The 50 floor was itself lowered from 60 on 2026-08-09 because 50-59 repairs came back worse, so raising it is a reversal needing evidence. Owner's call. → `server/lib/repairLogic.js:30-70` + `:100`, `server/config/models.js:981-988` thresholds
- [x] **PARTLY DONE 2026-09-09 — the arc no longer self-certifies its invented cast; the mother it invented was never counted.** `job_1788903616404_iqvhj4l8m` created `CHR001` "Mama", age 32, a wholly invented face on pages 2 and 18, and the arc's own critique said `"Invented figures past allowance: none — Fenno and Nolo, exactly two"` on an allowance of 2 with FOUR figures written. Root cause: the budget defined the allowance by ROLE ("opposition and its help"), so a framing parent counted as neither. Now: membership is defined by SOURCE (the story named it, the commission did not — framing adults, one-page and non-speaking figures included; a commission-supplied animal excluded), the critique EMITS an unnumbered head-positioned list with `Allowed:`/`Written:`, the arc panel is told the allowance and audits the list (new CAST lens), code re-counts the list and forces ONE extra arc round on an overcount (never past the clamp of 3), and the beats counters cross-check the declared list reporting-only. → `docs/decisions.md` 2026-09-09 "The arc ENUMERATES the figures it invented", `server/lib/promptBuilders.js`, `prompts/arc-*.txt`, `server/lib/beatsPipeline.js`, `server/lib/planCounters.js`, `tests/unit/arc-invented-figures.test.ts`
- [ ] **STILL OPEN (owner's call) — may the writer invent a PARENT at all, and may its face be rendered?** The 2026-09-09 work makes an invented parent COUNTABLE and forces a re-telling round when the cast overruns; it does not forbid the role. A real family's book showing an invented mother is a different failure class from an invented shopkeeper. Options: forbid inventing a parent/guardian when the commissioned cast contains children, require the role be filled from the uploaded cast or omitted, or keep it but never render the face. → `prompts/story-bible-from-beats.txt` secondaryCharacters spec, `server/lib/inventedAgeBand.js`
- [ ] **The forced arc round has never run on a real story (2026-09-09).** Shipped with unit coverage only — no paid validation run. First staging story whose arc overruns its invented allowance should be checked for the `arc_invented_overcount_forced` log line, and for whether the forced re-telling actually removes a figure. → `server/lib/beatsPipeline.js` arc round loop, `server/config/models.js` `arcForceRoundOnInventedOvercount`
- [x] **DONE 2026-09-09 (b11d84876) — `tests/manual/test-cover-prompt-builder.js` was stale — it asserts on prompt templates that no longer exist (2026-09-09).** `PROMPT_TEMPLATES.initialPageNoDedication` is `undefined` and the script throws before finishing; `prompts/` now contains only `cover-composition.txt` for covers — `front-cover.txt`, `back-cover.txt` and `initial-page-*.txt` are gone. Verified failing independently of the 2026-09-09 cover-name work (which touched no `prompts/*.txt`). CLAUDE.md's "Prompt Templates" section still lists those four deleted filenames and needs the same correction. → `tests/manual/test-cover-prompt-builder.js:143-166`, `server/services/prompts.js` template map, `CLAUDE.md` Prompt Templates list

- [ ] **The per-round repair cap has never run on a real story (2026-09-09).** Shipped with unit
      coverage only — no paid validation run. First staging story with >6 bad pages should be
      checked for the `🚧 [REPAIR-CAP]` WARN line and for whether deferred pages actually come
      back in the next round → `server/lib/repairLogic.js` `applyRoundCap`, `server/lib/repairPipeline.js:1893`
- [ ] **Today's six trial/idea fixes are on staging but unverified live (2026-09-09).** All six were verified statically only: `tsc`/`node --check`, a rendered-prompt assertion for the season split, and a live Nominatim query for the city dropdown. None has been through a real /try or wizard idea generation. Confirm on staging: (a) a Baden /try idea names only Baden landmarks and no invented river; (b) a wizard story with Jahreszeit Herbst gets autumn in BOTH idea cards, fantasy included; (c) typing "Buchs" in the trial city editor offers three cantons and regenerates on pick; (d) "Neue Ideen erstellen" shows the spinner. → `docs/decisions.md` three 2026-09-09 entries, commits `4c58ab16a` / `aecf928cd` / `3b1447111` / `400467c12`
- [ ] **`SAFE_REPAIRABLE_TYPES` is a first cut, unmeasured (2026-09-09).** Six types chosen by
      judgement, not by measured repair success per type. Once enough pages have been admitted by
      the rescue path, measure improvement rate per type and prune the ones that do not pay
      → `server/lib/repairLogic.js` `SAFE_REPAIRABLE_TYPES`
- [x] **`ARC_INVENTED_UNDECLARED` false-positives on ship and town names (2026-09-10).** FIXED 2026-09-10 (commit 756033e73, `isThingMarked` in `planCounters.js`; decisions.md same date). First live firing of the 2026-09-09 beats cross-check, on `job_1788983823620_csjcyp1q9`: "the plan names invented figures Sturmfeder, Krummhafen that the arc's own invented list does not carry". Sturmfeder is the ship, Krummhafen the town — both excluded by the source-based definition (vehicles and places never count), but the cross-check compares the arc's declared list against `planCounters.resolveCast().invented`, whose acts-like-a-person heuristic promoted them. Reporting-only, so harmless, but it will cry wolf on every story with a named ship or town. Fix is on the counter side (apply the same place/vehicle exclusions before comparing), never by widening what the arc must list. → `server/lib/planCounters.js` ARC_INVENTED_* block, `resolveCast` exclusions
- [x] **`stripQuoted` in `planCounters.js` treats a possessive apostrophe as an opening quote (found 2026-09-10).** FIXED 2026-09-10 (commit e541d93b5; quote-shaped clause `(^|\s)'[^']*?'(?=[\s.,;:!?)]|$)`, decisions.md same date; real plan retains 3818/3818 instead of 2849, findings unchanged). `'[^']*'` strips everything between `ship's` and the next apostrophe — on `job_1788983823620_csjcyp1q9` that is 969 of 3818 plan chars (25%, whole pages) removed from the corpus every cast test scans. Not fixed (out of the assigned scope); the `«…»`/`"…"` strips are fine. Fix: only strip a single-quoted span that opens at a word boundary → `server/lib/planCounters.js` `stripQuoted`
- [x] **The acts-like-a-person regex in `resolveCast` runs across plan-line breaks (found 2026-09-10).** FIXED 2026-09-10 (commit 2edeb4e82; `\s+` → `[ \t]+` in the `acts` regex and in both groups of the `nameCandidates` regex; decisions.md same date; real plan unchanged: invented `["Malva Grimm"]`, 4 findings). `\s+` lets the shot word opening the NEXT line count as the verb after a name that ends a line (`through <town>` at line end, then `close-up` opening the next). `isThingMarked` restricts itself to the same line; the older `acts` test does not → `server/lib/planCounters.js` `resolveCast`
- [x] **`nameCandidates` lists a full name and its bare first token as two cast members (found 2026-09-10; FIXED 2026-09-10 in `38fdd4d9c` — `canonicalName` in `resolveCast` folds the bare token into its one full name, never guesses between two; see decisions.md).** On `job_1788983823620_csjcyp1q9` once the possessive-strip bug was fixed, page 4 ("Fiona and Malva Grimm … while Malva in her rowing boat") resolves `invented: ["Malva Grimm", "Malva"]` and the page's cast count is 3, not 2 — one person counted twice. No finding tripped on this plan (CAST_OVER_3 needs >3), but a page with three real names plus one bare-first-name mention would. Fix: fold a candidate that is the first token of another candidate into it → `server/lib/planCounters.js` `nameCandidates` / `resolveCast`
- [x] **Text refine can DUPLICATE a scene across two pages, and nothing downstream can see it (2026-09-10).** RESOLVED 2026-09-10 (commit 08fd2d5ad): `text-refine.txt` may MOVE a scene to the page whose picture shows it; mechanical 5-word shingle check after the repair pass + one fed-back corrective pass, WARN if still tripping (`docs/decisions.md` 2026-09-10 "The refiner may MOVE a scene"). Original finding: `job_1788983823620_csjcyp1q9` p12/p13: Sarah's hour of recall + the charcoal chart appears verbatim on both pages (11 identical 5-grams). Chain: (1) the draft writer merged plan-p12 (Lorena refuses) and plan-p13 (chart made) into text-p12, so text ran one page ahead of the pictures from p12 on; (2) the arc-informed audit correctly flagged MISMATCH on p12/13/14; (3) the repair was bound by `prompts/text-refine.txt:38` "never remove an event from a page", so it could not move the chart OFF p12 — it wrote p13 fresh and left p12's paragraph byte-identical, then self-reported "split 12/13"; (4) the post-repair re-audit was removed by design (`server/lib/textRefine.js:33-36`) and no cross-page repetition check exists anywhere, so a fault the repair introduces is uncatchable. Root cause = rule 38 vs a MISMATCH whose only honest fix is a move. Owner to decide shape. → `prompts/text-refine.txt:38`, `server/lib/textRefine.js:33-36,622`, `prompts/story-text-from-beats.txt:44` ("nothing that belongs to a later page", unchecked)
- [x] **REDO the Art Director model bake-off — owner instruction, never recorded, never run (2026-09-10).** RUN 2026-09-10 (2 stories x 4 models x 8 pages, $3.64 of a $4.00 cap; Fiona cut for budget): AD arms Lab 1107-1110 (dragon) + 1121-1124 (bimo), judge 1111-1119 + 1127-1134; gemini-3.1-pro still lowest (raw 18 / reviewed 17) but only the gap to opus (26/30) exceeds judge noise → `docs/decisions.md` "AD model bake-off REDO on the new AD role (2026-09-10)". OPEN owner decision: default unchanged; whether to spend ~$2 on the third story + duplicate cells, and whether the Lab harness reviewer default (grok-4.6) should track production (deepseek-v4-pro). Original ask: The 2026-08-29 verdict (gemini-3.1-pro; Lab 893-953, decisions.md "Art Director model = gemini-3.1-pro") measured the AD as it was then. Since that date the AD role changed in 36 commits (+181/−78 lines across `prompts/scene-expansion*.txt` + `scene-review.txt`): `looksAt` gaze field, one-level-per-frame, rules 7f/7g (tool tip on target), three-VB-element budget at the AD, plate-holds-the-world-before-the-action, one-instant rules, structured worn-item states, bidirectional cast check in the review. The owner asked for the bake-off to be rerun on the new role; no Lab experiment with ≥2 AD model arms exists after 2026-09-01 and no doc captured the ask. Open questions before spending: which frozen beats (the 3 original stories predate the new beats rules; 2026-09-08/09 stories carry them), and whether `prompts/scene-hazard-audit.txt` covers the AD's new output fields. → `server/lib/testlab.js` scene_expansion / scene_hazard_count runners, `docs/decisions.md` 2026-08-29 entry
- [ ] Composite `figureMethod: inPlace` — validate in the Lab under the 2026-09-10 goal; promote to production only if it beats paste+phantom on page 4 of job_1788983823620_csjcyp1q9 → docs/decisions.md ("in-place figure render")
- [ ] Plate judge measured blind (flash-lite and flash) on exp 1086/1091 — needs a judge that sees level relations or stays parked → docs/decisions.md ("plate judge measured blind")
