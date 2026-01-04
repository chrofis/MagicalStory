# Story & Avatar Generation System Documentation

## Overview

The MagicalStory system has two primary generation pipelines:
1. **Story Generation** - Creates narrative, scene descriptions, and coordinated image generation
2. **Avatar Generation** - Creates character reference avatars with clothing variations, styled conversions, and costumed variants

**Key Feature (v2.0):** Per-character clothing - Different characters can wear different outfits in the same scene.

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
   ├─ Call Claude API with streaming
   ├─ Progressive parsing with ProgressiveUnifiedParser
   └─ Extract: scenes, per-character clothing, visual bible
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
   │  ├─ buildSceneDescriptionPrompt(characterClothing)
   │  └─ Call Claude API
   ↓
[STAGE 4: IMAGE GENERATION]
   ├─ Generate covers (title, initial, back)
   └─ Generate page images (parallel)
      ├─ getCharacterPhotoDetails() with per-character clothing
      ├─ buildImagePrompt()
      └─ Call Gemini 2.5 Flash Image API
   ↓
[STAGE 5: FINALIZATION]
   ├─ Save to database
   └─ Export styled avatars for persistence
```

---

## Part 2: Per-Character Clothing System

### 2.1 New Format in Story Prompt

The story-unified.txt prompt now outputs per-character clothing:

```
SCENE HINT:
[1-2 sentences describing the scene]
Characters:
- Lukas: costumed:superhero
- Franziska: standard
- Sophie: winter
```

### 2.2 Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    PER-CHARACTER CLOTHING FLOW                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. PARSING (outlineParser.js)                                   │
│     parseCharacterClothingBlock(content)                         │
│        ↓                                                         │
│     Returns: {                                                   │
│       characterClothing: { "Lukas": "costumed:superhero", ... }  │
│       characters: ["Lukas", "Franziska"]                         │
│     }                                                            │
│                                                                  │
│  2. SCENE EXPANSION (server.js → storyHelpers.js)                │
│     buildSceneDescriptionPrompt(characterClothing)               │
│        ↓                                                         │
│     Formats as:                                                  │
│       - Lukas: costumed:superhero                                │
│       - Franziska: standard                                      │
│                                                                  │
│  3. IMAGE GENERATION (server.js)                                 │
│     sceneClothingRequirements[char.name]._currentClothing        │
│        ↓                                                         │
│     getCharacterPhotoDetails() checks _currentClothing           │
│        ↓                                                         │
│     Each character gets correct avatar for THEIR clothing        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 3: Function Reference

### 3.1 Parsing Functions (outlineParser.js)

#### `parseCharacterClothingBlock(content)`
**Purpose:** Parse per-character clothing from scene content block

**Inputs:**
- `content: string` - Block content containing Characters: section

**Outputs:**
```javascript
{
  characterClothing: { [name: string]: string },  // e.g., { "Lukas": "costumed:superhero" }
  characters: string[]  // e.g., ["Lukas", "Franziska"]
}
```

**Location:** outlineParser.js:47-92

**Notes:**
- Supports new format: `- Name: category`
- Falls back to legacy format: `Characters: Name1, Name2` + `Clothing: category`

---

#### `class UnifiedStoryParser`
**Purpose:** Parse complete unified story response

**Constructor:**
- `response: string` - Full Claude response

**Key Methods:**

| Method | Output | Purpose |
|--------|--------|---------|
| `extractTitle()` | `string \| null` | Get story title |
| `extractClothingRequirements()` | `Object \| null` | Per-character outfit definitions |
| `extractVisualBible()` | `Object \| null` | Recurring visual elements |
| `extractCoverHints()` | `{ titlePage, initialPage, backCover }` | Cover scene hints with characterClothing |
| `extractPages()` | `Array<Page>` | All story pages |

**Page Object Structure:**
```javascript
{
  pageNumber: number,
  text: string,
  sceneHint: string,
  characterClothing: { [name]: string },  // NEW in v2.0
  characters: string[]
}
```

**Location:** outlineParser.js:936-1285

---

#### `class ProgressiveUnifiedParser`
**Purpose:** Stream-based parsing for progressive generation

**Constructor:**
```javascript
new ProgressiveUnifiedParser({
  onTitle: (title) => {},
  onClothingRequirements: (reqs) => {},
  onVisualBible: (bible) => {},
  onCoverHints: () => {},
  onPageComplete: (page) => {},
  onProgress: (type, message, data) => {}
})
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `addChunk(text)` | Process streaming chunk |
| `finalize()` | Complete parsing, emit remaining pages |

**Emitted Page Object:**
```javascript
{
  pageNumber: number,
  text: string,
  sceneHint: string,
  characterClothing: { [name]: string },  // NEW in v2.0
  characters: string[]
}
```

**Location:** outlineParser.js:1328-1700

---

### 3.2 Scene Description Functions (storyHelpers.js)

#### `buildSceneDescriptionPrompt(pageNumber, pageContent, characters, shortSceneDesc, language, visualBible, previousScenes, characterClothing)`

**Purpose:** Build Art Director scene description prompt

**Inputs:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pageNumber` | `number` | - | Current page number |
| `pageContent` | `string` | - | Story text for page |
| `characters` | `Array` | - | Character data array |
| `shortSceneDesc` | `string` | `''` | Scene hint from story |
| `language` | `string` | `'English'` | Output language |
| `visualBible` | `Object` | `null` | Recurring elements |
| `previousScenes` | `Array` | `[]` | Previous 2 pages for context |
| `characterClothing` | `Object\|string` | `{}` | Per-character clothing map |

**Outputs:**
- `string` - Complete Art Director prompt

**characterClothing Format:**
```javascript
// New format (per-character)
{ "Lukas": "costumed:superhero", "Franziska": "standard" }

// Legacy format (single value for all)
"standard"
```

**Location:** storyHelpers.js:1266-1420

---

#### `getCharacterPhotoDetails(characters, clothingCategory, costumeType, artStyle, clothingRequirements)`

**Purpose:** Get avatar/photo details for scene characters with per-character clothing support

**Inputs:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `characters` | `Array` | - | Character objects |
| `clothingCategory` | `string` | `null` | Default clothing category |
| `costumeType` | `string` | `null` | Default costume type |
| `artStyle` | `string` | `null` | Target art style |
| `clothingRequirements` | `Object` | `null` | Per-character clothing info |

**Per-Character Override:**
If `clothingRequirements[charName]._currentClothing` exists, it overrides the default:
```javascript
// Example clothingRequirements with _currentClothing
{
  "Lukas": {
    "_currentClothing": "costumed:superhero",  // Scene-specific
    "costumed": { "costume": "superhero", "used": true }  // Story-level
  },
  "Franziska": {
    "_currentClothing": "standard"
  }
}
```

**Outputs:**
```javascript
Array<{
  name: string,
  id: string,
  photoType: string,  // 'styled-costumed-superhero', 'clothing-standard', etc.
  photoUrl: string,   // Base64 or URL
  photoHash: string,
  clothingCategory: string,
  clothingDescription: string | null,
  hasPhoto: boolean
}>
```

**Location:** storyHelpers.js:569-761

---

### 3.3 Avatar Generation Functions (styledAvatars.js)

#### `collectAvatarRequirements(sceneDescriptions, pageClothing, clothingRequirements, characters)`

**Purpose:** Analyze scenes to determine required avatar variations

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `sceneDescriptions` | `Array<{pageNumber, description}>` | Scene hints |
| `pageClothing` | `Object<pageNum, Object\|string>` | Clothing per page (per-character or single) |
| `clothingRequirements` | `Object` | Story-level outfit definitions |
| `characters` | `Array` | Character data |

**Outputs:**
```javascript
{
  characterClothingMap: {
    [charName]: string[]  // ['standard', 'costumed:superhero']
  },
  costumedCharacters: string[],
  stylingNeeded: boolean
}
```

**Location:** styledAvatars.js:264-370

---

#### `prepareStyledAvatars(characters, artStyle, characterClothingMap, costumedAvatarPromises)`

**Purpose:** Convert avatars to target art style

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `characters` | `Array` | Character data |
| `artStyle` | `string` | Target style (pixar, watercolor, etc.) |
| `characterClothingMap` | `Object` | Required clothing per character |
| `costumedAvatarPromises` | `Array` | Pending costume generations |

**Outputs:**
```javascript
{
  styledAvatarsPromise: Promise<void>,
  prepStats: {
    stylingGenerated: number,
    stylingCached: number,
    costumedGenerated: number,
    costumedCached: number
  }
}
```

**Location:** styledAvatars.js:372-550

---

### 3.4 Server Integration (server.js)

#### Scene Generation Integration

**Location:** server.js:6890-6940

```javascript
// Build per-character clothing lookup
const perCharClothing = scene.characterClothing || {};

// Create merged requirements with _currentClothing
const sceneClothingRequirements = { ...clothingRequirements };
for (const char of sceneCharacters) {
  const charClothing = perCharClothing[char.name] || defaultClothing;
  sceneClothingRequirements[char.name] = {
    ...sceneClothingRequirements[char.name],
    _currentClothing: charClothing
  };
}

// Get avatars with per-character clothing
const pagePhotos = getCharacterPhotoDetails(
  sceneCharacters,
  defaultCategory,
  defaultCostumeType,
  inputData.artStyle,
  sceneClothingRequirements
);
```

---

## Part 4: Avatar Structure

### 4.1 Character Avatar Object

```javascript
character.avatars = {
  // Base clothing avatars
  standard: "data:image/jpeg;base64,...",
  winter: "...",
  summer: "...",

  // Costumed avatars (keyed by costume type)
  costumed: {
    superhero: "...",
    pirate: "...",
    ninja: "..."
  },

  // Styled variants (converted to art style)
  styledAvatars: {
    pixar: {
      standard: "...",
      winter: "...",
      costumed: {
        superhero: "...",
        pirate: "..."
      }
    },
    watercolor: { ... }
  },

  // Extracted clothing descriptions
  clothing: {
    standard: { fullBody: "...", shoes: "..." },
    costumed: {
      superhero: { fullBody: "...", cape: "..." }
    }
  }
};
```

### 4.2 Clothing Category Resolution

**Priority Order:**
1. Per-scene `_currentClothing` from characterClothing
2. Story-level `clothingRequirements` lookup
3. Auto-detect from available avatars
4. Default to 'standard'

**Avatar Selection Priority:**
1. Styled avatar for art style + clothing
2. Regular clothing avatar
3. Fallback chain: costumed → formal → standard → body photo

---

## Part 5: Key Files

| File | Purpose | Key Functions |
|------|---------|---------------|
| server.js | Main orchestration | processUnifiedStoryJob, startSceneExpansion |
| server/lib/storyHelpers.js | Prompt building, avatar lookup | buildSceneDescriptionPrompt, getCharacterPhotoDetails |
| server/lib/outlineParser.js | Parse story responses | UnifiedStoryParser, parseCharacterClothingBlock |
| server/lib/styledAvatars.js | Style conversion | collectAvatarRequirements, prepareStyledAvatars |
| prompts/story-unified.txt | Story generation prompt | Per-character clothing format |
| prompts/scene-descriptions.txt | Scene expansion prompt | CHARACTER_CLOTHING template |

---

## Part 6: Prompt Templates

### 6.1 Story Unified (story-unified.txt)

**Scene Hint Format:**
```
SCENE HINT:
[1-2 sentences describing the scene]
Characters:
- [CharacterName]: [standard | winter | summer | costumed:type]
- [CharacterName]: [clothing category]
```

**Critical Rules:**
- NEVER use "same" - always explicit category
- Each character must be listed with their clothing
- Format is machine-parsed

### 6.2 Scene Descriptions (scene-descriptions.txt)

**Template Variable:**
```
**Character clothing for this page:**
{CHARACTER_CLOTHING}
```

**Formatted as:**
```
- Lukas: costumed:superhero
- Franziska: standard
```

---

## Part 7: Migration Notes

### From v1 (single clothing) to v2 (per-character)

**Backwards Compatibility:**
- Parser supports legacy format (`Clothing: standard` + `Characters: A, B`)
- `buildSceneDescriptionPrompt` accepts both object and string
- `getCharacterPhotoDetails` uses default category if `_currentClothing` not set

**Data Structure Changes:**
| v1 | v2 |
|----|-----|
| `page.clothing: string` | `page.characterClothing: Object` |
| Single clothing per page | Per-character clothing per page |
| `Clothing: standard` in scene hint | `- Name: standard` format |

---

## Part 8: Debugging

### Common Issues

1. **Wrong avatar selected:**
   - Check `_currentClothing` is set in clothingRequirements
   - Verify avatar exists at `char.avatars.styledAvatars[artStyle][category]`

2. **Clothing not parsed:**
   - Check scene hint format matches `- Name: category`
   - Look for `[UNIFIED-PARSER]` debug logs

3. **Fallback to body photo:**
   - Check `[AVATAR FALLBACK]` logs
   - Verify styled avatar generation completed

### Logging

Key log prefixes:
- `[AVATAR LOOKUP]` - Avatar selection per character
- `[UNIFIED-PARSER]` - Story parsing
- `[STREAM-UNIFIED]` - Progressive parsing
- `[SCENE PROMPT]` - Scene description building

---

*Document updated: 2026-01-04*
*Version: 2.0 - Per-character clothing support*
