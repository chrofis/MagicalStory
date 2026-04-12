# Code Review — April 12, 2026

Systematic review of all recently-added features. Bugs only — no style or improvement suggestions.

## Critical Bugs

### 1. PDF text overlay crashes when textRect.imgHeight is missing
**File**: `server/lib/pdf.js:458`
**Impact**: `scaleY = imageHeight / undefined = NaN`. All Y coordinates become NaN. PDFKit crashes or produces a corrupt page. Affects stories processed before textRect was fully populated, or any migration gap.
**Fix**: Add `&& textRect.imgHeight` to the guard:
```js
if (textRect && textRect.w > 0 && textRect.h > 0 && textRect.imgWidth && textRect.imgHeight) {
```

### 2. Text region bounding box produces negative dimensions
**File**: `server/lib/textRegion.js:167-187`
**Impact**: When `washCoverage >= 5%` but no pixel passes the separate `threshold` check (threshold=34 vs coverage check=30), the bbox stays at init values: `minX=width, maxX=0` → rect has negative w/h. Any sharp operation with this rect crashes.
**Fix**: Guard the rect before returning:
```js
if (maxX < minX || maxY < minY) {
  return { imageData, position: preferredPosition, rect: null, score: 0, overridden: false };
}
```

## Major Bugs

### 3. SVG label crash on special characters in VB grid
**File**: `server/lib/images.js:10603` (single-element) and `:10651` (multi-element)
**Impact**: Character names with `&`, `<`, or `>` (e.g. "Tom & Jerry") produce malformed SVG. Sharp's SVG parser fails, `buildVisualBibleGrid` returns null. Entity consistency proceeds without a VB grid — consistency checking degraded. The fallback from single-element to multi-element has the same bug.
**Fix**: Escape XML before interpolation:
```js
const escapeXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
```

### 4. SharedStoryViewer page turn is flat (no 3D depth) on story pages
**File**: `client/src/pages/SharedStoryViewer.tsx:647-652`
**Impact**: `perspective: '2000px'` is on the same element that has the `animation`. CSS requires `perspective` on the PARENT of the rotating element. Story pages turn as a flat 2D horizontal shrink. The initialPage turn works correctly because perspective is on the parent container.
**Fix**: Add an inner wrapper div for the animation, keep perspective on the outer div.

### 5. PDF overlay height re-expansion can push past clamped bounds
**File**: `server/lib/pdf.js:497`
**Impact**: When textRect is near the bottom of the page AND text is long, `Math.max` re-expands `overlayH` past the bottom clamp enforced at line 474. Text/gradient spills below the printable area.
**Fix**: Re-apply bottom clamp after the Math.max:
```js
const maxH = bleed + pageHeight - borderInset - overlayY;
if (overlayH > maxH) overlayH = Math.max(0, maxH);
```

### 6. Admin JWT sent to public unauthenticated endpoint
**File**: `client/src/pages/TrialWizard.tsx:368`, `client/src/pages/trial/TrialCharacterStep.tsx:308`
**Impact**: The admin's full auth JWT is sent in the POST body to `/api/trial/create-anonymous-account` — a public endpoint with no prior auth. If logs capture request bodies, the admin JWT is exposed. Browser devtools also show it.
**Fix**: Use a short-lived HMAC token (`"trial-bypass:" + timestamp`, 5-minute TTL) instead of the primary auth token.

### 7. TOCTOU in referral discount — buyer can get double discount
**File**: `server/routes/print.js:1601` + `server.js:907`
**Impact**: `validateReferralCodeForUser` checks `referred_by IS NULL` at checkout creation. If buyer opens two tabs simultaneously, both pass validation, both Stripe sessions get the discount baked in, and both payments complete at the reduced price. The webhook's `referred_by` lock only prevents double CREDIT GRANT — but both sessions already have the reduced amount. Buyer pays CHF 10 less on one extra order.
**Note**: Low real-world risk (requires deliberate parallel checkout), but a real financial loss path.

### 8. PDF X-axis scaling uses pageWidth but image fills interiorW (includes bleed)
**File**: `server/lib/pdf.js:460`
**Impact**: `scaleX = pageWidth / textRect.imgWidth` but the image is drawn covering `interiorW = pageWidth + 2*bleed`. Text overlay X positions are shifted left by up to `bleed * 2 * scaleX` for rects on the right side. On A4 with 3mm bleed, this is ~2mm shift — visible but subtle.
**Fix**: Use `(pageWidth + 2 * bleed) / textRect.imgWidth` for scaleX, and same for scaleY.

## Minor Bugs

### 9. Cascade face merge distance metric mixes scales
**File**: `server/lib/entityConsistency.js:119-120`
**Impact**: `dx` is in body-widths, `dy` is in normalized image coords (0-1). Combined metric can cause wrong face matched to wrong figure in crowded scenes with close horizontal spacing.

### 10. Lazy referral code generation: concurrent 500 errors
**File**: `server/routes/print.js:1480-1494`
**Impact**: Two concurrent requests to `GET /referral/my-code` for the same user — both try to generate, one hits unique constraint 10 times, returns 500 instead of reading the code the other request wrote. The re-read at line 1493 only runs after a successful break, not after exhausting retries.
**Fix**: After the loop, unconditionally re-read from DB.

### 11. BookBuilder promo input visible when canUsePromo loading
**File**: `client/src/pages/BookBuilder.tsx`
**Impact**: `canUsePromo` defaults to `true` on error (per earlier fix). During the initial API call, it's `null` (loading). The guard `canUsePromo && ...` treats null as falsy — field is hidden during load, then appears. Slight layout jump.

## Not Bugs (Investigated and cleared)

- `sharp.composite` with JPEG buffer on `create:` canvas — valid, auto-detected from magic bytes
- `Buffer.rawElements` property — valid in Node.js, intentional design pattern
- Backward navigation skipping `toHasPanel` — intentional instant navigation
- `sharp.blur(0.3)` minimum — on the edge but valid per sharp docs
