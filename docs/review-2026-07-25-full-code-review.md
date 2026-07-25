# Full Code Review — 2026-07-25

> Deep review of the entire codebase, run in parallel waves by subsystem.
> Findings are recorded per area with severity, file:line evidence, and a
> proposed fix direction. Verified findings are marked; unverified ones are
> hypotheses from a single reviewer pass.
>
> Severity scale: **P0** data loss / security / money — fix now · **P1** real
> user-visible bug · **P2** correctness edge case / robustness · **P3** code
> health, perf, maintainability.

## Status

- [ ] Wave 1 — backend core (security, payments, pipeline, images, entity, text/PDF, regeneration, avatars/trial)
- [ ] Wave 2 — client, DB layer, prompts↔parsers, providers, python analyzer, composites, email/sharing
- [ ] Wave 3 — adversarial verification of P0/P1 findings + synthesis
- [ ] Final summary + ranked fix list

## Scope inventory

| Area | ~Lines | Files |
|---|---|---|
| server.js (monolith) | 8,280 | server.js |
| server/lib | 65,145 | images.js (17k), storyHelpers (6k), entityConsistency (3k), … |
| server/routes | 25,002 | regeneration (6.2k), stories (3.8k), avatars (3.6k), trial (2.7k), print (2.1k), … |
| server services/config | 8,456 | database.js (3.2k), models.js, prompts.js, middleware |
| client/src | 73,746 | StoryWizard (6.2k), StoryDisplay (7k), AdminDashboard (2k), … |
| prompts | 71 templates | |
| python | 3,439 | photo_analyzer.py |
| email | 1,108 | email.js |

---

## Findings

### 1. Security — routes, middleware, auth (Wave 1) ✅

**Verdict: no P0/P1.** Ownership checks (IDOR) are systematically correct across
stories/regeneration/jobs/characters/avatars. The real issues are abuse-cost
and hygiene class.

- **[P2] Unauthenticated file serving with weak non-crypto IDs exposes user photos (incl. children's faces)** — `server/routes/files.js:105` + `:43` — `GET /api/files/:fileId` uses `optionalAuth` and deliberately no ownership check ("unique random IDs, so public access is acceptable"), but IDs are `` `file-${Date.now()}-${Math.random()...substr(2,9)}` `` — predictable timestamp + non-crypto random. Uploaded face/body photos and print PDFs are fetchable by anyone with/guessing an ID; IDs leak in `fileUrl` responses. **Fix:** `crypto.randomUUID` ids + ownership gate or signed expiring URLs.
- **[P2] Global API rate limiter bypassable with a forged (unverified) JWT** — `server/middleware/rateLimit.js:28-42,55` — `apiLimiter` skips when `jwt.decode` (not verify!) yields `role==='admin'` or `impersonating===true`. Any unsigned token with `{"role":"admin"}` skips the 100/min cap; expensive unauthenticated endpoints (`sharing.js:653` og-image sharp resize, text-overlay render, `/api/user/location` outbound fetch) lose their only throttle → CPU DoS. **Fix:** skip based on verified `req.user` only.
- **[P2] AI proxy = free uncharged compute for any registered user** — `server/routes/ai-proxy.js:39,117` — `POST /api/claude` / `POST /api/gemini` deduct **no credits**, accept arbitrary prompts, and honor caller-supplied `max_tokens` (line 78, no clamp). Open registration → 60 calls/min of operator-paid Claude/Gemini. **Fix:** credit-charge or admin-gate; clamp `max_tokens` and prompt size.
- **[P3] Login email enumeration** — `auth.js:178` vs `:201` — `EMAIL_NOT_REGISTERED` vs `Invalid credentials` distinct responses defeat the dummy-bcrypt timing equalization. **Fix:** identical generic 401.
- **[P3] Legacy admin endpoints: `ADMIN_SECRET` in query string + timing-unsafe compare** — `admin.js:284,339,387` — secret lands in access logs/Referer; `/job-input` returns full job input/result data behind it. **Fix:** header + `timingSafeEqual`, prefer JWT-admin.
- **[P3] API-key prefixes logged** — `ai-proxy.js:49,127` — first 6 chars of live keys in logs. **Fix:** log set/unset boolean only.
- **[P3] Stateless 7-day JWTs: demotion/logout/password-change don't revoke** — `middleware/auth.js:39-51`, `auth.js:1260` — demoted admin keeps admin for up to 7 days; stolen tokens irrevocable. **Fix:** token-version column checked on sensitive routes.
- **[P3] OAuth redirect trusts Host headers when `FRONTEND_URL` unset** — `auth.js:424-429,587` — token fragment could be steered to attacker origin if env var missing. **Fix:** fail closed on missing `FRONTEND_URL`.
- **[P3] `/api/user/location` interpolates client-spoofable IP headers into outbound URL** — `user.js:19-37` — path injection into ip-api.com call (not full SSRF). **Fix:** regex-validate IP.
- **[P3] Mass assignment: `create-story` spreads whole `req.body` into `story_jobs.input_data`** — `jobs.js:101` — unaudited fields (model overrides, skip flags) ride along. **Fix:** allowlist.

**Checked and clean (defenses verified at line level):** story/regen/job/character/draft/avatar IDOR scoping (`WHERE user_id=$2` everywhere, any-story reads gated by `canReadAnyStory`); admin gating incl. impersonation re-check; parameterized SQL throughout (one dynamic-column case uses a hardcoded allowlist, `stories.js:779`); share tokens 64-hex `crypto.randomBytes(32)` + HMAC signed-key path with `timingSafeEqual`; password reset (1h expiry, generic response, cleared on use); trial admin-bypass HMAC (purpose-scoped, 5-min TTL); staging basic-auth constant-time; JWT_SECRET fail-closed at boot; Stripe webhook raw-body signature before json parser; Gemini proxy model allowlist; no user-controlled path traversal.

---

### 2. Background job pipeline — lifecycle, watchdog, credits (Wave 1) ✅

**Verdict: the credit-refund topology has holes.** The atomic-claim refund
pattern exists and is correct where used — but three failure paths skip it, and
"killing" a job doesn't actually stop it.

- **[P1] Watchdog + stale-detection mark jobs `failed` WITHOUT refunding reserved credits** — `server.js:8214-8227`, `server/routes/jobs.js:460-469`, `:684-691` — the 15-min sweep and the status-poll/my-jobs stale transitions flip status but leave `credits_reserved` untouched and never credit `users.credits` back. Contrast: create-story stale path (`jobs.js:206-250`) and boot zombie cleanup (`server.js:8078-8098`) DO refund. Compounding: `cleanupOldCompletedJobs` (`jobs.js:54-58`) **deletes failed rows after 1 hour**, destroying the `credits_reserved` evidence — the debt becomes undiscoverable. **Fix:** apply the cancel-endpoint's atomic-claim refund inside `sweepStaleJobs` + the poll stale transition.
- **[P1] Credit reservation leaks if the job INSERT fails** — `jobs.js:330-360,395-398` — credits debited atomically (line 330), then job INSERT (line 356); if INSERT throws (e.g. two concurrent submits with same `idempotencyKey` → second hits the partial unique index), outer catch returns 500 — debited credits never refunded and **no job row exists to carry the reservation**. **Fix:** one transaction, or refund-in-catch.
- **[P1] Double-submit without idempotency key double-charges** — `jobs.js:177-279` — active-job check is SELECT-then-INSERT, no lock, no DB constraint (idempotency key optional). Two near-simultaneous POSTs → both reserve, both insert, two full pipelines. **Fix:** partial unique index `ON story_jobs(user_id) WHERE status IN ('pending','processing')` or mandatory idempotency key.
- **[P1] "Killed" jobs keep running, keep spending, and can overwrite `failed`/`cancelled` with `completed`** — `server.js:7473-7485,7242-7248` — `checkCancellation()` only aborts on `'cancelled'` and is NOT threaded into `runUnifiedRepairPipeline` (whole repair phase never checks). Completion write is **unconditional** (`UPDATE ... SET status='completed' WHERE id=$5`). Scenarios: stale-refunded job finishes anyway → refund + finished story; user cancels during repair/finalize window → refund + `'cancelled'` overwritten by `'completed'` → free story. **Fix:** completion UPDATE `WHERE status='processing'`, reconcile credits on mismatch.
- **[P1] Status-poll can false-fail a healthy job (heartbeat gaps)** — `jobs.js:441-469` vs `server.js:5462,5663,5879,6747` — three inconsistent thresholds (10 min poll / 15 min sweep / 60 min total; comments still say "5 minutes"). Phase 5a/5a-pre heartbeats fire only on image *completion* — first completion >10 min (provider backoff at concurrency 50) → job failed while working. Repair loop already fixed this with a 30s interval ticker (`images.js:8488`); 5a and finalize (no heartbeat at all after progress 73, during R2 upload of every image) didn't. **Fix:** interval-ticker pattern in 5a/5a-pre/finalize; unify thresholds.
- **[P2] Boot zombie cleanup: non-atomic refund + rolling-deploy race** — `server.js:8053-8102` — refunds from stale SELECTed values (not atomic-claim); overlapping deploy containers can double-refund, and the new container can fail jobs an old draining container then completes.
- **[P2] Job "completes" at full price with most pages failed** — `server.js:6062-6083,7099-7119` — per-page catch converts failure to `{imageData:null}` and continues; no minimum-success gate before completion. Also warn-and-continue on: null scene expansions (whole pages dropped, 4909), empty VB (3109), coverless after 3-min timeout (6613), vantage plates, scale repair, shared bbox, checkpoints, cover typography, styled-avatar persistence. **Fix:** success-ratio gate + proportional refund; surface degradations in `result_data`.
- **[P2] ~0.5–1 GB peak per repair-heavy job, no global concurrency cap** — `server.js:5790-6079,7203-7241` — all base64 held in memory whole-job (~15–25 MB/page × 15 + covers + versions + retry history); `dropInlineBase64` comment confirms a real 256 MB jsonb overflow happened. Only per-user cap exists; 5–8 concurrent repair-heavy jobs threaten the 8 GB heap. **Fix:** global job semaphore; stream versions to R2 as produced.
- **[P2] Retry-storm surface: pLimit(500) bbox + evalConcurrency 500 per job** — `server.js:6337-6364` — 500 simultaneous Gemini calls manufacture the 429/503s the retries then amplify; two jobs → 1000.
- **[P2] Row stuck `pending` forever if the failure handler's own DB write throws** — `jobs.js:381-383`, `server.js:7969-7974` — falls to the sweep, which doesn't refund (see first P1).
- **[P3] Progress written at task start** (races to ~30 with zero images done); "95%" comment writes 73; completed rows deleted after 1 h → late poll gets 404.
- **[P3] Polling bandwidth: without optional `?knownPages=`, every poll re-downloads all completed pages (~10–20 MB).**

**Checked and clean:** atomic-claim refund correct in cancel/create-story-stale/pipeline-catch paths; credit reservation race-safe (`UPDATE ... AND credits >= $1`); `JobCancelledError` vs `failed` distinction; checkpoint lifecycle (upsert, delete on completion, CASCADE); throttled in-flight-guarded heartbeat helper; repair-loop 30s ticker; cover `Promise.all().catch()` + 3-min race at both await sites; `AbortSignal.timeout` on every external fetch checked (Grok 120s, Runware 60–120s bounded retry, Gemini 120–300s, Anthropic ~5min/25min streaming cap); `savePartialStoryFromCheckpoints` clobber guard; per-job `runInCacheScope` isolation.

---

### 3. Image generation + evaluation — `images.js`, scoring, validators (Wave 1) ✅

**Verdict: retry/score/aspect machinery is largely sound; the rot is in cost
accounting (four no-op tracker calls) and dead eval fields consumers pretend
exist.**

- **[P1] Repair/bbox/consistency/re-eval usage silently dropped from cost accounting** — `images.js:13533,13627,13795,13818` — `usageTracker` contract is `(provider, usage, functionName, modelName)` (`server.js:2869`), but four call sites inside `generateImageWithQualityRetry` misuse it: `13795` uses the removed legacy 5-arg signature (provider receives a usage *object* → junk `[object Object]` bucket, 0 tokens); `13533/13627/13818` pass `(null, usage, null, model)` → **no-op that still stamps `usage.__accounted=true`**, blocking later legitimate accounting. Compounding: Grok repair usage shape is `{model, cost}` — no tokens — so even correct plumbing would count $0. Every auto-repair Grok edit, bbox-detect, incremental-consistency and post-repair re-eval is invisible in per-story cost. Same family as the recent "cost NaN" fixes; these instances remain.
- **[P1] `evaluateImageQuality` never returns `object_matches` / `expectedText` / `actualText` — three consumer features are dead** — `images.js:1981-2001` vs consumers at `4794,4909,5441,6422,6468,6482,13455-13467,13582` — `object_matches` read in every branch, always `[]` (P1 visual inventory produces it at `710` but the merge at `1864-1876` drops it). The cover "NO TEXT expected" carve-out (`13455`) can never fire (`expectedText` always undefined; `textIssue` never `'MISSING'`) — textless-by-design covers go to full regen. **Fix:** return the fields or delete the dead features.
- **[P2] Last-attempt generation error throws away a usable earlier attempt** — `images.js:13434-13436` — `if (attempts >= MAX_ATTEMPTS) throw` even when `bestResult` holds a scored image from attempt 1-2; transient outage on attempt 3 fails the page instead of shipping the 55% image. **Fix:** `if (bestResult) break;`.
- **[P2] Falsy-zero severity bugs** — `issueExtractor.js:39,504`: `SEVERITY_ORDER[a.severity] || 2` with `critical: 0` → critical ranks as minor in dedup; overlapping major can dominate-drop a critical. `images.js:16078`: `severityOrder['critical'] || 1` → `minSeverityToFix:'critical'` behaves as `'major'`. `moderate`/`catastrophic`/uppercase not in tables. **Fix:** `??` + complete case-insensitive tables.
- **[P2] Runware branches hardcode 1024×1024, ignoring `MODEL_DEFAULTS.pageAspect` (3:4)** — `images.js:4748-4754,5160-5166,5585-5591,5840-5846` — square pages in an A4 pipeline; breaks text-overlay geometry + PDF layout on any Runware/dev config. **Fix:** one aspect→dims helper.
- **[P2] Runware backend branch drops `imageUsage`/`qualityUsage`** — `images.js:4781-4802` — exact bug class documented as fixed for the Grok branch (`4818-4821` comment); Runware never got the fix → untracked cost.
- **[P2] Out-of-scope `finishReason` → ReferenceError sabotages bbox truncated-JSON repair** — `images.js:3484` (declared inside `for` at 3369) — throws on every successful truncated-JSON repair; regex fallback then overwrites the good parse with figures-only → `objects[]`/missing-object flags silently lost whenever eval JSON truncates. **Fix:** hoist declaration.
- **[P2] STEP 2C proportion check disabled on the production-default backend** — `images.js:4882-4891` — the `imageBackend==='grok'` branch (prod default) omits `sceneCharacters` from the eval call; Runware/model-routed/Gemini branches all pass it. Head-to-body proportion block empty on the main path.
- **[P2] Eval failures fail OPEN in the quality-retry path** — `images.js:13441,13499-13514` — `null` eval (API error, safety block, unparseable JSON…) → image accepted with `score:null`, no `evaluated:false` flag (batch path has one; covers/iterate/regeneration path doesn't).
- **[P2] No timeout on repair-verification Gemini calls** — `repairVerification.js:171,295` — missing the `timeout:120000` that `sceneValidator.js:30` added after the 2026-07-07 stuck-at-51% incident; same hang class available in grid-repair verification.
- **[P2] Post-repair return pairs repaired bytes with pre-repair bbox overlay** — `images.js:13863-13874,13941-13952,13975-13983` — fails safe thanks to the `sourceImageFp` invariant (verified enforced at all consumers), but persists mismatched overlays and forces redundant re-detection.
- **[P3]** (abridged; full detail in agent report) `imageFingerprint` hashes full data-URI not payload (false stale-bbox); legacy `parseFloat("8/10…")` → 8/100 misread + unclamped `score*10` paths; cover `TITLE_ERROR` regex matches "texture" (no trailing boundary) and best-by-score can ship the title-error cover; Grok 7.5k truncation blind tail-chop cuts the trailing no-text/copy-space rules + dead ternary defeats backend override; batch-index→page mapping ambiguity; consistency parse failure shape (`consistent:false, issues:[]`); `wasRegenerated:true` on single-attempt; stale hardcoded prices in sceneValidator (~2-4× under-report); `repairScene` newline-escape corrupts multi-line JSON; mime declarations wrong both directions (benign today); double-count guard bypassed in post-three-stage merge; eval cache key ignores model overrides (dev A/B confusion); `evaluateImageBatch` default concurrency 100.

**Checked and clean:** retry loop keeps BEST not last (`13491-13497`); bounded retries everywhere, no retry↔repair recursion (`maxPasses:3` + deliberate ping-pong terminators); scoring.js triplication intentional and consistent, `capEntityPenalty` idempotent, tie-breaks correct; no `null>=60` coercion paths; bbox normalize/round-trips consistent `[ymin,xmin,ymax,xmax]`; `editImageWithPrompt` aspect-snap exemplary (log-ratio nearest preset; Gemini fallback swaps model IDs correctly at all 3 sites); markdown-fence/balanced-brace/MAX_TOKENS-retry eval plumbing correct; LRU caches have real eviction, bbox cache content-hashed.
