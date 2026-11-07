# Customer height edits (Janna family, prod) — 2026-11-06

Owner report: the customer of `job_1793893086454_ao77wh9j5` (Einhorn), `job_1793959308869_fre2mb4d0`
(Rubi) and `job_1793964466256_1tmyzh1do` (Laternen) used the page edit box ten times to fix the
girls' height order; almost every edit failed. Her order: Polina shortest, Melodi a little taller,
Janna, Melisa tallest.

## Done
- [x] Customer edit text names each character by descriptor (age, hair, garment, position), case-insensitive;
      garment ahead of an accessory (efa45e018, 6f20f5d32; decisions.md 2026-11-06). Free replay: her 9 sentences
      all resolve to the right girl; prod stored edits 11/12.
- [x] Staging copies of the three books: heights Polina 106 / Melodi 111 / Janna 115 / Melisa 121 and apparent
      age Polina+Melodi kindergartner, Janna+Melisa young-school-age, on the stories' character snapshots only
      (her profile untouched, owner choice).
- [x] Back-cover "THIS IMAGE DEPICTS" header dropped (5561b70cc).

- [x] 2026-11-07: all 39 pictures reviewed (height + story match); 29 kept, 7 switched to an older stored
      version, 3 redrawn from corrected briefs (Einhorn p6 tied unicorn alone, Rubi p10 whole unicorn,
      Laternen p1 lantern + heights). Promoted to production 08:21-08:22 CH (backups in
      backups/story-promotions/), read back 39/39 OK, no job row, no email. Code 1d4912caa..9572f01f on
      master. Marketing informed (Marketing/inbox/2026-11-07-magicalstory-janna-books-fixed.md).
- [x] 2026-11-07 08:46 CH: Laternen p1 lantern was blue (p9 shows it white with blue stars + moon). One Grok
      edit on staging recoloured only the lantern, rest of the picture unchanged (v5; the edit's quality score
      10 is not a picture fault, checked by eye against v4). Laternen re-promoted (--force after checking prod
      unchanged since 08:22: newest image 08:22 CH, no orders, p1 active v4); prod p1 active v5, bytes
      identical to staging, 0 staging URLs. Total paid spend for the job ~USD 2.50 of the 6 cap.

- [x] 2026-11-07 ~09:10 CH: re-review of the shipped books (owner: "have opus review each one again, and you
      review them as well"). Lab exp 1804 (book_audit, bookReview on, Opus 5.5, staging copies = prod), USD 0.48;
      covers not in this stage (pages 1-10). Opus: 0 height faults; 10 IMG faults —
      Einhorn p2 rope not round Silva's neck, p5 rope post→neck unclear, p6 Janna missing (owner chose the
      tied-alone picture), p7 rope should still be on the neck + horn off-centre (minor);
      Rubi p1 extra farm figures (minor), p5 cord too high (minor), p6 extra rope grips, p7 rope colour (minor);
      Laternen p8 Polina's legs/shoes (minor). My eye review (sheets in scratchpad `books/prod/`): agrees with
      those, plus **Laternen p1 Melodi drawn ~15% taller than Melisa** (head-to-foot ~720 vs ~625 px, same
      depth; she should be ~8% shorter) — Opus missed it, and so did the picture selection; Laternen p4 shows
      the families but no lanterns. Nothing changed in production by this review.

## Open
- [x] Owner: "fix all major … show them to me first" (2026-11-07). On staging, max 2 paid tries per page:
      Einhorn p5 ✅ edit (v3), Einhorn p7 ✅ 2nd edit (v2), Laternen p1 ✅ redraw with all three on one depth
      line + landmark heights (v6; Polina a little too short). Einhorn p2 ❌ twice (every edit that touches the
      head adds the hidden horn), Rubi p6 ❌ twice (edit dropped Melodi; redraw kept extra handles) — staging
      set back to the shipped versions. Review page: scratchpad `books/fixes.html`. NOT promoted yet.
- [x] Owner yes → Einhorn + Laternen promoted 09:13-09:14 CH (--force after checking prod newest = our own
      promotes, no orders); prod p5 v3 / p7 v2 / Laternen p1 v6 hash-identical to the staging fixes, 0 staging URLs.
- **Unicorn references (owner asked):** Silva has ONE Visual Bible picture, horn visible; Rubi has two (horn
  plain, horn glowing). No "horn hidden under forelock/leaves" picture exists although both stories hide the
  horn until a reveal page — so every redraw/edit that copies the reference draws the horn (Einhorn p2 3 of 3).
- [ ] Einhorn p2 + Rubi p6: owner said "try something else … a totally different picture without rope or with
      different focus". New compositions running (E2N: Silva side-on, head turned away drinking, girls find her,
      rope still coiled; R6N: Melodi's shout, rope slack in the leaves). Scripts: scratchpad `edits/newcomp.js`.
      Owner rejected both (2026-11-07): Einhorn p2 original is fine ("girl and pony are the focus"; the new
      girls look away from the pony); R6N reads as shouting on a be-quiet page and the rope looks yellow and in
      two pieces. Staging set back to the shipped versions (Einhorn p2 v1, Rubi p6 v5); prod untouched.
      Lesson: Opus's "rope not round the neck" on Einhorn p2 is a fault the owner does not count — the
      picture's focus matters more than the exact stage of the action.
- Rubi p6 quiet version (owner picked "a picture without the rope's ends"): R6Q via regenerate customPrompt came
  out orange/sunset unlike the book. Owner asked "Did you use a different background plate?" — yes: the
  regenerate route sends a plate only for landmark pages (ensureStoryPagePlate), and a customPrompt is the whole
  image prompt (no art-style template). The originals were drawn on the stored `empty_scene/p6/v0` plate.
  Re-rendered through the Lab `image` stage (production page render + stored plate +
  `sceneDescriptionOverride` = the R6Q brief): exp 1805, USD ~0.05 — same plate and style as p5/p7, one rope
  with two handles, Polina about Melodi's height. Owner: promote. Lab-promoted v10 active, Rubi promoted
  09:46 CH (--force; prod newest was our 08:22 promote, no orders); prod p6 v10 hash-identical, 0 staging URLs.
  **Lesson: a corrected brief for a stored page goes through the Lab `image` stage (production render + stored
  plate), not the regenerate route's customPrompt.**
- Final state: Einhorn p2 original kept (owner); Einhorn p6 tied-alone kept (owner). Spend for the whole job
  ~USD 4.30 of the 6 cap.
- **Why the majors survived the original runs** (stored `finalChecksReport.bookAuditRounds`):
  Einhorn p2/p5 flagged in round 1 → repair added the hidden horn → round 2 said BETTER: PREVIOUS → rollback
  restored the rope fault, and round 2 is the last round, so nothing retried. Rubi p6 flagged in all 3 rounds;
  every inpaint/char-fix left the extra grip (one regressed 96→85). Einhorn p7 never flagged in 3 rounds
  (flagged today: same reviewer, different run). Laternen p1: brief put Melodi `foreground` on the doorstep;
  the review had the HEIGHT ORDER line and still missed it.
- [ ] Owner yes needed on the two-part fix proposal for the tied-unicorn class (below, "Proposal").
- [ ] **Photo-derived apparent age overrides the family's real order.** Polina (5) was rated `young-school-age`
      from her photo, Melodi (5) `kindergartner`; every page prompt and Art Director brief then draws Polina as
      the older, taller child, and a HEIGHT ORDER line alone does not overcome it (staging Einhorn p9 redraw,
      v4 vs v5). The customer can set height and apparent age on the character form, but nothing tells her these
      fields drive the picture. Owner decision pending: surface it / ask for relative heights / apply to her profile.
- [ ] **Edit resizes overshoot.** With the right girl now identified, "polina ist kleiner als melodi" on
      Einhorn p9 v1 still made Polina ~25% shorter (toddler next to Melodi), quality score 20
      (staging `..._edittest`, E2). The edit call carries no target size. Results of all 9 replays:
      `scratchpad` edittest → summarised below once run.
- [ ] **Quoted speech in the scene-intent line is drawn as a caption.** Staging Rubi p6 rewrite: the
      THIS IMAGE DEPICTS line quoted «Alle still!» and the render shows a caption strip "Alle still!".
      Same class as the back-cover caption (5561b70cc) on story pages; not measured beyond this one page.

## Results
- Her 9 edits replayed word for word with names → descriptors (staging `_edittest` clones): right girl changed 9/9
  (before the fix ~3/9); size change exaggerated in ~7/9 ("a little smaller" → toddler, ~20-30%).
- Page redraws with heights + apparent age set and the brief rewritten: Einhorn p9, Rubi p1, Rubi p10 right;
  Einhorn p6/p10 and Rubi p6 not wrong but not comparable (depth/kneeling). Covers: order right on 4/5,
  gaps too big on the Einhorn dedication; no back-cover caption on 3/3 (5561b70cc holds).
- Phrasing test, 4 templates × 4 of her pictures (16 Grok edits via the real route, ~USD 1.60, measured by eye
  as head-top-to-feet pixels):
  - T1 end state + body landmark ("A stands with the top of her head level with B's eyebrows. Same poses, …"):
    pairs near target (Einhorn p9: Polina ~3% shorter than Melodi; Rubi p1 and p6 small changes); on the
    4-girl dedication 2 of 3 steps right (Melodi→Janna ~7%, Janna→Melisa ~3%) but Polina still ~19% below Melodi.
  - T3 Google form with the same landmark: like T1 on pairs, worse on the 4-girl page (Polina smaller still).
  - T5 "nearly the same height, just a little shorter": moderate overshoot on pairs.
  - T6 "one finger's width shorter": the biggest overshoot (the other girl grows a lot).
  - Research (no vendor/benchmark evidence on magnitude words; edit models apply one fixed strength):
    see the agent report summarised in the session; sources docs.x.ai prompting guide, Google Gemini 2.5
    Flash Image prompting blog, arXiv 2510.08532, 2511.09715.
  - Raw images: session scratchpad `phrasing/` (not in the repo); sample is small (1 render per cell).

## 2026-11-07 — Opus height check, root cause, fix route
- **Root cause of "Janna drawn tallest" (4/4 Einhorn group renders, landmark wording included):** the
  HEIGHT ORDER line was right in the sent prompt (AiN, initialPage v6). Janna's reference sheet has the
  oldest-looking face of the four (narrow, high cheekbones) while Melisa's is round ("softly rounded
  features"); the painter draws the oldest-looking child tallest. Wording alone cannot overrule it.
- **Landmark wording in generation (3868cac5c):** gaps shrank (dedication spread 30% → 18%, back 23% → 11%),
  order still wrong on Janna/Melisa in both covers; the mixed line-up was followed on 1 of 2.
- **Opus book review with the height order (1b825e9c1, 972262ae2):** 15 stored pictures, committed rule,
  Opus 5.5 via OpenRouter, USD 0.29 per pass: wrong caught 6/7 (missed only the borderline Einhorn back
  v2 gaps), right left alone 4/5 (Laternen dedication flagged for Melisa too tall — a real, small gap
  fault), not-comparable left alone 2/3. Run file: scratchpad `redraw/opus-height-v2.json`.
- **Fixing a wrong original — edit vs redraw (Laternen p1):** the landmark edit ("Polina stands with the top
  of her head level with Melisa's nose") left Polina unchanged and made Melisa taller (teen-looking): worse.
  Redraw from a rewritten brief: see below. Verdict so far: edits do not fix size; redraw + Opus check does.
- **Picture selection (agent, all 101 stored versions of 39 pages viewed):** 36 pages keep a stored
  version, 7 switch to an older better version, 3 need a redraw (Einhorn p6 cast/horn, Rubi p10 unicorn
  missing, Laternen p1 Polina a head short). Files: scratchpad `books/selection.json|html`.
- **Einhorn p6, tied unicorn never drawn (analysis 2026-11-07, two read-only agents, USD 0):**
  - Plan: the book's one mandatory peopleless page (story-beats.txt:35) went to the knot beat; the plan
    grammar is `<names> | nobody` (:91) and a tracked animal counts as a name (:45), so "no people" became
    "no Silva" → plan line "nobody — The rope drawn taut against the post". Text written later puts Janna
    AND Silva in the instant; nothing re-syncs plan/brief/VB pages (Silva's VB pages exclude 6; Jev VB score
    0.47 < 0.7).
  - Judges: book_review mode, only the Opus whole-book review ran. book-audit.txt:11 tells it a figure the
    words name but the brief did not draw is "absent by design … never a fault". Round 0/1 asked only for the
    taut rope; round 2 (final, no repair after it) wrote "Draw Silva tethered by the knotted rope from the post
    to her neck…".
  - Repair: the round-1 rebrief (eval_calls 1669) DID add Silva tied from the page text;
    `checkDeclaredSet` (iterateBeat.js:661-706, images.js:5041-5069) flagged her
    `character_outside_declared_set` and the corrective re-ask removed her, backed by PLAN_LINE_CAST_RULE
    (promptBuilders.js:9866). Humans are always allowed into a repair; a creature only when plan/brief/VB
    pages carry it. A per-page judge later filed Silva on p6 as `extra_character`.
  - Class of gap: picture contract fixed at plan time; text diverges after; every critic and repair is
    defined against the contract. Raw: scratchpad `analysis/`.
- **Proposal (owner picked both classes 2026-11-07; NOT built, needs the owner's yes on this shape):**
  1. Planner — "no people" is not "no figure": the peopleless page may name tracked creatures only (who-column
     lists only Visual Bible animals) and still counts as the book's peopleless page. Touches
     story-beats.txt rule 2 + plan grammar :91, the peopleless counter (planCounters / castCoverage), plan-check
     (its CHECK[11]/[20] ask only for humans), PLAN_LINE_CAST_RULE (promptBuilders.js:9866) and
     scene-briefs-all.txt rule 3/10b. Test: free replay of the plan counters over stored plans + a Lab
     planner stage over ≥20 stored arcs (paid, price asked first).
  2. Opus review — narrow exception to "absent by design" (book-audit.txt:11, kept since c4f23b21b took
     off-cast false faults 3 → 0): when a sentence of the page has a figure the brief left out ACT ON the
     subject the picture shows, it is an IMG `missing_character` MAJOR fault, not a TEXT fault.
     Required third part, or repair deletes the figure again: the iterate declared-set gate
     (iterateBeat.js:661-706) must admit a figure the review finding names. Test: replay the review prompt on
     stored pages with off-cast mentions (the c4f23b21b set, must stay 0 false faults) + this page.
  - Also found: a user's edited scene is always re-expanded by the brief writer from the page TEXT
    (regeneration.js shouldExpand when sceneWasEdited), so a scene the user writes without the text's
    figures gets them added back (Einhorn p6 E6S: "No people in the picture" → four girls).
- Production check before promote: no print orders; production versions identical to the staging copies;
  last production picture 2026-11-06 12:05 CH, before the copy.

## 2026-11-07 (late morning) — owner read the three books
- Einhorn text rewritten on p1, p2, p6, p8, p9 (owner-approved drafts; stakes said out loud, the split and the knot made logical, p9 says a magic animal belongs to no one). Applied on staging through PUT /api/stories/:id/text, per-page copies synced.
- Einhorn p9 picture: customer iterate (freeIterate + feedback) failed — redrew the old gate scene from the plan (USD ~0.10). Lab exp 1806 `image` stage with the p8 stable plate copied to p9 empty_scene v1 and the four-girl cast: accepted, v7.
- Rubi front cover: the only version had the title on a strip with a hard seam; regenerate cover on staging (v1) painted it into the scene, spelled right.
- Promoted both stories (`--force` after checking prod text = staging-before, no prod images or credit rows since this morning's promote, no orders). Prod check: p9 v7 md5 = approved image, 0 staging URLs, every active picture loads.
- Spend this round ≈ USD 0.25; Janna total ≈ USD 4.55 of 6.
- Einhorn p4/p5 text (owner flagged both): Janna sees the friends' boot prints next to the hoofprints; Melisa answers «Ein Einhorn hat doch ein Horn». Promoted after prod text == staging-before2; reading page from prod shows both.
- Einhorn knowledge timeline fixed (owner: "when do they detect that it is a unicorn?"): Janna glimpses the horn on p1; she never names Silva or the meadow; narrator states the fog rule. Promoted; reading page from prod shows all four sentences.
- Laternen p4/p7/p8 text (owner-approved first-reader clarity; rhyme kept because the customer picked learning topic «Reimwörter»): applied on staging via `PUT /text` + sceneImages sync, staging text == prod before, promoted (`--force`, 115 image rows, no orders). Reading page from prod: «nur Kinder konnten Silbermond» and «Wenn ich ‹Ballerina› sage» present, 0 staging URLs.
- Horn test (Build 2 replay, 20 stored stories × old/new VB prompt, USD 0.67 of 0.80): both positives keep hidden→revealed in both arms (new arm names them uniformly); no new false state on the 18 negatives; one new-arm parse failure (fence written before the section marker, JSON valid) — parser robustness, not the rule.
- Owner decision 14:xx CH: originals back, fixes as separate books (same title, no mark, no email). Created prod copies from the staging (= fixed) versions with `promote-story-to-prod.js --as-new --user=025579e7…`: Einhorn → job_1794060455874_w2sbl0o0s (119 rows, 236 objects), Rubi → job_1794060490533_1ksytdn47 (100 rows, 197 objects). Then `--restore-from` the 07:21–07:22 UTC backups for all three originals (89/76/102 rows). Verified: originals' text == writer original, all 13 active pictures of each of the 5 books answer 200, 0 staging URLs. Only Einhorn p9's background plate and two masks were overwritten in place by today's promotes (not visible). Laternen's fixed text stays on staging until the plot is reworked; its copy comes then.
