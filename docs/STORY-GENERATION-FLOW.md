# MagicalStory - Story & Image Generation Flow

> **Last Updated**: December 2024
> **Purpose**: Complete documentation of how stories and images are generated

---

## Table of Contents

1. [Overview](#1-overview)
2. [Character Creation](#2-character-creation)
3. [Story Generation Modes](#3-story-generation-modes)
4. [Visual Bible](#4-visual-bible)
5. [Scene Description Generation](#5-scene-description-generation)
6. [Image Generation](#6-image-generation)
7. [Prompt Structure & Data Flow](#7-prompt-structure--data-flow)
8. [Proposed Optimizations](#8-proposed-optimizations)

---

## 1. Overview

### Two Main Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Normal Mode** | Separate outline → text → scene descriptions → images | Longer stories, more control |
| **Storybook Mode** | Combined generation (text + scenes in one pass) | Picture books, simpler stories |

### Image Generation Sub-Modes

| Sub-Mode | Description | Speed | Consistency |
|----------|-------------|-------|-------------|
| **Parallel** | All images generated simultaneously | Fast | Lower (no cross-page reference) |
| **Sequential** | Images generated one-by-one, previous passed to next | Slow | Higher (visual continuity) |

---

## 2. Character Creation

### 2.1 User Input Flow (CharacterForm.tsx)

```
┌─────────────────────────────────────────────────────────────────┐
│                     CHARACTER CREATION                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  STEP 1: Photo Upload                                           │
│  ├── User uploads photo                                         │
│  ├── Server analyzes photo (POST /api/characters/analyze)       │
│  └── Returns:                                                   │
│      ├── faceThumbnail (cropped face)                          │
│      ├── bodyCrop (full body)                                  │
│      ├── bodyNoBg (transparent background)                     │
│      ├── styleAnalysis (detailed style DNA)                    │
│      └── attributes (gender, age, height, build, hairColor)    │
│                                                                  │
│  STEP 2: Character Details                                      │
│  ├── Name (required)                                           │
│  ├── Age, Gender, Height (from photo or manual)                │
│  ├── Strengths (min 3 traits)                                  │
│  ├── Flaws (min 2 traits)                                      │
│  ├── Challenges (optional)                                     │
│  └── Special Details (free text)                               │
│                                                                  │
│  STEP 3: Background Generation (automatic)                      │
│  └── Clothing Avatars generated for:                           │
│      ├── winter (coats, scarves, boots)                        │
│      ├── summer (t-shirts, shorts)                             │
│      ├── formal (suits, dresses)                               │
│      └── standard (casual everyday)                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Style Analysis Structure

When a photo is analyzed, the server extracts:

```javascript
styleAnalysis: {
  physical: {
    face: "Round face, brown eyes, light skin tone, small nose",
    hair: "Medium brown, short, slightly messy, straight texture",
    build: "Slim build, appears to be around 9 years old"
  },
  referenceOutfit: {
    garmentType: "casual hoodie and jeans",
    primaryColor: "blue",
    secondaryColors: ["gray", "white"],
    pattern: "solid",
    fabric: "cotton blend",
    neckline: "crew neck",
    sleeves: "long"
  },
  styleDNA: {
    signatureColors: ["light sky blue", "royal blue", "dark navy"],
    signaturePatterns: ["solid", "stripes"],
    signatureDetails: ["sneakers", "backpack"],
    aesthetic: "casual sporty"
  }
}
```

### 2.3 Character Data Storage

```javascript
character: {
  id: number,
  name: string,
  age: number,
  gender: "male" | "female" | "other",
  height: "tall" | "average" | "short",

  // Photos
  photoUrl: string,           // Original face photo
  bodyPhotoUrl: string,       // Full body photo
  bodyNoBgUrl: string,        // Body with transparent background

  // Clothing Avatars (generated automatically)
  clothingAvatars: {
    winter: string,           // Base64 image
    summer: string,
    formal: string,
    standard: string
  },

  // Style Analysis
  styleAnalysis: { ... },     // As shown above

  // Traits
  strengths: string[],
  flaws: string[],
  challenges: string,
  specialDetails: string
}
```

---

## 3. Story Generation Modes

### 3.1 Normal Mode (with Outline)

```
┌─────────────────────────────────────────────────────────────────┐
│                     NORMAL MODE FLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. OUTLINE GENERATION                                          │
│     ├── Prompt: prompts/outline.txt                             │
│     ├── Input: characters, relationships, story type, details   │
│     └── Output: Plot structure + Visual Bible section           │
│                                                                  │
│  2. VISUAL BIBLE EXTRACTION                                     │
│     ├── Function: parseVisualBible(outline)                     │
│     └── Extracts: secondary characters, animals, artifacts,     │
│                   locations with page appearances               │
│                                                                  │
│  3. STORY TEXT GENERATION                                       │
│     ├── Prompt: prompts/story-text-batch.txt                    │
│     ├── Input: outline, characters, language level              │
│     └── Output: Full story text with page markers               │
│                                                                  │
│  4. SCENE DESCRIPTION GENERATION (Art Director)                 │
│     ├── Prompt: prompts/scene-descriptions.txt                  │
│     ├── Input: page text, characters, Visual Bible              │
│     └── Output: Detailed visual scene per page                  │
│         ├── Setting & Atmosphere                                │
│         ├── Composition (camera angle)                          │
│         ├── Clothing category                                   │
│         ├── Characters (PHYSICAL, ACTION, EXPRESSION, POSITION) │
│         └── Objects & Animals                                   │
│                                                                  │
│  5. IMAGE GENERATION                                            │
│     ├── Prompt: prompts/image-generation.txt (or sequential)    │
│     ├── Input: scene description + reference photos + Visual    │
│     │          Bible                                            │
│     └── Output: Generated illustration                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Storybook Mode (Combined)

```
┌─────────────────────────────────────────────────────────────────┐
│                    STORYBOOK MODE FLOW                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. COMBINED GENERATION (Single API Call)                       │
│     ├── Prompt: prompts/storybook-combined.txt                  │
│     ├── Input: characters, relationships, story type, details   │
│     └── Output (all in one):                                    │
│         ├── Title Page scene                                    │
│         ├── Initial Page scene                                  │
│         ├── Visual Bible section                                │
│         ├── All pages: TEXT + SCENE for each                    │
│         └── Back Cover scene                                    │
│                                                                  │
│  2. VISUAL BIBLE EXTRACTION                                     │
│     ├── Function: parseVisualBible(response)                    │
│     └── Same extraction as normal mode                          │
│                                                                  │
│  3. IMAGE GENERATION                                            │
│     ├── Scene descriptions already included in combined output  │
│     ├── NO separate Art Director step                           │
│     └── Images generated from inline SCENE sections             │
│                                                                  │
│  KEY DIFFERENCE:                                                │
│  - No separate outline.txt call                                 │
│  - No separate scene-descriptions.txt call                      │
│  - Scene descriptions come directly from combined generation    │
│  - Simpler but less control over scene details                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Comparison Table

| Aspect | Normal Mode | Storybook Mode |
|--------|-------------|----------------|
| API Calls for Text | 2-3 (outline + text + scenes) | 1 (combined) |
| Scene Detail Level | High (Art Director prompt) | Medium (inline) |
| Visual Bible | From outline | From combined output |
| Clothing in Scenes | Explicit category field | Explicit category field |
| Best For | Complex stories, detailed control | Simple picture books |

---

## 4. Visual Bible

### 4.1 Structure

```javascript
visualBible: {
  // Populated from inputData.characters
  mainCharacters: [
    {
      id: number,
      name: string,
      physical: {
        face: string,
        hair: string,
        build: string
      },
      styleDNA: {
        signatureColors: string[],
        signaturePatterns: string[],
        signatureDetails: string[]
      },
      physicalDescription: string  // Combined text for prompts
    }
  ],

  // Parsed from outline/combined output
  secondaryCharacters: [
    {
      name: string,
      description: string,
      appearsOnPages: number[],
      extractedDescription: string  // Updated after first image
    }
  ],

  animals: [...],      // Same structure
  artifacts: [...],    // Same structure
  locations: [...],    // Same structure

  changeLog: [...]     // Track modifications
}
```

### 4.2 Visual Bible Population

```
┌─────────────────────────────────────────────────────────────────┐
│                  VISUAL BIBLE POPULATION                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  MAIN CHARACTERS (from user input):                             │
│  ├── initializeVisualBibleMainCharacters(visualBible, chars)    │
│  ├── Source: inputData.characters with styleAnalysis            │
│  └── Contains: physical descriptions, style DNA, colors         │
│                                                                  │
│  SECONDARY ELEMENTS (from AI generation):                       │
│  ├── parseVisualBible(outline or combined output)               │
│  ├── Regex extracts sections:                                   │
│  │   ├── ### Secondary Characters                               │
│  │   ├── ### Animals & Creatures                                │
│  │   ├── ### Artifacts                                          │
│  │   └── ### Locations                                          │
│  └── Format: **Name** (pages X, Y, Z): Description              │
│                                                                  │
│  EXTRACTION AFTER IMAGE GENERATION:                             │
│  ├── First time an element appears in an image                  │
│  ├── AI analyzes the generated image                            │
│  └── extractedDescription updated with exact visual details     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 Visual Bible Usage in Image Generation

```javascript
// Get elements relevant to a specific page
const entries = getVisualBibleEntriesForPage(visualBible, pageNumber);
// Returns: animals, artifacts, locations that have pageNumber in appearsOnPages

// Build prompt section
const vbPrompt = buildVisualBiblePrompt(visualBible, pageNumber, sceneCharacterNames);
// Returns formatted text with:
// - Main characters (filtered to those in scene)
// - Recurring elements for this page
// - Instructions: "MUST MATCH EXACTLY"
```

---

## 5. Scene Description Generation

### 5.1 Normal Mode (Art Director Prompt)

**Prompt Template**: `prompts/scene-descriptions.txt`

**Input**:
- Page text (story content for this page)
- Characters with full physical descriptions
- Visual Bible recurring elements
- Language

**Output Format**:
```
1. **Setting & Atmosphere:**
   - Location, time of day, lighting, mood

2. **Composition:**
   - Camera angle, framing, focal point

3. **Clothing:**
   - winter | summer | formal | standard

4. **Characters:**
   * **[Name]:**
     - PHYSICAL: Full physical description
     - ACTION: What they're doing
     - EXPRESSION: Facial expression
     - POSITION: Where in frame

5. **Objects & Animals:**
   - Visual Bible elements with exact descriptions
```

### 5.2 Storybook Mode (Inline Scenes)

**Prompt Template**: `prompts/storybook-combined.txt`

**Output Format** (simpler):
```
SCENE:
Setting: [Location, atmosphere]
Characters: [Who is present]
Action: [What's happening]
Clothing: [winter/summer/formal/standard]
Mood: [Emotional tone]
```

### 5.3 Clothing Category Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                   CLOTHING CATEGORY FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. SCENE DESCRIPTION includes clothing category                │
│     └── "**Clothing:** winter" or "Clothing: winter"            │
│                                                                  │
│  2. SERVER PARSES CATEGORY                                      │
│     ├── Function: parseClothingCategory(sceneDescription)       │
│     ├── Regex: /Clothing.*?(winter|summer|formal|standard)/i    │
│     └── Returns: "winter" | "summer" | "formal" | "standard"    │
│                                                                  │
│  3. AVATAR SELECTION                                            │
│     ├── Function: getCharacterPhotoDetails(chars, category)     │
│     └── For each character:                                     │
│         ├── IF clothingAvatars[category] exists → use it        │
│         ├── ELSE IF bodyNoBgUrl exists → use it                 │
│         ├── ELSE IF bodyPhotoUrl exists → use it                │
│         └── ELSE use photoUrl (face only)                       │
│                                                                  │
│  4. REFERENCE PHOTOS PASSED TO IMAGE API                        │
│     └── Array of { name, photoUrl, photoType, clothingCategory }│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Image Generation

### 6.1 Parallel vs Sequential Mode

```
┌─────────────────────────────────────────────────────────────────┐
│                     PARALLEL MODE                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Page 1 ─────┐                                                  │
│  Page 2 ─────┼──→ [All generate simultaneously] ──→ Done        │
│  Page 3 ─────┤                                                  │
│  Page 4 ─────┘                                                  │
│                                                                  │
│  Pros: Fast (all in parallel)                                   │
│  Cons: No cross-page visual consistency                         │
│  Template: image-generation.txt                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    SEQUENTIAL MODE                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Page 1 ──→ [Generate] ──→ Image 1                              │
│                              │                                   │
│                              ▼ (passed as reference)             │
│  Page 2 ──→ [Generate] ──→ Image 2                              │
│                              │                                   │
│                              ▼ (passed as reference)             │
│  Page 3 ──→ [Generate] ──→ Image 3                              │
│                              │                                   │
│                              ▼                                   │
│  ...                                                            │
│                                                                  │
│  Pros: Better visual continuity (same backgrounds, furniture)   │
│  Cons: Slower (must wait for each)                              │
│  Template: image-generation-sequential.txt                      │
│  Extra instruction: "Copy props from previous scene"            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 buildImagePrompt Function

**Location**: `server.js` line ~10775

**Input Parameters**:
```javascript
buildImagePrompt(
  sceneDescription,    // Visual scene description
  inputData,           // Story context (artStyle, language, ageRange)
  sceneCharacters,     // Characters appearing in this scene
  isSequential,        // true for sequential mode
  visualBible,         // Complete Visual Bible
  pageNumber           // Current page number
)
```

**Output Construction**:
```
┌─────────────────────────────────────────────────────────────────┐
│                    IMAGE PROMPT STRUCTURE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SECTION 1: CHARACTER REFERENCE PHOTOS                          │
│  ───────────────────────────────────────                        │
│  **CHARACTER REFERENCE PHOTOS (in order):**                     │
│  1. Emma, 8 years old, girl/woman                               │
│  2. Max, 10 years old, boy/man                                  │
│  Match each character to their corresponding reference photo.   │
│                                                                  │
│  SECTION 2: STYLE & SAFETY INSTRUCTIONS                         │
│  ───────────────────────────────────────                        │
│  [From template: image-generation.txt]                          │
│  - Art style description                                        │
│  - Style transformation rules                                   │
│  - Safety/age-appropriate content rules                         │
│                                                                  │
│  SECTION 3: SCENE DESCRIPTION                                   │
│  ───────────────────────────────────────                        │
│  **SZENE:** [Full scene description from Art Director]          │
│                                                                  │
│  SECTION 4: VISUAL BIBLE (appended at end)                      │
│  ───────────────────────────────────────                        │
│  **MAIN CHARACTERS - Must match reference photos:**             │
│  **Emma:**                                                      │
│  - Face: Round face, blue eyes, fair skin                       │
│  - Hair: Blonde, long, wavy                                     │
│  - Build: Slim, 8 years old                                     │
│  - Signature colors: pink, purple, white                        │
│                                                                  │
│  **RECURRING ELEMENTS - MUST MATCH EXACTLY:**                   │
│  **Fluffy (dog)** (animal): Golden retriever, fluffy fur...     │
│  **Magic Wand** (artifact): Silver wand with star tip...        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Reference Photo Labeling

In `callGeminiAPIForImage`:
```javascript
characterPhotos.forEach((photoData) => {
  const photoUrl = photoData.photoUrl;
  const characterName = photoData.name;

  if (characterName) {
    // Add text label BEFORE the image
    parts.push({ text: `[Reference photo of ${characterName}]:` });
  }
  parts.push({ inline_data: { mime_type, data: base64 } });
});

// Gemini receives:
// [text] "[Reference photo of Emma]:"
// [image] Emma's photo
// [text] "[Reference photo of Max]:"
// [image] Max's photo
// [text] Full prompt...
```

---

## 7. Prompt Structure & Data Flow

### 7.1 Data Source Mapping

| Data in Prompt | Source | Mode |
|----------------|--------|------|
| Character names & ages | `inputData.characters` | Both |
| Character physical descriptions | `styleAnalysis.physical` | Both |
| Signature colors | `styleAnalysis.styleDNA.signatureColors` | Both |
| Reference photos | `clothingAvatars[category]` or fallbacks | Both |
| Scene description | `scene-descriptions.txt` output | Normal |
| Scene description | Combined output SCENE section | Storybook |
| Clothing category | Parsed from scene description | Both |
| Secondary characters | Visual Bible (from outline) | Both |
| Animals/Artifacts/Locations | Visual Bible (from outline) | Both |
| Art style | `ART_STYLES[inputData.artStyle]` | Both |

### 7.2 Complete Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    COMPLETE DATA FLOW                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  USER INPUT                                                     │
│  ├── Characters (photos, names, traits)                         │
│  ├── Relationships                                              │
│  ├── Story type & details                                       │
│  └── Art style, language, pages                                 │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────────┐                                        │
│  │   PHOTO ANALYSIS    │                                        │
│  │   (per character)   │                                        │
│  └──────────┬──────────┘                                        │
│             │                                                    │
│             ▼                                                    │
│  ┌─────────────────────┐                                        │
│  │   styleAnalysis     │──→ physical, styleDNA, signatureColors │
│  │   bodyNoBgUrl       │──→ transparent background photo        │
│  │   clothingAvatars   │──→ winter/summer/formal/standard       │
│  └──────────┬──────────┘                                        │
│             │                                                    │
│             ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              STORY GENERATION                            │    │
│  │  ┌─────────────┐         ┌─────────────────┐            │    │
│  │  │ Normal Mode │         │ Storybook Mode  │            │    │
│  │  │             │         │                 │            │    │
│  │  │ outline.txt │         │ storybook-      │            │    │
│  │  │     ▼       │         │ combined.txt    │            │    │
│  │  │ story-text  │         │     ▼           │            │    │
│  │  │     ▼       │         │ (all in one)    │            │    │
│  │  │ scene-desc  │         │                 │            │    │
│  │  └──────┬──────┘         └────────┬────────┘            │    │
│  │         │                         │                      │    │
│  │         └────────────┬────────────┘                      │    │
│  │                      ▼                                   │    │
│  │              Visual Bible                                │    │
│  │              Scene Descriptions                          │    │
│  └──────────────────────┬───────────────────────────────────┘    │
│                         │                                        │
│                         ▼                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              IMAGE GENERATION                            │    │
│  │                                                          │    │
│  │  For each page:                                          │    │
│  │  1. Parse clothing category from scene                   │    │
│  │  2. Select reference photos (with correct avatar)        │    │
│  │  3. Get Visual Bible entries for this page               │    │
│  │  4. Build prompt with buildImagePrompt()                 │    │
│  │  5. Call Gemini API with prompt + photos                 │    │
│  │  6. Evaluate quality, retry if needed                    │    │
│  │                                                          │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. Proposed Optimizations

### 8.1 Current Issues in Image Prompt

1. **Redundant Character Descriptions**
   - Physical descriptions appear in SCENE section (per character)
   - AND again in MAIN CHARACTERS section at the end
   - Recommendation: Remove from SCENE, keep only in MAIN CHARACTERS

2. **Age Inconsistencies**
   - Reference photo header may say "7 years old"
   - PHYSICAL description may say "appears 9 years old"
   - Recommendation: Use single authoritative age from character data

3. **Irrelevant Visual Bible Items**
   - All Visual Bible items may be listed even if not in scene
   - Recommendation: Filter strictly by `appearsOnPages`

4. **Long Prompts**
   - Current prompts can be very long (8000+ characters)
   - Recommendation: Consolidate and remove redundancy

### 8.2 Proposed Optimized Prompt Structure

```
**REFERENCE PHOTOS (in order):**
1. [Name] - [Age] - [Gender]
...
Match each character to their reference photo.

**ART STYLE:** [Style description]

**SCENE:**
Setting: [Location, atmosphere, lighting]
Composition: [Camera angle, framing]
Clothing: [winter/summer/formal/standard]
Action: [What's happening]

**CHARACTERS IN SCENE:**
[Only characters that appear on this page]
* **[Name]:**
  - Match reference photo #X
  - Action: [What they're doing]
  - Expression: [Emotion]
  - Position: [Where in frame]

**VISUAL BIBLE ELEMENTS:**
[Only elements that appear on THIS page]
* **[Name]** ([type]): [Description - MUST MATCH EXACTLY]

**STYLE RULES:**
- Transform photos to [art style], keep recognizable
- All characters same consistent style
- No text, no watermarks
- Age-appropriate for [X-Y] years
```

### 8.3 Key Changes

| Current | Proposed |
|---------|----------|
| Full physical description per character in SCENE | Reference to photo number + action only |
| Physical descriptions duplicated | Single source in MAIN CHARACTERS |
| All Visual Bible items | Only items for this specific page |
| Long detailed instructions repeated | Concise, consolidated instructions |

---

## Appendix: Prompt Template Files

| File | Purpose |
|------|---------|
| `outline.txt` | Generate story outline with Visual Bible |
| `storybook-combined.txt` | Combined text + scenes for picture books |
| `story-text-batch.txt` | Generate story text in batches |
| `scene-descriptions.txt` | Art Director - detailed visual scenes |
| `image-generation.txt` | Image prompt (parallel mode) |
| `image-generation-sequential.txt` | Image prompt (sequential mode) |
| `image-generation-de.txt` | German image prompt |
| `image-generation-fr.txt` | French image prompt |
| `front-cover.txt` | Front cover image |
| `initial-page-with-dedication.txt` | Initial page with dedication |
| `back-cover.txt` | Back cover image |
| `image-evaluation.txt` | Quality evaluation for scenes |
| `cover-image-evaluation.txt` | Quality evaluation for covers |
| `style-analysis.txt` | Extract style DNA from photos |
| `clothing-avatars.txt` | Generate clothing variations |

---

## Next Steps

After reviewing this document:
1. Decide on prompt optimization approach
2. Update prompt templates
3. Test with sample stories
4. Measure improvement in image consistency
