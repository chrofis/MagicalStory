# Magical Story Platform - System Overview

**Document Version:** 1.0
**Last Updated:** 2025-01-26
**Status:** Draft

---

## Executive Summary

The Magical Story Platform is a multi-channel SaaS application that enables users to create personalized children's stories with AI-generated content and illustrations, culminating in professionally printed books. The platform supports web, iOS, and Android applications with a unified backend infrastructure.

---

## Business Objectives

### Primary Goals
1. Enable users to create personalized, high-quality children's stories
2. Provide consistent experience across web and mobile platforms
3. Generate revenue through subscription and per-print models
4. Ensure content safety and quality through review workflows
5. Scale to support 100,000+ concurrent users

### Success Metrics
- User acquisition: 50,000 users in Year 1
- Conversion rate: 15% free to paid
- Average order value: $35 per printed book
- Story completion rate: 60%
- Customer satisfaction: 4.5/5 stars

---

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                              │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│   Web App    │   iOS App    │ Android App  │   Admin Portal    │
│  (React)     │  (SwiftUI)   │  (Kotlin)    │   (React)         │
└──────────────┴──────────────┴──────────────┴───────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API GATEWAY LAYER                             │
│  ┌────────────┬─────────────┬──────────────┬─────────────────┐ │
│  │ Auth       │ Rate Limit  │ Load Balance │ Request Routing │ │
│  └────────────┴─────────────┴──────────────┴─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  BUSINESS LOGIC │  │  DATA LAYER     │  │ EXTERNAL SVCS   │
├─────────────────┤  ├─────────────────┤  ├─────────────────┤
│ • Auth Service  │  │ • PostgreSQL    │  │ • Anthropic AI  │
│ • Story Config  │  │ • MongoDB       │  │ • DALL-E/Midj.  │
│ • AI Generation │  │ • Redis Cache   │  │ • Stripe        │
│ • Image Gen     │  │ • S3 Storage    │  │ • Print APIs    │
│ • Review        │  │ • CloudFront    │  │ • SendGrid      │
│ • Payment       │  │                 │  │                 │
│ • Print Mgmt    │  │                 │  │                 │
│ • Notification  │  │                 │  │                 │
│ • Analytics     │  │                 │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## Technology Stack

### Frontend
- **Web Application:** React 18 + Next.js 14 (App Router)
  - TypeScript for type safety
  - Tailwind CSS for styling
  - Zustand for state management
  - React Query for server state
  - Progressive Web App (PWA) capabilities

- **iOS Application:** SwiftUI + Combine
  - iOS 15+ support
  - Swift 5.9+
  - Core Data for local persistence
  - CloudKit for sync (optional)

- **Android Application:** Kotlin + Jetpack Compose
  - Android 8.0+ (API 26+)
  - Kotlin Coroutines + Flow
  - Room Database for local storage
  - WorkManager for background tasks

- **Admin Portal:** React 18 + Material-UI v5
  - Role-based access control
  - Real-time dashboards
  - Advanced filtering and search

### Backend
- **API Framework:** Node.js 20 LTS + Express 4.18
  - TypeScript for type safety
  - Alternative: Python 3.11 + FastAPI (for AI-heavy workloads)

- **API Documentation:** OpenAPI 3.1 (Swagger)

- **Validation:** Zod for runtime type validation

- **Authentication:** JWT (RS256) + Refresh Tokens

### Databases
- **Primary Database:** PostgreSQL 15
  - Users, subscriptions, orders, configurations
  - Full ACID compliance
  - Row-level security (RLS)

- **Document Store:** MongoDB 7.0
  - Stories content (flexible schema)
  - Large text blobs
  - Media metadata

- **Cache:** Redis 7.2
  - Session management
  - Rate limiting counters
  - Query result caching
  - Pub/Sub for real-time features

- **Search:** Elasticsearch 8.x (optional, Phase 2)
  - Full-text search for stories
  - User content search

### Infrastructure
- **Cloud Provider:** AWS (Primary), Azure (Secondary/DR)
  - Multi-region deployment (US-East, EU-West)
  - 99.95% uptime SLA

- **Container Orchestration:** Kubernetes (EKS)
  - 3-5 nodes per environment (Dev/Staging/Prod)
  - Auto-scaling based on CPU/memory
  - Horizontal Pod Autoscaler (HPA)

- **CI/CD:** GitHub Actions
  - Automated testing
  - Docker image building
  - Deployment pipelines

- **Monitoring:** DataDog / AWS CloudWatch
  - APM (Application Performance Monitoring)
  - Log aggregation
  - Custom metrics and dashboards
  - Alert management

- **CDN:** CloudFront
  - Image delivery
  - Static asset caching
  - Edge locations worldwide

- **Object Storage:** AWS S3
  - User uploads (character photos)
  - Generated images
  - PDF files
  - Backup storage

### External Services
- **AI Text Generation:** Anthropic Claude API
  - Claude 3.5 Sonnet for story generation
  - Fallback to GPT-4 if needed

- **AI Image Generation:**
  - Primary: DALL-E 3 or Midjourney API
  - Alternative: Stable Diffusion (self-hosted)
  - Character consistency via LoRA training

- **Payment Processing:** Stripe
  - Payment intents API
  - Subscription management
  - Webhook handling

- **Print Services:**
  - Primary: Blurb API
  - Secondary: Lulu, Mixam (for geographic coverage)

- **Email:** SendGrid
  - Transactional emails
  - Marketing campaigns (optional)

- **SMS:** Twilio (optional, Phase 2)
  - Order notifications
  - 2FA

---

## Core User Flows

### 1. Story Creation Flow
```
User Registration/Login
    ↓
Configure Story Type & Language
    ↓
Create/Select Characters
    ↓
Define Character Relationships
    ↓
Set Story Parameters (pages, reading level)
    ↓
Payment (if not subscribed)
    ↓
AI Story Generation (async)
    ↓
Review Generated Story
    ↓
Image Generation (async)
    ↓
Review Story + Images
    ↓
Request Modifications (optional)
    ↓
Approve Final Version
    ↓
Submit for Print
    ↓
Track Order
    ↓
Receive Physical Book
```

### 2. Subscription Flow
```
Browse Plans (Free, Basic, Premium)
    ↓
Select Plan
    ↓
Enter Payment Information
    ↓
Confirm Subscription
    ↓
Access Premium Features
    ↓
Manage Subscription (upgrade/downgrade/cancel)
```

### 3. Review Flow
```
Story Generated
    ↓
Automated AI Content Safety Check
    ↓
(Optional) User Edit & Revise
    ↓
Company Human Review (if flagged)
    ↓
Approval/Rejection
    ↓
If Rejected: User Notified + Can Revise
    ↓
If Approved: Proceed to Print
```

---

## System Requirements

### Performance Requirements
- **API Response Time:**
  - 95th percentile < 200ms
  - 99th percentile < 500ms
- **Story Generation:** < 60 seconds for 10-page story
- **Image Generation:** < 30 seconds per image
- **Page Load Time:** < 2 seconds (Time to Interactive)
- **Database Query Time:** < 100ms average

### Scalability Requirements
- Support 100,000 concurrent users
- Handle 1,000 story generations per hour
- Process 500 print orders per day
- Store 10M+ stories
- Handle 1M+ images

### Availability Requirements
- **System Uptime:** 99.95% (4.38 hours downtime/year)
- **Database Availability:** 99.99%
- **Planned Maintenance:** < 2 hours/month (off-peak hours)

### Security Requirements
- TLS 1.3 for all communications
- Data encryption at rest (AES-256)
- PCI DSS Level 1 compliance for payments
- GDPR compliance for EU users
- COPPA compliance for children under 13
- SOC 2 Type II certification (Year 2)
- Regular security audits (quarterly)
- Penetration testing (semi-annually)

### Data Retention
- User data: Retained until account deletion + 30 days
- Stories: Indefinite retention (unless user deletes)
- Activity logs: 90 days (hot), 1 year (cold archive)
- Payment records: 7 years (regulatory requirement)
- Backup retention: 30 days (daily), 12 months (monthly)

---

## Integration Points

### Internal Service Communication
- **Protocol:** REST APIs over HTTPS
- **Authentication:** Service-to-service JWT tokens
- **Format:** JSON
- **Versioning:** URI versioning (/api/v1/)

### External API Integration
1. **Anthropic Claude API**
   - Purpose: Story generation
   - Protocol: HTTPS REST
   - Authentication: API Key (X-API-Key header)
   - Rate Limit: Managed by provider

2. **Image Generation APIs**
   - DALL-E 3: OpenAI API
   - Midjourney: Discord Bot API (if available)
   - Stable Diffusion: Self-hosted REST API

3. **Stripe Payment API**
   - Payment Intents API
   - Subscription API
   - Webhook events for async updates

4. **Print Provider APIs**
   - Blurb API: RESTful, OAuth 2.0
   - Lulu API: RESTful, API Key
   - Order submission, status tracking

5. **SendGrid Email API**
   - Transactional email sending
   - Webhook for delivery status

---

## Development Methodology

### Agile/Scrum
- 2-week sprints
- Daily standups (15 min)
- Sprint planning (4 hours)
- Sprint retrospective (2 hours)
- Code reviews (mandatory)

### Code Standards
- TypeScript strict mode enabled
- ESLint + Prettier for formatting
- 80% minimum code coverage
- Pre-commit hooks (Husky)

### Testing Strategy
- Unit tests (Jest/Vitest)
- Integration tests (Supertest)
- E2E tests (Playwright)
- Load testing (k6)
- Security testing (OWASP ZAP)

### Deployment Strategy
- Blue-Green deployments
- Feature flags (LaunchDarkly)
- Canary releases (5% → 50% → 100%)
- Rollback capability < 5 minutes

---

## Risk Management

### Technical Risks
| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| AI API downtime | High | Medium | Multiple provider fallback |
| Database failure | Critical | Low | Multi-AZ deployment, automated backups |
| Image generation cost overrun | High | Medium | Cost monitoring, quota limits |
| Security breach | Critical | Low | Regular audits, penetration testing |
| Scalability issues | High | Medium | Load testing, auto-scaling |

### Business Risks
| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Low user adoption | Critical | Medium | MVP validation, marketing |
| Print quality issues | High | Medium | Multiple vendors, quality checks |
| Content moderation failures | High | Medium | AI + human review, community reporting |
| Regulatory compliance | Critical | Low | Legal review, privacy by design |

---

## Success Criteria

### Technical Success
- ✓ All APIs meet performance SLA (95% < 200ms)
- ✓ System handles 100k concurrent users
- ✓ 99.95% uptime achieved
- ✓ Zero critical security vulnerabilities
- ✓ Automated deployment pipeline functional

### Business Success
- ✓ 50,000 registered users (Year 1)
- ✓ 15% conversion rate (free to paid)
- ✓ $1.75M ARR (Annual Recurring Revenue)
- ✓ 4.5+ star average rating
- ✓ 60% story completion rate

---

## Compliance & Legal

### Data Privacy
- **GDPR (EU):** Right to access, rectification, erasure, portability
- **CCPA (California):** Consumer data rights, opt-out mechanisms
- **COPPA (Children):** Parental consent for users under 13

### Content Guidelines
- No violence, explicit content, or harmful themes
- Age-appropriate language and imagery
- Cultural sensitivity and inclusivity
- Copyright compliance (no copyrighted characters without license)

### Terms of Service
- User-generated content ownership
- Platform usage rights
- Liability limitations
- Dispute resolution

---

## Phase Roadmap

### Phase 1: MVP (Months 1-3)
**Goal:** Validate core concept with minimal viable product

**Features:**
- User registration and authentication
- Character creation (text-based descriptions)
- Basic story configuration
- AI story generation (Claude API)
- Text-only story output
- Manual review process
- Single payment option (Stripe one-time)
- Web application only

**Success Metrics:**
- 1,000 registered users
- 100 stories generated
- 10 print orders
- User feedback collected

### Phase 2: Enhanced Features (Months 4-6)
**Goal:** Add image generation and mobile apps

**Features:**
- AI image generation (character portraits)
- Scene illustration generation
- iOS application launch
- Android application launch
- Subscription plans (monthly/annual)
- Automated print integration (Blurb API)
- Email notifications

**Success Metrics:**
- 10,000 registered users
- 50% mobile app adoption
- 500 stories with images
- 100 print orders/month

### Phase 3: Scale & Optimize (Months 7-9)
**Goal:** Scale infrastructure and add advanced features

**Features:**
- Multi-stage review workflow
- Image consistency improvements (LoRA models)
- Analytics dashboard
- Admin portal with moderation tools
- Multi-language support expansion
- Character library reuse
- Story versioning and history

**Success Metrics:**
- 50,000 registered users
- 2,000 stories/month
- 500 print orders/month
- < 2% content moderation issues

### Phase 4: Advanced Features (Months 10-12)
**Goal:** Premium features and international expansion

**Features:**
- Advanced customization (fonts, layouts)
- Audio narration (text-to-speech)
- Collaborative story creation
- Gift/share functionality
- International print providers
- Multi-currency support
- Referral program

**Success Metrics:**
- 100,000 registered users
- $1.5M ARR
- 1,000 print orders/month
- Expand to 3+ countries

---

## Appendix

### Glossary
- **Story Configuration:** User-defined parameters for story generation
- **Character Library:** Reusable character profiles
- **LoRA:** Low-Rank Adaptation for consistent character generation
- **Print-Ready:** PDF meeting printing company specifications
- **Review Workflow:** Multi-stage content approval process

### References
- Anthropic Claude API Documentation
- Stripe API Reference
- AWS Well-Architected Framework
- OWASP Top 10 Security Risks
- GDPR Compliance Guidelines

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-26 | Architecture Team | Initial draft |
