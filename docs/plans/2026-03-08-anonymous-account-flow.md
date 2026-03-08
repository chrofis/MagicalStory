# Anonymous Account Trial Flow

## Goal

Start story generation **before** email is collected to maximize conversion. Users see their story being created while they enter their email — they're already invested.

## Current Flow (Sequential)

```
1. Photo + name + age
2. Pick topic
3. Generate 2 story ideas → pick one
4. Enter email (or Google) ← GATE
5. Story generation starts (~2 min)
6. Email with claim link
7. User claims account (set password)
```

**Problem:** Steps 4-5 are a 2+ minute wall. User must provide email AND wait before seeing any result. High drop-off risk.

## New Flow (Parallel)

```
1. Photo + name + age → anonymous account + character created in DB
2. "Meet [Name]!" → preview avatar shown (saved to character)
3. Pick theme
4. "Create Story" → story generation starts immediately
5. While generating → email collection overlay
6. Story completes → viewable in-app
7. Email entered → linked to account, claim email sent
```

**Key change:** Story generation (step 4) and email collection (step 5) happen **in parallel**. The user watches progress while entering their email.

## Anonymous Account Design

### Creation (Step 1)

When the user clicks "Next" after filling in photo + name:

```
POST /api/trial/create-anonymous-account
{
  name, age, gender, traits, customTraits,
  facePhoto, turnstileToken, fingerprint
}
```

**Server creates:**
1. **User record** — `is_trial = true`, no email, no password, `anonymous = true`
2. **Character record** — full character data with photos saved to DB
3. Returns: `{ sessionToken, characterId }`

**Session token:**
- Short-lived JWT (24h expiry) with just `{ userId, anonymous: true }`
- Stored in `localStorage` as `trial_session_token`
- Used for all subsequent trial API calls
- NOT a full auth token — limited permissions (can only: poll job status, view own story, link email)

**User record fields:**
```sql
INSERT INTO users (id, username, email, password, role, credits, is_trial, anonymous)
VALUES ($1, $2, $3, $4, 'user', 0, true, true)
```
- `id`: UUID
- `username`: `anon_<uuid>` (placeholder, updated when email provided)
- `email`: `anon_<uuid>@anonymous` (placeholder, must be non-null per schema)
- `password`: random hash (placeholder)
- `anonymous`: true (new column)
- `is_trial`: true
- `credits`: 0

### Avatar Preview (Step 2)

The preview avatar is generated and saved to the character record:

```
POST /api/trial/generate-preview-avatar
Authorization: Bearer <sessionToken>
{ characterId }
```

- Same endpoint as before (Turnstile + fingerprint + IP protection)
- But now saves avatar to character in DB instead of just returning to frontend
- Avatar survives page refresh

### Story Generation (Step 4)

When user clicks "Create Story":

```
POST /api/trial/create-story
Authorization: Bearer <sessionToken>
{ storyCategory, storyTopic, storyTheme, storyDetails }
```

**Server:**
1. Verify session token → get userId
2. Check user hasn't already used trial story (`stories_generated < 1`)
3. Create story job (same as current `createTrialStoryJob`)
4. Start `processStoryJob(jobId)` in background
5. Return `{ jobId }` for polling

**Protection:** One story per anonymous account. Account creation is gated by Turnstile + fingerprint + IP.

### Email Linking (Step 5-7)

While story generates, user enters email:

```
POST /api/trial/link-email
Authorization: Bearer <sessionToken>
{ email }
```

**Server:**
1. Verify session token
2. Check email not already used (by another user)
3. Update user: `email = $1, username = $1, anonymous = false`
4. Send verification email with claim token
5. Return success

**Or Google:**
```
POST /api/trial/link-google
Authorization: Bearer <sessionToken>
{ idToken }
```

**Server:**
1. Verify Firebase token → get email
2. Check email not already used
3. Update user: `email, username, firebase_uid, anonymous = false, email_verified = true`
4. Generate full JWT (replaces session token)
5. Return `{ token, user }`

### Account Claim (unchanged)

Email users click claim link → set password → full account. Same as current flow.

## Database Changes

### New column on `users` table:
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymous BOOLEAN DEFAULT FALSE;
```

### Cleanup job:
```sql
-- Delete anonymous accounts older than 48h that never linked an email
DELETE FROM users WHERE anonymous = true AND created_at < NOW() - INTERVAL '48 hours';
-- Also clean up their characters and story_jobs (CASCADE or explicit)
```

Run via a scheduled task (Railway cron or setInterval on server start).

## Session Token vs Auth Token

| | Session Token | Auth Token |
|--|--|--|
| **Created when** | Anonymous account | Email linked/claimed |
| **Expiry** | 24h | 7 days |
| **Payload** | `{ userId, anonymous: true }` | `{ userId, username, email, role }` |
| **Stored in** | `localStorage` as `trial_session_token` | `localStorage` as `auth_token` |
| **Permissions** | Create story, poll status, view own story, link email | Full app access |

Frontend checks: if `trial_session_token` exists but no `auth_token`, show limited UI (story generation progress + email prompt).

## API Endpoints (New / Modified)

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/trial/create-anonymous-account` | Turnstile + fingerprint + IP | Create anonymous user + character |
| `POST /api/trial/generate-preview-avatar` | Session token + Turnstile | Generate + save avatar preview |
| `POST /api/trial/create-story` | Session token | Start story generation |
| `POST /api/trial/link-email` | Session token | Add email to anonymous account |
| `POST /api/trial/link-google` | Session token | Link Google account |
| `GET /api/trial/job-status/:jobId` | Session token | Poll story generation progress |

### Endpoints to Remove / Modify

| Current Endpoint | Change |
|----------|--------|
| `POST /api/trial/register-email` | Replace with `link-email` |
| `POST /api/trial/register-google` | Replace with `link-google` |
| `POST /api/trial/generate-ideas-stream` | Keep (or remove if ideas step is dropped) |

## Frontend Changes

### TrialWizard Steps

```typescript
type TrialStep = 'character' | 'avatar' | 'topic' | 'ideas';
// or simplified (if ideas step dropped):
type TrialStep = 'character' | 'avatar' | 'theme';
```

### State Management

```typescript
// Stored in localStorage, survives refresh
const [sessionToken, setSessionToken] = useState(
  localStorage.getItem('trial_session_token')
);

// When anonymous account created:
localStorage.setItem('trial_session_token', token);

// When email linked (Google) or account claimed:
localStorage.removeItem('trial_session_token');
localStorage.setItem('auth_token', fullToken);
```

### Story Generation Page

After "Create Story", navigate to a generation progress page:
- Shows progress bar + generating illustrations
- Email/Google sign-in prompt overlaid or alongside
- When story completes: show "Read Your Story" button
- If email not yet provided: gentle prompt "Save your story — enter your email"

## Protection Summary

| Resource | Cost | Protection |
|----------|------|-----------|
| Anonymous account | ~$0 (DB row) | Turnstile + fingerprint + IP |
| Preview avatar | ~$0.04 | Session token + Turnstile |
| Story generation | ~$0.50 | Session token + 1 per account |
| Account creation rate | — | 3/fingerprint/day, 5/IP/day |

**Worst case:** An attacker bypassing Turnstile with unique fingerprints and rotating IPs could create ~5 accounts/IP/day. At $0.54 each = $2.70/IP. With a botnet of 100 IPs = $270/day. Turnstile is the primary defense here — it's very hard to bypass at scale.

## Migration Path

1. Add `anonymous` column to users table
2. Implement new endpoints (create-anonymous, link-email, link-google)
3. Update frontend wizard flow
4. Add cleanup job for abandoned anonymous accounts
5. Keep old register-email/register-google working during transition
6. Remove old endpoints once new flow is stable

## Open Questions

1. **Ideas step:** Keep the "generate 2 story ideas" step, or drop it for a simpler flow? Dropping it means one less step before story generation starts.

2. **Story viewing without email:** Can the user read the completed story without providing an email? Or is "enter email to see your story" the final conversion gate?

3. **Cleanup interval:** 24h or 48h for abandoned anonymous accounts? 48h gives users time to come back next day.

4. **Session token storage:** `localStorage` (persists across tabs/refresh) or `sessionStorage` (lost on tab close)? localStorage is better for users who close and reopen.
