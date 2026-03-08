# Trial Flow v2 — Design Spec

**Date:** 2026-03-08
**Status:** Draft

## Goals

- Faster trial story generation (parallel avatar + title page, no scene expansion)
- Cheaper (simpler prompt, fewer API calls)
- Pre-defined costumes per topic (no costume generation in outline)
- Title page image (no other covers)
- Progressive prompt sanitization on Gemini blocks
- Keep trial in unified pipeline (flag-based)

## Changes Overview

| Area | Current | New |
|------|---------|-----|
| Costumes | Claude generates in outline | Pre-defined config file per topic |
| Story avatars | Wait for outline clothing → then style | Start immediately at job start |
| Scene expansion | Separate Claude call per page | Skip — richer hints in trial prompt |
| Title page | None (skipCovers=true) | Generate 1 title page, parallel |
| Other covers | None | Still none |
| Landmarks | All reference images | Top 3 only |
| Image retry | None | Progressive prompt sanitization |
| Output | 10 pages (5 scenes) | 11 pages (5 scenes + 1 title page) |
| Trial prompt | Has clothing section | Simplified, no clothing section |

---

## 1. Pre-Defined Costume Config

### New file: `server/config/trialCostumes.js`

Maps each adventure theme and historical event to male/female costume descriptions.

```javascript
module.exports = {
  // Adventure themes
  adventure: {
    pirate: {
      male: "Striped sailor shirt, brown leather vest, loose canvas trousers tucked into tall boots, wide leather belt with brass buckle",
      female: "Striped sailor blouse, brown leather corset vest, flowing skirt over trousers, tall boots, wide leather belt"
    },
    knight: {
      male: "Silver chain mail tunic over padded gambeson, leather bracers, brown boots, simple sword belt",
      female: "Silver chain mail tunic over padded gambeson, leather bracers, brown boots, simple sword belt"
    },
    // ... all 28 adventure themes
    wizard: {
      male: "Long flowing robe in deep blue with silver star patterns, leather belt with pouch, pointed shoes",
      female: "Long flowing robe in deep purple with golden moon patterns, leather belt with pouch, pointed shoes"
    },
    // For themes without clear costumes (detective, doctor, etc.):
    detective: {
      male: "Tweed jacket, magnifying glass on a chain, brown trousers, polished shoes, newsboy cap",
      female: "Tweed blazer, magnifying glass on a chain, plaid skirt, polished shoes, beret"
    },
    // ... etc
  },

  // Historical events — pull from existing prompts/historical-guides.txt
  historical: {
    'moon-landing': {
      male: "White NASA spacesuit with American flag patch, life support chest panel, white boots",
      female: "White NASA spacesuit with American flag patch, life support chest panel, white boots"
    },
    'columbus-voyage': {
      male: "Renaissance sailor tunic, loose trousers, leather shoes, cloth cap, rope belt",
      female: "Renaissance blouse with laced bodice, long skirt, leather shoes, cloth cap"
    },
    // ... all 55+ historical events
  }
};
```

**Gender detection:** Use `character.gender` field (already exists on character objects).

**Fallback:** If topic not in config → use `standard` avatar only (no costumed).

---

## 2. Immediate Story Avatar Generation

### Current flow:
```
Stream outline → parse clothing → prepareStyledAvatars() → wait → use in images
```

### New trial flow:
```
Job starts → look up costume from config → start prepareStyledAvatars() immediately
                                          → parallel with outline streaming
```

### Implementation (in `processUnifiedStoryJob`, server.js):

Before starting story generation, if `trialMode`:

```javascript
if (inputData.trialMode) {
  const costume = getTrialCostume(inputData.storyTopic, inputData.storyCategory, mainCharacter.gender);
  const trialClothingRequirements = {
    [mainCharacter.name]: {
      standard: { used: true, signature: 'none' },
      costumed: costume
        ? { used: true, costume: costumeType, description: costume }
        : { used: false }
    }
  };

  // Start avatar styling immediately — don't wait for outline
  streamingAvatarStylingPromise = prepareStyledAvatars(
    inputData.characters,
    artStyle,
    [{ pageNumber: 1, clothingCategory: 'standard', characterNames: [mainCharacter.name] }],
    trialClothingRequirements,
    addUsage
  );
}
```

This runs in parallel with the entire outline generation.

---

## 3. Title Page Generation

### Current: `skipCovers = true` → no covers at all

### New: Generate title page only, started as soon as title is parsed from stream

**Trigger:** In the streaming `onTitle` callback (or equivalent), as soon as we have the title:

```javascript
if (inputData.trialMode && !skipImages) {
  // Start title page generation as soon as title is known
  // Uses cover image model from config
  streamingCoverPromises.set('titlePage',
    startCoverGeneration('titlePage', titlePageHint)
  );
}
```

**Title page hint:** Since we removed cover hints from the trial prompt, build a simple one:

```javascript
const titlePageHint = `Book cover for "${title}". Main character in the center.
Setting: ${inputData.storyTopic} theme. Art style: ${artStyle}.`;
```

**Dependencies:** Needs styled avatars ready before image generation starts. Since avatars start immediately too, they should be ready by the time the title is parsed. If not, `startCoverGeneration` already waits for avatars internally.

**Model:** Uses `models.coverImage` (currently `gemini-3-pro-image-preview`).

**No other covers:** `initialPage` and `backCover` remain skipped.

---

## 4. Skip Scene Expansion for Trial

### Current: Each page's scene hint → `startSceneExpansion()` → separate Claude call → full scene description

### New: Skip entirely for trial. Scene hints used directly as image prompts.

**Implementation:** In PHASE 3 (scene expansion wait), skip for trial:

```javascript
if (inputData.trialMode) {
  // Trial uses enriched scene hints directly — no expansion needed
  for (const page of allPages) {
    page.sceneDescription = page.sceneHint; // Use hint as-is
  }
} else {
  // Normal flow: wait for scene expansions
  await Promise.all(sceneExpansionPromises);
}
```

**Prompt change:** Trial prompt must output richer scene hints (see section 7).

---

## 5. Top 3 Landmarks Only

### Current: Reference sheet generates images for all visual bible elements with 2+ appearances

### New: For trial, limit to top 3 elements (by page count, then alphabetical)

**Implementation:** In reference sheet generation:

```javascript
const maxLandmarks = inputData.trialMode ? 3 : undefined; // undefined = no limit
const refSheet = await generateReferenceSheet(visualBible, styleDescription, {
  minAppearances: 2,
  maxPerBatch: 4,
  maxElements: maxLandmarks  // NEW parameter
});
```

**Selection:** Sort by number of page appearances (descending), take top 3.

---

## 6. Progressive Image Retry on Gemini Block

### New feature for ALL stories (not just trial)

When Gemini blocks an image generation (content filtering), retry with progressively sanitized prompts:

```
Attempt 1: Original prompt
Attempt 2: Remove problematic words (weapons, blood, fire, death, etc.)
Attempt 3: Simplify to core scene — just setting + characters + action
Attempt 4: Minimal prompt — "[art style] illustration of a child in a [setting]"
```

### Implementation: New function `generateImageWithSanitizedRetry()`

```javascript
async function generateImageWithSanitizedRetry(prompt, options) {
  const sanitizationLevels = [
    (p) => p,                           // Level 0: original
    (p) => removeProblematicWords(p),   // Level 1: strip risky words
    (p) => simplifyToCore(p),           // Level 2: core scene only
    (p) => buildMinimalPrompt(options),  // Level 3: minimal fallback
  ];

  for (let level = 0; level < sanitizationLevels.length; level++) {
    const sanitized = sanitizationLevels[level](prompt);
    const result = await generateImage(sanitized, options);
    if (result.success) return result;
    if (!result.blocked) return result; // Real error, don't retry
    log.warn(`Image blocked at level ${level}, trying level ${level + 1}`);
  }
  return { success: false, error: 'All sanitization levels failed' };
}
```

**Problematic word list:** `['weapon', 'sword', 'knife', 'blood', 'fire', 'burning', 'death', 'dead', 'kill', 'attack', 'fight', 'war', 'battle', 'explosion', 'gun', 'shoot', 'violent', 'scary', 'horror', 'torture', 'poison', ...]`

Word list in a config constant, easy to extend.

---

## 7. Simplified Trial Prompt

### New `prompts/story-trial.txt`:

Key changes from current:
- **Removed:** `---CLOTHING REQUIREMENTS---` section (costumes from config)
- **Removed:** `{COSTUME_INSTRUCTION}` placeholder
- **Simplified:** Visual bible → locations + 1-2 key objects only
- **Enriched:** Scene hints are richer (used directly, no expansion)
- **Added:** `standard`/`costumed` avatar selection instruction
- **Removed:** `---COVER SCENE HINTS---` section

```
# Trial Story Generation

You write children's stories. Create a {PAGES}-scene story.
SHORT story — {PAGES} scenes. Keep it focused:
- One clear conflict, one resolution. No subplots.
- Introduce quickly (scene 1), build tension (2-3), resolve (4-5).

**Rules:**
- Write EVERYTHING in {LANGUAGE}. {LANGUAGE_NOTE}
- 150-200 words per page, flowing paragraphs
- Start with action, not weather or waking up
- Show character personality through actions

# Story Parameters
- **Scenes**: {PAGES}
- **Language**: {LANGUAGE}
- **Characters**: {CHARACTERS}
- **Story Idea**: {STORY_DETAILS}

# Avatar Selection
The main character has two avatar styles available:
- `standard` — everyday modern clothes
- `costumed:{COSTUME_TYPE}` — {COSTUME_DESCRIPTION}

Use `standard` for the opening scene (before the adventure begins).
Use `costumed:{COSTUME_TYPE}` for all other scenes.

# OUTPUT FORMAT

---TITLE---
TITLE: [Creative title in {LANGUAGE}]

---VISUAL BIBLE---
```json
{
  "locations": [
    { "id": "LOC001", "name": "[name]", "pages": [1,2], "description": "[key visual features, colors, style]" }
  ],
  "keyObjects": [
    { "id": "OBJ001", "name": "[name]", "pages": [2,3,4], "description": "[appearance]" }
  ]
}
```

---STORY PAGES---

--- Page 1 ---
TEXT:
[Story text, 150-200 words]

SCENE HINT:
[2-3 sentences: setting, mood, lighting, key action. Include colors, textures, atmosphere. Be specific enough for image generation without expansion.]
Characters:
- [Name] (left/right/center): [standard | costumed:{type}]
Setting: [indoor/outdoor] | Time: [morning/afternoon/evening/night] | Weather: [sunny/cloudy/rainy/snowy/n/a]
Key objects: [list any visual bible objects in scene]

--- Page 2 ---
... continue for ALL {PAGES} pages ...
```

### Changes to `buildTrialStoryPrompt()`:

- Read costume from config instead of building `COSTUME_INSTRUCTION`
- New placeholders: `{COSTUME_TYPE}`, `{COSTUME_DESCRIPTION}`
- If no costume available for topic → remove avatar selection section, all pages use `standard`

---

## 8. Pipeline Flow — New Trial Timeline

```
JOB START
  │
  ├─ Look up costume from config
  ├─ START prepareStyledAvatars(standard + costumed) ──────────────────┐
  │                                                                     │ parallel
  ├─ START story generation (streaming) ────────────────────────────┐   │
  │   ├─ Title parsed → START title page generation ────────────┐   │   │
  │   ├─ Visual bible parsed → load landmarks (top 3 only)      │   │   │
  │   ├─ Pages parsed (with rich scene hints)                   │   │   │
  │   └─ Stream complete                                        │   │   │
  │                                                              │   │   │
  ├─ WAIT for avatars ◄──────────────────────────────────────────┼───┘   │
  ├─ WAIT for story ◄───────────────────────────────────────────┘       │
  │                                                                      │
  ├─ NO scene expansion (hints used directly)                            │
  │                                                                      │
  ├─ Generate page images (5 pages) ─── with sanitized retry            │
  │   └─ Uses styled avatars + landmarks + rich scene hints             │
  │                                                                      │
  ├─ WAIT for title page ◄──────────────────────────────────────────────┘
  │
  ├─ Save story (5 scenes + 1 title page = 11 print pages)
  │
  └─ DONE
```

**Estimated time savings:**
- Avatar styling: ~10-15s saved (no longer waits for outline)
- Scene expansion: ~15-20s saved (5 pages × 3-4s each)
- Fewer landmarks: ~5-10s saved
- Title page: ~0s added (fully parallel)
- **Total: ~30-45s faster**

---

## 9. Files to Modify

| File | Change |
|------|--------|
| `server/config/trialCostumes.js` | **NEW** — costume config per topic |
| `prompts/story-trial.txt` | Rewrite — simplified, richer hints |
| `server/lib/storyHelpers.js` | Update `buildTrialStoryPrompt()` — new placeholders |
| `server.js` | Trial-specific early avatar start, skip scene expansion, title page trigger |
| `server/lib/images.js` | Add `generateImageWithSanitizedRetry()` |
| `server/routes/trial.js` | Update `createTrialStoryJob()` — remove `skipCovers`, add `skipCoversExceptTitle` or similar flag |
| `server/lib/referenceSheet.js` (or equivalent) | Add `maxElements` parameter |

---

## 10. Model Configuration

| Image | Model Parameter | Current Default |
|-------|----------------|-----------------|
| Title page | `models.coverImage` | `gemini-3-pro-image-preview` |
| Page images | `models.pageImage` | `gemini-2.5-flash-image` |

Both follow global config — no trial-specific overrides. If the model is changed globally, trial changes too.

---

## 11. Cost Estimate (Trial v2)

| Item | Cost |
|------|------|
| Story text (Claude Haiku, 1 call) | ~$0.005 |
| 2 styled avatars (Gemini) | ~$0.08 |
| Title page (Gemini 3 Pro) | ~$0.15 |
| 5 page images (Gemini 2.5 Flash) | ~$0.20 |
| 3 landmark references (Gemini) | ~$0.12 |
| **Total** | **~$0.56** |

vs. current trial: ~$0.41 (but no title page, no avatars)
vs. paid story: ~$4-5
