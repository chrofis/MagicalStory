# Trial Abuse Prevention: Avatar Generation Before Email

## Problem

The new trial flow generates an AI avatar **before** collecting an email address (the "Meet Emma!" celebration screen). This creates an abuse vector:

- A bot or malicious user could repeatedly upload photos and trigger avatar generation
- Each avatar costs ~$0.04 (one Gemini image call for preview)
- IP rate limiting alone is insufficient — VPNs and distributed bots bypass it easily
- 10,000 bot requests = $400 in wasted Gemini API cost

## Design Goals

1. Block automated/bot abuse effectively
2. Zero friction for real users — no cookie popups, no visible captchas
3. No cookies needed (avoid GDPR consent banner entirely)
4. Layered defense (no single point of failure)
5. Graceful degradation — if one layer fails, others still protect

## What's Protected Where

The trial flow has two expensive operations with different protection strategies:

| Operation | Cost | Protected By |
|-----------|------|-------------|
| **Preview avatar** (~$0.04) | Cheap | Turnstile + fingerprint + IP rate limit (before email) |
| **Story generation** (~$0.50) | Expensive | Email collection (same as current flow) |

**Key decision:** Email is still required before story generation. The three-layer defense only needs to protect the cheap avatar preview. This keeps the flow simple — no complex "one trial per person forever" tracking needed.

## Solution: Three-Layer Defense (Avatar Preview Only)

### Layer 1: Cloudflare Turnstile (Anti-Bot)

**What:** Invisible challenge that runs in the background. No user interaction needed. Managed mode — may occasionally show a simple challenge if unsure about the visitor.

**Why:** The primary bot blocker. Analyzes browser behavior, mouse movements, and other signals to distinguish humans from bots. Privacy-friendly, no cookies, GDPR-compliant without consent banner.

**Implementation:**

Frontend (`TrialCharacterStep.tsx`):
```tsx
import { Turnstile } from '@marsidev/react-turnstile';

// Render managed widget (invisible unless challenged)
<Turnstile
  siteKey={TURNSTILE_SITE_KEY}
  onSuccess={(token) => setTurnstileToken(token)}
/>

// Include token in avatar generation request
const response = await fetch('/api/trial/generate-preview-avatar', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    characterData,
    turnstileToken,
    fingerprint: browserFingerprint,
  }),
});
```

Backend (`server/routes/trial.js`):
```javascript
async function verifyTurnstile(token, remoteip) {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: process.env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip,
    }),
  });
  const data = await response.json();
  return data.success === true;
}
```

**Setup:**
- Create free Turnstile widget at https://dash.cloudflare.com/ (Managed mode)
- Get site key (frontend) + secret key (backend)
- Add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to environment

**Cost:** Free (unlimited verifications)

**Fallback:** If Turnstile is down or unreachable, fall back to fingerprint + IP only. Turnstile downtime is rare but shouldn't break the trial flow entirely.

---

### Layer 2: Browser Fingerprint (Anti-VPN/Multi-Account)

**What:** Generate a stable hash from ~30 browser signals (canvas, WebGL, screen, timezone, fonts, etc.). Track avatar generation count per fingerprint server-side in memory.

**Why:** Changing IP (VPN) doesn't change the browser fingerprint. A single person using multiple VPNs still has the same fingerprint. This catches the gap that IP rate limiting misses.

**GDPR Compliance:** Fingerprinting for fraud/abuse prevention is covered under GDPR Article 6(1)(f) "legitimate interest." No consent popup needed. Must be documented in privacy policy.

**Storage:** In-memory Map with 24h TTL. Resets on deploy, which is acceptable since Turnstile + IP limits still protect during the brief window.

**Implementation:**

Frontend — generate fingerprint using FingerprintJS open-source:
```tsx
import FingerprintJS from '@fingerprintjs/fingerprintjs';

const fp = await FingerprintJS.load();
const result = await fp.get();
const fingerprint = result.visitorId; // Stable hash string
```

Backend — track per fingerprint:
```javascript
// In-memory store (with TTL cleanup)
const fingerprintTracker = new Map(); // fingerprint -> { count, firstSeen }
const FINGERPRINT_MAX = 3;           // Max 3 avatar generations per fingerprint
const FINGERPRINT_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

function checkFingerprint(fingerprint) {
  const now = Date.now();
  const record = fingerprintTracker.get(fingerprint);

  if (!record || (now - record.firstSeen) > FINGERPRINT_WINDOW) {
    fingerprintTracker.set(fingerprint, { count: 1, firstSeen: now });
    return true; // Allowed
  }

  if (record.count >= FINGERPRINT_MAX) {
    return false; // Blocked
  }

  record.count++;
  return true; // Allowed
}

// Cleanup stale entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [fp, record] of fingerprintTracker) {
    if ((now - record.firstSeen) > FINGERPRINT_WINDOW) {
      fingerprintTracker.delete(fp);
    }
  }
}, 60 * 60 * 1000);
```

**Limitations:**
- Incognito mode may produce a different fingerprint (~20% of cases)
- Browser updates can change fingerprint
- Not 100% unique — but combined with Turnstile, this is sufficient

---

### Layer 3: IP Rate Limiting (Baseline Protection)

**What:** Standard express-rate-limit on the avatar generation endpoint.

**Why:** Catches the simplest abuse cases. Already implemented pattern in the codebase.

```javascript
const trialAvatarLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,  // 24 hours
  max: 5,                          // 5 avatar generations per IP per day
  message: { error: 'Too many attempts. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});
```

---

## New Endpoint

### `POST /api/trial/generate-preview-avatar`

**Purpose:** Generate a single preview avatar for the "Meet Emma!" celebration screen.

**Protection layers applied (in order):**
1. IP rate limit (5/day)
2. Turnstile verification (bot check) — fallback to fingerprint+IP if Turnstile unavailable
3. Fingerprint check (3/day per browser)

**Request Body:**
```json
{
  "name": "Emma",
  "age": 6,
  "gender": "girl",
  "facePhoto": "<base64>",
  "turnstileToken": "<token>",
  "fingerprint": "<hash>"
}
```

**Response:**
```json
{
  "avatarImage": "<base64>"
}
```

**What it generates:**
- ONE single avatar image (standard pose, watercolor style)
- No evaluation, no trait extraction, no winter/summer variants
- Cost: ~$0.04 per generation

**What it does NOT do:**
- Full avatar pipeline (that happens after account claim)
- Create a user account
- Start story generation (email required first)

**Server-side flow:**
```
1. Check IP rate limit → reject if >= 5/day
2. Verify Turnstile token → reject if invalid (skip if Turnstile unavailable)
3. Check fingerprint count → reject if >= 3/day
4. Call Python service for face detection
5. Generate single avatar via Gemini (watercolor style)
6. Return avatar image to client
```

**Avatar is not stored server-side.** The frontend holds it in component state. If the user refreshes, they generate again (counts against their limits). This is acceptable — legitimate users don't repeatedly refresh this page.

---

## Trial Flow (Updated)

```
Screen 1: Landing Page
  → "Create Your First Story" (free messaging prominent)

Screen 2: Add Your Child
  → Photo upload, name, age
  → Frontend computes browser fingerprint
  → Turnstile widget loads in background

Screen 3: "Meet Emma!" (NEW)
  → POST /api/trial/generate-preview-avatar
  → Celebration screen with AI avatar, sparkles
  → "Create Emma's Story →"

Screen 4: Choose a Theme
  → Theme grid, character preview

Screen 5: Collect Email / Google Sign-In  ← EMAIL WALL (same as current)
  → Email verification OR Google auth
  → Story generation starts (protected by email, same as today)

Screen 6: Story Reading
  → Full immersive experience (in-app, not just PDF)

Screen 7: Story Library
  → "1 of ∞ stories" framing
  → Create more → requires credits/payment
```

---

## Cost Analysis (Worst Case)

| Scenario | Requests | Cost |
|----------|----------|------|
| Legitimate user | 1 | $0.04 |
| Determined human abuser (per browser) | 3 max | $0.12 |
| Bot army without Turnstile bypass | 0 (blocked) | $0.00 |
| Bot army WITH Turnstile bypass + VPN rotation | 5 per IP | Still blocked by fingerprint if same browser |
| Theoretical worst case: unique browsers + IPs | Limited by Turnstile behavioral analysis | Extremely hard to scale |

**Realistic worst case per day:** ~$5-10 (from manual human abuse across many devices). Acceptable.

**Story generation abuse:** Not possible without a verified email address. Same protection as current flow.

---

## Dependencies to Add

### Backend (package.json)
None — Turnstile verification is a simple fetch call. No SDK needed.

### Frontend (client/package.json)
```json
{
  "@marsidev/react-turnstile": "^1.1.0",
  "@fingerprintjs/fingerprintjs": "^4.6.0"
}
```

### Environment Variables
```
TURNSTILE_SITE_KEY=<from Cloudflare dashboard>
TURNSTILE_SECRET_KEY=<from Cloudflare dashboard>
```

---

## Privacy Policy Addition

Add to privacy policy under "Security Measures":

> We use browser fingerprinting technology for fraud prevention and abuse detection.
> This generates a technical identifier from your browser's configuration (such as
> screen resolution, timezone, and rendering capabilities) to detect and prevent
> automated abuse of our free trial service. This data is processed under our
> legitimate interest in preventing fraud (GDPR Article 6(1)(f)). The fingerprint
> data is not used for advertising, tracking across websites, or user profiling.
> It is automatically deleted after 24 hours.

---

## Files to Modify

| File | Change |
|------|--------|
| `client/package.json` | Add @marsidev/react-turnstile, @fingerprintjs/fingerprintjs |
| `client/src/pages/TrialWizard.tsx` | Add avatar reveal step, pass fingerprint + turnstile token |
| `client/src/components/trial/TrialCharacterStep.tsx` | Add Turnstile widget, generate fingerprint |
| `client/src/components/trial/TrialAvatarReveal.tsx` | **NEW** — "Meet Emma!" celebration screen |
| `server/routes/trial.js` | Add `POST /generate-preview-avatar` endpoint, Turnstile verify, fingerprint tracking |
| `server/middleware/rateLimit.js` | Add `trialAvatarLimiter` |
| `.env` / `.env.example` | Add TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY |

---

## Sequence Diagram

```
User                    Frontend                 Backend              Gemini
  |                        |                        |                    |
  |  Upload photo + name   |                        |                    |
  |----------------------->|                        |                    |
  |                        |  Compute fingerprint   |                    |
  |                        |  Get Turnstile token   |                    |
  |                        |                        |                    |
  |  Tap "Next"            |                        |                    |
  |----------------------->|                        |                    |
  |                        | POST /generate-preview-avatar              |
  |                        |  { photo, name, age,   |                    |
  |                        |    turnstileToken,      |                    |
  |                        |    fingerprint }        |                    |
  |                        |----------------------->|                    |
  |                        |                        | 1. IP rate limit   |
  |                        |                        | 2. Verify Turnstile|
  |                        |                        | 3. Check fingerprint (<=3?)
  |                        |                        | 4. Face detection  |
  |                        |                        | 5. Generate avatar |
  |                        |                        |------------------->|
  |                        |                        |    Avatar image    |
  |                        |                        |<-------------------|
  |                        |  { avatarImage }        |                    |
  |                        |<-----------------------|                    |
  |                        |                        |                    |
  |  "Meet Emma!" screen   |                        |                    |
  |  with avatar + sparkles|                        |                    |
  |<-----------------------|                        |                    |
  |                        |                        |                    |
  |  Choose theme          |                        |                    |
  |----------------------->|                        |                    |
  |                        |                        |                    |
  |  Enter email (or Google)  ← EMAIL WALL          |                    |
  |----------------------->|                        |                    |
  |                        | POST /register-email   |                    |
  |                        |----------------------->|                    |
  |                        |                        | Start story job    |
  |                        |                        |------------------->|
```

---

## Decisions Made

| Question | Decision | Rationale |
|----------|----------|-----------|
| Turnstile mode | **Managed** | Rare challenge is acceptable for better protection |
| Fingerprint storage | **In-memory** | Simple, deploy reset is acceptable (Turnstile+IP still protect) |
| Avatar caching | **No server-side cache** | Frontend holds in state; regeneration counts against limits |
| Turnstile fallback | **Fall back to fingerprint+IP** | Don't break trial flow if Turnstile is temporarily down |
| Story generation protection | **Email wall (unchanged)** | Email required before expensive story generation, same as current |
