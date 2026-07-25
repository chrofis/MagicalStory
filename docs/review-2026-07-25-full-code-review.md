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
