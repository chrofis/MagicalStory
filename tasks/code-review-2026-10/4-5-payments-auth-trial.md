# Areas 4+5 — Payments, auth, trial, sharing (review 2026-10-04)

Files: routes/print.js, server.js (Stripe webhook, startup sweeps, body limits, trust proxy), lib/referralBalance.js, lib/gelato.js, lib/orders.js, routes/admin/orders.js, storyJobPipeline.js (refund paths), routes/auth.js, middleware/auth.js, routes/sharing.js, lib/shareLinkSig.js, routes/files.js, routes/photos.js, routes/trial.js, email.js (verification mail).
Finders: 3 × Sonnet (payments; auth/sharing/files/photos; trial). Verifier: Opus, who read only the cited regions plus the callers and middleware needed to settle each finding.

Read-only DB checks (prod + staging, counts only):
- prod `referral_events` = 0, users with `referred_by` = 0, users with `referral_balance_cents > 0` = 0. The referral code and cash-out features are live but nobody has used them, so P1/P3/P7/P9 have no exposure today. They are latent.
- prod `files` has 23 rows, all `order_pdf`. There are no `story_pdf` rows.
- prod users with a mixed-case email = 0.
- prod orders: one `paid` order from 2026-01 with no Gelato id (legacy, before `stripe_mode` existed). 46 `completed` orders from 2025-12 to 2026-01 have `gelato_status='submitted'` and no Gelato id. That is legacy data, not evidence for any current finding.
- prod non-admin `@magicalstory.ch` accounts = 22 (staging 49), almost all `demo-*`.

## Confirmed

### S1 Account pre-hijack: a password account registered on someone else's email is merged into that person's later Google sign-in
Severity: major (privacy: children's photos and stories).
Where: routes/auth.js:48-130 (register), :160-200 (login), :314-321 and :538-545 (Google upsert `ON CONFLICT (username) DO UPDATE SET email_verified = TRUE`).
The failure: registering does not verify the email. Logging in does not require `email_verified`. Both Google handlers upsert by email and keep the existing row's password. So an attacker can register a target's address with a password they choose. When the real owner later clicks "Sign in with Google", they land in that same account. They upload photos of their children and create stories there. The attacker's password still works, so the attacker can read all of it. The handlers also never read the token's `email_verified` claim. And `/change-email` (:1091) can point an existing account at an unverified address, which is the same weakness by another route.
Fix: on the Google upsert into an existing row that has an unverified email, reset the password and invalidate old sessions (or refuse to merge). Require `payload.email_verified`.

### P8 A deploy during book-order processing leaves a paid order stuck in `processing`, with no alert
Severity: major (customer charged, no book, nobody notified).
Where: server.js:986-1001 (`processBookOrder(...).catch(...)`, fire-and-forget); lib/gelato.js:264-268 (`payment_status='processing'`); admin/orders.js:55-58 (`has_issue` only for `paid` with no Gelato id); lib/idleShutdown.js:69-85 (busy probes cover only story jobs and Test Lab).
The failure: after the webhook acks, PDF generation and the Gelato order run in the background. A container restart kills that work midway. The restart can be a deploy, which the pre-push busy gate does not block for this work, or an OOM or an idle shutdown. The order then stays in `processing` forever. Nothing sweeps it, the admin `has_issue` flag misses it, and the `.catch` alert never fires because the process is gone. A second path: if the Gelato call succeeds but the final UPDATE throws, the catch marks the order `failed` and emails the customer "order failed" even though the book was ordered.
Fix: register a busy probe for orders in `processing`; add a startup or periodic sweep that re-queues or alerts on stale `processing` orders; widen `has_issue` to cover them.

### T1 Unauthenticated trial endpoints put unbounded client text into paid Sonnet prompts
Severity: major (cost amplification by an outside attacker).
Where: routes/trial.js:2349-2420 (`/generate-ideas-stream`: no session, no Turnstile, `trialIdeasLimiter` 10/h/IP, two Sonnet calls); `storyTopic` and `characters[0].name/traits` go into the prompt as-is; `/create-story` stores `storyDetails`/`storyTopic` unvalidated (:1506-1610) and they are resent on every writer call; body limit is 50 MB (server.js:1401).
The failure: nothing caps field length, so one request can carry hundreds of thousands of tokens into two Sonnet calls. The limiter's store is in memory, so it resets on every deploy, and the limit is per IP, so rotating IPs multiplies it. The daily trial cap (`dailyTrialCounter`) counts stories and avatars, not idea calls.
Fix: per-field length caps (topic, name, traits, details) at the route, plus a global daily cap on idea calls.

### P1 Referral cash-out issues the Stripe refund before debiting the balance and ignores a failed debit
Severity: major (latent: 0 users hold a balance in prod today).
Where: routes/print.js:1650-1712; lib/referralBalance.js:346-372.
The failure: the balance is checked once before the loop. `stripe.refunds.create` runs with no idempotency key. Then `spendForRefund` runs, and its `{ok:false, reason:'insufficient_available'}` result is never checked. Two concurrent POSTs both pass the balance check and both refund, up to the PaymentIntents' refundable amounts. Only the first debit takes effect, so the user is refunded about twice their balance. If `spendForRefund` throws after Stripe succeeded, the catch logs "Refund failed" and leaves the balance untouched, so the money can be cashed out again.
Fix: reserve or debit the balance atomically first (a pending row), refund with an idempotency key, then confirm or release. Treat `ok:false` as an error.

### T2 `/api/trial/link-email` sends unlimited verification emails to any address
Severity: major (email-sending reputation; also a step in the S1 takeover chain).
Where: routes/trial.js:1860-1950.
The failure: one anonymous session token can resubmit any number of addresses, because only an already-verified email blocks it. Each call sends a verification email from the production sender. The only limit is the global 100/min/IP `apiLimiter`. The mail body contains only the verify link, because `sendEmailVerificationEmail` ignores the name, so no attacker text gets in. The realistic damage is bounces and complaints against the Resend account. If a recipient clicks the link, the attacker's trial account becomes verified under that person's email (`claim-session` then issues a full JWT), and a later Google sign-in by that person lands in it (S1).
Fix: a per-session and per-IP limiter on link-email, a cap on address changes per session, and the S1 fix.

### S2 The email-link `?key=` grants full private-story access for 60 days and survives unsharing
Severity: minor.
Where: routes/sharing.js:106-124 and every `getSharedStory(..., hasValidSignedShareKey(...))` call (:289, :428, :459, :486, :621, :643, :675); lib/shareLinkSig.js:13-23.
The failure: the threat-model comment in shareLinkSig.js says the key only unlocks a cover preload hint. In fact sharing.js treats it like `is_shared=true` for text, images and covers. The key cannot be revoked: turning sharing off does not invalidate it. Anyone the story-ready email gets forwarded to keeps access for 60 days. The link goes only to the owner's inbox, so exploiting this needs a leaked or forwarded email. Not recorded in decisions.md.
Fix: bind the key to the current share state (or a per-story nonce that is rotated on unshare), shorten the TTL, and correct the comment.

### P5 Failure refunds claim `credits_reserved` and credit the user in separate, non-transactional statements
Severity: minor (narrow window).
Where: storyJobPipeline.js:7506-7524 (and the sibling at ~8121); server.js:2650-2675 (stale-job sweep); the boot zombie cleanup.
The failure: the claim UPDATE zeroes `credits_reserved` and commits. The credit UPDATE and the ledger INSERT are separate pool queries. If the process dies or a query fails between them, the reservation is gone and the user never gets the credits back. The jobs.js cancel/stale paths already wrap this in a transaction.
Fix: one transaction, or one CTE statement, for claim + credit + ledger.

### P3 `referred_by` is claimed when checkout is created and never released if the checkout expires
Severity: minor (latent; locks the customer out of the promo).
Where: routes/print.js:1828-1840; server.js:1037-1062 (the expired handler releases only the balance hold).
The failure: a buyer who enters a code and abandons the Stripe page can never use a referral code again ("You have already used a referral code"), even though no discount was ever applied.
Fix: in `checkout.session.expired`, clear `referred_by` when it matches the session's code and no paid order exists.

### P2 The admin "retry print order" endpoint is dead, and wrong if revived
Severity: minor (no client caller).
Where: routes/print.js:1227-1390.
The failure: `JSON.parse(storyResult.rows[0].data)` runs on a JSONB object and always throws. The endpoint also looks for `file_type='story_pdf'`, and prod only has `order_pdf`. The endpoint is admin-only, so `isUserTestMode` is always true and it would always submit a Gelato **draft**, then mark a real paid order `submitted/completed`. It also uses quantity 1, the first story only, and a guessed product. No client code calls it.
Fix: delete it, or rebuild it on `processBookOrder` with the order's own type, quantity and stories.

### P7 Referral cashback and balance-confirm failures after payment are logged and dropped
Severity: minor (latent).
Where: server.js:948-952 (cashback rollback), :969-972 (`confirmPending`).
The failure: the order is saved, but the referrer's cashback or the buyer's pending-balance confirmation silently fails. Nothing retries it and no admin alert goes out. The pending hold stays locked.
Fix: send these through the existing `stripe_webhook_retry` buffer, or alert the admin.

### S5 Sessions survive a password reset, a password change and a role demotion; the reset lookup is case-sensitive
Severity: minor.
Where: routes/auth.js:658-662 (`WHERE email = $1`), :697-730 and :732-770 (no token revocation); middleware/auth.js:20-60 (7-day JWT; `requireAdmin` trusts the role inside the token).
The failure: a victim who resets their password after a takeover (S1) does not log the attacker out, because the attacker's JWT stays valid for 7 days. An admin who is demoted keeps admin rights until the token expires. The case-sensitivity part has no effect today (0 mixed-case emails in prod). Reset tokens are stored in plaintext.
Fix: a `token_version` / `password_changed_at` check in `authenticateToken`; use LOWER() in the reset lookup.

### P10 Unauthenticated `GET /api/stripe/order-status/:sessionId` returns the whole order row
Severity: minor.
Where: routes/print.js:2019-2050.
The failure: `SELECT *` sends name, shipping address and email to anyone who holds the Checkout session id. The id is long and random, but it travels in the success URL (history, referrers, support screenshots). Each call also holds a connection open for up to 5 seconds of retries.
Fix: return only the status fields, or require the owner's JWT for the PII.

### T3 `/api/trial/prepare-title` has no trial-used or per-account cap
Severity: minor (Grok sheet costs about CHF 0.05-0.10 per call).
Where: routes/trial.js:2563-2810; limiter :134 (5/h/IP, in-memory).
The failure: one session token can keep generating 2×4 avatar sheets after its trial is used. The only guards are the per-IP limiter and the concurrent-call 409.
Fix: reject when `stories_generated >= story_quota`, or when `preGeneratedStyledAvatars` already exists for the same costume.

### T4 Turnstile verification fails open
Severity: minor.
Where: routes/trial.js:768-793.
The failure: a missing `TURNSTILE_SECRET_KEY`, or any siteverify network error, returns `true`. That contradicts the project's no-fallbacks rule. An attacker cannot force a siteverify error, so this is exploitable only if prod lacks the secret (not checked).
Fix: fail closed and log at error level.

### S4 `/api/shared/:token/header` lacks the `NOT admin_draft` filter its siblings have
Severity: minor.
Where: routes/sharing.js:226-244 vs :143, :162.
The failure: the title, page count and front-cover URL of a draft made while impersonating are served to the impersonated owner or a signed-key holder, while the full endpoint correctly hides that draft.
Fix: add `AND NOT admin_draft` to the header query.

### P9 The self-referral check compares user ids only
Severity: minor (latent; promo leakage).
Where: routes/print.js:1479-1515.
The failure: a second account of the same person qualifies, once it makes a real paid first order. That yields CHF 10 off plus CHF 10 cashback, which can be cashed out to a card. The check has no email, payment-fingerprint or address comparison.
Fix: compare the Stripe payment-method fingerprint or the shipping address against the referrer's orders in the webhook.

### S6 Unauthenticated `GET /api/photos/status` exposes the internal analyzer URL and error text
Severity: minor.
Where: routes/photos.js:14-37.
The failure: the response contains `PHOTO_ANALYZER_URL` and raw fetch errors, and every hit triggers an upstream call. This is separate from the BACKLOG item at BACKLOG.md:572 (owner decided not to add retries to that path), which concerns retries, not disclosure.
Fix: drop `url` and the error text, or move the endpoint behind admin auth.

### V1 (verifier) Any `@magicalstory.ch` registration is auto-verified
Severity: minor.
Where: routes/auth.js:120-128.
The failure: `isDemoAccount` is a domain regex. Nobody can receive mail at a made-up `x@magicalstory.ch`, but registering one skips the email-verification gate. That gives 200 welcome credits and story generation with no inbox, at 5 registrations/h/IP. Disposable inboxes give much the same, so the extra risk is small.
Fix: auto-verify only via the showcase orchestrator (admin-created accounts), not by domain.

## Plausible (needs a data/config check to settle)

### P4 `checkout.session.completed` grants credits and starts the print order without checking `payment_status === 'paid'`
Severity: major if a delayed payment method is enabled; otherwise none.
Where: server.js:581-700 and the order branch; print.js:1874, :1986 (`payment_method_types` omitted, so the Dashboard settings apply); `checkout.session.async_payment_failed` / `async_payment_succeeded` are not handled.
With card or TWINT the payment completes synchronously and this is safe. With SEPA debit, bank transfer or another delayed method, credits and a print order would go out before the money arrives.
Would settle it: the payment methods enabled in the Stripe Dashboard (live account). Cheap to harden either way.

### T5 Trial prepare-title and preview-avatar overwrite the whole character blob from a read up to ~100 s old
Severity: minor.
Where: routes/trial.js:2602 → :2799 (prepare-title), :1110 → :1129 (preview-avatar save), :1357 → :1395 (PATCH update-character-details).
The code race is real. Prepare-title fires when the Ideas step mounts (TrialIdeasStep.tsx:316). PATCH fires when the user leaves the Character step (TrialCharacterStep.tsx:487). So a user who goes back and edits the name while the sheet is generating loses that edit when prepare-title writes.
Would settle it: trial rows where `users.trial_data.characterData.name` differs from the name used in the story, or a log search for a PATCH inside a running prepare-title.

### V2 (verifier) Per-IP limiters may be keyed on a proxy IP, not the client
Where: server.js:342 (`trust proxy 1`) vs lib/ipLocation.js:21, which already reads `cf-connecting-ip` because XFF has more than one hop.
If traffic comes through Cloudflare and then Railway's edge, `req.ip` is the Cloudflare edge address. Every per-IP limiter (T1, T2, T3, register, auth) is then shared across unrelated visitors and too loose against a single attacker. Spoofing is not possible with `trust proxy 1`.
Would settle it: one log line comparing `req.ip` with `cf-connecting-ip` on prod.

## Rejected

- S3 (`/api/files/:id` public): ids are `Date.now()` plus about 46 bits of `Math.random`. That cannot be enumerated, and recovering V8's PRNG state from truncated base36 output is not practical. The public route is deliberate: Gelato fetches the print PDF from it. Prod holds 23 `order_pdf` rows. Hardening only: switch to `crypto.randomUUID()` and make the PDF URL signed and expiring.
- P6 (unchecked deduct on iterate/repair): duplicate of area 2 B1/B2 → tasks/code-review-2026-10/2-images-repair.md:24.
- S5, case-sensitive reset lookup only: no effect, 0 mixed-case emails in prod. The JWT-revocation part is confirmed above.
