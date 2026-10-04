# Area 7 — Client (review 2026-10-04)
Files covered: client/src/pages/StoryWizard.tsx, TrialWizard.tsx, TrialGenerationPage.tsx, trial/TrialCharacterStep.tsx, trial/TrialIdeasStep.tsx, SharedStoryViewer.tsx, BookBuilder.tsx, MyStories.tsx; components/generation/StoryDisplay.tsx, story/ImageHistoryModal.tsx; components/character/CharacterForm.tsx; context/GenerationContext.tsx; services/storyService.ts, characterService.ts, api.ts.
Finders: 2 × Sonnet (A: wizard, characters, trial; B: story display, repair UI, services, share viewer, checkout). Verifier: Opus, against HEAD 645cb5082.

## Confirmed

### D1 The "Nochmal / Retry" button does nothing for every real customer
Severity: major.
Where: StoryWizard.tsx:4998 passes `onImproveImage` whenever `storyId` is set, with no role check. StoryDisplay.tsx:5365, 5612, 5922, 6507, 7084 render the button for covers and pages. It calls `storyService.iteratePage` (storyService.ts:1322) → `POST /iterate`, and regeneration.js:2329-2332 returns 403 to anyone who is not an admin.
Failure: a customer clicks "Nochmal (N Credits)". The spinner shows, then stops. `handleImproveImage` (StoryDisplay.tsx:1063-1072) only logs the error to the console. No toast appears and the picture stays the same. No credits are taken, but the paid feature advertised on every page and cover never works.
Evidence: StoryDisplay is rendered without any admin wrapper (StoryWizard.tsx:4942). Prod has 54 non-admin story owners with 85 stories, and 0 `credit_transactions` rows mention iterate for non-admin users, so no customer has ever run it successfully. The 403 gate is older than the button wiring (it dates to the split of regeneration.js). No decisions.md entry calls it deliberate.
Fix direction: decide whether customers should get iterate. If yes, open the route to owners with the credit check. If no, pass `onImproveImage` only for admins or impersonation. Either way, surface errors with a toast.

### W1 The story poll loop outlives the wizard view and later forces the user to the reader
Severity: major.
Where: StoryWizard.tsx:4228 (`while (!completed)`), 4352-4491 (on completion `setStep(6)` and `navigate('/shared/<token>', {replace:true})`). `pollCancelledRef` is set only by the cancel button (6223). No unmount cleanup sets it.
Failure: the minimize dialog's main button is "Neue Geschichte erstellen" (`navigate('/create?new=true')`, 6259). That stays on the same mounted StoryWizard, so the old loop keeps running. When the first story's front cover arrives, it writes `coverImages` and calls `setStep(6)` while the user is filling in the next story. At completion it replaces the URL with the finished story's reader. "Meine Geschichten lesen" (/stories) unmounts the wizard, but the closure keeps polling and still navigates the user off MyStories into the reader. Both paths interrupt the user. GenerationContext already tracks the job, so this second loop is the one doing the hijacking.
Fix direction: set `pollCancelledRef.current = true` on minimize and on unmount, and let GenerationContext own background completion.

### D3 Turning sharing off can fail silently while the UI says the story is private
Severity: major (privacy). The trigger is rare.
Where: SharedStoryViewer.tsx:341-358 (`toggleSharing`), 366-382 (`handleShare`).
Failure: neither `fetch` checks `res.ok`. If `DELETE /share` returns 401/500 (for example a session revoked by the new `token_version` bump, or a deploy), the toggle still flips to "private" and the public link stays live. The owner believes the book is unshared. In the reverse case, `handleShare` copies or shares a URL whose sharing POST failed, so recipients get a dead link.
Fix direction: check `res.ok`, flip state only on success, and show an error toast otherwise.

### W4 A transient server error on the trial waiting page ends the trial on a failure screen
Severity: minor. The trigger is rare, but the consequence is heavy because one trial is allowed per user.
Where: TrialGenerationPage.tsx:471-474. Any non-ok JSON response sets `pageState='failed'` and stops polling. The server returns JSON 503 when the session lookup hits a DB error (trial.js:905) and JSON 500 from the job-status catch (trial.js:1923).
Failure: the story keeps generating, but the visitor sees "failed" and a "try again" link to /try. Non-JSON 502s from the edge are survived, because `response.json()` throws into the continue-polling catch. JSON 5xx responses are not.
Fix direction: treat 5xx and 429 as retryable, and stop only on 403/404 or `status:'failed'`.

### W5 Photo-analysis failures are swallowed and the wizard carries on with a half-set-up character
Severity: minor.
Where: characterService.ts:1063-1066 maps any error to `{success:false, error:'unknown_error'}`. StoryWizard.tsx:2756-2774 then keeps the original photo, clears avatars, and shows no toast.
Failure: when the analyzer is down (502/503, now a separate Railway service) or the character save fails (avatars.js:1538 returns 500 "Could not save the character. Please try again."), the user sees their photo accepted. They get no face box, no body crop and no server-side save, and the server's message is thrown away. This conflicts with the "fail loudly" rule.
Fix direction: pass the server error through and show it. Do not continue silently.

### W6 Retrying trial account creation reuses a spent Turnstile token, which sends the visitor to the signup page
Severity: minor.
Where: TrialCharacterStep.tsx:404-412 refreshes the token only when the state is null. The prewarm (466-470) already consumed it. On retry (530-545) a 403 lands in `status 4xx → navigate('/?signup=true')` (549-553).
Failure: if create-anonymous-account fails after Turnstile has passed (for example a DB 500), the retry sends the same token. Cloudflare rejects the duplicate, the server returns 403, and the visitor is bounced out of the trial. The 5xx message "Account creation failed. Please try again." is English only.
Fix direction: reset the Turnstile widget after every attempt, and keep the signup redirect for the fingerprint/quota cases only.

### W2 The wizard poll loop ignores a `cancelled` job
Severity: minor.
Where: StoryWizard.tsx:4352 / 4492 handle only `completed` and `failed`. GenerationContext.tsx:200 handles `cancelled`.
Failure: a job cancelled from somewhere other than this wizard instance (the 409 "cancel and start new" path at 4534 from another tab or instance, or an admin cancel) leaves the original wizard polling every 2 s indefinitely, with the progress modal stuck. User cancel in the same wizard is unaffected (it sets `pollCancelledRef`).
Fix direction: treat `cancelled` as terminal, the way GenerationContext does.

### W7 Trial ideas and session edges
Severity: minor.
Where: TrialIdeasStep.tsx:223 shows a raw "Server error: 403" for an expired session, and Retry cannot recover from it. TrialWizard.tsx:354-374 clears the trial session on any non-ok or network error from check-status, including transient ones. TrialWizard.tsx:435 makes `handleCreate` a silent no-op when `characterId` is null.
Failure: a returning visitor on a flaky connection loses their session token and is pushed into creating a new anonymous account, which the fingerprint limit can block.
Fix direction: clear the session only on 401/403, and show a localized "session expired, start over" message.

### W8 The trial preview avatar can belong to the previous photo
Severity: minor.
Where: TrialCharacterStep.tsx:345-391. While a generation is in flight, the effect returns early on `isGeneratingAvatar`. On completion it records the old closure's `facePhotoKey`, and the effect does not re-run because `isGeneratingAvatar` is not a dependency.
Failure: if the visitor swaps photos during the ~10-20 s preview generation, the avatar from the first photo is kept and sent as `previewAvatar` with the account.
Fix direction: compare the returned key with the current photo key, and re-trigger when generation ends.

### D2 Picking a version in the history modal uses the DB index as an array index
Severity: minor (rare data).
Where: ImageHistoryModal.tsx:97 sends `version.versionIndex ?? idx`. StoryWizard.tsx:5683-5720 (pages) and 5736-5752 (covers) read `imageVersions[versionIndex]`. StoryDisplay.tsx:297-312 (`resolveActiveArrayIdx`) already documents that the arrays can be sparse.
Failure: on a page with a gap in version_index, the server pins version N, but the screen shows the array entry at position N (a different picture) or nothing. Prod: 4 of 2,804 non-test page/cover version sets are sparse (staging 6 of 4,722).
Fix direction: find the entry by `versionIndex` in both handlers, the way `resolveActiveArrayIdx` does.

### D4 After a regenerate, the client keeps the old `activeVersion`
Severity: minor.
Where: StoryWizard.tsx:5047-5075 (page regenerate) ignores `result.activeVersion`, which regeneration.js:1121 returns. The cover regenerate (around 5289) drops it too. The cover edit (around 6450) falls back to `length-1`.
Failure: the new picture is shown, but the history modal's "Aktiv" badge and the dev panels (bbox, score) still point at the previously selected version until reload. This only matters once the user has picked a version on that page before.
Fix direction: adopt `result.activeVersion`, as the iterate branch already does.

### D5 The credit balance is not refreshed after an image or cover edit
Severity: minor.
Where: StoryWizard.tsx:6382 / 6419 never call `updateCredits`, although regeneration.js:3667 returns `creditsRemaining` for the image edit. The cover edit route (6718+) returns no balance at all.
Failure: the header and the button affordability check show the pre-edit balance until reload. The server still enforces the real balance.
Fix direction: call `updateCredits(result.creditsRemaining)`, and add the balance to the cover-edit response.

### D6 The checkout button re-enables during the Stripe redirect
Severity: minor.
Where: BookBuilder.tsx:380-410. `finally` runs `setIsCheckingOut(false)` right after `window.location.href = url`.
Failure: a second click in the ~1 s before navigation creates a second Stripe checkout session, along with its referral/balance hold.
Fix direction: leave the button disabled on the success path, and reset it only in `catch`.

### W10 Avatar failure messages are English and raw
Severity: minor.
Where: StoryWizard.tsx:3363 and 3371 (`Failed to generate avatar: ${result.error}` / `Avatar generation failed: …`), plus the sites the finder lists (2711-2736, 2971, 3471) and CharacterForm.tsx:1732-1735.
Failure: German, French and Italian users see an English, developer-style error. The 429 daily-limit reason is not surfaced on the auto-generation path.
Fix direction: localized messages keyed on the error code.

## Plausible

### W3 The ideas stream can end without `done`, which leaves the spinner running forever
Severity: minor.
Where: storyService.ts:1698-1700. A clean `reader.read()` end breaks the loop with no `onDone`/`onError`, and `finally` clears the 2-minute watchdog. StoryWizard.tsx:3850 clears `isGeneratingIdeas` only in those callbacks.
Every server path writes `done` or `error` (storyIdeas.js:1125, 1133). The hang therefore needs the backend to die mid-stream while the proxy closes the stream cleanly instead of resetting it.
What would settle it: restart the staging container during an idea stream and watch the client. Fix direction either way: call `onError` when the stream ends without `streamCompleted`.

### W9 A failed claim-session still redirects as verified
Severity: minor.
Where: TrialGenerationPage.tsx:386-396 sets `isVerified` even when `claimRes` is not ok. The page then sends the visitor to /stories (566-577).
EmailVerified.tsx:116 restores the session in localStorage, so on the same browser the user is logged in anyway. The failure bites only when the email link was opened on another device.
What would settle it: check whether trial verifications happen cross-device in practice. Fix direction: redirect only after a successful claim, otherwise show a login prompt.

### D7 The order-success dialog can print "undefined"
Severity: minor.
Where: MyStories.tsx:472-481 and StoryWizard.tsx:1531-1539 always print the customer and shipping fields. orders.js:44-62 adds those fields only when the bearer token belongs to the order's user. The api client sends the token, so the normal "logged in, return from Stripe" path is fine.
What would settle it: whether any return lands without a session (expired or revoked token, a different browser). Fix direction: omit the lines whose fields are absent.

## Rejected
- W11: avatar-options generation is behind `developerMode || isImpersonating` (CharacterForm.tsx:1494 context), so it is an admin-only tool and failing quietly to the console is acceptable there.
- D8: `GET /title-paint` is owner-scoped (`user_id = $2` unless admin) and returns only the caller's own story's plate and raw output. There is no cross-user exposure. Missing it in the dev-endpoint sweep (1394fe35c) is a consistency nit, not a defect.
