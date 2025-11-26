# Magical Story Platform - Requirements Documentation

**Version:** 1.0
**Last Updated:** 2025-01-26
**Status:** Draft

---

## 📋 Overview

This directory contains comprehensive technical specifications for the Magical Story Platform - a multi-channel SaaS application for creating personalized AI-generated children's storybooks with professional printing.

---

## 📂 Directory Structure

```
requirements/
├── README.md (this file)
├── architecture/
│   ├── 00-system-overview.md
│   └── 01-api-gateway-specification.md
├── modules/
│   ├── 01-user-authentication-service.md
│   ├── 02-story-configuration-service.md
│   ├── 03-ai-story-generation-service.md
│   ├── 04-image-generation-service.md
│   ├── 05-payment-subscription-service.md
│   ├── 06-print-integration-service.md
│   └── 07-review-moderation-service.md
├── data-models/
│   └── complete-database-schema.sql
└── api-specs/
    └── (OpenAPI specs - to be added)
```

---

## 📖 Document Index

### Architecture Documents

#### [00-system-overview.md](architecture/00-system-overview.md)
High-level system architecture, technology stack, deployment strategy, and project roadmap.

**Key Sections:**
- Executive summary & business objectives
- System architecture diagram
- Technology stack (frontend, backend, infrastructure)
- Core user flows
- Performance, security, scalability requirements
- Phase roadmap (MVP → Production)
- Risk management

#### [01-api-gateway-specification.md](architecture/01-api-gateway-specification.md)
Complete API Gateway specification including routing, authentication, rate limiting, and security.

**Key Sections:**
- Request routing and transformation
- Authentication & authorization
- Rate limiting per tier
- CORS, caching, health checks
- Monitoring and alerts

---

### Module Specifications

#### [01-user-authentication-service.md](modules/01-user-authentication-service.md)
User registration, login, session management, MFA, and RBAC.

**Features:**
- Email/password + social authentication
- JWT-based auth with refresh tokens
- Multi-factor authentication (TOTP)
- Password management (reset, change)
- Account deletion (GDPR compliance)
- Role-based access control

**API Endpoints:** 15+ endpoints
**Database Tables:** 6 tables

---

#### [02-story-configuration-service.md](modules/02-story-configuration-service.md)
Character creation, relationship mapping, and story configuration management.

**Features:**
- Character CRUD with photo upload
- Character trait management (strengths, weaknesses, fears)
- Relationship mapping between characters
- Story configuration (type, language, pages, reading level)
- Character library (reusable across stories)
- Import/export functionality

**API Endpoints:** 20+ endpoints
**Database Tables:** 4 tables

---

#### [03-ai-story-generation-service.md](modules/03-ai-story-generation-service.md)
AI-powered story generation using Claude/GPT APIs with queue management.

**Features:**
- Dynamic prompt generation from configuration
- Asynchronous job queue (priority-based)
- Multi-provider support (Claude, GPT-4)
- Cost tracking and optimization
- Story versioning and regeneration
- Content caching

**API Endpoints:** 7 endpoints
**Database Tables:** 4 tables
**External APIs:** Anthropic Claude, OpenAI

---

#### [04-image-generation-service.md](modules/04-image-generation-service.md)
AI image generation for character portraits and story scenes with consistency.

**Features:**
- Character portrait generation
- Scene illustration generation
- Character consistency (LoRA, reference images)
- Art style selection (cartoon, watercolor, realistic, etc.)
- Image upscaling for print (300 DPI)
- Batch generation for entire story

**API Endpoints:** 10 endpoints
**Database Tables:** 3 tables
**External APIs:** DALL-E 3, Midjourney, Stable Diffusion

---

#### [05-payment-subscription-service.md](modules/05-payment-subscription-service.md)
Stripe integration for payments, subscriptions, and billing.

**Features:**
- Subscription management (create, upgrade, downgrade, cancel)
- One-time payments (print orders)
- Multiple payment methods
- Usage quota tracking and enforcement
- Invoice generation
- Multi-currency support

**Subscription Tiers:**
- Free: $0/month (5 stories, no images)
- Basic: $9.99/month (20 stories, images)
- Premium: $24.99/month (unlimited)
- Enterprise: Custom pricing

**API Endpoints:** 15+ endpoints
**Database Tables:** 4 tables
**External APIs:** Stripe

---

#### [06-print-integration-service.md](modules/06-print-integration-service.md)
Integration with external printing companies for physical book production.

**Features:**
- Print-ready PDF generation (300 DPI, CMYK)
- Multiple print providers (Blurb, Lulu, Mixam)
- Order management and tracking
- Shipping cost calculation
- Proof approval workflow
- Multiple formats (hardcover, softcover, PDF)

**Book Formats:**
- Hardcover: $35-$75 (8x10", 10x8", 8.5x11")
- Softcover: $15-$35 (various sizes)
- PDF: $5 (digital download)

**API Endpoints:** 12 endpoints
**Database Tables:** 2 tables
**External APIs:** Blurb, Lulu, Mixam

---

#### [07-review-moderation-service.md](modules/07-review-moderation-service.md)
Multi-stage content review including AI safety checks and human moderation.

**Features:**
- Automated AI content safety checks
- Grammar and spelling validation
- Story coherence analysis
- Human moderation workflow
- Content editing with versioning
- Feedback and comment system

**Review Stages:**
1. AI Content Safety (automatic)
2. User Review (optional editing)
3. AI Quality Check (grammar, coherence)
4. Human Moderation (if flagged)

**API Endpoints:** 10 endpoints
**Database Tables:** 3 tables
**External APIs:** OpenAI Moderation, LanguageTool

---

### Data Models

#### [complete-database-schema.sql](data-models/complete-database-schema.sql)
Complete PostgreSQL database schema for the entire platform.

**Tables:**
- Users & Authentication (3 tables)
- Characters & Relationships (2 tables)
- Story Configuration (2 tables)
- Stories & Generation Jobs (2 tables)
- Images (2 tables)
- Reviews & Moderation (2 tables)
- Payments & Subscriptions (3 tables)
- Print Orders (1 table)
- Logging & Analytics (2 tables)

**Total:** 19+ tables with indexes, constraints, and triggers

---

## 🎯 Key Features Summary

### Core Functionality
✅ User registration and authentication
✅ Character creation with photos
✅ Relationship mapping
✅ AI story generation (Claude/GPT)
✅ AI image generation (DALL-E/Midjourney)
✅ Multi-stage content review
✅ Payment processing (Stripe)
✅ Print integration (multiple providers)
✅ Subscription management
✅ Usage quota enforcement

### Platform Support
- 🌐 Web application (React/Next.js)
- 📱 iOS application (SwiftUI)
- 🤖 Android application (Kotlin)
- 👨‍💼 Admin portal (React)

### Languages Supported
- 🇬🇧 English
- 🇩🇪 German
- 🇫🇷 French
- More in Phase 2

---

## 📊 System Specifications

### Performance Requirements
- **API Response Time:** < 200ms (p95)
- **Story Generation:** < 60 seconds
- **Image Generation:** < 30 seconds per image
- **System Uptime:** 99.95%
- **Concurrent Users:** 100,000+

### Scalability
- **Stories per Hour:** 1,000+
- **Images per Hour:** 500+
- **Print Orders per Day:** 500+
- **Database:** 10M+ stories, 50M+ images

### Security
- **Authentication:** JWT with refresh tokens
- **Encryption:** TLS 1.3, AES-256 at rest
- **Compliance:** GDPR, COPPA, PCI DSS, SOC 2
- **Rate Limiting:** Tier-based (100-2,000 req/min)

---

## 🚀 Development Phases

### Phase 1: MVP (Months 1-3)
- ✅ User authentication
- ✅ Character creation (text-based)
- ✅ AI story generation
- ✅ Basic web application
- ✅ Manual review process
- ✅ Single payment option
- **Goal:** 1,000 registered users, 100 stories generated

### Phase 2: Enhanced Features (Months 4-6)
- ✅ AI image generation
- ✅ iOS/Android apps
- ✅ Subscription plans
- ✅ Automated print integration
- ✅ Email notifications
- **Goal:** 10,000 users, 50% mobile adoption

### Phase 3: Scale & Optimize (Months 7-9)
- ✅ Multi-stage review workflow
- ✅ Character consistency (LoRA)
- ✅ Analytics dashboard
- ✅ Admin portal
- ✅ Multi-language expansion
- **Goal:** 50,000 users, $1M ARR

### Phase 4: Advanced Features (Months 10-12)
- ✅ Advanced customization
- ✅ Audio narration
- ✅ Collaborative story creation
- ✅ Gift/share functionality
- ✅ International expansion
- **Goal:** 100,000 users, $1.5M ARR

---

## 💰 Revenue Model

### Subscription Revenue
- **Free Tier:** 0% (acquisition)
- **Basic Tier:** $9.99/month × expected 30% of users
- **Premium Tier:** $24.99/month × expected 10% of users
- **Enterprise Tier:** $199+/month × expected 1% of users

### Per-Print Revenue
- **Hardcover:** $35-$75 per book (40% margin)
- **Softcover:** $15-$35 per book (40% margin)
- **PDF Downloads:** $5 per download (90% margin)

### Projected Year 1 Revenue
- **100,000 registered users**
- **15% conversion to paid**
- **$1.75M ARR**

---

## 🛠️ Technology Stack Summary

### Frontend
- React 18 + Next.js 14 (web)
- SwiftUI (iOS)
- Kotlin + Jetpack Compose (Android)
- Material-UI (admin portal)

### Backend
- Node.js 20 + Express.js (TypeScript)
- Python 3.11 + FastAPI (AI services)
- PostgreSQL 15 (primary database)
- MongoDB 7.0 (document storage)
- Redis 7.2 (cache & sessions)

### Infrastructure
- Kubernetes (EKS) on AWS
- Docker containers
- CloudFront CDN
- S3 object storage
- API Gateway (Kong)

### External Services
- Anthropic Claude (story generation)
- OpenAI DALL-E (image generation)
- Stripe (payments)
- Blurb/Lulu (printing)
- SendGrid (email)

---

## 📈 Success Metrics

### Technical KPIs
- ✅ 99.95% system uptime
- ✅ < 200ms API response time (p95)
- ✅ 95% story generation success rate
- ✅ > 90% character consistency
- ✅ < $0.50 per story cost

### Business KPIs
- ✅ 50,000 users (Year 1)
- ✅ 15% free-to-paid conversion
- ✅ < 5% monthly churn
- ✅ 60% story completion rate
- ✅ 4.5/5.0 customer satisfaction

---

## 🔒 Security & Compliance

### Data Protection
- **GDPR:** Right to access, erasure, portability
- **CCPA:** Consumer data rights
- **COPPA:** Parental consent for children under 13

### Payment Security
- **PCI DSS Level 1:** Stripe integration (no card storage)
- **3D Secure:** High-value transactions
- **Fraud Detection:** Stripe Radar

### Content Safety
- **AI Moderation:** Automated screening
- **Human Review:** Flagged content
- **Community Guidelines:** Age-appropriate, inclusive

---

## 📞 Contact & Support

**Technical Questions:** [dev@magicalstory.com](mailto:dev@magicalstory.com)
**Business Inquiries:** [business@magicalstory.com](mailto:business@magicalstory.com)
**Documentation Issues:** File an issue in the project repository

---

## 📝 Document Conventions

### Priority Levels
- **MUST HAVE:** Critical for MVP
- **SHOULD HAVE:** Important, Phase 2
- **NICE TO HAVE:** Future consideration

### API Endpoint Format
```
METHOD /api/v{version}/{resource}/{action}
Example: POST /api/v1/stories/generate
```

### Response Status Codes
- 2xx: Success
- 4xx: Client error
- 5xx: Server error

---

## 🔄 Document Updates

This documentation is a living document and will be updated as the project evolves.

**Update Frequency:** Weekly during active development
**Version Control:** All changes tracked in Git
**Review Process:** Technical lead approval required

---

## ✅ Next Steps

1. **Review all specifications** with stakeholders
2. **Set up development environment** (Docker, Kubernetes)
3. **Create project repositories** (monorepo or microservices)
4. **Initialize CI/CD pipelines** (GitHub Actions)
5. **Begin Phase 1 development** (MVP features)

---

**Last Updated:** 2025-01-26
**Document Maintained By:** Architecture Team
**Next Review:** 2025-02-02
