# Character Creation & Modification System - Requirements Document

This document specifies all requirements for implementing the character creation, modification, photo upload, and avatar generation system. A developer following this document should be able to implement a functionally equivalent system.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Character Data Model](#2-character-data-model)
3. [Photo Upload & Analysis](#3-photo-upload--analysis)
4. [Physical Traits](#4-physical-traits)
5. [Psychological Traits](#5-psychological-traits)
6. [Clothing System](#6-clothing-system)
7. [Avatar Generation](#7-avatar-generation)
8. [Character Save/Load](#8-character-saveload)
9. [Frontend UI Requirements](#9-frontend-ui-requirements)
10. [Database Schema](#10-database-schema)
11. [API Endpoints](#11-api-endpoints)
12. [Error Handling](#12-error-handling)
13. [Race Condition Prevention](#13-race-condition-prevention)
14. [Performance Requirements](#14-performance-requirements)

---

## 1. Overview

### 1.1 Purpose
The character system allows users to create characters for personalized story generation. Characters can be:
- Created from uploaded photos (face detected, traits extracted)
- Created manually without photos
- Modified after creation (with restrictions on certain fields)

### 1.2 Key Principles
1. **Photo Analysis is Authoritative**: Traits extracted from photos take precedence
2. **Backend Owns Avatars**: Frontend NEVER writes avatar data; backend manages exclusively
3. **Preserve Over Overwrite**: On save, preserve existing DB data that frontend doesn't have
4. **Trait Source Tracking**: Track where each trait value came from (`'photo'` or `'user'`)

---

## 2. Character Data Model

### 2.1 Core Character Interface

```typescript
interface Character {
  // Identity
  id: number;                    // Unique identifier (timestamp-based)
  name: string;                  // Required, user-editable
  gender: 'male' | 'female' | 'other';
  age: string;                   // Age as string (e.g., "7", "42")
  ageCategory?: AgeCategory;     // Auto-computed from age for image generation

  // Physical traits (nested object)
  physical?: PhysicalTraits;
  physicalTraitsSource?: PhysicalTraitsSource;

  // Psychological traits (nested object)
  traits: PsychologicalTraits;

  // Photos
  photos?: CharacterPhotos;

  // Avatars - READ ONLY FROM FRONTEND
  avatars?: CharacterAvatars;

  // Clothing (what they're wearing in reference photo)
  clothing?: CharacterClothing;
  clothingSource?: ClothingSource;

  // Generated outfits per page (during story generation)
  generatedOutfits?: Record<number, GeneratedOutfit>;
}
```

### 2.2 Physical Traits

```typescript
interface PhysicalTraits {
  height?: string;              // Height description
  build?: string;               // Body type (e.g., "slim", "athletic")
  face?: string;                // Face shape description
  eyeColor?: string;            // Eye color (e.g., "blue", "brown", "green")
  eyeColorHex?: string;         // Hex color code (e.g., "#6B4423")
  hairColor?: string;           // Hair color (e.g., "blonde", "brown", "black")
  hairColorHex?: string;        // Hex color code (e.g., "#3B2314")
  hairLength?: string;          // Hair length (e.g., "shoulder-length", "chin-length", "mid-back")
  hairStyle?: string;           // Hair texture/style (e.g., "straight", "wavy", "curly ponytail")
  hair?: string;                // Legacy: combined hair description (deprecated)
  facialHair?: string;          // For males (e.g., "none", "stubble", "beard", "mustache", "goatee")
  skinTone?: string;            // Skin tone (e.g., "fair", "medium", "olive", "dark")
  skinUndertone?: string;       // Skin undertone (e.g., "warm", "cool", "neutral")
  skinToneHex?: string;         // Hex color code (e.g., "#E8BEAC")
  other?: string;               // Glasses, birthmarks, always-present accessories
  detailedHairAnalysis?: string; // Detailed hair analysis from avatar evaluation
  apparentAge?: AgeCategory;    // How old they look in photo (from analysis or user override)
}

// Source tracking for each physical trait
type TraitSource = 'photo' | 'extracted' | 'user';

interface PhysicalTraitsSource {
  build?: TraitSource;
  face?: TraitSource;
  eyeColor?: TraitSource;
  hairColor?: TraitSource;
  hairLength?: TraitSource;
  hairStyle?: TraitSource;
  hair?: TraitSource;          // Legacy
  facialHair?: TraitSource;
  other?: TraitSource;
  skinTone?: TraitSource;
  apparentAge?: TraitSource;
}
```

### 2.3 Psychological Traits

```typescript
interface PsychologicalTraits {
  strengths: string[];          // Positive traits (e.g., ["brave", "kind", "curious"])
  flaws: string[];              // Negative traits (e.g., ["impatient", "stubborn"])
  challenges: string[];         // Challenges they face (e.g., ["fear of heights"])
  specialDetails?: string;      // Free-form additional details
}
```

### 2.4 Clothing

```typescript
interface CharacterClothing {
  current?: string;             // Legacy: free-text description
  structured?: StructuredClothing;
}

interface StructuredClothing {
  upperBody?: string;           // T-shirt, sweater, blouse, jacket, etc.
  lowerBody?: string;           // Pants, jeans, skirt, shorts, etc.
  shoes?: string;               // Sneakers, boots, sandals, etc.
  fullBody?: string;            // Dress, gown, jumpsuit - overrides upper+lower
}

// Source tracking for clothing
interface ClothingSource {
  upperBody?: TraitSource;
  lowerBody?: TraitSource;
  shoes?: TraitSource;
  fullBody?: TraitSource;
}
```

### 2.5 Photo Data Structure

```typescript
interface CharacterPhotos {
  original?: string;            // Uploaded photo URL
  face?: string;                // Cropped face thumbnail URL
  body?: string;                // Cropped body URL
  bodyNoBg?: string;            // Body with background removed
  faceBox?: BoundingBox;        // Face detection coordinates
  bodyBox?: BoundingBox;        // Body detection coordinates
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// For multi-face selection UI
interface DetectedFace {
  id: number;
  confidence: number;
  faceBox: BoundingBox;
  thumbnail: string;            // Base64 200x200 image
}
```

### 2.6 Avatar Data Structure

```typescript
type ClothingCategory = 'winter' | 'standard' | 'summer' | 'formal';

interface CharacterAvatars {
  // Generated avatar images per clothing category (base64 or URLs)
  winter?: string;
  standard?: string;
  summer?: string;
  formal?: string;

  // Face thumbnails for quick display in lists
  faceThumbnails?: Record<ClothingCategory, string>;

  // Metadata
  hasFullAvatars?: boolean;      // Flag indicating full avatars exist
  generatedAt?: string;
  status?: 'pending' | 'generating' | 'complete' | 'failed';
  stale?: boolean;               // True when avatars were generated from previous photo

  // Extracted clothing descriptions per avatar
  clothing?: Record<ClothingCategory, string>;

  // Dev mode only fields
  faceMatch?: Record<ClothingCategory, FaceMatchResult>;
  prompts?: Record<ClothingCategory, string>;
  styledAvatars?: Record<string, StyledAvatarSet>;
  costumed?: Record<string, CostumedAvatarData>;
}
```

### 2.7 Age Categories

```typescript
type AgeCategory =
  | 'infant' | 'toddler' | 'preschooler' | 'kindergartner'
  | 'young-school-age' | 'school-age' | 'preteen' | 'young-teen'
  | 'teenager' | 'young-adult' | 'adult' | 'middle-aged' | 'senior' | 'elderly';
```

---

## 3. Photo Upload & Analysis

### 3.1 Upload Flow

```
User selects photo
    ↓
Frontend sends to /api/avatars/analyze-photo
    ↓
Backend processes:
  1. Face detection (find all faces)
  2. If multiple faces → return all for selection
  3. If single face → auto-select
  4. Crop face region
  5. Crop body region (from face down)
  6. Remove background from body
  7. Extract physical traits from face
    ↓
Return to frontend:
  - photos object (all URLs)
  - extracted traits
  - all detected faces (if multiple)
    ↓
Frontend updates character state
    ↓
Avatar generation triggered (async)
```

### 3.2 Face Detection Requirements

- **Minimum face size**: 50x50 pixels
- **Confidence threshold**: 0.7 (70%)
- **Multiple faces**: Return all faces with bounds, let user select
- **No face detected**: Return error, allow manual trait entry

### 3.3 Photo Processing Requirements

| Output | Description | Format |
|--------|-------------|--------|
| `photos.original` | Original uploaded image | URL (stored in cloud) |
| `photos.face` | Cropped face (square) | URL |
| `photos.body` | Full body from face down | URL |
| `photos.bodyNoBg` | Body with background removed | URL |
| `photos.thumbnail` | Small preview | Base64 (max 100KB) |

### 3.4 Photo Analysis Output

The analyze-photo endpoint returns:
- `faceThumbnail` - Cropped face image (base64)
- `bodyCrop` - Body cropped from face down (base64)
- `bodyNoBg` - Body with background removed (base64)
- `faceBox` - Bounding box coordinates for face
- `bodyBox` - Bounding box coordinates for body
- `characterId` - ID of created/updated character

**Note**: Physical traits (eyeColor, hairColor, skinTone, etc.) are NOT extracted during photo analysis. They are extracted later during avatar evaluation.

### 3.5 Physical Trait Extraction (During Avatar Evaluation)

Physical traits are extracted when avatars are generated and evaluated. Extracted into `physical` object:
- `eyeColor` + `eyeColorHex` - Eye color with hex code
- `hairColor` + `hairColorHex` - Hair color with hex code
- `hairLength` - Length description (e.g., "shoulder-length")
- `hairStyle` - Texture/style (e.g., "straight", "wavy")
- `skinTone` + `skinToneHex` - Skin tone with hex code
- `facialHair` - For males (e.g., "none", "beard")
- `build` - Body type
- `apparentAge` - How old they look (mapped to AgeCategory)
- `detailedHairAnalysis` - Comprehensive hair description

### 3.6 Photo Re-upload Behavior

**CRITICAL**: When user uploads a new photo for existing character:
1. DO NOT erase existing avatar images immediately
2. Set `avatars.stale = true` and `avatars.status = 'pending'`
3. Preserve existing avatar images until new ones are generated
4. Replace old avatars only when new generation completes

```javascript
// CORRECT implementation:
if (character.avatars) {
  character.avatars.stale = true;
  character.avatars.status = 'pending';
} else {
  character.avatars = { status: 'pending', stale: true };
}
// WRONG - destroys existing avatars:
// character.avatars = { status: 'pending', stale: true };
```

---

## 4. Physical Traits

Physical traits are stored in the nested `physical` object on the character.

### 4.1 Identity Fields (Top-Level)

| Field | Type | Editable | Notes |
|-------|------|----------|-------|
| `name` | string | Always | Required |
| `gender` | 'male' \| 'female' \| 'other' | Always | Required |
| `age` | string | Always | Age as string (e.g., "7") |
| `ageCategory` | AgeCategory | Auto-computed | Derived from age for image generation |

### 4.2 Physical Traits (Nested in `physical`)

| Field | Type | Editable | Source |
|-------|------|----------|--------|
| `height` | string | Always | User only (in cm, e.g., "120") |
| `build` | string | Always | User or photo |
| `eyeColor` | string | Always | Photo or user |
| `eyeColorHex` | string | From photo | Auto-extracted |
| `hairColor` | string | Always | Photo or user |
| `hairColorHex` | string | From photo | Auto-extracted |
| `hairLength` | string | Always | Photo or user |
| `hairStyle` | string | Always | Photo or user |
| `facialHair` | string | Always | Photo or user (males only) |
| `skinTone` | string | Always | Photo or user |
| `skinToneHex` | string | From photo | Auto-extracted |
| `other` | string | Always | Birthmarks, accessories |
| `apparentAge` | AgeCategory | Always | From photo or user override |

### 4.3 Trait Source Tracking

Each physical trait tracks its source via `physicalTraitsSource`:

```typescript
physicalTraitsSource: {
  eyeColor: 'photo',      // Extracted from photo
  hairColor: 'user',      // User changed it
  skinTone: 'photo',      // Extracted from photo
  build: 'user',          // User entered
}
```

**Rule**: Only `'user'` source traits are sent to AI generation to avoid reinforcing extraction errors.

### 4.4 Editability Rules

1. **All traits are technically editable** - user can override photo-extracted values
2. **Source tracking matters for generation** - only user-entered values influence AI
3. **UI hint**: Show photo icon on extracted traits to indicate source

---

## 5. Psychological Traits

Psychological traits are stored in the `traits` object (required).

### 5.1 Structure

```typescript
interface PsychologicalTraits {
  strengths: string[];    // Positive traits
  flaws: string[];        // Negative traits
  challenges: string[];   // Challenges they face
  specialDetails?: string; // Free-form additional info
}
```

### 5.2 Strengths (Predefined Options)

Select from list (English):
- Cheerful, Kind, Caring, Funny, Forgiving, Protective, Loyal, Generous
- Fair-minded, Honest, Confident, Brave, Trustworthy, Determined, Hardworking
- Leader, Patient, Curious, Imaginative, Smart, Creative, Observant
- Resourceful, Energetic, Fast, Strong, Adventurous

### 5.3 Flaws (Predefined Options)

Select from list (English):
- Impatient, Distracted, Talkative, Whiny, Messy, Forgetful, Tattletale
- Sore Loser, Stubborn, Lying, Bossy, Gullible, Jealous, Easily scared
- Clingy, Quick-tempered, Selfish, Sneaky, Reckless, Shy, Clumsy
- Lazy, Boastful, Indecisive, Perfectionist

### 5.4 Challenges (Predefined Options)

Select from list (English):
- Following rules, Controlling emotions, Sharing with others
- Tests and grades, Making new friends, Speaking in public
- Trying new things, Accepting and asking for help
- Dealing with change, Standing up for oneself
- Fear of the dark, Bad dreams and nightmares
- Monsters, ghosts and things under the bed
- Fear of being alone, Fear of getting lost
- Doctors, dentists and shots, Fear of heights
- Fear of spiders, Fear of loud noises

### 5.5 Editability

All psychological traits are ALWAYS editable by user. They are never extracted from photos.

---

## 6. Clothing System

Clothing is stored in the `clothing` object with structured fields.

### 6.1 Clothing Structure

```typescript
interface CharacterClothing {
  current?: string;              // Legacy: free-text description
  structured?: StructuredClothing;
}

interface StructuredClothing {
  upperBody?: string;            // T-shirt, sweater, blouse, jacket
  lowerBody?: string;            // Pants, jeans, skirt, shorts
  shoes?: string;                // Sneakers, boots, sandals
  fullBody?: string;             // Dress, gown - overrides upper+lower
}
```

### 6.2 Clothing Source Tracking

```typescript
// Uses same TraitSource type as physical traits
interface ClothingSource {
  upperBody?: TraitSource;  // 'photo' | 'extracted' | 'user'
  lowerBody?: TraitSource;
  shoes?: TraitSource;
  fullBody?: TraitSource;
}
```

### 6.3 Editability

| Source | Description | Editability |
|--------|-------------|-------------|
| `'photo'` | Extracted from uploaded photo | User can override |
| `'user'` | User manually entered | Editable |

**Rule**: Only `'user'` source clothing is sent to AI generation.

---

## 7. Avatar Generation

### 7.1 Avatar Types (ClothingCategory)

Four avatar variants can be generated for each character:
1. **standard** - Default appearance with typical clothing
2. **winter** - Winter clothing variant (coat, hat, etc.)
3. **summer** - Summer clothing variant (t-shirt, shorts, etc.)
4. **formal** - Formal/dressy clothing variant

### 7.2 Generation Flow

```
Character saved with photo
    ↓
Avatar job created (async)
    ↓
Job polls for character in DB (up to 60 seconds)
    ↓
Character found → generate avatars
    ↓
AI generates avatar variants (standard, winter, summer, formal)
    ↓
Extract face thumbnails from each
    ↓
Save to character.avatars in DB
    ↓
Update metadata column (without large images)
    ↓
Frontend polls job status → receives completion
    ↓
Frontend fetches fresh character data with avatars
```

### 7.3 Avatar Job Requirements

1. **Async Processing**: Avatar generation runs in background job
2. **Job Timeout**: 5 minutes maximum
3. **Character Lookup Retry**: Poll DB for character up to 60 seconds (30 retries × 2 sec)
4. **Job Status**: Track `pending` → `generating` → `complete` | `error`
5. **Atomic Save**: Use SQL-level merge to preserve existing data

### 7.4 Frontend Avatar Handling

**CRITICAL RULE**: Frontend NEVER sends avatars to backend.

```typescript
// When saving character, strip avatars before sending
function mapCharacterToApi(char: Character): ApiCharacter {
  const { avatars, ...charWithoutAvatars } = char;
  // avatars are NEVER sent to backend
  return charWithoutAvatars;
}
```

### 7.5 Avatar Retry Logic

Frontend must retry to get avatar data after generation:

```typescript
// Wait up to 60 seconds for avatar data
const maxAttempts = 30;
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  if (attempt > 0) {
    // Exponential backoff: 500ms → 600ms → 720ms → ... → 3000ms max
    const delay = Math.min(500 * Math.pow(1.2, attempt), 3000);
    await sleep(delay);
  }

  const character = await loadFullCharacter(characterId);
  if (character?.avatars?.standard ||
      character?.avatars?.winter ||
      character?.avatars?.summer) {
    return character; // Got avatars
  }
}
```

---

## 8. Character Save/Load

### 8.1 Save Flow (POST /api/characters)

```
Frontend prepares character data
    ↓
Strip avatars (frontend never sends avatars)
    ↓
POST to /api/characters
    ↓
Backend: BEGIN transaction
    ↓
Backend: SELECT ... FOR UPDATE (lock row)
    ↓
Backend: Merge frontend data with DB data:
  - Frontend data takes precedence for user-editable fields
  - DB data preserved for: avatars, photos, extracted traits
    ↓
Backend: Atomic UPDATE with merged data
    ↓
Backend: Update metadata column (lightweight version)
    ↓
Backend: COMMIT transaction
    ↓
Return merged character to frontend
```

### 8.2 Preserve Query

When saving, backend runs a "preserve query" to keep DB-only data:

```sql
SELECT jsonb_build_object(
  'avatars', c->'avatars',
  'photos', c->'photos',
  'photo_url', c->>'photo_url',
  'body_photo_url', c->>'body_photo_url',
  'body_no_bg_url', c->>'body_no_bg_url',
  'thumbnail_url', c->>'thumbnail_url',
  'hair_length', c->>'hair_length',
  'skin_tone', c->>'skin_tone',
  'skin_tone_hex', c->>'skin_tone_hex',
  'facial_hair', c->>'facial_hair',
  'detailed_hair_analysis', c->>'detailed_hair_analysis'
) as preserved
FROM characters,
     jsonb_array_elements(data->'characters') AS c
WHERE id = $1 AND c->>'id' = $2
```

### 8.3 Merge Logic

```javascript
function mergeCharacters(frontendChar, dbChar) {
  const merged = { ...frontendChar };

  // Always preserve from DB (frontend never has these)
  merged.avatars = dbChar.avatars;
  merged.photos = dbChar.photos || merged.photos;

  // Preserve extracted traits if frontend doesn't have them
  const preserveIfMissing = [
    'hair_length', 'skin_tone', 'skin_tone_hex',
    'facial_hair', 'detailed_hair_analysis'
  ];

  for (const field of preserveIfMissing) {
    if (dbChar[field] && !frontendChar[field]) {
      merged[field] = dbChar[field];
    }
  }

  return merged;
}
```

### 8.4 Load Flow

Two load modes:
1. **Metadata (lightweight)**: For lists, no avatar images
2. **Full data**: For editing, includes all avatar images

```
GET /api/characters         → Returns metadata (small)
GET /api/characters/:id/full → Returns full data (large)
```

---

## 9. Frontend UI Requirements

### 9.1 Character Form

#### 9.1.1 Photo Section
- Upload button with drag-and-drop support
- Preview of uploaded photo
- Face selection UI (if multiple faces detected)
- "Analyzing..." indicator during processing
- Error display if face detection fails

#### 9.1.2 Basic Info Section
- Name input (required)
- Gender selector (male/female/other)
- Age input (string)

#### 9.1.3 Physical Traits Section
- Form fields for all traits in Section 4
- Lock icons on photo-extracted traits
- Tooltips explaining why fields are locked
- Dropdowns for enum values, text inputs for strings

#### 9.1.4 Psychological Traits Section
- Strengths: Multi-select chips from predefined list
- Flaws: Multi-select chips from predefined list
- Challenges: Multi-select chips from predefined list
- Special Details: Optional free-form text area

#### 9.1.5 Clothing Section
- Display extracted/generated clothing
- "Source" indicator (photo/avatar/user)
- Edit button (disabled for photo/avatar sources)

#### 9.1.6 Avatar Section
- Display generated avatars (standard, winter, summer, formal)
- "Generating..." indicator with spinner
- Regenerate button
- Error display if generation failed

### 9.2 State Management

```typescript
// Local state for character being edited
const [character, setCharacter] = useState<Character | null>(null);

// Track which character is generating avatars
const [generatingAvatarForId, setGeneratingAvatarForId] = useState<string | null>(null);

// Disable save button during avatar generation
const canSave = generatingAvatarForId !== character?.id;
```

### 9.3 Validation

| Field | Validation |
|-------|------------|
| `name` | Required |
| `gender` | Required (male/female/other) |
| `age` | Required (string) |
| `traits.strengths` | Array of strings |
| `traits.flaws` | Array of strings |
| `traits.challenges` | Array of strings |
| `traits.specialDetails` | Optional, free-form text |

---

## 10. Database Schema

### 10.1 Characters Table

```sql
CREATE TABLE characters (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  data JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for user lookups
CREATE INDEX idx_characters_user_id ON characters(user_id);

-- Add metadata column if missing (migration)
ALTER TABLE characters ADD COLUMN IF NOT EXISTS metadata JSONB;
```

### 10.2 Data Column Structure

```json
{
  "characters": [
    {
      "id": "1705432100000",
      "name": "Emma",
      "role": "main",
      "gender": "female",
      "age_group": "child",
      "photos": { ... },
      "avatars": { ... },
      "traitSources": { ... }
    }
  ],
  "relationships": {
    "1705432200000": "sister"
  }
}
```

### 10.3 Metadata Column Structure

Lightweight version for list views (no large images):

```json
{
  "characters": [
    {
      "id": "1705432100000",
      "name": "Emma",
      "role": "main",
      "avatars": {
        "status": "complete",
        "faceThumbnails": { ... }
      }
    }
  ]
}
```

**Stripped from metadata**: `photos`, `photo_url`, `body_photo_url`, `body_no_bg_url`, `thumbnail_url`, `clothing_avatars`, full avatar images

---

## 11. API Endpoints

### 11.1 Character Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/characters` | List all characters (metadata only) |
| GET | `/api/characters/:id/full` | Get single character with full data |
| POST | `/api/characters` | Create/update characters |
| DELETE | `/api/characters/:id` | Delete character |

### 11.2 Photo Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/avatars/analyze-photo` | Upload and analyze photo |
| POST | `/api/avatars/select-face` | Select face from multi-face photo |

### 11.3 Avatar Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/avatars/generate` | Start avatar generation job |
| GET | `/api/avatars/job/:id` | Get job status |
| POST | `/api/avatars/regenerate` | Regenerate avatars for character |

### 11.4 Request/Response Examples

#### POST /api/avatars/analyze-photo

Request:
```json
{
  "photo": "data:image/jpeg;base64,...",
  "characterId": "1705432100000",
  "characterName": "Emma"
}
```

Response (single face):
```json
{
  "success": true,
  "photos": {
    "original": "https://...",
    "face": "https://...",
    "body": "https://...",
    "bodyNoBg": "https://..."
  },
  "traits": {
    "gender": "female",
    "age_group": "child",
    "eye_color": "blue",
    "hair_color": "blonde"
  },
  "traitSources": {
    "gender": "photo",
    "eye_color": "photo"
  }
}
```

Response (multiple faces):
```json
{
  "success": true,
  "multipleFaces": true,
  "faces": [
    { "url": "...", "bounds": {...}, "confidence": 0.95 },
    { "url": "...", "bounds": {...}, "confidence": 0.87 }
  ]
}
```

#### POST /api/characters

Request:
```json
{
  "characters": [
    {
      "id": "1705432100000",
      "name": "Emma",
      "gender": "female"
      // NOTE: avatars NOT included - backend manages
    }
  ]
}
```

Response:
```json
{
  "success": true,
  "characters": [
    {
      "id": "1705432100000",
      "name": "Emma",
      "gender": "female",
      "avatars": {
        "status": "complete",
        "standard": "https://..."
      }
    }
  ]
}
```

---

## 12. Error Handling

### 12.1 Photo Upload Errors

| Error | User Message | Recovery |
|-------|--------------|----------|
| No face detected | "No face detected in photo. Please try a different photo." | Retry with different photo |
| Image too small | "Image is too small. Please use a larger photo." | Retry with larger image |
| Invalid format | "Unsupported image format. Please use JPG or PNG." | Retry with supported format |
| Processing failed | "Failed to process photo. Please try again." | Retry same photo |

### 12.2 Avatar Generation Errors

| Error | User Message | Recovery |
|-------|--------------|----------|
| Generation failed | "Failed to generate avatars. Please try again." | Click regenerate |
| Timeout | "Avatar generation timed out. Please try again." | Click regenerate |
| Character not found | "Character not saved. Please save first." | Save character, then regenerate |

### 12.3 Save Errors

| Error | User Message | Recovery |
|-------|--------------|----------|
| Network error | "Failed to save. Please check your connection." | Retry save |
| Conflict | "Character was modified elsewhere. Please refresh." | Refresh and re-edit |
| Validation | "[Specific field] is invalid" | Fix field and retry |

---

## 13. Race Condition Prevention

### 13.1 Problem: Async Avatar Generation vs Character Save

```
Timeline without protection:
T0: Upload photo → avatar job starts (async)
T1: User saves character → POST reads DB (no avatars yet)
T2: POST writes to DB (overwrites with no avatars)
T3: Avatar job completes → writes avatars
T4: Character save completes → avatars lost!
```

### 13.2 Solution: Row-Level Locking

```javascript
// In character POST handler
await dbQuery('BEGIN');

// FIRST: Acquire row lock
await dbQuery('SELECT id FROM characters WHERE id = $1 FOR UPDATE', [id]);

// THEN: Read current data (now locked, can't change)
const current = await dbQuery('SELECT data FROM characters WHERE id = $1', [id]);

// Merge and save
const merged = merge(frontendData, current.data);
await dbQuery('UPDATE characters SET data = $1 WHERE id = $2', [merged, id]);

await dbQuery('COMMIT');
```

### 13.3 Solution: Frontend Retry with Backoff

Frontend waits for avatars to appear (up to 60 seconds):

```typescript
const maxAttempts = 30;
for (let i = 0; i < maxAttempts; i++) {
  const delay = Math.min(500 * Math.pow(1.2, i), 3000);
  await sleep(delay);

  const char = await loadFullCharacter(id);
  if (char.avatars?.standard) {
    return char;
  }
}
```

### 13.4 Solution: Atomic SQL Merge for Avatar Jobs

Avatar job uses SQL-level COALESCE to never overwrite existing data:

```sql
UPDATE characters
SET data = jsonb_set(
  data,
  '{characters}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN c->>'id' = $2
        THEN c || $3::jsonb  -- Merge, don't replace
        ELSE c
      END
    )
    FROM jsonb_array_elements(data->'characters') AS c
  )
)
WHERE id = $1
```

---

## 14. Performance Requirements

### 14.1 Response Times

| Operation | Target | Maximum |
|-----------|--------|---------|
| Character list (metadata) | 200ms | 1s |
| Character full load | 500ms | 2s |
| Photo upload + analysis | 3s | 10s |
| Avatar generation | 15s | 60s |
| Character save | 200ms | 1s |

### 14.2 Payload Sizes

| Data Type | Target | Maximum |
|-----------|--------|---------|
| Metadata per character | 10KB | 50KB |
| Full data per character | 500KB | 5MB |
| Avatar image | 200KB | 1MB |
| Thumbnail | 10KB | 50KB |

### 14.3 Optimization Strategies

1. **Two-column storage**: `data` (full) vs `metadata` (lightweight)
2. **Strip large fields from metadata**: photos, avatar images
3. **Lazy loading**: Only load full character when editing
4. **Image compression**: Compress avatars before storage
5. **Thumbnail generation**: Small previews for lists

---

## Appendix A: Trait Options

### A.1 Age Categories (AgeCategory type)
Used for image generation consistency:
- infant
- toddler
- preschooler
- kindergartner
- young-school-age
- school-age
- preteen
- young-teen
- teenager
- young-adult
- adult
- middle-aged
- senior
- elderly

### A.2 Clothing Categories
- winter (warm clothing)
- standard (everyday clothing)
- summer (light clothing)
- formal (dressy clothing)

### A.3 Build Types (examples)
- slim
- average
- athletic
- stocky
- heavy

---

## Appendix B: Implementation Checklist

### Backend
- [ ] Characters table with `data` and `metadata` columns
- [ ] Photo upload endpoint with face/body detection
- [ ] Multi-face detection and selection
- [ ] Avatar generation job system
- [ ] Physical trait extraction during avatar evaluation
- [ ] Character save with preserve query
- [ ] Row-level locking for race conditions
- [ ] Atomic SQL merge for avatar jobs
- [ ] Metadata stripping for list endpoints

### Frontend
- [ ] Photo upload with drag-and-drop
- [ ] Face selection UI
- [ ] Character form with all trait fields
- [ ] Trait locking based on source
- [ ] Avatar display with loading states
- [ ] Retry logic with exponential backoff
- [ ] Never send avatars to backend
- [ ] Disable save during avatar generation

### Testing
- [ ] Photo upload → face/body detected, photos saved
- [ ] Avatar generation → images + physical traits saved to DB
- [ ] Page refresh → character data persists
- [ ] Photo re-upload → old avatars preserved until new ones ready
- [ ] Concurrent saves → no data loss
- [ ] Multiple faces → selection UI works
