# Module Requirements Specification: Image Generation Service

**Module ID:** MS-IMGGEN-001
**Version:** 1.0
**Last Updated:** 2025-01-26
**Owner:** AI/ML Team
**Status:** Draft

---

## 1. Module Overview

### 1.1 Purpose
Generate consistent, high-quality character portraits and story scene illustrations using AI image generation models. Maintain character appearance consistency across all images in a story.

### 1.2 Scope
- Character portrait generation from text descriptions
- Scene image generation based on story content
- Character consistency through reference images and LoRA models
- Multi-provider support (DALL-E, Midjourney, Stable Diffusion)
- Art style selection and customization
- Image post-processing (upscaling, format conversion)
- Image approval workflow

### 1.3 Dependencies
- **Upstream:** Story Config Service, AI Story Generation Service, Auth Service
- **Downstream:** Review Service, Print Service, Storage Service (S3)
- **External:** OpenAI DALL-E API, Midjourney API, Stable Diffusion (self-hosted)

### 1.4 Technology Stack
- **Language:** Python 3.11
- **Framework:** FastAPI
- **Queue:** Celery + Redis
- **Database:** PostgreSQL (metadata), S3 (image storage)
- **Image Processing:** Pillow, OpenCV
- **AI Libraries:** `openai`, `stability-sdk`, `diffusers`

---

## 2. Functional Requirements

### 2.1 Character Portrait Generation

#### FR-IMGGEN-001: Generate Character Portrait
**Priority:** MUST HAVE
**Description:** Create a character portrait from text description.

**Acceptance Criteria:**
- Use character description (age, gender, hair, features, traits)
- Select art style (cartoon, watercolor, realistic, etc.)
- Generate 1024x1024px minimum resolution
- Store original and print-ready (2048x2048px) versions
- Return CDN URL for display
- Generation time < 30 seconds
- Create character reference for consistency

**API Endpoint:**
```python
POST /api/v1/images/characters
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  characterId: str,
  storyId: Optional[str],
  style: "cartoon" | "watercolor" | "realistic" | "painterly" | "anime",
  options: {
    model: str = "dall-e-3",
    size: str = "1024x1024",
    quality: str = "hd"
  }
}

Response (202 Accepted):
{
  jobId: str,
  imageId: str,
  status: "queued",
  estimatedCompletionTime: str
}
```

#### FR-IMGGEN-002: Generate Scene Images
**Priority:** MUST HAVE
**Description:** Create scene illustrations for story pages.

**Acceptance Criteria:**
- Parse page content for scene description
- Include specified characters in scene
- Maintain character consistency (use reference images)
- Match art style across all images
- Generate one image per page (configurable)
- Support batch generation for entire story

**API Endpoint:**
```python
POST /api/v1/images/scenes
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  storyId: str,
  pageNumber: int,
  characterIds: List[str],  # Characters to include
  sceneDescription: Optional[str],  # Override auto-extraction
  style: str,
  options: {
    model: str,
    aspectRatio: str = "16:9",  # or "4:3", "1:1"
    includeText: bool = false  # Overlay page text
  }
}

Response (202 Accepted):
{
  jobId: str,
  imageId: str,
  status: "queued"
}
```

#### FR-IMGGEN-003: Batch Generate Story Images
**Priority:** MUST HAVE
**Description:** Generate all images for a complete story.

**Acceptance Criteria:**
- Generate character portraits for all characters
- Generate scene images for each page
- Process in parallel (up to 5 concurrent)
- Provide overall progress tracking
- Ensure consistent style across all images
- Estimated time: 3-5 minutes for 10-page story

**API Endpoint:**
```python
POST /api/v1/images/stories/:storyId/generate-all
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  style: str,
  includeCharacterPortraits: bool = true,
  includeSceneImages: bool = true,
  imagesPerPage: int = 1
}

Response (202 Accepted):
{
  batchJobId: str,
  totalImages: int,
  estimatedCompletionTime: str
}
```

### 2.2 Character Consistency

#### FR-IMGGEN-004: Create Character Reference
**Priority:** MUST HAVE
**Description:** Create and store character reference for consistency.

**Acceptance Criteria:**
- Generate multiple views (front, side, expressions)
- Store as character reference set
- Use for all future generations of this character
- Update reference if character description changes

**Implementation Approaches:**
1. **Reference Images:** Store multiple generated images of character
2. **LoRA Training:** Fine-tune model on character images (Phase 2)
3. **Embedding:** Generate and reuse character embedding

#### FR-IMGGEN-005: Apply Character Consistency
**Priority:** MUST HAVE
**Description:** Ensure character looks the same across all images.

**Techniques:**
- Image-to-image generation using reference
- Prompt engineering with detailed appearance descriptions
- LoRA model application (if trained)
- Consistency scoring (compare faces/features)

**Acceptance Criteria:**
- Character recognition rate > 90% across images
- Same hair color, facial features, clothing style
- Automatic flagging of inconsistent images

### 2.3 Art Style Management

#### FR-IMGGEN-006: Select Art Style
**Priority:** MUST HAVE
**Description:** Choose from predefined art styles.

**Available Styles:**
- **Cartoon:** Bright colors, simplified features, child-friendly
- **Watercolor:** Soft edges, painterly, artistic
- **Realistic:** Photo-like, detailed
- **Anime/Manga:** Japanese animation style
- **Storybook:** Classic children's book illustration
- **3D Render:** Computer-generated 3D look

**Style Prompt Templates:**
```python
STYLE_PROMPTS = {
    "cartoon": "children's book illustration, cartoon style, vibrant colors, friendly, simple shapes",
    "watercolor": "watercolor painting, soft colors, artistic, dreamy, children's book",
    "realistic": "realistic illustration, detailed, high quality, professional",
    "anime": "anime style, manga, Japanese animation, colorful, expressive",
    "storybook": "classic storybook illustration, hand-drawn, warm colors, nostalgic",
    "3d_render": "3D rendered, Pixar style, smooth, high quality, detailed"
}
```

#### FR-IMGGEN-007: Custom Style Creation
**Priority:** SHOULD HAVE (Phase 2)
**Description:** Users can define custom art styles.

**Acceptance Criteria:**
- Upload reference images (style examples)
- System learns style through fine-tuning
- Save as reusable custom style

### 2.4 Image Management

#### FR-IMGGEN-008: List Images
**Priority:** MUST HAVE
**Description:** Retrieve all images for a story or character.

**API Endpoint:**
```python
GET /api/v1/images?storyId={storyId}&characterId={characterId}&type=portrait
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  images: [
    {
      id: str,
      type: "portrait" | "scene",
      storyId: Optional[str],
      characterId: Optional[str],
      pageNumber: Optional[int],
      url: str,
      cdnUrl: str,
      thumbnailUrl: str,
      style: str,
      status: str,
      width: int,
      height: int,
      fileSize: int,
      createdAt: str
    }
  ]
}
```

#### FR-IMGGEN-009: Regenerate Image
**Priority:** MUST HAVE
**Description:** Regenerate image with different parameters.

**Acceptance Criteria:**
- Keep original image
- Create new version
- Option to adjust prompt, style, or seed
- Limit: 5 regenerations per image (prevent abuse)

**API Endpoint:**
```python
POST /api/v1/images/:imageId/regenerate
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  modifications: {
    style?: str,
    prompt?: str,
    seed?: int
  }
}

Response (202 Accepted):
{
  newImageId: str,
  jobId: str,
  status: "queued"
}
```

#### FR-IMGGEN-010: Delete Image
**Priority:** MUST HAVE
**Description:** Remove image from story/library.

**API Endpoint:**
```python
DELETE /api/v1/images/:imageId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Image deleted"
}
```

### 2.5 Image Quality

#### FR-IMGGEN-011: Image Upscaling
**Priority:** SHOULD HAVE
**Description:** Upscale images for print quality (300 DPI).

**Acceptance Criteria:**
- Upscale to 2048x2048px minimum for portraits
- Upscale to 3000x2000px for scene images
- Use AI upscaling (Real-ESRGAN or similar)
- Preserve quality and details

#### FR-IMGGEN-012: Image Post-Processing
**Priority:** MUST HAVE
**Description:** Automatic image enhancement after generation.

**Processing Steps:**
1. Format conversion (PNG for transparency, JPEG for photos)
2. Color correction (brightness, contrast, saturation)
3. Sharpening
4. Background removal (for character portraits, if needed)
5. Watermark removal (if present)
6. Resolution validation (meets print requirements)

---

## 3. Non-Functional Requirements

### 3.1 Performance

#### NFR-IMGGEN-001: Generation Speed
- Single image: < 30 seconds (p95)
- Batch of 10 images: < 5 minutes (p95)
- Upscaling: < 10 seconds per image

#### NFR-IMGGEN-002: Throughput
- Process 500 images per hour
- Support 50 concurrent generation jobs

### 3.2 Quality

#### NFR-IMGGEN-003: Image Quality Standards
- Minimum resolution: 1024x1024px (display), 2048x2048px (print)
- Color depth: 24-bit RGB or RGBA
- Format: PNG (with alpha) or JPEG (quality 95)
- File size: < 5MB per image
- No visible artifacts or distortions

#### NFR-IMGGEN-004: Character Consistency
- Character recognition accuracy: > 90%
- Consistent hair color, facial features, clothing
- Same art style across all images

### 3.3 Cost Management

#### NFR-IMGGEN-005: Cost per Image
- Target: < $0.10 per image (DALL-E 3)
- Budget: $500/day for image generation
- Alert when daily budget 80% consumed

#### NFR-IMGGEN-006: Provider Cost Comparison
- Track cost per image by provider
- Auto-select cheapest provider meeting quality standards

### 3.4 Storage

#### NFR-IMGGEN-007: Image Storage
- S3 Standard for recent images (< 30 days)
- S3 Intelligent-Tiering for older images
- Lifecycle: Delete after 1 year if story deleted

#### NFR-IMGGEN-008: CDN Distribution
- CloudFront for global delivery
- Cache for 30 days
- Signed URLs with 1-hour expiry

---

## 4. Data Models

### 4.1 Images Table
```sql
CREATE TABLE images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  story_id UUID REFERENCES stories(id),
  character_id UUID REFERENCES characters(id),

  -- Image type and purpose
  image_type VARCHAR(50) NOT NULL,  -- 'portrait', 'scene', 'cover'
  page_number INTEGER,

  -- Generation details
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  style VARCHAR(50),
  ai_model VARCHAR(100),
  ai_provider VARCHAR(50),
  generation_params JSONB,

  -- File details
  url VARCHAR(500) NOT NULL,  -- S3 URL
  cdn_url VARCHAR(500),  -- CloudFront URL
  thumbnail_url VARCHAR(500),
  width INTEGER,
  height INTEGER,
  file_size_bytes INTEGER,
  format VARCHAR(10),  -- 'PNG', 'JPEG'

  -- Reference and versioning
  is_reference BOOLEAN DEFAULT FALSE,  -- Character reference image
  version INTEGER DEFAULT 1,
  parent_image_id UUID REFERENCES images(id),

  -- Quality and status
  quality_score DECIMAL(3, 2),  -- 0-5
  status VARCHAR(50) DEFAULT 'generating',

  -- Cost tracking
  generation_cost_usd DECIMAL(10, 4),

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,

  CONSTRAINT valid_type CHECK (image_type IN ('portrait', 'scene', 'cover', 'reference')),
  CONSTRAINT valid_status CHECK (status IN ('queued', 'generating', 'completed', 'failed', 'approved', 'rejected'))
);

CREATE INDEX idx_images_story ON images(story_id);
CREATE INDEX idx_images_character ON images(character_id);
CREATE INDEX idx_images_user ON images(user_id);
CREATE INDEX idx_images_status ON images(status);
CREATE INDEX idx_images_reference ON images(character_id, is_reference) WHERE is_reference = TRUE;
```

### 4.2 Character References Table
```sql
CREATE TABLE character_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  reference_image_id UUID NOT NULL REFERENCES images(id),

  -- LoRA model (if trained)
  lora_model_url VARCHAR(500),
  lora_trigger_word VARCHAR(100),

  -- Embeddings
  embedding_vector FLOAT[],  -- Face/character embedding

  -- Metadata
  style VARCHAR(50),
  quality_score DECIMAL(3, 2),
  usage_count INTEGER DEFAULT 0,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(character_id, style)
);

CREATE INDEX idx_char_refs_character ON character_references(character_id);
```

### 4.3 Image Generation Jobs Table
```sql
CREATE TABLE image_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  image_id UUID NOT NULL REFERENCES images(id),

  -- Job details
  priority INTEGER DEFAULT 2,
  status VARCHAR(50) DEFAULT 'queued',

  -- Provider
  ai_provider VARCHAR(50),
  ai_model VARCHAR(100),

  -- Timing
  queued_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  processing_time_ms INTEGER,

  -- Error handling
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  error_message TEXT,

  -- Cost
  estimated_cost DECIMAL(10, 4),
  actual_cost DECIMAL(10, 4),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (status IN ('queued', 'processing', 'completed', 'failed'))
);

CREATE INDEX idx_img_jobs_status ON image_generation_jobs(status, priority, queued_at);
CREATE INDEX idx_img_jobs_image ON image_generation_jobs(image_id);
```

---

## 5. API Integration

### 5.1 DALL-E 3 Integration
```python
from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

response = client.images.generate(
    model="dall-e-3",
    prompt=full_prompt,
    size="1024x1024",
    quality="hd",
    n=1
)

image_url = response.data[0].url
revised_prompt = response.data[0].revised_prompt
```

### 5.2 Stable Diffusion Integration
```python
from diffusers import StableDiffusionPipeline
import torch

pipe = StableDiffusionPipeline.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0",
    torch_dtype=torch.float16
)
pipe = pipe.to("cuda")

image = pipe(
    prompt=full_prompt,
    negative_prompt=negative_prompt,
    num_inference_steps=50,
    guidance_scale=7.5
).images[0]
```

---

## 6. Testing

### 6.1 Unit Tests
- Prompt generation
- Image post-processing
- Character consistency scoring

**Coverage:** 80%

### 6.2 Integration Tests
- End-to-end image generation
- Batch processing
- Provider failover

**Coverage:** 70%

### 6.3 Quality Tests
- Visual consistency checks
- Resolution validation
- Color accuracy

---

## 7. Success Criteria

- 95% generation success rate
- < 30 seconds average generation time
- > 90% character consistency score
- > 4.0/5.0 image quality rating
- < $0.10 average cost per image

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | AI/ML Team | Initial specification |
