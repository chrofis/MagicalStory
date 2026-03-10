# Full Code Review — MagicalStory
**Date:** 2026-03-10
**Scope:** Security, Performance, UX, Technical Debt

---

## Table of Contents
1. [Critical Issues](#1-critical-issues)
2. [Security](#2-security)
3. [Performance & Architecture](#3-performance--architecture)
4. [Customer Experience & UX](#4-customer-experience--ux)
5. [Technical Debt & Code Quality](#5-technical-debt--code-quality)
6. [Positive Observations](#6-positive-observations)

---

## 1. Critical Issues

These should be addressed before the next deploy or as soon as possible.

### SEC-1: Hardcoded Admin Secret in Source Code
- **Files:** `server/routes/admin.js` (lines 274, 330, 379), `server/routes/admin/swiss-landmarks.js:28`, `server/routes/admin/landmark-index.js:30`
- **Impact:** Critical
- All use `process.env.ADMIN_SECRET || 'clear-landmarks-2026'`. If `ADMIN_SECRET` isn't set, anyone who reads the code can call destructive admin endpoints.
- **Fix:** Remove the hardcoded fallback. Refuse with 401 if `ADMIN_SECRET` is not set. Rotate the secret since it's in git history.

### SEC-2: JWT Token Exposed in Redirect URL
- **File:** `server/routes/auth.js:699`
- **Impact:** Critical
- After trial email verification, the JWT is put in the URL: `/email-verified?token={JWT}&trial=true`. Tokens in URLs appear in browser history, server logs, Referrer headers, and CDN logs. The JWT lasts 7 days.
- **Fix:** Use an HttpOnly cookie or a short-lived single-use nonce instead.

### PERF-1: Dual Database Connection Pool
- **Files:** `server.js:531-552` (creates its own `Pool`) + `server/services/database.js:8-42` (creates a second)
- **Impact:** Critical
- Two independent pg pools are open. Stripe/Gelato webhooks, checkpoints, and `processStoryJob` use the local pool. Route modules use the modular pool. This silently doubles baseline connections against Railway's connection limit.
- **Fix:** Remove the local Pool in `server.js`. Migrate all remaining `dbPool.query` calls to use the modular `dbQuery`.

### DEBT-1: Broken Module Import
- **File:** `server/lib/storyAvatarGeneration.js:17`
- **Impact:** Critical
- `require('./logger').forModule('avatar-gen')` — no `server/lib/logger.js` exists. The logger lives at `server/utils/logger.js` and has no `forModule` method. This file crashes on require.
- **Fix:** Change to `const { log } = require('../utils/logger');`

### DEBT-2: Firebase Service Account Key Possibly Tracked in Git
- **File:** `magical-story-3b745-firebase-adminsdk-fbsvc-a4d1b24148.json`
- **Impact:** Critical
- This file exists at root. The `.gitignore` pattern should catch it, but verify with `git ls-files`. If tracked, remove with `git rm --cached` and rotate the key.

### DEBT-3: Hardcoded FreeImage API Key
- **File:** `server/lib/magicApi.js:28`
- **Impact:** Critical
- `const FREEIMAGE_API_KEY = '6d207e02198a847aa98d0a2a901485a5'` — hardcoded in committed source.
- **Fix:** Move to env var `FREEIMAGE_API_KEY`.

---

## 2. Security

### SEC-3: No Input Size Validation on Base64 Uploads (High)
- **Files:** `server/routes/trial.js:316-530`, `server.js:1256`
- Global body parser allows `100mb`. Trial endpoints accept multiple base64 strings with no per-field size limit. An attacker can exhaust server memory.
- **Fix:** Validate base64 string length per field (reject > 15MB). Apply 100MB limit only to routes that need it; use 1MB globally.

### SEC-4: AI Proxy Accepts Arbitrary Model Names (High)
- **File:** `server/routes/ai-proxy.js:140-146`
- `POST /api/gemini` accepts any `model` from request body without whitelist. Users can route requests to expensive/experimental models.
- **Fix:** Validate `model` against an explicit allowlist.

### SEC-5: Wrong Column in Sharing Route (High)
- **File:** `server/routes/sharing.js:152-153`
- Queries `password_hash` but the column is `password`. Always returns null, causing `needsPassword = true` for story owners.
- **Fix:** Change to `password` column or use `has_set_password` flag.

### SEC-6: Trial Password Minimum Inconsistency (High)
- **File:** `server/routes/trial.js:1988`
- Trial claim validates `password.length < 6` while every other path enforces minimum 8.
- **Fix:** Change to `< 8`.

### SEC-7: CSP Fully Disabled (Medium)
- **File:** `server.js:591-596`
- `contentSecurityPolicy: false` passed to Helmet. No XSS backstop.
- **Fix:** Implement a CSP policy appropriate for a React SPA.

### SEC-8: User Text Flows Directly into AI Prompts (Medium)
- **File:** `server/lib/storyHelpers.js:2156-2281`
- `storyTopic`, `storyDetails`, `customThemeText`, `dedication` are interpolated into prompts with length-only sanitization. Prompt injection risk.
- **Fix:** Wrap user content in XML boundary tags (`<user_input>`) and instruct models to treat as data.

### SEC-9: In-Memory Rate Limiters Reset on Deploy (Medium)
- **Files:** `server/routes/trial.js:28-56`, `server/middleware/rateLimit.js`
- All rate limiters use MemoryStore. Every deploy to Railway resets all counters.
- **Fix:** Use Redis or PostgreSQL-backed store for the most sensitive limiters (avatar generation).

### SEC-10: `railway.app` Wildcard CORS (Medium)
- **File:** `server.js:573-575`
- `origin.includes('railway.app')` allows any Railway subdomain as CORS origin with credentials.
- **Fix:** Replace with explicit domain pattern match.

### SEC-11: Auth Token in Image URLs (Medium)
- **File:** `client/src/pages/SharedStoryViewer.tsx:147-149`
- JWT appended as query parameter to image URLs. Leaks to browser history, logs, referrers.
- **Fix:** Use short-lived signed media tokens or cookie-based auth for image endpoints.

### SEC-12: Manual X-Forwarded-For Parsing (Medium)
- **File:** `server/routes/user.js:19-20`
- Reads `X-Forwarded-For` directly instead of using `req.ip` (which Express normalizes via `trust proxy`). IP can be spoofed.
- **Fix:** Use `req.ip`.

### SEC-13: Stripe userId Parsed with parseInt (Low)
- **File:** `server.js:723,789`
- Trial users have UUID IDs. `parseInt` on a UUID returns NaN or wrong value. Could cause credit assignment to wrong user or silent failure.
- **Fix:** Don't parseInt; validate as string matching expected format.

### SEC-14: SSL Certificate Validation Disabled for DB (Low)
- **File:** `server.js:533-538`
- `ssl: { rejectUnauthorized: false }` — common on Railway but vulnerable to MITM.

---

## 3. Performance & Architecture

### PERF-2: Sequential Per-Row Database Writes (High)
- **File:** `server/services/database.js:1421-1492` (`saveRetryHistoryImages`), lines 520-575 (`saveStoryData`), lines 826-876 (`upsertStory`)
- Each image version is saved with an individual `await INSERT`. A 30-page story with retries produces up to 360 sequential DB round trips.
- **Fix:** Batch into multi-row INSERTs or use `Promise.all` since writes are independent.

### PERF-3: server.js is 5,098 Lines (High)
- **File:** `server.js`
- Still contains: Stripe webhook (~340 lines), Gelato webhook (~260 lines), `processStoryJob` (~750 lines), `initializeDatabase()` (~450 lines), checkpoint system, landmark endpoints, and 127 direct `dbQuery` calls.
- **Fix:** Extract to `server/routes/stripe.js`, `server/routes/gelato.js`, `server/services/storyPipeline.js`, `server/services/checkpoints.js`.

### PERF-4: pLimit(50) is Effectively No-Limit (Medium)
- **File:** `server/lib/images.js:3093,4222,4339,4483`
- 50 concurrent tasks for 30 pages = all fire simultaneously. Holds ~60MB base64 in memory and risks hitting Gemini rate limits.
- **Fix:** Lower to `pLimit(10)` for evaluations, `pLimit(5)` for image generation.

### PERF-5: Base64 TEXT Columns for Image Storage (Medium)
- **File:** `server/services/database.js:366` and story_images schema
- Base64 TEXT is 33% larger than binary, wastes TOAST overhead.
- **Fix:** Migrate to `BYTEA` columns. Long-term, consider object storage (S3/R2).

### PERF-6: No Retention Policy for Retry History Images (Medium)
- **File:** `server/services/database.js:1421-1492`
- A story with max retries can save 300MB+ of retry images with no cleanup.
- **Fix:** Prune retry images for pages with good scores after generation completes.

### PERF-7: 100MB Body Limit Applies Globally (Medium)
- **File:** `server.js:1256`
- `express.json({ limit: '100mb' })` on every route. Any endpoint can receive 100MB payloads.
- **Fix:** Use `1mb` globally, override to `100mb` only on image/story-save routes.

### PERF-8: StoryWizard.tsx — 90 useState, 40 useEffect, No Memoization (Medium)
- **File:** `client/src/pages/StoryWizard.tsx`
- 5,386 lines, 90 state variables, 2 useCallback/useMemo. Any state update re-renders the entire component tree.
- **Fix:** Split into `WizardConfigContext` + `GenerationResultContext`. Wrap expensive callbacks with `useCallback`.

### PERF-9: StoryDisplay.tsx is 5,547 Lines (Medium)
- **File:** `client/src/components/generation/StoryDisplay.tsx`
- Bundles story display, dev panels, modals all in one chunk.
- **Fix:** Sub-split into `StoryDisplayCore`, lazy-load `DevModePanel` and modals.

### PERF-10: Checkpoint Data Includes Full Image Data (Medium)
- **File:** `server.js:1907-1921`
- `partial_page` checkpoints store ~200KB base64 per page. 30-page story = ~6MB in JSONB checkpoints.
- **Fix:** Strip `imageData` from checkpoints; retrieve from `story_images` during recovery.

### PERF-11: JSON.parse(JSON.stringify) Deep Clone of Story Data (Medium)
- **File:** `server/services/database.js:512`
- Deep-clones 6-10MB story objects during every save, doubling peak memory.
- **Fix:** Build stripped copy structurally instead of clone-then-delete.

### PERF-12: GEMINI_API_KEY Read from process.env 15 Times (Low)
- **File:** `server/lib/images.js`
- **Fix:** Read once at module init: `const GEMINI_API_KEY = process.env.GEMINI_API_KEY;`

---

## 4. Customer Experience & UX

### UX-1: Trial Funnel Shows Sign-Up Form During Generation (High)
- **File:** `client/src/pages/TrialGenerationPage.tsx:596-654`
- Email form appears immediately when generation starts, competing with the "creating..." state.
- **Fix:** Show sign-up form only after completion (or at 80%+ progress).

### UX-2: No 404 Route (High)
- **File:** `client/src/App.tsx`
- No catch-all `<Route path="*">`. Invalid URLs show blank pages.
- **Fix:** Add `<Route path="*" element={<Navigate to="/" replace />} />` or a 404 page.

### UX-3: Share URL Route Mismatch (High)
- **Files:** `SharedStoryViewer.tsx:212` constructs `/s/${shareToken}`, but `App.tsx:49` registers `/shared/:shareToken`
- Share links may 404.
- **Fix:** Verify and align route registration with URL construction. Add both routes if needed.

### UX-4: Trial Failure Offers No Context or State Preservation (Medium)
- **File:** `client/src/pages/TrialGenerationPage.tsx:502-516`
- Generic "Something went wrong" with "Try Again" that discards all user input.
- **Fix:** Persist trial wizard state via `sessionStorage`. Distinguish timeout from hard failure.

### UX-5: Regular Users Cannot Cancel Stalled Generation (Medium)
- **File:** `client/src/components/generation/GenerationProgress.tsx:529-567`
- Cancel button only shown to admins. Regular users are stuck for up to 15 minutes.
- **Fix:** Show Cancel to all users when generation stalls.

### UX-6: Hardcoded English Strings in SharedStoryViewer (Medium)
- **File:** `client/src/pages/SharedStoryViewer.tsx:315-328`
- Error states ("Story Not Found", "Loading story...") hardcoded in English despite `useLanguage` being available.
- **Fix:** Add to translations map.

### UX-7: Wizard State Restored Even After Weeks (Medium)
- **File:** `client/src/pages/StoryWizard.tsx:84-90`
- Returning to `/create` restores stale localStorage state with no expiry.
- **Fix:** Add timestamp; only restore if < 24 hours old.

### UX-8: No Empty State on MyStories (Medium)
- **File:** `client/src/pages/MyStories.tsx`
- No dedicated "create your first story" empty state for new users.
- **Fix:** Add a prominent CTA when stories list is empty.

### UX-9: Developer Print Flow Uses browser prompt()/confirm() (Medium)
- **File:** `client/src/pages/StoryWizard.tsx:4279-4317`
- `prompt()` and `confirm()` are blocked on many mobile browsers.
- **Fix:** Replace with a proper modal form.

### UX-10: Page Counter Mismatch in SharedStoryViewer (Low)
- **File:** `client/src/pages/SharedStoryViewer.tsx:477`
- "Page X of Y" counts only story pages but dot navigation includes covers + end page.
- **Fix:** Use consistent counting across both indicators.

### UX-11: upsellDesc Empty in EN and DE (Low)
- **File:** `client/src/pages/TrialGenerationPage.tsx:65,111`
- French has content, EN/DE are empty strings. Field is never rendered anyway.
- **Fix:** Populate or remove the field.

### UX-12: Inline Ternary Translations Throughout StoryWizard (Low)
- **File:** `client/src/pages/StoryWizard.tsx` — dozens of occurrences
- `language === 'de' ? '...' : language === 'fr' ? '...' : '...'` bypasses the translation system.
- **Fix:** Move strings to `translations.ts`.

### UX-13: Two Different Header Styles for SharedStoryViewer (Low)
- **File:** `client/src/pages/SharedStoryViewer.tsx:336-426`
- Authenticated: `bg-black text-white`. Unauthenticated: `bg-white/80 backdrop-blur`. Brand name differs ("✨ Magical Story" vs "MagicalStory").
- **Fix:** Unify brand name; consider consistent header style.

---

## 5. Technical Debt & Code Quality

### DEBT-4: tokenUsage Object Defined 4 Times (High)
- **Files:** `server.js:2212,4344`, `server/lib/legacyPipelines.js:483,2409`
- Identical ~30-line block copy-pasted into every pipeline function.
- **Fix:** Extract `createTokenUsageTracker()` factory.

### DEBT-5: Rate Limiters Defined Twice (High)
- **Files:** `server.js:599-633` + `server/middleware/rateLimit.js:6-50`
- `authLimiter`, `registerLimiter`, `apiLimiter`, `aiProxyLimiter` are created twice with separate MemoryStores, halving rate-limit effectiveness.
- **Fix:** Import from `server/middleware/rateLimit.js`; remove duplicates.

### DEBT-6: authenticateToken Defined Twice (High)
- **Files:** `server.js:1982` + `server/middleware/auth.js:12`
- **Fix:** Import from middleware; delete local copy.

### DEBT-7: TEXT_MODELS Duplicated and Out of Sync (High)
- **Files:** `server/utils/config.js:14-51` (stale model names) vs `server/config/models.js:9-46` (current)
- The stale copy still references `claude-sonnet-4-5-20250929`.
- **Fix:** Delete from `utils/config.js`; import from `server/config/models.js`.

### DEBT-8: Zero Unit Tests for Core Pipeline (High)
- No tests for story generation, token usage tracking, image retry logic, entity scoring, or repair workflow orchestration.
- **Fix:** Prioritize unit tests for `selectBestVersion`, `findBadPages`, `evaluateImageBatch`, cost calculation.

### DEBT-9: No Database Migration System (High)
- Schema changes via manually-run scripts with no version tracking or rollback.
- **Fix:** Adopt `node-pg-migrate` or establish numbered SQL files with a migration runner.

### DEBT-10: errorResponse.js Created But Never Used (High)
- **File:** `server/utils/errorResponse.js`
- Well-designed `sendError` utility with error codes taxonomy. Zero route files import it. All 600+ error responses use ad-hoc inline objects.
- **Fix:** Adopt incrementally in new code.

### DEBT-11: Inconsistent Error Response Format (High)
- **Files:** All `server/routes/*.js` — ~600 instances
- Mix of `{ error: message }`, `{ error: message, details: ... }`, `{ error: err.message }`.
- **Fix:** Standardize via `errorResponse.js`.

### DEBT-12: server/index.js — Unused Alternate Entry Point (Medium)
- **File:** `server/index.js`
- Parallel modular entry point that is never deployed. Migration artifact.
- **Fix:** Delete or complete the migration.

### DEBT-13: database/config.js — MySQL Config, No Callers (Medium)
- **File:** `database/config.js`
- Configures MySQL2 but the system uses PostgreSQL. `mysql2` not in package.json.
- **Fix:** Delete.

### DEBT-14: PROVIDER_PRICING Re-implemented in Every Pipeline (Medium)
- **Files:** `server.js:2240-2248,4375-4389`, `server/lib/legacyPipelines.js:514-530,2433-2449`
- Local `calculateImageCost` lambda despite the same function already exported from `server/config/models.js`.
- **Fix:** Use the imported version.

### DEBT-15: buildStoryMetadata Defined in Two Places (Medium)
- **Files:** `server/services/database.js:467` (rich version) + `server/routes/stories.js:22` (stripped version)
- **Fix:** Export from database.js; delete duplicate.

### DEBT-16: Temp/Debug Files Tracked in Git at Root (Medium)
- **Files:** `tmp-analyze-images.js`, `tmp-check-vb.js`, `tmp-vb-data.json`, `fetch-prompt.js`
- **Fix:** Add `tmp-*.js`/`tmp-*.json` to .gitignore; `git rm --cached` them. Move `fetch-prompt.js` to `scripts/`.

### DEBT-17: `replicate` Package Installed But Unused (Medium)
- **File:** `package.json`
- No file imports `replicate`.
- **Fix:** Remove from dependencies.

### DEBT-18: legacyPipelines.js Uses bare console.log (Medium)
- **File:** `server/lib/legacyPipelines.js` (~15 occurrences)
- Bypasses log utility and LOG_LEVEL.
- **Fix:** Import and use `log` from `server/utils/logger`.

### DEBT-19: Mixed console.log / log.info in server.js (Low)
- 34 bare `console.log/error/warn` calls bypass LOG_LEVEL.
- **Fix:** Replace with `log.*` calls.

### DEBT-20: Pervasive `any` Casts in useRepairWorkflow.ts (Medium)
- **File:** `client/src/hooks/useRepairWorkflow.ts:297-417`
- Multiple `as any` where proper types exist.
- **Fix:** Use `EntityConsistencyReport` and `EntityCheckResult` types.

### DEBT-21: Dead Prompt Files (Low)
- `prompts/temp-historical-titles.js` — superseded by `server/config/trialTitles.js`
- `prompts/test-face-variations.txt` — never loaded
- `prompts/scene-expansion.txt` — loaded but overwritten by alias
- `prompts/story-idea-requirements-adventure.txt`, `story-idea-requirements-historical.txt` (base versions without number suffix) — never referenced
- **Fix:** Delete all five.

### DEBT-22: Test Files That Are Actually Admin Scripts (Low)
- **Files:** `tests/fix-roger-avatar.spec.ts`, `tests/setup-test-family.spec.ts`
- Named as Playwright specs but are one-time data setup scripts.
- **Fix:** Move to `scripts/admin/`.

### DEBT-23: Firebase Config Hardcoded in Client (Low)
- **File:** `client/src/services/firebase.ts:13-20`
- Firebase web keys are technically public, but hardcoding prevents rotation.
- **Fix:** Move to `VITE_FIREBASE_*` env vars.

### DEBT-24: Hardcoded Prompt Fallbacks in storyHelpers.js (Low)
- **File:** `server/lib/storyHelpers.js:2290-2299,2739,3072,3301`
- Silently falls back to stripped-down prompts when templates fail to load.
- **Fix:** Fail fast or log at error level.

### DEBT-25: nodemon in devDependencies But Not Used in dev Script (Low)
- **File:** `package.json`
- `dev` script is `node server.js`, not `nodemon server.js`.
- **Fix:** Change `dev` to `nodemon server.js`.

---

## 6. Positive Observations

**Security:**
- All database queries use parameterized queries (`$1`, `$2`) — zero SQL injection vectors found
- Story ownership correctly enforced via `AND user_id = $2` on all story queries (no IDOR)
- Password reset flow prevents email enumeration (same response whether email exists or not)
- Stripe webhook validates signatures with `constructEvent` + idempotency checking
- Trial flow has defense in depth: Turnstile CAPTCHA, fingerprint tracking, IP rate limiting, DB-persisted daily cap, atomic SQL for race prevention
- Admin impersonation prevents self/nested impersonation, uses short-lived tokens (2h)
- bcrypt rounds of 10 is appropriate

**Performance:**
- `getActiveStoryImages` CTE optimization avoids N queries for N pages
- `jsonb_set` for atomic partial updates during parallel page regeneration
- `App.tsx` lazy-loads all pages; StoryWizard lazy-loads expensive children
- LRU cache with TTL and hit/miss stats in image generation
- `image_version_meta` JSONB column avoids full blob updates for version switching
- Two-phase story loading (fast metadata → background full data)

**Architecture:**
- `server/services/prompts.js` — file-based prompt templates loaded at startup
- `server/config/models.js` — clean central source for AI model config and pricing
- TypeScript types in `client/src/types/story.ts` are exhaustive and well-documented
- `withRetry` wrapper shows disciplined retry logic with backoff
- Story images table separation from main blob is a major architectural win

**UX:**
- `GenerationProgress` with rotating character messages, avatar previews, and tips is delightful for a long wait
- `useSwipe` correctly distinguishes horizontal swipes from vertical scrolls
- Translation system covers EN/DE/FR with dialect variants (Swiss German, Austrian German)
- localStorage wizard state preservation with `?new=true` reset

---

## Priority Order

| Priority | Items | Effort |
|----------|-------|--------|
| **P0 — Now** | SEC-1 (admin secret), SEC-2 (JWT in URL), PERF-1 (dual pool), DEBT-1 (broken import) | Small |
| **P1 — This week** | SEC-3 (upload size), SEC-5 (wrong column), SEC-6 (password min), DEBT-5 (duplicate rate limiters), DEBT-6 (duplicate auth), UX-2 (404 route), UX-3 (share route) | Small-Medium |
| **P2 — This month** | SEC-7 (CSP), SEC-4 (model whitelist), PERF-2 (batch DB writes), PERF-7 (body limit), DEBT-4 (tokenUsage), DEBT-7 (stale models), DEBT-16 (tmp files), UX-1 (trial funnel timing), UX-4 (failure recovery) | Medium |
| **P3 — Backlog** | PERF-3 (split server.js), PERF-8/9 (split large components), DEBT-8 (tests), DEBT-9 (migrations), DEBT-10/11 (error responses), PERF-5 (BYTEA migration) | Large |
