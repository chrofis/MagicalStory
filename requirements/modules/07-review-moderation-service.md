# Module Requirements Specification: Review & Moderation Service

**Module ID:** MS-REVIEW-001
**Version:** 1.0
**Last Updated:** 2025-01-26
**Owner:** Backend Team
**Status:** Draft

---

## 1. Module Overview

### 1.1 Purpose
Manage multi-stage content review workflows including automated AI checks, user edits, and human moderation before print.

### 1.2 Scope
- Automated content safety checks
- AI-assisted review (grammar, coherence)
- Human moderation workflow
- Content editing with versioning
- Approval/rejection workflow
- Feedback and comment system

### 1.3 Dependencies
- **Upstream:** Story Service, Image Service, Auth Service
- **Downstream:** Print Service, Notification Service
- **External:** OpenAI Moderation API, LanguageTool API

---

## 2. Review Workflow Stages

### Stage 1: AI Content Safety (Automatic)
- Check for inappropriate content
- Detect violence, explicit themes
- Flag culturally insensitive content
- **Processing time:** < 5 seconds
- **Auto-pass threshold:** 95% confidence

### Stage 2: User Review (Optional)
- User can preview and edit
- Make text changes
- Request image regeneration
- **Timeline:** Anytime before submission

### Stage 3: AI Quality Check (Automatic)
- Grammar and spelling check
- Story coherence analysis
- Character consistency check
- Reading level verification
- **Processing time:** < 10 seconds

### Stage 4: Human Moderation (Conditional)
- Triggered if AI flags issues
- Manual review by moderator
- Approve/reject/request changes
- **SLA:** 24 hours (standard), 2 hours (premium)

---

## 3. Functional Requirements

### 3.1 Review Management

#### FR-REVIEW-001: Create Review
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/reviews
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  storyId: string,
  reviewType: "ai_safety" | "ai_quality" | "human" | "user"
}

Response (201 Created):
{
  reviewId: string,
  storyId: string,
  reviewType: string,
  status: "pending",
  assignedTo: string,
  dueDate: string,
  createdAt: string
}
```

#### FR-REVIEW-002: Get Review Status
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/reviews/:reviewId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  id: string,
  storyId: string,
  reviewType: string,
  status: "pending" | "in_review" | "approved" | "rejected" | "revision_requested",

  reviewer: {
    id: string,
    name: string,
    role: string
  },

  findings: [
    {
      type: "error" | "warning" | "suggestion",
      category: string,
      message: string,
      location: {
        page: number,
        element: string
      }
    }
  ],

  comments: [
    {
      id: string,
      userId: string,
      userName: string,
      comment: string,
      createdAt: string
    }
  ],

  assignedAt: string,
  completedAt: string,
  dueDate: string
}
```

#### FR-REVIEW-003: Submit Review Decision
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/reviews/:reviewId/decision
Headers: { Authorization: "Bearer {moderatorAccessToken}" }
Request Body:
{
  decision: "approve" | "reject" | "request_revision",
  reason?: string,
  requiredChanges?: [
    {
      page: number,
      type: string,
      description: string
    }
  ]
}

Response (200 OK):
{
  message: "Review decision recorded",
  status: string,
  nextAction: string
}
```

### 3.2 AI Content Safety

#### FR-REVIEW-004: Run AI Safety Check
**Priority:** MUST HAVE

**Checks:**
- Violence/gore
- Sexual content
- Hate speech
- Self-harm
- Profanity
- Drug references
- Scary/disturbing content

**API Endpoint:**
```typescript
POST /api/v1/reviews/ai-safety-check
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  storyId: string,
  content: string
}

Response (200 OK):
{
  safe: boolean,
  score: number,  // 0-1, higher = safer
  flagged: boolean,
  categories: {
    violence: { flagged: boolean, score: number },
    sexual: { flagged: boolean, score: number },
    hate: { flagged: boolean, score: number },
    // ... more categories
  },
  recommendation: "approve" | "review" | "reject"
}
```

### 3.3 AI Quality Check

#### FR-REVIEW-005: Grammar & Spelling Check
**Priority:** MUST HAVE

**Using:** LanguageTool API or similar

**API Endpoint:**
```typescript
POST /api/v1/reviews/grammar-check
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  text: string,
  language: string
}

Response (200 OK):
{
  errors: [
    {
      message: string,
      shortMessage: string,
      offset: number,
      length: number,
      replacements: string[],
      rule: {
        id: string,
        category: string
      }
    }
  ],
  totalErrors: number,
  errorRate: number  // errors per 100 words
}
```

#### FR-REVIEW-006: Story Coherence Check
**Priority:** SHOULD HAVE (Phase 2)

**Checks:**
- Character consistency (names, traits)
- Plot continuity
- Setting consistency
- Timeline coherence

### 3.4 Content Editing

#### FR-REVIEW-007: Edit Story Content
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
PUT /api/v1/stories/:storyId/content
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  pages: [
    {
      pageNumber: number,
      content: string
    }
  ],
  editReason: string,
  editedBy: "user" | "moderator" | "ai"
}

Response (200 OK):
{
  message: "Content updated",
  version: number,
  changesCount: number
}
```

#### FR-REVIEW-008: Track Content Changes
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/stories/:storyId/changes
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  changes: [
    {
      version: number,
      editedBy: string,
      editedAt: string,
      reason: string,
      diff: [
        {
          page: number,
          oldText: string,
          newText: string,
          changeType: "addition" | "deletion" | "modification"
        }
      ]
    }
  ]
}
```

### 3.5 Comments & Feedback

#### FR-REVIEW-009: Add Review Comment
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/reviews/:reviewId/comments
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  comment: string,
  type: "feedback" | "revision_request" | "question",
  page?: number,
  elementType?: "text" | "image",
  elementId?: string
}

Response (201 Created):
{
  commentId: string,
  message: "Comment added"
}
```

#### FR-REVIEW-010: Get Review Comments
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/reviews/:reviewId/comments
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  comments: [
    {
      id: string,
      userId: string,
      userName: string,
      userRole: string,
      comment: string,
      type: string,
      page: number,
      resolved: boolean,
      createdAt: string
    }
  ]
}
```

---

## 4. Non-Functional Requirements

### 4.1 Performance

#### NFR-REVIEW-001: Processing Speed
- AI safety check: < 5 seconds
- Grammar check: < 10 seconds
- Human review SLA: 24 hours (standard), 2 hours (premium)

### 4.2 Accuracy

#### NFR-REVIEW-002: Content Safety
- False positive rate: < 5%
- False negative rate: < 1%
- Overall accuracy: > 95%

### 4.3 Capacity

#### NFR-REVIEW-003: Review Queue
- Support 100 concurrent reviews
- Moderator capacity: 50 reviews per day per moderator

---

## 5. Data Models

### 5.1 Reviews Table
```sql
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id),
  user_id UUID NOT NULL REFERENCES users(id),
  reviewer_id UUID REFERENCES users(id),

  review_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',

  priority INTEGER DEFAULT 2,  -- 0=critical, 1=high, 2=normal

  assigned_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  due_date TIMESTAMP,

  decision VARCHAR(50),
  decision_reason TEXT,

  ai_safety_score DECIMAL(3, 2),
  ai_quality_score DECIMAL(3, 2),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_type CHECK (review_type IN ('ai_safety', 'ai_quality', 'human', 'user')),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'in_review', 'approved', 'rejected', 'revision_requested'))
);

CREATE INDEX idx_reviews_story ON reviews(story_id);
CREATE INDEX idx_reviews_status ON reviews(status, priority);
CREATE INDEX idx_reviews_reviewer ON reviews(reviewer_id);
```

### 5.2 Review Findings Table
```sql
CREATE TABLE review_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id),

  finding_type VARCHAR(50) NOT NULL,
  category VARCHAR(100),
  severity VARCHAR(20),

  message TEXT NOT NULL,
  location JSONB,  -- {page, line, character, element}

  suggested_fix TEXT,
  resolved BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_type CHECK (finding_type IN ('safety', 'grammar', 'coherence', 'quality')),
  CONSTRAINT valid_severity CHECK (severity IN ('error', 'warning', 'suggestion'))
);

CREATE INDEX idx_findings_review ON review_findings(review_id);
CREATE INDEX idx_findings_resolved ON review_findings(resolved);
```

### 5.3 Review Comments Table
```sql
CREATE TABLE review_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id),
  user_id UUID NOT NULL REFERENCES users(id),

  comment_type VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,

  page_number INTEGER,
  element_type VARCHAR(50),
  element_id VARCHAR(255),

  resolved BOOLEAN DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_type CHECK (comment_type IN ('feedback', 'revision_request', 'question', 'note'))
);

CREATE INDEX idx_comments_review ON review_comments(review_id);
CREATE INDEX idx_comments_user ON review_comments(user_id);
```

---

## 6. Testing

### 6.1 Test Cases
- Content with profanity → flagged
- Content with violence → flagged
- Grammatically correct text → no errors
- Text with spelling errors → flagged
- Safe, well-written story → auto-approved

### 6.2 Quality Metrics
- Content safety accuracy: > 95%
- Grammar detection rate: > 90%
- False flag rate: < 5%

---

## 7. Success Criteria

- < 5% false positive rate
- > 95% auto-approval rate for safe content
- < 24 hours average review time
- > 4.5/5.0 moderator efficiency rating

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | Backend Team | Initial specification |
