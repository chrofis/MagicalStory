# Session review 2026-10-07 — open items for the owner

Fixes shipped on branch `claude/backlog-trial-2026-10-07` (staging not yet deployed). Everything below is
**not done** and needs an owner decision, credentials, or a story run. Full agent reports are summarised;
file:line pointers are the evidence.

## Security / config (Railway)
- [ ] AI proxy routes (`server/routes/ai-proxy.js`) are now admin-only; delete them outright (no client caller)?
- [ ] CORS allows any `*.railway.app` origin with credentials (`server.js:421-431`) → set `CORS_ORIGINS` to the staging host.
- [ ] `ADMIN_SECRET` as a query-string credential on `/landmarks-photos`, `/job-input`, `admin/swiss-landmarks.js` → requireAdmin; rotate the secret if ever used from a browser.
- [ ] No CSP (`helmet` with `contentSecurityPolicy: false`, `server.js:516`); JWT in localStorage → any XSS = takeover. Needs the Stripe/Google/Turnstile/R2 allow-list.
- [ ] Analyzer decompression bomb: set `OPENCV_IO_MAX_IMAGE_PIXELS` before `import cv2` (`photo_analyzer.py:53`); unauthenticated trial upload can OOM the face worker.

## Reliability / observability (report, not changed)
- [ ] No `process.on('unhandledRejection'|'uncaughtException'|'SIGTERM')` anywhere — one stray rejection kills every in-flight story.
- [ ] Watchdog / sweep / zombie job failures (`jobs.js:355,609,819`, `server.js:2384,2631`) refund silently: no customer or admin email.
- [ ] Story ships "completed" with imageless pages / missing covers and is billed (`storyJobPipeline.js:6737-6751`); only log lines.
- [ ] `sendStoryCompleteEmail` failure returns null and is ignored (`email.js:316`, `storyJobPipeline.js:7474`); `email_sends.send_failed` has no reader.
- [ ] Gelato webhook swallows every error with 200 and no retry buffer (`server.js:1348`); Stripe retry monitor alerts console-only (`server.js:2696`).
- [ ] PDF text-overlay "falling back" path (`pdf.js:595,830`) violates NO FALLBACKS.
- [ ] R2 not configured → inline base64 into JSONB (`r2.js:19-23`); should throw in production.
- [ ] Customer emails / child names logged in plain text at INFO (auth.js, trial.js, trialEmail.js, storyJobPipeline.js:8064); only ~8 % of pipeline log lines carry the job id.

## Database (report, proposed SQL in the agent report)
- [ ] Job-status polling detoasts every page's base64 checkpoint on every poll (`jobs.js:655-700`) — filter knownPages in SQL.
- [ ] Whole `stories.data` rewritten per save + whole-document GIN indexes no query uses → measure `idx_scan`, drop if 0.
- [ ] Two pg pools per process, server.js pool without `max` (`server.js:368`, `database.js:28`).
- [ ] Failed/cancelled job checkpoints (base64) never deleted (`jobs.js:77-88`); `logs` table write-only, unindexed, unpruned.
- [ ] Unindexed token lookups on users (verification/reset/claim tokens) — three partial indexes.

## Story text prompts (report; several touch owner rules)
- [ ] gsw writer told "never switch to a dialect" while its LANGUAGE block is a dialect (`story-text-from-beats.txt:7`, `text-refine.txt:9`).
- [ ] Reading levels have no sentence-length numbers; toddler bands have no length level below 1st-grade and the prose writer never gets the band's craft rules.
- [ ] Italian tense rules contradict NARRATION_TENSE (`languages.js:252/276/284` vs `:539`); de-ch "no contractions" bans im/ins/zum; fr-ch "prefer vous" between children; `text-refine.txt:79` dash ban contradicts the writer's NO_DASH exception.
- [ ] Two declared mains: `pickMainCharacters` caps at 1 for ≤2 characters (`promptBuilders.js:6572`) → second sibling becomes a "passenger", against decisions 2026-09-25.
- [ ] STYLE_RULEBOOK sent whole to diff/lector; prompt caching wired but unused on arc/refine.

## SEO / content (owner copy)
- [ ] H1 on city/theme pages is the bare name; "Kinderbuch mit Namen/Foto" not targeted; French-slug pages; ~90 themes under 100 unique words; `mothers-day`/`fathers-day` no de/fr/it long text.
- [ ] City pages' primary CTA goes to `/create` (account) not `/try`; no `/try` CTA on Pricing/FAQ.
- [ ] Impressum lacks street address/UID; About has no founder; duplicate gift titles (`fuer-kinder` vs `einzigartiges-geschenk`); breadcrumb "Home" in every language.
- [ ] og:image points at the 544 kB PNG with wrong declared size (`client/index.html:62`) — switch to `og-image.jpg`?
- [ ] Is /try meant to stay in the sitemap?

## Conversion (owner copy/decisions)
- [ ] Plain-language photo-privacy statement at the upload (facts exist in PrivacyPolicy: deleted within 30 days, never shared).
- [ ] /try intro note devalues the trial ("schnelle Gratis-Probe … hohe Qualität mit Anmeldung").
- [ ] Trial→paid bridge: price anchor + printed-book image at the gate and on completion.
- [ ] One price framing everywhere (hero "ab CHF 29", FAQ "CHF 9.90" that does not exist, ads "Ab CHF 5").
- [ ] Homepage: ~7,700 px with no CTA on phones; 10.7 MB autoplay video; proof/testimonials far down; pricing page credits-first.
- [ ] Trial waiting page `rotationEmailHint` tells visitors to add the email "at the end" — contradicts decision #5.
- [ ] Ship the trial gate (staging-only per the 2026-10-05 handover).

## Website / a11y / perf (code, not yet done)
- [ ] `<main>` landmark on every public page; focus trap in the three dialogs; UserMenu roles; brand button tap target.
- [ ] Per-entry split of giftData / comparisonData / guideData like themeContent; lazy admin panels in StoryDisplay; trim unused Google-font weights; WebP city images.

## Email (owner)
- [ ] Default-language "English" ladders in email.js / trialEmail.js / trialReminders.js not recorded as a decision.

## Admin numbers
- [ ] Admin token-usage prices Anthropic at $3/$15 (Sonnet 5.5 is $2/$10); client re-prices rows with its own constants; totals silently cover only the newest 1000 stories; avatar cost not windowed.
