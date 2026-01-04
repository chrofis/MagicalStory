# Story & Avatar Generation System Documentation

## Overview

The MagicalStory system has two primary generation pipelines:
1. **Story Generation** - Creates narrative, scene descriptions, and coordinated image generation
2. **Avatar Generation** - Creates character reference avatars with clothing variations, styled conversions, and costumed variants

---

## Part 1: Story Generation Flow

### 1.1 Entry Points

**Main Entry Point:** `processStoryJob(jobId)` - server.js:7070

Three generation modes based on `inputData.generationMode`:

| Mode | Function | Behavior |
|------|----------|----------|
| `unified` (default) | processUnifiedStoryJob | Single AI prompt generates complete story |
| `pictureBook` | processStorybookJob | Combined text+scene for 1st-grade readers |
| `outlineAndText` | processStorybookJob | Legacy: separate outline then text prompts |

### 1.2 Generation Sequence

```
INPUT: Story parameters (title, characters, pages, language, style)
   ↓
[STAGE 1: OUTLINE GENERATION]
   ├─ buildStoryPrompt() or buildUnifiedStoryPrompt()
   ├─ Call Claude API
   ├─ Parse with OutlineParser or UnifiedStoryParser
   └─ Extract: scenes, clothing per page, visual bible
   ↓
[STAGE 2: CLOTHING & AVATAR PREPARATION]
   ├─ extractClothingRequirements() - Per-character variations
   ├─ collectAvatarRequirements() - Build avatar prep list
   ├─ prepareStyledAvatars() - Convert to target art style
   └─ Store in character objects & cache
   ↓
[STAGE 3: SCENE DESCRIPTIONS]
   ├─ For each page:
   │  ├─ getCharactersInScene()
   │  ├─ buildSceneDescriptionPrompt()
   │  └─ Call Claude API
   ↓
[STAGE 4: IMAGE GENERATION]
   ├─ Generate covers (title, initial, back)
   └─ Generate page images (parallel)
      ├─ getCharacterPhotoDetails()
      ├─ buildImagePrompt()
      └─ Call Gemini 2.5 Flash Image API
   ↓
[STAGE 5: FINALIZATION]
   ├─ Save to database
   └─ Export styled avatars for persistence
```

### 1.3 Key Files

| File | Purpose |
|------|---------|
| server.js | Main generation orchestration |
| server/lib/storyHelpers.js | Helper functions for prompts, character handling |
| server/lib/outlineParser.js | Parse outline/unified responses |
| server/lib/styledAvatars.js | Style conversion & caching |
| server/routes/avatars.js | Avatar generation API |

---

## Part 2: Avatar Generation Flow

### 2.1 Avatar Types

1. **Clothing Avatars** - Body with different outfits (standard, winter, summer)
2. **Styled Avatars** - Converted to art style (Pixar, watercolor, etc.)
3. **Costumed Avatars** - Full costume transformations (pirate, ninja, etc.)

### 2.2 Data Structure

```javascript
character.avatars = {
  // Clothing-based avatars
  standard: "data:image/jpeg;base64,...",
  winter: "...",
  summer: "...",

  // Costumed avatars
  costumed: {
    pirate: "...",
    ninja: "..."
  },

  // Styled variants
  styledAvatars: {
    pixar: {
      standard: "...",
      costumed: { pirate: "..." }
    },
    watercolor: { ... }
  },

  // Clothing descriptions
  clothing: {
    standard: { fullBody: "...", shoes: "..." }
  }
};
```

### 2.3 Key Functions

| Function | File | Purpose |
|----------|------|---------|
| generateDynamicAvatar | avatars.js | Generate single avatar with clothing |
| generateStyledCostumedAvatar | avatars.js | Costume + style in one call |
| prepareStyledAvatars | styledAvatars.js | Convert to art style |
| applyStyledAvatars | styledAvatars.js | Apply styled versions to photos |
| getCharacterPhotoDetails | storyHelpers.js | Select correct avatar for scene |

---

## Part 3: Identified Duplications

### 3.1 HIGH PRIORITY - Token Tracking (300+ lines duplicated)

**Problem:** Identical token tracking code in 3 functions:
- `processStorybookJob` (server.js:4722)
- `processUnifiedStoryJob` (server.js:6153)
- `processStoryJob` (server.js:7070)

**Duplicated Code:**
```javascript
const tokenUsage = {
  anthropic: {...},
  gemini_text: {...},
  gemini_image: {...},
  byFunction: {...}
};
const addUsage = (provider, usage, functionName, modelName) => {...};
const calculateCost = (...) => {...};
```

**Solution:** Extract to `server/lib/tokenTracking.js`:
```javascript
class TokenTracker {
  constructor()
  addUsage(provider, usage, functionName, modelName)
  calculateCost(model, inputTokens, outputTokens, thinkingTokens)
  getReport()
}
```

### 3.2 HIGH PRIORITY - Character Reference Building

**Problem:** Gender term and physical description logic duplicated:

| Location | Function |
|----------|----------|
| storyHelpers.js:871 | `getGenderTerm` in buildCharacterReferenceList |
| storyHelpers.js:1463 | `getGenderTerm` in buildImagePrompt (IDENTICAL) |

**Solution:** Extract shared helpers:
```javascript
function getAgeAppropriateGenderTerm(gender, apparentAge)
function buildHairDescription(physical, legacyField)
function buildPhysicalTraitsParts(char)
```

### 3.3 MEDIUM PRIORITY - Art Style Prompts Loaded Twice

**Problem:** `loadArtStylePrompts()` and `ART_STYLE_PROMPTS` defined in:
- avatars.js:513, 537
- styledAvatars.js:53, 92

**Solution:** Load once in `server/lib/prompts.js`, import where needed.

### 3.4 MEDIUM PRIORITY - Clothing Parsing

**Problem:** Similar clothing extraction in multiple places:
- `parseClothingCategory` (storyHelpers.js:469)
- `_extractClothingFromBlock` (outlineParser.js:549)
- Inline parsing in outlineParser

**Solution:** Consolidate into `server/lib/clothingParser.js`:
```javascript
function parseClothingFromScene(text, format='any')
function mapClothingCategory(category) // handles 'formal' → 'standard'
```

### 3.5 LOW PRIORITY - Unused Function

**Check if still used:**
- `extractTraitsWithGemini` (avatars.js:65) - May be deprecated since traits are now extracted in `evaluateAvatarFaceMatch`

---

## Part 4: Improvement Proposals

### 4.1 Consolidate Token Tracking (Estimated: 2-3 hours)

Create `server/lib/tokenTracking.js`:

```javascript
class TokenTracker {
  constructor() {
    this.usage = { anthropic: {}, gemini_text: {}, gemini_image: {}, byFunction: {} };
  }

  addUsage(provider, usage, functionName, modelName) { ... }
  calculateCost(model, inputTokens, outputTokens, thinkingTokens) { ... }
  getUsageSummary() { ... }
  exportForDatabase() { ... }
}

module.exports = { TokenTracker };
```

Update all 3 generation functions to use it.

### 4.2 Consolidate Character Helpers (Estimated: 1-2 hours)

Add to `storyHelpers.js`:

```javascript
// At top of file - shared helpers
function getAgeAppropriateGenderTerm(gender, apparentAge) {
  // ... single implementation
}

function buildHairDescription(physical, legacyHairField) {
  // Handles both new structure (color/length/style) and legacy
}
```

Remove duplicates from `buildCharacterReferenceList` and `buildImagePrompt`.

### 4.3 Centralize Art Style Prompts (Estimated: 30 min)

In `server/services/prompts.js`:
```javascript
// Add to existing prompts.js
const ART_STYLE_PROMPTS = loadArtStylePrompts();
module.exports.ART_STYLE_PROMPTS = ART_STYLE_PROMPTS;
```

Update imports in `avatars.js` and `styledAvatars.js`.

### 4.4 Simplify Avatar Lookup (Estimated: 1 hour)

Current flow is complex:
1. Generate costumed avatar → store in character object
2. Convert to style → store in cache
3. Scene needs avatar → look up from character OR cache
4. Mismatch between keys causes fallback

**Proposal:** Always store styled avatars in character objects immediately after conversion:

```javascript
// In prepareStyledAvatars, after conversion:
char.avatars.styledAvatars[artStyle][clothingCategory] = styledAvatar;
```

This eliminates cache/object mismatch issues.

### 4.5 Unified ClothingRequirements Structure

Current issue: Two different structures used:
1. **From outline (nested):** `{ CharName: { costumed: { used, costume, description } } }`
2. **For scene lookup (flat):** `{ CharName: "costumed:ninja-trainingsanzug" }`

**Proposal:** Use flat structure everywhere, convert at parse time:
```javascript
// In UnifiedStoryParser.extractClothingRequirements():
// Convert to flat: { CharName: "costumed:costume-type" }
```

---

## Part 5: Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      STORY GENERATION                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  INPUT: Characters, Story Params                                 │
│    ↓                                                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ STAGE 1: Generate Outline/Story                          │   │
│  │  └→ Claude API → Parser → clothingRequirements           │   │
│  └──────────────────────────────────────────────────────────┘   │
│    ↓                                                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ STAGE 2: Prepare Avatars                                  │   │
│  │  ├→ collectAvatarRequirements()                          │   │
│  │  ├→ generateStyledCostumedAvatar() for costumed chars    │   │
│  │  ├→ prepareStyledAvatars() for style conversion          │   │
│  │  └→ Store in char.avatars.styledAvatars[style]           │   │
│  └──────────────────────────────────────────────────────────┘   │
│    ↓                                                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ STAGE 3: Generate Images                                  │   │
│  │  ├→ getCharacterPhotoDetails(chars, clothing, artStyle,  │   │
│  │  │                           clothingRequirements)        │   │
│  │  │   └→ Looks up costume from clothingRequirements       │   │
│  │  │   └→ Finds avatar in styledAvatars[artStyle].costumed │   │
│  │  ├→ buildImagePrompt() with character references         │   │
│  │  └→ Gemini API → Scene Images                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│    ↓                                                             │
│  OUTPUT: Complete Story with Images                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 6: Files Summary

| File | Lines | Purpose | Consolidation Opportunity |
|------|-------|---------|--------------------------|
| server.js | ~9000 | Main server, story generation | Extract token tracking |
| server/lib/storyHelpers.js | ~2000 | Prompt building, character handling | Extract gender/hair helpers |
| server/lib/styledAvatars.js | ~730 | Style conversion, caching | Remove duplicate art style loading |
| server/lib/outlineParser.js | ~1600 | Parse outline responses | Share clothing keywords |
| server/routes/avatars.js | ~1000 | Avatar generation API | Check for unused functions |

---

## Part 7: Priority Action Items

1. **Immediate (fixes current bugs):**
   - [x] Fix `generateStyledCostumedAvatar` parameter order
   - [x] Fix `clothingRequirements` lookup (flat string format)
   - [x] Pass `clothingRequirements` to `getCharacterPhotoDetails`

2. **Short-term (reduce code duplication):**
   - [ ] Extract TokenTracker class
   - [ ] Consolidate gender term helpers
   - [ ] Centralize art style prompts

3. **Medium-term (improve architecture):**
   - [ ] Unify clothingRequirements structure
   - [ ] Store styled avatars directly in character objects
   - [ ] Consolidate clothing parsing

---

*Document generated: 2026-01-04*
*Last updated after fixing costumed avatar generation bugs*
