# Module Requirements Specification: Story Configuration Service

**Module ID:** MS-CONFIG-001
**Version:** 1.0
**Last Updated:** 2025-01-26
**Owner:** Backend Team
**Status:** Draft

---

## 1. Module Overview

### 1.1 Purpose
The Story Configuration Service manages all user-created content that defines a story: characters, relationships, story types, and story parameters. This service provides reusable character libraries and configuration templates.

### 1.2 Scope
This module handles:
- Character CRUD operations
- Character photo upload and management
- Relationship mapping between characters
- Story type selection and custom types
- Story parameter configuration
- Configuration persistence and versioning
- Character library management (reusable across stories)
- Import/export functionality

### 1.3 Dependencies
- **Upstream Dependencies:**
  - Authentication Service (user context)
  - Payment Service (feature gating)
- **Downstream Dependencies:**
  - AI Story Generation Service
  - Image Generation Service
  - Storage Service (S3)

### 1.4 Technology Stack
- **Language:** TypeScript (Node.js 20)
- **Framework:** Express.js 4.18
- **Database:** PostgreSQL 15 (relational data), MongoDB 7.0 (flexible configurations)
- **Storage:** AWS S3 (character photos)
- **Cache:** Redis 7.2
- **Image Processing:** Sharp library

---

## 2. Functional Requirements

### 2.1 Character Management

#### FR-CONFIG-001: Create Character
**Priority:** MUST HAVE
**Description:** Users can create character profiles for their stories.

**Acceptance Criteria:**
- Character must have: name (required), gender, age, description
- Optional fields: photo, hair color, physical features, special details
- Auto-detect gender from name (ML-based, can be overridden)
- Minimum 3 strengths, 2 weaknesses required
- Custom traits can be added
- Character photo max size: 10MB
- Supported formats: JPEG, PNG, WebP
- Photos auto-resized to 512x512px for storage
- Characters belong to user's character library

**API Endpoint:**
```typescript
POST /api/v1/characters
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  name: string,
  gender?: "male" | "female" | "other",
  age?: number,
  description?: string,
  hairColor?: string,
  physicalFeatures?: string,
  strengths: string[], // min 3
  weaknesses: string[], // min 2
  fears?: string[],
  specialDetails?: string,
  photoBase64?: string // base64 encoded image
}

Response (201 Created):
{
  id: string,
  userId: string,
  name: string,
  gender: string,
  age: number,
  photoUrl?: string, // S3 URL
  description: string,
  strengths: string[],
  weaknesses: string[],
  fears: string[],
  specialDetails: string,
  createdAt: string,
  updatedAt: string
}

Errors:
400 Bad Request - Validation errors (missing required fields)
413 Payload Too Large - Photo exceeds 10MB
422 Unprocessable Entity - Invalid image format
```

#### FR-CONFIG-002: List User Characters
**Priority:** MUST HAVE
**Description:** Retrieve all characters in user's library.

**Acceptance Criteria:**
- Paginated results (default 20 per page)
- Filter by: name, gender, age range
- Sort by: name, created date, last used
- Include usage count (how many stories use this character)

**API Endpoint:**
```typescript
GET /api/v1/characters?page=1&limit=20&sortBy=name&order=asc&gender=female
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  characters: [
    {
      id: string,
      name: string,
      gender: string,
      age: number,
      photoUrl: string,
      strengths: string[],
      usageCount: number,
      createdAt: string
    }
  ],
  pagination: {
    page: number,
    limit: number,
    total: number,
    totalPages: number
  }
}
```

#### FR-CONFIG-003: Get Character Details
**Priority:** MUST HAVE
**Description:** Retrieve full details of a specific character.

**API Endpoint:**
```typescript
GET /api/v1/characters/:characterId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  id: string,
  userId: string,
  name: string,
  gender: string,
  age: number,
  photoUrl: string,
  description: string,
  hairColor: string,
  physicalFeatures: string,
  strengths: string[],
  weaknesses: string[],
  fears: string[],
  specialDetails: string,
  usedInStories: number,
  createdAt: string,
  updatedAt: string
}

Errors:
404 Not Found - Character does not exist
403 Forbidden - Character belongs to another user
```

#### FR-CONFIG-004: Update Character
**Priority:** MUST HAVE
**Description:** Modify existing character details.

**Acceptance Criteria:**
- Can update all fields except ID and userId
- Updating photo replaces old photo in S3
- Old photo deleted from S3 (cost optimization)
- Version tracking (increment version number)
- Changes reflected in all stories using this character

**API Endpoint:**
```typescript
PUT /api/v1/characters/:characterId
Headers: { Authorization: "Bearer {accessToken}" }
Request Body: { /* partial character data */ }

Response (200 OK):
{
  message: "Character updated successfully",
  character: { /* updated character object */ }
}
```

#### FR-CONFIG-005: Delete Character
**Priority:** MUST HAVE
**Description:** Remove character from user's library.

**Acceptance Criteria:**
- Soft delete (mark as deleted, don't remove from DB)
- Check if character is used in any active stories
- If used: show warning, require confirmation
- Remove photo from S3
- Remove all relationships involving this character
- Cannot delete if character is in a story pending print

**API Endpoint:**
```typescript
DELETE /api/v1/characters/:characterId?force=false
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Character deleted successfully"
}

Response (409 Conflict) - if used in stories:
{
  error: "Character is used in 3 stories",
  stories: [
    { id: string, title: string, status: string }
  ],
  message: "Use ?force=true to delete anyway"
}
```

#### FR-CONFIG-006: Upload Character Photo
**Priority:** MUST HAVE
**Description:** Upload or update character photo separately.

**Acceptance Criteria:**
- Multipart form upload
- Auto-resize to 512x512px (maintain aspect ratio, add padding if needed)
- Generate thumbnail (128x128px) for list views
- Store in S3: `/characters/{userId}/{characterId}/photo.jpg`
- Return CDN URL

**API Endpoint:**
```typescript
POST /api/v1/characters/:characterId/photo
Headers: {
  Authorization: "Bearer {accessToken}",
  Content-Type: "multipart/form-data"
}
Form Data:
{
  photo: File
}

Response (200 OK):
{
  photoUrl: string, // CDN URL
  thumbnailUrl: string
}
```

### 2.2 Relationship Management

#### FR-CONFIG-007: Define Relationship
**Priority:** MUST HAVE
**Description:** Create relationship between two characters.

**Acceptance Criteria:**
- Bidirectional relationships (A → B implies B → A)
- Predefined types: Best Friends, Friends, Siblings, Parent-Child, Married, Rivals, Neighbors, Strangers
- Custom relationship types allowed
- Inverse relationships automatically created (e.g., "Parent of" ↔ "Child of")
- Cannot create duplicate relationships

**API Endpoint:**
```typescript
POST /api/v1/relationships
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  character1Id: string,
  character2Id: string,
  relationshipType: string, // e.g., "Parent of"
}

Response (201 Created):
{
  id: string,
  character1: { id: string, name: string },
  character2: { id: string, name: string },
  relationshipType: string,
  inverseType: string, // e.g., "Child of"
  createdAt: string
}

Errors:
400 Bad Request - Same character for both IDs
404 Not Found - Character does not exist
409 Conflict - Relationship already exists
```

#### FR-CONFIG-008: Get Character Relationships
**Priority:** MUST HAVE
**Description:** Retrieve all relationships for a character.

**API Endpoint:**
```typescript
GET /api/v1/characters/:characterId/relationships
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  characterId: string,
  characterName: string,
  relationships: [
    {
      relationshipId: string,
      relatedCharacter: {
        id: string,
        name: string,
        photoUrl: string
      },
      relationshipType: string
    }
  ]
}
```

#### FR-CONFIG-009: Update Relationship
**Priority:** MUST HAVE
**Description:** Change relationship type between two characters.

**API Endpoint:**
```typescript
PUT /api/v1/relationships/:relationshipId
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  relationshipType: string
}

Response (200 OK):
{
  message: "Relationship updated",
  relationship: { /* updated relationship */ }
}
```

#### FR-CONFIG-010: Delete Relationship
**Priority:** MUST HAVE
**Description:** Remove relationship between characters.

**API Endpoint:**
```typescript
DELETE /api/v1/relationships/:relationshipId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Relationship deleted"
}
```

### 2.3 Story Configuration

#### FR-CONFIG-011: Create Story Configuration
**Priority:** MUST HAVE
**Description:** Define all parameters for story generation.

**Acceptance Criteria:**
- Select story type (predefined or custom)
- Choose language (English, German, French, +more in Phase 2)
- Set number of pages (3-30)
- Set reading level (1st grade, standard, advanced)
- Select main characters (1-2 from character library)
- Include additional supporting characters
- All characters must have defined relationships
- Save as draft (can be edited before generation)

**API Endpoint:**
```typescript
POST /api/v1/story-configs
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  name: string, // User-friendly name for this config
  storyType: string, // "pirate", "princess", "custom-123", etc.
  language: "en" | "de" | "fr",
  numberOfPages: number, // 3-30
  readingLevel: "1st-grade" | "standard" | "advanced",
  mainCharacterIds: string[], // 1-2 characters
  supportingCharacterIds?: string[],
  customStoryType?: {
    name: string,
    emoji: string
  }
}

Response (201 Created):
{
  id: string,
  userId: string,
  name: string,
  storyType: string,
  language: string,
  numberOfPages: number,
  readingLevel: string,
  mainCharacters: [ /* character objects */ ],
  supportingCharacters: [ /* character objects */ ],
  status: "draft",
  createdAt: string,
  updatedAt: string
}

Errors:
400 Bad Request - Validation errors
403 Forbidden - Character limit exceeded (free tier)
404 Not Found - Character not found
422 Unprocessable Entity - Characters lack relationships
```

#### FR-CONFIG-012: Get Story Configurations
**Priority:** MUST HAVE
**Description:** List all story configurations for a user.

**Acceptance Criteria:**
- Filter by status (draft, used, archived)
- Sort by created date, name
- Include metadata (creation date, character count)

**API Endpoint:**
```typescript
GET /api/v1/story-configs?status=draft&sortBy=createdAt&order=desc
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  configurations: [
    {
      id: string,
      name: string,
      storyType: string,
      numberOfPages: number,
      characterCount: number,
      status: string,
      createdAt: string,
      lastUsed: string
    }
  ],
  pagination: { /* ... */ }
}
```

#### FR-CONFIG-013: Update Story Configuration
**Priority:** MUST HAVE
**Description:** Modify story configuration before generation.

**API Endpoint:**
```typescript
PUT /api/v1/story-configs/:configId
Headers: { Authorization: "Bearer {accessToken}" }
Request Body: { /* partial config data */ }

Response (200 OK):
{
  message: "Configuration updated",
  configuration: { /* updated config */ }
}
```

#### FR-CONFIG-014: Delete Story Configuration
**Priority:** MUST HAVE
**Description:** Remove story configuration.

**API Endpoint:**
```typescript
DELETE /api/v1/story-configs/:configId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Configuration deleted"
}
```

#### FR-CONFIG-015: Validate Configuration
**Priority:** MUST HAVE
**Description:** Validate configuration before story generation.

**Acceptance Criteria:**
- Check all characters exist and belong to user
- Check all character pairs have defined relationships
- Check character count within tier limits
- Check all required fields present

**API Endpoint:**
```typescript
POST /api/v1/story-configs/:configId/validate
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  valid: boolean,
  errors: [
    {
      field: string,
      message: string,
      code: string
    }
  ]
}
```

### 2.4 Import/Export

#### FR-CONFIG-016: Export Configuration
**Priority:** MUST HAVE
**Description:** Export configuration as JSON file.

**Acceptance Criteria:**
- Include all characters, relationships, story settings
- Exclude user-specific IDs (generate on import)
- Include character photos as base64 (optional)
- File size limit: 50MB

**API Endpoint:**
```typescript
GET /api/v1/story-configs/:configId/export?includePhotos=false
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  version: "1.0",
  exportedAt: string,
  configuration: {
    name: string,
    storyType: string,
    language: string,
    numberOfPages: number,
    readingLevel: string,
    characters: [ /* character objects */ ],
    relationships: [ /* relationship objects */ ],
    customStoryTypes: [ /* custom types */ ]
  }
}
```

#### FR-CONFIG-017: Import Configuration
**Priority:** MUST HAVE
**Description:** Import configuration from JSON file.

**Acceptance Criteria:**
- Validate JSON schema
- Create new character IDs for imported characters
- Check for duplicate characters (by name + traits)
- Option to merge with existing library or keep separate
- Handle photo import (base64 decode and upload to S3)

**API Endpoint:**
```typescript
POST /api/v1/story-configs/import
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  configData: { /* exported config JSON */ },
  mergeStrategy: "create-new" | "merge-existing"
}

Response (201 Created):
{
  message: "Configuration imported successfully",
  configId: string,
  charactersCreated: number,
  relationshipsCreated: number
}

Errors:
400 Bad Request - Invalid JSON format
422 Unprocessable Entity - Schema validation failed
```

### 2.5 Story Types

#### FR-CONFIG-018: List Story Types
**Priority:** MUST HAVE
**Description:** Get all available story types (predefined + user's custom).

**API Endpoint:**
```typescript
GET /api/v1/story-types
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  predefined: [
    {
      id: "pirate",
      name: { en: "Pirate Adventure", de: "Piraten-Abenteuer", fr: "Aventure de Pirates" },
      emoji: "🏴‍☠️"
    },
    // ... more predefined types
  ],
  custom: [
    {
      id: "custom-123",
      name: "Space Ninja",
      emoji: "🚀🥷",
      createdAt: string
    }
  ]
}
```

#### FR-CONFIG-019: Create Custom Story Type
**Priority:** MUST HAVE
**Description:** Users can create custom story types.

**Acceptance Criteria:**
- Name and emoji required
- Name unique per user
- Emoji validation (must be valid emoji)

**API Endpoint:**
```typescript
POST /api/v1/story-types
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  name: string,
  emoji: string
}

Response (201 Created):
{
  id: string,
  name: string,
  emoji: string,
  createdAt: string
}

Errors:
409 Conflict - Story type name already exists
```

#### FR-CONFIG-020: Delete Custom Story Type
**Priority:** MUST HAVE
**Description:** Remove custom story type.

**API Endpoint:**
```typescript
DELETE /api/v1/story-types/:typeId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Story type deleted"
}

Errors:
409 Conflict - Story type used in configurations
```

---

## 3. Non-Functional Requirements

### 3.1 Performance

#### NFR-CONFIG-001: Response Time
- Character operations: < 100ms (95th percentile)
- Configuration operations: < 150ms (95th percentile)
- Photo upload: < 3 seconds (including processing)

#### NFR-CONFIG-002: Throughput
- Support 1,000 character operations per minute
- Support 500 configuration operations per minute
- Support 100 photo uploads per minute

### 3.2 Storage

#### NFR-CONFIG-003: Character Limits
- Free tier: 10 characters max
- Basic tier: 50 characters max
- Premium tier: Unlimited characters
- Enterprise tier: Unlimited + team sharing

#### NFR-CONFIG-004: Photo Storage
- Original photo: up to 10MB
- Processed photo: 512x512px JPEG (quality 85) ~ 100KB
- Thumbnail: 128x128px JPEG ~ 15KB
- S3 Standard storage class
- Lifecycle policy: Move to Glacier after 90 days of inactivity

### 3.3 Validation

#### NFR-CONFIG-005: Input Validation
- Character name: 1-100 characters, unicode supported
- Age: 0-150 years
- Strengths/weaknesses: 1-50 per trait
- Custom trait: 1-100 characters
- Story name: 1-255 characters

### 3.4 Security

#### NFR-CONFIG-006: Access Control
- Users can only access their own characters and configurations
- Admin users can access all data (read-only)
- Moderators cannot access user configurations

#### NFR-CONFIG-007: Photo Security
- Signed S3 URLs (expire after 1 hour)
- No direct S3 bucket access
- Malware scanning on upload (ClamAV)
- EXIF data stripped (privacy)

### 3.5 Data Integrity

#### NFR-CONFIG-008: Referential Integrity
- Foreign key constraints enforced
- Cascade deletes for dependent records
- Transaction support for multi-table operations

---

## 4. Data Models

### 4.1 Characters Table (PostgreSQL)
```sql
CREATE TABLE characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  gender VARCHAR(20), -- 'male', 'female', 'other'
  age INTEGER CHECK (age >= 0 AND age <= 150),
  description TEXT,
  hair_color VARCHAR(50),
  physical_features TEXT,
  strengths TEXT[] NOT NULL, -- min 3 items
  weaknesses TEXT[] NOT NULL, -- min 2 items
  fears TEXT[],
  special_details TEXT,
  photo_url VARCHAR(500),
  thumbnail_url VARCHAR(500),
  version INTEGER DEFAULT 1,
  usage_count INTEGER DEFAULT 0,
  deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT min_strengths CHECK (array_length(strengths, 1) >= 3),
  CONSTRAINT min_weaknesses CHECK (array_length(weaknesses, 1) >= 2)
);

CREATE INDEX idx_characters_user ON characters(user_id) WHERE deleted = FALSE;
CREATE INDEX idx_characters_name ON characters(name);
CREATE INDEX idx_characters_created ON characters(created_at);
```

### 4.2 Relationships Table
```sql
CREATE TABLE character_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character1_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  character2_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  relationship_type VARCHAR(100) NOT NULL,
  inverse_relationship_type VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT different_characters CHECK (character1_id != character2_id),
  CONSTRAINT unique_relationship UNIQUE (character1_id, character2_id)
);

CREATE INDEX idx_relationships_char1 ON character_relationships(character1_id);
CREATE INDEX idx_relationships_char2 ON character_relationships(character2_id);
CREATE INDEX idx_relationships_user ON character_relationships(user_id);
```

### 4.3 Story Configurations Table
```sql
CREATE TABLE story_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  story_type VARCHAR(100) NOT NULL,
  custom_story_type_id UUID REFERENCES custom_story_types(id),
  language VARCHAR(10) NOT NULL,
  number_of_pages INTEGER NOT NULL CHECK (number_of_pages BETWEEN 3 AND 30),
  reading_level VARCHAR(20) NOT NULL,
  main_character_ids UUID[] NOT NULL, -- 1-2 characters
  supporting_character_ids UUID[],
  status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'used', 'archived'
  last_used_at TIMESTAMP,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_reading_level CHECK (reading_level IN ('1st-grade', 'standard', 'advanced')),
  CONSTRAINT valid_status CHECK (status IN ('draft', 'used', 'archived')),
  CONSTRAINT main_char_count CHECK (array_length(main_character_ids, 1) BETWEEN 1 AND 2)
);

CREATE INDEX idx_story_configs_user ON story_configurations(user_id);
CREATE INDEX idx_story_configs_status ON story_configurations(status);
CREATE INDEX idx_story_configs_created ON story_configurations(created_at);
```

### 4.4 Custom Story Types Table
```sql
CREATE TABLE custom_story_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, name)
);

CREATE INDEX idx_custom_story_types_user ON custom_story_types(user_id);
```

---

## 5. Testing Requirements

### 5.1 Unit Tests
- Character validation logic
- Relationship bidirectionality
- Configuration validation
- Image processing functions

**Coverage Target:** 85%

### 5.2 Integration Tests
- Character CRUD with photo upload
- Relationship creation and cascading updates
- Configuration creation with character validation
- Import/export roundtrip

**Coverage Target:** 75%

### 5.3 Edge Cases
- Creating character with minimum/maximum allowed traits
- Deleting character used in multiple stories
- Importing configuration with duplicate characters
- Handling corrupted image files

---

## 6. Success Metrics

- Average characters per user > 5
- Character reuse rate > 40%
- Configuration completion rate > 70%
- Photo upload success rate > 99%
- Average config creation time < 5 minutes

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | Backend Team | Initial specification |
