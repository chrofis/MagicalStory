# Trial Pre-Generated Title Page — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate the title page image while the user browses story ideas (step 3), so it's ready before they click "Create My Story".

**Architecture:** New `POST /api/trial/prepare-title` endpoint styles avatars + generates a front cover in ~15-20s. Frontend fires it on step 3 mount (parallel with idea generation). Result stored in DB on the character record. Story pipeline checks for pre-generated title page and skips regenerating it.

**Tech Stack:** Express.js backend, Gemini image generation, styled avatar system, React frontend

---

### Task 1: Backend — `POST /api/trial/prepare-title` endpoint

**Files:**
- Modify: `server/routes/trial.js` — add new endpoint + helper

**Step 1: Add the endpoint**

Add after the `generate-ideas-stream` endpoint (around line 410). The endpoint:
1. Verifies session token (reuses `verifySessionToken` middleware)
2. Loads character from DB (face photo + preview avatar)
3. Looks up costume + title from config
4. Styles the avatar (standard + costumed in watercolor)
5. Generates front cover image using the styled costumed avatar + title
6. Stores result on character record in DB for later reuse by story pipeline
7. Returns `{ titlePageImage, title, costumeType }`

```javascript
/**
 * POST /api/trial/prepare-title
 *
 * Pre-generate title page image while user browses story ideas.
 * Runs avatar styling + cover generation in parallel with idea display.
 */
router.post('/prepare-title', verifySessionToken, async (req, res) => {
  const startTime = Date.now();
  try {
    const { userId } = req.sessionUser;
    const { storyTopic, storyCategory, language } = req.body;

    if (!storyTopic && !storyCategory) {
      return res.status(400).json({ error: 'Story topic or category required' });
    }

    const { getPool } = require('../services/database');
    const pool = getPool();

    // Load character from DB
    const characterId = `characters_${userId}`;
    const charResult = await pool.query('SELECT data FROM characters WHERE id = $1', [characterId]);
    if (charResult.rows.length === 0) {
      return res.status(404).json({ error: 'Character not found' });
    }

    const charData = typeof charResult.rows[0].data === 'string'
      ? JSON.parse(charResult.rows[0].data) : charResult.rows[0].data;
    const mainChar = charData.characters?.[0];
    if (!mainChar) {
      return res.status(404).json({ error: 'Character data not found' });
    }

    const gender = mainChar.gender || '';
    const topic = storyTopic || '';
    const category = storyCategory || 'adventure';
    const lang = language || 'en';

    // Look up costume and title from config
    const { getTrialCostume } = require('../config/trialCostumes');
    const { getTrialTitle } = require('../config/trialTitles');

    const costume = getTrialCostume(topic, category, gender);
    const title = getTrialTitle(topic, category, gender, lang);

    if (!title) {
      log.warn(`[TRIAL TITLE] No pre-defined title for topic=${topic}, category=${category}, gender=${gender}, lang=${lang}`);
      return res.json({ titlePageImage: null, title: null, costumeType: null });
    }

    log.info(`[TRIAL TITLE] Starting title page pre-generation for "${mainChar.name}" (topic: ${topic}, title: "${title}")`);

    // Build character object in the format prepareStyledAvatars expects
    const character = {
      name: mainChar.name || 'Child',
      age: mainChar.age || '',
      gender: mainChar.gender || '',
      isMainCharacter: true,
      photos: mainChar.photos || {},
      avatars: {
        standard: mainChar.previewAvatar || null,
      },
      physical: mainChar.physical || {},
    };

    // Build clothing requirements
    const clothingRequirements = {};
    clothingRequirements[character.name] = {
      standard: { used: true, signature: 'none' },
      costumed: costume
        ? { used: true, costume: costume.costumeType, description: costume.description }
        : { used: false },
    };

    // Build avatar requirements (standard + costumed)
    const avatarRequirements = [
      { pageNumber: 'pre-cover', clothingCategory: 'standard', characterNames: [character.name] },
    ];
    if (costume) {
      avatarRequirements.push({
        pageNumber: 'pre-cover',
        clothingCategory: `costumed:${costume.costumeType}`,
        characterNames: [character.name],
      });
    }

    const artStyle = 'watercolor';
    const characters = [character];

    // Step 1: Style avatars (standard + costumed)
    const { prepareStyledAvatars, clearStyledAvatarCache } = require('../lib/styledAvatars');
    await prepareStyledAvatars(characters, artStyle, avatarRequirements, clothingRequirements, null);
    log.info(`[TRIAL TITLE] Avatar styling complete for "${character.name}"`);

    // Step 2: Generate front cover image
    const {
      ART_STYLES,
      getCharacterPhotoDetails,
      buildCharacterReferenceList,
    } = require('../lib/storyHelpers');
    const { applyStyledAvatars } = require('../lib/styledAvatars');
    const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
    const { generateImageWithQualityRetry } = require('../lib/images');

    // Determine which clothing to use for cover (costumed if available, standard otherwise)
    const coverClothing = costume ? `costumed:${costume.costumeType}` : 'standard';
    const coverClothingReqs = {};
    coverClothingReqs[character.name] = { _currentClothing: coverClothing };

    let coverPhotos = getCharacterPhotoDetails(characters, 'standard', null, artStyle, coverClothingReqs);
    coverPhotos = applyStyledAvatars(coverPhotos, artStyle);

    const styleDescription = ART_STYLES[artStyle] || ART_STYLES.pixar;
    const characterRefList = buildCharacterReferenceList(coverPhotos, characters);

    const sceneDescription = `A magical, eye-catching front cover scene featuring ${character.name} in a ${topic || 'adventure'}-themed setting. The main character is prominently displayed, looking excited and ready for adventure. The composition leaves space at the top for the title.`;

    const coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
      TITLE_PAGE_SCENE: sceneDescription,
      STYLE_DESCRIPTION: styleDescription,
      STORY_TITLE: title,
      CHARACTER_REFERENCE_LIST: characterRefList,
      VISUAL_BIBLE: '',
    });

    const coverResult = await generateImageWithQualityRetry(
      coverPrompt, coverPhotos, null, 'cover', null, null, null, null, 'TRIAL TITLE PAGE',
      { skipQualityEval: true }
    );

    log.info(`[TRIAL TITLE] ✅ Title page generated in ${Date.now() - startTime}ms (score: ${coverResult.score})`);

    const titlePageImage = coverResult.imageData;

    // Store on character record for reuse by story pipeline
    try {
      if (charData.characters[0]) {
        charData.characters[0].preGeneratedTitlePage = titlePageImage;
        charData.characters[0].preGeneratedTitle = title;
        charData.characters[0].preGeneratedCostumeType = costume?.costumeType || null;
        await pool.query('UPDATE characters SET data = $1 WHERE id = $2', [JSON.stringify(charData), characterId]);
      }
    } catch (dbErr) {
      log.warn(`[TRIAL TITLE] Failed to save title page to DB: ${dbErr.message}`);
    }

    // Clear styled avatar cache (this was a standalone call, don't pollute other requests)
    clearStyledAvatarCache();

    res.json({ titlePageImage, title, costumeType: costume?.costumeType || null });
  } catch (err) {
    log.error(`[TRIAL TITLE] prepare-title error: ${err.message}`);
    res.json({ titlePageImage: null, title: null, costumeType: null });
  }
});
```

**Key design decisions:**
- Returns `{ titlePageImage: null }` on failure (not 500) — this is an optimization, not critical path
- Clears styled avatar cache after standalone generation to avoid cross-contamination
- Stores result in DB on the character record so the story pipeline can skip cover regeneration
- Uses `skipQualityEval: true` in options to save cost/time

**Step 2: Verify `skipQualityEval` is respected by `generateImageWithQualityRetry`**

Check `server/lib/images.js` for how `options.skipQualityEval` is handled. If not already supported, the `skipQualityEval` on the endpoint is fine — the trial story pipeline already sets it via `inputData.skipQualityEval`.

Actually, looking at the function signature, `options` is the last param. We need to check if it supports `skipQualityEval`. If not, we'll pass `null` for the quality model override instead.

**Step 3: Commit**

```
feat: add prepare-title endpoint for pre-generating trial title page
```

---

### Task 2: Backend — Wire pre-generated title page into story pipeline

**Files:**
- Modify: `server/routes/trial.js` — `createTrialStoryJob()` function (~line 1310)
- Modify: `server.js` — cover generation section (~line 2496)

**Step 1: Load pre-generated title page in `createTrialStoryJob()`**

In `createTrialStoryJob()`, after loading character data, check for `preGeneratedTitlePage` on the character and add it to `inputData`:

```javascript
// After line 1353 (trialMode: true), add:
// Check for pre-generated title page (from prepare-title endpoint)
const mainCharDB = charData?.characters?.[0];  // note: charData isn't available here
```

Actually, `createTrialStoryJob` receives `characterData` (extracted from DB already in `create-story`). But the pre-generated title page is stored on the character in DB. We need to load it from the DB character record.

Better approach: In the `create-story` endpoint (line 551), after loading `charResult`, extract the pre-generated data:

```javascript
// After line 590 (const mainChar = charData.characters[0];), add:
const preGeneratedTitlePage = mainChar.preGeneratedTitlePage || null;
const preGeneratedTitle = mainChar.preGeneratedTitle || null;

// Pass to createTrialStoryJob or add to inputData directly
```

Then pass it into `createTrialStoryJob` and add to inputData.

**Step 2: Skip cover generation when pre-generated title exists**

In `server.js`, in `startCoverGeneration` (line 2496), add a check:

```javascript
const startCoverGeneration = (coverType, hint) => {
  if (streamingCoverPromises.has(coverType) || skipImages) return;
  if (inputData.titlePageOnly && coverType !== 'titlePage') return;
  if (skipCovers) return;
  // Skip if pre-generated title page exists
  if (coverType === 'titlePage' && inputData.preGeneratedTitlePage) {
    log.info(`⏭️ [COVER] Skipping titlePage generation — using pre-generated title page`);
    // Create a resolved promise with the pre-generated data
    streamingCoverPromises.set(coverType, Promise.resolve({
      imageData: inputData.preGeneratedTitlePage,
      score: 80,
      reasoning: 'Pre-generated during trial step 3',
    }));
    return;
  }
  // ... rest of existing code
```

**Step 3: Commit**

```
feat: wire pre-generated title page into story pipeline
```

---

### Task 3: Frontend — Call `prepare-title` from TrialIdeasStep

**Files:**
- Modify: `client/src/pages/trial/TrialIdeasStep.tsx` — add prepare-title call on mount
- Modify: `client/src/pages/TrialWizard.tsx` — pass props + state for title page data

**Step 1: Add props and state to TrialWizard**

In `TrialWizard.tsx`, add state for title page data and pass it to TrialIdeasStep:

```typescript
// After previewAvatar state (line 135):
const [titlePageData, setTitlePageData] = useState<{
  titlePageImage: string | null;
  title: string | null;
  costumeType: string | null;
} | null>(null);
```

Pass to TrialIdeasStep:
```tsx
<TrialIdeasStep
  // ... existing props ...
  sessionToken={sessionToken}
  storyInput={storyInput}
  onTitlePageReady={setTitlePageData}
/>
```

Pass to generation page navigation:
```typescript
navigate('/trial-generation', {
  state: {
    // ... existing state ...
    titlePageData,
  },
});
```

**Step 2: Fire prepare-title in TrialIdeasStep on mount**

In `TrialIdeasStep.tsx`, add new props and a background fetch:

```typescript
interface Props {
  // ... existing props ...
  sessionToken?: string | null;
  onTitlePageReady?: (data: { titlePageImage: string | null; title: string | null; costumeType: string | null }) => void;
}
```

Add a `useEffect` that fires prepare-title on mount:

```typescript
// Fire prepare-title in background on mount
useEffect(() => {
  if (!sessionToken || !storyInput.storyTopic) return;

  const apiUrl = import.meta.env.VITE_API_URL || '';
  fetch(`${apiUrl}/api/trial/prepare-title`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      storyTopic: storyInput.storyTopic,
      storyCategory: storyInput.storyCategory,
      language: storyInput.language,
    }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.titlePageImage) {
        onTitlePageReady?.(data);
      }
    })
    .catch(() => {
      // Non-critical — story pipeline will generate title page if this fails
    });
}, [sessionToken, storyInput.storyTopic, storyInput.storyCategory, storyInput.language]);
```

**Step 3: Commit**

```
feat: call prepare-title on step 3 mount for background title page generation
```

---

### Task 4: Frontend — Show title page preview on generation page

**Files:**
- Modify: `client/src/pages/TrialGenerationPage.tsx` — show title page image, pass to create-story

**Step 1: Accept titlePageData in LocationState**

```typescript
interface LocationState {
  // ... existing fields ...
  titlePageData?: {
    titlePageImage: string | null;
    title: string | null;
    costumeType: string | null;
  } | null;
}
```

**Step 2: Show title page instead of avatar when available**

Replace the avatar display section with conditional rendering:

```tsx
{state.titlePageData?.titlePageImage ? (
  <div className="mb-4">
    <img
      src={state.titlePageData.titlePageImage}
      alt={state.titlePageData.title || 'Story cover'}
      className="w-48 h-auto rounded-xl shadow-lg mx-auto"
    />
  </div>
) : state.previewAvatar ? (
  <div className="mb-4">
    <img
      src={state.previewAvatar}
      alt={state.characterName || 'Character'}
      className="w-24 h-24 rounded-full object-cover border-4 border-indigo-100 shadow-md"
    />
  </div>
) : (
  <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-4">
    <BookOpen className="w-8 h-8 text-indigo-600" />
  </div>
)}
```

**Step 3: Pass titlePageData to create-story (so backend can skip regeneration)**

The `create-story` endpoint doesn't need the image from the frontend since it's already stored in the DB from `prepare-title`. No changes needed to the fetch call.

**Step 4: Commit**

```
feat: show pre-generated title page on generation page
```

---

### Task 5: Build, test, and deploy

**Step 1: Build**
```bash
cd client && npm run build
```

**Step 2: Manual test**
- Go to `/try`
- Complete step 1 (character)
- Complete step 2 (topic)
- On step 3, check network tab for `prepare-title` request
- Verify it returns a `titlePageImage`
- Click "Create My Story"
- Verify title page shows on generation page
- Check Railway logs for `[TRIAL TITLE]` messages

**Step 3: Commit and push**
```bash
git add -A
git commit -m "feat: pre-generate trial title page during idea browsing"
git push origin master
```
