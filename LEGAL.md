# Legal Implementation Tasks

## Completed

- [x] Terms of Service page (`/terms`) - EN, DE, FR
- [x] Privacy Policy page (`/privacy`) - EN, DE, FR
- [x] Consent checkboxes on photo upload
- [x] Footer with legal links

## Pending

### Photo Retention (30-day deletion)

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

### Other Legal Considerations

- [ ] Set up legal@magicalstory.com email
- [ ] Set up privacy@magicalstory.com email
- [ ] Cookie consent banner (if analytics added)
- [ ] Account deletion flow (GDPR "right to be forgotten")
- [ ] Data export functionality (GDPR data portability)
- [ ] Review by actual lawyer for Swiss/EU compliance
