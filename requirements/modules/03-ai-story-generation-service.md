# Module Requirements Specification: AI Story Generation Service

**Module ID:** MS-AIGEN-001
**Version:** 1.0
**Last Updated:** 2025-01-26
**Owner:** AI/ML Team
**Status:** Draft

---

## 1. Module Overview

### 1.1 Purpose
The AI Story Generation Service orchestrates AI-powered story creation using large language models. It manages prompt engineering, queue processing, cost optimization, and story versioning.

### 1.2 Scope
- Story generation using Claude/GPT APIs
- Dynamic prompt engineering based on configuration
- Asynchronous job queue management
- Multi-provider support with failover
- Cost tracking and optimization
- Story versioning and regeneration
- Content caching for similar requests

### 1.3 Dependencies
- **Upstream:** Story Configuration Service, Payment Service, Auth Service
- **Downstream:** Review Service, Notification Service, Image Generation Service
- **External:** Anthropic Claude API, OpenAI GPT-4 API

### 1.4 Technology Stack
- **Language:** Python 3.11 (better AI library support)
- **Framework:** FastAPI
- **Queue:** AWS SQS + Celery
- **Database:** PostgreSQL (metadata), MongoDB (story content)
- **Cache:** Redis
- **AI Libraries:** `anthropic`, `openai`, `langchain`

---

## 2. Functional Requirements

### 2.1 Story Generation

#### FR-AIGEN-001: Generate Story from Configuration
**Priority:** MUST HAVE
**Description:** Generate a complete story based on user configuration.

**Acceptance Criteria:**
- Validate configuration completeness
- Check user has sufficient credits/subscription
- Create prompt from template + configuration
- Submit to AI provider (Claude preferred)
- Parse response into page-structured format
- Store story in MongoDB
- Mark as "completed" or "failed"
- Send notification on completion
- Generation time < 60 seconds for 10-page story

**API Endpoint:**
```python
POST /api/v1/stories/generate
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  configurationId: str,
  priority: "normal" | "high" = "normal",  # Premium users get high priority
  options: {
    temperature: float = 0.7,  # 0.0-1.0, controls creativity
    maxTokens: int = 4000,
    model: str = "claude-3-5-sonnet-20250514"  # Optional override
  }
}

Response (202 Accepted):
{
  jobId: str,
  storyId: str,
  status: "queued",
  estimatedCompletionTime: str,  # ISO 8601
  message: "Story generation started"
}

Errors:
400 Bad Request - Invalid configuration
402 Payment Required - Insufficient credits
403 Forbidden - Daily limit exceeded
429 Too Many Requests - Rate limit
```

#### FR-AIGEN-002: Check Generation Status
**Priority:** MUST HAVE
**Description:** Poll job status for async generation.

**API Endpoint:**
```python
GET /api/v1/stories/:storyId/status
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  storyId: str,
  status: "queued" | "processing" | "completed" | "failed",
  progress: int,  # 0-100
  currentStep: str,  # e.g., "generating_story", "parsing_response"
  error: Optional[str],
  completedAt: Optional[str],
  estimatedTimeRemaining: Optional[int]  # seconds
}
```

#### FR-AIGEN-003: Retrieve Generated Story
**Priority:** MUST HAVE
**Description:** Get the complete generated story.

**API Endpoint:**
```python
GET /api/v1/stories/:storyId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  id: str,
  userId: str,
  configurationId: str,
  title: str,
  content: str,  # Full story text
  pages: [
    {
      pageNumber: int,
      content: str,
      wordCount: int
    }
  ],
  metadata: {
    language: str,
    readingLevel: str,
    totalWords: int,
    totalPages: int,
    characters: [
      { name: str, mentions: int }
    ]
  },
  aiMetadata: {
    model: str,
    provider: str,
    tokensUsed: int,
    generationTimeMs: int,
    cost: float
  },
  status: "completed" | "approved" | "rejected",
  version: int,
  createdAt: str,
  updatedAt: str
}

Errors:
404 Not Found - Story does not exist
403 Forbidden - Story belongs to another user
```

#### FR-AIGEN-004: Regenerate Story
**Priority:** MUST HAVE
**Description:** Regenerate story with modified parameters or same config.

**Acceptance Criteria:**
- Create new version (increment version number)
- Link to parent story
- Preserve original story
- Option to adjust temperature, style, or specific aspects
- Reuse configuration or allow modifications

**API Endpoint:**
```python
POST /api/v1/stories/:storyId/regenerate
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  modifications?: {
    temperature?: float,
    focusMoreOn?: str,  # e.g., "adventure", "character development"
    tone?: str,  # e.g., "humorous", "serious", "mysterious"
  },
  keepOriginal: bool = true  # Create new version vs replace
}

Response (202 Accepted):
{
  newStoryId: str,
  jobId: str,
  status: "queued",
  message: "Regeneration started"
}
```

#### FR-AIGEN-005: List User Stories
**Priority:** MUST HAVE
**Description:** Get all stories for a user with filtering.

**API Endpoint:**
```python
GET /api/v1/stories?status=completed&sortBy=createdAt&order=desc&page=1&limit=20
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  stories: [
    {
      id: str,
      title: str,
      configurationName: str,
      storyType: str,
      language: str,
      pages: int,
      status: str,
      thumbnail: Optional[str],  # First image if available
      createdAt: str,
      lastModified: str
    }
  ],
  pagination: { page: int, limit: int, total: int, totalPages: int }
}
```

#### FR-AIGEN-006: Update Story Content
**Priority:** MUST HAVE
**Description:** Manual editing of generated story (user or moderator).

**Acceptance Criteria:**
- Track all edits (diff/change log)
- Create new version on save
- Preserve edit history
- Support page-level or full-text editing

**API Endpoint:**
```python
PUT /api/v1/stories/:storyId/content
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  pages: [
    {
      pageNumber: int,
      content: str
    }
  ],
  editReason?: str  # Optional note about changes
}

Response (200 OK):
{
  message: "Story updated",
  newVersion: int,
  story: { /* updated story */ }
}
```

#### FR-AIGEN-007: Delete Story
**Priority:** MUST HAVE
**Description:** Soft delete story from user's library.

**Acceptance Criteria:**
- Soft delete (mark as deleted, retain data)
- Cannot delete if print order is in progress
- Related images also marked as deleted
- Permanent deletion after 30 days (scheduled job)

**API Endpoint:**
```python
DELETE /api/v1/stories/:storyId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Story deleted",
  deletionDate: str  # 30 days from now
}

Errors:
409 Conflict - Story has active print order
```

### 2.2 Prompt Engineering

#### FR-AIGEN-008: Dynamic Prompt Generation
**Priority:** MUST HAVE
**Description:** Generate optimized prompts based on configuration.

**Prompt Template Structure:**
```
System Prompt:
- You are an expert children's story writer
- Age-appropriate language based on reading level
- Cultural sensitivity and inclusivity
- Positive themes and life lessons

User Prompt:
- Story type and setting
- Character descriptions (names, traits, relationships)
- Page count and structure requirements
- Language and reading level instructions
- Tone and style guidance

Output Format Requirements:
- Clear page breaks (--- Page X ---)
- Age-appropriate vocabulary
- Complete sentences and proper grammar
- No abrupt endings
```

**Acceptance Criteria:**
- Template supports all languages (en, de, fr)
- Character consistency instructions
- Relationship integration requirements
- Reading level-specific vocabulary guidance
- Page structure enforcement

#### FR-AIGEN-009: Prompt Versioning
**Priority:** SHOULD HAVE
**Description:** Version control for prompt templates.

**Acceptance Criteria:**
- Each story references prompt version used
- A/B testing capabilities
- Rollback to previous prompt versions
- Prompt analytics (success rate, user satisfaction)

### 2.3 Queue Management

#### FR-AIGEN-010: Priority Queue System
**Priority:** MUST HAVE
**Description:** Process generation jobs with priority-based scheduling.

**Priority Levels:**
1. **Critical** - Retry after failure (avoid user frustration)
2. **High** - Premium users
3. **Normal** - Standard users
4. **Low** - Batch regeneration, admin testing

**Acceptance Criteria:**
- FIFO within same priority level
- Premium users jump queue
- Concurrent processing (10 jobs in parallel)
- Job timeout: 120 seconds
- Auto-retry on failure (max 3 attempts with exponential backoff)

#### FR-AIGEN-011: Job Monitoring
**Priority:** MUST HAVE
**Description:** Real-time job queue monitoring and alerts.

**Metrics to Track:**
- Queue length per priority
- Average wait time
- Processing time per job
- Success/failure rates
- Cost per generation

**Alerts:**
- Queue length > 100 jobs
- Average wait time > 5 minutes
- Failure rate > 10%
- API errors from provider

### 2.4 Multi-Provider Support

#### FR-AIGEN-012: Provider Failover
**Priority:** SHOULD HAVE (Phase 2)
**Description:** Automatic fallback to secondary AI provider.

**Provider Priority:**
1. Anthropic Claude 3.5 Sonnet (primary)
2. OpenAI GPT-4 Turbo (fallback)
3. OpenAI GPT-4 (secondary fallback)

**Failover Triggers:**
- API downtime or errors
- Rate limit exceeded
- Timeout (> 60 seconds)
- Cost optimization (use cheaper model for simple stories)

**Acceptance Criteria:**
- Seamless failover (user not aware)
- Log provider switches
- Track success rate per provider

#### FR-AIGEN-013: Cost Optimization
**Priority:** SHOULD HAVE
**Description:** Minimize AI API costs through intelligent routing.

**Strategies:**
- Cache similar prompts (similarity threshold 90%)
- Use cheaper models for 1st grade reading level
- Batch processing during off-peak hours
- Token usage monitoring and alerting

---

## 3. Non-Functional Requirements

### 3.1 Performance

#### NFR-AIGEN-001: Generation Time
- 10-page story: < 60 seconds (p95)
- 5-page story: < 30 seconds (p95)
- 30-page story: < 180 seconds (p95)

#### NFR-AIGEN-002: Throughput
- Process 1,000 stories per hour
- Support 100 concurrent generations
- Queue capacity: 10,000 jobs

### 3.2 Reliability

#### NFR-AIGEN-003: Uptime
- 99.9% uptime for generation service
- Graceful degradation if AI provider down
- Persistent queue (survives service restart)

#### NFR-AIGEN-004: Error Handling
- Retry failed jobs automatically (max 3 attempts)
- Detailed error messages for users
- Fallback to alternative provider

### 3.3 Cost Management

#### NFR-AIGEN-005: Budget Control
- Monthly budget cap per user tier
- Alert when 80% of budget consumed
- Auto-throttle if budget exceeded

#### NFR-AIGEN-006: Cost Tracking
- Track cost per story
- Track cost per user
- Daily/monthly cost reports

### 3.4 Quality

#### NFR-AIGEN-007: Story Quality Metrics
- Grammar error rate: < 1%
- Character name consistency: > 99%
- Page length variance: ± 20% from target
- User satisfaction: > 4.0/5.0 stars

#### NFR-AIGEN-008: Content Safety
- No violence, explicit content, or harmful themes
- Age-appropriate language enforcement
- Cultural sensitivity checks

---

## 4. Data Models

### 4.1 Stories Table (PostgreSQL - Metadata)
```sql
CREATE TABLE stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  configuration_id UUID NOT NULL REFERENCES story_configurations(id),
  title VARCHAR(500),
  language VARCHAR(10) NOT NULL,
  reading_level VARCHAR(20) NOT NULL,
  num_pages INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'generating',

  -- AI Metadata
  ai_model VARCHAR(100),
  ai_provider VARCHAR(50),
  prompt_version VARCHAR(20),
  tokens_used INTEGER,
  generation_time_ms INTEGER,
  cost_usd DECIMAL(10, 4),

  -- Versioning
  version INTEGER DEFAULT 1,
  parent_story_id UUID REFERENCES stories(id),

  -- Content reference (MongoDB)
  content_ref VARCHAR(100),  -- MongoDB document ID

  -- Status tracking
  deleted BOOLEAN DEFAULT FALSE,
  deletion_scheduled_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,

  CONSTRAINT valid_status CHECK (status IN ('queued', 'generating', 'completed', 'failed', 'approved', 'rejected'))
);

CREATE INDEX idx_stories_user ON stories(user_id) WHERE deleted = FALSE;
CREATE INDEX idx_stories_config ON stories(configuration_id);
CREATE INDEX idx_stories_status ON stories(status);
CREATE INDEX idx_stories_created ON stories(created_at);
CREATE INDEX idx_stories_parent ON stories(parent_story_id);
```

### 4.2 Story Content (MongoDB)
```javascript
{
  _id: ObjectId,
  storyId: UUID,  // Reference to PostgreSQL
  userId: UUID,

  // Full content
  fullText: String,  // Complete story

  // Page-structured content
  pages: [
    {
      pageNumber: Number,
      content: String,
      wordCount: Number,
      imageUrl: String  // Set after image generation
    }
  ],

  // Metadata
  metadata: {
    totalWords: Number,
    totalPages: Number,
    characters: [
      {
        name: String,
        mentions: Number,
        mainCharacter: Boolean
      }
    ],
    themes: [String],  // Extracted themes
    readabilityScore: Number  // Flesch-Kincaid or similar
  },

  // Prompt used
  prompt: {
    system: String,
    user: String,
    version: String
  },

  // Raw AI response
  rawResponse: String,

  // Edit history
  editHistory: [
    {
      version: Number,
      editedBy: UUID,
      editedAt: Date,
      changes: String,  // Diff format
      reason: String
    }
  ],

  createdAt: Date,
  updatedAt: Date
}

// Indexes
db.story_content.createIndex({ storyId: 1 }, { unique: true });
db.story_content.createIndex({ userId: 1 });
db.story_content.createIndex({ "metadata.themes": 1 });
db.story_content.createIndex({ createdAt: -1 });
```

### 4.3 Generation Jobs Table (PostgreSQL)
```sql
CREATE TABLE generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  story_id UUID NOT NULL REFERENCES stories(id),
  configuration_id UUID NOT NULL REFERENCES story_configurations(id),

  -- Job management
  priority INTEGER DEFAULT 2,  -- 0=critical, 1=high, 2=normal, 3=low
  status VARCHAR(50) DEFAULT 'queued',

  -- Provider info
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
  error_code VARCHAR(50),

  -- Cost tracking
  estimated_cost DECIMAL(10, 4),
  actual_cost DECIMAL(10, 4),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT valid_priority CHECK (priority BETWEEN 0 AND 3)
);

CREATE INDEX idx_jobs_status ON generation_jobs(status, priority, queued_at);
CREATE INDEX idx_jobs_user ON generation_jobs(user_id);
CREATE INDEX idx_jobs_story ON generation_jobs(story_id);
```

### 4.4 Prompt Templates Table (PostgreSQL)
```sql
CREATE TABLE prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  version VARCHAR(20) NOT NULL,
  language VARCHAR(10) NOT NULL,
  reading_level VARCHAR(20) NOT NULL,

  -- Template content
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,  -- With placeholders

  -- Metadata
  is_active BOOLEAN DEFAULT TRUE,
  success_rate DECIMAL(5, 2),  -- 0-100%
  average_quality_score DECIMAL(3, 2),  -- 1-5

  created_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES users(id),

  UNIQUE(name, version, language, reading_level)
);

CREATE INDEX idx_prompts_active ON prompt_templates(language, reading_level, is_active);
```

---

## 5. Integration Specifications

### 5.1 Anthropic Claude API
```python
import anthropic

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

message = client.messages.create(
    model="claude-3-5-sonnet-20250514",
    max_tokens=4000,
    temperature=0.7,
    system="You are an expert children's story writer...",
    messages=[
        {"role": "user", "content": prompt}
    ]
)

story_text = message.content[0].text
tokens_used = message.usage.input_tokens + message.usage.output_tokens
```

### 5.2 OpenAI GPT-4 API (Fallback)
```python
from openai import OpenAI

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

response = client.chat.completions.create(
    model="gpt-4-turbo-preview",
    messages=[
        {"role": "system", "content": "You are an expert children's story writer..."},
        {"role": "user", "content": prompt}
    ],
    max_tokens=4000,
    temperature=0.7
)

story_text = response.choices[0].message.content
tokens_used = response.usage.total_tokens
```

---

## 6. Testing Requirements

### 6.1 Unit Tests
- Prompt generation logic
- Story parsing (page extraction)
- Cost calculation
- Error handling

**Coverage:** 85%

### 6.2 Integration Tests
- End-to-end story generation
- Provider failover
- Queue processing
- Retry mechanism

**Coverage:** 75%

### 6.3 Load Tests
- 100 concurrent generation requests
- Queue with 1,000 jobs
- Provider switching under load

### 6.4 Quality Tests
- Grammar checking (LanguageTool)
- Character name consistency validation
- Reading level verification (readability scores)
- Content safety checks

---

## 7. Monitoring & Alerts

### 7.1 Metrics
- Stories generated per hour/day
- Average generation time
- Queue length and wait time
- Cost per story (by provider, model)
- Success/failure rates
- User satisfaction ratings

### 7.2 Alerts
- High queue length (> 100 jobs)
- Generation failures (> 10% in 15 min)
- API errors from providers
- Cost anomalies (sudden spike)
- Long generation times (> 120 seconds)

---

## 8. Success Criteria

- 95% generation success rate
- < 60 seconds average generation time
- < $0.50 average cost per story
- > 4.0/5.0 user satisfaction
- 99.5% uptime for generation service

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | AI/ML Team | Initial specification |
