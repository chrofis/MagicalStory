# Legal Implementation Tasks

## Completed

- [x] Terms of Service page (`/terms`) - EN, DE, FR
- [x] Privacy Policy page (`/privacy`) - EN, DE, FR
- [x] Consent checkboxes on photo upload (explicit consent for AI processing)
- [x] Footer with legal links
- [x] ToS: Explicit US prohibition ("Service not available to US residents/citizens")
- [x] ToS: User warranty that they are CH/EU residents
- [x] ToS: Swiss law jurisdiction with exclusive Zurich courts
- [x] ToS: UN CISG exclusion

## Pending - Technical Implementation

### 1. US Geo-Blocking (HIGH PRIORITY)

**Status:** Not implemented

**Requirements:**
- IP-based geo-blocking for all US IP addresses
- Show explicit "Access Denied" page to US visitors
- Consider blocking known VPN exit nodes (optional, complex)
- Log blocked access attempts for monitoring

**Implementation options:**
- Cloudflare geo-blocking rules (recommended - simple, reliable)
- Server-side middleware checking IP geolocation
- Railway/hosting provider geo-restrictions

### 2. Payment Restrictions

**Status:** Not implemented

**Requirements:**
- Stripe: Only accept cards with CH/EU billing addresses
- Remove USD as currency option
- Only offer EUR/CHF

**Implementation:**
- Stripe Checkout: Use `billing_address_collection: 'required'`
- Validate country code in webhook before processing
- Configure allowed countries in Stripe Dashboard

### 3. Photo Retention (30-day deletion)

**Status:** Not implemented

**What the Privacy Policy states:**
- Original photos deleted within 30 days after story completion
- Generated avatars retained until account deletion

**Implementation needed:**
1. Track upload timestamps - Add `photos.originalUploadedAt` to character data
2. Scheduled cleanup job (daily cron) to:
   - Find characters where `originalUploadedAt` > 30 days ago
   - Clear `photos.original` field (uploaded photo)
   - Keep `photos.face`, `photos.body`, etc. (generated avatars)
3. Consider: Server cron job vs admin endpoint with external scheduler

### 4. Account Deletion (GDPR "Right to be Forgotten")

**Status:** Not implemented

**Requirements:**
- User-accessible "Delete my account" button in settings
- Delete all user data: account, characters, stories, photos, orders history
- Confirm deletion with email verification
- 30-day grace period before permanent deletion (optional)

### 5. Data Export (GDPR Data Portability)

**Status:** Not implemented

**Requirements:**
- User can request export of all their data
- Provide data in machine-readable format (JSON)
- Include: account info, characters, stories, order history

## Pending - Administrative

- [ ] Set up legal@magicalstory.com email
- [ ] Set up privacy@magicalstory.com email
- [ ] Cookie consent banner (if analytics added)
- [ ] Review by actual lawyer for Swiss/EU/FADP compliance
- [ ] Data Processing Agreements with cloud providers (Railway, Google Cloud, OpenAI)

## Notes

**Biometric Data (GDPR Art. 9):**
Photos containing faces may be considered biometric data under GDPR. Current implementation:
- Explicit consent checkbox before upload ✓
- Clear explanation of AI processing in consent text ✓
- Privacy Policy explains photo processing ✓

**FADP (Swiss Data Protection Act):**
- Similar requirements to GDPR
- Swiss law jurisdiction specified in ToS ✓
- Consider registering data processing activities if required
