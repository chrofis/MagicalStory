# MagicalStory Character System

**Last Updated:** January 2025

## Table of Contents

1. [Overview](#1-overview)
2. [Character Data Structure](#2-character-data-structure)
3. [Photo Analysis](#3-photo-analysis)
4. [Avatar Generation](#4-avatar-generation)
5. [Trait Handling & Source Tracking](#5-trait-handling--source-tracking)
6. [Clothing System](#6-clothing-system)
7. [Character Consistency](#7-character-consistency)
8. [Code Locations](#8-code-locations)

---

## 1. Overview

The character system manages:
- Photo upload and analysis
- Physical trait extraction and editing
- Avatar generation (seasonal + costumed)
- Trait source tracking (user vs AI-extracted)
- Clothing category selection for scenes

### Character Flow

```
Photo Upload → Analysis → Trait Extraction → Avatar Generation → Story Usage
     │             │            │                  │                │
     ▼             ▼            ▼                  ▼                ▼
  Face crop    Physical     Suggest to       4 seasonal      Reference in
  Body crop    features     user form         avatars         prompts
  No-bg crop   Style DNA                   + costumes
```

---

## 2. Character Data Structure

### Complete Character Object

```typescript
interface Character {
  // Identity
  id: number;
  name: string;
  age: number;
  gender: "male" | "female" | "other";
  ageCategory: string;      // Auto-calculated: "toddler", "young-school-age", etc.
  apparentAge: number;      // How old they LOOK in avatar

  // Photos
  photoUrl: string;         // Original face photo (base64)
  bodyPhotoUrl: string;     // Full body photo
  bodyNoBgUrl: string;      // Body with transparent background

  // Physical Traits
  physical: {
    height: string;
    build: string;
    eyeColor: string;
    eyeColorHex: string;
    hairColor: string;
    hairColorHex: string;
    hairLength: string;
    hairStyle: string;
    face: string;
    skinTone: string;
    skinToneHex: string;
    facialHair: string;     // Males only
    other: string;          // Glasses, birthmarks
    detailedHairAnalysis: {
      type: string;         // wavy, curly, straight
      bangsEndAt: string;
      direction: string;
      lengthTop: string;
      lengthSides: string;
    };
  };

  // Source Tracking
  physicalTraitsSource: {
    build: 'user' | 'extracted' | 'photo';
    eyeColor: 'user' | 'extracted' | 'photo';
    hairColor: 'user' | 'extracted' | 'photo';
    hairStyle: 'user' | 'extracted' | 'photo';
    hairLength: 'user' | 'extracted' | 'photo';
    face: 'user' | 'extracted' | 'photo';
    skinTone: 'user' | 'extracted' | 'photo';
    facialHair: 'user' | 'extracted' | 'photo';
    other: 'user' | 'extracted' | 'photo';
    apparentAge: 'user' | 'extracted' | 'photo';
  };

  // Avatars
  avatars: {
    standard: string;       // Base64 image
    winter: string;
    summer: string;
    formal: string;
    costumed: {
      [costumeType: string]: {
        imageData: string;
        clothing: string;
      };
    };
    clothing: {
      standard: string;     // Clothing description
      winter: string;
      summer: string;
      costumed: {
        [costumeType: string]: string;
      };
    };
  };

  // Styled Avatars (per art style)
  styledAvatars: {
    [artStyle: string]: {
      standard: string;
      winter: string;
      summer: string;
      costumed: {
        [costumeType: string]: {
          imageData: string;
          clothing: string;
        };
      };
    };
  };

  // Style Analysis (from photo)
  styleAnalysis: {
    physical: {
      face: string;
      hair: string;
      build: string;
    };
    styleDNA: {
      signatureColors: string[];
      signaturePatterns: string[];
      signatureDetails: string[];
    };
  };

  // Personality
  strengths: string[];
  flaws: string[];
  challenges: string;
  specialDetails: string;
  clothingStyle: string;    // Fallback clothing description
}
```

---

## 3. Photo Analysis

### Endpoint: `POST /api/characters/analyze`

When a photo is uploaded, the server extracts:

```javascript
{
  faceThumbnail: "base64...",     // Cropped face
  bodyCrop: "base64...",          // Full body crop
  bodyNoBg: "base64...",          // Transparent background

  attributes: {
    gender: "male" | "female",
    age: 8,
    height: "average",
    build: "slim"
  },

  styleAnalysis: {
    physical: {
      face: "Round face, brown eyes, light skin tone, small nose",
      hair: "Medium brown, short, slightly messy, straight texture",
      build: "Slim build, appears to be around 9 years old"
    }
  }
}
```

### Style Analysis (prompts/style-analysis.txt)

Extracts detailed clothing/outfit info for Visual Bible:

```javascript
styleAnalysis: {
  physical: { face, hair, build },
  referenceOutfit: {
    garmentType: "casual hoodie and jeans",
    primaryColor: "blue",
    secondaryColors: ["gray", "white"],
    pattern: "solid",
    fabric: "cotton blend"
  },
  styleDNA: {
    signatureColors: ["blue", "gray"],
    signaturePatterns: ["solid"],
    signatureDetails: ["hood", "drawstrings"]
  }
}
```

---

## 4. Avatar Generation

### Generation Flow

```
1. Character with photo + traits created
2. Avatar generation triggered (POST /api/avatars/generate)
3. Generates 2x2 character sheet with 4 views
4. Avatar evaluation extracts traits from generated image
5. Traits merged back (respecting source tracking)
6. Seasonal avatars generated (winter, summer, standard)
7. Costume avatars generated if story requires
```

### Avatar Providers

| Provider | Model | Cost | Use Case |
|----------|-------|------|----------|
| Gemini | 2.5 Flash Image | ~$0.03/img | Default, best prompt following |
| Runware ACE++ | FLUX Fill | ~$0.005/img | Dev mode, face-reference |

### Prompt Templates

| File | Purpose |
|------|---------|
| `avatar-main-prompt.txt` | Gemini avatar generation (4500+ chars) |
| `avatar-ace-prompt.txt` | Runware ACE++ avatars (2900 char limit) |
| `avatar-evaluation.txt` | Extract traits from generated avatar |

### Avatar Evaluation

After generation, Gemini analyzes the avatar to extract:

```javascript
{
  apparentAge: 8,
  build: "slim",
  eyeColor: "brown",
  hairColor: "dark blonde",
  hairStyle: "ponytail",
  hairLength: "shoulder-length",
  facialHair: "none",        // Males only
  skinTone: "fair",
  detailedHairAnalysis: {
    type: "wavy",
    bangsEndAt: "to eyebrows",
    direction: "part left"
  }
}
```

---

## 5. Trait Handling & Source Tracking

### Trait Categories

#### 1. User-Only Traits (Never Extracted by AI)

| Trait | Location | Notes |
|-------|----------|-------|
| `name` | `character.name` | User input only |
| `age` | `character.age` | User input only |
| `gender` | `character.gender` | User input only |
| `height` | `character.physical.height` | Optional user input |

#### 2. Always-Overwritten Traits

| Trait | Location | Notes |
|-------|----------|-------|
| `detailedHairAnalysis` | `character.physical.detailedHairAnalysis` | Always from latest avatar |

#### 3. Source-Tracked Traits

These traits respect user edits:

| Trait | Location |
|-------|----------|
| `apparentAge` | `character.apparentAge` |
| `build` | `character.physical.build` |
| `eyeColor` | `character.physical.eyeColor` |
| `hairColor` | `character.physical.hairColor` |
| `hairLength` | `character.physical.hairLength` |
| `hairStyle` | `character.physical.hairStyle` |
| `face` | `character.physical.face` |
| `skinTone` | `character.physical.skinTone` |
| `facialHair` | `character.physical.facialHair` |
| `other` | `character.physical.other` |

### Source Tracking Logic

```
On Avatar Generation/Regeneration:

1. User-edited traits (source === 'user'):
   → PRESERVED - value NOT overwritten
   → Source remains 'user'

2. Non-user traits (source !== 'user'):
   → OVERWRITTEN with extracted value
   → Source set to 'extracted'

3. Always-overwritten traits:
   → ALWAYS replaced with latest extraction

4. User-only traits (age, gender, height):
   → NEVER touched by AI
```

### Hex Color Variants

Several traits have both text and hex values:

| Text Trait | Hex Trait | Notes |
|------------|-----------|-------|
| `eyeColor` | `eyeColorHex` | Shared source tracking |
| `hairColor` | `hairColorHex` | Shared source tracking |
| `skinTone` | `skinToneHex` | Shared source tracking |

Both updated together based on text trait's source.

### User Edit Flow

When user edits a physical trait in CharacterForm:
1. Value is updated
2. Source is set to `'user'`
3. This trait preserved on future regenerations

---

## 6. Clothing System

### Clothing Categories

| Category | Description | Avatar Used |
|----------|-------------|-------------|
| `standard` | Everyday casual | `avatars.standard` |
| `winter` | Cold weather | `avatars.winter` |
| `summer` | Warm weather | `avatars.summer` |
| `formal` | Dress clothes | `avatars.formal` |
| `costumed:pirate` | Pirate outfit | `avatars.costumed.pirate` |
| `costumed:knight` | Knight outfit | `avatars.costumed.knight` |

### Clothing Data Structure

```typescript
avatars: {
  // Seasonal avatars (images)
  standard: "base64...",
  winter: "base64...",
  summer: "base64...",

  // Costumed avatars
  costumed: {
    pirate: {
      imageData: "base64...",
      clothing: "striped vest, brown pants, red bandana"
    },
    knight: {
      imageData: "base64...",
      clothing: "silver armor, blue cape, leather boots"
    }
  },

  // Clothing descriptions per category
  clothing: {
    standard: "blue t-shirt, jeans",
    winter: "red parka, dark jeans, snow boots",
    summer: "yellow sundress, sandals",
    costumed: {
      pirate: "striped vest, brown pants, red bandana",
      knight: "silver armor, blue cape"
    }
  }
}
```

### Clothing Selection Flow

```
Scene Description → Parse Clothing Category → Select Avatar → Build Prompt

1. Scene specifies: "Clothing: winter"
2. parseClothingCategory() extracts "winter"
3. getCharacterPhotoDetails() returns:
   - Photo: avatars.winter (or fallback)
   - Clothing: avatars.clothing.winter
4. Prompt includes: "Wearing: red parka, dark jeans, snow boots"
```

### Per-Character Clothing

Different characters can wear different outfits in same scene:

```
Scene hint:
Characters:
- Roger: summer
- Sophie: costumed:pirate

Result in prompt:
Roger: summer avatar + "yellow t-shirt, khaki shorts"
Sophie: pirate avatar + "striped shirt, brown pants, red bandana"
```

### Visual Bible Clothing Items

Visual Bible clothing entries (CLO001, etc.) are **accessories and special items** - NOT main outfits:

| Purpose | Examples |
|---------|----------|
| Special items | Capes, masks, hats, magic wands |
| Context-dependent | May be worn, held, or lying on surface |
| Scene-determined | How item appears depends on scene description |

**Why VB clothing is NOT merged into character "Wearing:"**
1. Avatars cannot have masks/helmets - faces must stay visible
2. Scene context matters - item might be held, found, or worn
3. The `wornBy` field indicates ownership, not always-wearing

---

## 7. Character Consistency

### Main Characters

Main characters have strong consistency through:
- Reference photos passed to every image generation
- Physical descriptions included in every prompt
- Style DNA (signature colors, patterns)
- Visual Bible entries

### Secondary Characters

Secondary characters (introduced by AI) use:
- Character Bible generated during outline
- Extracted descriptions after first appearance
- Visual Bible entries with page appearances

### Hair Description Building

```javascript
buildHairDescription(character):
  Output: "dark blonde, ponytail, shoulder-length, bangs to eyebrows"

  Priority order:
  1. hairColor (always first)
  2. User-edited hairStyle > detailedHairAnalysis.type > extracted hairStyle
  3. hairLength (or detailed analysis)
  4. Bangs from detailed analysis
  5. Direction (if specific)
```

### Physical Description in Prompts

```
**CHARACTER REFERENCE PHOTOS (in order):**
1. Roger, Looks: adult, 45 years old, man, Build: athletic. Eyes: brown.
   Hair: dark blonde, ponytail, shoulder-length. Facial hair: clean-shaven.
   Wearing: blue winter jacket, dark jeans
2. Sophie, Looks: young-school-age, 7 years old, girl, Build: slim.
   Eyes: blue. Hair: blonde, wavy, long.
   Wearing: pink sweater, purple leggings

HEIGHT ORDER: Sophie (shortest) -> Roger (much taller)
```

### Filtering Rules

- **"none" values**: Filtered out for `other` and `facialHair`
- **User edits**: `hairStyle` respects user-edited values over AI-extracted
- **Males only**: `facialHair` only included for `gender === 'male'`

---

## 8. Code Locations

### Frontend

| File | Purpose |
|------|---------|
| `client/src/types/character.ts` | Type definitions |
| `client/src/services/characterService.ts` | API calls, trait extraction |
| `client/src/pages/StoryWizard.tsx` | Trait merging on avatar generation |
| `client/src/components/character/CharacterForm.tsx` | User edit handling |

### Backend

| File | Purpose |
|------|---------|
| `server/routes/avatars.js` | Avatar generation endpoints |
| `server/routes/characters.js` | Character CRUD |
| `server/lib/storyHelpers.js` | Physical description building |
| `server/lib/visualBible.js` | Visual Bible management |

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `buildHairDescription()` | storyHelpers.js:~50 | Build hair description |
| `buildCharacterPhysicalDescription()` | storyHelpers.js:~942 | Full physical description |
| `buildCharacterReferenceList()` | storyHelpers.js:~1060 | Character list for prompts |
| `getCharacterPhotoDetails()` | storyHelpers.js:~720 | Select avatar by clothing |
| `mergeTraitsWithSourceTracking()` | StoryWizard.tsx:~1816 | Merge extracted traits |

### Prompt Templates

| File | Purpose |
|------|---------|
| `prompts/avatar-main-prompt.txt` | Gemini avatar generation |
| `prompts/avatar-ace-prompt.txt` | ACE++ avatar generation |
| `prompts/avatar-evaluation.txt` | Extract traits from avatar |
| `prompts/character-analysis.txt` | Initial photo analysis |
| `prompts/style-analysis.txt` | Style DNA extraction |
