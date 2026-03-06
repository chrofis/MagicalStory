# Complete Review: Character Creation & Avatar Management

## Executive Summary (Updated Jan 18, 2026)

After testing initial fixes, the **ROOT CAUSE** of data loss on refresh was identified:

**The `analyze-photo` endpoint was only saving legacy flat fields (`photo_url`, `body_no_bg_url`, etc.) but NOT the `photos` object that the frontend uses.** When the character was later saved via POST, the preserve query didn't include `photos`, so it was lost.

### Critical Issues Identified:
1. **`photos` object not saved** - analyze-photo endpoint only saves legacy fields (FIXED but reverted)
2. **Missing fields in preserve query** - `photos`, `hair_length`, `skin_tone`, `skin_tone_hex`, `facial_hair`, `detailed_hair_analysis`
3. **ID type mismatch** - SQL returns strings, frontend sends numbers, strict equality fails
4. **thumbnail_url not stripped** - Large base64 data in metadata queries

---

## CRITICAL ISSUES (Must Fix)

### 1. Missing `metadata` Column in Characters Table
**Severity:** CRITICAL | **File:** `server/services/database.js:143-149`

The characters table CREATE statement doesn't include `metadata JSONB`, but `characters.js` and `avatars.js` write to it.

```sql
-- Current (BROKEN):
CREATE TABLE IF NOT EXISTS characters (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  -- metadata column MISSING!
)
```

**Impact:** INSERT/UPDATE queries fail silently or throw errors on databases without the column.

**Fix:** Add metadata column and ALTER statement (like stories table has at line 166).

---

### 2. Avatar Job Marked "Complete" Even When DB Save Fails
**Severity:** CRITICAL | **File:** `server/routes/avatars.js:2103-2236`

When character not found after 10 retries, avatars are generated successfully but NOT saved to DB. However, job status is still set to 'complete' and avatars returned to frontend.

```javascript
// Line 2106: Only logs warning, doesn't fail job
log.warn(`Avatars generated but NOT saved to DB!`);

// Line 2233: Job marked complete anyway
results.status = 'complete';
job.result = results;  // Contains avatars that weren't persisted!
```

**Impact:** User sees avatars, thinks they're saved, but they're lost on page refresh.

**Fix:** Already partially fixed - throw error if character not found (line 2218). But need to also set `dbSaveSuccessful: false` in result.

---

### 3. Fire-and-Forget Avatar Generation Creates Race Conditions
**Severity:** CRITICAL | **File:** `client/src/pages/StoryWizard.tsx:1627-1674`

Avatar generation runs in background without awaiting. If user switches characters, state updates can corrupt data.

```javascript
characterService.generateAndSaveAvatarForCharacter(charForGeneration, ...)
  .then(result => {
    // Problem: currentCharacter might be different character now
    setCharacters(prev => prev.map(c =>
      c.id === charId ? { ...c, ...result.character! } : c
    ));
  });
  // No .catch() handler!
```

**Impact:** Avatar updates can be lost or applied to wrong character.

---

### 4. Photo Upload Creates Orphaned Character Records
**Severity:** CRITICAL | **File:** `server/routes/avatars.js:1471-1514`

Every photo upload creates a NEW character in DB with `Date.now()` ID. For existing characters re-uploading photos, this creates orphaned records.

```javascript
const characterId = Date.now();  // Always new ID
// ... creates new DB record ...
```

Frontend now ignores server ID for existing characters, but orphaned records accumulate.

**Impact:** Database bloat, potential confusion if name fallback matches wrong record.

---

### 5. Hacky setState Pattern for Reading State
**Severity:** CRITICAL | **File:** `client/src/pages/StoryWizard.tsx:2343-2362`

Uses unreliable pattern to read current state:

```javascript
const latestCurrentChar = await new Promise<Character | null>(resolve => {
  setCurrentCharacter(prev => {
    resolve(prev);  // Reads state inside setState
    return prev;
  });
});
```

**Impact:** React batches updates - this may not return latest state.

**Fix:** Use `useRef` to track latest state values.

---

### 6. New Characters Added to Array But Never Saved
**Severity:** CRITICAL | **File:** `client/src/pages/StoryWizard.tsx:1600-1618`

New characters are added to React state array but NOT automatically persisted:

```javascript
if (!exists) {
  log.info(`Adding new character to array to prevent data loss`);
  return [...prev, newChar];  // Only in memory!
}
```

**Impact:** If user navigates away without explicit save, character is lost.

---

## HIGH SEVERITY ISSUES

### 7. Name Fallback Can Match Wrong Character
**File:** `server/routes/avatars.js:2082, 2967`

If character ID lookup fails, falls back to name matching. Multiple characters with same name = wrong match.

### 8. Retry Timeout Too Short (20 seconds)
**File:** `server/routes/avatars.js:2063-2101`

10 retries × 2 seconds = 20 seconds. User taking longer to name character = avatar job gives up.

### 9. Frontend Retry Logic Masks Real Errors
**File:** `client/src/services/characterService.ts:1036-1049`

Retries 3 times with 500ms delay, but if avatars still missing, continues silently without error.

### 10. Missing Error Handling in Background Avatar Generation
**File:** `client/src/pages/StoryWizard.tsx:2391-2413`

No `.catch()` handler, no timeout, no user notification on failure.

### 11. Inconsistent ID Handling - Server Creates Duplicate
**File:** `client/src/pages/StoryWizard.tsx:1545-1557`

Server always creates new ID, frontend ignores it for existing characters. Works but creates orphans.

### 12. Race Condition in Metadata Fallback
**File:** `server/routes/characters.js:54-58`

If metadata column missing, falls back to full data query but may fail.

### 13. No Migration for Characters Metadata Column
**File:** `server/services/database.js`

Stories table has `ALTER TABLE ADD COLUMN IF NOT EXISTS metadata`, characters doesn't.

---

## MEDIUM SEVERITY ISSUES

### 14. Stale Flag Never Set When Photo Changes
**File:** `client/src/types/character.ts:149`

`avatars.stale` should be `true` when photo changes, but it's never set.

### 15. Clothing Source Lost on Avatar Regeneration
**File:** `client/src/pages/StoryWizard.tsx:1997-2046`

`clothingSource` tracking not updated when avatars regenerated.

### 16. Aggressive Legacy Cleanup Deletes All Other Rows
**File:** `server/routes/characters.js:494-502`

`DELETE FROM characters WHERE user_id = $1 AND id != $2` is too aggressive.

### 17. Redundant Merge Logic (characterMerge.js Unused)
**File:** `server/lib/characterMerge.js`

Utilities exist but aren't used - logic reimplemented inline in characters.js.

### 18. Inconsistent Name Validation Before Avatar Generation
**File:** `client/src/pages/StoryWizard.tsx:1627 vs 1844`

`handlePhotoSelect` doesn't check name, `handleFaceSelection` does.

### 19. Photo Data Inconsistency
**File:** `client/src/pages/StoryWizard.tsx:1507-1514`

`original` fallback to `originalPhotoUrl` may not match `face` photo.

### 20. Avatar Metadata Inconsistency
**File:** `server/routes/characters.js:445-456`

Metadata structure differs from full data structure.

### 21. Silent Failure in Photo Endpoint
**File:** `server/routes/avatars.js:1515-1518`

DB errors caught and logged but don't fail the response.

---

## FOCUSED FIX PLAN (Updated Jan 18, 2026)

### Current State (Verified via Code Review)

The following fixes are **ALREADY IN PRODUCTION** (working tree clean, matches origin/master):
- `photos` object saved in analyze-photo endpoint (line 1510)
- `photos` field in preserve query (line 200)
- ID type conversion with `String()` (lines 229-230)

### Remaining Issues to Fix

#### 1. Missing Fields in Preserve Query (CRITICAL)
**File:** `server/routes/characters.js` lines 194-220

Avatar generation extracts these fields (avatars.js lines 2157-2164) but preserve query doesn't include them:
- `hair_length`
- `skin_tone`
- `skin_tone_hex`
- `facial_hair`
- `detailed_hair_analysis`

**Impact:** These traits get lost when character is saved after avatar generation completes.

**Fix:** Add to preserve query (after line 215):
```sql
'hair_length', c->>'hair_length',
'skin_tone', c->>'skin_tone',
'skin_tone_hex', c->>'skin_tone_hex',
'facial_hair', c->>'facial_hair',
'detailed_hair_analysis', c->>'detailed_hair_analysis'
```

#### 2. Missing Merge Logic for New Fields
**File:** `server/routes/characters.js` after line 298

Need to add preservation logic like the other fields have (height, eye_color, etc.):
```javascript
if (existingChar.hair_length && !newChar.hair_length) {
  mergedChar.hair_length = existingChar.hair_length;
  preservedFields.push('hair_length');
  hasChanges = true;
}
// Similar for: skin_tone, skin_tone_hex, facial_hair, detailed_hair_analysis
```

#### 3. Strip thumbnail_url from Metadata (Performance)
**File:** `server/routes/characters.js` line 449

Current stripping:
```javascript
const { body_no_bg_url, body_photo_url, photo_url, clothing_avatars, photos, ...lightChar } = char;
```

`thumbnail_url` is NOT stripped but contains base64 data (set at avatars.js:1506).

**Fix:** Add `thumbnail_url` to destructured fields:
```javascript
const { body_no_bg_url, body_photo_url, photo_url, thumbnail_url, clothing_avatars, photos, ...lightChar } = char;
```

---

## Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `server/routes/characters.js` | 215 | Add 5 missing fields to preserve query |
| `server/routes/characters.js` | ~298 | Add merge logic for 5 fields |
| `server/routes/characters.js` | 449 | Add `thumbnail_url` to strip list |

---

## Verification

1. **Generate avatars → Save character → Verify traits preserved**:
   - Upload photo, generate avatars (which extracts traits)
   - Save character (triggers preserve/merge)
   - Reload page
   - Verify `hair_length`, `skin_tone`, etc. are present

2. **Check metadata size**: After fix, metadata should not include `thumbnail_url` base64 data
