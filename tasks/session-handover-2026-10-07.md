# Session handover 2026-10-07 — what changed, what is open

Branch: `claude/backlog-trial-2026-10-07` (pushed; NOT on staging or master; no PR yet).
State at handover: full suite 696 files / 8026 tests green; check-no-undef, check-settled,
check-sibling-paths, check-verify-coupling, check-open-bugs (0 open), client tsc all clean.

## What changed (≈125 commits, merged from ~40 parallel agents)
- **Trial**: writer gets the beats writer's shared prose rules + the Art Director's image rules and a
  one-word `population` level (no extra call); production page-grid selector; photo glasses/features
  reach the character; slot no longer burned on a failed create-story; costume-or-fail on streamed
  renders; completion mail single-send; resume before validation; idea-stream dead end; idea edit keeps
  selection; caption language; funnel gate_seen/gate_unlocked, visit linkage after claim, AI-assistant
  traffic buckets. Review: `tasks/trial-quality-review-2026-10-07.md`.
- **Full story**: "[object Object]" clothing in iterate prompts (live prod bug); text-refine diff reviews
  length-fix pages; empty audit = failed audit; VB label repair gets the language; artifact-repair route.
- **Money/security**: book ships to Stripe *shipping* address (was billing); BookBuilder quote = charged
  price; localized promo errors; referral first-order recheck; AI proxy admin-only; landmark discovery
  rate-limited; landmarks-cache admin-only; clientIp = req.ip.
- **SEO/web**: soft-404s → real 404 + noindex app routes; sitemap lastmod from file mtime; 4 missing theme
  metas; JSON-LD prices; crawlers never Accept-Language-redirected; `?lang=` kept on internal links;
  /anlaesse dead link; city history in `<details>`; gift↔occasion↔guide cross-links; theme pages ~70 %
  less JS; a11y (nav name, dialogs, main landmark, skip link, focus trap, labels, img sizes, headings);
  i18n gaps + guard test.
- **Features**: GDPR hard-delete (`server/lib/userErasure.js` behind CLI + admin route, migration guard);
  email batch (one-click unsubscribe, HTML escaping, Swiss address order, no dead tracking CTA, apex host,
  Italian wording); process guards (unhandledRejection/uncaughtException alerts); job-status poll filters
  known pages in SQL; token + sweep indexes.
- **Backlog**: ~25 items ticked/closed; dead code and 12 scratch scripts removed; Lab fixes.

## Deploy notes
- Migrations run at boot: `045_users_marketing_opt_out.sql`, `046_token_and_job_sweep_indexes.sql`.
- Validate on staging with one trial run; record verify entries `trial-writer-shared-prose-rules`,
  `trial-writer-shared-image-rules`, `trial-page-grid-production-selector`, `trial-photo-glasses-and-features`
  via `node scripts/admin/verify-run.js <storyId> --write`.
- GDPR: run `node scripts/admin/delete-user-data.js --email=<x> --production` (dry run) before the first real erasure.
- Check orders since 2026-08-23 where cardholder ≠ recipient (may have shipped to the billing address).

## Started, stopped before any commit (re-run each as a fresh task)
- [ ] `failJobAndNotify`: watchdog/sweep/zombie failures (jobs.js ~354/~612/~826, server.js ~2369/~2612)
      refund silently — settle via settleJobWithRefund `{changed}` then customer + admin mail once; route the
      in-process catch (storyJobPipeline.js ~8116-8177) through the same helper. Design in decisions.md 2026-10-07 process-guards entry.
- [ ] Loud degradations: story shipped with imageless pages/missing covers (storyJobPipeline.js ~6737, ~3825)
      → recordFailure + admin alert; ignored sendStoryCompleteEmail null (~7474) + `send_failed` in activity feed;
      PDF overlay fallback (pdf.js ~595/~830); R2 unconfigured in prod (r2.js ~19); Gelato webhook 200-swallow
      (server.js ~1348) → retry buffer; Stripe retry monitor console-only (server.js ~2696).
- [ ] Analyzer: `OPENCV_IO_MAX_IMAGE_PIXELS` before `import cv2` (photo_analyzer.py ~53, decompression bomb);
      background-removal-failed returns success:true with None outputs (~1958/~2054); 413 HTML → Node 502.
- [ ] Trial: rejected streamed cover never re-rendered (storyJobPipeline.js ~3444 `streamingCoverPromises`);
      reminders sweep can send day-5 and day-25 in one run (trialReminders.js).
- [ ] Remaining story-delete paths skip `deleteStoryDerivedRows` (server/routes/admin/database.js ~211,
      scripts/admin/cleanup-orphaned-data.js) + guard test; storyMetrics.js ~423 `OR result_data->>'storyId'` seq scan.
- [ ] Logs: maskEmail at every email log site (server.js, auth.js, trial.js, trialEmail.js, trialReminders.js);
      automatic `[job_xxx]` prefix inside the job scope; DEBUG dump at error level (storyJobPipeline.js ~8051).
- [ ] Web perf round 2: per-entry split of giftData/comparisonData/guideData (theme split pattern); lazy admin
      panels in StoryDisplay; og:image → og-image.jpg 1200×630 (client/index.html ~62); trim unused font weights.
- [ ] **Owner-approved, not built**: keyword H1 on city ("Personalisiertes Kinderbuch aus {Stadt}") and theme
      ("{Thema}: personalisiertes Kinderbuch") pages, all 4 languages, city/theme name as its own span.

## Owner decisions (answered this session)
- Story-text prompt fixes (gsw dialect line, Italian tense, de contractions, fr tu/vous, two mains, toddler level): **declined for now**.
- Website: only the keyword headings approved; photo-privacy note, CTAs to /try, book price at trial end: not approved.
- All other open owner items: `tasks/session-review-2026-10-07.md`.
