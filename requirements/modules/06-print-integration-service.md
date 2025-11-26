# Module Requirements Specification: Print Integration Service

**Module ID:** MS-PRINT-001
**Version:** 1.0
**Last Updated:** 2025-01-26
**Owner:** Backend Team
**Status:** Draft

---

## 1. Module Overview

### 1.1 Purpose
Integrate with external printing companies to produce physical books from generated stories. Manage print orders, file preparation, and order tracking.

### 1.2 Scope
- Multiple print provider integration (Blurb, Lulu, Mixam)
- Print-ready PDF generation
- Order submission and tracking
- Shipping address management
- Print format and binding options
- Proof approval workflow
- Order status updates

### 1.3 Dependencies
- **Upstream:** Story Service, Image Service, Payment Service, Auth Service
- **Downstream:** Notification Service, Logging Service
- **External:** Blurb API, Lulu API, Mixam API

### 1.4 Technology Stack
- **Language:** TypeScript (Node.js 20)
- **Framework:** Express.js
- **PDF Generation:** Puppeteer, PDFKit
- **Database:** PostgreSQL
- **Storage:** AWS S3

---

## 2. Print Specifications

### 2.1 Book Formats

#### Hardcover
- Size options: 8x10", 10x8", 8.5x11"
- Page count: 20-80 pages
- Paper: Premium photo paper (satin/matte)
- Cover: Laminated hardcover
- Binding: Lay-flat or perfect bound
- Price range: $35-$75

#### Softcover (Paperback)
- Size options: 8x10", 6x9", 8.5x11"
- Page count: 20-100 pages
- Paper: Premium matte
- Cover: Glossy/matte lamination
- Binding: Perfect bound
- Price range: $15-$35

#### PDF Only
- Digital download
- Print-ready format (300 DPI)
- Price: $5

---

## 3. Functional Requirements

### 3.1 Order Management

#### FR-PRINT-001: Create Print Order
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/print/orders
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  storyId: string,
  format: "hardcover" | "softcover" | "pdf",
  size: "8x10" | "10x8" | "8.5x11" | "6x9",
  pageFinish: "satin" | "matte" | "glossy",
  binding: "perfect" | "layflat",
  quantity: number,
  shippingAddress: {
    fullName: string,
    addressLine1: string,
    addressLine2?: string,
    city: string,
    state: string,
    postalCode: string,
    country: string,
    phone: string
  },
  giftMessage?: string
}

Response (201 Created):
{
  orderId: string,
  estimatedPrice: number,
  currency: string,
  estimatedDelivery: string,
  proofRequired: boolean,
  status: "draft"
}

Errors:
400 Bad Request - Invalid format or size
402 Payment Required - Insufficient funds
404 Not Found - Story not found
422 Unprocessable Entity - Story not approved for print
```

#### FR-PRINT-002: Get Order Details
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/print/orders/:orderId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  id: string,
  userId: string,
  storyId: string,
  storyTitle: string,
  format: string,
  size: string,
  binding: string,
  quantity: number,

  status: "draft" | "pending_proof" | "proof_approved" | "processing" | "printing" | "shipped" | "delivered" | "cancelled",

  pricing: {
    subtotal: number,
    shipping: number,
    tax: number,
    discount: number,
    total: number,
    currency: string
  },

  shippingAddress: { /* address object */ },

  provider: string,
  providerOrderId: string,
  trackingNumber: string,
  trackingUrl: string,

  estimatedDelivery: string,
  actualDelivery: string,

  proofUrl: string,
  proofApprovedAt: string,

  printFileUrl: string,

  createdAt: string,
  submittedAt: string,
  completedAt: string
}
```

#### FR-PRINT-003: List Orders
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/print/orders?status=shipped&page=1&limit=20
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  orders: [
    {
      id: string,
      storyTitle: string,
      format: string,
      quantity: number,
      total: number,
      status: string,
      trackingNumber: string,
      estimatedDelivery: string,
      createdAt: string
    }
  ],
  pagination: { /* ... */ }
}
```

#### FR-PRINT-004: Cancel Order
**Priority:** MUST HAVE

**Acceptance Criteria:**
- Can cancel if status is "draft" or "pending_proof"
- Cannot cancel if printing started
- Full refund if cancelled before submission
- Partial refund if cancelled after submission (provider policy)

**API Endpoint:**
```typescript
DELETE /api/v1/print/orders/:orderId
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  reason: string
}

Response (200 OK):
{
  message: "Order cancelled",
  refundAmount: number,
  refundStatus: "immediate" | "processing"
}

Errors:
409 Conflict - Order cannot be cancelled (already printing)
```

### 3.2 PDF Generation

#### FR-PRINT-005: Generate Print-Ready PDF
**Priority:** MUST HAVE

**Acceptance Criteria:**
- 300 DPI minimum resolution
- CMYK color mode (for print)
- Correct page size with bleed (0.125" on all sides)
- Embed all fonts
- Compress images appropriately
- Include cover (front, spine, back)
- Generation time < 30 seconds

**PDF Structure:**
```
- Cover page (full spread)
- Title page
- Copyright/credits page
- Story pages (one page per story page)
- Author/character credits page
- Back cover (printed on cover spread)
```

**API Endpoint:**
```typescript
POST /api/v1/print/pdf/generate
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  storyId: string,
  format: string,
  size: string,
  includeBleed: boolean = true
}

Response (202 Accepted):
{
  jobId: string,
  message: "PDF generation started"
}

// Status check
GET /api/v1/print/pdf/:jobId/status
Response (200 OK):
{
  status: "processing" | "completed" | "failed",
  progress: number,  // 0-100
  pdfUrl: string,  // When completed
  fileSize: number
}
```

#### FR-PRINT-006: Validate Print File
**Priority:** MUST HAVE

**Validation Checks:**
- Resolution >= 300 DPI
- Color mode is CMYK
- All images present
- Fonts embedded
- Correct page count
- Bleed margins present
- File size < 100MB

**API Endpoint:**
```typescript
POST /api/v1/print/pdf/:pdfId/validate
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  valid: boolean,
  errors: [
    {
      severity: "error" | "warning",
      message: string,
      page: number
    }
  ],
  recommendations: string[]
}
```

### 3.3 Proof Approval

#### FR-PRINT-007: Request Proof
**Priority:** SHOULD HAVE (Phase 2)

**Acceptance Criteria:**
- Generate digital proof (PDF preview)
- Show page spreads
- Highlight potential issues (low resolution, color issues)
- User must approve before printing

**API Endpoint:**
```typescript
POST /api/v1/print/orders/:orderId/proof
Headers: { Authorization: "Bearer {accessToken}" }

Response (202 Accepted):
{
  proofId: string,
  proofUrl: string,
  message: "Proof ready for review"
}
```

#### FR-PRINT-008: Approve Proof
**Priority:** SHOULD HAVE (Phase 2)

**API Endpoint:**
```typescript
POST /api/v1/print/orders/:orderId/proof/approve
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  approved: boolean,
  comments?: string
}

Response (200 OK):
{
  message: "Proof approved. Order submitted for printing.",
  orderId: string,
  estimatedDelivery: string
}
```

### 3.4 Provider Integration

#### FR-PRINT-009: Submit Order to Provider
**Priority:** MUST HAVE

**Acceptance Criteria:**
- Select provider based on: price, quality, delivery time, location
- Upload print file to provider
- Submit order details
- Receive provider order ID
- Handle provider errors gracefully

**Provider Selection Logic:**
```typescript
1. Check story requirements (size, format, quality)
2. Get quotes from all available providers
3. Apply user preferences (speed vs cost)
4. Apply premium user discounts
5. Select optimal provider
6. Fallback if primary provider unavailable
```

#### FR-PRINT-010: Track Order Status
**Priority:** MUST HAVE

**Acceptance Criteria:**
- Poll provider API for status updates
- Update internal order status
- Send notifications on status changes
- Retrieve tracking information

**Status Mapping:**
```typescript
Provider Status → Internal Status
"received" → "processing"
"in_production" → "printing"
"shipped" → "shipped"
"delivered" → "delivered"
"cancelled" → "cancelled"
```

### 3.5 Shipping

#### FR-PRINT-011: Calculate Shipping Cost
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/print/shipping/calculate
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  format: string,
  size: string,
  quantity: number,
  shippingAddress: {
    country: string,
    postalCode: string
  },
  shippingSpeed: "standard" | "express"
}

Response (200 OK):
{
  options: [
    {
      method: "standard",
      carrier: "USPS",
      cost: number,
      estimatedDays: number,
      estimatedDelivery: string
    },
    {
      method: "express",
      carrier: "FedEx",
      cost: number,
      estimatedDays: number,
      estimatedDelivery: string
    }
  ]
}
```

#### FR-PRINT-012: Track Shipment
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/print/orders/:orderId/tracking
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  carrier: string,
  trackingNumber: string,
  trackingUrl: string,
  status: "in_transit" | "out_for_delivery" | "delivered" | "exception",
  estimatedDelivery: string,
  events: [
    {
      timestamp: string,
      location: string,
      status: string,
      description: string
    }
  ]
}
```

---

## 4. Non-Functional Requirements

### 4.1 Performance

#### NFR-PRINT-001: PDF Generation
- 10-page book: < 30 seconds
- 30-page book: < 60 seconds
- File size: < 50MB

#### NFR-PRINT-002: Order Processing
- Order creation: < 500ms
- Provider submission: < 5 seconds

### 4.2 Quality

#### NFR-PRINT-003: Print Quality
- Resolution: 300 DPI minimum
- Color accuracy: Delta E < 5
- Bleed: 0.125" on all sides
- Font embedding: 100%

### 4.3 Reliability

#### NFR-PRINT-004: Order Success Rate
- > 95% successful submissions
- Automatic retry on provider errors (max 3 attempts)
- Fallback to alternative provider

---

## 5. Data Models

### 5.1 Print Orders Table
```sql
CREATE TABLE print_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  story_id UUID NOT NULL REFERENCES stories(id),

  -- Order details
  format VARCHAR(50) NOT NULL,
  size VARCHAR(20) NOT NULL,
  page_finish VARCHAR(20),
  binding VARCHAR(20),
  quantity INTEGER NOT NULL DEFAULT 1,

  -- Status
  status VARCHAR(50) DEFAULT 'draft',

  -- Provider
  provider VARCHAR(50),
  provider_order_id VARCHAR(255),

  -- Pricing
  subtotal DECIMAL(10, 2),
  shipping_cost DECIMAL(10, 2),
  tax DECIMAL(10, 2),
  discount DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'USD',

  -- Shipping
  shipping_address JSONB NOT NULL,
  shipping_method VARCHAR(50),
  tracking_number VARCHAR(255),
  tracking_url VARCHAR(500),

  -- Files
  print_file_url VARCHAR(500),
  proof_url VARCHAR(500),
  proof_approved_at TIMESTAMP,

  -- Timing
  estimated_delivery DATE,
  actual_delivery DATE,
  submitted_at TIMESTAMP,
  completed_at TIMESTAMP,
  cancelled_at TIMESTAMP,

  -- Gift options
  gift_message TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_format CHECK (format IN ('hardcover', 'softcover', 'pdf')),
  CONSTRAINT valid_status CHECK (status IN ('draft', 'pending_proof', 'proof_approved', 'processing', 'printing', 'shipped', 'delivered', 'cancelled')),
  CONSTRAINT valid_quantity CHECK (quantity > 0 AND quantity <= 100)
);

CREATE INDEX idx_print_orders_user ON print_orders(user_id);
CREATE INDEX idx_print_orders_story ON print_orders(story_id);
CREATE INDEX idx_print_orders_status ON print_orders(status);
CREATE INDEX idx_print_orders_provider ON print_orders(provider, provider_order_id);
```

### 5.2 Print Files Table
```sql
CREATE TABLE print_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES print_orders(id),
  story_id UUID NOT NULL REFERENCES stories(id),

  file_type VARCHAR(50) NOT NULL,  -- 'interior', 'cover', 'proof', 'combined'
  url VARCHAR(500) NOT NULL,
  file_size_bytes BIGINT,
  page_count INTEGER,

  -- Validation
  validated BOOLEAN DEFAULT FALSE,
  validation_errors JSONB,

  -- Specs
  dpi INTEGER,
  color_mode VARCHAR(20),
  width_inches DECIMAL(5, 2),
  height_inches DECIMAL(5, 2),

  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_file_type CHECK (file_type IN ('interior', 'cover', 'proof', 'combined'))
);

CREATE INDEX idx_print_files_order ON print_files(order_id);
CREATE INDEX idx_print_files_story ON print_files(story_id);
```

---

## 6. External API Integration

### 6.1 Blurb API
```typescript
// Create book project
POST https://api.blurb.com/v2/projects
{
  title: string,
  size: string,
  cover: string,
  pages: number
}

// Upload PDF
PUT https://api.blurb.com/v2/projects/:id/files
Content-Type: application/pdf

// Place order
POST https://api.blurb.com/v2/orders
{
  projectId: string,
  quantity: number,
  shippingAddress: object
}

// Check order status
GET https://api.blurb.com/v2/orders/:id
```

---

## 7. Testing

### 7.1 Unit Tests
- PDF generation logic
- Price calculation
- Provider selection
- Order validation

**Coverage:** 85%

### 7.2 Integration Tests
- Full order flow
- Provider API calls
- PDF validation
- Shipping calculation

**Coverage:** 75%

### 7.3 Print Quality Tests
- Test prints for all formats
- Color accuracy verification
- Physical inspection

---

## 8. Success Criteria

- 98% order success rate
- < 7 days average delivery time
- < 1% quality complaints
- > 4.5/5.0 satisfaction rating
- < $2 average shipping cost overrun

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | Backend Team | Initial specification |
