# Area 6 — Other routes (review 2026-10-04)
Files: server/routes/stories.js, storyDraft.js, jobs.js, storyIdeas.js, avatars.js (styledAvatars, referenceSheets skimmed), admin.js, admin/*.js, lib/pdf.js (image fetch only), middleware/auth.js. Finders: 3 × Sonnet; verifier: Opus. Read-only; DB checks are counts only (prod + staging).

## Confirmed

### V1 A better-scoring avatar retry is thrown away; the DB keeps the rejected avatar but stores the retry's score and clothing
Severity: major (default path for every character whose first avatar scores low; the stored avatar is what every page renders from).
Where: routes/avatars.js:2286-2323 (retry swap), 1960-1983 (R2 upload, first attempt only), 2507-2514 (persist).
Failure: the async avatar job uploads each first-attempt avatar to R2 and sets `results.<category>Url`. When the retry scores higher, it swaps only the inline bytes, thumbnails, prompt, `faceMatch` and `structuredClothing`; it never uploads the retry or updates the URL. The writer then drops inline bytes whenever a URL exists (`onlyIfNoUrl`, `onlyMissingThumbs`), so the character row keeps the rejected image and its thumbnails, labelled with the retry's score and the retry's clothing description.
Evidence: the client discards the job payload and reloads the character from the DB (`characterService.ts` ~1150-1175), so the DB row is what the user and the pipeline see. The retry runs on every category under `MIN_BASE_AVATAR_SCORE` or the ArcFace gate (`ENABLE_AVATAR_EVALUATION = true`, :163).
Fix direction: upload the retry to R2 (new `r2Version`) and set `results.<category>Url` and the thumbnail URLs when the retry wins.

### R1 Cancel can refund a story that is already saved, and can turn a completed job into 'cancelled'
Severity: minor (needs a cancel in the last seconds of a run; money loss is one free story).
Where: routes/jobs.js:766-772 (refund claim, no status/progress guard), :808-815 (status write, no `WHERE status` guard).
Failure: `upsertStory` saves the story at storyJobPipeline.js:7056; the completion write (`credits_reserved = 0`, `status = 'completed'`) comes at :7299. A cancel in between refunds the reservation, sets 'cancelled', and the completion write then no-ops: the user keeps the story and the credits. A cancel whose SELECT ran before completion but whose UPDATE runs after overwrites 'completed' with 'cancelled'.
Evidence: the pipeline's own refund at storyJobPipeline.js:8136 has `progress < 100`; the cancel path has neither that nor a status guard. Related but distinct: area 1 A3 (failure writes overwrite 'cancelled').
Fix direction: do the claim and the status flip in one UPDATE `... WHERE status IN ('pending','processing')`, and refund only when that row changed.

### R2 `repaint-title` charges from a stale balance check and ignores a failed debit
Severity: minor (2 credits per call; needs parallel requests).
Where: routes/stories.js:3756-3762 (balance read), 3772 (paid call), 3787-3792 (deduct).
Failure: the balance is read before the image call; the atomic `UPDATE ... AND credits >= $1 RETURNING` runs after it, and an empty result is treated as charged (`newCredits = userCredits - creditCost`, `charged: creditCost`). Parallel requests with enough credits for one get every repaint, and the response reports a charge that did not happen. No `credit_transactions` row is written at all.
Evidence: same pattern family as area 2 B1/B2, on a route that area did not cover.
Fix direction: reserve before the call (deduct with RETURNING, refund on `!painted`) and write a ledger row.

### M1 `cleanup-orphaned-jobs` deletes every running job
Severity: minor (admin-only API, no client caller).
Where: routes/admin/database.js:217-222.
Failure: "orphan" means "no stories row with the same id", but a stories row is only written at the end of a run (storyJobPipeline.js:6763 `storyId = jobId`, first `upsertStory` at :7056). So `action: 'delete'` removes every pending and processing job, including its `credits_reserved` (never refunded), plus trial and text-only jobs. The preview is capped at 100 rows; the DELETE has no cap.
Evidence: prod has 0 such rows right now and staging 1 (failed) — after `cleanupOldCompletedJobs` there is little else, so in practice the DELETE hits mostly live jobs.
Fix direction: restrict to terminal statuses older than N hours, or delete the endpoint.

### V4 Avatar endpoints have no per-user cap or charge
Severity: minor (needs a registered account and scripted calls; consistent with area 2 B4 / area 4-5 T3).
Where: routes/avatars.js:1570 (`/generate-avatar-options`, 3 Gemini calls per request, used by CharacterForm.tsx:658), 2741 (`/generate-clothing-avatars`, 3 categories + evals + retries per job).
Failure: the only limit is the global `apiLimiter` (100/min per IP). Any account can queue avatar jobs back to back, each costing several image calls. `avatarModel` is taken from the body unvalidated, though it can only pick a registered `IMAGE_MODELS` entry. The "unbounded Map" part is wrong: `avatarJobs` has a 10-minute expiry sweep (:180-191).
Fix direction: one in-flight avatar job per character/user (409 like the trial preview path) plus a per-user daily cap.

### R4 Authenticated story-ideas routes take unbounded text into two paid prompts
Severity: minor (authenticated, 30 calls per 15 min per IP; sibling of area 4-5 T1).
Where: routes/storyIdeas.js:765 and :986 (body fields), :328 (`customThemeText` inlined), body limit 50 MB (server.js:1525).
Failure: `customThemeText`, `characters`, `relationships`, `storyTopic` have no length cap, so one call can fill a model's context. The stream route does not abort the model call when the client disconnects. The model override is admin-only (:844), so this is size, not model choice.
Fix direction: cap field lengths at the route, shared with the T1 fix; abort the stream on `req.on('close')`.

### M3 `DELETE /api/admin/landmarks-cache` wipes `landmark_index` in one request, with a secret accepted in the query string
Severity: minor (admin or secret holder only).
Where: routes/admin.js:329-372.
Failure: with no `city` it runs `DELETE FROM landmark_index` (the judged landmark dataset); with a `city` the value goes into `LIKE '%…%'` unescaped, so `_` or `%` also matches everything. `ADMIN_SECRET` is accepted as `?secret=`, which ends up in proxy and access logs. The finder's LIKE point is real but secondary — the unfiltered branch already deletes everything by design of the code.
Fix direction: drop the query-string secret, escape LIKE, require an explicit confirm for the full wipe (or remove the route — the index is now a curated asset, not a cache).

### R3 The one-job-at-a-time check is not atomic
Severity: minor (each job is still paid; idempotency key catches the double-click).
Where: routes/jobs.js:298-304 (SELECT) and 495-498 (INSERT in a later transaction); no partial unique index on `(user_id) WHERE status IN ('pending','processing')`.
Failure: two create-story requests with different idempotency keys at the same moment both pass the check and both run.
Fix direction: a partial unique index, mapping its violation to the existing 409.

### R9 / R12 `POST /api/stories` stores any client-supplied story blob, and the PDF builder fetches any URL in it
Severity: minor (own stories only).
Where: routes/stories.js:3317-3345; lib/pdf.js:40-55 (`resolveImageBuffer`).
Failure: the owner can write arbitrary scores, versions and image URLs into their own story (the cross-user overwrite is guarded at :3335). `resolveImageBuffer` then `fetch`es any http(s) URL with no timeout and no host allowlist, so a crafted story turns PDF generation into a server-side fetch. `story.id` missing on a body without `story` throws → 500.
Fix direction: whitelist the fields this endpoint may change; restrict image fetches to the R2/CDN hosts with a timeout (reuse `fetchImageBytes`).

### V5 Avatar routes fetch any http(s) URL given as the reference photo
Severity: minor (blind: the response only becomes image input).
Where: routes/avatars.js ~1695 and ~2874 → lib/r2.js:308-316 `bytesFromAnyImage` → :457 `fetchImageBytes` (has a 30 s timeout and 3 retries, no host check).
Fix direction: same allowlist as R12, in `fetchImageBytes` so both callers get it.

### R7 Owner-side routes skip the `admin_draft` filter
Severity: minor (the draft id is never shown to the owner; needs the id).
Where: routes/stories.js:357-380 (`/metadata`), ~2400 (`/images`), 2879 (`/image/:pageNumber`), 4174 (`POST /:id/share`). Only the list (:133) and `GET /:id` (:3199) filter.
Failure: the owner of an unpublished admin draft can read it and create a share link for it, contrary to decisions.md 2026-08-10 "invisible until published". The public-side sibling is area 4-5 S4.
Fix direction: one shared owner-access helper that applies `NOT admin_draft` for non-admins.

### R8 Developer/eval endpoints are open to every story owner
Severity: minor (own stories only; exposes internal prompts and eval output, not other users' data).
Where: routes/stories.js:827 (`dev-metadata`), 1429, 1539, 1615, 1977, 2064, 2112, 2170, 2344 — `authenticateToken` only, owner check, no role check.
Fix direction: `requireAdmin` (or the dev-mode role) on these routes.

### V2 The sync branch of `/generate-clothing-avatars` writes by a stale array index
Severity: minor (no caller: every client and script uses `?async=true`).
Where: routes/avatars.js:3541-3565, 3720; async branch at 2753/2771 is the fixed one.
Failure: unlocked SELECT, ~60 s of generation, then `jsonb_set` at the old index, with a name fallback — a reorder lands the avatars on another character. It is also a second implementation of the async job (and has the V1 defect too).
Fix direction: delete the sync branch.

### X1 (verifier) `/api/stories/debug/:id` and `/debug/:id/images` can never be reached
Severity: minor (fails closed; dead code).
Where: routes/stories.js:236-285 check `req.user.isAdmin`, which no token carries (`generateToken`, middleware/auth.js:40-50, sets `role`). If someone "fixes" the check, the first route returns the owner's email for any story id.
Fix direction: delete both routes, or use `requireAdmin` and drop the email field.

### R11 Story-draft API and client disagree on shape, and neither side is used
Severity: minor (dead code).
Where: routes/storyDraft.js:15-63; client storyService.ts:202-217 sends `{ draft }` and reads `.draft`, the server reads top-level fields and returns a flat object. `getDraft`/`saveDraft`/`deleteDraft` have no callers.
Fix direction: delete the route, the table use and the client methods.

### R10 Admin page-image revert writes into the blob but not the separate image table
Severity: minor (admin-only, no client caller found).
Where: routes/stories.js:3508-3522.
Fix direction: route reverts through the image-version API (set active version) or delete the branch.

## Plausible (needs a data check or run to settle)

### R5 Story edits rewrite the whole `stories.data` blob across a multi-second restamp
Severity: minor.
Where: routes/stories.js ~3611-3640, 3700, 3850 (title/dedication/page text edits), database.js ~2093.
Failure: read blob → re-render/restamp → write whole blob, no lock. A concurrent background write (re-evaluate, repair) loses one side. The finder's "edits while the job is running" part is mostly moot: the stories row only exists once a run finishes. Same family as area 2 B5 and area 1 A4.
Settle: find a story whose title/text edit and a background re-evaluate overlap in `activity_log`/logs, or reproduce on staging with two requests.

### V3 Avatar-job failure status is written at an index read moments earlier, and the same index is used for `metadata`
Severity: minor.
Where: routes/avatars.js:2705-2722.
Failure: SELECT then UPDATE without a lock; the window is milliseconds. The larger risk is that the index found in `data.characters` is reused for `metadata.characters`; if the two arrays ever differ in order, the wrong metadata entry is marked failed.
Settle: count rows where `data.characters[i].id <> metadata.characters[i].id` for any i.

### V6 `analyze-photo` returns success when the DB write failed
Severity: minor.
Where: routes/avatars.js:1486-1490.
Failure: the collision part (two characters with `Date.now()` ids) did not happen: 0 rows with duplicate character ids on prod or staging. The remaining part — a failed character upsert logged and a success returned, after which the avatar job cannot find the character — is real in code; whether it fires needs a log search for that error line.
Settle: grep Railway logs for the analyze-photo DB-write error.

## Rejected
- M2 — DUPLICATE of area 4-5 S5 (role demotion and password reset do not revoke the 7-day JWT). The impersonation token carrying the target's role is intended.
- R6 — a stories row does not exist until the run's final save (storyJobPipeline.js:6763/7056), so DELETE on an in-progress story returns 404 and never touches the job; after the final save the credits are rightly spent.
- V4 "avatarJobs Map unbounded" — it has a 10-minute expiry sweep (avatars.js:180-191).
