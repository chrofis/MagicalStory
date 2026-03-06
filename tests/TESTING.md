# Automated Testing Documentation

## Overview

E2E tests for MagicalStory using Playwright. Tests cover character management, photo uploads, avatar generation, and relationships.

## Running Tests

```bash
# Start local servers first (3 terminals)
npm run dev            # Backend on :3000
npm run dev:client     # Frontend on :5173
npm run dev:python     # Python photo analyzer on :5000

# Run all character management tests
TEST_BASE_URL=http://localhost:5173 npx playwright test tests/character-management.spec.ts --project=chromium --reporter=line

# Run specific test
TEST_BASE_URL=http://localhost:5173 npx playwright test tests/character-management.spec.ts --project=chromium --grep "Test 1"

# Run with visible browser
TEST_BASE_URL=http://localhost:5173 npx playwright test tests/character-management.spec.ts --project=chromium --headed
```

## Test Files

### `tests/character-management.spec.ts`

| Test | Description | Duration |
|------|-------------|----------|
| Test 1 | Delete and recreate Franziska with avatar + relationships | ~2 min |
| Test 2 | Upload new photo for Roger, verify avatar generation | ~1 min |
| Test 3 | Edit traits and regenerate avatar with traits | ~1 min |
| Test 4 | (Additional tests) | varies |

## Test Photos

Test photos are stored in: `C:\Users\roger\OneDrive\Pictures\For automatic testing\`
- Franziska.jpg (92KB)
- Lukas.jpg (272KB)
- Manuel.jpg (632KB)
- Roger.jpg (550KB)
- Sophie.JPG (349KB)

## Key Fixes Made (January 2026)

### 1. Avatar Job Timing Fix
**Problem:** Avatar job completed BEFORE wizard saved character to database. Avatar was generated but couldn't be saved.

**Fix:** Added retry logic in `server/routes/avatars.js` (lines 2001-2048):
- When avatar job can't find character, retries up to 10 times
- 2-second delay between retries
- Allows wizard save to complete before avatar tries to save

### 2. False Positive Avatar Verification
**Problem:** Test claimed Franziska had avatar when she didn't. Locator was finding wrong card.

**Fix:** Changed verification in test to iterate through character cards specifically:
```typescript
const allCards = page.locator('div.border.rounded-lg, div.border.rounded');
for (let i = 0; i < cardCount; i++) {
  const card = allCards.nth(i);
  const cardText = await card.textContent();
  if (cardText?.includes('Franziska')) {
    // Found the right card, check for avatar
  }
}
```

### 3. Relationships Not Being Set
**Problem:** Test wasn't navigating to relationships step. Only clicked "Next" once after traits.

**Fix:** Character creation flow is: photo → name → traits → **characteristics** → **relationships** → avatar

Need to click "Next" TWICE after traits:
1. traits → characteristics (hobbies)
2. characteristics → relationships

```typescript
// First click: traits → characteristics
await nextBtn.click();
await page.waitForTimeout(2000);

// Second click: characteristics → relationships
await nextBtn.click();
await page.waitForTimeout(2000);

// Now set relationships
const relationshipCards = page.locator('div.rounded-lg').filter({ has: page.locator('select') });
```

### 4. bodyNoBg Not Saved for New Characters
**Problem:** New characters didn't have `body_no_bg_url` saved. Server only preserved from DB, but new characters had nothing in DB.

**Fix:** Pass `{ includePhotos: true }` when saving new characters in `client/src/pages/StoryWizard.tsx`:
```typescript
const hasNewCharWithPhotos = !isEdit && latestCurrentChar.photos?.original;
await characterService.saveCharacterData({
  characters: updatedCharacters,
  // ...
}, { includePhotos: hasNewCharWithPhotos });
```

### 5. Test Not Detecting Avatar Generation Failures
**Problem:** Test 2 claimed success even when avatar generation failed with IMAGE_OTHER.

**Fix:** Updated test to properly wait for completion and detect failures:
```typescript
for (let i = 0; i < 60; i++) {
  if (logs.some(log => log.includes('Avatar job') && log.includes('completed'))) {
    avatarCompleted = true;
    break;
  }
  if (logs.some(log => log.includes('Avatar job') && log.includes('Failed'))) {
    avatarFailed = true;
    throw new Error('Avatar generation failed');
  }
  await page.waitForTimeout(2000);
}
```

## Known Issues

### Gemini IMAGE_OTHER Failures (Local Only)

**Symptom:** Avatar generation fails locally with `IMAGE_OTHER` from Gemini, but works on production.

**Root Cause:** Production uses **cached avatars** and doesn't regenerate. When forcing regeneration locally with new photo upload, Gemini's content filter sometimes rejects the request.

**Evidence:**
- Production log: `Roger already has standard avatar, skipping`
- Local: Makes actual Gemini call → gets IMAGE_OTHER

**Gemini Filter Triggers:**
The avatar prompt includes body transformation language:
```
BODY TRANSFORMATION (CRITICAL):
- Generate the person with an ATHLETIC, FIT body type by default
- Do NOT preserve overweight or heavy body proportions
- transform the body to be slim and athletic
```

This can trigger content filters, especially for:
- Standard/summer avatars (show more body)
- Winter avatars often succeed (heavy coat hides body)

**Probabilistic Nature:**
- Not 100% deterministic
- Same request can succeed or fail on retry
- Rapid successive requests increase failure rate

**Potential Fixes (Not Yet Implemented):**
1. Accept partial success (2/3 avatars is OK)
2. Sequential generation with delays
3. Remove body transformation language on retry
4. Exponential backoff with more retries

## Test Screenshots

Screenshots saved to `test-results/`:
- `t1-01-start.png` - Initial state
- `t1-02-franziska-found.png` - Before deletion
- `t1-03-deleted.png` - After deletion
- `t1-07b-traits-selected.png` - After selecting traits
- `t1-08b-relationships-step.png` - Relationships page
- `t1-08c-relationships-set.png` - After setting relationships
- `t1-09-final.png` - Final character list
- `t2-06-avatar-FAILED.png` - Avatar generation failure (if occurs)

## Architecture Notes

### Character Creation Flow (Step 1 of Wizard)
```
photo → name → traits → characteristics → relationships → avatar
```
Each sub-step requires clicking "Next" to advance.

### Avatar Generation Flow
1. Photo uploaded → Python analyzer extracts face, body, bodyNoBg
2. Character saved to database
3. Avatar job started (background)
4. Job generates 3 seasonal avatars: winter, standard, summer
5. Job saves avatars + extracted traits to database
6. Frontend polls for completion

### Relationship Data Structure
```typescript
relationships: {
  "char1Id-char2Id": "Parent of",  // Forward
  "char2Id-char1Id": "Child of"    // Inverse (auto-set)
}
```

## Console Capture

Tests capture browser console logs to detect errors:
```typescript
const logs: string[] = [];
page.on('console', msg => {
  const text = msg.text();
  logs.push(text);
  if (text.includes('[ERROR]') || text.includes('Avatar job')) {
    console.log(`[BROWSER] ${text}`);
  }
});
```

## Troubleshooting

### Server Won't Start (Port in Use)
```bash
# Windows
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"

# Then restart
npm run dev
```

### Avatar Generation Timeout
- Increase test timeout: `test.setTimeout(300000);`
- Check Python service is running on :5000
- Check server logs for errors

### Tests Pass But Manual Check Shows Issues
- Always verify screenshots in `test-results/`
- Check that assertions actually validate expected state
- Don't trust "Note: may still be generating" messages
