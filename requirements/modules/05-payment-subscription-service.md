# Module Requirements Specification: Payment & Subscription Service

**Module ID:** MS-PAY-001
**Version:** 1.0
**Last Updated:** 2025-01-26
**Owner:** Backend Team
**Status:** Draft

---

## 1. Module Overview

### 1.1 Purpose
Handle all payment processing, subscription management, billing, and feature access control based on user subscription tiers.

### 1.2 Scope
- Stripe integration for payments
- Subscription management (create, upgrade, downgrade, cancel)
- One-time payments (print orders)
- Invoice generation
- Usage tracking and quota enforcement
- Multi-currency support
- Tax calculation
- Refund processing

### 1.3 Dependencies
- **Upstream:** Auth Service, Story Generation Service, Print Service
- **Downstream:** Notification Service, Logging Service
- **External:** Stripe API, Tax calculation service

### 1.4 Technology Stack
- **Language:** TypeScript (Node.js 20)
- **Framework:** Express.js
- **Database:** PostgreSQL
- **Payment Gateway:** Stripe
- **Libraries:** `stripe`, `express-validator`

---

## 2. Subscription Tiers

### 2.1 Free Tier
**Price:** $0/month

**Limits:**
- 5 stories per month
- No image generation
- Watermarked PDFs
- Standard support
- Max 10 characters in library

### 2.2 Basic Tier
**Price:** $9.99/month or $99/year (save 17%)

**Features:**
- 20 stories per month
- Image generation (10 images per story)
- No watermarks
- Priority support
- Max 50 characters
- Export configurations

### 2.3 Premium Tier
**Price:** $24.99/month or $249/year (save 17%)

**Features:**
- Unlimited stories
- Unlimited image generation
- Premium art styles
- Print discounts (15% off)
- Priority generation queue
- Unlimited characters
- Advanced editing tools
- Early access to new features

### 2.4 Enterprise Tier
**Price:** Custom (min $199/month)

**Features:**
- Everything in Premium
- Multi-user accounts (team collaboration)
- Custom branding
- API access
- Dedicated account manager
- SLA guarantees

---

## 3. Functional Requirements

### 3.1 Subscription Management

#### FR-PAY-001: Create Subscription
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/subscriptions
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  priceId: string,  // Stripe price ID
  paymentMethodId: string,  // From Stripe.js
  billingCycle: "monthly" | "annual"
}

Response (201 Created):
{
  subscriptionId: string,
  status: "active" | "incomplete",
  currentPeriodStart: string,
  currentPeriodEnd: string,
  tier: string,
  amount: number,
  currency: string
}
```

#### FR-PAY-002: Get Current Subscription
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/subscriptions/current
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  id: string,
  userId: string,
  tier: string,
  status: "active" | "past_due" | "canceled" | "trialing",
  currentPeriodStart: string,
  currentPeriodEnd: string,
  cancelAtPeriodEnd: boolean,
  amount: number,
  currency: string,
  billingCycle: string,
  usage: {
    storiesGenerated: number,
    storiesLimit: number,
    imagesGenerated: number,
    imagesLimit: number
  }
}
```

#### FR-PAY-003: Upgrade/Downgrade Subscription
**Priority:** MUST HAVE

**Acceptance Criteria:**
- Immediate upgrade (prorated charge)
- Downgrade at period end (prevent revenue loss)
- Calculate proration automatically
- Update quotas immediately on upgrade

**API Endpoint:**
```typescript
PUT /api/v1/subscriptions/:subscriptionId
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  newPriceId: string,
  immediate: boolean = false  // Force immediate change
}

Response (200 OK):
{
  message: "Subscription updated",
  subscription: { /* updated subscription */ },
  prorationAmount: number,
  effectiveDate: string
}
```

#### FR-PAY-004: Cancel Subscription
**Priority:** MUST HAVE

**Acceptance Criteria:**
- Cancel at period end (default)
- Immediate cancellation (with refund option)
- Retain access until period end
- Send cancellation email
- Offer cancellation survey (optional)

**API Endpoint:**
```typescript
DELETE /api/v1/subscriptions/:subscriptionId?immediate=false
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Subscription cancelled",
  accessUntil: string,
  refundAmount: number
}
```

#### FR-PAY-005: Reactivate Subscription
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/subscriptions/:subscriptionId/reactivate
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Subscription reactivated",
  subscription: { /* reactivated subscription */ }
}
```

### 3.2 Payment Methods

#### FR-PAY-006: Add Payment Method
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/payment-methods
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  paymentMethodId: string,  // From Stripe.js
  setAsDefault: boolean = true
}

Response (201 Created):
{
  id: string,
  type: "card" | "paypal",
  last4: string,
  brand: string,
  expiryMonth: number,
  expiryYear: number,
  isDefault: boolean
}
```

#### FR-PAY-007: List Payment Methods
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/payment-methods
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  paymentMethods: [
    {
      id: string,
      type: string,
      last4: string,
      brand: string,
      expiryMonth: number,
      expiryYear: number,
      isDefault: boolean
    }
  ]
}
```

#### FR-PAY-008: Delete Payment Method
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
DELETE /api/v1/payment-methods/:paymentMethodId
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  message: "Payment method deleted"
}
```

### 3.3 One-Time Payments

#### FR-PAY-009: Create Payment Intent (Print Orders)
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/payments/intent
Headers: { Authorization: "Bearer {accessToken}" }
Request Body:
{
  orderId: string,  // Print order ID
  amount: number,
  currency: string = "USD",
  paymentMethodId?: string  // Optional, use saved method
}

Response (200 OK):
{
  clientSecret: string,  // For Stripe.js
  paymentIntentId: string,
  amount: number,
  currency: string
}
```

#### FR-PAY-010: Confirm Payment
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
POST /api/v1/payments/:paymentIntentId/confirm
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  status: "succeeded" | "requires_action",
  paymentId: string,
  receipt: {
    id: string,
    url: string
  }
}
```

### 3.4 Billing & Invoices

#### FR-PAY-011: Get Billing History
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/billing/history?page=1&limit=20
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  invoices: [
    {
      id: string,
      date: string,
      amount: number,
      currency: string,
      status: "paid" | "open" | "void",
      description: string,
      invoiceUrl: string,
      pdfUrl: string
    }
  ],
  pagination: { /* ... */ }
}
```

#### FR-PAY-012: Download Invoice
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/billing/invoices/:invoiceId/pdf
Headers: { Authorization: "Bearer {accessToken}" }

Response: PDF file download
```

### 3.5 Usage Tracking

#### FR-PAY-013: Get Current Usage
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/usage/current
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  period: {
    start: string,
    end: string
  },
  tier: string,
  usage: {
    storiesGenerated: number,
    storiesLimit: number,
    imagesGenerated: number,
    imagesLimit: number,
    printOrders: number
  },
  percentUsed: {
    stories: number,
    images: number
  }
}
```

#### FR-PAY-014: Check Feature Access
**Priority:** MUST HAVE

**API Endpoint:**
```typescript
GET /api/v1/usage/can-generate?type=story
Headers: { Authorization: "Bearer {accessToken}" }

Response (200 OK):
{
  allowed: boolean,
  reason: string,  // If not allowed: "quota_exceeded", "subscription_required", etc.
  upgradeUrl: string  // If applicable
}
```

### 3.6 Refunds

#### FR-PAY-015: Request Refund
**Priority:** MUST HAVE

**Acceptance Criteria:**
- Admin approval required
- Full or partial refund
- Refund to original payment method
- Update subscription status
- Send refund confirmation email

**API Endpoint:**
```typescript
POST /api/v1/payments/:paymentId/refund
Headers: { Authorization: "Bearer {adminAccessToken}" }
Request Body:
{
  amount?: number,  // Partial refund, omit for full
  reason: string
}

Response (200 OK):
{
  refundId: string,
  amount: number,
  status: "succeeded" | "pending"
}
```

---

## 4. Non-Functional Requirements

### 4.1 Security

#### NFR-PAY-001: PCI DSS Compliance
- Never store raw card numbers
- Use Stripe.js for client-side tokenization
- Store only Stripe payment method IDs
- TLS 1.2+ for all communications

#### NFR-PAY-002: Fraud Prevention
- Stripe Radar enabled
- 3D Secure for high-value transactions
- Velocity checks (max 5 attempts per hour)
- Geographic restrictions (if needed)

### 4.2 Performance

#### NFR-PAY-003: Response Time
- Payment intent creation: < 500ms
- Subscription operations: < 200ms
- Webhook processing: < 1 second

### 4.3 Reliability

#### NFR-PAY-004: Payment Success Rate
- > 95% success rate for valid cards
- Automatic retry for failed payments
- Grace period for payment failures (3 days)

### 4.4 Compliance

#### NFR-PAY-005: Tax Compliance
- Automatic tax calculation (Stripe Tax)
- VAT handling for EU customers
- Sales tax for US states
- Display tax-inclusive prices where required

---

## 5. Data Models

### 5.1 Subscriptions Table
```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_customer_id VARCHAR(255) NOT NULL,

  tier VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,

  current_period_start TIMESTAMP NOT NULL,
  current_period_end TIMESTAMP NOT NULL,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  canceled_at TIMESTAMP,

  billing_cycle VARCHAR(20) NOT NULL,  -- 'monthly', 'annual'
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',

  trial_start TIMESTAMP,
  trial_end TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_tier CHECK (tier IN ('free', 'basic', 'premium', 'enterprise')),
  CONSTRAINT valid_status CHECK (status IN ('active', 'past_due', 'canceled', 'trialing', 'incomplete')),
  CONSTRAINT valid_cycle CHECK (billing_cycle IN ('monthly', 'annual'))
);

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
```

### 5.2 Payments Table
```sql
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),

  stripe_payment_intent_id VARCHAR(255) UNIQUE,
  stripe_invoice_id VARCHAR(255),

  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(50) NOT NULL,

  payment_method_type VARCHAR(50),  -- 'card', 'paypal', etc.
  last4 VARCHAR(4),
  brand VARCHAR(50),

  description TEXT,
  receipt_url VARCHAR(500),

  refunded BOOLEAN DEFAULT FALSE,
  refund_amount DECIMAL(10, 2),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'canceled'))
);

CREATE INDEX idx_payments_user ON payments(user_id);
CREATE INDEX idx_payments_intent ON payments(stripe_payment_intent_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_created ON payments(created_at);
```

### 5.3 Usage Quotas Table
```sql
CREATE TABLE usage_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),

  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,

  stories_generated INTEGER DEFAULT 0,
  stories_limit INTEGER NOT NULL,

  images_generated INTEGER DEFAULT 0,
  images_limit INTEGER NOT NULL,

  print_orders INTEGER DEFAULT 0,

  quota_reset_at TIMESTAMP NOT NULL,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, period_start)
);

CREATE INDEX idx_quotas_user ON usage_quotas(user_id);
CREATE INDEX idx_quotas_period ON usage_quotas(period_start, period_end);
```

---

## 6. Stripe Webhook Events

### 6.1 Webhook Handler
**Endpoint:** `POST /api/v1/webhooks/stripe`

**Events to Handle:**
```typescript
- customer.subscription.created
- customer.subscription.updated
- customer.subscription.deleted
- invoice.payment_succeeded
- invoice.payment_failed
- payment_intent.succeeded
- payment_intent.payment_failed
- customer.subscription.trial_will_end
```

### 6.2 Event Processing
- Validate webhook signature
- Idempotent processing (check event ID)
- Update database accordingly
- Send notifications
- Log all events

---

## 7. Testing

### 7.1 Unit Tests
- Subscription upgrade/downgrade logic
- Proration calculations
- Usage quota checks

**Coverage:** 90%

### 7.2 Integration Tests
- Full payment flow
- Webhook processing
- Stripe API calls

**Coverage:** 80%

### 7.3 Test Mode
- Use Stripe test keys
- Test card numbers:
  - Success: `4242 4242 4242 4242`
  - Decline: `4000 0000 0000 0002`
  - 3D Secure: `4000 0027 6000 3184`

---

## 8. Success Criteria

- 95% payment success rate
- < 2% churn rate
- Average LTV > $150
- Upgrade rate: 15% free → paid
- Invoice generation < 5 seconds

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | Backend Team | Initial specification |
