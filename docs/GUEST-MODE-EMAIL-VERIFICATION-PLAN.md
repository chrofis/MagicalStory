# Guest Mode + Email Verification for Story Generation

**Status:** PLANNED (Not Implemented)
**Created:** 2024-12-21
**Context:** Allow users to browse and set up stories without login, collect email only when generating

---

## User Requirements

1. **Guest browsing:** Users can access Steps 1-4 (character, story type, details, relationships) without login
2. **Email collection:** Show modal when user clicks "Generate Story" (only if not logged in)
3. **Magic link verification:** Email contains link that verifies AND auto-starts generation
4. **Auto-return:** User returns to app showing generation progress (no need to click Generate again)
5. **Link expiry:** 24 hours

---

## Confirmed Design Decisions

| Decision | Choice |
|----------|--------|
| Logged-in users | Keep current flow - Generate starts immediately |
| Zero credits (returning user) | Block with "Insufficient credits" + Buy Credits link |
| New user password | Prompt "Set a password" modal on first visit |

---

## Architecture: "Pending Story Request" Pattern

**Why this approach:**
- No orphaned user records (vs "pending users" pattern)
- Story data stored temporarily in DB (24h TTL)
- Works for new users AND returning users
- Single-click experience after receiving email

**Flow:**
```
1. Guest browses Steps 1-4 (character, story type, details, relationships)
2. Clicks "Generate Story" → Email modal appears
3. Enters email → Backend creates `pending_story_request` record
4. Receives magic link email
5. Clicks link → Backend: verify token → create/login user → start job → redirect
6. App shows generation progress with jobId from URL
```

---

## Database Changes

### New Table: `pending_story_requests`

```sql
CREATE TABLE IF NOT EXISTS pending_story_requests (
  id VARCHAR(100) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  verification_token VARCHAR(255) UNIQUE NOT NULL,
  input_data TEXT NOT NULL,              -- JSON story wizard data
  credits_needed INT NOT NULL,           -- pages * 10
  language VARCHAR(20) DEFAULT 'English',
  status VARCHAR(50) DEFAULT 'pending',  -- pending/verified/expired
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,         -- 24h from creation
  verified_at TIMESTAMP,
  user_id VARCHAR(255),                  -- filled after verification
  job_id VARCHAR(100)                    -- filled after job creation
);

CREATE INDEX idx_pending_requests_token ON pending_story_requests(verification_token);
CREATE INDEX idx_pending_requests_email ON pending_story_requests(email);
CREATE INDEX idx_pending_requests_status ON pending_story_requests(status);
CREATE INDEX idx_pending_requests_expires ON pending_story_requests(expires_at);
```

### Modify Users Table

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_password BOOLEAN DEFAULT TRUE;
```

---

## New API Endpoints

### 1. `POST /api/story/request-generation` (Public - No auth required)

**Purpose:** Create pending request + send magic link

**Request:**
```json
{
  "email": "user@example.com",
  "storyData": {
    "storyType": "adventure",
    "storyTypeName": "Adventure",
    "artStyle": "pixar",
    "language": "English",
    "languageLevel": "standard",
    "pages": 20,
    "dedication": "For my little hero",
    "storyDetails": "A story about...",
    "characters": [...],
    "mainCharacters": [1, 2],
    "relationships": {...},
    "relationshipTexts": {...}
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Magic link sent to your email",
  "requestId": "req_xxx",
  "creditsNeeded": 200,
  "expiresIn": "24 hours"
}
```

**Logic:**
1. Validate email format
2. Calculate credits: `pages * 10`
3. Generate token: `crypto.randomBytes(32).toString('hex')`
4. Create pending_story_requests record (expires: now + 24h)
5. Send magic link email with token
6. Return success (same response whether email exists or not - no enumeration)

### 2. `GET /api/story/verify/:token` (Public - No auth required)

**Purpose:** Verify email + create/login user + start generation

**Logic:**
1. Find pending request by token
2. Validate: not expired, not already verified
3. **If email exists in users table (returning user):**
   - Check credits sufficient → if not, redirect to insufficient credits page
   - Deduct credits
   - Log them in (generate JWT)
   - Mark email_verified if not already
4. **If new email (new user):**
   - Create user with email as username
   - Generate random password, set `has_password = false`
   - Grant initial 1000 credits, deduct for story
   - Mark email_verified = true
5. Create story job (reuse existing job creation logic from /api/jobs/create-story)
6. Update pending request: user_id, job_id, status='verified'
7. Redirect to: `/create?jobId={jobId}&token={jwt}`

**Response (if called via API instead of browser redirect):**
```json
{
  "success": true,
  "token": "jwt_token_here",
  "user": { "id": "...", "email": "...", "credits": 800 },
  "jobId": "job_xxx",
  "message": "Story generation started!"
}
```

### 3. `GET /api/story/request/:id/status` (Public)

**Purpose:** Check if pending request still valid (optional UI enhancement)

**Response:**
```json
{
  "status": "pending" | "verified" | "expired",
  "expiresAt": "2024-01-16T10:00:00Z"
}
```

### 4. `POST /api/auth/set-password` (Authenticated)

**Purpose:** Allow new users to set their password

**Request:**
```json
{
  "password": "newPassword123",
  "confirmPassword": "newPassword123"
}
```

**Logic:**
1. Validate passwords match and meet requirements
2. Hash password with bcrypt
3. Update user: password = hash, has_password = true
4. Return success

---

## Frontend Changes

### 1. StoryWizard.tsx

**Remove auth redirect** (currently at lines 145-150):
```typescript
// DELETE this block:
useEffect(() => {
  if (!isAuthenticated) {
    navigate(`/?login=true&redirect=${redirectParam}`);
  }
}, [isAuthenticated, navigate]);
```

**Add new state:**
```typescript
const [showEmailModal, setShowEmailModal] = useState(false);
const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
const [emailSent, setEmailSent] = useState(false);
```

**Modify generateStory() function:**
```typescript
const generateStory = async (overrides?: { skipImages?: boolean }) => {
  // If not authenticated, show email modal instead
  if (!isAuthenticated) {
    setShowEmailModal(true);
    return;
  }

  // ... existing generation logic
};
```

**Handle return from magic link:**
```typescript
useEffect(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const jobId = urlParams.get('jobId');
  const token = urlParams.get('token');

  if (jobId && token) {
    // Store token and start polling
    localStorage.setItem('auth_token', token);
    setJobId(jobId);
    setIsGenerating(true);
    startPollingJobStatus(jobId);
  }
}, []);
```

### 2. New Component: EmailCaptureModal.tsx

**Location:** `client/src/components/auth/EmailCaptureModal.tsx`

**Features:**
- Email input with validation
- "Send Magic Link" button
- Loading state while sending
- Success state: "Check your email! Click the link to start your story."
- Error handling
- Localization (EN/DE/FR)

```typescript
interface EmailCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  storyData: StoryInputData;
  onSuccess: (requestId: string) => void;
}
```

### 3. New Page: VerifyStory.tsx

**Route:** `/verify-story/:token`

**Purpose:** Landing page from magic link email

**Flow:**
1. Show "Verifying..." spinner
2. Call `GET /api/story/verify/:token`
3. On success:
   - Store JWT in localStorage
   - Redirect to `/create?jobId=xxx`
4. On error:
   - "Link expired" → option to request new link
   - "Already used" → link to view story or create new
   - "Insufficient credits" → link to buy credits

### 4. New Component: SetPasswordModal.tsx

**Location:** `client/src/components/auth/SetPasswordModal.tsx`

**Purpose:** Prompt new users (from magic link) to set their password

**Trigger:** On first visit when `user.has_password === false`

**Features:**
- Two password fields (password + confirm)
- Validation (min length, match)
- "Skip" option (can use Google/magic link only)
- Calls `POST /api/auth/set-password`

### 5. LandingPage.tsx

**Change:** "Start Journey" button goes directly to `/create` without auth check

```typescript
// Before:
onClick={() => setShowAuth(true)}

// After:
onClick={() => navigate('/create')}
```

### 6. App.tsx

**Add new route:**
```typescript
<Route path="/verify-story/:token" element={<VerifyStory />} />
```

---

## Email Template: magic-link-story.html

**Location:** `emails/magic-link-story.html`

**Template Structure** (following existing pattern):

```html
[ENGLISH]
Subject: Start Your Magical Story - Click to Begin!
Text:
Hello,

You're one click away from creating your personalized story!

Click here to start your story: {verifyUrl}

This link expires in 24 hours.

If you didn't request this, you can safely ignore this email.

--
MagicalStory
www.magicalstory.ch
---
Html:
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <img src="https://www.magicalstory.ch/logo.png" alt="MagicalStory" style="height: 50px;">
  </div>

  <h1 style="color: #6366f1; text-align: center;">Your Story Awaits!</h1>

  <p style="font-size: 16px; line-height: 1.6; color: #333;">
    You're one click away from creating your personalized story.
  </p>

  <div style="text-align: center; margin: 30px 0;">
    <a href="{verifyUrl}"
       style="display: inline-block; background: #6366f1; color: white; padding: 16px 32px;
              text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold;">
      Start My Story
    </a>
  </div>

  <p style="color: #666; font-size: 14px; text-align: center;">
    This link expires in 24 hours.
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px; text-align: center;">
    If you didn't request this, you can safely ignore this email.
  </p>

  <p style="color: #666; font-size: 12px; text-align: center;">
    MagicalStory - Personalized AI-Generated Children's Books<br>
    <a href="https://www.magicalstory.ch" style="color: #6366f1;">www.magicalstory.ch</a>
  </p>
</div>

[GERMAN]
Subject: Starte deine magische Geschichte - Klicke zum Beginnen!
Text:
Hallo,

Du bist nur einen Klick davon entfernt, deine personalisierte Geschichte zu erstellen!

Klicke hier, um deine Geschichte zu starten: {verifyUrl}

Dieser Link ist 24 Stunden gueltig.

Falls du dies nicht angefordert hast, kannst du diese E-Mail ignorieren.

--
MagicalStory
www.magicalstory.ch
---
Html:
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <img src="https://www.magicalstory.ch/logo.png" alt="MagicalStory" style="height: 50px;">
  </div>

  <h1 style="color: #6366f1; text-align: center;">Deine Geschichte wartet!</h1>

  <p style="font-size: 16px; line-height: 1.6; color: #333;">
    Du bist nur einen Klick davon entfernt, deine personalisierte Geschichte zu erstellen.
  </p>

  <div style="text-align: center; margin: 30px 0;">
    <a href="{verifyUrl}"
       style="display: inline-block; background: #6366f1; color: white; padding: 16px 32px;
              text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold;">
      Meine Geschichte starten
    </a>
  </div>

  <p style="color: #666; font-size: 14px; text-align: center;">
    Dieser Link ist 24 Stunden gueltig.
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px; text-align: center;">
    Falls du dies nicht angefordert hast, kannst du diese E-Mail ignorieren.
  </p>

  <p style="color: #666; font-size: 12px; text-align: center;">
    MagicalStory - Personalisierte KI-generierte Kinderbuecher<br>
    <a href="https://www.magicalstory.ch" style="color: #6366f1;">www.magicalstory.ch</a>
  </p>
</div>

[FRENCH]
Subject: Commencez votre histoire magique - Cliquez pour commencer!
Text:
Bonjour,

Vous etes a un clic de creer votre histoire personnalisee!

Cliquez ici pour commencer votre histoire: {verifyUrl}

Ce lien expire dans 24 heures.

Si vous n'avez pas fait cette demande, vous pouvez ignorer cet e-mail.

--
MagicalStory
www.magicalstory.ch
---
Html:
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <img src="https://www.magicalstory.ch/logo.png" alt="MagicalStory" style="height: 50px;">
  </div>

  <h1 style="color: #6366f1; text-align: center;">Votre histoire vous attend!</h1>

  <p style="font-size: 16px; line-height: 1.6; color: #333;">
    Vous etes a un clic de creer votre histoire personnalisee.
  </p>

  <div style="text-align: center; margin: 30px 0;">
    <a href="{verifyUrl}"
       style="display: inline-block; background: #6366f1; color: white; padding: 16px 32px;
              text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold;">
      Commencer mon histoire
    </a>
  </div>

  <p style="color: #666; font-size: 14px; text-align: center;">
    Ce lien expire dans 24 heures.
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px; text-align: center;">
    Si vous n'avez pas fait cette demande, vous pouvez ignorer cet e-mail.
  </p>

  <p style="color: #666; font-size: 12px; text-align: center;">
    MagicalStory - Livres pour enfants personnalises generes par IA<br>
    <a href="https://www.magicalstory.ch" style="color: #6366f1;">www.magicalstory.ch</a>
  </p>
</div>
```

---

## Edge Cases

| Case | Handling |
|------|----------|
| Email already registered | Send magic link as normal, log them in on verify |
| Insufficient credits (returning user) | Show error page with "Buy Credits" option, don't start generation |
| Link clicked twice | First click works; second shows "Already verified, story generating..." |
| Link expired (>24h) | Show "Link expired" page with option to request new link |
| Browser closed after email sent | Magic link still works (data in DB), clicking starts generation |
| User already logged in clicks Generate | Normal flow, no email modal |
| Multiple pending requests same email | All valid until expired; each can be used once |

---

## Security Considerations

1. **Token Security:**
   - Use `crypto.randomBytes(32).toString('hex')` for 256-bit tokens
   - Single-use: mark as verified immediately on first use
   - 24-hour expiry strictly enforced

2. **Rate Limiting:**
   - Limit email requests: 3 per email per hour
   - Limit verification attempts: 5 per IP per hour
   - Use existing rate limiter patterns

3. **Email Enumeration Prevention:**
   - Same response for existing and new emails
   - "Check your email" message regardless of email status

4. **Credits Protection:**
   - Credits not deducted until verification succeeds
   - For returning users: verify credits before starting job

5. **Data Cleanup:**
   - Cron job to delete expired pending requests (> 24h + buffer)
   - Run daily or on each new request

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `server.js` | Modify | Add DB table, 4 new endpoints, email function |
| `email.js` | Modify | Add `sendMagicLinkEmail()` function |
| `emails/magic-link-story.html` | Create | New email template (EN/DE/FR) |
| `client/src/pages/StoryWizard.tsx` | Modify | Remove auth redirect, add email modal trigger, handle jobId param |
| `client/src/components/auth/EmailCaptureModal.tsx` | Create | Email collection modal |
| `client/src/pages/VerifyStory.tsx` | Create | Magic link landing page |
| `client/src/components/auth/SetPasswordModal.tsx` | Create | Password setup for new users |
| `client/src/App.tsx` | Modify | Add `/verify-story/:token` route |
| `client/src/pages/LandingPage.tsx` | Modify | Update "Start Journey" to go to /create |
| `client/src/types/user.ts` | Modify | Add `has_password`, `email_verified` fields |
| `client/src/context/AuthContext.tsx` | Modify | Handle login from URL token |

---

## Implementation Order

1. **Phase 1: Backend Foundation**
   - Add database migrations (pending_story_requests table, users columns)
   - Implement `POST /api/story/request-generation` endpoint
   - Implement `GET /api/story/verify/:token` endpoint
   - Implement `POST /api/auth/set-password` endpoint
   - Add `sendMagicLinkEmail()` function to email.js
   - Create email template

2. **Phase 2: Frontend - Guest Mode**
   - Remove auth redirect from StoryWizard.tsx
   - Update LandingPage.tsx "Start Journey" button
   - Create EmailCaptureModal.tsx
   - Integrate modal into StoryWizard

3. **Phase 3: Frontend - Verification Flow**
   - Create VerifyStory.tsx page
   - Add route to App.tsx
   - Handle jobId/token URL params in StoryWizard
   - Update AuthContext to handle URL token login

4. **Phase 4: Password Setup**
   - Create SetPasswordModal.tsx
   - Add has_password check to AuthContext
   - Integrate modal trigger on first visit

5. **Phase 5: Testing & Polish**
   - Test new user flow end-to-end
   - Test returning user flow
   - Test edge cases
   - Add loading states and error handling
   - Verify localization

---

## Notes

- This plan does NOT affect logged-in user experience
- Existing auth (email/password, Google) continues to work
- Credits system unchanged for authenticated users
- Admin features unchanged
