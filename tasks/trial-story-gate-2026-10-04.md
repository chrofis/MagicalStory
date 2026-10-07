# Trial generation page: show the story, gate the ending — 2026-10-04

**Owner ask:** "check while story is generating, what does user see, how can we get users to add their Email here.
This is the other point where many people jump off. Can we show more of the story … keep a part of the text hidden
on each page or show only the text of the first pages? Think it through."

## Findings (production, measured 2026-10-04)

- **Funnel, last 60 days (trial_events, distinct visits):** generation_started 18 → generation_completed 15 →
  account_created 10 (8 Google, 2 email). 8 of 18 (44%) start a story and leave no contact.
- **When they leave:** of the 9 started-but-no-account visits, **7 stayed until generation_completed (~3 min) and
  then left**; 1 submitted an email and never clicked the verification link (story lost); 2 left at 0 s.
  → The drop-off is NOT impatience; it is the gate at the payoff.
- **What the screen shows today** (`client/src/pages/TrialGenerationPage.tsx`): progress bar, ONE rotating image
  slot (avatars, title page, page images as they arrive) with info/funny captions, then the sign-in box
  ("sign in to see" — Google, or email + verification link; "without verification your story will be lost").
  **No story text is ever shown on this page.** After completion, without an account, still only rotating images.
- **The text exists early:** the unified pipeline (trial = unified, `trialMode`) saves a `story_text` checkpoint
  with all page texts right after the writer step (`storyJobPipeline.js` ~L3301, comment: "UI can show text
  immediately"), and every `partial_page` checkpoint carries `text` next to `imageData` (~L5191).
  `GET /api/trial/job-status/:id` (`server/routes/trial.js` ~L1680) maps `partial_page` rows to
  `{ pageNumber, imageData }` only — **it drops the text.**
- **Trial run timeline** (stories.data.generationLog, two prod runs): outline/writer 0→~120 s; avatars ~120–135 s;
  6 page images ~135–155 s; repair ~155–216 s; finalize. So text is ready at **~2:00**, pictures **~2:15–2:35**,
  finished **~3:00–3:40**. Sign-ups happen on average **69 s** after start (during the writer phase, when nothing
  story-specific exists).
- Trial stories have **6 pages** (last 8 trial stories in prod).

## Design considerations

- Per-page partial hiding: reader cannot follow the story → no emotional pull; feels like a trick on every page.
- First pages readable, ending gated: reader gets invested in a story about their own child; the gate lands at the
  natural cliffhanger ("how does it end?"). Recommended.
- Hidden text must be withheld SERVER-side (not CSS blur) — otherwise readable in dev tools; the gate must be real.
- The email path's verification-before-reading is the second friction point (1 of 9 lost there; only 2 of 10
  accounts via email). Unlocking the ending on email submit (verification still needed to keep the story / PDF /
  credits) removes it.
- The first ~2 minutes stay story-less either way (the writer call). Streaming page text out of the writer would
  fill them but is a pipeline change (separate idea, not in this scope).
- Before building: reuse the full path's progressive story display (StoryDisplay / jobs route reads `story_text`)
  rather than a second renderer — one implementation (check what it offers first).
- Measurement: ~9 trial starts/month → a before/after difference takes weeks to read; add a funnel event for the
  gate so the step is visible.

## Decision (owner, 2026-10-04)

1. **0:00 → story text ready:** keep today's rotating styled avatars with the funny captions.
   (Avatars are made by `POST /api/trial/prepare-title`, fired on the ideas step while the visitor picks a story,
   so they normally arrive with the page at 0:00; late ones arrive via job-status polling.)
2. **~2:00, story text ready:** a "your story is ready" moment led by the TITLE (the title text exists at ~2:00
   when the story is parsed; the title-page picture is drawn with the pages, ~2:15–2:35, and slots in then).
3. **Pages 1–3 readable** (picture + full text, pictures appearing as they are drawn).
4. **Pages 4–6: picture only + cliffhanger gate** ("Wie geht es weiter?") with the sign-in (Google / email) at the gate.
5. **Unlock immediately on email submit** — confirmation still needed to keep the story / PDF / credits.
6. **The email stays changeable** after unlock ("wrong email? change it" → re-send confirmation), so a typo or a
   fake address can be corrected.

## Build spec

**Server — `GET /api/trial/job-status/:id` (`server/routes/trial.js`)**
- Returns the story as `storyTitle`, `totalPages`, and `pages: [{ pageNumber, imageData?, text?, locked }]`.
- Text source: during generation the `story_text` checkpoint (all page texts at ~2:00) and `partial_page`
  checkpoints; after completion the checkpoints are deleted, so read the stored story row instead. Both sources
  must yield the same shape.
- **The gate is server-side:** for a visitor who is not unlocked, pages after `TRIAL_FREE_PAGES` (= 3, one constant,
  server only) come back with `locked: true` and NO `text`. The client never receives locked text.
- Unlocked = the trial user has submitted an email (verified or not) or linked Google — read from the server's own
  record, never from the request.
- The gate decision is a pure exported function with unit tests (free pages, locked pages carry no text, unlocked
  returns all, page count edge cases).

**Client — `client/src/pages/TrialGenerationPage.tsx`**
- Phase 1 unchanged (rotating avatars + captions) until `storyTitle` arrives.
- Then: title moment, pages 1–3 as image + text (placeholder until the picture arrives), pages 4–6 as image + locked
  panel; ONE sign-in block placed at the gate (moved, not duplicated).
- After email submit / Google link: re-poll, locked pages fill in; while unverified, keep visible: "check your email
  to keep your story" + "Andere E-Mail verwenden" (re-link + re-send).
- Reuse an existing page image+text component if one fits; no second renderer.

**Validation:** unit tests for the gate function; staging check with a real trial run on the smoke/admin path
(cost ≈ one trial story) to see the phases, the gate, unlock-on-email and email change; phone screenshots to owner.

## Verification on staging (real trial runs, iPhone 14 viewport)

- **Run 1** (job_1791114188734_cwyvu3y8p, build ed1f27c07): every phase and the gate passed — 14 status
  payloads while locked, **none carried page 4–6 text**; pages 1–3 always had text; email unlocked all 6 at once;
  email change re-linked + re-issued the token. **FAILED: reload** → page lost the story (bare sign-in form).
  Root cause + fix: bug `trial-waiting-page-reload-loses-story` (tasks/bugs.json), fixed in 5933f5926.
  (Run 1's own "pages still unlocked after reload" check passed falsely — it read a pre-reload payload; harness fixed.)
- **Run 2** (job_1791130829297_qfrcuuf2m, build b36317c6e): **all checks pass**, incl. reload (a new job-status
  after reload, all 6 pages unlocked with text, title on screen, no sign-in form, check-email note shown).
  Timeline on staging: title + first picture at ~190 s, complete at ~218 s — on staging the "text before
  pictures" window was ~2 s (prod logs showed text at ~120 s, pictures ~135–155 s).
- Open copy nits: (1) the check-email body still says "…und deine Geschichte zu lesen" although the visitor has
  read it — should say "behalten"; (2) "Deine Geschichte ist fertig!" + "Deine Geschichte ist bereit zum Lesen"
  say the same thing twice at the top.
- Not on production. Production push needs the owner's explicit OK.

## HANDOVER — session end 2026-10-05 (everything below is on STAGING; nothing on production)

On staging (all verified on staging, iPhone/Android screenshots sent to the owner):
- /try phone intro: finished book first, compact steps with owner-approved thumbnails (Lily: knight / reading,
  originals scripts/ads/approved/try-steps/), start button pinned — 6ab466467, 911ff7dcf, 406758938.
- Waiting page: title moment, pages 1–3 readable, pages 4–6 locked SERVER-side (TRIAL_FREE_PAGES = 3), unlock on
  email, email changeable, reload resumes the story (bug trial-waiting-page-reload-loses-story fixed) —
  ed1f27c07, b36317c6e (5933f5926), copy fix d64153ba1. Two real staging trial runs; run 2 passed every check.
- TRIAL_ART_STYLE constant; preview-as-standard remnant removed (decisions.md 2026-10-04).
- Homepage: hero trust row removed, hero text Inter/stone-600, en-dash " – " everywhere, both CTAs font-medium —
  ccdc22205 (decisions.md 2026-10-04 "Homepage hero: no trust row").
- Top bar fixed on every page: Navigation `minimal` variant replaces 5 hand-built bars; overflow-x-clip on
  StoryWizard + TrialGenerationPage roots — 8e4cca4f2 (645cb5082). Re-measured: /create and /try bars stay.

OPEN (owner):
- [ ] Owner (2026-10-05): run ANOTHER staging test first, then everything below goes to production EXCEPT the footer. Then explicit OK for production. Production = cherry-pick ONLY these commits
      onto origin/master in a scratch worktree (staging is hundreds of commits ahead; master is far behind in
      trial.js — expect adaptation; re-run tsc + tests/unit/{trial-story-gate,trial-reload-and-art-style,
      trial-intro-phone,navigation-always-sticky,trial-funnel-*}.test.ts on the merged state first).
- [x] Ad-visit tracking (site_arrival/site_exit, fbb75e248) goes WITH the production push (owner 2026-10-05: "the rest goes all to production"). Until then the attribution report shows arrived=0 for paid clicks.
- [x] Google Ads OAuth: magicalstory-admin-tools re-published + token re-issued 2026-10-05 (decisions.md 8ef99e81e).
- [ ] After production: resume Search-Deutschschweiz-v1 (activate-week.js ARMS status -> ENABLED, --apply), measure.
- [x] Footer tagline "—": owner 2026-10-05 — leave it.
- [ ] Wilhelm Tell staging run job_1791145238223_50osg2osm findings reported to owner, NOT investigated/fixed
      (another session's verification run): covers initialPage ≈ backCover (logged "not distinct", shipped);
      repairs on dismissed findings (consolidator_fix_unbacked p5, p7); p7 73→55 and p10 60→55 with the
      lower-scoring repair shown (check the picker's critical-gone rule before calling it a bug); outline 31/55 min.
- Known gap: trial users never set a password (return from another device = "forgot password").

## Ads addendum 2026-10-05/06
- Added live (owner chose "add keywords only", no bid raise until prod): Alter-2 + 10 life-challenge groups, CHF 0.20, all approved — e7209844a. Cheap campaigns lose ~90% of auctions on rank (0.20 vs ~1.16 first page). Next lever AFTER prod: raise ceiling (set-keyword-bids.js) and resume Deutschschweiz.
- Local commits not yet on origin/staging: 8ef99e81e (decisions note), e7209844a (ads scripts) — docs/scripts only, push with the next staging push.
