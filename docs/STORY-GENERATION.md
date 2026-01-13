# MagicalStory Story Generation Pipeline

**Last Updated:** January 2025

## Table of Contents

1. [Overview](#1-overview)
2. [Generation Pipeline](#2-generation-pipeline)
3. [Character Creation](#3-character-creation)
4. [Visual Bible System](#4-visual-bible-system)
5. [Scene Descriptions](#5-scene-descriptions)
6. [Image Generation](#6-image-generation)
7. [Physical Features & Clothing](#7-physical-features--clothing)
8. [Page Architecture](#8-page-architecture)
9. [Regeneration & Editing](#9-regeneration--editing)
10. [Quality Evaluation](#10-quality-evaluation)
11. [Cover Generation](#11-cover-generation)
12. [Prompt Templates](#12-prompt-templates)

---

## 1. Overview

### Generation Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Unified** (default) | Single prompt generates complete story with Art Director scene expansion | Most stories |
| **Picture Book** | Combined text + scene generation | Simple picture books |
| **Outline + Text** | Separate outline → text → scenes | Legacy, more control |

### Image Generation Sub-Modes

| Sub-Mode | Description | Speed | Consistency |
|----------|-------------|-------|-------------|
| **Parallel** | All images generated simultaneously | Fast | Lower |
| **Sequential** | Images generated one-by-one, previous passed as reference | Slow | Higher |

### Complete Pipeline Flow

```
POST /api/jobs/create-story → Background Job:
  1. Generate Outline (Claude)           → 5%
  2. Extract Scene Hints                 → Internal
  3. Generate Story Text (Claude)        → 10-40%
  4. Generate Scene Descriptions         → Parallel
  5. Generate Images (Gemini)            → 10-90%
  6. Quality Evaluation + Auto-Repair    → Optional
  7. Generate Covers                     → 95%
  8. Save Final Result                   → 100%
  → GET /api/jobs/:id/status (polling)
```

---

## 2. Generation Pipeline

### Step-by-Step Flow

```
┌─────────────────────────────────────────────────────────────┐
│  BACKGROUND JOB (processStoryJob)                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 1: Generate Outline (5%)                              │
│      └─► Claude API → outline + checkpoint                  │
│                                                             │
│  Step 2: Extract Scene Hints (internal)                     │
│      └─► Parse outline → shortSceneDescriptions + checkpoint│
│                                                             │
│  Step 3: Generate Story Text (10-40%)                       │
│      └─► Claude API batches → fullStoryText + checkpoint    │
│                                                             │
│  Step 4: Generate Scene Descriptions (parallel)             │
│      └─► Claude API per page → allSceneDescriptions[]       │
│                                                             │
│  Step 5: Generate Images (10-90%, parallel/sequential)      │
│      ├─► Gemini API per page → raw image                    │
│      ├─► Compress to JPEG                                   │
│      ├─► Gemini API: evaluateImageQuality() → score 0-100   │
│      └─► Quality retry if below threshold + checkpoint      │
│                                                             │
│  Step 6: Generate Covers (95%)                              │
│      ├─► Gemini API × 3 → coverImages{}                     │
│      └─► Quality evaluation with text accuracy check        │
│                                                             │
│  Step 7: Save Final Result (100%)                           │
│      └─► UPDATE story_jobs SET result_data = {...}          │
│          + Send completion email                            │
└─────────────────────────────────────────────────────────────┘
```

### Checkpoint System

Checkpoints save progress after each major step for debugging and recovery:

| Checkpoint | Saved After |
|------------|-------------|
| `outline` | Outline generation |
| `scene_hints` | Scene hint extraction |
| `story_batch_N` | Each story text batch |
| `page_N` | Each page image generation |
| `cover_TYPE` | Each cover generation |

---

## 3. Character Creation

### User Input Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     CHARACTER CREATION                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  STEP 1: Photo Upload                                        │
│  ├── User uploads photo                                      │
│  ├── Server analyzes photo (POST /api/characters/analyze)    │
│  └── Returns:                                                │
│      ├── faceThumbnail (cropped face)                       │
│      ├── bodyCrop (full body)                               │
│      ├── bodyNoBg (transparent background)                  │
│      ├── styleAnalysis (detailed style DNA)                 │
│      └── attributes (gender, age, height, build, hairColor) │
│                                                              │
│  STEP 2: Character Details                                   │
│  ├── Name (required)                                        │
│  ├── Age, Gender, Height (from photo or manual)             │
│  ├── Strengths (min 3 traits)                               │
│  ├── Flaws (min 2 traits)                                   │
│  └── Challenges, Special Details (optional)                 │
│                                                              │
│  STEP 3: Avatar Generation (automatic)                       │
│  └── Clothing Avatars generated for:                        │
│      ├── winter (coats, scarves, boots)                     │
│      ├── summer (t-shirts, shorts)                          │
│      ├── formal (suits, dresses)                            │
│      └── standard (casual everyday)                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Character Data Structure

```javascript
character: {
  id: number,
  name: string,
  age: number,
  gender: "male" | "female" | "other",

  // Photos
  photoUrl: string,           // Original face photo
  bodyPhotoUrl: string,       // Full body photo
  bodyNoBgUrl: string,        // Body with transparent background

  // Clothing Avatars
  clothingAvatars: {
    winter: string,           // Base64 image
    summer: string,
    formal: string,
    standard: string
  },

  // Physical Traits
  physical: {
    height: string,
    build: string,
    eyeColor: string,
    hairColor: string,
    hairStyle: string,
    hairLength: string,
    facialHair: string,       // males only
    skinTone: string,
    face: string,
    other: string             // glasses, birthmarks
  },

  // Style Analysis from Photo
  styleAnalysis: {
    physical: { face, hair, build },
    styleDNA: {
      signatureColors: string[],
      signaturePatterns: string[],
      signatureDetails: string[]
    }
  },

  // Personality Traits
  strengths: string[],
  flaws: string[],
  challenges: string,
  specialDetails: string
}
```

---

## 4. Visual Bible System

The Visual Bible tracks visual consistency for all story elements.

### Structure

```javascript
visualBible: {
  // From user input
  mainCharacters: [{
    id: number,
    name: string,
    physical: { face, hair, build },
    styleDNA: { signatureColors, signaturePatterns, signatureDetails },
    physicalDescription: string
  }],

  // Parsed from outline/combined output
  secondaryCharacters: [{
    name: string,
    description: string,
    appearsOnPages: number[],
    extractedDescription: string  // Updated after first image
  }],

  animals: [...],      // Same structure
  artifacts: [...],    // Same structure
  locations: [...],    // Same structure
  clothing: [...],     // Special items (capes, masks)

  changeLog: [...]     // Track modifications
}
```

### Population Flow

```
MAIN CHARACTERS (from user input):
├── initializeVisualBibleMainCharacters(visualBible, chars)
├── Source: inputData.characters with styleAnalysis
└── Contains: physical descriptions, style DNA, colors

SECONDARY ELEMENTS (from AI generation):
├── parseVisualBible(outline or combined output)
├── Regex extracts sections:
│   ├── ### Secondary Characters
│   ├── ### Animals & Creatures
│   ├── ### Artifacts
│   └── ### Locations
└── Format: **Name** (pages X, Y, Z): Description

EXTRACTION AFTER IMAGE GENERATION:
├── First time an element appears in an image
├── AI analyzes the generated image
└── extractedDescription updated with exact visual details
```

### Usage in Image Generation

```javascript
// Get elements relevant to a specific page
const entries = getVisualBibleEntriesForPage(visualBible, pageNumber);

// Build prompt section
const vbPrompt = buildVisualBiblePrompt(visualBible, pageNumber, sceneCharacterNames);
// Returns: Main characters + Recurring elements with "MUST MATCH EXACTLY"
```

### Secondary Character Consistency

**Problem:** Secondary characters (fireman, teacher, pets) have no reference photos and can look different between scenes.

**Solution (Implemented):**
1. **Character Bible** - Outline generates detailed descriptions for all characters
2. **Extract & Describe** - After generating first scene with new character, AI analyzes and extracts appearance
3. **Consistent Prompts** - Extracted descriptions included in all future prompts

---

## 5. Scene Descriptions

### Normal Mode (Art Director Prompt)

**Template:** `prompts/scene-descriptions.txt`

**Output Format:**
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

### Storybook Mode (Inline Scenes)

**Template:** `prompts/storybook-combined.txt`

**Output Format (simpler):**
```
SCENE:
Setting: [Location, atmosphere]
Characters: [Who is present]
Action: [What's happening]
Clothing: [winter/summer/formal/standard]
Mood: [Emotional tone]
```

### Clothing Category Flow

```
1. SCENE DESCRIPTION includes clothing category
   └── "**Clothing:** winter" or "Clothing: winter"

2. SERVER PARSES CATEGORY
   ├── Function: parseClothingCategory(sceneDescription)
   ├── Regex: /Clothing.*?(winter|summer|formal|standard)/i
   └── Returns: "winter" | "summer" | "formal" | "standard"

3. AVATAR SELECTION
   ├── Function: getCharacterPhotoDetails(chars, category)
   └── For each character:
       ├── IF clothingAvatars[category] exists → use it
       ├── ELSE IF bodyNoBgUrl exists → use it
       └── ELSE use photoUrl (face only)

4. REFERENCE PHOTOS PASSED TO IMAGE API
   └── Array of { name, photoUrl, photoType, clothingCategory }
```

---

## 6. Image Generation

### Parallel vs Sequential Mode

```
┌─────────────────────────────────────────────────────────────┐
│                     PARALLEL MODE                            │
├─────────────────────────────────────────────────────────────┤
│  Page 1 ─────┐                                              │
│  Page 2 ─────┼──→ [All generate simultaneously] ──→ Done    │
│  Page 3 ─────┤                                              │
│  Page 4 ─────┘                                              │
│                                                              │
│  Pros: Fast (all in parallel)                               │
│  Cons: No cross-page visual consistency                     │
│  Template: image-generation.txt                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    SEQUENTIAL MODE                           │
├─────────────────────────────────────────────────────────────┤
│  Page 1 ──→ [Generate] ──→ Image 1                          │
│                              │ (passed as reference)        │
│  Page 2 ──→ [Generate] ──→ Image 2                          │
│                              │ (passed as reference)        │
│  Page 3 ──→ [Generate] ──→ Image 3                          │
│                                                              │
│  Pros: Better visual continuity                             │
│  Cons: Slower (must wait for each)                          │
│  Template: image-generation-sequential.txt                  │
└─────────────────────────────────────────────────────────────┘
```

### Image Prompt Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    IMAGE PROMPT STRUCTURE                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  SECTION 1: CHARACTER REFERENCE PHOTOS                       │
│  ───────────────────────────────────────                    │
│  **CHARACTER REFERENCE PHOTOS (in order):**                 │
│  1. Emma, 8 years old, girl/woman                           │
│  2. Max, 10 years old, boy/man                              │
│  Match each character to their corresponding reference.     │
│                                                              │
│  SECTION 2: STYLE & SAFETY INSTRUCTIONS                      │
│  ───────────────────────────────────────                    │
│  [From template: image-generation.txt]                      │
│  - Art style description                                    │
│  - Style transformation rules                               │
│  - Safety/age-appropriate content rules                     │
│                                                              │
│  SECTION 3: SCENE DESCRIPTION                                │
│  ───────────────────────────────────────                    │
│  **SCENE:** [Full scene description from Art Director]      │
│                                                              │
│  SECTION 4: VISUAL BIBLE (appended at end)                   │
│  ───────────────────────────────────────                    │
│  **MAIN CHARACTERS - Must match reference photos:**         │
│  **Emma:** Face: Round face, blue eyes...                   │
│                                                              │
│  **RECURRING ELEMENTS - MUST MATCH EXACTLY:**               │
│  **Fluffy (dog)**: Golden retriever, fluffy fur...          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Reference Photo Labeling

```javascript
// In callGeminiAPIForImage:
characterPhotos.forEach((photoData) => {
  // Add text label BEFORE the image
  parts.push({ text: `[Reference photo of ${photoData.name}]:` });
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

## 7. Physical Features & Clothing

### Physical Features in Prompts

| Feature | Source Field | Example |
|---------|--------------|---------|
| **Build** | `physical.build` | "athletic", "slim" |
| **Eye Color** | `physical.eyeColor` | "brown", "blue" |
| **Hair Color** | `physical.hairColor` | "dark blonde" |
| **Hair Style** | `physical.hairStyle` | "ponytail", "braids" |
| **Hair Length** | `physical.hairLength` | "shoulder-length" |
| **Bangs** | `detailedHairAnalysis.bangsEndAt` | "to eyebrows" |
| **Facial Hair** | `physical.facialHair` | Males only |
| **Other** | `physical.other` | "glasses", "birthmark" |

### Hair Description Logic

```
Output: "dark blonde, ponytail, shoulder-length, bangs to eyebrows"

Priority order:
1. hairColor (always first)
2. User-edited hairStyle > detailedHairAnalysis.type > extracted hairStyle
3. hairLength
4. Bangs from detailed analysis
5. Direction (if specific)
```

### Clothing Categories

| Category | Source | Example |
|----------|--------|---------|
| `standard` | `avatars.standard` + `avatars.clothing.standard` | Everyday clothes |
| `winter` | `avatars.winter` + `avatars.clothing.winter` | Winter jacket, boots |
| `summer` | `avatars.summer` + `avatars.clothing.summer` | T-shirt, shorts |
| `costumed:pirate` | `avatars.costumed.pirate` + clothing | Full pirate outfit |
| `costumed:knight` | `avatars.costumed.knight` + clothing | Knight armor |

### Per-Character Clothing

Each character in a scene can have a different clothing category:

```javascript
// Scene hint format:
// Characters:
// - Roger: summer
// - Sophie: costumed:pirate

// Result: Each character gets their own avatar and clothing description
// Roger: summer avatar + "yellow t-shirt, khaki shorts"
// Sophie: pirate costume avatar + "striped shirt, brown pants, red bandana"
```

### Example Character Reference Output

```
**CHARACTER REFERENCE PHOTOS (in order):**
1. Roger, Looks: adult, 45 years old, man, Build: athletic. Eyes: brown.
   Hair: dark blonde, ponytail, shoulder-length. Facial hair: clean-shaven.
   Wearing: brown leather vest, white puffy shirt, black pants, red sash
2. Sophie, Looks: young-school-age, 7 years old, girl, Build: slim.
   Eyes: blue. Hair: blonde, wavy, long.
   Wearing: striped blue/white pirate shirt, brown pants, red bandana

HEIGHT ORDER: Sophie (shortest) -> Roger (much taller)
```

---

## 8. Page Architecture

### Page Count vs Scene Count

| Book Type | Language Level | Print Pages | Scene Count | Images |
|-----------|---------------|-------------|-------------|--------|
| **Bilderbuch** | 1st-grade | 10 | 10 | 10 |
| **Kinderbuch** | standard | 10 | 5 | 5 |
| **Jugendbuch** | advanced | 10 | 5 | 5 |

### Language Levels

| Level | German Name | Words/Page | Layout |
|-------|-------------|------------|--------|
| `1st-grade` | Bilderbuch | 20-35 | Image + text on same page |
| `standard` | Kinderbuch | 120-150 | Text page + facing image |
| `advanced` | Jugendbuch | 250-300 | Text page + facing image |

### Scene Count Calculation

```javascript
const printPages = inputData.pages;
const isPictureBookLayout = inputData.languageLevel === '1st-grade';
const sceneCount = isPictureBookLayout ? printPages : Math.floor(printPages / 2);
```

### Credit Costs

| Action | Credits |
|--------|---------|
| Story creation | pages × 10 |
| Image regeneration | 5 per image |
| Cover regeneration | 5 per cover |

### Credit Flow

```
1. User selects pages (e.g., 10 pages Kinderbuch)
   └─ Credits needed: 10 * 10 = 100 credits

2. Job creation (POST /api/jobs/create-story)
   └─ Credits RESERVED from user balance atomically

3. Story generation
   └─ If FAILS: Full refund of credits_reserved
   └─ If SUCCESS: credits_reserved zeroed, transaction logged

4. Image regeneration (optional)
   └─ Each regeneration: 5 credits deducted immediately
```

---

## 9. Regeneration & Editing

### Available Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stories/:id/regenerate/scene-description/:pageNum` | POST | Regenerate scene description |
| `/api/stories/:id/regenerate/image/:pageNum` | POST | Regenerate page image |
| `/api/stories/:id/regenerate/cover/:coverType` | POST | Regenerate cover |
| `/api/stories/:id/edit/image/:pageNum` | POST | Edit image with custom prompt |
| `/api/stories/:id/edit/cover/:coverType` | POST | Edit cover with custom prompt |
| `PATCH /api/stories/:id/page/:pageNum` | PATCH | Edit page text or scene description |

### Developer Mode Features

When enabled, admins can:
- Regenerate images directly from outline view
- Edit images with custom prompts
- Skip payment for print orders
- Access detailed prompts and quality scores

---

## 10. Quality Evaluation

### Evaluation Process

```javascript
// Scene images evaluated by Gemini for:
// - Character accuracy (faces match reference photos)
// - Scene matching (elements match description)
// - Art style consistency

// Cover images additionally checked for:
// - Text accuracy (title spelling)
// - Text errors force score to 0
```

### Configuration

| Setting | Value |
|---------|-------|
| Quality threshold | 50% (configurable) |
| Scene retry attempts | 2 |
| Cover retry attempts | 3 |

### Auto-Repair

If quality evaluation identifies specific issues:
1. **Fix targets** identified (character faces, missing elements)
2. **Inpainting** applied to specific regions
3. **Re-evaluation** after repair

---

## 11. Cover Generation

### Cover Types

| Type | Template | Description |
|------|----------|-------------|
| Front Cover | `prompts/front-cover.txt` | Main character centered, title |
| Back Cover | `prompts/back-cover.txt` | Group scene, all characters |
| Initial Page | `prompts/initial-page-with-dedication.txt` | Group intro |

### Cover-Specific Quality

Covers have additional text accuracy check:
- Title must be spelled correctly
- Text errors force quality score to 0
- More retries allowed (3 vs 2)

---

## 12. Prompt Templates

All prompts located in `/prompts/` folder:

| File | Purpose |
|------|---------|
| `outline.txt` | Generate story outline with Visual Bible |
| `story-unified.txt` | Unified story generation |
| `story-text-batch.txt` | Generate story text in batches |
| `scene-descriptions.txt` | Art Director - detailed visual scenes |
| `image-generation.txt` | Image prompt (parallel mode) |
| `image-generation-sequential.txt` | Image prompt (sequential mode) |
| `image-generation-storybook.txt` | Image prompt for picture books |
| `front-cover.txt` | Front cover image |
| `back-cover.txt` | Back cover image |
| `initial-page-with-dedication.txt` | Initial page with dedication |
| `image-evaluation.txt` | Quality evaluation for scenes |
| `cover-image-evaluation.txt` | Quality evaluation for covers |
| `avatar-main-prompt.txt` | Gemini avatar generation |
| `avatar-ace-prompt.txt` | Runware ACE++ avatars |
| `style-analysis.txt` | Extract style DNA from photos |
| `character-analysis.txt` | Initial photo analysis |

---

## Key Code Locations

| Function | File | Purpose |
|----------|------|---------|
| `processStoryJob()` | server.js | Main job processor |
| `processUnifiedStoryJob()` | server.js | Unified mode handler |
| `buildImagePrompt()` | server/lib/storyHelpers.js | Build image prompts |
| `buildCharacterReferenceList()` | server/lib/storyHelpers.js | Character descriptions |
| `buildHairDescription()` | server/lib/storyHelpers.js | Hair description logic |
| `getCharacterPhotoDetails()` | server/lib/storyHelpers.js | Avatar selection |
| `parseVisualBible()` | server/lib/visualBible.js | Parse Visual Bible |
| `evaluateImageQuality()` | server/lib/images.js | Quality evaluation |
| `generatePrintPdf()` | server/lib/pdf.js | PDF generation |
